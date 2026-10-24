import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPillowUpscaleProcess } from "./pillow-super-resolution-process.js";

describe("bounded native process", () => {
  async function fixture(test: (cwd: string) => Promise<void>) {
    const cwd = await mkdtemp(join(tmpdir(), "pillow-process-test-"));
    try { await test(cwd); }
    finally {
      assert(resolve(cwd).startsWith(`${resolve(tmpdir())}${sep}pillow-process-test-`), "Invalid cleanup target");
      await rm(cwd, { recursive: true, force: true });
    }
  }
  it("returns a safe timeout even when the child has not finished starting", async () => fixture(async cwd => {
    await expect(runPillowUpscaleProcess({ executable: process.execPath, cwd, timeoutMs: 500,
      args: ["-e", "setInterval(()=>{},1000)"] }))
      .rejects.toMatchObject({ code: "agent_upscale_timeout" });
  }));
  it("cancels an acknowledged running child and waits until its PID exits", async () => fixture(async cwd => {
    const controller = new AbortController();
    const pending = runPillowUpscaleProcess({ executable: process.execPath, cwd, timeoutMs: 20_000, signal: controller.signal,
      args: ["-e", "require('node:fs').writeFileSync('pid',String(process.pid));setInterval(()=>{},1000)"] });
    const result = pending.catch(error => error);
    try {
      const pid = await vi.waitFor(async () => Number(await readFile(join(cwd, "pid"), "utf8")), { timeout: 10_000, interval: 100 });
      expect(() => process.kill(pid, 0)).not.toThrow();
      controller.abort();
      expect(await result).toMatchObject({ code: "agent_upscale_cancelled" });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { controller.abort(); await result; }
  }), 15_000);
  it("redacts spawn errors and never starts a pre-cancelled process", async () => fixture(async cwd => {
    await expect(runPillowUpscaleProcess({ executable: join(cwd, "sensitive-missing.exe"), cwd, args: [], timeoutMs: 500 }))
      .rejects.toMatchObject({ message: "agent_upscale_process_failed" });
    const controller = new AbortController(); controller.abort();
    await expect(runPillowUpscaleProcess({ executable: process.execPath, cwd, args: [], timeoutMs: 500, signal: controller.signal }))
      .rejects.toMatchObject({ code: "agent_upscale_cancelled" });
  }));
});
import assert from "node:assert/strict";
