import { performance } from "node:perf_hooks";

export interface RuntimeConsumer {
  waitUntilReady(): Promise<unknown>;
  run(): Promise<unknown>;
  close(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: "error", handler: (error: Error) => void): unknown;
}
interface RuntimeScheduler { start(): void; close(): Promise<unknown> }
export type WorkerLifecycleEvent = {
  type: "worker.lifecycle";
  state: "starting" | "ready" | "stopping" | "stopped" | "error";
  queues: string[];
  schedulers: string[];
  code?: string;
  clean?: boolean;
};
export interface WorkerShutdownResult { clean: boolean; timedOut: boolean; failedResources: string[]; reason: string }

/** Owns transport resources, not business state, task retries or approval. */
export class WorkerLifecycle {
  private phase: "assembling" | "starting" | "ready" | "stopping" | "stopped" = "assembling";
  private readonly consumers = new Map<string, RuntimeConsumer>();
  private readonly schedulers = new Map<string, RuntimeScheduler>();
  private readonly resources = new Map<string, (force: boolean) => Promise<unknown>>();
  private startupFailure = false;
  private stopping?: Promise<WorkerShutdownResult>;
  private stoppedResolve!: (result: WorkerShutdownResult) => void;
  readonly stopped = new Promise<WorkerShutdownResult>(resolve => { this.stoppedResolve = resolve; });

  constructor(private readonly options: { startupTimeoutMs: number; shutdownTimeoutMs: number; report: (event: WorkerLifecycleEvent) => void }) {
    if (![options.startupTimeoutMs, options.shutdownTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid Worker lifecycle deadline");
  }
  assertAssembling() { if (this.phase !== "assembling") throw new Error("Worker is no longer assembling"); }
  consumer<T extends RuntimeConsumer>(name: string, consumer: T): T {
    this.assertAssembling();
    if (this.consumers.has(name)) throw new Error("Duplicate Worker consumer");
    this.consumers.set(name, consumer);
    consumer.on("error", () => this.fault("WORKER_CONNECTION_ERROR"));
    return consumer;
  }
  scheduler<T extends RuntimeScheduler>(name: string, scheduler: T): T {
    this.assertAssembling();
    if (this.schedulers.has(name)) throw new Error("Duplicate Worker scheduler");
    this.schedulers.set(name, scheduler); return scheduler;
  }
  resource(name: string, close: (force: boolean) => Promise<unknown>) {
    this.assertAssembling(); if (this.resources.has(name)) throw new Error("Duplicate Worker resource"); this.resources.set(name, close);
  }
  async preflight(check: () => Promise<unknown>) {
    this.assertAssembling();
    await deadline(Promise.resolve().then(check), this.options.startupTimeoutMs);
    this.assertAssembling();
  }
  async start() {
    this.assertAssembling(); this.phase = "starting"; this.report("starting");
    try {
      await deadline(Promise.all([...this.consumers.values()].map(worker => worker.waitUntilReady())), this.options.startupTimeoutMs);
      if (this.phase !== "starting" || this.startupFailure) throw new Error("Worker startup interrupted");
      for (const scheduler of this.schedulers.values()) scheduler.start();
      for (const worker of this.consumers.values()) void worker.run().then(() => {
        if (this.phase === "starting" || this.phase === "ready") this.fault("WORKER_LOOP_ENDED");
      }, () => this.fault("WORKER_LOOP_FAILED"));
      await Promise.resolve();
      if (this.phase !== "starting" || this.startupFailure) throw new Error("Worker startup interrupted");
      this.phase = "ready"; this.report("ready");
    } catch {
      this.report("error", { code: "WORKER_STARTUP_FAILED" });
      await this.shutdown("startup_failed");
      throw new Error("WORKER_STARTUP_FAILED");
    }
  }
  shutdown(reason = "shutdown"): Promise<WorkerShutdownResult> {
    if (this.stopping) return this.stopping;
    this.phase = "stopping"; this.report("stopping", { code: reason });
    this.stopping = this.closeResources(reason);
    return this.stopping;
  }
  private fault(code: string) {
    if (this.phase === "stopping" || this.phase === "stopped") return;
    this.startupFailure = true; this.report("error", { code });
    if (this.phase === "ready") void this.shutdown("consumer_failed");
  }
  private report(state: WorkerLifecycleEvent["state"], extra: Pick<WorkerLifecycleEvent, "code" | "clean"> = {}) {
    this.options.report({ type: "worker.lifecycle", state, queues: [...this.consumers.keys()], schedulers: [...this.schedulers.keys()], ...extra });
  }
  private async closeResources(reason: string): Promise<WorkerShutdownResult> {
    const expires = performance.now() + this.options.shutdownTimeoutMs, failedResources: string[] = [];
    let timedOut = false;
    // Invoke every close before awaiting any one: all timers and consumers stop
    // accepting new work even when an active request takes time to finish.
    const close = (name: string, operation: () => Promise<unknown>) => Promise.resolve().then(operation).catch(() => { failedResources.push(name); });
    const draining = [...this.schedulers].map(([name, scheduler]) => close(name, () => scheduler.close()));
    draining.push(...[...this.consumers].map(([name, worker]) => close(name, () => worker.close())));
    try { await deadline(Promise.all(draining), Math.max(1, expires - performance.now())); }
    catch { timedOut = true; for (const worker of this.consumers.values()) void Promise.resolve().then(() => worker.disconnect()).catch(() => undefined); }
    // Shared publishers and the database remain usable while active jobs drain.
    // Close the database last; no cleanup marks a business task as successful.
    for (const [name, operation] of [...this.resources].reverse()) {
      try { await deadline(close(name, () => operation(timedOut)), Math.max(1, expires - performance.now())); }
      catch { timedOut = true; failedResources.push(name); }
    }
    this.phase = "stopped";
    const result = { clean: !timedOut && !failedResources.length, timedOut, failedResources, reason };
    this.report("stopped", { clean: result.clean }); this.stoppedResolve(result); return result;
  }
}

async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("WORKER_DEADLINE")), milliseconds); timer.unref(); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function workerDeadline(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 300_000) throw new Error("Invalid Worker deadline setting");
  return parsed;
}
