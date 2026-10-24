import { MaterialCommandRetentionDispatcher } from "@yummyai/order-core";
import type { DatabaseConnection } from "@yummyai/database";
import { InputRetentionScheduler, reportInputRetention, type InputRetentionEvent } from "./input-retention-scheduler.js";

export type MaterialRetentionEvent = InputRetentionEvent<"materialCommandRetentionScheduler">;
export class MaterialCommandRetentionScheduler extends InputRetentionScheduler<"materialCommandRetentionScheduler"> {
  constructor(database: DatabaseConnection, intervalMs = 60_000,
    dispatcher: Pick<MaterialCommandRetentionDispatcher, "dispatch"> = new MaterialCommandRetentionDispatcher(database),
    report: (event: MaterialRetentionEvent) => void = reportInputRetention) {
    super("materialCommandRetentionScheduler", intervalMs, dispatcher, report);
  }
}
