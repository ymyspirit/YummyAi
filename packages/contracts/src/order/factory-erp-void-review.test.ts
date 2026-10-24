import { describe, expect, it } from "vitest";
import {
  ReviewFactoryErpVoidSchema, FactoryErpVoidReviewResultSchema, FactoryErpVoidObservationViewSchema,
  FactoryErpVoidBasisSchema, FactoryErpVoidObservationPageQuerySchema,
} from "./factory-erp-void-review.js";
import { FactoryErpBindingSourceSchema } from "./factory-erp-binding.js";
const id = (n: number) => `01a15e10-0000-7000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64), at = "2026-10-21T09:00:00.000Z";
const observation = { id: id(1), sequence: 7, importId: id(2), rowNumber: 2, rowChecksum: hash, fileChecksum: hash, previewChecksum: hash, recordedAt: at };
const source = { importId: id(3), rowNumber: 3, fileChecksum: hash, previewChecksum: hash };
const input = () => ({ expectedBindingRevision: 2, expectedItemsChecksum: hash, expectedObservationSequence: 9, observation, expectedPreviousReviewId: null,
  source, outcome: "confirmed_active", reasonCode: "factory_contact", provenance: "operator_attested", confirmed: true, idempotencyKey: id(4) });
const result = () => ({ id: id(5), bindingId: id(6), factoryId: id(7), observation, source, originalBindingRevision: 2,
  originalItemsChecksum: hash, originalObservationSequence: 9, reviewRevision: 1, previousReviewId: null, outcome: "confirmed_active",
  reasonCode: "factory_contact", provenance: "operator_attested", requestChecksum: hash, createdAt: at });
describe("explicit operator-attested review of one original factory void observation", () => {
  it("normalizes permanent UUID pins and preserves the existing source ABI", () => {
    expect(ReviewFactoryErpVoidSchema.parse({ ...input(), idempotencyKey: id(4).toUpperCase() }).idempotencyKey).toBe(id(4));
    expect(FactoryErpBindingSourceSchema.parse(source)).toEqual(source);
  });
  it("rejects free text, private cells and unverifiable claims", () => {
    for (const candidate of [{ ...input(), note: "private" }, { ...input(), source: { ...source, externalId: "private" } },
      { ...input(), provenance: "factory_api_verified" }, { ...input(), confirmed: false }, { ...input(), observation: { ...observation, trackingNumber: "private" } }])
      expect(ReviewFactoryErpVoidSchema.safeParse(candidate).success).toBe(false);
  });
  it("requires explicit evidence for conclusions and retains uncertain or wrong-binding work", () => {
    for (const outcome of ["confirmed_active", "confirmed_voided", "export_record_incorrect"])
      for (const reasonCode of ["needs_factory_confirmation", "conflicting_records", "binding_mismatch"])
        expect(ReviewFactoryErpVoidSchema.safeParse({ ...input(), outcome, reasonCode }).success).toBe(false);
    expect(ReviewFactoryErpVoidSchema.safeParse({ ...input(), outcome: "followup_required", reasonCode: "binding_mismatch" }).success).toBe(true);
    expect(ReviewFactoryErpVoidSchema.safeParse({ ...input(), outcome: "followup_required" }).success).toBe(false);
  });
  it("rejects a target newer than the pinned complete observation history", () => {
    expect(ReviewFactoryErpVoidSchema.safeParse({ ...input(), expectedObservationSequence: 6 }).success).toBe(false);
  });
  it("preserves linear later conclusions rather than rewriting a previous review", () => {
    expect(FactoryErpVoidReviewResultSchema.safeParse(result()).success).toBe(true);
    expect(FactoryErpVoidReviewResultSchema.safeParse({ ...result(), reviewRevision: 2 }).success).toBe(false);
    expect(FactoryErpVoidReviewResultSchema.safeParse({ ...result(), reviewRevision: 2, previousReviewId: id(8) }).success).toBe(true);
  });
  it("does not let a receipt for another source masquerade as this observation", () => {
    const view = { ...observation, sourceReadable: false, latestReview: result(), pending: false, requiresOrderHandling: false };
    expect(FactoryErpVoidObservationViewSchema.safeParse(view).success).toBe(true);
    expect(FactoryErpVoidObservationViewSchema.safeParse({ ...view, latestReview: { ...result(), observation: { ...observation, importId: id(9) } } }).success).toBe(false);
    expect(FactoryErpVoidObservationViewSchema.safeParse({ ...view, pending: true }).success).toBe(false);
  });
  it("keeps factory-confirmed void separate from pending review and actual order handling", () => {
    const view = { ...observation, sourceReadable: false, latestReview: { ...result(), outcome: "confirmed_voided" }, pending: false, requiresOrderHandling: true };
    expect(FactoryErpVoidObservationViewSchema.safeParse(view).success).toBe(true);
    expect(FactoryErpVoidObservationViewSchema.safeParse({ ...view, requiresOrderHandling: false }).success).toBe(false);
  });
  it("rejects incomplete summary navigation or a receipt from another original group", () => {
    const view = { ...observation, sourceReadable: true, latestReview: null, pending: true, requiresOrderHandling: false };
    const basis = { bindingId: id(6), factoryId: id(7), bindingRevision: 2, itemsChecksum: hash, state: "active", observationSequence: 9,
      summary: { total: 1, pending: 1, requiresOrderHandling: 0, latest: view, nextPending: view } };
    expect(FactoryErpVoidBasisSchema.safeParse(basis).success).toBe(true);
    expect(FactoryErpVoidBasisSchema.safeParse({ ...basis, summary: { ...basis.summary, nextPending: null } }).success).toBe(false);
    expect(FactoryErpVoidBasisSchema.safeParse({ ...basis, summary: { total: 1, pending: 0, requiresOrderHandling: 0, nextPending: null,
      latest: { ...view, pending: false, latestReview: { ...result(), bindingId: id(9) } } } }).success).toBe(false);
    expect(FactoryErpVoidObservationPageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
