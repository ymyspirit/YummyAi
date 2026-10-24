import { factoryTaskReceipts as receipts, type TenantTransaction } from "@yummyai/database";
import { inArray } from "drizzle-orm";
export async function factoryReceiptIds(tx: TenantTransaction, feedbackIds: string[]) {
  if (!feedbackIds.length) return new Set<string>();
  return new Set(
    (
      await tx
        .select({ id: receipts.feedbackId })
        .from(receipts)
        .where(inArray(receipts.feedbackId, feedbackIds))
    ).map((row) => row.id),
  );
}
