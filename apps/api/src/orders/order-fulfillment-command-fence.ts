import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { authorize, intersectPermissionContexts, Permission, requireTenantOrderPermissions } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { FULFILLMENT_COMMAND_VERSION, fulfillmentCommandCanonicalJson, type PrepareFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";
import { loadCurrentMembershipContext, orderFulfillmentCommandIntents, orderProtectedDetails, orders, orderWorkItems, type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

type WithoutRequest<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type FulfillmentOwnerCommand = WithoutRequest<PrepareFulfillmentCommand>;
/** `agent` is an internal admission flag, never an HTTP input field. */
export type OrderFulfillmentCommandFence = { intentId: string; leaseToken: string; agent?: true };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export function fulfillmentCommandBinding(command: FulfillmentOwnerCommand) {
  const normalized = command.kind === "delivery_create"
    ? { ...command, input: { ...command.input, items: [...command.input.items].sort((a, b) => a.productionOrderId.localeCompare(b.productionOrderId)) } }
    : command.kind === "whole_production_milestone" || command.kind === "whole_quality_inspection" || command.kind === "whole_shipment_create"
      ? { ...command, input: { ...command.input, items: [...command.input.items].sort((a, b) => a.lineId.localeCompare(b.lineId)) } }
      : command;
  // The coordinator may pass its complete Prepare DTO. Request identity is a
  // separate checksum and must never enter the original-owner binding digest.
  const fields = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== "requestId"));
  return { kind: command.kind, targetId: command.targetId,
    requestKey: command.kind === "production_milestone" ? command.input.externalEventId : command.input.idempotencyKey,
    ownerChecksum: sha(canonicalJson(fields)) };
}

export function fulfillmentCommandPermissions(command: FulfillmentOwnerCommand, write = true): Permission[] {
  const required: Permission[] = [Permission.OrderRead, Permission.OrderPiiRead, ...(write ? [Permission.OrderWrite] : [])];
  if (command.kind === "delivery_create" || command.kind === "delivery_feedback")
    required.push(Permission.OrderPiiRead, Permission.DesignRead, Permission.AssetRead);
  else if (command.kind === "whole_production_milestone" || command.kind === "whole_quality_inspection" || command.kind === "whole_shipment_create" ||
    command.kind === "shipment_dispatch" || command.kind === "shipment_platform_confirmation") required.push(Permission.OrderPiiRead);
  if (command.kind === "production_recovery" && command.input.reviewedArtwork)
    required.push(Permission.OrderPiiRead, Permission.DesignRead);
  return [...new Set(required)];
}

export class OrderFulfillmentCommandFenceError extends ConflictException {
  constructor() { super({ code: "fulfillment_command_superseded", message: "本次执行已失效 请读取原履约提交记录" }); }
}

/** Business locks precede this shared claim lock. A cancelled/replaced claim
 * cannot overtake an admitted writer; no successful business fact is stored here. */
export async function assertOrderFulfillmentCommandFence(tx: TenantTransaction, context: TenantContext,
  command: FulfillmentOwnerCommand, fence?: OrderFulfillmentCommandFence): Promise<void> {
  const binding = fulfillmentCommandBinding(command);
  const match = and(
    eq(orderFulfillmentCommandIntents.kind, binding.kind), eq(orderFulfillmentCommandIntents.targetId, binding.targetId),
    eq(orderFulfillmentCommandIntents.requestKey, binding.requestKey));
  const rows = await tx.select().from(orderFulfillmentCommandIntents).where(match);
  if (!rows.length && !fence) return;
  const metadata = rows.find(candidate => candidate.id === fence?.intentId);
  if (!metadata || !fence) throw new OrderFulfillmentCommandFenceError();
  // Privacy writers take their source row first and then redact the intent in
  // its trigger. Take the same order; holding the intent first would deadlock.
  // These identity fields cannot change between the unlocked and locked reads.
  await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, metadata.orderId)).for("share");
  await tx.select({ id: orderProtectedDetails.orderId }).from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, metadata.orderId)).for("share");
  await tx.select({ id: orderWorkItems.id }).from(orderWorkItems).where(inArray(orderWorkItems.id, metadata.lineIds)).orderBy(asc(orderWorkItems.id)).for("share");
  const locked = await tx.select().from(orderFulfillmentCommandIntents).where(match).for("share");
  const row = locked.find(candidate => candidate.id === fence.intentId);
  if (!row || !fence || row.tenantId !== context.tenantId || row.createdBy !== context.userId ||
    row.contractVersion !== (fence.agent ? AGENT_FULFILLMENT_COMMAND_VERSION : FULFILLMENT_COMMAND_VERSION) || row.ownerChecksum !== binding.ownerChecksum ||
    row.requestChecksum !== sha(fulfillmentCommandCanonicalJson({ ...command, requestId: row.requestId })) ||
    row.authoritySnapshot.tenantId !== context.tenantId || row.authoritySnapshot.userId !== context.userId ||
    row.status !== "executing" || row.leaseToken !== fence.leaseToken || !row.encryptedInput || row.acknowledgedAt || row.redactedAt)
    throw new OrderFulfillmentCommandFenceError();
  const ceiling = intersectPermissionContexts(row.authoritySnapshot, context);
  const current = await loadCurrentMembershipContext(tx, ceiling, { lock: true });
  const effective = intersectPermissionContexts(ceiling, current);
  requireTenantOrderPermissions(effective, fulfillmentCommandPermissions(command));
  if (fence.agent) {
    authorize(effective, Permission.WorkflowRead, { ownerId: context.userId });
    authorize(effective, Permission.WorkflowRun, { ownerId: context.userId });
  }
  const [clock] = await tx.execute<{ now: Date; available: boolean }>(sql`select clock_timestamp() as now,
    order_fulfillment_command_source_available(c) as available from order_fulfillment_command_intents c where c.id=${row.id}::uuid`);
  if (!clock?.available || row.expiresAt <= new Date(clock.now) || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date(clock.now))
    throw new OrderFulfillmentCommandFenceError();
}
