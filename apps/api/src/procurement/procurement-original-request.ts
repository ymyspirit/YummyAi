import { ConflictException } from "@nestjs/common";
import { authorize, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { canonicalProcurementWriteRequest, createEntityId, type ProcurementWriteKind, type TenantContext } from "@yummyai/contracts";
import { inventoryProcurementWriteRequests, procurementCommands, loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { invoiceRequestChecksum } from "./procurement-invoice-request.js";
import { canonicalInvoiceReconciliationRequest } from "@yummyai/contracts/procurement/invoice-reconciliation";

type OriginalInput = { idempotencyKey: string } | { input: { idempotencyKey: string }; linkId: string };
type Witness = Pick<typeof inventoryProcurementWriteRequests.$inferInsert,
  "requisitionId" | "rfqId" | "quoteId" | "purchaseOrderId" | "purchaseOrderVersionId" | "purchaseOrderEventId">;

export async function beginProcurementWrite(tx: TenantTransaction, base: TenantContext, permission: Permission,
  operation: ProcurementWriteKind, input: OriginalInput, targetId: string | null = null) {
  const current = intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: true }));
  authorize(current, permission);
  authorize(current, Permission.ProcurementRead);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-original:${base.tenantId}:${operation}:${requestKey(input)}`},0))`);
  const [prepared] = await tx.select({ id: procurementCommands.id }).from(procurementCommands).where(and(
    eq(procurementCommands.operation, operation), eq(procurementCommands.requestKey, requestKey(input)),
  )).limit(1);
  if (prepared) {
    const [session] = await tx.execute<{ commandId: string | null }>(sql`select current_setting('app.procurement_command_id',true) as "commandId"`);
    if (session?.commandId !== prepared.id) throw new ConflictException({ code: "procurement_original_pending", message: "这笔采购已有原提交 请从原命令核对并执行" });
  }
  const original = await originalRequest(tx, operation, requestKey(input));
  if (original) {
    authorize(current, permission, { ownerId: original.createdBy });
    authorize(current, Permission.ProcurementRead, { ownerId: original.createdBy });
    assertOriginal(original, current, operation, targetId, input, {});
  }
  return current;
}

function requestKey(input: OriginalInput) { return "input" in input ? input.input.idempotencyKey : input.idempotencyKey; }

function requestChecksum(operation: ProcurementWriteKind, targetId: string | null, input: OriginalInput) {
  return createHash("sha256").update(canonicalProcurementWriteRequest(operation, targetId, input)).digest("hex");
}

/** The durable transport uses the identical v1 binding as the actual owner. */
export function procurementCommandBinding(original: PrepareProcurementCommand) {
  if (original.kind === "invoice_reconcile") return { operation: "invoice_reconcile" as const, targetId: original.targetId,
    input: original.input, idempotencyKey: original.input.idempotencyKey,
    requestChecksum: createHash("sha256").update(canonicalInvoiceReconciliationRequest(original.targetId, original.input)).digest("hex") };
  if (original.kind === "invoice_record") return { operation: "invoice_record" as const, targetId: original.targetId,
    input: original.input, idempotencyKey: original.input.idempotencyKey, requestChecksum: invoiceRequestChecksum(original.targetId, original.input) };
  const operation: ProcurementWriteKind = original.kind === "supply_purchase_create" ? "purchase_create" : original.kind;
  const input: OriginalInput = original.kind === "supply_purchase_create" ? { linkId: original.targetId, input: original.input } : original.input;
  return { operation, targetId: original.targetId, input, idempotencyKey: requestKey(input), requestChecksum: requestChecksum(operation, original.targetId, input) };
}

export async function assertProcurementReplay(tx: TenantTransaction, context: TenantContext, operation: ProcurementWriteKind,
  targetId: string | null, input: OriginalInput, witness: Witness) {
  const original = await originalRequest(tx, operation, requestKey(input));
  if (!original) throw new ConflictException({ code: "procurement_input_unavailable", message: "旧采购操作缺少原提交依据 请先核对历史记录 不可自动重放" });
  assertOriginal(original, context, operation, targetId, input, witness);
}

async function originalRequest(tx: TenantTransaction, operation: ProcurementWriteKind, key: string) {
  const [original] = await tx.select().from(inventoryProcurementWriteRequests).where(and(
    eq(inventoryProcurementWriteRequests.operation, operation), eq(inventoryProcurementWriteRequests.idempotencyKey, key),
  )).limit(1);
  return original;
}

function assertOriginal(original: typeof inventoryProcurementWriteRequests.$inferSelect, context: TenantContext,
  operation: ProcurementWriteKind, targetId: string | null, input: OriginalInput, witness: Witness) {
  if (original.evidenceVersion !== 1 || original.createdBy !== context.userId || original.targetId !== (targetId?.toLowerCase() ?? null)
    || original.requestChecksum !== requestChecksum(operation, targetId, input)
    || Object.entries(witness).some(([name, id]) => original[name as keyof Witness] !== id))
    throw new ConflictException({ code: "procurement_request_mismatch", message: "采购操作与原对象 填写或操作者不一致 请核对原提交" });
}

export async function bindProcurementWrite(tx: TenantTransaction, context: TenantContext, operation: ProcurementWriteKind,
  targetId: string | null, input: OriginalInput, witness: Witness) {
  await tx.insert(inventoryProcurementWriteRequests).values({ id: createEntityId(), tenantId: context.tenantId,
    operation, targetId: targetId?.toLowerCase() ?? null, createdBy: context.userId, evidenceVersion: 1,
    idempotencyKey: requestKey(input), requestChecksum: requestChecksum(operation, targetId, input), ...witness });
}
