import { FollowupAttentionDispatcher } from "@yummyai/followup-core";
import type { DatabaseConnection } from "@yummyai/database";
export class BusinessFollowupScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: ReturnType<FollowupAttentionDispatcher["dispatch"]>;
  private stopping = false;
  private readonly dispatcher: FollowupAttentionDispatcher;
  constructor(
    database: DatabaseConnection,
    private readonly intervalMs = 60_000,
  ) {
    this.dispatcher = new FollowupAttentionDispatcher(database);
  }
  start() {
    if (this.timer || this.stopping) return;
    const tick = () =>
      void this.dispatch()
        .then((result) => {
          if (result.failures)
            process.stderr.write(`Business follow-up deferred ${result.failures} checks\n`);
        })
        .catch(() => process.stderr.write("Business follow-up check failed\n"));
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
    tick();
  }
  async dispatch() {
    if (this.stopping || this.pending) return { checked: 0, notices: 0, deferred: 0, failures: 0 };
    this.pending = this.dispatcher.dispatch();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) await this.pending;
  }
}
