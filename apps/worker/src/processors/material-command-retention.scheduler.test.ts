import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseConnection } from "@yummyai/database";
import { MaterialCommandRetentionScheduler } from "./material-command-retention.scheduler.js";
import type { MaterialRetentionEvent } from "./material-command-retention.scheduler.js";
import { IncomingCommandRetentionScheduler, type IncomingRetentionEvent } from "./incoming-command-retention.scheduler.js";

describe.each([
  { label: "material", Scheduler: MaterialCommandRetentionScheduler, moduleName: "material-command-retention.scheduler.ts", className: "MaterialCommandRetentionScheduler", schedulerName: "materialCommandRetentionScheduler" },
  { label: "incoming", Scheduler: IncomingCommandRetentionScheduler, moduleName: "incoming-command-retention.scheduler.ts", className: "IncomingCommandRetentionScheduler", schedulerName: "incomingCommandRetentionScheduler" },
] as const)("$label input retention lifecycle", ({ Scheduler, moduleName, className, schedulerName }) => {
  it("reports real completed batches without replacing an overlapping check with a false healthy heartbeat", async () => {
    vi.useFakeTimers();
    const events: (MaterialRetentionEvent | IncomingRetentionEvent)[] = [];
    let finish!: (result: { tenants: number; redacted: number; failures: number }) => void;
    const scheduler = new Scheduler({} as DatabaseConnection, 50,
      { dispatch: () => new Promise(resolve => { finish = resolve; }) }, event => events.push(event));
    try {
      scheduler.start(); await vi.advanceTimersByTimeAsync(100); expect(events).toEqual([]);
      finish({ tenants: 2, redacted: 1, failures: 0 }); await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual([{ type: "worker.maintenance", scheduler: schedulerName, state: "completed", tenants: 2, redacted: 1, failures: 0 }]);
    } finally { await scheduler.close(); vi.useRealTimers(); }
  });
  it("reports sanitized deferred and failed checks and recovers on a subsequent tick", async () => {
    vi.useFakeTimers(); const events: (MaterialRetentionEvent | IncomingRetentionEvent)[] = [];
    const dispatch = vi.fn().mockResolvedValueOnce({ tenants: 1, redacted: 0, failures: 1 })
      .mockRejectedValueOnce(new Error("synthetic secret must not reach maintenance output"))
      .mockResolvedValue({ tenants: 2, redacted: 0, failures: 0 });
    const scheduler = new Scheduler({} as DatabaseConnection, 50, { dispatch }, event => events.push(event));
    try {
      scheduler.start(); await vi.advanceTimersByTimeAsync(100);
      expect(events.map(event => event.state)).toEqual(["deferred", "failed", "completed"]);
      expect(JSON.stringify(events)).not.toContain("synthetic secret");
    } finally { await scheduler.close(); vi.useRealTimers(); }
  });
  it("keeps an independent Node process alive for its next batch without an IPC or database handle", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const moduleUrl = new URL(moduleName, import.meta.url).href;
    const code = `import { ${className} as Scheduler } from ${JSON.stringify(moduleUrl)};
      let ticks=0;
      const scheduler=new Scheduler({},50,{dispatch:async()=>{
        console.log(JSON.stringify({tick:++ticks}));
        if(ticks===2)setImmediate(()=>void scheduler.close());
        return {tenants:0,redacted:0,failures:0};
      }},()=>{});
      scheduler.start();`;
    const child = spawnSync(process.execPath, ["--import", "./apps/worker/node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", code],
      { cwd: root, windowsHide: true, timeout: 15_000, encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
    expect(child.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([{ tick: 1 }, { tick: 2 }]);
  }, 20_000);
  it("waits for an in-flight privacy batch and never overlaps or restarts after close", async () => {
    let finish!: (result: { tenants: number; redacted: number; failures: number }) => void;
    const dispatch = vi.fn(() => new Promise<{ tenants: number; redacted: number; failures: number }>(resolve => { finish = resolve; }));
    const scheduler = new Scheduler({} as DatabaseConnection, 60_000, { dispatch });
    const pending = scheduler.dispatch(), closing = scheduler.close();
    let closed = false; void closing.then(() => { closed = true; });
    await scheduler.dispatch(); expect(dispatch).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    finish({ tenants: 1, redacted: 1, failures: 0 });
    await Promise.all([pending, closing]);
    scheduler.start(); await scheduler.dispatch(); expect(dispatch).toHaveBeenCalledOnce();
  });
  it("clears its pending batch after failure so the next explicit tick can recover", async () => {
    const dispatch = vi.fn().mockRejectedValueOnce(new Error("synthetic privacy failure")).mockResolvedValue({ tenants: 1, redacted: 2, failures: 0 });
    const scheduler = new Scheduler({} as DatabaseConnection, 60_000, { dispatch });
    await expect(scheduler.dispatch()).rejects.toThrow("synthetic privacy failure");
    await expect(scheduler.dispatch()).resolves.toEqual({ tenants: 1, redacted: 2, failures: 0 });
    await scheduler.close(); expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
