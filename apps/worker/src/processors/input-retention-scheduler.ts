export type RetentionBatch = { tenants: number; redacted: number; failures: number };
type RetentionName = "materialCommandRetentionScheduler" | "incomingCommandRetentionScheduler" | "procurementCommandRetentionScheduler" | "financeCommandRetentionScheduler" | "advertisingCommandRetentionScheduler" | "factoryErpSourceRetentionScheduler";
export type InputRetentionEvent<Name extends RetentionName> = RetentionBatch & {
  type: "worker.maintenance"; scheduler: Name; state: "completed" | "deferred" | "failed";
};
export function reportInputRetention<Name extends RetentionName>(event: InputRetentionEvent<Name>) {
  process.stdout.write(JSON.stringify(event) + "\n");
  if (process.connected) {
    try { process.send?.(event, () => undefined); } catch { /* IPC supervision is optional. */ }
  }
}

/** Shared timer discipline only. Each dispatcher owns one privacy capability. */
export class InputRetentionScheduler<Name extends RetentionName> {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<RetentionBatch>;
  private stopping = false;
  constructor(private readonly name: Name, private readonly intervalMs: number,
    private readonly dispatcher: { dispatch(): Promise<RetentionBatch> },
    private readonly report: (event: InputRetentionEvent<Name>) => void) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError("Invalid retention interval");
  }
  start() {
    if (this.timer || this.stopping) return;
    const tick = () => {
      if (this.stopping || this.pending) return;
      void this.dispatch().then(result => this.report({ type: "worker.maintenance", scheduler: this.name,
        state: result.failures ? "deferred" : "completed", ...result,
      })).catch(() => this.report({ type: "worker.maintenance", scheduler: this.name,
        state: "failed", tenants: 0, redacted: 0, failures: 1 }));
    };
    this.timer = setInterval(tick, this.intervalMs); tick();
  }
  async dispatch(): Promise<RetentionBatch> {
    if (this.stopping || this.pending) return { tenants: 0, redacted: 0, failures: 0 };
    this.pending = this.dispatcher.dispatch();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) await this.pending;
  }
}
