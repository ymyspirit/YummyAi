import { createEntityId, type ProcurementWorkspaceView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProcurementWorkspace } from "./procurement-workspace";

describe("ProcurementWorkspace", () => {
  it("renders versioned purchase, receipt, invoice, and replenishment evidence", () => {
    const html = renderToStaticMarkup(<ProcurementWorkspace data={fixture()} />);
    expect(html).toContain("库存采购单");
    expect(html).toContain("IPO-2026-001");
    expect(html).toContain("收货与发票对账");
    expect(html).toContain("开放补货建议");
    expect(html).toContain("待对账");
  });

  it("does not fabricate procurement evidence", () => {
    const empty: ProcurementWorkspaceView = {
      suppliers: [],
      stockItems: [],
      locations: [],
      requisitions: [],
      rfqs: [],
      quotes: [],
      purchaseOrders: [],
      receipts: [],
      invoices: [],
      policies: [],
      suggestions: [],
    };
    const html = renderToStaticMarkup(<ProcurementWorkspace data={empty} />);
    expect(html).toContain("还没有采购证据");
    expect(html).toContain("不会根据库存缺口自动批准采购");
  });
});

function fixture(): ProcurementWorkspaceView {
  const supplierId = createEntityId();
  const stockItemId = createEntityId();
  const locationId = createEntityId();
  const requisitionId = createEntityId();
  const purchaseOrderId = createEntityId();
  const policyId = createEntityId();
  return {
    suppliers: [{
      id: supplierId,
      name: "Blank Goods Supplier",
      kind: "manual",
      regionCode: "US",
      settlementCurrency: "USD",
      status: "active",
    }],
    stockItems: [{
      id: stockItemId,
      code: "BLANK-PILLOW",
      name: "Blank pillow cover",
      baseUnit: "each",
    }],
    locations: [{
      id: locationId,
      code: "RECEIVE",
      name: "Receiving dock",
    }],
    requisitions: [{
      id: requisitionId,
      code: "REQ-2026-001",
      status: "ordered",
      currentVersion: 1,
      reasonCode: "REORDER_POINT",
      lines: [{
        lineKey: "LINE-1",
        stockItemId,
        destinationLocationId: locationId,
        quantity: 10,
        unit: "each",
      }],
      createdAt: "2026-07-23T01:00:00.000Z",
      updatedAt: "2026-07-23T01:00:00.000Z",
    }],
    rfqs: [],
    quotes: [],
    purchaseOrders: [{
      id: purchaseOrderId,
      code: "IPO-2026-001",
      supplierId,
      requisitionId,
      quoteId: null,
      status: "reconciliation_required",
      currentVersion: 1,
      currency: "USD",
      expectedAt: "2026-08-10T00:00:00.000Z",
      totalMinor: 4250,
      lines: [{
        lineKey: "LINE-1",
        stockItemId,
        destinationLocationId: locationId,
        quantity: 10,
        unit: "each",
        unitCostMinor: 425,
      }],
      createdAt: "2026-07-23T01:00:00.000Z",
      updatedAt: "2026-07-23T01:00:00.000Z",
    }],
    receipts: [{
      id: createEntityId(),
      purchaseOrderId,
      purchaseOrderVersion: 1,
      receivedAt: "2026-08-09T12:00:00.000Z",
      externalReference: "ASN-001",
      hasVariance: true,
      lines: [{
        lineKey: "LINE-1",
        stockItemId,
        destinationLocationId: locationId,
        receivedQuantity: 10,
        rejectedQuantity: 1,
        rejectionReasonCode: "DAMAGED",
        lotId: createEntityId(),
        movementId: createEntityId(),
        unit: "each",
      }],
      createdAt: "2026-08-09T12:00:00.000Z",
    }],
    invoices: [{
      id: createEntityId(),
      purchaseOrderId,
      invoiceNumber: "INV-001",
      currency: "USD",
      totalMinor: 4500,
      varianceMinor: 250,
      status: "reconciliation_required",
      issuedAt: "2026-08-09T14:00:00.000Z",
      createdAt: "2026-08-09T14:00:00.000Z",
    }],
    policies: [{
      id: policyId,
      stockItemId,
      locationId,
      currentVersion: 1,
      reorderPoint: 20,
      safetyStock: 5,
      minimumOrderQuantity: 8,
      leadTimeDays: 7,
      serviceLevelBps: 9500,
      reviewIntervalDays: 7,
      updatedAt: "2026-07-23T01:00:00.000Z",
    }],
    suggestions: [{
      id: createEntityId(),
      policyId,
      policyVersion: 1,
      stockItemId,
      locationId,
      availableQuantity: 10,
      inTransitQuantity: 0,
      suggestedQuantity: 15,
      status: "open",
      createdAt: "2026-07-23T01:00:00.000Z",
    }],
  };
}
