import { describe, expect, it } from "vitest";
import { WorkerReadinessServer, workerReadinessPort } from "./runtime-readiness.js";

describe("Worker loopback readiness", () => {
  it("requires an explicit valid health port", () => {
    expect(workerReadinessPort(undefined)).toBeUndefined();
    expect(workerReadinessPort("8001")).toBe(8001);
    for (const value of ["", "0", "80", "65536", "8001.5", "-1", "8001x"]) expect(() => workerReadinessPort(value)).toThrow("WORKER_HEALTH_PORT_INVALID");
  });
  it("reports the actual lifecycle and exact consumers without keeping readiness after failure", async () => {
    const server = new WorkerReadinessServer(0);
    try {
      const address = await server.start();
      expect(address.address).toBe("127.0.0.1");
      const url = `http://127.0.0.1:${address.port}/health`;
      expect((await fetch(url)).status).toBe(503);
      server.report({ type: "worker.lifecycle", state: "ready", queues: ["logistics"], schedulers: [] });
      const ready = await fetch(url);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ state: "ready", pid: process.pid, queues: ["logistics"], schedulers: [] });
      server.report({ type: "worker.lifecycle", state: "error", code: "WORKER_LOOP_FAILED", queues: ["logistics"], schedulers: [] });
      expect((await fetch(url)).status).toBe(503);
      expect((await fetch(url + "?task=private")).status).toBe(404);
      expect((await fetch(url, { method: "POST" })).status).toBe(404);
    } finally { await server.close(); }
  });
});
