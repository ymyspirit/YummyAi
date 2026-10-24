import { describe, expect, it } from "vitest";
import {
  FulfillmentCommandKindSchema, FulfillmentCommandQuerySchema, FulfillmentCommandReceiptSchema,
  FulfillmentCommandViewSchema, PrepareFulfillmentCommandSchema, fulfillmentCommandCanonicalJson,
  fulfillmentCommandRequestKey, normalizeFulfillmentCommand, type FulfillmentCommandKind,
} from "./fulfillment-command.js";

const id = "01999cab-abcd-7000-8000-000000000001";
const other = "01999cab-abcd-7000-8000-000000000002";
const requestId = "64f9ae8a-c894-4fb2-8589-f93e0293a010";
const key = "76f9ae8a-c894-4fb2-8589-f93e0293a011";
const now = "2026-10-23T00:00:00.000Z";
const hash = "a".repeat(64);
const evidence = { code: "SYNTHETIC_ONLY", note: "Authored Mixed CASE remains original", assetIds: [] };
const assessment = { formatVersion: 2, criterionResults: [{ code: "PRINT", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] };
const line = { lineId: id, quantity: 1, expectedRevision: 0, expectedProjectionVersion: 0 };
const productionLine = { ...line, productionOrderId: id, expectedProductionProjectionVersion: 1 };
const shipping = { shipDate: now, shipFromCountryCode: "US", idempotencyKey: key, packages: [{
  packageReferenceId: "ORIGINAL-1", trackingNumber: "SYNTHETIC-1", carrierCode: "SYNTHETIC", carrierName: "Synthetic only",
  carrierService: "Synthetic only", lines: [{ orderLineId: id, quantity: 1 }],
}] };

function command(kind: FulfillmentCommandKind) {
  const inputs: Record<FulfillmentCommandKind, unknown> = {
    delivery_create: { factoryId: id, supplierId: id, items: [{ productionOrderId: id, productionVersionId: id, expectedProjectionVersion: 1 }], idempotencyKey: key },
    delivery_feedback: { kind: "submitted", expectedSequence: 0, fileChecksum: hash, idempotencyKey: key,
      reference: "SYNTHETIC", note: "Synthetic original submission", occurredAt: now, verifiedByOperator: true },
    production_milestone: { type: "started", expectedProjectionVersion: 1, externalEventId: key, occurredAt: now, evidence },
    quality_inspection: { qualityStandardVersionId: id, expectedProductionProjectionVersion: 1, result: "passed", scoreBps: 10000,
      inspectedAt: now, assessment, defects: [], evidenceAssetIds: [], idempotencyKey: key },
    quality_group_inspection: { formatVersion: 3, productionVersionId: id, expectedProductionProjectionVersion: 1, expectedRootInspectionId: null,
      qualityStandardVersionId: id, inspectedAt: now, segregationConfirmed: true, idempotencyKey: key,
      groups: [{ key: "good", label: "Synthetic original bin", quantity: 1, criterionResults: assessment.criterionResults, defects: [] }] },
    production_recovery: { type: "remake", originalProductionOrderId: id, reason: "Authored Mixed CASE remains original", remakeQuantity: 1,
      expectedCompletionAt: "2026-10-24T00:00:00.000Z", idempotencyKey: key },
    whole_production_milestone: { type: "started", occurredAt: now, evidence, items: [productionLine], idempotencyKey: key },
    whole_quality_inspection: { qualityStandardVersionId: id, scoreBps: 10000, inspectedAt: now, assessment,
      evidenceAssetIds: [], items: [productionLine], idempotencyKey: key },
    shipment_create: shipping,
    whole_shipment_create: { items: [line], trackingNumber: "SYNTHETIC-1", carrierCode: "SYNTHETIC", carrierName: "Synthetic only",
      carrierService: "Synthetic only", shipFromCountryCode: "US", shipDate: now, idempotencyKey: key },
    shipment_version: { ...shipping, expectedCurrentVersion: 1 },
    shipment_review: { decision: "approved", reasonCode: "SYNTHETIC", reason: "Synthetic exact package review", expectedCurrentVersion: 1, idempotencyKey: key },
    shipment_dispatch: { expectedVersion: 1, reason: "Synthetic actual handover attestation", occurredAt: now, idempotencyKey: key },
    shipment_platform_confirmation: { expectedVersion: 1, evidenceReference: "Synthetic operator check only", confirmedAt: now, idempotencyKey: key },
  };
  return PrepareFulfillmentCommandSchema.parse({ kind, requestId, targetId: id, input: inputs[kind],
    ...(kind === "delivery_feedback" ? { packageId: other } : {}), ...(kind === "shipment_review" ? { versionId: other } : {}) });
}

describe("original fulfillment command contracts", () => {
  it("accepts all fourteen finite original owner inputs and retains their original business key", () => {
    expect(FulfillmentCommandKindSchema.options).toHaveLength(14);
    for (const kind of FulfillmentCommandKindSchema.options) {
      const value = command(kind);
      expect(value.kind).toBe(kind);
      expect(fulfillmentCommandRequestKey(value)).toBe(key);
      expect(value.requestId).toBe(requestId);
    }
  });

  it("rejects arbitrary routes, execution flags and unknown fields without weakening original owner validation", () => {
    for (const kind of FulfillmentCommandKindSchema.options) {
      const value = command(kind);
      for (const extra of [{ path: "/v1/arbitrary" }, { execute: true }, { acknowledged: true }, { tenantId: other }])
        expect(PrepareFulfillmentCommandSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    }
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...command("shipment_dispatch"), kind: "marketplace_submit" }).success).toBe(false);
    const feedback = command("delivery_feedback");
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...feedback, input: { ...feedback.input, verifiedByOperator: false } }).success).toBe(false);
    const milestone = command("production_milestone");
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...milestone, input: { ...milestone.input, externalEventId: null } }).success).toBe(false);
  });

  it("rejects noncanonical nested entity references and a recovery that targets a different original production", () => {
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...command("shipment_dispatch"), requestId: requestId.toUpperCase() }).success).toBe(false);
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...command("shipment_dispatch"), targetId: id.toUpperCase() }).success).toBe(false);
    const feedback = command("delivery_feedback");
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...feedback, packageId: other.toUpperCase() }).success).toBe(false);
    const delivery = command("delivery_create");
    if (delivery.kind !== "delivery_create") throw new Error("Synthetic delivery contract expected");
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...delivery, input: { ...delivery.input,
      items: [{ ...delivery.input.items[0]!, productionVersionId: other.toUpperCase() }] } }).success).toBe(false);
    expect(PrepareFulfillmentCommandSchema.safeParse({ ...command("production_recovery"), targetId: other }).success).toBe(false);
  });

  it("canonicalizes only unordered owner selections without mutating the authored source", () => {
    const whole = command("whole_production_milestone");
    if (whole.kind !== "whole_production_milestone") throw new Error("Synthetic whole command expected");
    const value = { ...whole, input: { ...whole.input, items: [{ ...productionLine, lineId: other, productionOrderId: other }, productionLine] } };
    const before = JSON.stringify(value), reverse = { ...value, input: { ...value.input, items: [...value.input.items].reverse() } };
    expect(fulfillmentCommandCanonicalJson(value)).toBe(fulfillmentCommandCanonicalJson(reverse));
    expect(normalizeFulfillmentCommand(value).input).toBeDefined();
    expect(JSON.stringify(value)).toBe(before);
    expect(fulfillmentCommandCanonicalJson(value)).toContain(evidence.note);
    const changed = { ...value, input: { ...value.input, evidence: { ...evidence, note: "Changed original evidence" } } };
    expect(fulfillmentCommandCanonicalJson(changed)).not.toBe(fulfillmentCommandCanonicalJson(value));
    expect(fulfillmentCommandCanonicalJson({ ...value, requestId: key })).not.toBe(fulfillmentCommandCanonicalJson(value));
  });

  it("requires a matching strict original receipt for success and never exposes an acknowledged receipt as executable", () => {
    const view = { id, requestId, requestChecksum: hash, kind: "shipment_create", targetId: id, orderId: id, lineIds: [id],
      status: "succeeded", createdAt: now, expiresAt: "2026-10-24T00:00:00.000Z", leaseExpiresAt: null,
      acknowledged: false, canExecute: false, canCancel: false, summary: { orderNumber: "SYNTHETIC", lineCount: 1, label: "Synthetic original" },
      receipt: { kind: "shipment_create", shipmentId: id, versionId: other, versionNumber: 1 }, errorCode: null };
    expect(FulfillmentCommandViewSchema.parse(view).receipt).toEqual(view.receipt);
    expect(FulfillmentCommandViewSchema.safeParse({ ...view, receipt: null }).success).toBe(false);
    expect(FulfillmentCommandViewSchema.safeParse({ ...view, receipt: { ...view.receipt, kind: "shipment_version" } }).success).toBe(false);
    expect(FulfillmentCommandReceiptSchema.safeParse({ ...view.receipt, token: "not-an-original-receipt-field" }).success).toBe(false);
    const acknowledged = { ...view, status: "acknowledged", acknowledged: true, summary: null, receipt: null };
    expect(FulfillmentCommandViewSchema.parse(acknowledged).status).toBe("acknowledged");
    expect(FulfillmentCommandViewSchema.safeParse({ ...acknowledged, canExecute: true }).success).toBe(false);
  });

  it("requires the exact request ID and checksum together for a read-only lookup", () => {
    expect(FulfillmentCommandQuerySchema.parse({ orderId: id, requestId, requestChecksum: hash })).toMatchObject({ requestId, requestChecksum: hash });
    for (const query of [{ orderId: id, requestId }, { orderId: id, requestChecksum: hash }, { orderId: id, requestId, requestChecksum: hash, input: {} },
      { orderId: id, requestId, requestChecksum: "a".repeat(63) }, { orderId: id.toUpperCase() }])
      expect(FulfillmentCommandQuerySchema.safeParse(query).success).toBe(false);
  });
});
