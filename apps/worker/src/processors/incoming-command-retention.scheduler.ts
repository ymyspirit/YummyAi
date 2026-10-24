import { IncomingCommandRetentionDispatcher, type DatabaseConnection } from "@yummyai/database";
import { InputRetentionScheduler, reportInputRetention, type InputRetentionEvent } from "./input-retention-scheduler.js";

export type IncomingRetentionEvent = InputRetentionEvent<"incomingCommandRetentionScheduler">;
export class IncomingCommandRetentionScheduler extends InputRetentionScheduler<"incomingCommandRetentionScheduler"> {
  constructor(database: DatabaseConnection, intervalMs = 60_000,
    dispatcher: Pick<IncomingCommandRetentionDispatcher, "dispatch"> = new IncomingCommandRetentionDispatcher(database),
    report: (event: IncomingRetentionEvent) => void = reportInputRetention) {
    super("incomingCommandRetentionScheduler", intervalMs, dispatcher, report);
  }
}
