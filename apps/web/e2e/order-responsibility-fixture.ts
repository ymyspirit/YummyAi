import { createEntityId } from "@yummyai/contracts";
import { createHash } from "node:crypto";
import {
  connectDatabase,
  marketplaceAccounts,
  orderLines,
  withTenant,
  orderLineResponsibilities,
  orders,
  orderSourceSnapshots,
  orderProtectedDetails,
  orderEvents,
} from "@yummyai/database";
import {
  OrderLineAttentionDispatcher,
  OrderLineResponsibilityCoordinator,
} from "../../../packages/order-core/src/index";
import { eq } from "drizzle-orm";
import { workflowOperatorFixture, workflowApi } from "./workflow-operator-fixture";
import { centerApi } from "./order-centers-fixture";
import { createOrderPiiVault } from "../../api/src/orders/order-pii-vault";
export async function orderResponsibilityFixture(labelPrefix = "") {
  const base = await workflowOperatorFixture(),
    database = connectDatabase(),
    context = base.context,
    accountId = createEntityId(),
    externalId = createEntityId();
  try {
    await withTenant(database.db, context, (tx) =>
      tx.insert(marketplaceAccounts).values({
        id: accountId,
        tenantId: context.tenantId,
        platform: "etsy",
        displayName: "Synthetic follow-up " + accountId,
        region: "GLOBAL",
        authorizationMode: "etsy_oauth",
        createdBy: context.userId,
      }),
    );
    const order = { id: createEntityId() },
      lineId = createEntityId(),
      snapshotId = createEntityId(),
      redacted = { fixture: externalId };
    const protectedDetails = {
      buyer: { name: "Synthetic Buyer", email: null, phone: null },
      shippingAddress: {
        recipient: "Synthetic Buyer",
        lines: ["1 Test Street"],
        city: "Test",
        region: "CA",
        postalCode: "00000",
        countryCode: "US",
      },
      customizations: [],
    };
    // Provision source data only. Responsibility, exception and archival actions use the real API.
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(orderSourceSnapshots).values({
        id: snapshotId,
        tenantId: context.tenantId,
        accountId,
        platform: "etsy",
        externalEventId: externalId + ":v1",
        externalOrderId: externalId,
        normalizedOrderId: order.id,
        redactedPayload: redacted,
        payloadChecksum: createHash("sha256").update(JSON.stringify(redacted)).digest("hex"),
      });
      await tx.insert(orders).values({
        id: order.id,
        tenantId: context.tenantId,
        accountId,
        sourceSnapshotId: snapshotId,
        platform: "etsy",
        externalOrderId: externalId,
        providerStatus: "paid",
        lineCount: 1,
        placedAt: new Date(),
        orderTotalMinor: 1000,
        orderCurrency: "USD",
        addressStatus: "protected",
        addressCountryCode: "US",
      });
      await tx.insert(orderLines).values({
        id: lineId,
        tenantId: context.tenantId,
        orderId: order.id,
        externalLineId: externalId + "-1",
        title: labelPrefix + " 合成验收商品 用于责任与提醒验证 " + externalId,
        quantity: 1,
        unitPriceMinor: 1000,
        unitPriceCurrency: "USD",
      });
      await tx.insert(orderProtectedDetails).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        orderId: order.id,
        encryptedEnvelope: createOrderPiiVault().encrypt(JSON.stringify(protectedDetails)),
        countryCode: "US",
        retentionExpiresAt: new Date(Date.now() + 86400000),
      });
      await tx.insert(orderEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        orderId: order.id,
        sequence: 1,
        type: "order_ingested",
        toWorkflowState: "pending",
        actorUserId: context.userId,
        idempotencyKey: externalId,
        metadata: { fixture: true },
      });
    });
    await centerApi(`order-centers/lines/${lineId}/platform-deadline`, {
      expectedProjectionVersion: 0,
      shipByAt: null,
      evidenceReference: "Synthetic fixture only",
      idempotencyKey: createEntityId(),
    });
    return {
      context,
      lineId,
      orderId: order.id,
      externalId,
      permissions: base.permissions,
      view: () => new OrderLineResponsibilityCoordinator(database).get(context, lineId),
      exception: async () => {
        const basis = await workflowApi<{ orderSequence: number; sourceChecksum: string }>(`orders/${order.id}/exception-operations`);
        return workflowApi(`orders/${order.id}/exceptions`, {
          expectedOrderSequence: basis.orderSequence,
          expectedSourceChecksum: basis.sourceChecksum,
          category: "address",
          code: "SYNTHETIC_FOLLOW_UP",
          message: "Synthetic fixture exception",
          idempotencyKey: createEntityId(),
        });
      },
      dispatch: async () => {
        await withTenant(database.db, context, (tx) =>
          tx
            .update(orderLineResponsibilities)
            .set({ attentionNextAt: new Date(0) })
            .where(eq(orderLineResponsibilities.workItemId, lineId)),
        );
        return new OrderLineAttentionDispatcher(database).dispatch();
      },
      async close() {
        try {
          await base.permissions();
          const view = await new OrderLineResponsibilityCoordinator(database).get(context, lineId);
          await centerApi(`order-centers/lines/${lineId}/archive`, {
            expectedProjectionVersion: view.businessProjectionVersion,
            archived: true,
            reason: "Synthetic fixture teardown",
            idempotencyKey: createEntityId(),
          });
        } finally {
          try {
            await base.close();
          } finally {
            await database.client.end();
          }
        }
      },
      api: workflowApi,
    };
  } catch (error) {
    try {
      await base.close();
    } finally {
      await database.client.end();
    }
    throw error;
  }
}
