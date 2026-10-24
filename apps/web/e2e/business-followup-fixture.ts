import { createEntityId } from "@yummyai/contracts";
import {
  FollowupDetailViewSchema,
  type FollowupSource,
} from "@yummyai/contracts/operations/followup";
import {
  connectDatabase,
  fulfillmentSuppliers,
  orderWorkItems,
  withTenant,
} from "@yummyai/database";
import { FollowupAttentionDispatcher } from "../../../packages/followup-core/src/index";
import { eq } from "drizzle-orm";
import { orderResponsibilityFixture } from "./order-responsibility-fixture";
export async function businessFollowupFixture(source: FollowupSource) {
  const base = await orderResponsibilityFixture(),
    database = connectDatabase(),
    context = base.context;
  try {
    let id: string;
    if (source === "procurement_order") {
      const supplier = createEntityId(),
        code = createEntityId().toUpperCase();
      await withTenant(database.db, context, (tx) =>
        tx
          .insert(fulfillmentSuppliers)
          .values({
            id: supplier,
            tenantId: context.tenantId,
            name: "合成供应商 用于长名称与手机验收 " + supplier,
            kind: "manual",
            status: "active",
            regionCode: "US",
            settlementCurrency: "USD",
            priority: 1,
            createdBy: context.userId,
          }),
      );
      const warehouse = await base.api<{ id: string }>("inventory/warehouses", {
        code: "WH-" + code,
        name: "Synthetic receiving",
        type: "owned",
        countryCode: "US",
        timeZone: "America/Los_Angeles",
      });
      const location = await base.api<{ id: string }>("inventory/locations", {
        warehouseId: warehouse.id,
        code: "RECEIVE-" + code,
        name: "Synthetic receiving",
      });
      const stock = await base.api<{ id: string }>("inventory/stock-items", {
        skuId: null,
        code: "STOCK-" + code,
        name: "Synthetic blank",
        baseUnit: "each",
      });
      id = (
        await base.api<{ id: string }>("procurement/purchase-orders", {
          code: "PO-" + code,
          supplierId: supplier,
          requisitionId: null,
          quoteId: null,
          currency: "USD",
          expectedAt: "2099-06-01T00:00:00.000Z",
          lines: [
            {
              lineKey: "ONE",
              stockItemId: stock.id,
              destinationLocationId: location.id,
              quantity: 10,
              unit: "each",
              unitCostMinor: 50,
            },
          ],
          idempotencyKey: createEntityId(),
        })
      ).id;
    } else if (source === "after_sales_case")
      id = (
        await base.api<{ case: { id: string } }>(`order-centers/lines/${base.lineId}/cases`, {
          type: "quality_issue",
          reasonCode: "SYNTHETIC",
          summary: "合成售后验收资料",
          idempotencyKey: createEntityId(),
        })
      ).case.id;
    else id = ((await base.exception()) as { id: string }).id;
    return {
      ...base,
      id,
      source,
      view: async () =>
        FollowupDetailViewSchema.parse(await base.api(`business-followups/${source}/${id}`)),
      business: async () =>
        source === "procurement_order"
          ? base.api("procurement/workspace")
          : base.api(`orders/${base.orderId}`),
      change: () =>
        source === "procurement_order"
          ? base.api(`procurement/purchase-orders/${id}/reviews`, {
              expectedVersion: 1,
              decision: "approved",
              reasonCode: "SYNTHETIC",
              idempotencyKey: createEntityId(),
            })
          : base.exception(),
      async expire(expired: boolean) {
        await withTenant(database.db, context, (tx) =>
          tx
            .update(orderWorkItems)
            .set({ expiresAt: new Date(expired ? 0 : Date.now() + 86400000) })
            .where(eq(orderWorkItems.id, base.lineId)),
        );
      },
      dispatch: () => new FollowupAttentionDispatcher(database).dispatch(),
      async close() {
        try {
          await base.close();
        } finally {
          await database.client.end();
        }
      },
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
