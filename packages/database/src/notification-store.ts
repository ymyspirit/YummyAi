import {
  CreateNotificationSchema,
  type CreateNotificationInput,
} from "@yummyai/contracts/operations/notification";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { and, eq } from "drizzle-orm";
import type { TenantTransaction } from "./tenant-transaction.js";
import { notifications } from "./schema/operations.js";
import { memberships } from "./schema/identity.js";

/** Shared persistence owner, like recordAuditInTransaction. Callers authorize the
 * current recipient and resource before invoking it inside the same tenant tx. */
export async function recordNotificationInTransaction(
  tx: TenantTransaction,
  recipient: TenantContext,
  raw: CreateNotificationInput,
) {
  const input = CreateNotificationSchema.parse(raw);
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, recipient.userId), eq(memberships.status, "active")))
    .limit(1);
  if (!member) throw new Error("Notification recipient is not an active tenant member");
  const [created] = await tx
    .insert(notifications)
    .values({
      id: createEntityId(),
      tenantId: recipient.tenantId,
      userId: recipient.userId,
      ...input,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  if (!input.deduplicationKey) throw new Error("Notification identity collision");
  const [existing] = await tx
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, recipient.userId),
        eq(notifications.deduplicationKey, input.deduplicationKey),
      ),
    )
    .limit(1);
  if (
    !existing ||
    existing.kind !== input.kind ||
    existing.resourceId !== (input.resourceId ?? null) ||
    existing.resourceType !== (input.resourceType ?? null)
  )
    throw new Error("Notification deduplication identity conflict");
  return existing;
}
