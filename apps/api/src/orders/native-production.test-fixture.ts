import { randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, withTenant, orders, routingPolicyVersions, orderRoutingDecisions, purchaseOrders, purchaseOrderVersions } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { OrderService } from "./order.service.js";
import { AuditService } from "../audit/audit.service.js";
import { syntheticNativeManufacturingForLine } from "./manufacturing-production.test-fixture.js";

export async function syntheticNativeProductionOrder(context: TenantContext, input: { accountId: string; supplierId: string; externalId: string; sourcePng: Uint8Array }) {
  requireDisposableIntegrationEnvironment(); const db = connectDatabase();
  const orderService = new OrderService(db, new SecretVault(Buffer.alloc(32, 42)), new AuditService(db));
  try {
    // No customer envelope is supplied, fabricated or backfilled. Approvals are explicit disposable fixtures.
    const order = await orderService.ingestNormalized(context, { accountId: input.accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId: input.externalId, providerStatus: "paid",
      placedAt: new Date().toISOString(), orderTotal: null, lines: [{ externalLineId: "synthetic-native-line", externalListingId: null, skuCode: input.externalId,
        title: `Synthetic native product ${input.externalId}`, quantity: 3, unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
    const lineId = order.lines[0]!.id, product = await syntheticNativeManufacturingForLine(db, context, lineId, {
      productType: "rectangular_print", productionFile: { body: input.sourcePng, name: `synthetic-native-${lineId}.png` },
    });
    const policyId = createEntityId(), decisionId = createEntityId(), purchaseId = createEntityId(), purchaseVersionId = createEntityId();
    await withTenant(db.db, context, async tx => {
      await tx.update(orders).set({ workflowState: "in_production" }).where(eq(orders.id, order.id));
      await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId: context.tenantId, name: `Synthetic routing ${policyId}`, versionNumber: 1,
        weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 },
        thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 },
        tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: context.userId });
      await tx.insert(orderRoutingDecisions).values({ id: decisionId, tenantId: context.tenantId, orderId: order.id, orderLineId: lineId, routingPolicyVersionId: policyId,
        versionNumber: 1, status: "approved", selectedSupplierId: input.supplierId, inputChecksum: "a".repeat(64), requiresApproval: false, approvalReasons: [], idempotencyKey: randomUUID() });
      await tx.insert(purchaseOrders).values({ id: purchaseId, tenantId: context.tenantId, supplierId: input.supplierId, orderId: order.id, status: "approved", createdBy: context.userId });
      await tx.insert(purchaseOrderVersions).values({ id: purchaseVersionId, tenantId: context.tenantId, purchaseOrderId: purchaseId, versionNumber: 1, currency: "USD", totalMinor: 3,
        lineSnapshot: [{ orderLineId: lineId, quantity: 3, unitCostMinor: 1 }], routingDecisionIds: [decisionId], checksum: "b".repeat(64), createdBy: context.userId });
    });
    return { externalId: input.externalId, lineId, orderId: order.id, ...product, routingDecisionId: decisionId, purchaseOrderVersionId: purchaseVersionId };
  } finally { await db.client.end(); }
}
