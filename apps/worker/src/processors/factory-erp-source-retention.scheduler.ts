import type { DatabaseConnection } from "@yummyai/database";
import { createFactoryErpSourcePurgerFromEnvironment } from "@yummyai/storage";
import { FactoryErpSourceRetentionDispatcher } from "./factory-erp-source-retention.dispatcher.js";
import { InputRetentionScheduler, reportInputRetention, type InputRetentionEvent } from "./input-retention-scheduler.js";

export type FactoryErpSourceRetentionEvent = InputRetentionEvent<"factoryErpSourceRetentionScheduler">;
function createDispatcher(database: DatabaseConnection, intervalMs: number) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError("Invalid retention interval");
  const purger = createFactoryErpSourcePurgerFromEnvironment();
  try { return new FactoryErpSourceRetentionDispatcher(database, purger); }
  catch (error) { purger.close(); throw error; }
}
export class FactoryErpSourceRetentionScheduler extends InputRetentionScheduler<"factoryErpSourceRetentionScheduler"> {
  constructor(database: DatabaseConnection, intervalMs = 60_000,
    private readonly retention: Pick<FactoryErpSourceRetentionDispatcher, "dispatch" | "stop"> =
      createDispatcher(database, intervalMs),
    report: (event: FactoryErpSourceRetentionEvent) => void = reportInputRetention) {
    super("factoryErpSourceRetentionScheduler", intervalMs, retention, report);
  }

  override async close() {
    // stop() aborts actual requests immediately; super.close() clears the timer
    // and drains the shared pending cycle while the database is still open.
    const stopping = this.retention.stop();
    const draining = super.close();
    await Promise.all([stopping, draining]);
  }
}
