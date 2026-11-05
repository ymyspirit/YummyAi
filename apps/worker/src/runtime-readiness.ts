import { createServer, type Server } from "node:http";
import type { WorkerLifecycleEvent } from "./lifecycle.js";

export function workerReadinessPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error("WORKER_HEALTH_PORT_INVALID");
  return Number(value);
}

/** Loopback runtime health only; contains no task, tenant or credential data. */
export class WorkerReadinessServer {
  private event: WorkerLifecycleEvent = { type: "worker.lifecycle", state: "starting", queues: [], schedulers: [] };
  private readonly server: Server;
  constructor(private readonly port: number) {
    this.server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/health") { response.writeHead(404); response.end(); return; }
      response.writeHead(this.event.state === "ready" ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ state: this.event.state, pid: process.pid, queues: this.event.queues, schedulers: this.event.schedulers }));
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
  }
  report(event: WorkerLifecycleEvent) { this.event = { ...event, queues: [...event.queues], schedulers: [...event.schedulers] }; }
  async start() {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.server.removeListener("listening", ready); reject(error); };
      const ready = () => { this.server.removeListener("error", failed); resolve(); };
      this.server.once("error", failed); this.server.once("listening", ready); this.server.listen(this.port, "127.0.0.1");
    });
    this.server.unref();
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("WORKER_HEALTH_BIND_FAILED");
    return address;
  }
  async close() {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => { this.server.close(error => error ? reject(error) : resolve()); this.server.closeIdleConnections(); });
  }
}
