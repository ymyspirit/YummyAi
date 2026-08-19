import { renderToStaticMarkup } from "react-dom/server";
import { createEntityId, type OrderCustomizationSummaryView, type OrderIngestionRunView, type OrderView } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { OrderInbox, type OperationalQueues } from "./order-inbox";

describe("OrderInbox", () => {
  it("renders the public order projection without protected customer fields", () => {
    const order = fixture();
    const html = renderToStaticMarkup(<OrderInbox items={[order]} customizations={[customizationFixture(order)]} />);

    expect(html).toContain("ETSY-1007");
    expect(html).toContain("待设计");
    expect(html).toContain("US");
    expect(html).toContain("Personalized pillow cover");
    expect(html).toContain("客户审批");
    expect(html).toContain("文件隔离中");
    expect(html).toContain("100%");
    expect(html).not.toMatch(/buyer|recipient|email|phone|postal|shippingAddress/);
  });

  it("keeps customization API failures explicit", () => {
    const html = renderToStaticMarkup(<OrderInbox items={[fixture()]} customizationError="定制队列读取失败 (503)。" />);
    expect(html).toContain("定制队列读取失败 (503)。");
    expect(html).toContain("role=\"alert\"");
  });

  it("renders an explicit empty state", () => {
    const html = renderToStaticMarkup(<OrderInbox items={[]} />);
    expect(html).toContain("暂无订单");
    expect(html).toContain("不可变来源快照");
  });

  it("shows collected-versus-reported drift and PII-free ingestion risks", () => {
    const html = renderToStaticMarkup(<OrderInbox items={[]} runs={[ingestionFixture()]} />);
    expect(html).toContain("2 / 3");
    expect(html).toContain("地址缺失");
    expect(html).toContain("Protected shipping address is incomplete or unavailable");
    expect(html).not.toMatch(/buyer@example|Secret Street|encryptedEnvelope/);
  });

  it("renders production, logistics, exception, and after-sales queues without protected text", () => {
    const order = fixture();
    const html = renderToStaticMarkup(<OrderInbox items={[order]} operations={operationsFixture(order)} />);
    expect(html).toContain("履约工作台");
    expect(html).toContain("生产中");
    expect(html).toContain("待回传");
    expect(html).toContain("DELIVERY_DELAYED");
    expect(html).toContain("质量问题");
    expect(html).not.toMatch(/encryptedSummary|encryptedReason|Private customer message/);
  });
});

function ingestionFixture(): OrderIngestionRunView {
  const id = createEntityId();
  return {
    id, accountId: createEntityId(), platform: "etsy", stream: "receipts", status: "completed",
    collectedCount: 2, reportedCount: 3, duplicateCount: 1, riskCount: 1, sourceVersion: "etsy-open-api-v3",
    checkpointVersionStart: 1, checkpointVersionEnd: 2, highWaterAt: "2026-07-22T12:00:00.000Z", errorCode: null,
    startedAt: "2026-07-22T11:59:00.000Z", completedAt: "2026-07-22T12:00:00.000Z",
    risks: [{ id: createEntityId(), ingestionRunId: id, orderId: null, code: "address_gap", severity: "blocker", externalOrderId: "receipt-1", externalLineId: null, message: "Protected shipping address is incomplete or unavailable", createdAt: "2026-07-22T12:00:00.000Z" }],
  };
}

function operationsFixture(order: OrderView): OperationalQueues {
  return {
    production: [{ id: createEntityId(), orderId: order.id, status: "in_production", source: "initial", projectionVersion: 3, currentVersionNumber: 1, expectedCompletionAt: "2026-07-24T12:00:00.000Z", updatedAt: "2026-07-22T12:00:00.000Z" }],
    shipments: [{ id: createEntityId(), orderId: order.id, status: "writeback_pending", currentVersionNumber: 2, approvedVersionNumber: 2, updatedAt: "2026-07-22T12:00:00.000Z" }],
    exceptions: [{ id: createEntityId(), orderId: order.id, category: "logistics", code: "DELIVERY_DELAYED", message: "Static operational message", status: "open", resolution: null, openedAt: "2026-07-22T12:00:00.000Z", resolvedAt: null }],
    afterSales: [{ id: createEntityId(), orderId: order.id, type: "quality_issue", status: "awaiting_internal", reasonCode: "PRINT_DEFECT", currentDecisionVersion: 0, updatedAt: "2026-07-22T12:00:00.000Z" }],
  };
}

function fixture(): OrderView {
  const id = createEntityId();
  return {
    id,
    accountId: createEntityId(),
    platform: "etsy",
    externalOrderId: "ETSY-1007",
    providerStatus: "paid",
    workflowState: "awaiting_design",
    sideState: null,
    orderTotal: { amountMinor: 2640, currency: "USD" },
    lineCount: 1,
    address: { status: "protected", countryCode: "US" },
    latestEventSequence: 3,
    placedAt: "2026-07-20T04:00:00.000Z",
    createdAt: "2026-07-20T04:00:00.000Z",
    updatedAt: "2026-07-20T04:10:00.000Z",
    lines: [{
      id: createEntityId(), externalLineId: "line-1", externalListingId: "listing-1", skuCode: "PILLOW-01",
      title: "Personalized pillow cover", quantity: 1, unitPrice: { amountMinor: 2640, currency: "USD" }, customizationCount: 1,
    }],
  };
}

function customizationFixture(order: OrderView): OrderCustomizationSummaryView {
  return {
    id: createEntityId(), orderId: order.id, orderLineId: order.lines[0]!.id, schemaVersion: 4,
    fulfillmentPath: "customer_approval_required", status: "quarantined", versionId: createEntityId(), versionNumber: 1,
    completeness: 100, mappedFieldKeys: ["name", "portrait"], missingFieldKeys: [], fileFieldKeys: ["portrait"],
    customerApprovalDueAt: "2026-07-25T12:00:00.000Z", createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:00:00.000Z",
  };
}
