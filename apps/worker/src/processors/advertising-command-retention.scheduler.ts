import {AdvertisingCommandRetentionDispatcher,type DatabaseConnection} from "@yummyai/database";
import {InputRetentionScheduler,reportInputRetention,type InputRetentionEvent} from "./input-retention-scheduler.js";
export type AdvertisingRetentionEvent=InputRetentionEvent<"advertisingCommandRetentionScheduler">;
export class AdvertisingCommandRetentionScheduler extends InputRetentionScheduler<"advertisingCommandRetentionScheduler">{
  constructor(database:DatabaseConnection,intervalMs=60_000,
    dispatcher:Pick<AdvertisingCommandRetentionDispatcher,"dispatch">=new AdvertisingCommandRetentionDispatcher(database),
    report:(event:AdvertisingRetentionEvent)=>void=reportInputRetention){
    super("advertisingCommandRetentionScheduler",intervalMs,dispatcher,report);
  }
}
