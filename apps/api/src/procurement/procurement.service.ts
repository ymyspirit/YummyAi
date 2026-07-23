import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CreateInventoryPurchaseOrderInputSchema,
  CreateProcurementRequisitionInputSchema,
  CreateProcurementRfqInputSchema,
  CreateReplenishmentSuggestionInputSchema,
  RecordProcurementInvoiceInputSchema,
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
  inventoryBalances,
  inventoryLocations,
  inventoryProcurementReceiptLines,
  inventoryProcurementReceipts,
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
  inventorySupplierQuoteVersions,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

type PurchaseOrderRow = typeof inventoryPurchaseOrders.$inferSelect;
type PurchaseOrderVersionRow = typeof inventoryPurchaseOrderVersions.$inferSelect;

@Injectable()
export class ProcurementService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createRequisition(context: TenantContext, rawInput: CreateProcurementRequisitionInput) {
    const input = CreateProcurementRequisitionInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-requisition-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [existing] = await tx.select().from(inventoryProcurementRequisitions)
        .where(eq(inventoryProcurementRequisitions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) return requisitionView(tx, existing);
      await validateRequestLines(tx, input.lines);
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
      return requisitionView(tx, requisition!);
    });
    await this.audit.record(context, {
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
    const input = CreateProcurementRfqInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-rfq-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryProcurementRfqs)
        .where(eq(inventoryProcurementRfqs.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return rfqView(tx, replayed);
      const requisition = await requireRequisition(tx, requisitionId);
      if (requisition.currentVersion !== input.expectedRequisitionVersion) {
        throw new ConflictException("Procurement requisition version changed");
      }
      if (requisition.status === "ordered" || requisition.status === "cancelled") {
        throw new ConflictException("Procurement requisition cannot be quoted in its current state");
      }
      await requireActiveSuppliers(tx, input.supplierIds);
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
      return mapRfq(rfq!, input.expectedRequisitionVersion);
    });
    await this.audit.record(context, {
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
    const input = RecordProcurementSupplierQuoteInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-quote-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventorySupplierQuoteVersions)
        .where(eq(inventorySupplierQuoteVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return mapQuote(replayed);
      const rfq = await requireRfq(tx, rfqId);
      if (rfq.status !== "open") throw new ConflictException("Procurement RFQ is not open");
      if (!rfq.supplierIds.includes(input.supplierId)) {
        throw new ConflictException("Supplier was not invited to this RFQ");
      }
      await requireActiveSuppliers(tx, [input.supplierId]);
      const [requestVersion] = await tx.select().from(inventoryProcurementRequisitionVersions)
        .where(eq(inventoryProcurementRequisitionVersions.id, rfq.requisitionVersionId)).limit(1);
      if (!requestVersion) throw new ConflictException("RFQ requisition version is missing");
      const quoteByLine = new Map(input.lines.map((line) => [line.lineKey, line]));
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
      const lines = canonicalLines(input.lines);
      const totalMinor = requestVersion.lineSnapshot.reduce((total, requested) => {
        const quoted = quoteByLine.get(requested.lineKey)!;
        return total + Math.max(requested.quantity, quoted.minimumOrderQuantity) * quoted.unitCostMinor;
      }, 0);
      assertSafeMoney(totalMinor);
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
      return mapQuote(quote!);
    });
    await this.audit.record(context, {
      action: "procurement.quote.record",
      resourceType: "inventory_supplier_quote",
      resourceId: result.id,
      result: "success",
      metadata: { rfqId, supplierId: result.supplierId, version: result.version },
    });
    return result;
  }

  async createPurchaseOrder(context: TenantContext, rawInput: CreateInventoryPurchaseOrderInput) {
    const input = CreateInventoryPurchaseOrderInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-order-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryPurchaseOrders)
        .where(eq(inventoryPurchaseOrders.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return purchaseOrderView(tx, replayed);
      await requireActiveSuppliers(tx, [input.supplierId]);
      await validatePurchaseLines(tx, input.lines);
      if (input.requisitionId) {
        const requisition = await requireRequisition(tx, input.requisitionId);
        if (requisition.status === "cancelled") throw new ConflictException("Procurement requisition is cancelled");
      }
      if (input.quoteId) {
        const [quote] = await tx.select().from(inventorySupplierQuoteVersions)
          .where(eq(inventorySupplierQuoteVersions.id, input.quoteId)).limit(1);
        if (!quote) throw new NotFoundException("Procurement supplier quote not found");
        if (quote.supplierId !== input.supplierId) throw new ConflictException("Quote supplier does not match purchase order");
        if (quote.currency !== input.currency) throw new ConflictException("Quote currency does not match purchase order");
      }
      const orderId = createEntityId();
      const lines = canonicalLines(input.lines);
      const totalMinor = purchaseTotal(lines);
      const [order] = await tx.insert(inventoryPurchaseOrders).values({
        id: orderId,
        tenantId: context.tenantId,
        code: input.code,
        supplierId: input.supplierId,
        requisitionId: input.requisitionId,
        quoteId: input.quoteId,
        expectedAt: new Date(input.expectedAt),
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      await tx.insert(inventoryPurchaseOrderVersions).values({
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
      });
      await insertOrderEvent(tx, context, orderId, {
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
      return purchaseOrderView(tx, order!);
    });
    await this.audit.record(context, {
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
    const input = ReviseInventoryPurchaseOrderInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      if (await hasOrderEvent(tx, purchaseOrderId, input.idempotencyKey)) {
        return purchaseOrderView(tx, await requirePurchaseOrder(tx, purchaseOrderId));
      }
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      if (!["draft", "rejected"].includes(order.status)) {
        throw new ConflictException("Purchase order cannot be revised in its current state");
      }
      if (order.currentVersion !== input.expectedVersion) {
        throw new ConflictException("Purchase order version changed");
      }
      await validatePurchaseLines(tx, input.lines);
      const lines = canonicalLines(input.lines);
      const nextVersion = order.currentVersion + 1;
      await tx.insert(inventoryPurchaseOrderVersions).values({
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
      });
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
      await insertOrderEvent(tx, context, purchaseOrderId, {
        action: "revised",
        fromStatus: order.status,
        toStatus: "draft",
        reasonCode: "VERSION_REVISED",
        idempotencyKey: input.idempotencyKey,
      });
      return purchaseOrderView(tx, updated);
    });
    await this.audit.record(context, {
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
    const input = ReviewInventoryPurchaseOrderInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      if (await hasOrderEvent(tx, purchaseOrderId, input.idempotencyKey)) {
        return purchaseOrderView(tx, await requirePurchaseOrder(tx, purchaseOrderId));
      }
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      if (!["draft", "rejected"].includes(order.status)) {
        throw new ConflictException("Purchase order cannot be reviewed in its current state");
      }
      if (order.currentVersion !== input.expectedVersion) {
        throw new ConflictException("Purchase order version changed");
      }
      const [updated] = await tx.update(inventoryPurchaseOrders).set({
        status: input.decision,
        updatedAt: new Date(),
      }).where(and(
        eq(inventoryPurchaseOrders.id, purchaseOrderId),
        eq(inventoryPurchaseOrders.currentVersion, input.expectedVersion),
      )).returning();
      if (!updated) throw new ConflictException("Purchase order version changed");
      await insertOrderEvent(tx, context, purchaseOrderId, {
        action: input.decision,
        fromStatus: order.status,
        toStatus: input.decision,
        reasonCode: input.reasonCode,
        idempotencyKey: input.idempotencyKey,
      });
      return purchaseOrderView(tx, updated);
    });
    await this.audit.record(context, {
      action: `procurement.purchase_order.${input.decision}`,
      resourceType: "inventory_purchase_order",
      resourceId: result.id,
      result: "success",
      metadata: { version: result.currentVersion, reasonCode: input.reasonCode },
    });
    return result;
  }

  async recordReceipt(
    context: TenantContext,
    purchaseOrderId: string,
    rawInput: RecordProcurementReceiptInput,
  ) {
    const input = RecordProcurementReceiptInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-receipt-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryProcurementReceipts)
        .where(eq(inventoryProcurementReceipts.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        return {
          receipt: await receiptView(tx, replayed),
          purchaseOrder: await purchaseOrderView(
            tx,
            await requirePurchaseOrder(tx, replayed.purchaseOrderId),
          ),
        };
      }
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      if (!["approved", "partially_received", "reconciliation_required"].includes(order.status)) {
        throw new ConflictException("Purchase order is not approved for receipt");
      }
      if (order.currentVersion !== input.expectedVersion) {
        throw new ConflictException("Purchase order version changed");
      }
      const version = await requirePurchaseOrderVersion(tx, order);
      const orderLines = new Map(version.lineSnapshot.map((line) => [line.lineKey, line]));
      const previous = await receiptTotals(tx, purchaseOrderId);
      let hasVariance = false;
      for (const line of input.lines) {
        const ordered = orderLines.get(line.lineKey);
        if (!ordered) throw new ConflictException(`Purchase order line ${line.lineKey} was not found`);
        const total = previous.get(line.lineKey) ?? { received: 0, rejected: 0 };
        if (total.received + total.rejected + line.receivedQuantity + line.rejectedQuantity > ordered.quantity) {
          hasVariance = true;
        }
        if (line.rejectedQuantity > 0) hasVariance = true;
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
        let lotId: string | null = null;
        let movementId: string | null = null;
        if (line.receivedQuantity > 0) {
          const stock = await this.inventory.receiveProcurementStock(tx, context, {
            receiptId,
            stockItemId: ordered.stockItemId,
            locationId: ordered.destinationLocationId,
            lotCode: line.lotCode!,
            quantity: line.receivedQuantity,
            unit: ordered.unit,
            unitCostMinor: ordered.unitCostMinor,
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
          lotId,
          movementId,
        });
      }
      const totals = await receiptTotals(tx, purchaseOrderId);
      const complete = version.lineSnapshot.every((line) => {
        const total = totals.get(line.lineKey);
        return total && total.received === line.quantity && total.rejected === 0;
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
      return {
        receipt: await receiptView(tx, receipt!),
        purchaseOrder: await purchaseOrderView(tx, updated!),
      };
    });
    await this.audit.record(context, {
      action: "procurement.receipt.record",
      resourceType: "inventory_procurement_receipt",
      resourceId: result.receipt.id,
      result: "success",
      metadata: {
        purchaseOrderId,
        hasVariance: result.receipt.hasVariance,
        lineCount: result.receipt.lines.length,
      },
    });
    return result;
  }

  async recordInvoice(
    context: TenantContext,
    purchaseOrderId: string,
    rawInput: RecordProcurementInvoiceInput,
  ) {
    const input = RecordProcurementInvoiceInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `procurement-invoice-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventorySupplierInvoices)
        .where(eq(inventorySupplierInvoices.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return mapInvoice(replayed);
      await lock(tx, `procurement-order:${context.tenantId}:${purchaseOrderId}`);
      const order = await requirePurchaseOrder(tx, purchaseOrderId);
      const version = await requirePurchaseOrderVersion(tx, order);
      const purchaseLines = new Map(version.lineSnapshot.map((line) => [line.lineKey, line]));
      const received = await receiptTotals(tx, purchaseOrderId);
      let totalMinor = 0;
      let expectedMinor = 0;
      let mismatch = input.currency !== version.currency || input.lines.length !== version.lineSnapshot.length;
      const lineValues: Array<typeof inventorySupplierInvoiceLines.$inferInsert> = [];
      const invoiceId = createEntityId();
      for (const line of input.lines) {
        const ordered = purchaseLines.get(line.lineKey);
        if (!ordered) throw new ConflictException(`Purchase order line ${line.lineKey} was not found`);
        const lineTotal = line.invoicedQuantity * line.unitCostMinor;
        const expectedQuantity = received.get(line.lineKey)?.received ?? 0;
        const expectedTotal = expectedQuantity * ordered.unitCostMinor;
        assertSafeMoney(lineTotal);
        assertSafeMoney(expectedTotal);
        totalMinor += lineTotal;
        expectedMinor += expectedTotal;
        if (line.invoicedQuantity !== expectedQuantity || line.unitCostMinor !== ordered.unitCostMinor) mismatch = true;
        lineValues.push({
          id: createEntityId(),
          tenantId: context.tenantId,
          invoiceId,
          lineKey: line.lineKey,
          invoicedQuantity: line.invoicedQuantity,
          unitCostMinor: line.unitCostMinor,
          varianceMinor: lineTotal - expectedTotal,
        });
      }
      assertSafeMoney(totalMinor);
      const status = mismatch ? "reconciliation_required" : "matched";
      const [invoice] = await tx.insert(inventorySupplierInvoices).values({
        id: invoiceId,
        tenantId: context.tenantId,
        purchaseOrderId,
        invoiceNumber: input.invoiceNumber,
        currency: input.currency,
        totalMinor,
        varianceMinor: totalMinor - expectedMinor,
        status,
        issuedAt: new Date(input.issuedAt),
        idempotencyKey: input.idempotencyKey,
        createdBy: context.userId,
      }).returning();
      await tx.insert(inventorySupplierInvoiceLines).values(lineValues);
      if (mismatch && order.status !== "reconciliation_required") {
        await tx.update(inventoryPurchaseOrders).set({
          status: "reconciliation_required",
          updatedAt: new Date(),
        }).where(eq(inventoryPurchaseOrders.id, purchaseOrderId));
        await insertOrderEvent(tx, context, purchaseOrderId, {
          action: "reconciliation_required",
          fromStatus: order.status,
          toStatus: "reconciliation_required",
          reasonCode: "INVOICE_VARIANCE",
          idempotencyKey: input.idempotencyKey,
        });
      }
      return mapInvoice(invoice!);
    });
    await this.audit.record(context, {
      action: "procurement.invoice.record",
      resourceType: "inventory_supplier_invoice",
      resourceId: result.id,
      result: "success",
      metadata: { purchaseOrderId, status: result.status, varianceMinor: result.varianceMinor },
    });
    return result;
  }

  async upsertReplenishmentPolicy(context: TenantContext, rawInput: UpsertReplenishmentPolicyInput) {
    const input = UpsertReplenishmentPolicyInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `replenishment-policy:${context.tenantId}:${input.stockItemId}:${input.locationId}`);
      const [replayed] = await tx.select().from(inventoryReplenishmentPolicyVersions)
        .where(eq(inventoryReplenishmentPolicyVersions.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        const [policy] = await tx.select().from(inventoryReplenishmentPolicies)
          .where(eq(inventoryReplenishmentPolicies.id, replayed.policyId)).limit(1);
        return mapPolicy(policy!, replayed);
      }
      await validateDimension(tx, input.stockItemId, input.locationId);
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
      const physical = balances.reduce((total, balance) => total + balance.physicalQuantity, 0);
      const reserved = balances.reduce((total, balance) => total + balance.reservedQuantity, 0);
      const inTransit = balances.reduce((total, balance) => total + balance.inTransitQuantity, 0);
      const available = physical - reserved;
      const position = available + inTransit;
      const target = version.reorderPoint + version.safetyStock;
      const suggestedQuantity = position <= version.reorderPoint
        ? Math.max(version.minimumOrderQuantity, target - position)
        : 0;
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

  workspace(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      const suppliers = await tx.select().from(fulfillmentSuppliers)
        .orderBy(asc(fulfillmentSuppliers.name));
      const stockItems = await tx.select().from(inventoryStockItems)
        .orderBy(asc(inventoryStockItems.name));
      const locations = await tx.select().from(inventoryLocations)
        .orderBy(asc(inventoryLocations.name));
      const requisitions = await tx.select().from(inventoryProcurementRequisitions)
        .orderBy(desc(inventoryProcurementRequisitions.updatedAt)).limit(100);
      const requisitionVersions = await tx.select().from(inventoryProcurementRequisitionVersions);
      const rfqs = await tx.select().from(inventoryProcurementRfqs)
        .orderBy(desc(inventoryProcurementRfqs.createdAt)).limit(100);
      const quotes = await tx.select().from(inventorySupplierQuoteVersions)
        .orderBy(desc(inventorySupplierQuoteVersions.createdAt)).limit(100);
      const orders = await tx.select().from(inventoryPurchaseOrders)
        .orderBy(desc(inventoryPurchaseOrders.updatedAt)).limit(100);
      const orderVersions = await tx.select().from(inventoryPurchaseOrderVersions);
      const receipts = await tx.select().from(inventoryProcurementReceipts)
        .orderBy(desc(inventoryProcurementReceipts.receivedAt)).limit(100);
      const receiptLines = await tx.select().from(inventoryProcurementReceiptLines);
      const invoices = await tx.select().from(inventorySupplierInvoices)
        .orderBy(desc(inventorySupplierInvoices.issuedAt)).limit(100);
      const policies = await tx.select().from(inventoryReplenishmentPolicies)
        .orderBy(desc(inventoryReplenishmentPolicies.updatedAt)).limit(100);
      const policyVersions = await tx.select().from(inventoryReplenishmentPolicyVersions);
      const suggestions = await tx.select().from(inventoryReplenishmentSuggestions)
        .orderBy(desc(inventoryReplenishmentSuggestions.createdAt)).limit(100);
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
        })),
        locations: locations.map((location) => ({
          id: location.id,
          code: location.code,
          name: location.name,
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
        invoices: invoices.map(mapInvoice),
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

async function validateRequestLines(tx: TenantTransaction, lines: ProcurementRequestLine[]) {
  for (const line of lines) {
    const stockItem = await validateDimension(tx, line.stockItemId, line.destinationLocationId);
    if (stockItem.baseUnit !== line.unit) {
      throw new ConflictException(`Procurement line ${line.lineKey} unit does not match stock item`);
    }
  }
}

async function validatePurchaseLines(tx: TenantTransaction, lines: ProcurementPurchaseLine[]) {
  await validateRequestLines(tx, lines);
  purchaseTotal(lines);
}

async function validateDimension(tx: TenantTransaction, stockItemId: string, locationId: string) {
  const [stockItem] = await tx.select().from(inventoryStockItems)
    .where(eq(inventoryStockItems.id, stockItemId)).limit(1);
  if (!stockItem) throw new NotFoundException("Inventory stock item not found");
  if (stockItem.status !== "active") throw new ConflictException("Inventory stock item is inactive");
  const [location] = await tx.select().from(inventoryLocations)
    .where(eq(inventoryLocations.id, locationId)).limit(1);
  if (!location) throw new NotFoundException("Inventory location not found");
  if (location.status !== "active") throw new ConflictException("Inventory location is inactive");
  return stockItem;
}

async function requireActiveSuppliers(tx: TenantTransaction, supplierIds: string[]) {
  const suppliers = await tx.select().from(fulfillmentSuppliers)
    .where(inArray(fulfillmentSuppliers.id, supplierIds));
  if (suppliers.length !== supplierIds.length) throw new NotFoundException("Procurement supplier not found");
  if (suppliers.some((supplier) => supplier.status !== "active")) {
    throw new ConflictException("Procurement supplier is not active");
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
  const totals = new Map<string, { received: number; rejected: number }>();
  for (const row of rows) {
    const value = totals.get(row.lineKey) ?? { received: 0, rejected: 0 };
    value.received += row.receivedQuantity;
    value.rejected += row.rejectedQuantity;
    totals.set(row.lineKey, value);
  }
  return totals;
}

async function hasOrderEvent(tx: TenantTransaction, purchaseOrderId: string, idempotencyKey: string) {
  const [event] = await tx.select({ id: inventoryPurchaseOrderEvents.id })
    .from(inventoryPurchaseOrderEvents)
    .where(and(
      eq(inventoryPurchaseOrderEvents.purchaseOrderId, purchaseOrderId),
      eq(inventoryPurchaseOrderEvents.idempotencyKey, idempotencyKey),
    )).limit(1);
  return Boolean(event);
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
  await tx.insert(inventoryPurchaseOrderEvents).values({
    id: createEntityId(),
    tenantId: context.tenantId,
    purchaseOrderId,
    sequence: (latest?.sequence ?? 0) + 1,
    ...event,
    actorUserId: context.userId,
  });
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
    status: row.status,
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
    })),
    createdAt: receipt.createdAt.toISOString(),
  };
}

function mapInvoice(row: typeof inventorySupplierInvoices.$inferSelect) {
  return {
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    invoiceNumber: row.invoiceNumber,
    currency: row.currency,
    totalMinor: row.totalMinor,
    varianceMinor: row.varianceMinor,
    status: row.status,
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
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitCostMinor, 0);
  assertSafeMoney(total);
  return total;
}

function assertSafeMoney(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConflictException("Procurement monetary total exceeds the supported range");
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
