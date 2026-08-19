import { describe, expect, it } from "vitest";

import {
  CreateAfterSalesCaseInputSchema,
  DecideAfterSalesCaseInputSchema,
  RecordCustomerContactInputSchema,
} from "./after-sales.js";

describe("after-sales contracts", () => {
  it("accepts a bounded case and protected contact record", () => {
    expect(CreateAfterSalesCaseInputSchema.parse({
      type: "quality_issue",
      reasonCode: "PRINT_DEFECT",
      summary: "Customer reported a print defect.",
      idempotencyKey: "case-quality-0001",
    })).toMatchObject({ type: "quality_issue" });
    expect(RecordCustomerContactInputSchema.parse({
      channel: "marketplace",
      direction: "inbound",
      body: "The print is damaged.",
      externalMessageId: "message-1",
      occurredAt: "2026-07-22T10:00:00.000Z",
      idempotencyKey: "contact-message-0001",
    })).toMatchObject({ direction: "inbound" });
  });

  it("requires refund money only for refund resolutions", () => {
    expect(() => DecideAfterSalesCaseInputSchema.parse({
      resolution: "full_refund",
      refundAmountMinor: null,
      refundCurrency: null,
      returnRequired: false,
      responsibilityParty: "supplier",
      reasonCode: "DEFECT",
      reason: "Refund approved.",
      expectedDecisionVersion: 0,
      idempotencyKey: "decision-refund-0001",
    })).toThrow();
    expect(() => DecideAfterSalesCaseInputSchema.parse({
      resolution: "replacement",
      refundAmountMinor: 100,
      refundCurrency: "USD",
      returnRequired: false,
      responsibilityParty: "supplier",
      reasonCode: "DEFECT",
      reason: "Replacement approved.",
      expectedDecisionVersion: 0,
      idempotencyKey: "decision-replace-0001",
    })).toThrow();
  });
});
