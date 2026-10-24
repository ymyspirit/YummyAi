/** Isolated test setup only. Current purchases are received through the actual
 * arrival/measurement/review/posting owners; no production gate is disabled. */
import { createHash } from "node:crypto";
import { RecordProcurementReceiptInputSchema, type RecordProcurementReceiptInput, type TenantContext } from "@yummyai/contracts";
import { compareStockQuantity, sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import type { ProcurementService } from "./procurement.service.js";
import type { IncomingInspectionService } from "./incoming-inspection.service.js";

const key = (value: string, stage: string) => createHash("sha256").update(`${stage}:${value}`).digest("hex");

export async function prepareInspectedReceiptFixture(procurement: ProcurementService, incoming: IncomingInspectionService,
  context: TenantContext, orderId: string, raw: RecordProcurementReceiptInput) {
  const input = RecordProcurementReceiptInputSchema.parse(raw);
  const workspace = await incoming.workspace(context, orderId);
  const procurementWorkspace = await procurement.workspace(context);
  const order = procurementWorkspace.purchaseOrders.find(item => item.id === orderId.toLowerCase());
  if (!order) throw new Error("Synthetic original purchase was not found");
  const standards = new Map<string, string>();
  for (const line of input.lines) {
    const original = order.lines.find(item => item.lineKey === line.lineKey);
    if (!original) throw new Error("Synthetic original purchase line was not found");
    const old = workspace.standards.find(item => item.stockItemId === original.stockItemId && item.code === "TEST-INCOMING");
    const standard = old ?? await incoming.publishStandard(context, { code: "TEST-INCOMING", stockItemId: original.stockItemId,
      expectedVersion: 0, title: "Synthetic fixture acceptance", sourceReference: "Isolated controlled fixture observations; no actual factory or supplier acceptance",
      criteria: [{ code: "FIXTURE-OBSERVATION", label: "合成夹具观测", kind: "one_of", acceptedValues: ["SYNTHETIC-RECORDED"] }],
      idempotencyKey: key(original.stockItemId, "standard") });
    standards.set(line.lineKey, standard.id);
  }
  const arrival = await incoming.recordArrival(context, orderId, { code: `TAR.${key(input.idempotencyKey, "code").slice(0, 40).toUpperCase()}`,
    expectedPurchaseOrderVersion: input.expectedVersion, arrivedAt: input.receivedAt,
    externalReference: input.externalReference ?? "Synthetic controlled receipt fixture", idempotencyKey: key(input.idempotencyKey, "arrival"),
    lines: input.lines.map(line => { const original = order.lines.find(item => item.lineKey === line.lineKey)!; return {
      lineKey: line.lineKey, quantity: sumStockQuantities([line.receivedQuantity, line.rejectedQuantity]), unit: original.unit,
      holdingLocationId: original.destinationLocationId,
      // An explicit additional synthetic custody fact for rejection-only tests;
      // this is not inferred, migrated or used for real supplier data.
      lotCode: line.lotCode ?? `TEST-RETURN.${key(input.idempotencyKey, line.lineKey).slice(0, 20).toUpperCase()}`, expiresAt: line.expiresAt,
    }; }) });
  const prepared: Array<{ lineId: string; reviewId: string; line: RecordProcurementReceiptInput["lines"][number] }> = [];
  for (const line of input.lines) {
    const original = arrival.lines.find(item => item.lineKey === line.lineKey)!;
    const quantity = sumStockQuantities([line.receivedQuantity, line.rejectedQuantity]);
    const inspected = await incoming.recordInspection(context, original.id, { expectedInspectionVersion: 0,
      standardVersionId: standards.get(line.lineKey)!, acceptedQuantity: line.receivedQuantity, rejectedQuantity: line.rejectedQuantity,
      sampleQuantity: compareStockQuantity(quantity, 1) < 0 ? quantity : 1,
      rejectionReason: compareStockQuantity(line.rejectedQuantity, 0) > 0 ? line.rejectionReasonCode : null,
      measuredAt: input.receivedAt, readings: [{ criterionCode: "FIXTURE-OBSERVATION", value: "SYNTHETIC-RECORDED", unit: null }],
      notes: null, idempotencyKey: key(input.idempotencyKey, `inspection:${line.lineKey}`) });
    const reviewed = await incoming.reviewInspection(context, original.id, { expectedInspectionVersion: 1,
      inspectionId: inspected.inspections[0]!.id, decision: "approved", reason: "Synthetic fixture observation and quantities reviewed",
      idempotencyKey: key(input.idempotencyKey, `review:${line.lineKey}`) });
    prepared.push({ lineId: original.id, reviewId: reviewed.inspections[0]!.review!.id, line });
  }
  return {
    async execute() {
      if (prepared.length !== 1) throw new Error("Use separate actual line postings for a multi-line synthetic receipt");
      const { lineId, reviewId, line } = prepared[0]!;
      const result = await incoming.postInspection(context, lineId, { expectedInspectionVersion: 1, approvalId: reviewId,
        acceptedQuantity: line.receivedQuantity, rejectedQuantity: line.rejectedQuantity,
        rejectionLocationId: compareStockQuantity(line.rejectedQuantity, 0) > 0 ? order.lines.find(item => item.lineKey === line.lineKey)!.destinationLocationId : null,
        ownershipConfirmation: compareStockQuantity(line.receivedQuantity, 0) > 0 ? "merchant_received" : null,
        postedAt: input.receivedAt, idempotencyKey: input.idempotencyKey });
      const posting = result.postings.find(item => item.approvalId === reviewId)!;
      const current = await procurement.workspace(context);
      const receipt = current.receipts.find(item => item.id === posting.receiptId), purchaseOrder = current.purchaseOrders.find(item => item.id === order.id);
      if (!receipt || !purchaseOrder) throw new Error("Synthetic committed receipt unavailable");
      return { receipt, purchaseOrder };
    },
  };
}

export async function recordInspectedReceiptFixture(procurement: ProcurementService, incoming: IncomingInspectionService,
  context: TenantContext, orderId: string, input: RecordProcurementReceiptInput) {
  return (await prepareInspectedReceiptFixture(procurement, incoming, context, orderId, input)).execute();
}
