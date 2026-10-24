import { FinanceCommandRetentionDispatcher, type DatabaseConnection } from "@yummyai/database";
import { InputRetentionScheduler, reportInputRetention, type InputRetentionEvent } from "./input-retention-scheduler.js";

export type FinanceRetentionEvent = InputRetentionEvent<"financeCommandRetentionScheduler">;
export class FinanceCommandRetentionScheduler extends InputRetentionScheduler<"financeCommandRetentionScheduler"> {
  constructor(database: DatabaseConnection, intervalMs = 60_000,
    dispatcher: Pick<FinanceCommandRetentionDispatcher, "dispatch"> = new FinanceCommandRetentionDispatcher(database),
    report: (event: FinanceRetentionEvent) => void = reportInputRetention) {
    super("financeCommandRetentionScheduler", intervalMs, dispatcher, report);
  }
}
