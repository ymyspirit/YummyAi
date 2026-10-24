import { ArchiveRecordInputSchema, EntityIdSchema } from "@yummyai/contracts";
import { authorize, Permission, intersectPermissionContexts } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { createHash } from "node:crypto";
import { addStockQuantity, compareStockQuantity, stockQuantityWithinCommandLimit,
  subtractStockQuantity, sumStockQuantities, stockQuantityMatchesUnit, type StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { assertProcurementQuantityUnit, convertProcurementQuantity, equivalentProcurementPrice,
  pinProcurementStockBasis, procurementAmountMinor, ProcurementStockBasisSchema, ProcurementUnitSchema, subtractProcurementMinor,
  sumProcurementMinor, type ProcurementStockBasis, type ProcurementUnit } from "@yummyai/contracts/procurement/measurement";
import type { ProcurementInvoiceView, ProcurementPurchaseLineSnapshot } from "@yummyai/contracts/procurement";
import type { InvoiceReconciliationEvent } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { CreateSupplyPurchaseInputSchema, type CreateSupplyPurchaseInput } from "@yummyai/contracts/catalog/product-supply";
import { PrepareProcurementCommandSchema, type PrepareProcurementCommand, type ProcurementCommandKind,
  type ProcurementCommandResult, type ProcurementCommandScope, type ProcurementReviewBasis } from "@yummyai/contracts/procurement/procurement-command";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  CreateInventoryPurchaseOrderInputSchema,
  CreateProcurementRequisitionInputSchema,
  CreateProcurementRfqInputSchema,
  CreateReplenishmentSuggestionInputSchema,
  RecordProcurementInvoiceInputSchema,
  ProcurementInvoiceViewSchema,
  RecordProcurementReceiptInputSchema,
  RecordProcurementSupplierQuoteInputSchema,
  ReviewInventoryPurchaseOrderInputSchema,
  ReviseInventoryPurchaseOrderInputSchema,
  UpsertReplenishmentPolicyInputSchema,
  createEntityId,
  type CreateInventoryPurchaseOrderInput,
  type CreateProcurementRequisitionInput,
  type CreateProcurementRfqInput,
  type CreateReplenishmentSuggestionInput,
  type ProcurementPurchaseLine,
  type ProcurementRequestLine,
  type RecordProcurementInvoiceInput,
  type RecordProcurementReceiptInput,
  type RecordProcurementSupplierQuoteInput,
  type ReviewInventoryPurchaseOrderInput,
  type ReviseInventoryPurchaseOrderInput,
  type TenantContext,
  type UpsertReplenishmentPolicyInput,
} from "@yummyai/contracts";
import {
  fulfillmentSuppliers,
  productSupplyLinks, productSupplyVersions, productPlans,
  inventoryBalances,
  inventoryLocations,
  inventoryProcurementReceiptLines,
  inventoryProcurementReceipts,
  inventoryProcurementWriteRequests,
  inventoryProcurementReceiptRequests, procurementArrivals, loadCurrentMembershipContext,
  inventoryProcurementRequisitionVersions,
  inventoryProcurementRequisitions,
  inventoryProcurementRfqs,
  inventoryPurchaseOrderEvents,
  inventoryPurchaseOrderVersions,
  inventoryPurchaseOrders,
  inventoryReplenishmentPolicies,
  inventoryReplenishmentPolicyVersions,
  inventoryReplenishmentSuggestions,
  inventoryStockItems,
  inventorySupplierInvoiceLines,
  inventorySupplierInvoices,
  inventorySupplierInvoiceRequests,
  inventorySupplierInvoiceAllocations,
  invoiceReconciliations,
  inventorySupplierQuoteVersions,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { procurementReadScope, readProcurementAnalysis } from "./procurement-analysis.js";
import { assertProcurementReplay, beginProcurementWrite, bindProcurementWrite, procurementCommandBinding } from "./procurement-original-request.js";
import { assertInvoiceReplay, beginInvoiceWrite, bindInvoiceRequest, invoiceRequestChecksum } from "./procurement-invoice-request.js";
import { InvoiceReconciliationService, readEffectiveInvoiceOccupationInTransaction } from "./invoice-reconciliation.service.js";

type PurchaseOrderRow = typeof inventoryPurchaseOrders.$inferSelect;
type PurchaseOrderVersionRow = typeof inventoryPurchaseOrderVersions.$inferSelect;
type InvoiceAllocationPlan = { receiptLineId: string; quantity: StockQuantity; unit: ProcurementUnit };
type InvoiceLinePlan = { lineKey: string; invoicedQuantity: StockQuantity; unit: ProcurementUnit; unitCostMinor: number;
  priceBasisQuantity: StockQuantity; allocatedQuantity: StockQuantity | null; varianceMinor: number | null; allocations: InvoiceAllocationPlan[] };

@Injectable()
export class ProcurementService {
  private readonly invoiceReconciliation: InvoiceReconciliationService;
  /** A preparation checks real owner rules without creating a business fact. */
  async validateCommandInTransaction(tx: TenantTransaction, context: TenantContext, raw: PrepareProcurementCommand) {
    const original = PrepareProcurementCommandSchema.parse(raw);
    const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context));
    if (original.kind === "invoice_reconcile") {
      await this.invoiceReconciliation.validateInTransaction(tx, current, original.targetId, original.input);
      return;
    }
    const permission = original.kind === "purchase_review" ? Permission.ProcurementApprove : Permission.ProcurementWrite;
    authorize(current, permission);
    authorize(current, Permission.ProcurementRead);
    if (original.kind === "invoice_record") {
      const [actual] = await tx.select({ id: inventorySupplierInvoiceRequests.id }).from(inventorySupplierInvoiceRequests)
        .where(eq(inventorySupplierInvoiceRequests.idempotencyKey, original.input.idempotencyKey)).limit(1);
      if (actual) throw new ConflictException({ code: "procurement_actual_already_recorded", message: "这张发票已有真实登记 不可追认为新的待执行命令" });
      const [legacy] = await tx.select({ id: inventorySupplierInvoices.id }).from(inventorySupplierInvoices)
        .where(eq(inventorySupplierInvoices.idempotencyKey, original.input.idempotencyKey)).limit(1);
      if (legacy) throw new ConflictException({ code: "procurement_invoice_input_unavailable", message: "旧发票缺少原提交依据 请先核对原发票 不可追认为待执行命令" });
      await this.readCommandTargetInTransaction(tx, current, original, { original });
      const order = await requirePurchaseOrder(tx, original.targetId);
      authorize(current, permission, { ownerId: order.createdBy });
      if (order.currentVersion !== original.input.expectedVersion) throw new ConflictException("Purchase order basis changed");
      const version = await requirePurchaseOrderVersion(tx, order);
      await planInvoice(tx, current, order, version, original.input);
      return;
    }
    const binding = procurementCommandBinding(original);
    const operation = original.kind === "supply_purchase_create" ? "purchase_create" : original.kind;
    const [actual] = await tx.select({ id: inventoryProcurementWriteRequests.id }).from(inventoryProcurementWriteRequests)
      .where(and(eq(inventoryProcurementWriteRequests.operation, operation), eq(inventoryProcurementWriteRequests.idempotencyKey, binding.idempotencyKey))).limit(1);
    if (actual) throw new ConflictException({ code: "procurement_actual_already_recorded", message: "这笔采购已有真实业务记录 不可追认为新的待执行命令" });
    if ((await legacyProcurementFact(tx, original)).length)
      throw new ConflictException({ code: "procurement_input_unavailable", message: "旧采购操作缺少原提交依据 请先核对历史记录 不可追认为新的待执行命令" });
    await this.readCommandTargetInTransaction(tx, current, original, { original });
    if (original.kind === "requisition_create") {
      await validateRequestLines(tx, original.input.lines, current);
      return;
    }
    if (original.kind === "rfq_create") {
      const requisition = await requireRequisition(tx, original.targetId);
      authorize(current, permission, { ownerId: requisition.createdBy });
      if (requisition.currentVersion !== original.input.expectedRequisitionVersion || ["ordered", "cancelled"].includes(requisition.status))
        throw new ConflictException("Procurement requisition basis changed");
      await requireActiveSuppliers(tx, original.input.supplierIds, current);
      return;
    }
    if (original.kind === "quote_record") {
      const rfq = await requireRfq(tx, original.targetId);
      authorize(current, permission, { ownerId: rfq.createdBy });
      if (rfq.status !== "open" || !rfq.supplierIds.includes(original.input.supplierId)) throw new ConflictException("Procurement RFQ or supplier basis changed");
      await requireActiveSuppliers(tx, [original.input.supplierId], current);
      const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
      if (!version || version.lineSnapshot.length !== original.input.lines.length || version.lineSnapshot.some(line => !original.input.lines.some(quote => quote.lineKey === line.lineKey)))
        throw new ConflictException("Supplier quote line set differs from its RFQ");
      quoteTotal(version.lineSnapshot, original.input.lines);
      return;
    }
    if (original.kind === "purchase_create" || original.kind === "supply_purchase_create") {
      const input = original.kind === "purchase_create" ? original.input : (await prepareSupplyPurchase(tx, original.targetId, original.input, current, false)).input;
      await requireActiveSuppliers(tx, [input.supplierId], current);
      await validatePurchaseLines(tx, input.lines, current);
      if (input.requisitionId) {
        const requisition = await requireRequisition(tx, input.requisitionId);
        authorize(current, permission, { ownerId: requisition.createdBy });
        if (requisition.status === "cancelled") throw new ConflictException("Procurement requisition is cancelled");
      }
      await validateQuotedPurchase(tx, current, input, false);
      return;
    }
    const order = await requirePurchaseOrder(tx, original.targetId);
    authorize(current, permission, { ownerId: order.createdBy });
    if (order.currentVersion !== original.input.expectedVersion || !["draft", "rejected"].includes(order.status)) throw new ConflictException("Purchase order basis changed");
    if (original.kind === "purchase_revise") {
      await validatePurchaseLines(tx, original.input.lines, current);
      await validateQuotedPurchase(tx, current, { ...original.input, supplierId: order.supplierId, requisitionId: order.requisitionId, quoteId: order.quoteId }, false);
    } else if (original.input.decision === "approved") {
      const version = await requirePurchaseOrderVersion(tx, order);
      await validateQuotedPurchase(tx, current, { supplierId: order.supplierId, requisitionId: order.requisitionId, quoteId: order.quoteId, currency: version.currency, lines: version.lineSnapshot }, false);
    }
  }

  /** Execute only through the existing owners in this same top-level transaction. */
  async executeCommandInTransaction(tx: TenantTransaction, current: TenantContext, original: PrepareProcurementCommand): Promise<string> {
    await this.validateCommandInTransaction(tx, current, original);
    if (original.kind === "invoice_reconcile") return this.invoiceReconciliation.executeInTransaction(tx, current, original.targetId, original.input);
    if (original.kind === "invoice_record") {
      await this.recordInvoiceInTransaction(tx, current, original.targetId, original.input);
      const [proof] = await tx.select().from(inventorySupplierInvoiceRequests)
        .where(eq(inventorySupplierInvoiceRequests.idempotencyKey, original.input.idempotencyKey)).limit(1);
      if (!proof || proof.evidenceVersion !== 1 || proof.createdBy !== current.userId || proof.purchaseOrderId !== original.targetId
        || proof.requestChecksum !== invoiceRequestChecksum(original.targetId, original.input))
        throw new ConflictException("Actual invoice evidence is missing or differs");
      return proof.id;
    }
    switch (original.kind) {
      case "requisition_create": await this.createRequisitionInTransaction(tx, current, original.input); break;
      case "rfq_create": await this.createRfqInTransaction(tx, current, original.targetId, original.input); break;
      case "quote_record": await this.recordSupplierQuoteInTransaction(tx, current, original.targetId, original.input); break;
      case "purchase_create": await this.persistPurchaseOrderInTransaction(tx, current, original.input); break;
      case "supply_purchase_create": await this.persistPurchaseOrderInTransaction(tx, current, undefined, { linkId: original.targetId, input: original.input }); break;
      case "purchase_revise": await this.revisePurchaseOrderInTransaction(tx, current, original.targetId, original.input); break;
      case "purchase_review": await this.reviewPurchaseOrderInTransaction(tx, current, original.targetId, original.input); break;
    }
    const binding = procurementCommandBinding(original);
    const operation = original.kind === "supply_purchase_create" ? "purchase_create" : original.kind;
    const [proof] = await tx.select().from(inventoryProcurementWriteRequests).where(and(eq(inventoryProcurementWriteRequests.operation, operation),
      eq(inventoryProcurementWriteRequests.idempotencyKey, binding.idempotencyKey))).limit(1);
    if (!proof || proof.createdBy !== current.userId || proof.targetId !== original.targetId || proof.requestChecksum !== binding.requestChecksum)
      throw new ConflictException("Actual procurement evidence is missing or differs");
    return proof.id;
  }

  async readCommandTargetInTransaction(tx: TenantTransaction, current: TenantContext, scope: ProcurementCommandScope,
    options: { original?: PrepareProcurementCommand; resultProofId?: string | null; invoiceResultProofId?: string | null } = {}): Promise<{ targetLabel: string; targetDetail: string | null }> {
    authorize(current, Permission.ProcurementRead);
    if (scope.kind === "invoice_reconcile") {
      if (options.original && (options.original.kind !== scope.kind || options.original.targetId !== scope.targetId))
        throw new ConflictException("Procurement original target differs");
      if (options.resultProofId) {
        const event = await this.invoiceReconciliation.readEventInTransaction(tx, current, options.resultProofId);
        if (event.invoiceId !== scope.targetId) throw new ConflictException("Actual invoice reconciliation target differs");
      }
      return this.invoiceReconciliation.readTargetInTransaction(tx, current, scope.targetId!);
    }
    let label = scope.kind === "requisition_create" ? "新建采购申请" : "新建采购草稿";
    if (scope.kind === "rfq_create") {
      const requisition = await requireRequisition(tx, scope.targetId!);
      authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
      const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(and(eq(inventoryProcurementRequisitionVersions.requisitionId, requisition.id), eq(inventoryProcurementRequisitionVersions.versionNumber, requisition.currentVersion))).limit(1);
      if (!version) throw new ConflictException("Procurement requisition version is missing");
      await readLineDimensions(tx, current, version.lineSnapshot);
      label = requisition.code;
    } else if (scope.kind === "quote_record") {
      const rfq = await requireRfq(tx, scope.targetId!);
      authorize(current, Permission.ProcurementRead, { ownerId: rfq.createdBy });
      const requisition = await requireRequisition(tx, rfq.requisitionId);
      authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
      const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
      if (!version) throw new ConflictException("RFQ requisition version is missing");
      await readLineDimensions(tx, current, version.lineSnapshot);
      label = requisition.code;
    } else if (scope.kind === "supply_purchase_create") {
      const [source] = await tx.select({ link: productSupplyLinks, product: productPlans }).from(productSupplyLinks)
        .innerJoin(productPlans, eq(productPlans.id, productSupplyLinks.productPlanId)).where(eq(productSupplyLinks.id, scope.targetId!)).limit(1);
      if (!source) throw new NotFoundException("Product supply not found");
      authorize(current, Permission.ProductRead, { ownerId: source.link.createdBy });
      authorize(current, Permission.ProductRead, { ownerId: source.product.createdBy });
      await readSupplier(tx, current, source.link.supplierId);
      label = "供货关联采购";
    } else if (scope.kind === "purchase_revise" || scope.kind === "purchase_review" || scope.kind === "invoice_record") {
      const order = await requirePurchaseOrder(tx, scope.targetId!);
      authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
      await readSupplier(tx, current, order.supplierId);
      const version = await requirePurchaseOrderVersion(tx, order);
      await readLineDimensions(tx, current, version.lineSnapshot);
      label = order.code;
    }
    const original = options.original;
    if (original) {
      if (original.kind !== scope.kind || original.targetId !== scope.targetId) throw new ConflictException("Procurement original target differs");
      if (original.kind === "requisition_create" || original.kind === "purchase_create" || original.kind === "purchase_revise") await readLineDimensions(tx, current, original.input.lines);
      if (original.kind === "rfq_create") for (const id of original.input.supplierIds) await readSupplier(tx, current, id);
      if (original.kind === "quote_record" || original.kind === "purchase_create") await readSupplier(tx, current, original.input.supplierId);
      if (original.kind === "purchase_create") {
        if (original.input.requisitionId) {
          const request = await requireRequisition(tx, original.input.requisitionId);
          authorize(current, Permission.ProcurementRead, { ownerId: request.createdBy });
        }
        if (original.input.quoteId) {
          const [quote] = await tx.select().from(inventorySupplierQuoteVersions).where(eq(inventorySupplierQuoteVersions.id, original.input.quoteId)).limit(1);
          if (!quote) throw new NotFoundException("Procurement supplier quote not found");
          authorize(current, Permission.ProcurementRead, { ownerId: quote.createdBy });
        }
      }
      if (original.kind === "supply_purchase_create") await readLocation(tx, current, original.input.destinationLocationId);
      if (original.kind === "invoice_record") {
        const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(and(
          eq(inventoryPurchaseOrderVersions.purchaseOrderId, original.targetId), eq(inventoryPurchaseOrderVersions.versionNumber, original.input.expectedVersion),
        )).limit(1);
        if (!version) throw new ConflictException("Original invoice purchase version is missing");
        await readLineDimensions(tx, current, version.lineSnapshot);
      }
      if (original.kind === "requisition_create" || original.kind === "purchase_create") label = original.input.code;
    }
    const resultProofId = scope.kind === "invoice_record" ? options.invoiceResultProofId ?? options.resultProofId : options.resultProofId;
    if (resultProofId) {
      const result = await this.readCommandResultInTransaction(tx, current, scope.kind, resultProofId);
      if (scope.targetId === null) {
        if (scope.kind === "requisition_create") label = (await requireRequisition(tx, result.id)).code;
        else label = (await requirePurchaseOrder(tx, result.id)).code;
      }
    }
    return { targetLabel: label, targetDetail: null };
  }

  /** Review the retained request against its named historical source. Reading a
   * newer head would silently change the basis the operator is confirming. */
  async reviewCommandBasisInTransaction(tx: TenantTransaction, context: TenantContext,
    raw: PrepareProcurementCommand): Promise<ProcurementReviewBasis | null> {
    const original = PrepareProcurementCommandSchema.parse(raw);
    const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context));
    authorize(current, Permission.ProcurementRead);
    if (original.kind === "invoice_reconcile") {
      await this.invoiceReconciliation.readTargetInTransaction(tx, current, original.targetId);
      return null;
    }
    let sourceVersionId: string | null = null, currency: string | null = null;
    let lines: Array<ProcurementRequestLine & { unitCostMinor?: number; priceBasisQuantity?: StockQuantity; stockBasis?: ProcurementStockBasis }>;
    let pinNewPurchase = false;
    try {
      if (original.kind === "requisition_create") lines = original.input.lines;
      else if (original.kind === "rfq_create") {
        const requisition = await requireRequisition(tx, original.targetId);
        authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
        for (const supplierId of original.input.supplierIds) await readSupplier(tx, current, supplierId);
        const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(and(
          eq(inventoryProcurementRequisitionVersions.requisitionId, requisition.id),
          eq(inventoryProcurementRequisitionVersions.versionNumber, original.input.expectedRequisitionVersion),
        )).limit(1);
        if (!version) return null;
        sourceVersionId = version.id;
        lines = version.lineSnapshot;
      } else if (original.kind === "quote_record") {
        const rfq = await requireRfq(tx, original.targetId);
        authorize(current, Permission.ProcurementRead, { ownerId: rfq.createdBy });
        const requisition = await requireRequisition(tx, rfq.requisitionId);
        authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
        await readSupplier(tx, current, original.input.supplierId);
        const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
        if (!version) return null;
        const prices = new Map(original.input.lines.map(line => [line.lineKey, line]));
        if (version.lineSnapshot.some(line => !prices.has(line.lineKey))) return null;
        sourceVersionId = version.id;
        currency = original.input.currency;
        lines = version.lineSnapshot.map(line => {
          const price = prices.get(line.lineKey)!;
          return { ...line, quantity: compareStockQuantity(line.quantity, price.minimumOrderQuantity) < 0 ? price.minimumOrderQuantity : line.quantity,
            unitCostMinor: price.unitCostMinor, ...(price.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: price.priceBasisQuantity }) };
        });
      } else if (original.kind === "purchase_create") {
        await readSupplier(tx, current, original.input.supplierId);
        if (original.input.requisitionId) {
          const requisition = await requireRequisition(tx, original.input.requisitionId);
          authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
        }
        if (original.input.quoteId) {
          const [quote] = await tx.select().from(inventorySupplierQuoteVersions).where(eq(inventorySupplierQuoteVersions.id, original.input.quoteId)).limit(1);
          if (!quote) return null;
          authorize(current, Permission.ProcurementRead, { ownerId: quote.createdBy });
          const rfq = await requireRfq(tx, quote.rfqId);
          authorize(current, Permission.ProcurementRead, { ownerId: rfq.createdBy });
          const requisition = await requireRequisition(tx, rfq.requisitionId);
          authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
          sourceVersionId = quote.id;
        }
        currency = original.input.currency;
        lines = original.input.lines;
        pinNewPurchase = true;
      } else if (original.kind === "supply_purchase_create") {
        const [source] = await tx.select({ link: productSupplyLinks, version: productSupplyVersions, product: productPlans }).from(productSupplyLinks)
          .innerJoin(productSupplyVersions, and(eq(productSupplyVersions.linkId, productSupplyLinks.id), eq(productSupplyVersions.versionNumber, original.input.expectedVersion)))
          .innerJoin(productPlans, eq(productPlans.id, productSupplyLinks.productPlanId)).where(eq(productSupplyLinks.id, original.targetId)).limit(1);
        if (!source) return null;
        authorize(current, Permission.ProductRead, { ownerId: source.link.createdBy });
        authorize(current, Permission.ProductRead, { ownerId: source.product.createdBy });
        await readSupplier(tx, current, source.link.supplierId);
        const terms = source.version.terms;
        if (!terms.stockItemId || terms.unitCostMinor === null) return null;
        const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, terms.stockItemId)).limit(1);
        if (!stock) return null;
        authorize(current, Permission.InventoryRead, { ownerId: stock.createdBy });
        sourceVersionId = source.version.id;
        currency = terms.currency;
        lines = [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: original.input.destinationLocationId,
          quantity: original.input.quantity, unit: terms.purchaseUnit ?? ProcurementUnitSchema.parse(stock.baseUnit), unitCostMinor: terms.unitCostMinor,
          ...(terms.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: terms.priceBasisQuantity }) }];
        pinNewPurchase = true;
      } else if (original.kind === "invoice_record") {
        const order = await requirePurchaseOrder(tx, original.targetId);
        authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
        await readSupplier(tx, current, order.supplierId);
        const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(and(
          eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id), eq(inventoryPurchaseOrderVersions.versionNumber, original.input.expectedVersion),
        )).limit(1);
        if (!version) return null;
        const ordered = new Map(version.lineSnapshot.map(line => [line.lineKey, line]));
        lines = [];
        for (const input of original.input.lines) {
          const source = ordered.get(input.lineKey);
          if (!source) return null;
          const line = { lineKey: input.lineKey, stockItemId: source.stockItemId, destinationLocationId: source.destinationLocationId,
            quantity: input.invoicedQuantity, unit: source.unit, unitCostMinor: input.unitCostMinor,
            ...(input.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: input.priceBasisQuantity }) };
          if (source.stockBasis !== undefined) {
            const basis = await receiptLineStockBasis(tx, current, source);
            lines.push(procurementExact(() => pinProcurementStockBasis(line, basis.stockUnit)));
          } else lines.push(line);
        }
        sourceVersionId = version.id;
        currency = original.input.currency;
      } else {
        const order = await requirePurchaseOrder(tx, original.targetId);
        authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
        await readSupplier(tx, current, order.supplierId);
        const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(and(
          eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id), eq(inventoryPurchaseOrderVersions.versionNumber, original.input.expectedVersion),
        )).limit(1);
        if (!version) return null;
        sourceVersionId = version.id;
        currency = original.kind === "purchase_revise" ? original.input.currency : version.currency;
        lines = original.kind === "purchase_revise" ? original.input.lines : version.lineSnapshot;
        pinNewPurchase = original.kind === "purchase_revise";
      }
      const reviewed: ProcurementReviewBasis["lines"] = [];
      for (const line of canonicalLines(lines)) {
        const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, line.stockItemId)).limit(1);
        if (!stock) return null;
        authorize(current, Permission.InventoryRead, { ownerId: stock.createdBy });
        await readLocation(tx, current, line.destinationLocationId);
        const stockBasis = line.stockBasis ?? (pinNewPurchase ? procurementExact(() => pinProcurementStockBasis(line, ProcurementUnitSchema.parse(stock.baseUnit)).stockBasis) : null);
        reviewed.push({ lineKey: line.lineKey, stockItemId: line.stockItemId, quantity: line.quantity, unit: line.unit, stockBasis,
          unitCostMinor: line.unitCostMinor ?? null, priceBasisQuantity: line.unitCostMinor === undefined ? null : line.priceBasisQuantity ?? 1,
          lineTotalMinor: line.unitCostMinor === undefined ? null : procurementExact(() => procurementAmountMinor(line.quantity, line.unitCostMinor!, line.priceBasisQuantity ?? 1)),
        });
      }
      return { sourceVersionId, currency, lines: reviewed };
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  async readCommandResultInTransaction(tx: TenantTransaction, current: TenantContext, kind: ProcurementCommandKind, proofId: string): Promise<ProcurementCommandResult> {
    if (kind === "invoice_reconcile") {
      const event = await this.invoiceReconciliation.readEventInTransaction(tx, current, proofId);
      return { kind, id: event.id, versionId: null, version: null };
    }
    if (kind === "invoice_record") {
      const { invoice } = await requireInvoiceResult(tx, current, proofId);
      return { kind, id: invoice.id, versionId: null, version: null };
    }
    const [proof] = await tx.select().from(inventoryProcurementWriteRequests).where(eq(inventoryProcurementWriteRequests.id, proofId)).limit(1);
    if (!proof || proof.operation !== (kind === "supply_purchase_create" ? "purchase_create" : kind)) throw new NotFoundException("Actual procurement evidence not found");
    authorize(current, Permission.ProcurementRead, { ownerId: proof.createdBy });
    if (kind === "requisition_create") {
      const request = await requireRequisition(tx, proof.requisitionId!);
      authorize(current, Permission.ProcurementRead, { ownerId: request.createdBy });
      const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(and(eq(inventoryProcurementRequisitionVersions.requisitionId, request.id), eq(inventoryProcurementRequisitionVersions.versionNumber, 1))).limit(1);
      if (!version) throw new ConflictException("Original requisition version is missing");
      await readLineDimensions(tx, current, version.lineSnapshot);
      return { kind, id: request.id, versionId: version.id, version: version.versionNumber };
    }
    if (kind === "rfq_create" || kind === "quote_record") {
      const rfq = await requireRfq(tx, proof.rfqId!);
      authorize(current, Permission.ProcurementRead, { ownerId: rfq.createdBy });
      const request = await requireRequisition(tx, rfq.requisitionId);
      authorize(current, Permission.ProcurementRead, { ownerId: request.createdBy });
      const [version] = await tx.select().from(inventoryProcurementRequisitionVersions).where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
      if (!version) throw new ConflictException("RFQ requisition version is missing");
      await readLineDimensions(tx, current, version.lineSnapshot);
      if (kind === "rfq_create") return { kind, id: rfq.id, versionId: null, version: null };
      const [quote] = await tx.select().from(inventorySupplierQuoteVersions).where(eq(inventorySupplierQuoteVersions.id, proof.quoteId!)).limit(1);
      if (!quote) throw new NotFoundException("Actual supplier quote not found");
      authorize(current, Permission.ProcurementRead, { ownerId: quote.createdBy });
      await readSupplier(tx, current, quote.supplierId);
      return { kind, id: quote.id, versionId: quote.id, version: quote.versionNumber };
    }
    const order = await requirePurchaseOrder(tx, proof.purchaseOrderId!);
    authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
    await readSupplier(tx, current, order.supplierId);
    const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(eq(inventoryPurchaseOrderVersions.id, proof.purchaseOrderVersionId!)).limit(1);
    if (!version || version.purchaseOrderId !== order.id) throw new ConflictException("Original purchase version is missing");
    await readLineDimensions(tx, current, version.lineSnapshot);
    return { kind, id: order.id, versionId: version.id, version: version.versionNumber };
  }

  async readCommandInvoiceResultInTransaction(tx: TenantTransaction, context: TenantContext, proofId: string): Promise<ProcurementInvoiceView> {
    const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context));
    const { invoice } = await requireInvoiceResult(tx, current, proofId);
    return ProcurementInvoiceViewSchema.parse(await invoiceView(tx, invoice));
  }

  /** Read an actual invoice and its original handoff identities without preparing any command. */
  readInvoiceHandoff(context: TenantContext, rawInvoiceId: string): Promise<{
    contextAuthority: string; invoice: ProcurementInvoiceView; supplierId: string;
    proofId: string; purchaseOrderVersionId: string;
  }> {
    const invoiceId = EntityIdSchema.parse(rawInvoiceId).toLowerCase();
    return withTenant(this.database.db, context, async tx => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context));
      const [original] = await tx.select({ id: inventorySupplierInvoiceRequests.id }).from(inventorySupplierInvoiceRequests)
        .where(eq(inventorySupplierInvoiceRequests.invoiceId, invoiceId)).limit(1);
      if (!original) throw new NotFoundException("Actual invoice evidence not found");
      const { proof, invoice, version, order } = await requireInvoiceResult(tx, current, original.id);
      return { contextAuthority: catalogContextAuthority(current), invoice: ProcurementInvoiceViewSchema.parse(await invoiceView(tx, invoice)),
        supplierId: order.supplierId, proofId: proof.id, purchaseOrderVersionId: version.id };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async readCommandReconciliationResultInTransaction(tx: TenantTransaction, context: TenantContext, proofId: string): Promise<InvoiceReconciliationEvent> {
    return this.invoiceReconciliation.readEventInTransaction(tx, context, proofId);
  }

  analysisBasis(context: TenantContext, stockItemId: string, locationId: string) {
    return readProcurementAnalysis(this.database, context, stockItemId, locationId);
  }
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(InvoiceReconciliationService) reconciliation?: InvoiceReconciliationService,
  ) { this.invoiceReconciliation = reconciliation ?? new InvoiceReconciliationService(database, audit); }

  async createRequisition(context: TenantContext, rawInput: CreateProcurementRequisitionInput) {
    return withTenant(this.database.db, context, tx => this.createRequisitionInTransaction(tx, context, rawInput));
  }

  async createRequisitionInTransaction(tx: TenantTransaction, context: TenantContext, rawInput: CreateProcurementRequisitionInput) {
    const input = CreateProcurementRequisitionInputSchema.parse(rawInput);
      const current = await beginProcurementWrite(tx, context, Permission.ProcurementWrite, "requisition_create", input);
      await lock(tx, `procurement-requisition-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [existing] = await tx.select().from(inventoryProcurementRequisitions)
        .where(eq(inventoryProcurementRequisitions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        authorize(current, Permission.ProcurementWrite, { ownerId: existing.createdBy });
        await assertProcurementReplay(tx, current, "requisition_create", null, input, { requisitionId: existing.id });
        return requisitionView(tx, existing);
      }
      await validateRequestLines(tx, input.lines, current);
      const lines = canonicalLines(input.lines);
      const requisitionId = createEntityId();
      const [requisition] = await tx.insert(inventoryProcurementRequisitions).values({
        id: requisitionId,
        tenantId: context.tenantId,
        code: input.code,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      await tx.insert(inventoryProcurementRequisitionVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requisitionId,
        versionNumber: 1,
        reasonCode: input.reasonCode,
        lineSnapshot: lines,
        checksum: checksum({ reasonCode: input.reasonCode, lines }),
        createdBy: context.userId,
      });
      const result = await requisitionView(tx, requisition!);
      await bindProcurementWrite(tx, current, "requisition_create", null, input, { requisitionId: result.id });
      await this.audit.recordInTransaction(tx, current, {
      action: "procurement.requisition.create",
      resourceType: "inventory_procurement_requisition",
      resourceId: result.id,
      result: "success",
      metadata: { code: result.code, lineCount: result.lines.length },
      });
      return result;
  }

  async createRfq(
    context: TenantContext,
    requisitionId: string,
    rawInput: CreateProcurementRfqInput,
  ) {
    return withTenant(this.database.db, context, tx => this.createRfqInTransaction(tx, context, requisitionId, rawInput));
  }

  async createRfqInTransaction(tx: TenantTransaction, 
    context: TenantContext,
    requisitionId: string,
    rawInput: CreateProcurementRfqInput,
  ) {
    const input = CreateProcurementRfqInputSchema.parse(rawInput);
    requisitionId = requisitionId.toLowerCase();
      const current = await beginProcurementWrite(tx, context, Permission.ProcurementWrite, "rfq_create", input, requisitionId);
      await lock(tx, `procurement-rfq-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryProcurementRfqs)
        .where(eq(inventoryProcurementRfqs.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        authorize(current, Permission.ProcurementWrite, { ownerId: replayed.createdBy });
        await assertProcurementReplay(tx, current, "rfq_create", requisitionId, input, { rfqId: replayed.id });
        return rfqView(tx, replayed);
      }
      await lock(tx, `procurement-requisition:${context.tenantId}:${requisitionId}`);
      const requisition = await requireRequisition(tx, requisitionId);
      authorize(current, Permission.ProcurementWrite, { ownerId: requisition.createdBy });
      authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
      if (requisition.currentVersion !== input.expectedRequisitionVersion) {
        throw new ConflictException("Procurement requisition version changed");
      }
      if (requisition.status === "ordered" || requisition.status === "cancelled") {
        throw new ConflictException("Procurement requisition cannot be quoted in its current state");
      }
      await requireActiveSuppliers(tx, input.supplierIds, current);
      const [version] = await tx.select().from(inventoryProcurementRequisitionVersions)
        .where(and(
          eq(inventoryProcurementRequisitionVersions.requisitionId, requisitionId),
          eq(inventoryProcurementRequisitionVersions.versionNumber, requisition.currentVersion),
        )).limit(1);
      if (!version) throw new ConflictException("Procurement requisition version is missing");
      const [rfq] = await tx.insert(inventoryProcurementRfqs).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requisitionId,
        requisitionVersionId: version.id,
        supplierIds: [...input.supplierIds].sort(),
        responseDueAt: new Date(input.responseDueAt),
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      await tx.update(inventoryProcurementRequisitions).set({
        status: "rfq_open",
        updatedAt: new Date(),
      }).where(eq(inventoryProcurementRequisitions.id, requisitionId));
      const result = mapRfq(rfq!, input.expectedRequisitionVersion);
      await bindProcurementWrite(tx, current, "rfq_create", requisitionId, input, { requisitionId, rfqId: result.id });
      await this.audit.recordInTransaction(tx, current, {
      action: "procurement.rfq.create",
      resourceType: "inventory_procurement_rfq",
      resourceId: result.id,
      result: "success",
      metadata: { requisitionId, supplierCount: result.supplierIds.length },
      });
      return result;
  }

  async recordSupplierQuote(
    context: TenantContext,
    rfqId: string,
    rawInput: RecordProcurementSupplierQuoteInput,
  ) {
    return withTenant(this.database.db, context, tx => this.recordSupplierQuoteInTransaction(tx, context, rfqId, rawInput));
  }

  async recordSupplierQuoteInTransaction(tx: TenantTransaction, 
    context: TenantContext,
    rfqId: string,
    rawInput: RecordProcurementSupplierQuoteInput,
  ) {
    const input = RecordProcurementSupplierQuoteInputSchema.parse(rawInput);
    rfqId = rfqId.toLowerCase();
      const current = await beginProcurementWrite(tx, context, Permission.ProcurementWrite, "quote_record", input, rfqId);
      await lock(tx, `procurement-quote-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventorySupplierQuoteVersions)
        .where(eq(inventorySupplierQuoteVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        authorize(current, Permission.ProcurementWrite, { ownerId: replayed.createdBy });
        await assertProcurementReplay(tx, current, "quote_record", rfqId, input, { quoteId: replayed.id });
        return mapQuote(replayed);
      }
      await lock(tx, `procurement-quote-version:${context.tenantId}:${rfqId}:${input.supplierId.toLowerCase()}`);
      const rfq = await requireRfq(tx, rfqId);
      authorize(current, Permission.ProcurementWrite, { ownerId: rfq.createdBy });
      authorize(current, Permission.ProcurementRead, { ownerId: rfq.createdBy });
      const requestedBy = await requireRequisition(tx, rfq.requisitionId);
      authorize(current, Permission.ProcurementRead, { ownerId: requestedBy.createdBy });
      if (rfq.status !== "open") throw new ConflictException("Procurement RFQ is not open");
      if (!rfq.supplierIds.includes(input.supplierId)) {
        throw new ConflictException("Supplier was not invited to this RFQ");
      }
      await requireActiveSuppliers(tx, [input.supplierId], current);
      const [requestVersion] = await tx.select().from(inventoryProcurementRequisitionVersions)
        .where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
      if (!requestVersion) throw new ConflictException("RFQ requisition version is missing");
      const quoteByLine = new Map(input.lines.map((line) => [line.lineKey, line]));
      if (quoteByLine.size !== requestVersion.lineSnapshot.length) throw new ConflictException("Supplier quote line set does not match the RFQ");
      for (const line of requestVersion.lineSnapshot) {
        if (!quoteByLine.has(line.lineKey)) {
          throw new ConflictException(`Supplier quote is missing line ${line.lineKey}`);
        }
      }
      const [latest] = await tx.select({ versionNumber: inventorySupplierQuoteVersions.versionNumber })
        .from(inventorySupplierQuoteVersions)
        .where(and(
          eq(inventorySupplierQuoteVersions.rfqId, rfqId),
          eq(inventorySupplierQuoteVersions.supplierId, input.supplierId),
        )).orderBy(desc(inventorySupplierQuoteVersions.versionNumber)).limit(1);
      const lines = canonicalLines(input.lines).map(line => ({ ...line,
        unit: requestVersion.lineSnapshot.find(requested => requested.lineKey === line.lineKey)!.unit,
      }));
      const totalMinor = quoteTotal(requestVersion.lineSnapshot, input.lines);
      const [quote] = await tx.insert(inventorySupplierQuoteVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        rfqId,
        supplierId: input.supplierId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        currency: input.currency,
        validUntil: new Date(input.validUntil),
        lineSnapshot: lines,
        totalMinor,
        checksum: checksum({ currency: input.currency, validUntil: input.validUntil, lines }),
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      const result = mapQuote(quote!);
      await bindProcurementWrite(tx, current, "quote_record", rfqId, input, { requisitionId: rfq.requisitionId, rfqId, quoteId: result.id });
      await this.audit.recordInTransaction(tx, current, {
      action: "procurement.quote.record",
      resourceType: "inventory_supplier_quote",
      resourceId: result.id,
      result: "success",
      metadata: { rfqId, supplierId: result.supplierId, version: result.version },
      });
      return result;
  }

  async createPurchaseOrder(context: TenantContext, rawInput: CreateInventoryPurchaseOrderInput) {
    return withTenant(this.database.db, context, tx => this.persistPurchaseOrderInTransaction(tx, context, CreateInventoryPurchaseOrderInputSchema.parse(rawInput)));
  }

  async createPurchaseOrderFromSupply(context: TenantContext, linkId: string, raw: CreateSupplyPurchaseInput) {
    const input = CreateSupplyPurchaseInputSchema.parse(raw);
    return withTenant(this.database.db, context, tx => this.persistPurchaseOrderInTransaction(tx, context, undefined, { linkId: linkId.toLowerCase(), input }));
  }

  private async persistPurchaseOrderInTransaction(tx: TenantTransaction, context: TenantContext, regularInput?: CreateInventoryPurchaseOrderInput, source?: { linkId: string; input: CreateSupplyPurchaseInput }) {
    const key = source?.input.idempotencyKey ?? regularInput!.idempotencyKey;
    const sourceHash = source ? checksum(source) : null;
      const current = await beginProcurementWrite(tx, context, Permission.ProcurementWrite, "purchase_create", source ?? regularInput!, source?.linkId ?? null);
      await lock(tx, `procurement-order-idempotency:${context.tenantId}:${key}`);
      const [replayed] = await tx.select().from(inventoryPurchaseOrders)
        .where(eq(inventoryPurchaseOrders.idempotencyKey, key)).limit(1);
      if (replayed) {
        authorize(current, Permission.ProcurementWrite, { ownerId: replayed.createdBy });
        await assertProcurementReplay(tx, current, "purchase_create", source?.linkId ?? null, source ?? regularInput!, { purchaseOrderId: replayed.id });
        return purchaseOrderView(tx, replayed);
      }
      // Resolve and pin the quote inside the same tenant transaction as the draft.
      // Retries above return the original draft even if a newer quote now exists.
      const prepared = source ? await prepareSupplyPurchase(tx, source.linkId, source.input, current) : undefined;
      const input = prepared?.input ?? regularInput!;
      await requireActiveSuppliers(tx, [input.supplierId], current);
      await validatePurchaseLines(tx, input.lines, current);
      if (input.requisitionId) {
        await lock(tx, `procurement-requisition:${context.tenantId}:${input.requisitionId.toLowerCase()}`);
        const requisition = await requireRequisition(tx, input.requisitionId);
        authorize(current, Permission.ProcurementWrite, { ownerId: requisition.createdBy });
        authorize(current, Permission.ProcurementRead, { ownerId: requisition.createdBy });
        if (requisition.status === "cancelled") throw new ConflictException("Procurement requisition is cancelled");
      }
      await validateQuotedPurchase(tx, current, input);
      const orderId = createEntityId();
      const lines = await pinPurchaseLines(tx, canonicalLines(input.lines), current);
      const totalMinor = purchaseTotal(lines);
      const [order] = await tx.insert(inventoryPurchaseOrders).values({
        id: orderId,
        tenantId: context.tenantId,
        code: input.code,
        supplierId: input.supplierId,
        requisitionId: input.requisitionId,
        quoteId: input.quoteId,
        sourceSupplyVersionId: prepared?.versionId ?? null,
        sourceSupplyRequestHash: sourceHash,
        purpose: source?.input.purpose ?? "general",
        expectedAt: new Date(input.expectedAt),
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      const [version] = await tx.insert(inventoryPurchaseOrderVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        purchaseOrderId: orderId,
        versionNumber: 1,
        currency: input.currency,
        expectedAt: new Date(input.expectedAt),
        lineSnapshot: lines,
        totalMinor,
        checksum: checksum({ currency: input.currency, expectedAt: input.expectedAt, lines }),
        createdBy: context.userId,
      }).returning();
      const eventId = await insertOrderEvent(tx, current, orderId, {
        action: "created",
        fromStatus: null,
        toStatus: "draft",
        reasonCode: null,
        idempotencyKey: input.idempotencyKey,
      });
      if (input.requisitionId) {
        await tx.update(inventoryProcurementRequisitions).set({
          status: "ordered",
          updatedAt: new Date(),
        }).where(eq(inventoryProcurementRequisitions.id, input.requisitionId));
      }
      const result = await purchaseOrderView(tx, order!);
      await bindProcurementWrite(tx, current, "purchase_create", source?.linkId ?? null, source ?? regularInput!, {
        purchaseOrderId: result.id, purchaseOrderVersionId: version!.id, purchaseOrderEventId: eventId,
      });
      await this.audit.recordInTransaction(tx, current, {
      action: "procurement.purchase_order.create",
      resourceType: "inventory_purchase_order",
      resourceId: result.id,
      result: "success",
      metadata: { code: result.code, supplierId: result.supplierId, totalMinor: result.totalMinor },
      });
      return result;
  }

  async revisePurchaseOrder(
    context: TenantContext,
    purchaseOrderId: string,
    rawInput: ReviseInventoryPurchaseOrderInput,
  ) {
    return withTenant(this.database.db, context, tx => this.revisePurchaseOrderInTransaction(tx, context, purchaseOrderId, rawInput));
  }

  async revisePurchaseOrderInTransaction(tx: TenantTransaction, 
    context: TenantContext,
    purchaseOrderId: string,
    rawInput: ReviseInventoryPurchaseOrderInput,
  ) {
    const input = ReviseInventoryPurchaseOrderInputSchema.parse(rawInput);
    purchaseOrderId = purchaseOrderId.toLowerCase();
      const current = await beginProcurementWrite(tx, context, Permission.ProcurementWrite, "purchase_revise", input, purchaseOrderId);
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      authorize(current, Permission.ProcurementWrite, { ownerId: order.createdBy });
      authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
      const replayed = await findOrderEvent(tx, purchaseOrderId, input.idempotencyKey);
      if (replayed) {
        await assertProcurementReplay(tx, current, "purchase_revise", purchaseOrderId, input, { purchaseOrderId, purchaseOrderEventId: replayed.id });
        return purchaseOrderView(tx, order);
      }
      if (!["draft", "rejected"].includes(order.status)) {
        throw new ConflictException("Purchase order cannot be revised in its current state");
      }
      if (order.currentVersion !== input.expectedVersion) {
        throw new ConflictException("Purchase order version changed");
      }
      await validatePurchaseLines(tx, input.lines, current);
      await validateQuotedPurchase(tx, current, { ...input, supplierId: order.supplierId, requisitionId: order.requisitionId, quoteId: order.quoteId });
      const lines = await pinPurchaseLines(tx, canonicalLines(input.lines), current);
      const nextVersion = order.currentVersion + 1;
      const [version] = await tx.insert(inventoryPurchaseOrderVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        purchaseOrderId,
        versionNumber: nextVersion,
        currency: input.currency,
        expectedAt: new Date(input.expectedAt),
        lineSnapshot: lines,
        totalMinor: purchaseTotal(lines),
        checksum: checksum({ currency: input.currency, expectedAt: input.expectedAt, lines }),
        createdBy: context.userId,
      }).returning();
      const [updated] = await tx.update(inventoryPurchaseOrders).set({
        status: "draft",
        currentVersion: nextVersion,
        expectedAt: new Date(input.expectedAt),
        updatedAt: new Date(),
      }).where(and(
        eq(inventoryPurchaseOrders.id, purchaseOrderId),
        eq(inventoryPurchaseOrders.currentVersion, input.expectedVersion),
      )).returning();
      if (!updated) throw new ConflictException("Purchase order version changed");
      const eventId = await insertOrderEvent(tx, current, purchaseOrderId, {
        action: "revised",
        fromStatus: order.status,
        toStatus: "draft",
        reasonCode: "VERSION_REVISED",
        idempotencyKey: input.idempotencyKey,
      });
      const result = await purchaseOrderView(tx, updated);
      await bindProcurementWrite(tx, current, "purchase_revise", purchaseOrderId, input, {
        purchaseOrderId, purchaseOrderVersionId: version!.id, purchaseOrderEventId: eventId,
      });
      await this.audit.recordInTransaction(tx, current, {
      action: "procurement.purchase_order.revise",
      resourceType: "inventory_purchase_order",
      resourceId: result.id,
      result: "success",
      metadata: { version: result.currentVersion },
      });
      return result;
  }

  async reviewPurchaseOrder(
    context: TenantContext,
    purchaseOrderId: string,
    rawInput: ReviewInventoryPurchaseOrderInput,
  ) {
    return withTenant(this.database.db, context, tx => this.reviewPurchaseOrderInTransaction(tx, context, purchaseOrderId, rawInput));
  }

  async reviewPurchaseOrderInTransaction(tx: TenantTransaction, 
    context: TenantContext,
    purchaseOrderId: string,
    rawInput: ReviewInventoryPurchaseOrderInput,
  ) {
    const input = ReviewInventoryPurchaseOrderInputSchema.parse(rawInput);
    purchaseOrderId = purchaseOrderId.toLowerCase();
      const current = await beginProcurementWrite(tx, context, Permission.ProcurementApprove, "purchase_review", input, purchaseOrderId);
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      authorize(current, Permission.ProcurementApprove, { ownerId: order.createdBy });
      authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
      const replayed = await findOrderEvent(tx, purchaseOrderId, input.idempotencyKey);
      if (replayed) {
        await assertProcurementReplay(tx, current, "purchase_review", purchaseOrderId, input, { purchaseOrderId, purchaseOrderEventId: replayed.id });
        return purchaseOrderView(tx, order);
      }
      if (!["draft", "rejected"].includes(order.status)) {
        throw new ConflictException("Purchase order cannot be reviewed in its current state");
      }
      if (order.currentVersion !== input.expectedVersion) {
        throw new ConflictException("Purchase order version changed");
      }
      const version = await requirePurchaseOrderVersion(tx, order);
      if (input.decision === "approved") await validateQuotedPurchase(tx, current, { supplierId: order.supplierId, requisitionId: order.requisitionId,
        quoteId: order.quoteId, currency: version.currency, lines: version.lineSnapshot });
      const [updated] = await tx.update(inventoryPurchaseOrders).set({
        status: input.decision,
        updatedAt: new Date(),
      }).where(and(
        eq(inventoryPurchaseOrders.id, purchaseOrderId),
        eq(inventoryPurchaseOrders.currentVersion, input.expectedVersion),
      )).returning();
      if (!updated) throw new ConflictException("Purchase order version changed");
      const eventId = await insertOrderEvent(tx, current, purchaseOrderId, {
        action: input.decision,
        fromStatus: order.status,
        toStatus: input.decision,
        reasonCode: input.reasonCode,
        idempotencyKey: input.idempotencyKey,
      });
      const result = await purchaseOrderView(tx, updated);
      await bindProcurementWrite(tx, current, "purchase_review", purchaseOrderId, input, {
        purchaseOrderId, purchaseOrderVersionId: version.id, purchaseOrderEventId: eventId,
      });
      await this.audit.recordInTransaction(tx, current, {
      action: `procurement.purchase_order.${input.decision}`,
      resourceType: "inventory_purchase_order",
      resourceId: result.id,
      result: "success",
      metadata: { version: result.currentVersion, reasonCode: input.reasonCode },
      });
      return result;
  }

  async recordReceipt(context: TenantContext, purchaseOrderId: string, rawInput: RecordProcurementReceiptInput) {
    return withTenant(this.database.db, context, tx => this.recordReceiptInTransaction(tx, context, purchaseOrderId, rawInput));
  }

  /** Internal owner transaction. The deferred SQL constraint requires a matching
   * actual incoming posting; passing an internal ID alone cannot commit stock. */
  async recordReceiptInTransaction(tx: TenantTransaction, context: TenantContext, purchaseOrderId: string, rawInput: RecordProcurementReceiptInput, incomingPostingId?: string) {
    purchaseOrderId = purchaseOrderId.toLowerCase();
    const input = RecordProcurementReceiptInputSchema.parse(rawInput);
    const requestChecksum = createHash("sha256").update(canonicalJson({ version: 1, purchaseOrderId, input: {
      ...input, receivedAt: new Date(input.receivedAt).toISOString(), lines: input.lines.map(line => ({ ...line, expiresAt: line.expiresAt ? new Date(line.expiresAt).toISOString() : null })),
    } })).digest("hex");
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      authorize(current, Permission.ProcurementWrite);
      await lock(tx, `procurement-receipt-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryProcurementReceipts)
        .where(eq(inventoryProcurementReceipts.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const originalOrder = await requirePurchaseOrder(tx, replayed.purchaseOrderId);
        authorize(current, Permission.ProcurementWrite, { ownerId: originalOrder.createdBy });
        const [original] = await tx.select().from(inventoryProcurementReceiptRequests).where(eq(inventoryProcurementReceiptRequests.receiptId, replayed.id)).limit(1);
        if (!original) throw new ConflictException({ code: "receipt_input_unavailable", message: "旧收货缺少原提交依据，请先核对原收货记录，不可自动重放" });
        if (original.evidenceVersion !== 1 || original.purchaseOrderId !== purchaseOrderId || original.createdBy !== current.userId || original.requestChecksum !== requestChecksum)
          throw new ConflictException({ code: "receipt_request_mismatch", message: "收货请求与原提交不一致，请核对原采购单、填写和操作者" });
        return {
          receipt: await receiptView(tx, replayed),
          purchaseOrder: await purchaseOrderView(
            tx,
            originalOrder,
          ),
        };
      }
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      authorize(current, Permission.ProcurementWrite, { ownerId: order.createdBy });
      if (!incomingPostingId) {
        const [arrival] = await tx.select({ id: procurementArrivals.id }).from(procurementArrivals).where(eq(procurementArrivals.purchaseOrderId, purchaseOrderId)).limit(1);
        if (order.receivingPolicy === "inspection_required" || arrival) throw new ConflictException({ code: "incoming_inspection_required", message: "请先登记实际到货并完成来料检验核准 再从原到货记录确认入库" });
      }
      if (!["approved", "partially_received", "reconciliation_required"].includes(order.status)) {
        throw new ConflictException("Purchase order is not approved for receipt");
      }
      if (order.currentVersion !== input.expectedVersion) {
        throw new ConflictException("Purchase order version changed");
      }
      const version = await requirePurchaseOrderVersion(tx, order);
      const orderLines = new Map(version.lineSnapshot.map((line) => [line.lineKey, line]));
      const previous = await receiptTotals(tx, purchaseOrderId);
      const stockReceipts = new Map<string, { basis: ProcurementStockBasis; received: StockQuantity; rejected: StockQuantity }>();
      let hasVariance = false;
      for (const line of input.lines) {
        const ordered = orderLines.get(line.lineKey);
        if (!ordered) throw new ConflictException(`Purchase order line ${line.lineKey} was not found`);
        const total = previous.get(line.lineKey) ?? { received: 0, rejected: 0 };
        if (compareStockQuantity(sumStockQuantities([total.received, total.rejected, line.receivedQuantity, line.rejectedQuantity]), ordered.quantity) > 0) {
          hasVariance = true;
        }
        if (!stockQuantityMatchesUnit(line.receivedQuantity, ordered.unit) || !stockQuantityMatchesUnit(line.rejectedQuantity, ordered.unit)) throw new ConflictException("Receipt quantities do not match their original unit");
        const basis = await receiptLineStockBasis(tx, current, ordered);
        stockReceipts.set(line.lineKey, { basis,
          received: procurementExact(() => convertProcurementQuantity(line.receivedQuantity, ordered.unit, basis.stockUnit)),
          rejected: procurementExact(() => convertProcurementQuantity(line.rejectedQuantity, ordered.unit, basis.stockUnit)),
        });
        if (compareStockQuantity(line.rejectedQuantity, 0) > 0) hasVariance = true;
      }
      const receiptId = createEntityId();
      const [receipt] = await tx.insert(inventoryProcurementReceipts).values({
        id: receiptId,
        tenantId: context.tenantId,
        purchaseOrderId,
        purchaseOrderVersionId: version.id,
        receivedAt: new Date(input.receivedAt),
        externalReference: input.externalReference,
        hasVariance,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      for (const line of input.lines) {
        const ordered = orderLines.get(line.lineKey)!;
        const converted = stockReceipts.get(line.lineKey)!;
        let lotId: string | null = null;
        let movementId: string | null = null;
        if (compareStockQuantity(line.receivedQuantity, 0) > 0) {
          const stock = await this.inventory.receiveProcurementStock(tx, current, {
            receiptId,
            stockItemId: ordered.stockItemId,
            locationId: ordered.destinationLocationId,
            lotCode: line.lotCode!,
            quantity: converted.received,
            unit: converted.basis.stockUnit,
            unitCostMinor: ordered.unitCostMinor,
            unitCostQuantity: converted.basis.priceBasisStockQuantity,
            currency: version.currency,
            receivedAt: input.receivedAt,
            expiresAt: line.expiresAt,
            idempotencyKey: childKey(input.idempotencyKey, line.lineKey),
          });
          lotId = stock.lot.id;
          movementId = stock.movement.id;
        }
        await tx.insert(inventoryProcurementReceiptLines).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          receiptId,
          lineKey: line.lineKey,
          stockItemId: ordered.stockItemId,
          destinationLocationId: ordered.destinationLocationId,
          receivedQuantity: line.receivedQuantity,
          rejectedQuantity: line.rejectedQuantity,
          rejectionReasonCode: line.rejectionReasonCode,
          unit: ordered.unit,
          unitCostMinor: ordered.unitCostMinor,
          priceBasisQuantity: ordered.priceBasisQuantity ?? 1,
          stockUnit: converted.basis.stockUnit,
          stockReceivedQuantity: converted.received,
          stockRejectedQuantity: converted.rejected,
          lotId,
          movementId,
        });
      }
      const totals = await receiptTotals(tx, purchaseOrderId);
      const complete = version.lineSnapshot.every((line) => {
        const total = totals.get(line.lineKey);
        return total && compareStockQuantity(total.received, line.quantity) === 0 && compareStockQuantity(total.rejected, 0) === 0;
      });
      const status = hasVariance ? "reconciliation_required" : complete ? "received" : "partially_received";
      const [updated] = await tx.update(inventoryPurchaseOrders).set({
        status,
        updatedAt: new Date(),
      }).where(eq(inventoryPurchaseOrders.id, purchaseOrderId)).returning();
      await insertOrderEvent(tx, context, purchaseOrderId, {
        action: status,
        fromStatus: order.status,
        toStatus: status,
        reasonCode: hasVariance ? "RECEIPT_VARIANCE" : null,
        idempotencyKey: input.idempotencyKey,
      });
      await tx.insert(inventoryProcurementReceiptRequests).values({ id: createEntityId(), tenantId: context.tenantId, receiptId,
        purchaseOrderId, purchaseOrderVersionId: version.id, createdBy: current.userId, evidenceVersion: 1, requestChecksum, idempotencyKey: input.idempotencyKey });
      await this.audit.recordInTransaction(tx, current, { action: "procurement.receipt.record", resourceType: "inventory_procurement_receipt",
        resourceId: receiptId, result: "success", metadata: { purchaseOrderId, hasVariance, lineCount: input.lines.length } });
      return {
        receipt: await receiptView(tx, receipt!),
        purchaseOrder: await purchaseOrderView(tx, updated!),
      };
  }

  async recordInvoice(
    context: TenantContext,
    purchaseOrderId: string,
    rawInput: RecordProcurementInvoiceInput,
  ) {
    const input = RecordProcurementInvoiceInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, tx => this.recordInvoiceInTransaction(tx, context, purchaseOrderId, input));
  }

  /** This owner is shared by raw recording and the retained invoice command. */
  async recordInvoiceInTransaction(tx: TenantTransaction, context: TenantContext, purchaseOrderId: string, rawInput: RecordProcurementInvoiceInput) {
    purchaseOrderId = purchaseOrderId.toLowerCase();
    const input = RecordProcurementInvoiceInputSchema.parse(rawInput);
      const current = await beginInvoiceWrite(tx, context, purchaseOrderId, input);
      await lock(tx, `procurement-invoice-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventorySupplierInvoices)
        .where(eq(inventorySupplierInvoices.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const originalOrder = await requirePurchaseOrder(tx, replayed.purchaseOrderId);
        authorize(current, Permission.ProcurementWrite, { ownerId: originalOrder.createdBy });
        authorize(current, Permission.ProcurementRead, { ownerId: originalOrder.createdBy });
        await assertInvoiceReplay(tx, current, replayed.id, purchaseOrderId, input);
        return invoiceView(tx, replayed);
      }
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      authorize(current, Permission.ProcurementWrite, { ownerId: order.createdBy });
      authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
      if (input.expectedVersion !== undefined && order.currentVersion !== input.expectedVersion) throw new ConflictException("Purchase order version changed");
      const version = await requirePurchaseOrderVersion(tx, order);
      const plan = await planInvoice(tx, current, order, version, input, true);
      const allocationValues: Array<typeof inventorySupplierInvoiceAllocations.$inferInsert> = [];
      const invoiceId = createEntityId();
      const lineValues: Array<typeof inventorySupplierInvoiceLines.$inferInsert> = plan.lines.map(({ allocations, ...line }) => {
        const lineId = createEntityId();
        for (const allocation of allocations) allocationValues.push({ id: createEntityId(), tenantId: current.tenantId,
          invoiceLineId: lineId, ...allocation, createdBy: current.userId });
        return { id: lineId, tenantId: current.tenantId, invoiceId, ...line };
      });
      const [invoice] = await tx.insert(inventorySupplierInvoices).values({
        id: invoiceId,
        tenantId: context.tenantId,
        purchaseOrderId,
        invoiceNumber: input.invoiceNumber,
        currency: input.currency,
        totalMinor: plan.totalMinor,
        varianceMinor: plan.varianceMinor,
        status: plan.status,
        allocationStatus: plan.allocationStatus,
        issuedAt: new Date(input.issuedAt),
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      await tx.insert(inventorySupplierInvoiceLines).values(lineValues);
      if (allocationValues.length) await tx.insert(inventorySupplierInvoiceAllocations).values(allocationValues);
      await bindInvoiceRequest(tx, current, invoiceId, purchaseOrderId, version.id, input);
      if (plan.mismatch && order.status !== "reconciliation_required") {
        await tx.update(inventoryPurchaseOrders).set({
          status: "reconciliation_required",
          updatedAt: new Date(),
        }).where(eq(inventoryPurchaseOrders.id, purchaseOrderId));
        await insertOrderEvent(tx, current, purchaseOrderId, {
          action: "reconciliation_required",
          fromStatus: order.status,
          toStatus: "reconciliation_required",
          reasonCode: "INVOICE_VARIANCE",
          idempotencyKey: input.idempotencyKey,
        });
      }
      const result = mapInvoice(invoice!, lineValues, version.currency);
      await this.audit.recordInTransaction(tx, current, {
      action: "procurement.invoice.record",
      resourceType: "inventory_supplier_invoice",
      resourceId: result.id,
      result: "success",
      metadata: { purchaseOrderId, status: result.status, varianceMinor: result.varianceMinor, legacyUnknown: plan.legacyUnknown, sameCurrency: plan.sameCurrency },
      });
      return result;
  }

  async upsertReplenishmentPolicy(context: TenantContext, rawInput: UpsertReplenishmentPolicyInput) {
    const input = UpsertReplenishmentPolicyInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      authorize(current, Permission.ProcurementWrite);
      await lock(tx, `replenishment-policy:${context.tenantId}:${input.stockItemId}:${input.locationId}`);
      const [replayed] = await tx.select().from(inventoryReplenishmentPolicyVersions)
        .where(eq(inventoryReplenishmentPolicyVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const [policy] = await tx.select().from(inventoryReplenishmentPolicies)
          .where(eq(inventoryReplenishmentPolicies.id, replayed.policyId)).limit(1);
        return mapPolicy(policy!, replayed);
      }
      const stock = await validateDimension(tx, input.stockItemId, input.locationId, current);
      for (const quantity of [input.reorderPoint, input.safetyStock, input.minimumOrderQuantity])
        procurementExact(() => assertProcurementQuantityUnit(quantity, ProcurementUnitSchema.parse(stock.baseUnit)));
      const [existing] = await tx.select().from(inventoryReplenishmentPolicies)
        .where(and(
          eq(inventoryReplenishmentPolicies.stockItemId, input.stockItemId),
          eq(inventoryReplenishmentPolicies.locationId, input.locationId),
        )).limit(1);
      const versionNumber = (existing?.currentVersion ?? 0) + 1;
      const policy = existing ?? (await tx.insert(inventoryReplenishmentPolicies).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        stockItemId: input.stockItemId,
        locationId: input.locationId,
        createdBy: context.userId,
      }).returning())[0]!;
      const [version] = await tx.insert(inventoryReplenishmentPolicyVersions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        policyId: policy.id,
        versionNumber,
        reorderPoint: input.reorderPoint,
        safetyStock: input.safetyStock,
        minimumOrderQuantity: input.minimumOrderQuantity,
        leadTimeDays: input.leadTimeDays,
        serviceLevelBps: input.serviceLevelBps,
        reviewIntervalDays: input.reviewIntervalDays,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      const [updated] = existing
        ? await tx.update(inventoryReplenishmentPolicies).set({
            currentVersion: versionNumber,
            updatedAt: new Date(),
          }).where(eq(inventoryReplenishmentPolicies.id, policy.id)).returning()
        : [policy];
      return mapPolicy(updated!, version!);
    });
    await this.audit.record(context, {
      action: "procurement.replenishment_policy.version",
      resourceType: "inventory_replenishment_policy",
      resourceId: result.id,
      result: "success",
      metadata: { version: result.currentVersion, stockItemId: result.stockItemId },
    });
    return result;
  }

  async createReplenishmentSuggestion(
    context: TenantContext,
    policyId: string,
    rawInput: CreateReplenishmentSuggestionInput,
  ) {
    const input = CreateReplenishmentSuggestionInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      authorize(current, Permission.ProcurementWrite);
      await lock(tx, `replenishment-suggestion:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryReplenishmentSuggestions)
        .where(eq(inventoryReplenishmentSuggestions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const [replayedVersion] = await tx.select().from(inventoryReplenishmentPolicyVersions)
          .where(eq(inventoryReplenishmentPolicyVersions.id, replayed.policyVersionId)).limit(1);
        if (!replayedVersion) throw new ConflictException("Replenishment suggestion policy version is missing");
        return mapSuggestion(replayed, replayedVersion.versionNumber);
      }
      const [policy] = await tx.select().from(inventoryReplenishmentPolicies)
        .where(eq(inventoryReplenishmentPolicies.id, policyId)).limit(1);
      if (!policy) throw new NotFoundException("Replenishment policy not found");
      authorize(current, Permission.ProcurementWrite, { ownerId: policy.createdBy });
      await validateDimension(tx, policy.stockItemId, policy.locationId, current);
      if (policy.status !== "active") throw new ConflictException("Replenishment policy is inactive");
      const [version] = await tx.select().from(inventoryReplenishmentPolicyVersions)
        .where(and(
          eq(inventoryReplenishmentPolicyVersions.policyId, policyId),
          eq(inventoryReplenishmentPolicyVersions.versionNumber, policy.currentVersion),
        )).limit(1);
      if (!version) throw new ConflictException("Replenishment policy version is missing");
      const balances = await tx.select().from(inventoryBalances)
        .where(and(
          eq(inventoryBalances.stockItemId, policy.stockItemId),
          eq(inventoryBalances.locationId, policy.locationId),
        ));
      const physical = sumStockQuantities(balances.map(balance => balance.physicalQuantity));
      const reserved = sumStockQuantities(balances.map(balance => balance.reservedQuantity));
      const inTransit = sumStockQuantities(balances.map(balance => balance.inTransitQuantity));
      const available = subtractStockQuantity(physical, reserved);
      const position = addStockQuantity(available, inTransit);
      const target = addStockQuantity(version.reorderPoint, version.safetyStock);
      const missing = subtractStockQuantity(target, position);
      const coverage = compareStockQuantity(missing, version.minimumOrderQuantity) < 0 ? version.minimumOrderQuantity : missing;
      const suggestedQuantity = compareStockQuantity(position, version.reorderPoint) <= 0 ? coverage : 0;
      if (!stockQuantityWithinCommandLimit(suggestedQuantity)) {
        throw new ConflictException("Replenishment suggestion exceeds the supported purchase quantity");
      }
      const [suggestion] = await tx.insert(inventoryReplenishmentSuggestions).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        policyId,
        policyVersionId: version.id,
        stockItemId: policy.stockItemId,
        locationId: policy.locationId,
        availableQuantity: available,
        inTransitQuantity: inTransit,
        suggestedQuantity,
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      return mapSuggestion(suggestion!, version.versionNumber);
    });
    await this.audit.record(context, {
      action: "procurement.replenishment_suggestion.create",
      resourceType: "inventory_replenishment_suggestion",
      resourceId: result.id,
      result: "success",
      metadata: { policyId, suggestedQuantity: result.suggestedQuantity },
    });
    return result;
  }

  async archivePurchaseOrder(context: TenantContext, id: string, raw: unknown) {
    authorize(context, Permission.ProcurementWrite);
    const input = ArchiveRecordInputSchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      const [row] = await tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, id)).for("update");
      if (!row) throw new NotFoundException("记录不存在");

      if (Boolean(row.archivedAt) === input.archived) return { id, archived: input.archived };
      await tx.update(inventoryPurchaseOrders).set({ archivedAt: input.archived ? new Date() : null }).where(eq(inventoryPurchaseOrders.id, id));
      await this.audit.recordInTransaction(tx, context, { action: "inventory_purchase_order.archive", resourceType: "inventory_purchase_order", resourceId: id, result: "success", metadata: input });
      return { id, archived: input.archived };
    });
  }

  workspace(context: TenantContext, includeArchived = false) {
    return withTenant(this.database.db, context, async (tx) => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      authorize(current, Permission.ProcurementRead);
      const purchaseVisibility = and(includeArchived ? undefined : sql`${inventoryPurchaseOrders.archivedAt} is null`,
        procurementReadScope(current, Permission.ProcurementRead, inventoryPurchaseOrders.createdBy));
      const visibleRequisition = includeArchived ? undefined : sql`not (
        ${inventoryProcurementRequisitions.status} = 'ordered'
        and exists (select 1 from inventory_purchase_orders p where p.requisition_id = ${inventoryProcurementRequisitions.id})
        and not exists (select 1 from inventory_purchase_orders p where p.requisition_id = ${inventoryProcurementRequisitions.id} and p.archived_at is null)
      )`;
      const visibleRequisitionIds = tx.select({ id: inventoryProcurementRequisitions.id }).from(inventoryProcurementRequisitions).where(visibleRequisition);
      const visibleRfqIds = tx.select({ id: inventoryProcurementRfqs.id }).from(inventoryProcurementRfqs).where(inArray(inventoryProcurementRfqs.requisitionId, visibleRequisitionIds));
      const visiblePolicy = includeArchived ? undefined : and(eq(inventoryReplenishmentPolicies.status, "active"),
        inArray(inventoryReplenishmentPolicies.stockItemId, tx.select({ id: inventoryStockItems.id }).from(inventoryStockItems).where(eq(inventoryStockItems.status, "active"))),
        inArray(inventoryReplenishmentPolicies.locationId, tx.select({ id: inventoryLocations.id }).from(inventoryLocations).where(eq(inventoryLocations.status, "active"))));
      const suppliers = await tx.select().from(fulfillmentSuppliers)
        .where(procurementReadScope(current, Permission.ProcurementRead, fulfillmentSuppliers.createdBy))
        .orderBy(asc(fulfillmentSuppliers.name));
      const stockItems = await tx.select().from(inventoryStockItems)
        .where(procurementReadScope(current, Permission.InventoryRead, inventoryStockItems.createdBy))
        .orderBy(asc(inventoryStockItems.name));
      const locations = await tx.select().from(inventoryLocations)
        .where(procurementReadScope(current, Permission.InventoryRead, inventoryLocations.createdBy))
        .orderBy(asc(inventoryLocations.name));
      const requisitions = await tx.select().from(inventoryProcurementRequisitions)
        .where(and(visibleRequisition, procurementReadScope(current, Permission.ProcurementRead, inventoryProcurementRequisitions.createdBy)))
        .orderBy(desc(inventoryProcurementRequisitions.updatedAt)).limit(100);
      const rfqs = await tx.select().from(inventoryProcurementRfqs)
        .where(and(inArray(inventoryProcurementRfqs.requisitionId, visibleRequisitionIds), procurementReadScope(current, Permission.ProcurementRead, inventoryProcurementRfqs.createdBy)))
        .orderBy(desc(inventoryProcurementRfqs.createdAt)).limit(100);
      const requisitionVersions = await tx.select().from(inventoryProcurementRequisitionVersions).where(or(
        inArray(inventoryProcurementRequisitionVersions.requisitionId, requisitions.map(row => row.id)),
        inArray(inventoryProcurementRequisitionVersions.id, rfqs.map(row => row.requisitionVersionId)),
      ));
      const quotes = await tx.select().from(inventorySupplierQuoteVersions)
        .where(and(inArray(inventorySupplierQuoteVersions.rfqId, visibleRfqIds), procurementReadScope(current, Permission.ProcurementRead, inventorySupplierQuoteVersions.createdBy)))
        .orderBy(desc(inventorySupplierQuoteVersions.createdAt)).limit(100);
      const orders = await tx.select().from(inventoryPurchaseOrders).where(purchaseVisibility)
        .orderBy(desc(inventoryPurchaseOrders.updatedAt)).limit(100);
      const receipts = await tx.select().from(inventoryProcurementReceipts)
        .where(inArray(inventoryProcurementReceipts.purchaseOrderId, tx.select({ id: inventoryPurchaseOrders.id }).from(inventoryPurchaseOrders).where(purchaseVisibility)))
        .orderBy(desc(inventoryProcurementReceipts.receivedAt)).limit(100);
      const orderVersions = await tx.select().from(inventoryPurchaseOrderVersions).where(or(
        inArray(inventoryPurchaseOrderVersions.purchaseOrderId, orders.map(row => row.id)),
        inArray(inventoryPurchaseOrderVersions.id, receipts.map(row => row.purchaseOrderVersionId)),
      ));
      const receiptLines = await tx.select().from(inventoryProcurementReceiptLines).where(inArray(inventoryProcurementReceiptLines.receiptId, receipts.map(row => row.id)));
      const invoices = await tx.select().from(inventorySupplierInvoices)
        .where(inArray(inventorySupplierInvoices.purchaseOrderId, tx.select({ id: inventoryPurchaseOrders.id }).from(inventoryPurchaseOrders).where(purchaseVisibility)))
        .orderBy(desc(inventorySupplierInvoices.issuedAt)).limit(100);
      const invoiceLines = invoices.length ? await tx.select().from(inventorySupplierInvoiceLines)
        .where(inArray(inventorySupplierInvoiceLines.invoiceId, invoices.map(row => row.id))).orderBy(asc(inventorySupplierInvoiceLines.lineKey)) : [];
      const invoiceBases = invoices.length ? await tx.select({ invoiceId: inventorySupplierInvoiceRequests.invoiceId, currency: inventoryPurchaseOrderVersions.currency })
        .from(inventorySupplierInvoiceRequests).innerJoin(inventoryPurchaseOrderVersions, eq(inventoryPurchaseOrderVersions.id, inventorySupplierInvoiceRequests.purchaseOrderVersionId))
        .where(inArray(inventorySupplierInvoiceRequests.invoiceId, invoices.map(row => row.id))) : [];
      const policies = await tx.select().from(inventoryReplenishmentPolicies)
        .where(and(visiblePolicy, procurementReadScope(current, Permission.ProcurementRead, inventoryReplenishmentPolicies.createdBy)))
        .orderBy(desc(inventoryReplenishmentPolicies.updatedAt)).limit(100);
      const suggestions = await tx.select().from(inventoryReplenishmentSuggestions)
        .where(inArray(inventoryReplenishmentSuggestions.policyVersionId, tx.select({ id: inventoryReplenishmentPolicyVersions.id }).from(inventoryReplenishmentPolicyVersions)
          .innerJoin(inventoryReplenishmentPolicies, eq(inventoryReplenishmentPolicies.id, inventoryReplenishmentPolicyVersions.policyId))
          .where(and(visiblePolicy, procurementReadScope(current, Permission.ProcurementRead, inventoryReplenishmentPolicies.createdBy)))))
        .orderBy(desc(inventoryReplenishmentSuggestions.createdAt)).limit(100);
      const policyVersions = await tx.select().from(inventoryReplenishmentPolicyVersions).where(or(
        inArray(inventoryReplenishmentPolicyVersions.policyId, policies.map(row => row.id)),
        inArray(inventoryReplenishmentPolicyVersions.id, suggestions.map(row => row.policyVersionId)),
      ));
      return {
        suppliers: suppliers.map((supplier) => ({
          id: supplier.id,
          name: supplier.name,
          kind: supplier.kind,
          regionCode: supplier.regionCode,
          settlementCurrency: supplier.settlementCurrency,
          status: supplier.status,
        })),
        stockItems: stockItems.map((stockItem) => ({
          id: stockItem.id,
          code: stockItem.code,
          name: stockItem.name,
          baseUnit: stockItem.baseUnit,
          status: stockItem.status,
        })),
        locations: locations.map((location) => ({
          id: location.id,
          code: location.code,
          name: location.name,
          status: location.status,
        })),
        requisitions: requisitions.map((row) => {
          const version = requisitionVersions.find((candidate) =>
            candidate.requisitionId === row.id && candidate.versionNumber === row.currentVersion);
          if (!version) throw new ConflictException("Procurement requisition version is missing");
          return mapRequisition(row, version);
        }),
        rfqs: rfqs.map((rfq) => {
          const version = requisitionVersions.find((candidate) => candidate.id === rfq.requisitionVersionId);
          if (!version) throw new ConflictException("RFQ requisition version is missing");
          return mapRfq(rfq, version.versionNumber);
        }),
        quotes: quotes.map(mapQuote),
        purchaseOrders: orders.map((row) => {
          const version = orderVersions.find((candidate) =>
            candidate.purchaseOrderId === row.id && candidate.versionNumber === row.currentVersion);
          if (!version) throw new ConflictException("Purchase order version is missing");
          return mapPurchaseOrder(row, version);
        }),
        receipts: receipts.map((receipt) => {
          const version = orderVersions.find((candidate) => candidate.id === receipt.purchaseOrderVersionId);
          if (!version) throw new ConflictException("Receipt purchase order version is missing");
          return mapReceipt(
            receipt,
            receiptLines.filter((line) => line.receiptId === receipt.id),
            version.versionNumber,
          );
        }),
        invoices: invoices.map(invoice => mapInvoice(invoice, invoiceLines.filter(line => line.invoiceId === invoice.id), invoiceBases.find(basis => basis.invoiceId === invoice.id)?.currency ?? null)),
        policies: policies.map((policy) => {
          const version = policyVersions.find((candidate) =>
            candidate.policyId === policy.id && candidate.versionNumber === policy.currentVersion);
          if (!version) throw new ConflictException("Replenishment policy version is missing");
          return mapPolicy(policy, version);
        }),
        suggestions: suggestions.map((suggestion) => {
          const version = policyVersions.find((candidate) => candidate.id === suggestion.policyVersionId);
          if (!version) throw new ConflictException("Replenishment suggestion policy version is missing");
          return mapSuggestion(suggestion, version.versionNumber);
        }),
      };
    });
  }
}

async function readSupplier(tx: TenantTransaction, current: TenantContext, id: string) {
  const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, id)).limit(1);
  if (!supplier) throw new NotFoundException("Procurement supplier not found");
  authorize(current, Permission.ProcurementRead, { ownerId: supplier.createdBy });
}

async function readLocation(tx: TenantTransaction, current: TenantContext, id: string) {
  const [location] = await tx.select().from(inventoryLocations).where(eq(inventoryLocations.id, id)).limit(1);
  if (!location) throw new NotFoundException("Inventory location not found");
  authorize(current, Permission.InventoryRead, { ownerId: location.createdBy });
}

async function readLineDimensions(tx: TenantTransaction, current: TenantContext, lines: ProcurementRequestLine[]) {
  for (const line of lines) {
    const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, line.stockItemId)).limit(1);
    if (!stock) throw new NotFoundException("Inventory stock item not found");
    authorize(current, Permission.InventoryRead, { ownerId: stock.createdBy });
    await readLocation(tx, current, line.destinationLocationId);
  }
}

async function validateRequestLines(tx: TenantTransaction, lines: ProcurementRequestLine[], context?: TenantContext) {
  for (const line of lines) {
    const stockItem = await validateDimension(tx, line.stockItemId, line.destinationLocationId, context);
    procurementExact(() => convertProcurementQuantity(line.quantity, line.unit, ProcurementUnitSchema.parse(stockItem.baseUnit)));
  }
}

async function validatePurchaseLines(tx: TenantTransaction, lines: ProcurementPurchaseLine[], context?: TenantContext) {
  await validateRequestLines(tx, lines, context);
  for (const line of lines) procurementExact(() => assertProcurementQuantityUnit(line.priceBasisQuantity ?? 1, line.unit));
  purchaseTotal(lines);
}

async function pinPurchaseLines(tx: TenantTransaction, lines: ProcurementPurchaseLine[], context: TenantContext): Promise<ProcurementPurchaseLineSnapshot[]> {
  const result: ProcurementPurchaseLineSnapshot[] = [];
  for (const line of lines) {
    const stock = await validateDimension(tx, line.stockItemId, line.destinationLocationId, context);
    result.push(procurementExact(() => pinProcurementStockBasis(line, ProcurementUnitSchema.parse(stock.baseUnit))));
  }
  return result;
}

async function receiptLineStockBasis(tx: TenantTransaction, current: TenantContext, line: ProcurementPurchaseLineSnapshot): Promise<ProcurementStockBasis> {
  const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, line.stockItemId)).limit(1);
  if (!stock) throw new NotFoundException("Inventory stock item not found");
  authorize(current, Permission.InventoryRead, { ownerId: stock.createdBy });
  await readLocation(tx, current, line.destinationLocationId);
  if (line.stockBasis !== undefined) {
    const parsed = ProcurementStockBasisSchema.safeParse(line.stockBasis);
    if (!parsed.success) throw new ConflictException({ code: "procurement_stock_basis_invalid", message: "原采购库存转换或计价依据不完整 请先核对原采购版本" });
    if (parsed.data.stockUnit !== stock.baseUnit) throw new ConflictException({ code: "procurement_stock_basis_changed", message: "原采购库存单位与货品依据不一致 请先核对原采购版本" });
    const expected = procurementExact(() => pinProcurementStockBasis(line, ProcurementUnitSchema.parse(stock.baseUnit)).stockBasis);
    if (canonicalJson(parsed.data) !== canonicalJson(expected)) throw new ConflictException({ code: "procurement_stock_basis_invalid", message: "原采购库存转换或计价依据与原行数量不一致 请先核对原采购版本" });
    return parsed.data;
  }
  // Legacy purchase quantities used stock base units. Only that identity is
  // recoverable; a missing historical conversion must never be manufactured.
  if (line.unit !== stock.baseUnit) throw new ConflictException({ code: "procurement_stock_basis_unavailable", message: "旧采购缺少单位转换依据 请先核对原采购版本" });
  return procurementExact(() => pinProcurementStockBasis(line, ProcurementUnitSchema.parse(stock.baseUnit)).stockBasis);
}

async function validateDimension(tx: TenantTransaction, stockItemId: string, locationId: string, context?: TenantContext) {
  const [stockItem] = await tx.select().from(inventoryStockItems)
    .where(eq(inventoryStockItems.id, stockItemId)).limit(1);
  if (!stockItem) throw new NotFoundException("Inventory stock item not found");
  if (context) authorize(context, Permission.InventoryRead, { ownerId: stockItem.createdBy });
  if (stockItem.status !== "active") throw new ConflictException("Inventory stock item is inactive");
  const [location] = await tx.select().from(inventoryLocations)
    .where(eq(inventoryLocations.id, locationId)).limit(1);
  if (!location) throw new NotFoundException("Inventory location not found");
  if (context) authorize(context, Permission.InventoryRead, { ownerId: location.createdBy });
  if (location.status !== "active") throw new ConflictException("Inventory location is inactive");
  return stockItem;
}

async function requireActiveSuppliers(tx: TenantTransaction, supplierIds: string[], context?: TenantContext) {
  const suppliers = await tx.select().from(fulfillmentSuppliers)
    .where(inArray(fulfillmentSuppliers.id, supplierIds));
  if (suppliers.length !== supplierIds.length) throw new NotFoundException("Procurement supplier not found");
  if (context) for (const supplier of suppliers) authorize(context, Permission.ProcurementRead, { ownerId: supplier.createdBy });
  if (suppliers.some((supplier) => supplier.status !== "active")) {
    throw new ConflictException("Procurement supplier is not active");
  }
}

async function validateQuotedPurchase(tx: TenantTransaction, context: TenantContext,
  input: Pick<CreateInventoryPurchaseOrderInput, "supplierId" | "requisitionId" | "quoteId" | "currency" | "lines">, lockSource = true) {
  if (!input.quoteId) return;
  const [quote] = await tx.select().from(inventorySupplierQuoteVersions).where(eq(inventorySupplierQuoteVersions.id, input.quoteId)).limit(1);
  if (!quote) throw new NotFoundException("Procurement supplier quote not found");
  authorize(context, Permission.ProcurementRead, { ownerId: quote.createdBy });
  if (lockSource) await lock(tx, `procurement-quote-version:${context.tenantId}:${quote.rfqId}:${quote.supplierId}`);
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  if (quote.validUntil.getTime() <= new Date(clock!.now).getTime()) throw new ConflictException("Supplier quote has expired; confirm a new quote before purchasing");
  const [latest] = await tx.select({ id: inventorySupplierQuoteVersions.id }).from(inventorySupplierQuoteVersions)
    .where(and(eq(inventorySupplierQuoteVersions.rfqId, quote.rfqId), eq(inventorySupplierQuoteVersions.supplierId, quote.supplierId)))
    .orderBy(desc(inventorySupplierQuoteVersions.versionNumber)).limit(1);
  if (latest?.id !== quote.id) throw new ConflictException("Supplier quote has a newer version; refresh the purchase source");
  const rfq = await requireRfq(tx, quote.rfqId);
  authorize(context, Permission.ProcurementRead, { ownerId: rfq.createdBy });
  if (rfq.status === "cancelled" || rfq.requisitionId !== input.requisitionId?.toLowerCase()) throw new ConflictException("Quote does not belong to the selected requisition");
  const [request] = await tx.select().from(inventoryProcurementRequisitionVersions).where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
  if (!request) throw new ConflictException("Quote requisition version is missing");
  const requisition = await requireRequisition(tx, rfq.requisitionId);
  authorize(context, Permission.ProcurementRead, { ownerId: requisition.createdBy });
  if (requisition.currentVersion !== request.versionNumber) throw new ConflictException("Quote references an earlier requisition version");
  if (quote.supplierId !== input.supplierId.toLowerCase()) throw new ConflictException("Quote supplier does not match purchase order");
  if (quote.currency !== input.currency) throw new ConflictException("Quote currency does not match purchase order");
  const requested = new Map(request.lineSnapshot.map(line => [line.lineKey, line]));
  const quoted = new Map(quote.lineSnapshot.map(line => [line.lineKey, line]));
  if (input.lines.length !== requested.size || quoted.size !== requested.size) throw new ConflictException("Quote and purchase line sets do not match the original requisition");
  for (const line of input.lines) {
    const source = requested.get(line.lineKey), price = quoted.get(line.lineKey);
    if (!source || !price || source.stockItemId !== line.stockItemId.toLowerCase() || source.destinationLocationId !== line.destinationLocationId.toLowerCase()
      || procurementExact(() => compareStockQuantity(convertProcurementQuantity(line.quantity, line.unit, source.unit), price.minimumOrderQuantity)) < 0
      || !procurementExact(() => equivalentProcurementPrice(line.unitCostMinor,
        convertProcurementQuantity(line.priceBasisQuantity ?? 1, line.unit, source.unit), price.unitCostMinor, price.priceBasisQuantity ?? 1)))
      throw new ConflictException("Purchase line differs from its quoted item, location, unit, price or MOQ");
  }
}

async function requireRequisition(tx: TenantTransaction, requisitionId: string) {
  const [requisition] = await tx.select().from(inventoryProcurementRequisitions)
    .where(eq(inventoryProcurementRequisitions.id, requisitionId)).limit(1);
  if (!requisition) throw new NotFoundException("Procurement requisition not found");
  return requisition;
}

async function requireRfq(tx: TenantTransaction, rfqId: string) {
  const [rfq] = await tx.select().from(inventoryProcurementRfqs)
    .where(eq(inventoryProcurementRfqs.id, rfqId)).limit(1);
  if (!rfq) throw new NotFoundException("Procurement RFQ not found");
  return rfq;
}

async function requirePurchaseOrder(tx: TenantTransaction, purchaseOrderId: string) {
  const [order] = await tx.select().from(inventoryPurchaseOrders)
    .where(eq(inventoryPurchaseOrders.id, purchaseOrderId)).limit(1);
  if (!order) throw new NotFoundException("Inventory purchase order not found");
  return order;
}

async function requirePurchaseOrderVersion(tx: TenantTransaction, order: PurchaseOrderRow) {
  const [version] = await tx.select().from(inventoryPurchaseOrderVersions)
    .where(and(
      eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id),
      eq(inventoryPurchaseOrderVersions.versionNumber, order.currentVersion),
    )).limit(1);
  if (!version) throw new ConflictException("Purchase order version is missing");
  return version;
}

async function requisitionView(
  tx: TenantTransaction,
  requisition: typeof inventoryProcurementRequisitions.$inferSelect,
) {
  const [version] = await tx.select().from(inventoryProcurementRequisitionVersions)
    .where(and(
      eq(inventoryProcurementRequisitionVersions.requisitionId, requisition.id),
      eq(inventoryProcurementRequisitionVersions.versionNumber, requisition.currentVersion),
    )).limit(1);
  if (!version) throw new ConflictException("Procurement requisition version is missing");
  return mapRequisition(requisition, version);
}

async function purchaseOrderView(tx: TenantTransaction, order: PurchaseOrderRow) {
  return mapPurchaseOrder(order, await requirePurchaseOrderVersion(tx, order));
}

async function prepareSupplyPurchase(tx: TenantTransaction, linkId: string, raw: CreateSupplyPurchaseInput, context: TenantContext, lockSource = true) {
  const [initial] = await tx.select().from(productSupplyLinks).where(eq(productSupplyLinks.id, linkId)).limit(1);
  if (!initial) throw new NotFoundException("Product supply not found");
  if (lockSource) await lock(tx, `product-supply:${initial.tenantId}:${initial.productPlanId}`);
  const [source] = await tx.select({ link: productSupplyLinks, version: productSupplyVersions, productStatus: productPlans.status, productOwner: productPlans.createdBy })
    .from(productSupplyLinks).innerJoin(productSupplyVersions, and(eq(productSupplyVersions.linkId, productSupplyLinks.id), eq(productSupplyVersions.versionNumber, productSupplyLinks.currentVersion)))
    .innerJoin(productPlans, eq(productPlans.id, productSupplyLinks.productPlanId)).where(eq(productSupplyLinks.id, linkId)).limit(1);
  if (!source) throw new NotFoundException("Product supply not found");
  authorize(context, Permission.ProductRead, { ownerId: source.link.createdBy });
  authorize(context, Permission.ProductRead, { ownerId: source.productOwner });
  if (source.link.currentVersion !== raw.expectedVersion) throw new ConflictException("Supply version changed");
  const terms = source.version.terms;
  if (source.productStatus === "archived" || terms.status !== "active" || terms.sampleStatus === "failed") throw new ConflictException("Supply is unavailable");
  if (!terms.fulfillmentModes.includes(raw.purpose)) throw new ConflictException("Supplier does not support this purchase purpose");
  if (terms.unitCostMinor === null || !terms.stockItemId) throw new ConflictException("Supply quote or stock item is missing");
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  const now = new Date(clock!.now).getTime();
  if (Date.parse(terms.validFrom) > now || (terms.validUntil && Date.parse(terms.validUntil) <= now)) throw new ConflictException("Supply quote is not currently valid");
  if (compareStockQuantity(raw.quantity, terms.minimumOrderQuantity) < 0) throw new ConflictException("Quantity is below supplier minimum order quantity");
  const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, terms.stockItemId)).limit(1);
  if (!stock) throw new NotFoundException("Stock item not found");
  if (stock.skuId && stock.skuId !== source.link.skuId) throw new ConflictException("Stock SKU does not match supply SKU");
  return { versionId: source.version.id, input: CreateInventoryPurchaseOrderInputSchema.parse({
    code: raw.code, supplierId: source.link.supplierId, requisitionId: null, quoteId: null,
    currency: terms.currency, expectedAt: raw.expectedAt, idempotencyKey: raw.idempotencyKey,
    lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: raw.destinationLocationId,
      quantity: raw.quantity, unit: terms.purchaseUnit ?? stock.baseUnit, unitCostMinor: terms.unitCostMinor,
      ...(terms.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: terms.priceBasisQuantity }) }],
  }) };
}

async function receiptView(
  tx: TenantTransaction,
  receipt: typeof inventoryProcurementReceipts.$inferSelect,
) {
  const lines = await tx.select().from(inventoryProcurementReceiptLines)
    .where(eq(inventoryProcurementReceiptLines.receiptId, receipt.id))
    .orderBy(asc(inventoryProcurementReceiptLines.lineKey));
  const [version] = await tx.select({ versionNumber: inventoryPurchaseOrderVersions.versionNumber })
    .from(inventoryPurchaseOrderVersions)
    .where(eq(inventoryPurchaseOrderVersions.id, receipt.purchaseOrderVersionId)).limit(1);
  if (!version) throw new ConflictException("Receipt purchase order version is missing");
  return mapReceipt(receipt, lines, version.versionNumber);
}

async function rfqView(
  tx: TenantTransaction,
  rfq: typeof inventoryProcurementRfqs.$inferSelect,
) {
  const [version] = await tx.select({ versionNumber: inventoryProcurementRequisitionVersions.versionNumber })
    .from(inventoryProcurementRequisitionVersions)
    .where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
  if (!version) throw new ConflictException("RFQ requisition version is missing");
  return mapRfq(rfq, version.versionNumber);
}

async function receiptTotals(tx: TenantTransaction, purchaseOrderId: string) {
  const rows = await tx.select({
    lineKey: inventoryProcurementReceiptLines.lineKey,
    receivedQuantity: inventoryProcurementReceiptLines.receivedQuantity,
    rejectedQuantity: inventoryProcurementReceiptLines.rejectedQuantity,
  }).from(inventoryProcurementReceiptLines)
    .innerJoin(
      inventoryProcurementReceipts,
      eq(inventoryProcurementReceipts.id, inventoryProcurementReceiptLines.receiptId),
    )
    .where(eq(inventoryProcurementReceipts.purchaseOrderId, purchaseOrderId));
  const totals = new Map<string, { received: StockQuantity; rejected: StockQuantity }>();
  for (const row of rows) {
    const value = totals.get(row.lineKey) ?? { received: 0, rejected: 0 };
    value.received = addStockQuantity(value.received, row.receivedQuantity);
    value.rejected = addStockQuantity(value.rejected, row.rejectedQuantity);
    totals.set(row.lineKey, value);
  }
  return totals;
}

async function findOrderEvent(tx: TenantTransaction, purchaseOrderId: string, idempotencyKey: string) {
  const [event] = await tx.select()
    .from(inventoryPurchaseOrderEvents)
    .where(and(
      eq(inventoryPurchaseOrderEvents.purchaseOrderId, purchaseOrderId),
      eq(inventoryPurchaseOrderEvents.idempotencyKey, idempotencyKey),
    )).limit(1);
  return event;
}

async function insertOrderEvent(
  tx: TenantTransaction,
  context: TenantContext,
  purchaseOrderId: string,
  event: {
    action: string;
    fromStatus: string | null;
    toStatus: string;
    reasonCode: string | null;
    idempotencyKey: string;
  },
) {
  const [latest] = await tx.select({ sequence: inventoryPurchaseOrderEvents.sequence })
    .from(inventoryPurchaseOrderEvents)
    .where(eq(inventoryPurchaseOrderEvents.purchaseOrderId, purchaseOrderId))
    .orderBy(desc(inventoryPurchaseOrderEvents.sequence)).limit(1);
  const id = createEntityId();
  await tx.insert(inventoryPurchaseOrderEvents).values({
    id,
    tenantId: context.tenantId,
    purchaseOrderId,
    sequence: (latest?.sequence ?? 0) + 1,
    ...event,
    actorUserId: context.userId,
  });
  return id;
}

function mapRequisition(
  row: typeof inventoryProcurementRequisitions.$inferSelect,
  version: typeof inventoryProcurementRequisitionVersions.$inferSelect,
) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    currentVersion: row.currentVersion,
    reasonCode: version.reasonCode,
    lines: version.lineSnapshot,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRfq(row: typeof inventoryProcurementRfqs.$inferSelect, requisitionVersion: number) {
  return {
    id: row.id,
    requisitionId: row.requisitionId,
    requisitionVersion,
    status: row.status,
    supplierIds: row.supplierIds,
    responseDueAt: row.responseDueAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapQuote(row: typeof inventorySupplierQuoteVersions.$inferSelect) {
  return {
    id: row.id,
    rfqId: row.rfqId,
    supplierId: row.supplierId,
    version: row.versionNumber,
    currency: row.currency,
    validUntil: row.validUntil.toISOString(),
    lines: row.lineSnapshot,
    totalMinor: row.totalMinor,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapPurchaseOrder(row: PurchaseOrderRow, version: PurchaseOrderVersionRow) {
  return {
    id: row.id,
    code: row.code,
    supplierId: row.supplierId,
    requisitionId: row.requisitionId,
    quoteId: row.quoteId,
    sourceSupplyVersionId: row.sourceSupplyVersionId,
    purpose: row.purpose as "general" | "custom_order" | "fba_replenishment",
    status: row.status,
    receivingPolicy: row.receivingPolicy as "inspection_required" | null,
    currentVersion: row.currentVersion,
    currency: version.currency,
    expectedAt: version.expectedAt.toISOString(),
    totalMinor: version.totalMinor,
    lines: version.lineSnapshot,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapReceipt(
  receipt: typeof inventoryProcurementReceipts.$inferSelect,
  lines: Array<typeof inventoryProcurementReceiptLines.$inferSelect>,
  purchaseOrderVersion: number,
) {
  return {
    id: receipt.id,
    purchaseOrderId: receipt.purchaseOrderId,
    purchaseOrderVersion,
    receivedAt: receipt.receivedAt.toISOString(),
    externalReference: receipt.externalReference,
    hasVariance: receipt.hasVariance,
    lines: lines.map((line) => ({
      lineKey: line.lineKey,
      stockItemId: line.stockItemId,
      destinationLocationId: line.destinationLocationId,
      receivedQuantity: line.receivedQuantity,
      rejectedQuantity: line.rejectedQuantity,
      rejectionReasonCode: line.rejectionReasonCode,
      lotId: line.lotId,
      movementId: line.movementId,
      unit: line.unit,
      stockUnit: line.stockUnit,
      stockReceivedQuantity: line.stockReceivedQuantity,
      stockRejectedQuantity: line.stockRejectedQuantity,
      priceBasisQuantity: line.priceBasisQuantity,
    })),
    createdAt: receipt.createdAt.toISOString(),
  };
}

async function requireInvoiceResult(tx: TenantTransaction, current: TenantContext, proofId: string) {
  authorize(current, Permission.ProcurementRead);
  const [proof] = await tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.id, proofId)).limit(1);
  if (!proof || proof.evidenceVersion !== 1) throw new NotFoundException("Actual invoice evidence not found");
  authorize(current, Permission.ProcurementRead, { ownerId: proof.createdBy });
  const [invoice] = await tx.select().from(inventorySupplierInvoices).where(eq(inventorySupplierInvoices.id, proof.invoiceId)).limit(1);
  if (!invoice || invoice.purchaseOrderId !== proof.purchaseOrderId || invoice.createdBy !== proof.createdBy || invoice.idempotencyKey !== proof.idempotencyKey)
    throw new ConflictException("Actual invoice result differs from its original evidence");
  const order = await requirePurchaseOrder(tx, proof.purchaseOrderId);
  authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
  await readSupplier(tx, current, order.supplierId);
  const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(and(
    eq(inventoryPurchaseOrderVersions.id, proof.purchaseOrderVersionId), eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id),
  )).limit(1);
  if (!version) throw new ConflictException("Original invoice purchase version is missing");
  await readLineDimensions(tx, current, version.lineSnapshot);
  return { proof, invoice, version, order };
}

/** Shared calculation only. A preparation reads the same rules without taking
 * business locks; only the actual owner reserves receipt allocation order. */
async function planInvoice(tx: TenantTransaction, current: TenantContext, order: PurchaseOrderRow,
  version: PurchaseOrderVersionRow, input: RecordProcurementInvoiceInput, lockReceipts = false) {
  const [duplicate] = await tx.select({ id: inventorySupplierInvoices.id }).from(inventorySupplierInvoices)
    .where(and(eq(inventorySupplierInvoices.purchaseOrderId, order.id), eq(inventorySupplierInvoices.invoiceNumber, input.invoiceNumber))).limit(1);
  if (duplicate) throw new ConflictException({ code: "procurement_invoice_number_already_recorded", message: "原采购单已登记这张发票 请先核对原发票记录" });
  const purchaseLines = new Map(version.lineSnapshot.map(line => [line.lineKey, line]));
  const receiptLines = await tx.select().from(inventoryProcurementReceiptLines).where(inArray(inventoryProcurementReceiptLines.receiptId,
    tx.select({ id: inventoryProcurementReceipts.id }).from(inventoryProcurementReceipts).where(and(
      eq(inventoryProcurementReceipts.purchaseOrderId, order.id), eq(inventoryProcurementReceipts.purchaseOrderVersionId, version.id),
    )))).orderBy(asc(inventoryProcurementReceiptLines.id));
  // Immutable receipts have no UPDATE grant. The actual owner and SQL guard
  // share this ordered advisory lock rather than granting mutation of facts.
  if (lockReceipts) for (const receipt of receiptLines) await lock(tx, `procurement-invoice-receipt:${current.tenantId}:${receipt.id}`);
  const priorInvoices = await tx.select({ allocationStatus: inventorySupplierInvoices.allocationStatus, requestId: inventorySupplierInvoiceRequests.id })
    .from(inventorySupplierInvoices).leftJoin(inventorySupplierInvoiceRequests, eq(inventorySupplierInvoiceRequests.invoiceId, inventorySupplierInvoices.id))
    .where(eq(inventorySupplierInvoices.purchaseOrderId, order.id));
  const legacyUnknown = priorInvoices.some(invoice => invoice.allocationStatus === null || invoice.allocationStatus === "legacy_unknown" || !invoice.requestId);
  const used = await readEffectiveInvoiceOccupationInTransaction(tx, receiptLines);
  const sameCurrency = input.currency === version.currency;
  let mismatch = !sameCurrency || legacyUnknown;
  let allocationComplete = !legacyUnknown;
  const totals: number[] = [], expectedTotals: number[] = [], lines: InvoiceLinePlan[] = [];
  for (const line of input.lines) {
    const ordered = purchaseLines.get(line.lineKey);
    if (!ordered) throw new ConflictException(`Purchase order line ${line.lineKey} was not found`);
    procurementExact(() => {
      assertProcurementQuantityUnit(line.invoicedQuantity, ordered.unit);
      assertProcurementQuantityUnit(line.priceBasisQuantity ?? 1, ordered.unit);
    });
    const lineTotal = procurementExact(() => procurementAmountMinor(line.invoicedQuantity, line.unitCostMinor, line.priceBasisQuantity ?? 1));
    const lineAllocations: InvoiceAllocationPlan[] = [];
    let remaining = line.invoicedQuantity;
    if (!legacyUnknown) for (const receipt of receiptLines) {
      if (receipt.lineKey !== line.lineKey || compareStockQuantity(remaining, 0) <= 0) continue;
      if (receipt.unit !== ordered.unit || receipt.stockItemId !== ordered.stockItemId || receipt.destinationLocationId !== ordered.destinationLocationId)
        throw new ConflictException({ code: "procurement_invoice_allocation_basis_unavailable", message: "原收货与发票采购依据不一致 请先核对原收货" });
      const available = subtractStockQuantity(receipt.receivedQuantity, used.get(receipt.id) ?? 0);
      if (compareStockQuantity(available, 0) < 0) throw new ConflictException({ code: "procurement_invoice_allocation_basis_unavailable", message: "原收货已超额分配 请先核对历史发票" });
      const quantity = compareStockQuantity(remaining, available) < 0 ? remaining : available;
      if (compareStockQuantity(quantity, 0) <= 0) continue;
      lineAllocations.push({ receiptLineId: receipt.id, quantity, unit: ordered.unit });
      used.set(receipt.id, addStockQuantity(used.get(receipt.id) ?? 0, quantity));
      remaining = subtractStockQuantity(remaining, quantity);
    }
    const allocatedQuantity = legacyUnknown ? null : subtractStockQuantity(line.invoicedQuantity, remaining);
    // An unknown allocation or different currency has no comparable minor
    // amount. Missing evidence is never valued at zero or silently rounded.
    const expectedTotal = legacyUnknown || !sameCurrency ? null : procurementExact(() => procurementAmountMinor(allocatedQuantity!, ordered.unitCostMinor, ordered.priceBasisQuantity ?? 1));
    totals.push(lineTotal);
    if (expectedTotal !== null) expectedTotals.push(expectedTotal);
    if (compareStockQuantity(remaining, 0) > 0) { allocationComplete = false; mismatch = true; }
    if (!procurementExact(() => equivalentProcurementPrice(line.unitCostMinor, line.priceBasisQuantity ?? 1, ordered.unitCostMinor, ordered.priceBasisQuantity ?? 1))) mismatch = true;
    lines.push({ lineKey: line.lineKey, invoicedQuantity: line.invoicedQuantity, unit: ordered.unit, unitCostMinor: line.unitCostMinor,
      priceBasisQuantity: line.priceBasisQuantity ?? 1, allocatedQuantity,
      varianceMinor: expectedTotal === null ? null : procurementExact(() => subtractProcurementMinor(lineTotal, expectedTotal)), allocations: lineAllocations });
  }
  const totalMinor = procurementExact(() => sumProcurementMinor(totals));
  const expectedMinor = procurementExact(() => sumProcurementMinor(expectedTotals));
  const status = mismatch ? "reconciliation_required" : "matched";
  const allocationStatus = legacyUnknown ? "legacy_unknown" : allocationComplete ? "complete" : "reconciliation_required";
  return { lines, totalMinor, varianceMinor: legacyUnknown || !sameCurrency ? null : procurementExact(() => subtractProcurementMinor(totalMinor, expectedMinor)),
    status, allocationStatus, mismatch, legacyUnknown, sameCurrency };
}

async function invoiceView(tx: TenantTransaction, invoice: typeof inventorySupplierInvoices.$inferSelect) {
  const lines = await tx.select().from(inventorySupplierInvoiceLines).where(eq(inventorySupplierInvoiceLines.invoiceId, invoice.id))
    .orderBy(asc(inventorySupplierInvoiceLines.lineKey));
  const [basis] = await tx.select({ currency: inventoryPurchaseOrderVersions.currency }).from(inventorySupplierInvoiceRequests)
    .innerJoin(inventoryPurchaseOrderVersions, eq(inventoryPurchaseOrderVersions.id, inventorySupplierInvoiceRequests.purchaseOrderVersionId))
    .where(eq(inventorySupplierInvoiceRequests.invoiceId, invoice.id)).limit(1);
  return mapInvoice(invoice, lines, basis?.currency ?? null);
}

function mapInvoice(row: typeof inventorySupplierInvoices.$inferSelect,
  lines: Array<Pick<typeof inventorySupplierInvoiceLines.$inferInsert, "lineKey" | "invoicedQuantity" | "unit" | "unitCostMinor" | "priceBasisQuantity" | "allocatedQuantity" | "varianceMinor">> = [], comparisonCurrency: string | null = null) {
  const comparable = row.allocationStatus !== null && row.allocationStatus !== "legacy_unknown" && comparisonCurrency === row.currency;
  return {
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    invoiceNumber: row.invoiceNumber,
    currency: row.currency,
    comparisonCurrency,
    totalMinor: row.totalMinor,
    varianceMinor: comparable ? row.varianceMinor : null,
    status: row.status,
    allocationStatus: (row.allocationStatus ?? "legacy_unknown") as "complete" | "reconciliation_required" | "legacy_unknown",
    lines: lines.map(line => ({ lineKey: line.lineKey, invoicedQuantity: line.invoicedQuantity, unit: line.unit ?? null,
      unitCostMinor: line.unitCostMinor, priceBasisQuantity: line.priceBasisQuantity ?? null,
      allocatedQuantity: line.allocatedQuantity ?? null, varianceMinor: comparable ? line.varianceMinor ?? null : null })),
    issuedAt: row.issuedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapPolicy(
  policy: typeof inventoryReplenishmentPolicies.$inferSelect,
  version: typeof inventoryReplenishmentPolicyVersions.$inferSelect,
) {
  return {
    id: policy.id,
    stockItemId: policy.stockItemId,
    locationId: policy.locationId,
    currentVersion: policy.currentVersion,
    reorderPoint: version.reorderPoint,
    safetyStock: version.safetyStock,
    minimumOrderQuantity: version.minimumOrderQuantity,
    leadTimeDays: version.leadTimeDays,
    serviceLevelBps: version.serviceLevelBps,
    reviewIntervalDays: version.reviewIntervalDays,
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function mapSuggestion(
  row: typeof inventoryReplenishmentSuggestions.$inferSelect,
  policyVersion: number,
) {
  return {
    id: row.id,
    policyId: row.policyId,
    policyVersion,
    stockItemId: row.stockItemId,
    locationId: row.locationId,
    availableQuantity: row.availableQuantity,
    inTransitQuantity: row.inTransitQuantity,
    suggestedQuantity: row.suggestedQuantity,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function canonicalLines<T extends { lineKey: string }>(lines: T[]): T[] {
  return [...lines].sort((left, right) => left.lineKey.localeCompare(right.lineKey));
}

function purchaseTotal(lines: ProcurementPurchaseLine[]) {
  return procurementExact(() => sumProcurementMinor(lines.map(line => procurementAmountMinor(line.quantity, line.unitCostMinor, line.priceBasisQuantity ?? 1))));
}

function quoteTotal(requests: ProcurementRequestLine[], quotes: RecordProcurementSupplierQuoteInput["lines"]) {
  const byKey = new Map(quotes.map(line => [line.lineKey, line]));
  return procurementExact(() => sumProcurementMinor(requests.map(requested => {
    const quoted = byKey.get(requested.lineKey)!;
    assertProcurementQuantityUnit(quoted.minimumOrderQuantity, requested.unit);
    assertProcurementQuantityUnit(quoted.priceBasisQuantity ?? 1, requested.unit);
    const quantity = compareStockQuantity(requested.quantity, quoted.minimumOrderQuantity) < 0 ? quoted.minimumOrderQuantity : requested.quantity;
    return procurementAmountMinor(quantity, quoted.unitCostMinor, quoted.priceBasisQuantity ?? 1);
  })));
}

function procurementExact<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const code = error.message.startsWith("procurement_") ? error.message : "procurement_quantity_invalid";
    throw new ConflictException({ code, message: "采购数量 单位或金额无法按原计价依据精确计算 请核对填写 不自动换算未知单位或舍入金额" });
  }
}

function checksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function childKey(parent: string, label: string) {
  return `procurement:${checksum(`${parent}:${label}`)}`;
}

async function lock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Existing owner facts predate retained inputs. Never infer an original from
 * their current projection or assign the same operation/key to another actor. */
async function legacyProcurementFact(tx: TenantTransaction, original: PrepareProcurementCommand) {
  const key = original.input.idempotencyKey;
  switch (original.kind) {
    case "requisition_create":
      return tx.select({ id: inventoryProcurementRequisitions.id }).from(inventoryProcurementRequisitions)
        .where(eq(inventoryProcurementRequisitions.idempotencyKey, key)).limit(1);
    case "rfq_create":
      return tx.select({ id: inventoryProcurementRfqs.id }).from(inventoryProcurementRfqs)
        .where(eq(inventoryProcurementRfqs.idempotencyKey, key)).limit(1);
    case "quote_record":
      return tx.select({ id: inventorySupplierQuoteVersions.id }).from(inventorySupplierQuoteVersions)
        .where(eq(inventorySupplierQuoteVersions.idempotencyKey, key)).limit(1);
    case "purchase_create":
    case "supply_purchase_create":
      return tx.select({ id: inventoryPurchaseOrders.id }).from(inventoryPurchaseOrders)
        .where(eq(inventoryPurchaseOrders.idempotencyKey, key)).limit(1);
    case "purchase_revise":
    case "purchase_review":
      return tx.select({ id: inventoryPurchaseOrderEvents.id }).from(inventoryPurchaseOrderEvents)
        .where(and(eq(inventoryPurchaseOrderEvents.idempotencyKey, key), or(
          eq(inventoryPurchaseOrderEvents.purchaseOrderId, original.targetId),
          inArray(inventoryPurchaseOrderEvents.action, original.kind === "purchase_revise" ? ["revised"] : ["approved", "rejected"]),
        ))).limit(1);
    case "invoice_record":
      return tx.select({ id: inventorySupplierInvoices.id }).from(inventorySupplierInvoices)
        .where(eq(inventorySupplierInvoices.idempotencyKey, key)).limit(1);
    case "invoice_reconcile":
      return tx.select({ id: invoiceReconciliations.id }).from(invoiceReconciliations)
        .where(eq(invoiceReconciliations.requestKey, key)).limit(1);
  }
}
