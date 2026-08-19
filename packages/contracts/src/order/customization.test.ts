import { createEntityId } from "../common/ids.js";
import { describe, expect, it } from "vitest";

import {
  InitializeOrderCustomizationInputSchema,
  RecordCustomerProofDecisionInputSchema,
  RemapOrderCustomizationInputSchema,
  RegisterOrderCustomizationFileInputSchema,
} from "./customization.js";

describe("order customization contracts", () => {
  it("requires an explicit customer approval deadline", () => {
    expect(InitializeOrderCustomizationInputSchema.safeParse({
      orderLineId: createEntityId(), fulfillmentPath: "customer_approval_required",
    }).success).toBe(false);
    expect(InitializeOrderCustomizationInputSchema.safeParse({
      orderLineId: createEntityId(), fulfillmentPath: "customer_approval_required", customerApprovalDueAt: "2026-07-25T12:00:00.000Z",
    }).success).toBe(true);
  });

  it("accepts only hashed quarantine file metadata, not file bytes or URLs", () => {
    const safe = {
      fieldKey: "portrait", fileName: "customer.png", mediaType: "image/png", byteSize: 1024,
      checksumSha256: "a".repeat(64), objectKey: `tenants/${createEntityId()}/quarantine/${"a".repeat(64)}/customer.png`,
    };
    expect(RegisterOrderCustomizationFileInputSchema.safeParse(safe).success).toBe(true);
    expect(RegisterOrderCustomizationFileInputSchema.safeParse({ ...safe, sourceUrl: "https://private.example.test/file" }).success).toBe(false);
  });

  it("requires a static reason code for customer rejection", () => {
    expect(RecordCustomerProofDecisionInputSchema.safeParse({ decision: "rejected", externalDecisionId: "decision-1" }).success).toBe(false);
    expect(RecordCustomerProofDecisionInputSchema.safeParse({ decision: "rejected", externalDecisionId: "decision-1", reasonCode: "CUSTOMER_REQUESTED_CHANGE" }).success).toBe(true);
  });

  it("requires optimistic concurrency when remapping protected customization values", () => {
    expect(RemapOrderCustomizationInputSchema.safeParse({ expectedVersionNumber: 1 }).success).toBe(true);
    expect(RemapOrderCustomizationInputSchema.safeParse({ expectedVersionNumber: 0 }).success).toBe(false);
    expect(RemapOrderCustomizationInputSchema.safeParse({ expectedVersionNumber: 1, values: { name: "PII" } }).success).toBe(false);
  });
});
