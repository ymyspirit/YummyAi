import type { AdvertisingOperation } from "@yummyai/advertising-core";
import { requireAdvertisingAccount as sharedRequireAdvertisingAccount } from "@yummyai/advertising-core";
import type { TenantContext } from "@yummyai/contracts";
import type { TenantTransaction } from "@yummyai/database";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
export { advertisingAccess,advertisingContextAuthority,currentAdvertisingAuthority,requireAnyAdvertisingPermission,type AdvertisingOperation } from "@yummyai/advertising-core";
export async function requireAdvertisingAccount(tx: TenantTransaction, context: TenantContext,
  id: string, operation: AdvertisingOperation | null, includeDeleted = false) {return originalOwnerOperation(()=>sharedRequireAdvertisingAccount(tx,context,id,operation,includeDeleted));}
