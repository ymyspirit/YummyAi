import { describe, expect, it } from "vitest";
import {
  IncomingMeasurementNumberSchema, PublishIncomingStandardInputSchema, RecordIncomingArrivalInputSchema,
  RecordIncomingInspectionInputSchema, PostIncomingInspectionInputSchema,
  evaluateIncomingReadings, incomingLineQuantities, type IncomingCriterion,
} from "./incoming.js";

const stock = "01900000-0000-7000-8000-000000000001";
const numeric: IncomingCriterion = { code: "WIDTH", label: "宽度", kind: "numeric_range", unit: "mm", minimum: "9.999999999", maximum: "10.000000001" };
const choice: IncomingCriterion = { code: "SURFACE", label: "外观", kind: "one_of", acceptedValues: ["完整", "符合封样"] };

describe("incoming inspection contracts", () => {
  it.each([["-0.000000000", "0"], ["10.100000000", "10.1"], ["-999999999999.123456789", "-999999999999.123456789"]])("normalizes exact measurement %s", (value, expected) => {
    expect(IncomingMeasurementNumberSchema.parse(value)).toBe(expected);
  });
  it.each(["1e2", "1.0000000001", "NaN", "Infinity", "0001", "1000000000000"]) ("rejects invalid measurement %s", value => {
    expect(IncomingMeasurementNumberSchema.safeParse(value).success).toBe(false);
  });
  it("uses exact inclusive limits and matching measurement units", () => {
    const check = (value: string, unit = "mm") => evaluateIncomingReadings([numeric], [{ criterionCode: "WIDTH", value, unit }]);
    expect(check("9.999999999").passed).toBe(true);
    expect(check("10.000000001").passed).toBe(true);
    expect(check("10.000000002")).toMatchObject({ passed: false, complete: true });
    expect(check("10", "cm")).toMatchObject({ passed: false, complete: false });
    expect(check("ten")).toMatchObject({ passed: false, complete: false });
  });
  it("keeps missing and failed qualitative evidence separate", () => {
    expect(evaluateIncomingReadings([numeric, choice], []).items.map(item => item.result)).toEqual(["missing", "missing"]);
    expect(evaluateIncomingReadings([choice], [{ criterionCode: "SURFACE", value: "破损", unit: null }])).toMatchObject({ complete: true, passed: false });
    expect(evaluateIncomingReadings([choice], [{ criterionCode: "SURFACE", value: "完整", unit: "件" }])).toMatchObject({ complete: false, passed: false });
    expect(evaluateIncomingReadings([choice], [{ criterionCode: "SURFACE", value: "完整", unit: null }]).passed).toBe(true);
  });
  it("cannot invent a criterion or overwrite a duplicated reading", () => {
    expect(() => evaluateIncomingReadings([choice], [{ criterionCode: "OTHER", value: "完整", unit: null }])).toThrow();
    expect(() => evaluateIncomingReadings([choice], [{ criterionCode: "SURFACE", value: "完整", unit: null }, { criterionCode: "SURFACE", value: "破损", unit: null }])).toThrow();
    expect(() => evaluateIncomingReadings([], [])).toThrow();
  });
  it("requires an actual source and meaningful published criteria", () => {
    const input = { code: "FABRIC", stockItemId: stock, expectedVersion: 0, title: "确认的材料标准", sourceReference: "供应商封样 S-01", criteria: [numeric], idempotencyKey: "standard-01" };
    expect(PublishIncomingStandardInputSchema.safeParse(input).success).toBe(true);
    expect(PublishIncomingStandardInputSchema.safeParse({ ...input, sourceReference: " " }).success).toBe(false);
    expect(PublishIncomingStandardInputSchema.safeParse({ ...input, criteria: [{ ...numeric, minimum: null, maximum: null }] }).success).toBe(false);
    expect(PublishIncomingStandardInputSchema.safeParse({ ...input, criteria: [{ ...numeric, minimum: "11", maximum: "10" }] }).success).toBe(false);
    expect(PublishIncomingStandardInputSchema.safeParse({ ...input, criteria: [numeric, numeric] }).success).toBe(false);
  });
  it("records an exact arrival without turning custody into available stock", () => {
    const line = { lineKey: "FABRIC", quantity: "0.123456789", unit: "meter", holdingLocationId: stock, lotCode: "SUPPLIER-LOT-01", expiresAt: null };
    const input = { code: "ARRIVAL-01", expectedPurchaseOrderVersion: 1, arrivedAt: "2026-10-20T08:00:00Z", externalReference: "供应商送货单01", lines: [line], idempotencyKey: "arrival-01" };
    expect(RecordIncomingArrivalInputSchema.parse(input).lines[0]?.quantity).toBe("0.123456789");
    expect(RecordIncomingArrivalInputSchema.safeParse({ ...input, lines: [{ ...line, unit: "each" }] }).success).toBe(false);
    expect(RecordIncomingArrivalInputSchema.safeParse({ ...input, lines: [line, line] }).success).toBe(false);
    expect(RecordIncomingArrivalInputSchema.safeParse({ ...input, availableQuantity: "0.123456789" }).success).toBe(false);
  });
  it("keeps inspected quantity, sampling and rejection reasons consistent", () => {
    const input = { expectedInspectionVersion: 0, standardVersionId: stock, acceptedQuantity: "0.1", rejectedQuantity: "0.023456789", sampleQuantity: "0.01", rejectionReason: "边缘破损", measuredAt: "2026-10-20T08:00:00Z", readings: [], notes: null, idempotencyKey: "inspect-01" };
    expect(RecordIncomingInspectionInputSchema.safeParse(input).success).toBe(true);
    expect(RecordIncomingInspectionInputSchema.safeParse({ ...input, rejectionReason: null }).success).toBe(false);
    expect(RecordIncomingInspectionInputSchema.safeParse({ ...input, sampleQuantity: 1 }).success).toBe(false);
    expect(RecordIncomingInspectionInputSchema.safeParse({ ...input, acceptedQuantity: 0, rejectedQuantity: 0 }).success).toBe(false);
  });
  it("requires an actual rejection holding location for a disposition", () => {
    const input = { expectedInspectionVersion: 1, approvalId: stock, acceptedQuantity: 1, rejectedQuantity: 0, rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: "2026-10-20T08:00:00Z", idempotencyKey: "posting-01" };
    expect(PostIncomingInspectionInputSchema.safeParse(input).success).toBe(true);
    expect(PostIncomingInspectionInputSchema.safeParse({ ...input, rejectedQuantity: 1 }).success).toBe(false);
    expect(PostIncomingInspectionInputSchema.safeParse({ ...input, acceptedQuantity: 0 }).success).toBe(false);
  });
  it("conserves exact partial quantities without counting returns twice", () => {
    expect(incomingLineQuantities("0.123456789", "0.1", "0.02", "0.005")).toEqual({ arrived: "0.123456789", accepted: "0.1", rejected: "0.02", returned: "0.005", pending: "0.003456789", rejectedHeld: "0.015" });
    expect(() => incomingLineQuantities(10, 9, 2, 0)).toThrow(RangeError);
    expect(() => incomingLineQuantities(10, 5, 3, 4)).toThrow(RangeError);
    expect(() => incomingLineQuantities(10, -1, 0, 0)).toThrow();
  });
});
