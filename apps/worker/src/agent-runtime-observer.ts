import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  AGENT_RUNTIME_FAMILIES, AGENT_RUNTIME_PRESENCE_VERSION, AGENT_RUNTIME_PULSE_MS,
  AgentRuntimePresenceReportSchema, agentRuntimeWorkerName,
  type AgentRuntimePresenceReport, type AgentRuntimeQueue,
} from "@yummyai/contracts/ai/agent-runtime-readiness";
import type { RedisAgentRuntimePresence } from "@yummyai/jobs";
import type { WorkerLifecycleEvent } from "./lifecycle.js";

export type AgentRuntimeSchedulerEvent = "started" | "dispatching" | "succeeded" | "failed" | "closing";
export type AgentRuntimeSchedulerObserver = (event: AgentRuntimeSchedulerEvent) => void;
export interface AgentRuntimeClient {
  readonly status: string;
  on?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}
export interface AgentRuntimeConsumer {
  readonly client: Promise<AgentRuntimeClient>;
  readonly closing?: Promise<unknown>;
  waitUntilReady(): Promise<AgentRuntimeClient>;
  isRunning(): boolean;
  isPaused(): boolean;
}
type Presence = Pick<RedisAgentRuntimePresence, "publish" | "withdraw" | "close">;
type Dispatcher = { started: boolean; closing: boolean; lastSuccess?: number; currentFailure: boolean };
type Consumer = { worker: AgentRuntimeConsumer; executorVersions: AgentRuntimePresenceReport["executorVersions"];
  normal?: AgentRuntimeClient; blocking?: AgentRuntimeClient };

/** Observes the existing runtime. It never starts a consumer or dispatcher. */
export class AgentRuntimeObserver {
  readonly instanceId: string;
  readonly workerName: string;
  private readonly now: () => number;
  private readonly consumers = new Map<AgentRuntimeQueue, Consumer>();
  private readonly dispatchers = new Map<AgentRuntimeQueue, Dispatcher>();
  private readonly detach: Array<() => void> = [];
  private state: AgentRuntimePresenceReport["lifecycle"] = "starting";
  private timer?: ReturnType<typeof setInterval>;
  private sealed = false;
  private pending?: Promise<void>;
  private dirty = false;
  private withdrawal?: Promise<void>;
  private closing?: Promise<void>;

  constructor(private readonly presence: Presence, options: { instanceId?: string; now?: () => number } = {}) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.workerName = agentRuntimeWorkerName(this.instanceId);
    this.now = options.now ?? (() => performance.now());
  }

  register(queue: AgentRuntimeQueue, worker: AgentRuntimeConsumer,
    executorVersions: readonly AgentRuntimePresenceReport["executorVersions"][number][]): void {
    if (this.sealed || this.consumers.has(queue)) throw new Error("AGENT_RUNTIME_OBSERVER_REGISTRATION_INVALID");
    const entry: Consumer = { worker, executorVersions: [...executorVersions] };
    // Validate the queue/protocol association before retaining the public ports.
    AgentRuntimePresenceReportSchema.parse(this.report(queue, entry));
    this.consumers.set(queue, entry);
    const capture = (client: AgentRuntimeClient, kind: "normal" | "blocking") => {
      if (this.sealed) return;
      entry[kind] = client;
      const changed = () => this.requestPulse();
      for (const event of ["ready", "close", "end", "reconnecting", "error"]) {
        client.on?.(event, changed);
        this.detach.push(() => { client.off?.(event, changed); });
      }
    };
    void worker.client.then(client => capture(client, "normal"), () => this.requestPulse());
    void worker.waitUntilReady().then(client => capture(client, "blocking"), () => this.requestPulse());
  }

  scheduler(queue: AgentRuntimeQueue): AgentRuntimeSchedulerObserver {
    if (!this.dispatchers.has(queue)) this.dispatchers.set(queue, { started: false, closing: false, currentFailure: false });
    return event => {
      if (this.sealed) return;
      const state = this.dispatchers.get(queue)!;
      if (event === "closing") state.closing = true;
      else if (!state.closing) {
        if (event === "started") state.started = true;
        if (event === "failed") state.currentFailure = true;
        if (event === "succeeded" && state.started) { state.lastSuccess = this.now(); state.currentFailure = false; }
        // dispatching and repeated pending ticks do not renew lastSuccess.
      }
      if (event !== "dispatching") this.requestPulse();
    };
  }

  lifecycle(event: WorkerLifecycleEvent): void {
    if (this.sealed) return;
    this.state = event.state;
    if (event.state === "error" || event.state === "stopping" || event.state === "stopped") {
      void this.withdraw();
      return;
    }
    if (!this.timer && this.consumers.size) {
      this.timer = setInterval(() => this.requestPulse(), AGENT_RUNTIME_PULSE_MS);
      this.timer.unref();
    }
    this.requestPulse();
  }

  private report(queue: AgentRuntimeQueue, consumer: Consumer): AgentRuntimePresenceReport {
    const dispatcher = this.dispatchers.get(queue);
    const age = dispatcher?.lastSuccess === undefined ? null : Math.floor(this.now() - dispatcher.lastSuccess);
    return {
      version: AGENT_RUNTIME_PRESENCE_VERSION, instanceId: this.instanceId, queue, workerName: this.workerName,
      executorVersions: [...consumer.executorVersions], lifecycle: this.state,
      consumer: {
        running: !consumer.worker.closing && consumer.worker.isRunning(), paused: consumer.worker.isPaused(),
        normalConnection: consumer.normal?.status === "ready" ? "ready" : "unavailable",
        blockingConnection: consumer.blocking?.status === "ready" ? "ready" : "unavailable",
      },
      dispatcher: {
        name: queue === "agent-loop" ? AGENT_RUNTIME_FAMILIES.loop.scheduler : AGENT_RUNTIME_FAMILIES.plan.scheduler,
        started: dispatcher?.started ?? false, closing: dispatcher?.closing ?? false,
        lastSuccessAgeMs: age !== null && Number.isSafeInteger(age) && age >= 0 ? age : null,
        currentFailure: dispatcher?.currentFailure ?? false,
      },
    };
  }

  private requestPulse(): void {
    this.dirty = true;
    void this.pulse().catch(() => undefined);
  }

  pulse(): Promise<void> {
    if (this.sealed) return this.withdrawal ?? Promise.resolve();
    if (this.pending) return this.pending;
    const pending = (async () => {
      do {
        this.dirty = false;
        for (const [queue, consumer] of this.consumers) {
          if (this.sealed) break;
          const report = AgentRuntimePresenceReportSchema.parse(this.report(queue, consumer));
          try { await this.presence.publish(report); }
          catch { /* Missing or expired proof is unavailable; telemetry never dispatches. */ }
        }
      } while (this.dirty && !this.sealed);
    })();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }

  private withdraw(): Promise<void> {
    if (this.withdrawal) return this.withdrawal;
    this.sealed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const detach of this.detach.splice(0)) detach();
    // Calling withdraw seals each pair synchronously, before awaiting a pulse.
    this.withdrawal = Promise.allSettled([...this.consumers.keys()].map(queue => this.presence.withdraw(this.instanceId, queue)))
      .then(() => undefined);
    return this.withdrawal;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "stopped";
    this.closing = (async () => {
      await this.withdraw();
      await this.pending?.catch(() => undefined);
      await this.presence.close();
    })();
    return this.closing;
  }
}
