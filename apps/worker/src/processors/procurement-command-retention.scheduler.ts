import { ProcurementCommandRetentionDispatcher, type DatabaseConnection } from "@yummyai/database";
import { InputRetentionScheduler, reportInputRetention, type InputRetentionEvent } from "./input-retention-scheduler.js";

export type ProcurementRetentionEvent = InputRetentionEvent<"procurementCommandRetentionScheduler">;
export class ProcurementCommandRetentionScheduler extends InputRetentionScheduler<"procurementCommandRetentionScheduler"> {
  constructor(database: DatabaseConnection, intervalMs = 60_000,
    dispatcher: Pick<ProcurementCommandRetentionDispatcher, "dispatch"> = new ProcurementCommandRetentionDispatcher(database),
    report: (event: ProcurementRetentionEvent) => void = reportInputRetention) {
    super("procurementCommandRetentionScheduler", intervalMs, dispatcher, report);
  }
}
