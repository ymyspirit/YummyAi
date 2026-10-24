import { listAdvertisingHistory as sharedListAdvertisingHistory,readAdvertisingHistory as sharedReadAdvertisingHistory } from "@yummyai/advertising-core";
import type { TenantContext } from "@yummyai/contracts";
import {
type AdHistoryPage,type AdHistoryQuery,
type AdHistoryRecordQuery,type AdHistoryRecordResult
} from "@yummyai/contracts/advertising/history";
import {
type TenantTransaction
} from "@yummyai/database";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
export async function listAdvertisingHistory(
  tx: TenantTransaction, current: TenantContext, raw: AdHistoryQuery,
): Promise<AdHistoryPage> {return originalOwnerOperation(()=>sharedListAdvertisingHistory(tx,current,raw));}
export async function readAdvertisingHistory(
  tx: TenantTransaction, current: TenantContext, rawId: string, raw: AdHistoryRecordQuery,
): Promise<AdHistoryRecordResult> {return originalOwnerOperation(()=>sharedReadAdvertisingHistory(tx,current,rawId,raw));}
