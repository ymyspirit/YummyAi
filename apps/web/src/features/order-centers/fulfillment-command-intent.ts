import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import {
  fulfillmentCommandCanonicalJson, normalizeFulfillmentCommand,
  type FulfillmentCommandView, type PrepareFulfillmentCommand,
} from "@yummyai/contracts/order/fulfillment-command";

/** The full request exists only in memory and in the original server command.
 * Refresh recovery uses the current person's same-order server list. */
export type FulfillmentCommandIntent = {
  orderId: string;
  command: PrepareFulfillmentCommand;
  requestChecksum: string;
};
export type FulfillmentCommandReference = Pick<FulfillmentCommandIntent, "orderId" | "requestChecksum">
  & { requestId: string; id: string | null };

export async function createFulfillmentCommandIntent(orderId: string, raw: unknown): Promise<FulfillmentCommandIntent> {
  const command = normalizeFulfillmentCommand(raw);
  return { orderId: EntityIdSchema.parse(orderId), command,
    requestChecksum: await agentTransportTextHash(fulfillmentCommandCanonicalJson(command)) };
}

export function fulfillmentCommandMatches(value: FulfillmentCommandView, intent: FulfillmentCommandIntent): boolean {
  return value.orderId === intent.orderId && value.requestId === intent.command.requestId
    && value.requestChecksum === intent.requestChecksum && value.kind === intent.command.kind && value.targetId === intent.command.targetId
    && new Set(value.lineIds).size === value.lineIds.length;
}

/** Finite adapter for the existing operation forms. It never forwards a URL. */
export function fulfillmentCommandForOperation(path: string, input: unknown, context: { orderId: string; lineId?: string; versionId?: string }): PrepareFulfillmentCommand | null {
  const parts = path.split("/"), requestId = crypto.randomUUID();
  if (parts[0] === "lines" && parts.length === 3 && parts[2] === "shipments") {
    if (!context.lineId || EntityIdSchema.parse(parts[1]) !== EntityIdSchema.parse(context.lineId))
      throw new Error("装箱入口不属于当前原商品");
    return normalizeFulfillmentCommand({ kind: "shipment_create", targetId: context.orderId, requestId, input });
  }
  if (parts[0] === "production" && parts.length === 3) {
    const kind = parts[2] === "milestones" ? "production_milestone" : parts[2] === "inspections" ? "quality_inspection"
      : parts[2] === "quality-groups" ? "quality_group_inspection" : null;
    return kind ? normalizeFulfillmentCommand({ kind, targetId: parts[1], requestId, input }) : null;
  }
  if (parts[0] === "orders" && parts.length === 3) {
    const kind = parts[2] === "production-progress" ? "whole_production_milestone" : parts[2] === "quality-pass" ? "whole_quality_inspection"
      : parts[2] === "shipments" ? "whole_shipment_create" : null;
    if (!kind) return null;
    if (parts[1] !== context.orderId) throw new Error("履约提交不属于当前原订单");
    return normalizeFulfillmentCommand({ kind, targetId: context.orderId, requestId, input });
  }
  if (path === "recoveries") {
    if (!input || typeof input !== "object" || !("originalProductionOrderId" in input)) throw new Error("补做缺少原生产来源");
    return normalizeFulfillmentCommand({ kind: "production_recovery", targetId: input.originalProductionOrderId, requestId, input });
  }
  if (parts[0] === "shipments" && parts.length === 3) {
    const kind = parts[2] === "versions" ? "shipment_version" : parts[2] === "review" ? "shipment_review"
      : parts[2] === "dispatch" ? "shipment_dispatch" : parts[2] === "platform-confirmation" ? "shipment_platform_confirmation" : null;
    if (!kind) return null;
    return normalizeFulfillmentCommand({ kind, targetId: parts[1], requestId, input,
      ...(kind === "shipment_review" ? { versionId: context.versionId } : {}) });
  }
  return null;
}

export function fulfillmentCommandReceiptMatches(value: FulfillmentCommandView, command: PrepareFulfillmentCommand): boolean {
  const receipt = value.receipt;
  if (!receipt || receipt.kind !== command.kind) return false;
  switch (command.kind) {
    case "delivery_create": return receipt.kind === "delivery_create" && receipt.itemIds.length === command.input.items.length
      && new Set(receipt.itemIds).size === receipt.itemIds.length;
    case "delivery_feedback": return receipt.kind === "delivery_feedback" && receipt.packageId === command.packageId && receipt.itemId === command.targetId;
    case "production_milestone": return receipt.kind === "production_milestone" && receipt.productionOrderId === command.targetId;
    case "quality_inspection": return receipt.kind === "quality_inspection" && receipt.productionOrderId === command.targetId;
    case "quality_group_inspection": return receipt.kind === "quality_group_inspection" && receipt.productionOrderId === command.targetId
      && new Set(receipt.groupIds).size === receipt.groupIds.length;
    case "production_recovery": return receipt.kind === "production_recovery" && (command.input.type !== "remake" || receipt.replacementProductionOrderId !== null);
    case "whole_production_milestone": {
      if (receipt.kind !== "whole_production_milestone") return false;
      const expected = new Set(command.input.items.map(item => item.productionOrderId));
      return expected.size === receipt.items.length && new Set(receipt.items.map(item => item.productionOrderId)).size === receipt.items.length
        && receipt.items.every(item => expected.has(item.productionOrderId));
    }
    case "whole_quality_inspection": {
      if (receipt.kind !== "whole_quality_inspection") return false;
      const expected = new Set(command.input.items.map(item => item.productionOrderId));
      return expected.size === receipt.items.length && new Set(receipt.items.map(item => item.productionOrderId)).size === receipt.items.length
        && receipt.items.every(item => expected.has(item.productionOrderId));
    }
    case "shipment_create": return receipt.kind === "shipment_create";
    case "whole_shipment_create": return receipt.kind === "whole_shipment_create";
    case "shipment_version": return receipt.kind === "shipment_version" && receipt.shipmentId === command.targetId
      && receipt.versionNumber === command.input.expectedCurrentVersion + 1;
    case "shipment_review": return receipt.kind === "shipment_review" && receipt.shipmentId === command.targetId && receipt.versionId === command.versionId;
    case "shipment_dispatch": return receipt.kind === "shipment_dispatch" && receipt.shipmentId === command.targetId
      && new Set(receipt.trackingEventIds).size === receipt.trackingEventIds.length;
    case "shipment_platform_confirmation": return receipt.kind === "shipment_platform_confirmation" && receipt.shipmentId === command.targetId;
  }
}
