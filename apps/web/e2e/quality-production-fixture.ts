import { randomUUID } from "node:crypto";
import type { WholeOrderFulfillmentView } from "@yummyai/contracts/order/whole-fulfillment";
import type { ProductionDeliveryPackageView, ProductionDeliveryWorkspace } from "@yummyai/contracts/order/production-delivery";
import { centerApi } from "./order-centers-fixture";
import { prepareWholePillows } from "./whole-order-fixture";
const plan = (orderId: string) => centerApi<WholeOrderFulfillmentView>("order-centers/orders/" + orderId + "/fulfillment");
export async function completedPillows(count: number, quantityPerLine = 1) {
  const order = await prepareWholePillows(count, quantityPerLine), ready = await plan(order.orderId);
  const factory = ready.factories.find(row => row.factoryId === order.factoryId)!;
  await centerApi("order-centers/orders/" + order.orderId + "/release", {
    supplierId: factory.supplierId, factoryId: factory.factoryId, factoryVersionId: factory.factoryVersionId,
    items: ready.items.map(item => ({ ...linePin(item), renderId: item.renderId,
      manufacturing: { versionId: order.manufacturing.versionId, orderUnitConfirmed: true },
      capacityPlan: order.capacityPlan,
      capabilityVersionId: factory.items.find(row => row.lineId === item.lineId)!.capabilityVersionId })),
    expectedCompletionAt: order.capacity.expectedCompletionAt, instructions: "Synthetic controlled factory handoff", idempotencyKey: randomUUID(),
  });
  const deliveries = await centerApi<ProductionDeliveryWorkspace>("order-centers/deliveries?order=" + order.orderId);
  let delivery = await centerApi<ProductionDeliveryPackageView>("order-centers/deliveries", {
    supplierId: order.supplierId, factoryId: order.factoryId,
    items: deliveries.candidates.map(item => ({ productionOrderId: item.productionOrderId,
      productionVersionId: item.productionVersionId, expectedProjectionVersion: item.projectionVersion })), idempotencyKey: randomUUID(),
  });
  for (const original of delivery.items) for (const kind of ["submitted", "received", "accepted"] as const) {
    const item = delivery.items.find(row => row.id === original.id)!;
    delivery = await centerApi("order-centers/deliveries/" + delivery.id + "/items/" + item.id + "/feedback", {
      kind, expectedSequence: item.sequence, fileChecksum: item.snapshot!.file.checksum,
      manufacturingChecksum: item.snapshot!.manufacturing!.plan.checksum,
      reference: "Synthetic exact file " + kind, note: "Synthetic fixture receipt only; no external factory contacted",
      occurredAt: new Date().toISOString(), verifiedByOperator: true, idempotencyKey: randomUUID(),
    });
  }
  for (const type of ["started", "completed"] as const) {
    const current = await plan(order.orderId);
    await centerApi("order-centers/orders/" + order.orderId + "/production-progress", {
      type, items: current.items.map(item => ({ ...linePin(item), productionOrderId: item.production!.id,
        expectedProductionProjectionVersion: item.production!.projectionVersion })), occurredAt: new Date().toISOString(),
      evidence: { code: "SYNTHETIC_" + type.toUpperCase(), note: null, assetIds: [] }, idempotencyKey: randomUUID(),
    });
  }
  return order;
}
function linePin(item: WholeOrderFulfillmentView["items"][number]) {
  return { lineId: item.lineId, quantity: item.quantity, expectedRevision: item.expectedRevision, expectedProjectionVersion: item.expectedProjectionVersion };
}
