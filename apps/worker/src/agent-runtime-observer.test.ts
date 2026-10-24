import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_LOOP_VERSION } from "@yummyai/contracts/ai/agent-loop";
import { AGENT_NATIVE_V3_VERSION } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_RUNTIME_DISPATCH_FRESH_MS, AgentRuntimePresenceReportSchema, type AgentRuntimePresenceReport } from "@yummyai/contracts/ai/agent-runtime-readiness";
import { AgentRuntimeObserver, type AgentRuntimeClient, type AgentRuntimeConsumer } from "./agent-runtime-observer.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class Client extends EventEmitter implements AgentRuntimeClient { status = "ready"; }
const observers: AgentRuntimeObserver[] = [];
function fixture(pendingConnections = false) {
  let now = 1_000;
  const normal = new Client(), blocking = new Client(), normalReady = deferred<Client>(), blockingReady = deferred<Client>();
  const published: AgentRuntimePresenceReport[] = [], withdrawn: Array<{ id: string; queue: string }> = [];
  const presence = {
    publish: vi.fn(async (report: AgentRuntimePresenceReport) => { published.push(AgentRuntimePresenceReportSchema.parse(structuredClone(report))); }),
    withdraw: vi.fn(async (id: string, queue: "agent-loop" | "agent-plan") => { withdrawn.push({ id, queue }); }),
    close: vi.fn(async () => {}),
  };
  const worker: AgentRuntimeConsumer = { client: pendingConnections ? normalReady.promise : Promise.resolve(normal),
    waitUntilReady: vi.fn(() => pendingConnections ? blockingReady.promise : Promise.resolve(blocking)),
    isRunning: vi.fn(() => true), isPaused: vi.fn(() => false) };
  const observer = new AgentRuntimeObserver(presence, { instanceId: "019d1710-b400-7000-8000-000000000002", now: () => now }); observers.push(observer);
  observer.register("agent-plan", worker, [AGENT_NATIVE_V3_VERSION]);
  const dispatcher = observer.scheduler("agent-plan");
  const phase = (state: "starting" | "ready" | "stopping" | "stopped" | "error") => observer.lifecycle({ type: "worker.lifecycle", state, queues: ["agent-plan"], schedulers: ["agentPlanScheduler"] });
  async function settle() { for (let i = 0; i < 3; i++) { await Promise.resolve(); await observer.pulse(); } return published.at(-1)!; }
  return { normal, blocking, normalReady, blockingReady, published, withdrawn, presence, worker, observer, dispatcher, phase, settle, advance: (milliseconds: number) => { now += milliseconds; } };
}
afterEach(async () => { for (const observer of observers.splice(0)) await observer.close(); vi.useRealTimers(); });

describe("passive original Worker runtime observer", () => {
  it("never creates readiness from pending public clients and observes each live connection separately", async () => {
    const f = fixture(true); f.phase("ready");
    expect((await f.settle()).consumer).toEqual({ running: true, paused: false, normalConnection: "unavailable", blockingConnection: "unavailable" });
    f.normalReady.resolve(f.normal); await f.settle();
    expect(f.published.at(-1)?.consumer.blockingConnection).toBe("unavailable");
    f.blockingReady.resolve(f.blocking); const ready = await f.settle();
    expect(ready.consumer).toEqual({ running: true, paused: false, normalConnection: "ready", blockingConnection: "ready" });
    expect(ready.workerName).toBe(f.observer.workerName); expect(ready.instanceId).toBe(f.observer.instanceId);
    expect(f.worker.waitUntilReady).toHaveBeenCalledOnce();
  });

  it("records actual running pause closing and connection state without replacing the consumer", async () => {
    const f = fixture(); f.phase("ready"); await f.settle();
    vi.mocked(f.worker.isRunning).mockReturnValue(false); expect((await f.settle()).consumer.running).toBe(false);
    vi.mocked(f.worker.isRunning).mockReturnValue(true); vi.mocked(f.worker.isPaused).mockReturnValue(true);
    expect((await f.settle()).consumer.paused).toBe(true);
    vi.mocked(f.worker.isPaused).mockReturnValue(false); f.normal.status = "reconnecting"; f.normal.emit("reconnecting");
    expect((await f.settle()).consumer).toMatchObject({ normalConnection: "unavailable", blockingConnection: "ready" });
    f.normal.status = "ready"; f.blocking.status = "end"; f.blocking.emit("end");
    expect((await f.settle()).consumer).toMatchObject({ normalConnection: "ready", blockingConnection: "unavailable" });
    Object.defineProperty(f.worker, "closing", { value: Promise.resolve(), configurable: true });
    expect((await f.settle()).consumer.running).toBe(false);
  });

  it("ages only a completed successful dispatch and retains failure until a later complete success", async () => {
    const f = fixture(); f.phase("ready");
    expect((await f.settle()).dispatcher).toMatchObject({ started: false, lastSuccessAgeMs: null, currentFailure: false });
    f.dispatcher("succeeded"); expect((await f.settle()).dispatcher.lastSuccessAgeMs).toBeNull();
    f.dispatcher("started"); f.dispatcher("succeeded"); expect((await f.settle()).dispatcher.lastSuccessAgeMs).toBe(0);
    f.advance(AGENT_RUNTIME_DISPATCH_FRESH_MS + 1); f.dispatcher("dispatching");
    expect((await f.settle()).dispatcher.lastSuccessAgeMs).toBe(AGENT_RUNTIME_DISPATCH_FRESH_MS + 1);
    f.dispatcher("failed"); expect((await f.settle()).dispatcher.currentFailure).toBe(true);
    f.dispatcher("dispatching"); expect((await f.settle()).dispatcher.currentFailure).toBe(true);
    f.dispatcher("succeeded"); expect((await f.settle()).dispatcher).toMatchObject({ lastSuccessAgeMs: 0, currentFailure: false });
    f.dispatcher("closing"); f.advance(10); f.dispatcher("succeeded");
    expect((await f.settle()).dispatcher).toMatchObject({ closing: true, lastSuccessAgeMs: 10 });
  });

  it("withdraws and permanently seals an instance before an in-flight old publication completes", async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    f.presence.publish.mockImplementationOnce(async report => { entered.resolve(); await release.promise; f.published.push(report); });
    f.phase("ready"); await entered.promise;
    f.phase("stopping"); expect(f.presence.withdraw).toHaveBeenCalledExactlyOnceWith(f.observer.instanceId, "agent-plan");
    const closing = f.observer.close(); release.resolve(); await closing;
    const calls = f.presence.publish.mock.calls.length;
    f.phase("ready"); f.dispatcher("succeeded"); f.normal.emit("ready"); await f.observer.pulse();
    expect(f.presence.publish).toHaveBeenCalledTimes(calls); expect(f.presence.close).toHaveBeenCalledOnce();
    // An old publish completion is not a new proof: the Redis bridge independently
    // fences that exact instance/queue. This pure test only proves the observer seal.
    expect(f.withdrawn).toEqual([{ id: f.observer.instanceId, queue: "agent-plan" }]);
  });

  it("does not wait for a blocked Redis publication or expose the original error to obtain withdrawal", async () => {
    const f = fixture(); f.presence.publish.mockRejectedValue(new Error("synthetic-private-redis-credential"));
    f.phase("starting"); await f.settle(); f.phase("error"); await f.observer.close();
    expect(f.presence.withdraw).toHaveBeenCalledExactlyOnceWith(f.observer.instanceId, "agent-plan");
    expect(f.presence.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.published)).not.toContain("synthetic-private");
  });

  it("rejects duplicated registration and a protocol assigned to another queue without starting any resource", async () => {
    const f = fixture();
    expect(() => f.observer.register("agent-plan", f.worker, [AGENT_NATIVE_V3_VERSION])).toThrow();
    expect(() => f.observer.register("agent-loop", f.worker, [AGENT_NATIVE_V3_VERSION])).toThrow();
    const other = new AgentRuntimeObserver(f.presence); observers.push(other);
    other.register("agent-loop", f.worker, [AGENT_LOOP_VERSION]); await other.pulse();
    await other.close(); expect(() => other.register("agent-plan", f.worker, [AGENT_NATIVE_V3_VERSION])).toThrow();
    expect(f.presence.publish.mock.calls.every(([value]) => !Object.hasOwn(value, "tenantId"))).toBe(true);
  });
});
