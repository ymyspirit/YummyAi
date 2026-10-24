import { createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { createEntityId, type RecordProcurementInvoiceInput, type TenantContext } from "@yummyai/contracts";
import { canonicalProcurementInvoiceRequest } from "@yummyai/contracts/procurement/procurement-cycle";
import { authorize, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { inventorySupplierInvoiceRequests, procurementCommands, loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";

/** A receipt allocation is a fact; its original request is a separate immutable witness. */
export function invoiceRequestChecksum(purchaseOrderId: string, input: RecordProcurementInvoiceInput) {
  return createHash("sha256").update(canonicalProcurementInvoiceRequest(purchaseOrderId, input)).digest("hex");
}

/** Raw and retained submissions share a key lock before any actual invoice lock. */
export async function beginInvoiceWrite(tx: TenantTransaction, base: TenantContext, purchaseOrderId: string, input: RecordProcurementInvoiceInput) {
  const current = intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: true }));
  authorize(current, Permission.ProcurementWrite);
  authorize(current, Permission.ProcurementRead);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-original:${current.tenantId}:invoice_record:${input.idempotencyKey}`},0))`);
  const [command] = await tx.select().from(procurementCommands).where(and(eq(procurementCommands.operation, "invoice_record"),
    eq(procurementCommands.requestKey, input.idempotencyKey))).for("update");
  if (command) {
    const [session] = await tx.execute<{ commandId: string | null }>(sql`select current_setting('app.procurement_command_id',true) as "commandId"`);
    if (session?.commandId !== command.id || command.status !== "prepared")
      throw new ConflictException({ code: "procurement_original_pending", message: "这笔发票已有原提交 请从原采购命令核对结果 不可另行提交" });
    if (command.kind !== "invoice_record" || command.createdBy !== current.userId || command.targetId !== purchaseOrderId.toLowerCase()
      || command.requestChecksum !== invoiceRequestChecksum(purchaseOrderId, input)) invoiceMismatch();
  }
  const [proof] = await tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.idempotencyKey, input.idempotencyKey)).limit(1);
  if (proof) assertOriginal(proof, current, purchaseOrderId, input);
  return current;
}

export async function assertInvoiceReplay(tx: TenantTransaction, context: TenantContext, invoiceId: string,
  purchaseOrderId: string, input: RecordProcurementInvoiceInput) {
  const [proof] = await tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.invoiceId, invoiceId)).limit(1);
  if (!proof) throw new ConflictException({ code: "procurement_invoice_input_unavailable", message: "旧发票缺少原提交依据 请先核对原发票 不可自动重放" });
  assertOriginal(proof, context, purchaseOrderId, input);
}

function assertOriginal(proof: typeof inventorySupplierInvoiceRequests.$inferSelect, context: TenantContext,
  purchaseOrderId: string, input: RecordProcurementInvoiceInput) {
  if (proof.evidenceVersion !== 1 || proof.purchaseOrderId !== purchaseOrderId.toLowerCase() || proof.createdBy !== context.userId
    || proof.idempotencyKey !== input.idempotencyKey || proof.requestChecksum !== invoiceRequestChecksum(purchaseOrderId, input)) invoiceMismatch();
}

function invoiceMismatch(): never {
  throw new ConflictException({ code: "procurement_invoice_input_mismatch", message: "发票与原采购单 填写或操作者不一致 请核对原提交" });
}

export async function bindInvoiceRequest(tx: TenantTransaction, context: TenantContext, invoiceId: string,
  purchaseOrderId: string, purchaseOrderVersionId: string, input: RecordProcurementInvoiceInput) {
  await tx.insert(inventorySupplierInvoiceRequests).values({ id: createEntityId(), tenantId: context.tenantId, invoiceId,
    purchaseOrderId, purchaseOrderVersionId, createdBy: context.userId, evidenceVersion: 1,
    requestChecksum: invoiceRequestChecksum(purchaseOrderId, input), idempotencyKey: input.idempotencyKey });
}
