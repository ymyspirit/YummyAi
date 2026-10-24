import { describe, expect, it } from "vitest";
import { DeliveryReviewSchema, DeliverySealSchema } from "./sales-plan-delivery.js";
import { createEntityId } from "../common/ids.js";
const base = () => ({
  expectedRevision: 1,
  expectedFingerprint: "a".repeat(64),
  listingVersionId: createEntityId(),
  imageEvidence: [{ assetId: createEntityId(), kind: "finished_photo" }],
  checks: { skuFacts: true, customization: true, images: true, copyClaims: true },
  note: "Operator evidence",
  idempotencyKey: "36b7990a-0a72-42d5-9cf5-6d99a9596dd4",
});
describe("controlled listing delivery contracts", () => {
  it("requires every manual check and recorded evidence", () => {
    expect(DeliveryReviewSchema.safeParse(base()).success).toBe(true);
    for (const key of Object.keys(base().checks))
      expect(
        DeliveryReviewSchema.safeParse({ ...base(), checks: { ...base().checks, [key]: false } })
          .success,
      ).toBe(false);
    expect(DeliveryReviewSchema.safeParse({ ...base(), note: " " }).success).toBe(false);
  });
  it("rejects caller-selected tenants, asset paths, and approval state", () => {
    for (const extra of [
      { tenantId: createEntityId() },
      { approved: true },
      { objectKey: "research/copied-image" },
    ])
      expect(DeliveryReviewSchema.safeParse({ ...base(), ...extra }).success).toBe(false);
  });
  it("pins exact listing/source versions and seals only an explicit SKU", () => {
    expect(
      DeliveryReviewSchema.safeParse({ ...base(), expectedFingerprint: "unknown" }).success,
    ).toBe(false);
    expect(
      DeliverySealSchema.safeParse({
        reviewId: createEntityId(),
        skuId: createEntityId(),
        expectedFingerprint: "b".repeat(64),
        idempotencyKey: base().idempotencyKey,
      }).success,
    ).toBe(true);
    expect(
      DeliverySealSchema.safeParse({
        reviewId: createEntityId(),
        skuId: createEntityId(),
        expectedFingerprint: "b".repeat(64),
        idempotencyKey: base().idempotencyKey,
        all: true,
      }).success,
    ).toBe(false);
  });
});
