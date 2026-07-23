import { createHash } from "node:crypto";

import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  channelMutationReconciliationEvents,
  channelMutationReconciliations,
  type TenantTransaction,
} from "@yummyai/database";
import { eq } from "drizzle-orm";

export interface ChannelMutationReconciliationInput {
  accountId: string;
  listingId: string;
  syncRequestId: string;
  platform: "amazon" | "etsy";
  externalListingId: string;
  reasonCode: string;
  message: string;
}

export interface ChannelMutationReconciliationWriter {
  ensure(
    tx: TenantTransaction,
    context: TenantContext,
    input: ChannelMutationReconciliationInput,
  ): Promise<void>;
}

export class DrizzleChannelMutationReconciliationWriter
implements ChannelMutationReconciliationWriter {
  async ensure(
    tx: TenantTransaction,
    context: TenantContext,
    input: ChannelMutationReconciliationInput,
  ): Promise<void> {
    const idempotencyKey = checksum({
      version: 1,
      syncRequestId: input.syncRequestId,
      reasonCode: input.reasonCode,
    });
    const [existing] = await tx.select().from(channelMutationReconciliations)
      .where(eq(channelMutationReconciliations.idempotencyKey, idempotencyKey)).limit(1);
    if (existing) return;

    const reconciliationId = createEntityId();
    await tx.insert(channelMutationReconciliations).values({
      id: reconciliationId,
      tenantId: context.tenantId,
      accountId: input.accountId,
      listingId: input.listingId,
      syncRequestId: input.syncRequestId,
      mutationKey: `${input.platform}:${input.externalListingId}:price_inventory`,
      idempotencyKey,
      createdBy: context.userId,
    });
    await tx.insert(channelMutationReconciliationEvents).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      reconciliationId,
      sequence: 1,
      status: "open",
      reasonCode: input.reasonCode,
      message: input.message,
      idempotencyKey,
      actorUserId: context.userId,
    });
  }
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
