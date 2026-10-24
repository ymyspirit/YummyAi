import { and, desc, eq, inArray } from "drizzle-orm";
import {
  ModelBillingAcknowledgmentSchema,
  type ModelBillingAcknowledgment,
} from "@yummyai/contracts/harness";
import { modelBillingReconciliations as receipts } from "./schema/model-billing.js";
import type { TenantTransaction } from "./tenant-transaction.js";

/** Only safe cost metadata. Invoice references remain behind the billing owner's permission. */
export async function readModelBillingAcknowledgments(
  tx: TenantTransaction,
  owner: "assist" | "pod",
  ids: string[],
): Promise<Map<string, ModelBillingAcknowledgment>> {
  if (ids.length > 20) throw new Error("MODEL_BILLING_SCOPE_TOO_LARGE");
  if (!ids.length) return new Map();
  const rows = await tx
    .selectDistinctOn([receipts.subjectId], {
      subjectId: receipts.subjectId,
      id: receipts.id,
      sequence: receipts.sequence,
      amountUsd: receipts.amountUsd,
      proofChecksum: receipts.proofChecksum,
      checkedAt: receipts.checkedAt,
      checkedBy: receipts.checkedBy,
    })
    .from(receipts)
    .where(and(eq(receipts.owner, owner), inArray(receipts.subjectId, ids)))
    .orderBy(receipts.subjectId, desc(receipts.sequence));
  const result = new Map<string, ModelBillingAcknowledgment>();
  for (const row of rows) {
    const { subjectId, ...metadata } = row;
    result.set(
      subjectId,
      ModelBillingAcknowledgmentSchema.parse({
        ...metadata,
        verification: "operator_attested",
        checkedAt: row.checkedAt.toISOString(),
      }),
    );
  }
  return result;
}
