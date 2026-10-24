import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerLifecycle, workerDeadline, type WorkerLifecycleEvent } from "./lifecycle.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function consumer(events: string[], name: string, ready = Promise.resolve(), drain = Promise.resolve()) {
  const lifetime = deferred();
  const result = Object.assign(new EventEmitter(), {
    waitUntilReady: vi.fn(async () => { await ready; events.push(`${name}:ready`); }),
    run: vi.fn(async () => { events.push(`${name}:run`); await lifetime.promise; }),
    close: vi.fn(async () => { events.push(`${name}:close`); await drain; lifetime.resolve(); }),
    disconnect: vi.fn(async () => { events.push(`${name}:disconnect`); lifetime.resolve(); }),
  });
  return result;
}
function fixture() {
  const events: string[] = [], reports: WorkerLifecycleEvent[] = [];
  const lifecycle = new WorkerLifecycle({ startupTimeoutMs: 30, shutdownTimeoutMs: 30, report: event => { reports.push(event); } });
  return { events, reports, lifecycle };
}
afterEach(() => vi.useRealTimers());

describe("standard Worker resource lifecycle", () => {
  it("waits for every consumer before starting schedulers or consuming jobs", async () => {
    const { events, lifecycle, reports } = fixture(), ready = deferred();
    const a = lifecycle.consumer("a", consumer(events, "a")), b = lifecycle.consumer("b", consumer(events, "b", ready.promise));
    const scheduler = lifecycle.scheduler("dispatch", { start: vi.fn(), close: vi.fn(async () => {}) });
    const starting = lifecycle.start(); await Promise.resolve();
    expect(a.run).not.toHaveBeenCalled(); expect(b.run).not.toHaveBeenCalled(); expect(scheduler.start).not.toHaveBeenCalled();
    ready.resolve(); await starting;
    expect(reports.find(event => event.state === "ready")?.queues).toEqual(["a", "b"]); expect(a.run).toHaveBeenCalledOnce();
    expect((await lifecycle.shutdown()).clean).toBe(true);
  });

  it("cleans a partial startup without running any consumer", async () => {
    const { events, lifecycle } = fixture();
    const a = lifecycle.consumer("a", consumer(events, "a")), b = lifecycle.consumer("b", consumer(events, "b", Promise.reject(new Error("synthetic Redis unavailable"))));
    const scheduler = lifecycle.scheduler("dispatch", { start: vi.fn(), close: vi.fn(async () => {}) });
    lifecycle.resource("database", async () => { events.push("database:close"); });
    await expect(lifecycle.start()).rejects.toThrow("WORKER_STARTUP_FAILED");
    expect(a.run).not.toHaveBeenCalled(); expect(b.run).not.toHaveBeenCalled(); expect(a.close).toHaveBeenCalledOnce(); expect(b.close).toHaveBeenCalledOnce();
    expect(scheduler.start).not.toHaveBeenCalled(); expect(scheduler.close).toHaveBeenCalledOnce(); expect(events.at(-1)).toBe("database:close");
  });

  it("rolls back already-started timers when another dispatcher cannot start", async () => {
    const { events, lifecycle } = fixture(), a = lifecycle.consumer("a", consumer(events, "a"));
    const first = lifecycle.scheduler("first", { start: vi.fn(), close: vi.fn(async () => {}) });
    const failed = lifecycle.scheduler("failed", { start: () => { throw new Error("synthetic timer error"); }, close: vi.fn(async () => {}) });
    await expect(lifecycle.start()).rejects.toThrow("WORKER_STARTUP_FAILED");
    expect(first.close).toHaveBeenCalledOnce(); expect(failed.close).toHaveBeenCalledOnce(); expect(a.run).not.toHaveBeenCalled();
  });

  it("stops every source of new work immediately, then closes publishers and the database after draining", async () => {
    const { events, lifecycle } = fixture(), drain = deferred();
    lifecycle.resource("database", async () => { events.push("database:close"); });
    lifecycle.resource("publisher", async () => { events.push("publisher:close"); });
    lifecycle.consumer("slow", consumer(events, "slow", Promise.resolve(), drain.promise)); lifecycle.consumer("fast", consumer(events, "fast"));
    lifecycle.scheduler("dispatch", { start() {}, close: async () => { events.push("dispatch:close"); } });
    await lifecycle.start(); const first = lifecycle.shutdown(); expect(lifecycle.shutdown()).toBe(first); await Promise.resolve();
    expect(events).toEqual(expect.arrayContaining(["slow:close", "fast:close", "dispatch:close"])); expect(events).not.toContain("publisher:close");
    drain.resolve(); expect((await first).clean).toBe(true); expect(events.slice(-2)).toEqual(["publisher:close", "database:close"]);
  });

  it("bounds shutdown without reporting an unfinished job as completed", async () => {
    vi.useFakeTimers();
    const { events, lifecycle } = fixture(), drain = deferred(), forced: boolean[] = [];
    lifecycle.resource("database", async force => { forced.push(force); });
    const a = lifecycle.consumer("a", consumer(events, "a", Promise.resolve(), drain.promise));
    await lifecycle.start(); const stopping = lifecycle.shutdown(); await vi.advanceTimersByTimeAsync(31);
    expect(await stopping).toMatchObject({ clean: false, timedOut: true }); expect(a.disconnect).toHaveBeenCalledOnce(); expect(forced).toEqual([true]);
    expect(events).not.toContain("job:completed"); drain.resolve();
  });

  it("continues closing other resources after one publisher fails", async () => {
    const { events, lifecycle } = fixture();
    lifecycle.resource("database", async () => { events.push("database:close"); });
    lifecycle.resource("publisher", async () => { throw new Error("synthetic close error"); });
    await lifecycle.start(); expect(await lifecycle.shutdown()).toMatchObject({ clean: false, failedResources: ["publisher"] }); expect(events).toContain("database:close");
  });

  it("handles a consumer connection error with safe metadata and a supervised stop", async () => {
    const { events, lifecycle, reports } = fixture(), a = lifecycle.consumer("a", consumer(events, "a"));
    await lifecycle.start(); a.emit("error", new Error("synthetic-private-credential-and-body"));
    expect((await lifecycle.stopped).reason).toBe("consumer_failed"); expect(JSON.stringify(reports)).not.toContain("synthetic-private");
  });

  it("times out an unready consumer and never starts its processor", async () => {
    vi.useFakeTimers(); const { events, lifecycle } = fixture(), pending = deferred();
    const a = lifecycle.consumer("a", consumer(events, "a", pending.promise));
    const result = lifecycle.start().catch(error => error); await vi.advanceTimersByTimeAsync(31);
    expect((await result).message).toBe("WORKER_STARTUP_FAILED"); expect(a.run).not.toHaveBeenCalled(); expect(a.close).toHaveBeenCalledOnce(); pending.resolve();
  });

  it("does not proceed after a shutdown during preflight", async () => {
    const { lifecycle } = fixture(), pending = deferred();
    const checking = lifecycle.preflight(() => pending.promise); await lifecycle.shutdown(); pending.resolve();
    await expect(checking).rejects.toThrow("no longer assembling");
  });

  it("validates explicit deadlines without treating an invalid value as a default", () => {
    expect(workerDeadline(undefined, 15_000)).toBe(15_000); expect(workerDeadline("1000", 15_000)).toBe(1000);
    for (const value of ["0", "-1", "NaN", "999", "300001", "1000.5"]) expect(() => workerDeadline(value, 15_000)).toThrow();
  });
});

describe("runtime readiness withdrawal follows the standard lifecycle", () => {
  it("reports stopping before waiting for an actual consumer drain and reports stopped only after close", async () => {
    const { events, lifecycle, reports } = fixture(), drain = deferred();
    lifecycle.consumer("agent-plan", consumer(events, "agent-plan", Promise.resolve(), drain.promise));
    lifecycle.scheduler("agentPlanScheduler", { start() {}, async close() { events.push("scheduler:close"); } });
    await lifecycle.start();
    expect(reports.at(-1)?.state).toBe("ready");
    const stopped = lifecycle.shutdown("parent_shutdown");
    expect(reports.at(-1)).toMatchObject({ state: "stopping", queues: ["agent-plan"], schedulers: ["agentPlanScheduler"] });
    expect(reports.some(event => event.state === "stopped")).toBe(false);
    await Promise.resolve(); expect(events).toContain("agent-plan:close");
    drain.resolve(); expect(await stopped).toMatchObject({ clean: true, reason: "parent_shutdown" });
    expect(reports.map(event => event.state)).toEqual(["starting", "ready", "stopping", "stopped"]);
  });

  it("withdraws readiness when the original run loop fails and never starts a second cleanup", async () => {
    const { events, lifecycle, reports } = fixture();
    let rejectRun!: (error: Error) => void;
    const running = new Promise<never>((_, reject) => { rejectRun = reject; });
    const selected = consumer(events, "agent-loop"); selected.run.mockImplementation(() => running);
    lifecycle.consumer("agent-loop", selected);
    const databaseClose = vi.fn(async () => {}); lifecycle.resource("database", databaseClose);
    await lifecycle.start(); rejectRun(new Error("synthetic-private-runtime-loop-failure"));
    expect(await lifecycle.stopped).toMatchObject({ clean: true, reason: "consumer_failed" });
    expect(reports).toContainEqual(expect.objectContaining({ state: "error", code: "WORKER_LOOP_FAILED" }));
    expect(reports.at(-1)?.state).toBe("stopped"); expect(databaseClose).toHaveBeenCalledOnce(); expect(selected.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(reports)).not.toContain("synthetic-private");
    await lifecycle.shutdown(); expect(databaseClose).toHaveBeenCalledOnce();
  });

  it("does not retain readiness when an original consumption loop resolves without a requested stop", async () => {
    const { events, lifecycle, reports } = fixture(), ended = deferred();
    const selected = consumer(events, "agent-plan"); selected.run.mockImplementation(() => ended.promise);
    lifecycle.consumer("agent-plan", selected); await lifecycle.start(); ended.resolve();
    expect(await lifecycle.stopped).toMatchObject({ clean: true, reason: "consumer_failed" });
    expect(reports).toContainEqual(expect.objectContaining({ state: "error", code: "WORKER_LOOP_ENDED" }));
    expect(selected.close).toHaveBeenCalledOnce(); expect(reports.at(-1)?.state).toBe("stopped");
  });
});
