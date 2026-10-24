import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { addStockQuantity, compareStockQuantity, subtractStockQuantity, sumStockQuantities, type StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { procurementAmountMinor, ProcurementUnitSchema, safeMinorValue, subtractProcurementMinor, sumProcurementMinor } from "@yummyai/contracts/procurement/measurement";
import {
  canonicalInvoiceReconciliationRequest, InvoiceReconciliationBalanceSchema, InvoiceReconciliationDetailSchema,
  InvoiceReconciliationEventSchema, InvoiceReconciliationInputSchema, InvoiceReconciliationListSchema, InvoiceReconciliationQuerySchema,
  type InvoiceReconciliationBalance, type InvoiceReconciliationDetail, type InvoiceReconciliationEvent,
  type InvoiceReconciliationInput, type InvoiceReconciliationList, type SupplierAdjustmentView,
} from "@yummyai/contracts/procurement/invoice-reconciliation";
import {
  fulfillmentSuppliers, inventoryLocations, inventoryProcurementReceiptLines, inventoryProcurementReceipts,
  inventoryPurchaseOrders, inventoryPurchaseOrderVersions, inventoryStockItems, inventorySupplierInvoiceAllocations,
  inventorySupplierInvoiceLines, inventorySupplierInvoiceRequests, inventorySupplierInvoices, invoiceAllocationEffects,
  invoiceReconciliations, loadCurrentMembershipContext, procurementCommands, withTenant,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

type InvoiceRow = typeof inventorySupplierInvoices.$inferSelect;
type LineRow = typeof inventorySupplierInvoiceLines.$inferSelect;
type ProofRow = typeof inventorySupplierInvoiceRequests.$inferSelect;
type VersionRow = typeof inventoryPurchaseOrderVersions.$inferSelect;
type ReceiptLineRow = typeof inventoryProcurementReceiptLines.$inferSelect;
type AllocationRow = typeof inventorySupplierInvoiceAllocations.$inferSelect;
type EffectRow = typeof invoiceAllocationEffects.$inferSelect;
type EventRow = typeof invoiceReconciliations.$inferSelect;
type EffectPlan = Pick<EffectRow, "invoiceLineId" | "receiptLineId" | "kind" | "quantity" | "unit" | "sourceAllocationId" | "sourceEffectId">;
type ActionFact = Pick<EventRow, "id" | "invoiceId" | "input">;
type Occupation = { byReceipt: Map<string, StockQuantity>; byLine: Map<string, StockQuantity> };
type Graph = {
  invoice: InvoiceRow; order: typeof inventoryPurchaseOrders.$inferSelect;
  proof: ProofRow | null; version: VersionRow | null; lines: LineRow[];
  invoices: InvoiceRow[]; proofs: ProofRow[]; allLines: LineRow[];
  receipts: (typeof inventoryProcurementReceipts.$inferSelect)[]; receiptLines: ReceiptLineRow[];
  allocations: AllocationRow[]; effects: EffectRow[]; events: EventRow[];
  legacyUnknown: boolean; fingerprint: string;
};

/** A supplier document is an entered reference, not external verification. Only
 * its separately approved event changes financial claims or receipt occupation. */
@Injectable()
export class InvoiceReconciliationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(context: TenantContext, raw: unknown): Promise<InvoiceReconciliationList> {
    const query = parse(InvoiceReconciliationQuerySchema, raw);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentContext(tx, context);
      authorize(current, Permission.ProcurementRead);
      // Pending selection belongs in the raw page query. A page of unrelated
      // invoices must not hide a colleague's real pending supplier document.
      const pending = query.pendingOnly === "true" ? sql`exists (
        select 1 from ${invoiceReconciliations} pending
        where pending.tenant_id=${inventorySupplierInvoices.tenantId}
          and pending.invoice_id=${inventorySupplierInvoices.id} and pending.action='adjustment_record'
          and not exists (select 1 from ${invoiceReconciliations} reviewed
            where reviewed.tenant_id=pending.tenant_id and reviewed.adjustment_id=pending.id)
      )` : undefined;
      const rows = await tx.select({ id: inventorySupplierInvoices.id }).from(inventorySupplierInvoices).where(and(
        query.before ? lt(inventorySupplierInvoices.id, query.before) : undefined,
        query.purchaseOrderId ? eq(inventorySupplierInvoices.purchaseOrderId, query.purchaseOrderId) : undefined, pending,
      )).orderBy(desc(inventorySupplierInvoices.id)).limit(51);
      const page = rows.slice(0, 50);
      const items: InvoiceReconciliationList["items"] = [];
      let unavailableCount = 0;
      for (const row of page) {
        try {
          const detail = detailOf(await readGraph(tx, current, row.id), current);
          items.push({ invoiceId: detail.invoiceId, invoiceNumber: detail.invoiceNumber, purchaseOrderId: detail.purchaseOrderId,
            purchaseOrderCode: detail.purchaseOrderCode, originalStatus: detail.originalStatus, status: detail.balance.status,
            currency: detail.balance.currency, netAmountMinor: detail.balance.netAmountMinor, varianceMinor: detail.balance.varianceMinor,
            pendingCount: detail.adjustments.filter(document => document.status === "pending").length });
        } catch (error) {
          if (!(error instanceof ForbiddenError || error instanceof NotFoundException)) throw error;
          unavailableCount++;
        }
      }
      return InvoiceReconciliationListSchema.parse({ items, unavailableCount, nextCursor: rows.length > 50 ? page.at(-1)!.id : null });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async detail(context: TenantContext, invoiceId: string): Promise<InvoiceReconciliationDetail> {
    return withTenant(this.database.db, context, async tx => {
      const current = await currentContext(tx, context);
      return detailOf(await readGraph(tx, current, invoiceId), current);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  /** Prepare is read only: no business lock, sequence, paper, or allocation is reserved. */
  async validateInTransaction(tx: TenantTransaction, context: TenantContext, invoiceId: string, raw: InvoiceReconciliationInput): Promise<void> {
    const input = parse(InvoiceReconciliationInputSchema, raw);
    const current = await currentContext(tx, context);
    const graph = await readGraph(tx, current, invoiceId);
    requireAction(current, graph, input);
    const [actual] = await tx.select({ id: invoiceReconciliations.id }).from(invoiceReconciliations)
      .where(eq(invoiceReconciliations.requestKey, input.idempotencyKey)).limit(1);
    if (actual) conflict("procurement_actual_already_recorded", "这笔核对已有真实凭据 不可追认为新的待执行命令");
    await validatePlan(tx, graph, input);
  }

  /** The event, effects, audit and caller's command outcome share one top-level tenant transaction. */
  async executeInTransaction(tx: TenantTransaction, context: TenantContext, invoiceId: string, raw: InvoiceReconciliationInput): Promise<string> {
    const input = parse(InvoiceReconciliationInputSchema, raw);
    const latest = await currentContext(tx, context, true);
    authorize(latest, actionPermission(input));
    authorize(latest, Permission.ProcurementRead);
    await lock(tx, `procurement-original:${latest.tenantId}:invoice_reconcile:${input.idempotencyKey}`);
    const current = await requireCommandBinding(tx, latest, invoiceId, input);
    authorize(current, actionPermission(input));
    authorize(current, Permission.ProcurementRead);
    const [existing] = await tx.select().from(invoiceReconciliations).where(eq(invoiceReconciliations.requestKey, input.idempotencyKey)).limit(1);
    if (existing) {
      const graph = await readGraph(tx, current, invoiceId);
      requireAction(current, graph, input);
      if (existing.createdBy !== current.userId || existing.invoiceId !== invoiceId.toLowerCase()
        || existing.requestChecksum !== reconciliationChecksum(invoiceId, input))
        conflict("procurement_request_mismatch", "核对与原发票 填写或操作者不一致 请核对原提交");
      return existing.id;
    }
    const [invoice] = await tx.select({ purchaseOrderId: inventorySupplierInvoices.purchaseOrderId }).from(inventorySupplierInvoices)
      .where(eq(inventorySupplierInvoices.id, invoiceId)).limit(1);
    if (!invoice) throw new NotFoundException("Supplier invoice not found");
    await lock(tx, `procurement-order:${current.tenantId}:${invoice.purchaseOrderId}`);
    if (input.action === "adjustment_record") {
      const [order] = await tx.select({ supplierId: inventoryPurchaseOrders.supplierId }).from(inventoryPurchaseOrders)
        .where(eq(inventoryPurchaseOrders.id, invoice.purchaseOrderId)).limit(1);
      if (!order) throw new NotFoundException("Purchase order not found");
      await lock(tx, `procurement-invoice-document:${current.tenantId}:${order.supplierId}:${documentKey(input)}`);
    }
    const graph = await readGraph(tx, current, invoiceId);
    requireAction(current, graph, input);
    for (const receipt of graph.receiptLines) await lock(tx, `procurement-invoice-receipt:${current.tenantId}:${receipt.id}`);
    // All writers share the PO lock; re-reading also protects against a newly
    // committed receipt between the initial read and acquiring its lock.
    const fixed = await readGraph(tx, current, invoiceId);
    requireAction(current, fixed, input);
    const effects = await validatePlan(tx, fixed, input);
    const id = createEntityId();
    const preceding = fixed.events.filter(event => event.invoiceId === fixed.invoice.id).sort((a, b) => a.sequence - b.sequence).at(-1);
    const balance = calculateBalance(fixed, [...fixed.events, { id, invoiceId: fixed.invoice.id, input }], [...fixed.effects, ...effects]);
    await tx.insert(invoiceReconciliations).values({ id, tenantId: current.tenantId, invoiceId: fixed.invoice.id,
      originalProofId: fixed.proof!.id, purchaseOrderId: fixed.order.id, purchaseOrderVersionId: fixed.version!.id,
      supplierId: fixed.order.supplierId, sequence: (preceding?.sequence ?? 0) + 1, previousId: preceding?.id ?? null,
      adjustmentId: input.action === "adjustment_review" ? input.adjustmentId : null, action: input.action, input, balance,
      documentKey: input.action === "adjustment_record" ? documentKey(input) : null,
      requestKey: input.idempotencyKey, requestChecksum: reconciliationChecksum(invoiceId, input), createdBy: current.userId,
      creationTransactionId: sql`pg_current_xact_id()::text` });
    if (effects.length) await tx.insert(invoiceAllocationEffects).values(effects.map(effect => ({ ...effect, id: createEntityId(),
      tenantId: current.tenantId, eventId: id, createdBy: current.userId })));
    await this.audit.recordInTransaction(tx, current, { action: "procurement.invoice.reconcile", resourceType: "inventory_invoice_reconciliation",
      resourceId: id, result: "success", metadata: { invoiceId: fixed.invoice.id, purchaseOrderId: fixed.order.id,
        action: input.action, adjustmentId: input.action === "adjustment_review" ? input.adjustmentId : null,
        status: balance.status, effectCount: effects.length, source: "operator_entered_supplier_reference" } });
    return id;
  }

  async readEventInTransaction(tx: TenantTransaction, context: TenantContext, eventId: string): Promise<InvoiceReconciliationEvent> {
    const current = await currentContext(tx, context);
    const [event] = await tx.select().from(invoiceReconciliations).where(eq(invoiceReconciliations.id, eventId)).limit(1);
    if (!event) throw new NotFoundException("Invoice reconciliation evidence not found");
    const graph = await readGraph(tx, current, event.invoiceId);
    if (event.originalProofId !== graph.proof?.id || event.purchaseOrderVersionId !== graph.version?.id || event.purchaseOrderId !== graph.order.id)
      basisUnavailable();
    // Result recovery reads the immutable submission-time balance. Subsequent
    // documents and receipt matches only affect the separate current detail.
    return eventView(event);
  }

  async readTargetInTransaction(tx: TenantTransaction, context: TenantContext, invoiceId: string): Promise<{ targetLabel: string; targetDetail: string | null }> {
    const graph = await readGraph(tx, await currentContext(tx, context), invoiceId);
    return { targetLabel: graph.invoice.invoiceNumber, targetDetail: graph.order.code };
  }
}

/** New invoices and reconciliation use the same effective financial occupation.
 * Original 149 allocations are never edited; approved releases free billing capacity only. */
export async function readEffectiveInvoiceOccupationInTransaction(tx: TenantTransaction, receipts: ReceiptLineRow[]): Promise<Map<string, StockQuantity>> {
  if (!receipts.length) return new Map();
  const ids = receipts.map(receipt => receipt.id);
  const allocations = await tx.select().from(inventorySupplierInvoiceAllocations).where(inArray(inventorySupplierInvoiceAllocations.receiptLineId, ids));
  const effects = await tx.select().from(invoiceAllocationEffects).where(inArray(invoiceAllocationEffects.receiptLineId, ids));
  try { return occupation(receipts, allocations, effects).byReceipt; }
  catch (error) {
    if (error instanceof ConflictException && (error.getResponse() as { code?: string }).code === "invoice_reconciliation_legacy_basis_missing")
      conflict("procurement_invoice_allocation_basis_unavailable", "原收货分配依据不完整或已超额 请先核对历史发票");
    throw error;
  }
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: "invoice_reconciliation_input_invalid", message: "发票核对填写不完整或格式不正确" });
  return result.data;
}

async function currentContext(tx: TenantTransaction, base: TenantContext, lockMembership = false) {
  return intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: lockMembership }));
}

function actionPermission(input: InvoiceReconciliationInput) {
  return input.action === "adjustment_record" ? Permission.ProcurementWrite : Permission.ProcurementApprove;
}

function requireAction(current: TenantContext, graph: Graph, input: InvoiceReconciliationInput) {
  authorize(current, actionPermission(input), { ownerId: graph.order.createdBy });
  if (graph.legacyUnknown) conflict("invoice_reconciliation_legacy_basis_missing", "原发票或收货分配依据缺失 请先人工核对历史 不支持自动重建旧账");
}

function permitted(current: TenantContext, permission: Permission, ownerId: string | null) {
  try { authorize(current, permission, { ownerId }); return true; }
  catch (error) { if (error instanceof ForbiddenError) return false; throw error; }
}

function reconciliationChecksum(invoiceId: string, input: InvoiceReconciliationInput) {
  return createHash("sha256").update(canonicalInvoiceReconciliationRequest(invoiceId, input)).digest("hex");
}

function documentKey(input: Extract<InvoiceReconciliationInput, { action: "adjustment_record" }>) {
  return `${input.document.kind}:${input.document.number.trim().toLowerCase()}`;
}

async function requireCommandBinding(tx: TenantTransaction, current: TenantContext, invoiceId: string, input: InvoiceReconciliationInput) {
  const [command] = await tx.select().from(procurementCommands).where(and(eq(procurementCommands.operation, "invoice_reconcile"),
    eq(procurementCommands.requestKey, input.idempotencyKey))).for("update");
  if (!command) conflict("invoice_reconciliation_command_required", "请先准备本人发票核对命令 再核准并记入实际凭据");
  const [session] = await tx.execute<{ commandId: string | null }>(sql`select current_setting('app.procurement_command_id',true) as "commandId"`);
  if (session?.commandId !== command.id || command.status !== "prepared")
    conflict("procurement_original_pending", "这笔核对已有原提交 请从原采购命令核对结果 不可另行提交");
  if (command.kind !== "invoice_reconcile" || command.targetId !== invoiceId.toLowerCase() || command.createdBy !== current.userId
    || command.requestChecksum !== reconciliationChecksum(invoiceId, input))
    conflict("procurement_request_mismatch", "核对与原发票 填写或操作者不一致 请核对原提交");
  return intersectPermissionContexts(command.authoritySnapshot, current);
}

async function readGraph(tx: TenantTransaction, current: TenantContext, invoiceId: string): Promise<Graph> {
  authorize(current, Permission.ProcurementRead);
  const [invoice] = await tx.select().from(inventorySupplierInvoices).where(eq(inventorySupplierInvoices.id, invoiceId)).limit(1);
  if (!invoice) throw new NotFoundException("Supplier invoice not found");
  authorize(current, Permission.ProcurementRead, { ownerId: invoice.createdBy });
  const [order] = await tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, invoice.purchaseOrderId)).limit(1);
  if (!order) throw new NotFoundException("Purchase order not found");
  authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
  const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, order.supplierId)).limit(1);
  if (!supplier) throw new NotFoundException("Procurement supplier not found");
  authorize(current, Permission.ProcurementRead, { ownerId: supplier.createdBy });
  const invoices = await tx.select().from(inventorySupplierInvoices).where(eq(inventorySupplierInvoices.purchaseOrderId, order.id)).orderBy(asc(inventorySupplierInvoices.id));
  const proofs = await tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.purchaseOrderId, order.id)).orderBy(asc(inventorySupplierInvoiceRequests.id));
  const proof = proofs.find(row => row.invoiceId === invoice.id) ?? null;
  if (proof) authorize(current, Permission.ProcurementRead, { ownerId: proof.createdBy });
  const [storedVersion] = proof ? await tx.select().from(inventoryPurchaseOrderVersions).where(eq(inventoryPurchaseOrderVersions.id, proof.purchaseOrderVersionId)).limit(1) : [];
  const version = storedVersion?.purchaseOrderId === order.id ? storedVersion : null;
  if (version) for (const line of version.lineSnapshot) {
    const [stock] = await tx.select({ createdBy: inventoryStockItems.createdBy }).from(inventoryStockItems).where(eq(inventoryStockItems.id, line.stockItemId)).limit(1);
    const [location] = await tx.select({ createdBy: inventoryLocations.createdBy }).from(inventoryLocations).where(eq(inventoryLocations.id, line.destinationLocationId)).limit(1);
    if (!stock || !location) throw new NotFoundException("Procurement stock or location not found");
    authorize(current, Permission.InventoryRead, { ownerId: stock.createdBy });
    authorize(current, Permission.InventoryRead, { ownerId: location.createdBy });
  }
  const allLines = await tx.select().from(inventorySupplierInvoiceLines).where(inArray(inventorySupplierInvoiceLines.invoiceId, invoices.map(row => row.id))).orderBy(asc(inventorySupplierInvoiceLines.id));
  const lines = allLines.filter(line => line.invoiceId === invoice.id);
  if (!lines.length) basisUnavailable();
  const receipts = await tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.purchaseOrderId, order.id)).orderBy(asc(inventoryProcurementReceipts.id));
  const receiptLines = receipts.length ? await tx.select().from(inventoryProcurementReceiptLines).where(inArray(inventoryProcurementReceiptLines.receiptId, receipts.map(row => row.id))).orderBy(asc(inventoryProcurementReceiptLines.id)) : [];
  const sourceFilter = or(inArray(inventorySupplierInvoiceAllocations.invoiceLineId, allLines.map(row => row.id)),
    receiptLines.length ? inArray(inventorySupplierInvoiceAllocations.receiptLineId, receiptLines.map(row => row.id)) : undefined);
  const allocations = await tx.select().from(inventorySupplierInvoiceAllocations).where(sourceFilter).orderBy(asc(inventorySupplierInvoiceAllocations.id));
  const effects = await tx.select().from(invoiceAllocationEffects).where(or(inArray(invoiceAllocationEffects.invoiceLineId, allLines.map(row => row.id)),
    receiptLines.length ? inArray(invoiceAllocationEffects.receiptLineId, receiptLines.map(row => row.id)) : undefined)).orderBy(asc(invoiceAllocationEffects.id));
  const events = await tx.select().from(invoiceReconciliations).where(eq(invoiceReconciliations.purchaseOrderId, order.id)).orderBy(asc(invoiceReconciliations.id));
  const legacyUnknown = !proof || !version || proof.evidenceVersion !== 1 || proof.idempotencyKey !== invoice.idempotencyKey
    || proof.createdBy !== invoice.createdBy || lines.some(line => !line.unit || line.priceBasisQuantity === null || line.allocatedQuantity === null)
    || invoices.some(row => row.allocationStatus === null || row.allocationStatus === "legacy_unknown" || !proofs.some(witness => witness.invoiceId === row.id));
  const fingerprint = createHash("sha256").update(canonicalJson(isoValues({ version: 1, invoice, order, proof, fixedVersion: version,
    invoices, proofs, allLines, receipts, receiptLines, allocations, effects, events, legacyUnknown }))).digest("hex");
  return { invoice, order, proof, version, lines, invoices, proofs, allLines, receipts, receiptLines, allocations, effects, events, legacyUnknown, fingerprint };
}

function isoValues(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(isoValues);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, isoValues(child)]));
  return value;
}

function occupation(receipts: ReceiptLineRow[], allocations: AllocationRow[], effects: (EffectPlan & { id?: string })[]): Occupation {
  const receiptById = new Map(receipts.map(receipt => [receipt.id, receipt]));
  const sources = new Map<string, { invoiceLineId: string; receiptLineId: string; quantity: StockQuantity; unit: string }>();
  const released = new Map<string, StockQuantity>();
  const result: Occupation = { byReceipt: new Map(), byLine: new Map() };
  function add(invoiceLineId: string, receiptLineId: string, unit: string, quantity: StockQuantity, release = false) {
    const receipt = receiptById.get(receiptLineId);
    if (!receipt || receipt.unit !== unit || compareStockQuantity(quantity, 0) <= 0) basisUnavailable();
    const combine = release ? subtractStockQuantity : addStockQuantity;
    result.byReceipt.set(receiptLineId, combine(result.byReceipt.get(receiptLineId) ?? 0, quantity));
    result.byLine.set(invoiceLineId, combine(result.byLine.get(invoiceLineId) ?? 0, quantity));
  }
  for (const allocation of allocations) {
    sources.set(`allocation:${allocation.id}`, allocation);
    add(allocation.invoiceLineId, allocation.receiptLineId, allocation.unit, allocation.quantity);
  }
  for (const effect of effects.filter(effect => effect.kind === "consume")) {
    if (effect.sourceAllocationId || effect.sourceEffectId) basisUnavailable();
    if (effect.id) sources.set(`effect:${effect.id}`, effect);
    add(effect.invoiceLineId, effect.receiptLineId, effect.unit, effect.quantity);
  }
  for (const effect of effects.filter(effect => effect.kind === "release")) {
    if (Boolean(effect.sourceAllocationId) === Boolean(effect.sourceEffectId)) basisUnavailable();
    const sourceId = effect.sourceAllocationId ? `allocation:${effect.sourceAllocationId}` : `effect:${effect.sourceEffectId}`;
    const source = sources.get(sourceId);
    if (!source || source.invoiceLineId !== effect.invoiceLineId || source.receiptLineId !== effect.receiptLineId || source.unit !== effect.unit) basisUnavailable();
    const total = addStockQuantity(released.get(sourceId) ?? 0, effect.quantity);
    if (compareStockQuantity(total, source.quantity) > 0) basisUnavailable();
    released.set(sourceId, total);
    add(effect.invoiceLineId, effect.receiptLineId, effect.unit, effect.quantity, true);
  }
  for (const [id, used] of result.byReceipt) {
    if (compareStockQuantity(used, 0) < 0 || compareStockQuantity(used, receiptById.get(id)!.receivedQuantity) > 0) basisUnavailable();
  }
  for (const used of result.byLine.values()) if (compareStockQuantity(used, 0) < 0) basisUnavailable();
  return result;
}

function approvedDocuments(graph: Graph, events: ActionFact[]) {
  const approved = new Set(events.filter(event => event.invoiceId === graph.invoice.id
    && event.input.action === "adjustment_review" && event.input.decision === "approved")
    .map(event => (event.input as Extract<InvoiceReconciliationInput, { action: "adjustment_review" }>).adjustmentId));
  return events.filter(event => event.invoiceId === graph.invoice.id && event.input.action === "adjustment_record" && approved.has(event.id))
    .map(event => event.input as Extract<InvoiceReconciliationInput, { action: "adjustment_record" }>);
}

function calculateBalance(graph: Graph, events: ActionFact[] = graph.events,
  effects: (EffectPlan & { id?: string })[] = graph.effects): InvoiceReconciliationBalance {
  const documents = approvedDocuments(graph, events);
  const reasons = new Set<InvoiceReconciliationBalance["unknownReasons"][number]>();
  if (graph.legacyUnknown) reasons.add("legacy_basis_missing");
  const sameCurrency = graph.version !== null && graph.invoice.currency === graph.version.currency;
  if (graph.version && !sameCurrency) reasons.add("currency_mismatch");
  const used = graph.legacyUnknown ? null : occupation(graph.receiptLines, graph.allocations, effects);
  const ordered = new Map(graph.version?.lineSnapshot.map(line => [line.lineKey, line]) ?? []);
  const creditAmounts: number[] = [], debitAmounts: number[] = [];
  const lines = graph.lines.map(line => {
    const credits = documents.filter(document => document.document.kind === "credit_note").flatMap(document => document.lines.filter(item => item.invoiceLineId === line.id));
    const debits = documents.filter(document => document.document.kind === "debit_note").flatMap(document => document.lines.filter(item => item.invoiceLineId === line.id));
    const creditedQuantity = sumStockQuantities(credits.map(item => item.quantity));
    const netQuantity = subtractStockQuantity(line.invoicedQuantity, creditedQuantity);
    if (compareStockQuantity(netQuantity, 0) < 0) conflict("invoice_reconciliation_quantity_exceeded", "累计贷项数量超过原发票尚未抵减的数量");
    const creditAmountMinor = exact(() => sumProcurementMinor(credits.map(item => item.amountMinor)));
    const debitAmountMinor = exact(() => sumProcurementMinor(debits.map(item => item.amountMinor)));
    creditAmounts.push(creditAmountMinor); debitAmounts.push(debitAmountMinor);
    const unit = ProcurementUnitSchema.safeParse(line.unit);
    let originalAmountMinor: number | null = null;
    if (line.priceBasisQuantity !== null && unit.success) {
      try { originalAmountMinor = procurementAmountMinor(line.invoicedQuantity, line.unitCostMinor, line.priceBasisQuantity); }
      catch (error) { if (!(error instanceof RangeError)) throw error; reasons.add("price_basis_unrepresentable"); }
    } else reasons.add("legacy_basis_missing");
    const netAmountMinor = originalAmountMinor === null ? null : exact(() => safeMinorValue(BigInt(originalAmountMinor!) + BigInt(debitAmountMinor) - BigInt(creditAmountMinor)));
    if (netAmountMinor !== null && netAmountMinor < 0) conflict("invoice_reconciliation_amount_exceeded", "累计贷项金额超过原发票及已核准补差的尚余金额");
    const allocatedQuantity = used?.byLine.get(line.id) ?? (used ? 0 : null);
    const unallocatedQuantity = allocatedQuantity === null ? null : subtractStockQuantity(netQuantity, allocatedQuantity);
    if (unallocatedQuantity !== null && compareStockQuantity(unallocatedQuantity, 0) < 0) basisUnavailable();
    let expectedAmountMinor: number | null = null;
    const source = ordered.get(line.lineKey);
    if (!source || !unit.success || source.unit !== line.unit) reasons.add("legacy_basis_missing");
    else if (sameCurrency && allocatedQuantity !== null) {
      try { expectedAmountMinor = procurementAmountMinor(allocatedQuantity, source.unitCostMinor, source.priceBasisQuantity ?? 1); }
      catch (error) { if (!(error instanceof RangeError)) throw error; reasons.add("price_basis_unrepresentable"); }
    }
    const varianceMinor = netAmountMinor === null || expectedAmountMinor === null ? null : exact(() => subtractProcurementMinor(netAmountMinor, expectedAmountMinor));
    return { invoiceLineId: line.id, lineKey: line.lineKey, unit: unit.success ? unit.data : null,
      originalQuantity: line.invoicedQuantity, creditedQuantity, netQuantity, allocatedQuantity, unallocatedQuantity,
      originalAmountMinor, creditAmountMinor, debitAmountMinor, netAmountMinor, expectedAmountMinor, varianceMinor };
  });
  const netAmountMinor = exact(() => safeMinorValue(BigInt(graph.invoice.totalMinor)
    + debitAmounts.reduce((total, amount) => total + BigInt(amount), 0n) - creditAmounts.reduce((total, amount) => total + BigInt(amount), 0n)));
  if (netAmountMinor < 0) conflict("invoice_reconciliation_amount_exceeded", "累计贷项金额超过原发票及已核准补差的尚余金额");
  const fullyCredited = !graph.legacyUnknown && netAmountMinor === 0
    && lines.every(line => compareStockQuantity(line.netQuantity, 0) === 0 && line.netAmountMinor === 0);
  const varianceMinor = reasons.size || lines.some(line => line.varianceMinor === null) ? null
    : exact(() => sumProcurementMinor(lines.map(line => line.varianceMinor!)));
  const matched = reasons.size === 0 && varianceMinor === 0 && lines.every(line => line.unallocatedQuantity !== null
    && compareStockQuantity(line.unallocatedQuantity, 0) === 0 && line.varianceMinor === 0);
  return InvoiceReconciliationBalanceSchema.parse({ status: fullyCredited ? "fully_credited" : reasons.size ? "unknown" : matched ? "matched" : "reconciliation_required",
    currency: graph.invoice.currency, comparisonCurrency: graph.version?.currency ?? null, unknownReasons: [...reasons],
    netAmountMinor, varianceMinor, lines });
}

function adjustmentsOf(graph: Graph): SupplierAdjustmentView[] {
  return graph.events.filter(event => event.invoiceId === graph.invoice.id && event.input.action === "adjustment_record").map(event => {
    const input = event.input as Extract<InvoiceReconciliationInput, { action: "adjustment_record" }>;
    const review = graph.events.find(candidate => candidate.invoiceId === graph.invoice.id && candidate.adjustmentId === event.id && candidate.input.action === "adjustment_review");
    const decision = review?.input.action === "adjustment_review" ? review.input.decision : null;
    return { id: event.id, invoiceId: graph.invoice.id, document: input.document, lines: input.lines, reason: input.reason,
      createdBy: event.createdBy, createdAt: event.createdAt.toISOString(), status: decision ?? "pending", reviewId: review?.id ?? null,
      reviewedBy: review?.createdBy ?? null, reviewedAt: review?.createdAt.toISOString() ?? null, reviewReason: review?.input.reason ?? null };
  });
}

function detailOf(graph: Graph, current: TenantContext): InvoiceReconciliationDetail {
  const balance = calculateBalance(graph);
  const used = graph.legacyUnknown ? null : occupation(graph.receiptLines, graph.allocations, graph.effects);
  const receipts = new Set(graph.receipts.filter(receipt => receipt.purchaseOrderVersionId === graph.version?.id).map(receipt => receipt.id));
  const canRecord = !graph.legacyUnknown && permitted(current, Permission.ProcurementWrite, graph.order.createdBy);
  const canApprove = !graph.legacyUnknown && permitted(current, Permission.ProcurementApprove, graph.order.createdBy);
  return InvoiceReconciliationDetailSchema.parse({ invoiceId: graph.invoice.id, invoiceNumber: graph.invoice.invoiceNumber,
    originalStatus: graph.invoice.status, purchaseOrderId: graph.order.id, purchaseOrderCode: graph.order.code,
    supplierId: graph.order.supplierId, purchaseOrderVersionId: graph.version?.id ?? null, originalProofId: graph.proof?.id ?? null,
    fingerprint: graph.fingerprint, canRecord, canApprove,
    blockReason: graph.legacyUnknown ? "invoice_reconciliation_legacy_basis_missing" : !canRecord && !canApprove ? "permission_denied" : null,
    balance, adjustments: adjustmentsOf(graph), events: graph.events.filter(event => event.invoiceId === graph.invoice.id).sort((a, b) => a.sequence - b.sequence).map(eventView),
    receipts: graph.receiptLines.filter(receipt => receipts.has(receipt.receiptId)).map(receipt => ({ receiptLineId: receipt.id,
      lineKey: receipt.lineKey, unit: ProcurementUnitSchema.parse(receipt.unit), acceptedQuantity: receipt.receivedQuantity,
      availableQuantity: used ? subtractStockQuantity(receipt.receivedQuantity, used.byReceipt.get(receipt.id) ?? 0) : null })) });
}

function eventView(row: EventRow): InvoiceReconciliationEvent {
  return InvoiceReconciliationEventSchema.parse({ id: row.id, invoiceId: row.invoiceId, purchaseOrderId: row.purchaseOrderId,
    purchaseOrderVersionId: row.purchaseOrderVersionId, originalProofId: row.originalProofId, sequence: row.sequence,
    previousId: row.previousId, adjustmentId: row.adjustmentId, action: row.action, input: row.input,
    createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), balance: row.balance });
}

async function validatePlan(tx: TenantTransaction, graph: Graph, input: InvoiceReconciliationInput): Promise<EffectPlan[]> {
  if (input.expectedFingerprint !== graph.fingerprint) conflict("invoice_reconciliation_basis_changed", "原发票 收货或已核准核对已变化 请重新核对实际依据");
  const balance = calculateBalance(graph);
  let effects: EffectPlan[] = [];
  if (input.action === "adjustment_record") {
    const [duplicate] = await tx.select({ id: invoiceReconciliations.id }).from(invoiceReconciliations).where(and(
      eq(invoiceReconciliations.supplierId, graph.order.supplierId), eq(invoiceReconciliations.documentKey, documentKey(input)),
    )).limit(1);
    if (duplicate) conflict("invoice_reconciliation_document_duplicate", "这家供应商的该凭证号已登记 请核对原凭证 更换日期或发票不能重复使用");
    validateAdjustment(graph, input, balance);
  } else if (input.action === "adjustment_review") {
    const record = graph.events.find(event => event.invoiceId === graph.invoice.id && event.id === input.adjustmentId);
    if (!record || record.input.action !== "adjustment_record") throw new NotFoundException("Supplier adjustment document not found");
    if (graph.events.some(event => event.adjustmentId === record.id)) conflict("invoice_reconciliation_adjustment_reviewed", "该供应商凭证已有实际审核结果 请核对原结果");
    if (input.decision === "approved") {
      validateAdjustment(graph, record.input, balance);
      if (record.input.document.kind === "credit_note") effects = creditReleases(graph, record.input, balance);
    }
  } else effects = receiptMatches(graph, input, balance);
  // Projection is pure. Preparing a command never inserts a speculative event
  // or acquires a supplier document / financial capacity reservation.
  calculateBalance(graph, [...graph.events, { id: "prospective", invoiceId: graph.invoice.id, input }], [...graph.effects, ...effects]);
  return effects;
}

function validateAdjustment(graph: Graph, document: Extract<InvoiceReconciliationInput, { action: "adjustment_record" }>, balance: InvoiceReconciliationBalance) {
  if (document.document.currency !== graph.invoice.currency)
    conflict("invoice_reconciliation_currency_mismatch", "调整凭证须使用原发票币种 本次不换算汇率");
  const projected: number[] = [];
  for (const line of document.lines) {
    const original = balance.lines.find(candidate => candidate.invoiceLineId === line.invoiceLineId);
    if (!original || original.unit !== line.unit || original.netAmountMinor === null) basisUnavailable();
    if (document.document.kind === "credit_note") {
      if (compareStockQuantity(line.quantity, original.netQuantity) > 0)
        conflict("invoice_reconciliation_quantity_exceeded", "贷项数量超过该原发票行尚未抵减的数量");
      if (line.amountMinor > original.netAmountMinor)
        conflict("invoice_reconciliation_amount_exceeded", "贷项金额超过该原发票行及已核准补差的尚余金额");
      projected.push(-line.amountMinor);
    } else {
      if (compareStockQuantity(line.quantity, 0) !== 0) conflict("invoice_reconciliation_quantity_exceeded", "补差只记录金额 新增数量须登记新的实际发票");
      exact(() => sumProcurementMinor([original.netAmountMinor!, line.amountMinor]));
      projected.push(line.amountMinor);
    }
  }
  exact(() => sumProcurementMinor([balance.netAmountMinor, ...projected]));
}

function creditReleases(graph: Graph, document: Extract<InvoiceReconciliationInput, { action: "adjustment_record" }>, balance: InvoiceReconciliationBalance): EffectPlan[] {
  const result: EffectPlan[] = [];
  for (const line of document.lines) {
    const original = balance.lines.find(candidate => candidate.invoiceLineId === line.invoiceLineId)!;
    if (original.unallocatedQuantity === null) basisUnavailable();
    // A credit cancels an unallocated invoice claim before releasing an actual
    // 149 allocation or a later real receipt-consumption effect.
    let remaining = subtractStockQuantity(line.quantity, original.unallocatedQuantity);
    if (compareStockQuantity(remaining, 0) <= 0) continue;
    const sources = [
      ...graph.allocations.filter(source => source.invoiceLineId === line.invoiceLineId).map(source => ({ ...source, sourceAllocationId: source.id, sourceEffectId: null })),
      ...graph.effects.filter(source => source.kind === "consume" && source.invoiceLineId === line.invoiceLineId).map(source => ({ ...source, sourceAllocationId: null, sourceEffectId: source.id })),
    ].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const source of sources) {
      if (compareStockQuantity(remaining, 0) <= 0) break;
      const released = sumStockQuantities(graph.effects.filter(effect => effect.kind === "release" && (source.sourceAllocationId
        ? effect.sourceAllocationId === source.sourceAllocationId : effect.sourceEffectId === source.sourceEffectId)).map(effect => effect.quantity));
      const available = subtractStockQuantity(source.quantity, released);
      if (compareStockQuantity(available, 0) < 0 || source.unit !== line.unit) basisUnavailable();
      const quantity = compareStockQuantity(remaining, available) < 0 ? remaining : available;
      if (compareStockQuantity(quantity, 0) <= 0) continue;
      result.push({ invoiceLineId: line.invoiceLineId, receiptLineId: source.receiptLineId, kind: "release", quantity, unit: line.unit,
        sourceAllocationId: source.sourceAllocationId, sourceEffectId: source.sourceEffectId });
      remaining = subtractStockQuantity(remaining, quantity);
    }
    if (compareStockQuantity(remaining, 0) > 0) basisUnavailable();
  }
  return result;
}

function receiptMatches(graph: Graph, input: Extract<InvoiceReconciliationInput, { action: "receipt_match" }>, balance: InvoiceReconciliationBalance): EffectPlan[] {
  const used = occupation(graph.receiptLines, graph.allocations, graph.effects);
  const remainingClaims = new Map(balance.lines.map(line => [line.invoiceLineId, line.unallocatedQuantity]));
  const receiptHeaders = new Map(graph.receipts.map(receipt => [receipt.id, receipt]));
  const result: EffectPlan[] = [];
  for (const line of input.lines) {
    const original = balance.lines.find(candidate => candidate.invoiceLineId === line.invoiceLineId);
    const receipt = graph.receiptLines.find(candidate => candidate.id === line.receiptLineId);
    const ordered = graph.version?.lineSnapshot.find(candidate => candidate.lineKey === original?.lineKey);
    if (!original || !receipt || !ordered || original.unit !== line.unit || receipt.unit !== line.unit || ordered.unit !== line.unit
      || receiptHeaders.get(receipt.receiptId)?.purchaseOrderVersionId !== graph.version?.id || receipt.lineKey !== original.lineKey
      || receipt.stockItemId !== ordered.stockItemId || receipt.destinationLocationId !== ordered.destinationLocationId)
      conflict("invoice_reconciliation_receipt_basis_mismatch", "须使用原发票固定采购版本同一行 同单位的实际合格收货");
    const claim = remainingClaims.get(line.invoiceLineId);
    if (claim === null || claim === undefined) basisUnavailable();
    if (compareStockQuantity(line.quantity, claim) > 0)
      conflict("invoice_reconciliation_quantity_exceeded", "匹配数量超过该原发票行尚未分配的净数量");
    const available = subtractStockQuantity(receipt.receivedQuantity, used.byReceipt.get(receipt.id) ?? 0);
    if (compareStockQuantity(line.quantity, available) > 0)
      conflict("invoice_reconciliation_receipt_capacity_exceeded", "该实际收货的可开票数量已不足 请核对已分配记录");
    remainingClaims.set(line.invoiceLineId, subtractStockQuantity(claim, line.quantity));
    used.byReceipt.set(receipt.id, addStockQuantity(used.byReceipt.get(receipt.id) ?? 0, line.quantity));
    result.push({ invoiceLineId: line.invoiceLineId, receiptLineId: receipt.id, kind: "consume", quantity: line.quantity, unit: line.unit,
      sourceAllocationId: null, sourceEffectId: null });
  }
  return result;
}

function exact<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    conflict(error.message.startsWith("procurement_") ? error.message : "invoice_reconciliation_quantity_invalid", "数量或金额无法按原凭据精确计算 请核对填写 不自动舍入");
  }
}

function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }
function basisUnavailable(): never { return conflict("invoice_reconciliation_legacy_basis_missing", "原发票或收货分配依据不完整 请核对历史 不自动重建原账"); }
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`); }
