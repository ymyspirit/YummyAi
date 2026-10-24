import { describe, expect, it } from "vitest";

import { createEntityId } from "../common/ids.js";
import {
  CreateInventoryPurchaseOrderInputSchema,
  CreateProcurementRequisitionInputSchema,
  ProcurementPurchaseLineSnapshotSchema,
  ProcurementReceiptLineInputSchema,
  RecordProcurementInvoiceInputSchema,
  RecordProcurementSupplierQuoteInputSchema,
  RecordProcurementReceiptInputSchema,
  UpsertReplenishmentPolicyInputSchema,
} from "./procurement.js";
import { canonicalProcurementWriteRequest } from "./procurement-cycle.js";

describe("procurement contracts", () => {
  function purchase() {
    return { code: "PO-PRECISION", supplierId: createEntityId(), requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: "2026-10-21T00:00:00.000Z",
      lines: [{ lineKey: "LINE-1", stockItemId: createEntityId(), destinationLocationId: createEntityId(),
        quantity: "1.000000001", unit: "kilogram" as const, unitCostMinor: 1_000_000_000 }],
      idempotencyKey: "synthetic-procurement-precision-contract" };
  }

  it("preserves nine-place requisition, quote, purchase, policy and invoice quantities", () => {
    const order = purchase(), line = order.lines[0]!;
    expect(CreateInventoryPurchaseOrderInputSchema.parse(order).lines[0]!.quantity).toBe("1.000000001");
    expect(CreateProcurementRequisitionInputSchema.parse({ code: "REQ-PRECISION", reasonCode: "SYNTHETIC",
      lines: [{ lineKey: line.lineKey, stockItemId: line.stockItemId, destinationLocationId: line.destinationLocationId,
        quantity: line.quantity, unit: line.unit }], idempotencyKey: order.idempotencyKey }).lines[0]!.quantity).toBe(line.quantity);
    expect(RecordProcurementSupplierQuoteInputSchema.parse({ supplierId: order.supplierId, currency: "USD",
      validUntil: order.expectedAt, lines: [{ lineKey: line.lineKey, unitCostMinor: 1,
        minimumOrderQuantity: "0.000000001", priceBasisQuantity: "0.000000001", leadTimeDays: 0 }],
      idempotencyKey: order.idempotencyKey }).lines[0]).toMatchObject({ minimumOrderQuantity: "0.000000001", priceBasisQuantity: "0.000000001" });
    expect(UpsertReplenishmentPolicyInputSchema.parse({ stockItemId: line.stockItemId, locationId: line.destinationLocationId,
      reorderPoint: "0.100000001", safetyStock: "0.000000001", minimumOrderQuantity: "0.25", leadTimeDays: 0,
      serviceLevelBps: 9500, reviewIntervalDays: 1, idempotencyKey: order.idempotencyKey }))
      .toMatchObject({ reorderPoint: "0.100000001", safetyStock: "0.000000001", minimumOrderQuantity: "0.25" });
    expect(RecordProcurementInvoiceInputSchema.parse({ expectedVersion: 1, invoiceNumber: "SYNTHETIC-PRECISION",
      currency: "USD", issuedAt: order.expectedAt, lines: [{ lineKey: line.lineKey, invoicedQuantity: "0.000000001",
        unitCostMinor: 1, priceBasisQuantity: "0.000000001" }], idempotencyKey: order.idempotencyKey }).lines[0]!.invoicedQuantity).toBe("0.000000001");
  });

  it("does not add pricing or version defaults to legacy request bodies or change their v1 identity", () => {
    const order = purchase(), original = { ...order, lines: order.lines.map(line => ({ ...line, quantity: 1 })) };
    const numeric = CreateInventoryPurchaseOrderInputSchema.parse(original);
    const equivalent = CreateInventoryPurchaseOrderInputSchema.parse({ ...original,
      lines: original.lines.map(line => ({ ...line, quantity: "001.000000000" })) });
    expect(numeric.lines[0]).not.toHaveProperty("priceBasisQuantity");
    expect(equivalent).toEqual(numeric);
    expect(canonicalProcurementWriteRequest("purchase_create", null, equivalent)).toBe(canonicalProcurementWriteRequest("purchase_create", null, numeric));
    const fractional = CreateInventoryPurchaseOrderInputSchema.parse({ ...original,
      lines: original.lines.map(line => ({ ...line, quantity: "0.290000000" })) });
    const shortened = CreateInventoryPurchaseOrderInputSchema.parse({ ...original,
      lines: original.lines.map(line => ({ ...line, quantity: "0.29" })) });
    expect(canonicalProcurementWriteRequest("purchase_create", null, fractional)).toBe(canonicalProcurementWriteRequest("purchase_create", null, shortened));
    const invoice = RecordProcurementInvoiceInputSchema.parse({ invoiceNumber: "LEGACY", currency: "USD", issuedAt: original.expectedAt,
      lines: [{ lineKey: "LINE-1", invoicedQuantity: 1, unitCostMinor: 100 }], idempotencyKey: original.idempotencyKey });
    expect(invoice).not.toHaveProperty("expectedVersion");
    expect(invoice.lines[0]).not.toHaveProperty("priceBasisQuantity");
  });

  it.each(["each", "pair", "set"] as const)("requires whole %s quantities and price bases in procurement input", unit => {
    const order = purchase();
    expect(CreateInventoryPurchaseOrderInputSchema.safeParse({ ...order,
      lines: order.lines.map(line => ({ ...line, unit, quantity: "0.25" })) }).success).toBe(false);
    expect(CreateInventoryPurchaseOrderInputSchema.safeParse({ ...order,
      lines: order.lines.map(line => ({ ...line, unit, quantity: 2, priceBasisQuantity: "0.5" })) }).success).toBe(false);
    expect(CreateInventoryPurchaseOrderInputSchema.parse({ ...order,
      lines: order.lines.map(line => ({ ...line, unit, quantity: "2.000000000", priceBasisQuantity: 1 })) }).lines[0]!.quantity).toBe(2);
  });

  it("rejects floating quantities, excess precision and a zero pricing basis without silently coercing them", () => {
    const order = purchase();
    for (const quantity of [0.25, "0.0000000001", "2147483647.000000001", "1e-9", "NaN"])
      expect(CreateInventoryPurchaseOrderInputSchema.safeParse({ ...order,
        lines: order.lines.map(line => ({ ...line, quantity })) }).success).toBe(false);
    expect(CreateInventoryPurchaseOrderInputSchema.safeParse({ ...order,
      lines: order.lines.map(line => ({ ...line, priceBasisQuantity: 0 })) }).success).toBe(false);
  });

  it("reads pinned stock basis without requiring it or fabricating it on legacy snapshots", () => {
    const line = purchase().lines[0]!;
    expect(ProcurementPurchaseLineSnapshotSchema.parse(line)).not.toHaveProperty("stockBasis");
    const stockBasis = { version: 1, rule: "metric-unit-v1", stockUnit: "gram", stockQuantity: "1000.000001",
      conversionNumerator: "1000", conversionDenominator: "1", priceBasisStockQuantity: 1000 };
    expect(ProcurementPurchaseLineSnapshotSchema.parse({ ...line, stockBasis }).stockBasis).toEqual(stockBasis);
  });

  it("preserves the full incoming handover reference through the receipt contract", () => {
    const input = { expectedVersion: 1, receivedAt: "2026-10-19T01:02:00.000Z",
      externalReference: "凭".repeat(2000), lines: [{ lineKey: "LINE-1", receivedQuantity: "0.1",
        rejectedQuantity: 0, rejectionReasonCode: null, lotCode: "ACTUAL-LOT", expiresAt: null }],
      idempotencyKey: "incoming-reference-contract-0001" };
    expect(RecordProcurementReceiptInputSchema.parse(input).externalReference).toBe(input.externalReference);
    expect(RecordProcurementReceiptInputSchema.safeParse({ ...input, externalReference: "凭".repeat(2001) }).success).toBe(false);
  });

  it("accepts explicit purchase quantities, units, destinations, and minor-unit costs", () => {
    expect(CreateInventoryPurchaseOrderInputSchema.parse({
      code: "PO-2026-001",
      supplierId: createEntityId(),
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2026-08-10T00:00:00.000Z",
      lines: [{
        lineKey: "LINE-1",
        stockItemId: createEntityId(),
        destinationLocationId: createEntityId(),
        quantity: 120,
        unit: "each",
        unitCostMinor: 425,
      }],
      idempotencyKey: "procurement-order-contract-0001",
    })).toMatchObject({ currency: "USD" });
  });

  it("requires received stock to have a lot and rejected stock to have a reason", () => {
    expect(ProcurementReceiptLineInputSchema.safeParse({
      lineKey: "LINE-1",
      receivedQuantity: 5,
      rejectedQuantity: 0,
      rejectionReasonCode: null,
      lotCode: null,
      expiresAt: null,
    }).success).toBe(false);
    expect(ProcurementReceiptLineInputSchema.safeParse({
      lineKey: "LINE-1",
      receivedQuantity: 0,
      rejectedQuantity: 2,
      rejectionReasonCode: null,
      lotCode: null,
      expiresAt: null,
    }).success).toBe(false);
  });

  it("rejects duplicate line keys and invalid service-level policy values", () => {
    const line = {
      lineKey: "LINE-1",
      stockItemId: createEntityId(),
      destinationLocationId: createEntityId(),
      quantity: 1,
      unit: "each",
      unitCostMinor: 100,
    };
    expect(CreateInventoryPurchaseOrderInputSchema.safeParse({
      code: "PO-DUPLICATE",
      supplierId: createEntityId(),
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2026-08-10T00:00:00.000Z",
      lines: [line, line],
      idempotencyKey: "procurement-order-contract-0002",
    }).success).toBe(false);
    expect(UpsertReplenishmentPolicyInputSchema.safeParse({
      stockItemId: createEntityId(),
      locationId: createEntityId(),
      reorderPoint: 10,
      safetyStock: 4,
      minimumOrderQuantity: 5,
      leadTimeDays: 7,
      serviceLevelBps: 10_001,
      reviewIntervalDays: 7,
      idempotencyKey: "replenishment-policy-contract-0001",
    }).success).toBe(false);
  });
});
