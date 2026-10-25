import { describe, expect, it } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { studioImageHash } from "@yummyai/pod-core";
import { assertStudioImageOperatorAdmission, assertStudioPaidImageEvidence, isStudioImageSubmissionBudgetGuard, studioImageWorkerConfigured,
  type StudioPaidImageEvidence } from "./studio-image-paid-admission.js";

const tenant = "019a1030-0000-7000-8000-000000000001", owner = "019a1030-0000-7000-8000-000000000002";
const route = "019a1030-0000-7000-8000-000000000003", provider = "019a1030-0000-7000-8000-000000000004";
const generationId = "019a1030-0000-7000-8000-000000000005", requestId = "019a1030-0000-7000-8000-000000000006";
const imageRequestId = "019a1030-0000-7000-8000-000000000007", checksum = "a".repeat(64);

function evidence(): StudioPaidImageEvidence {
  const input = { requestId, modelId: route, capability: "image" as const, selectionRevision: checksum, prompt: "A blue printed cup",
    referenceKeys: ["reference:one"], size: "1536x1024", quality: "medium" as const, background: "opaque" as const, seconds: 4 };
  const references = [{ assetId: "019a1030-0000-7000-8000-000000000008", version: 2, checksum }];
  const fixed = { version: 1 as const, inputFingerprint: studioImageHash(input), modelId: route, providerConfigId: provider,
    model: "gpt-image-1", label: "Image model", providerLabel: "Operator channel", selectionRevision: checksum, providerFingerprint: checksum,
    contextAuthority: erpSessionAuthority({ tenantId: tenant, userId: owner, permissions: ["asset:write", "design:write"], dataScope: "self" }),
    unit: "image" as const, count: 1 as const, currency: "USD" as const, basis: "operator_estimate" as const,
    pricing: { estimatedUsd: "0.03000000", reservationUsd: "0.050000", reference: "Operator estimate" },
    size: input.size, quality: input.quality, background: input.background, references,
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2026-10-24T00:05:00.000Z" };
  const quote = { ...fixed, quoteHash: studioImageHash(fixed) };
  return { generation: { id: generationId, tenantId: tenant, ownerId: owner, scope: "unassigned", requestId, input, references,
    modelSnapshot: { providerConfigId: provider, model: quote.model, capability: "image", routeId: route, providerFingerprint: checksum,
      paidImage: { imageRequestId, quoteHash: quote.quoteHash, reservationUsd: quote.pricing.reservationUsd, estimatedUsd: quote.pricing.estimatedUsd } } },
    request: { id: imageRequestId, tenantId: tenant, ownerId: owner, scope: "unassigned", requestId, input, quote,
      generationId, committedAt: new Date("2026-10-24T00:01:00.000Z"), cancelledAt: null } };
}

describe("Studio image Worker capability gate", () => {
  it("does not register the broad Studio queue by default", () => {
    expect(studioImageWorkerConfigured({})).toBe(false);
    expect(studioImageWorkerConfigured({ STUDIO_PAID_IMAGE_ENABLED: "1", STUDIO_PAID_IMAGE_TENANT_IDS: "*" })).toBe(false);
    expect(() => assertStudioImageOperatorAdmission(tenant, {})).toThrow("STUDIO_PAID_IMAGE_OPERATOR_PAUSED");
  });
  it("registers only an explicit allowlist and rechecks a later operator pause", () => {
    const env = { STUDIO_PAID_IMAGE_ENABLED: "1", STUDIO_PAID_IMAGE_TENANT_IDS: tenant };
    expect(studioImageWorkerConfigured(env)).toBe(true);
    expect(() => assertStudioImageOperatorAdmission(tenant, env)).not.toThrow();
    env.STUDIO_PAID_IMAGE_ENABLED = "0";
    expect(() => assertStudioImageOperatorAdmission(tenant, env)).toThrow("STUDIO_PAID_IMAGE_OPERATOR_PAUSED");
  });
});

describe("Studio image pre-submission budget failure classification", () => {
  const guardError = () => Object.assign(new Error("private diagnostics"), {
    code: "23514", constraint_name: "studio_image_paid_submission_month_guard",
  });
  it("recognizes the exact database guard without reading SQL or message text", () => {
    const value = guardError();
    Object.defineProperties(value, {
      message: { get: () => { throw new Error("message must remain unread"); } },
      query: { get: () => { throw new Error("SQL must remain unread"); } },
    });
    expect(isStudioImageSubmissionBudgetGuard(value)).toBe(true);
  });
  it("recognizes an exact guard inside wrapped Error causes", () => {
    expect(isStudioImageSubmissionBudgetGuard(new Error("outer", {
      cause: new Error("inner", { cause: guardError() }),
    }))).toBe(true);
  });
  it("rejects lookalikes, wrong SQL states, cycles and chains beyond the bound", () => {
    for (const constraint_name of ["studio_image_paid_submission_month_guard_other", "STUDIO_IMAGE_PAID_SUBMISSION_MONTH_GUARD", "other_guard"]) {
      expect(isStudioImageSubmissionBudgetGuard(Object.assign(guardError(), { constraint_name }))).toBe(false);
    }
    expect(isStudioImageSubmissionBudgetGuard(Object.assign(guardError(), { code: "23503" }))).toBe(false);
    expect(isStudioImageSubmissionBudgetGuard(new Error("studio_image_paid_submission_month_guard"))).toBe(false);
    expect(isStudioImageSubmissionBudgetGuard({ code: "23514", constraint_name: "studio_image_paid_submission_month_guard" })).toBe(false);
    const cyclic = new Error("cycle");
    Object.defineProperty(cyclic, "cause", { value: cyclic });
    expect(isStudioImageSubmissionBudgetGuard(cyclic)).toBe(false);
    let deep: Error = guardError();
    for (let depth = 0; depth < 8; depth++) deep = new Error("wrapper", { cause: deep });
    expect(isStudioImageSubmissionBudgetGuard(deep)).toBe(false);
  });
});

describe("Studio original committed image evidence", () => {
  it("accepts the exact original quote and leaves all original fields untouched", () => {
    const value = evidence(), before = globalThis.structuredClone(value);
    expect(() => assertStudioPaidImageEvidence(value)).not.toThrow();
    expect(value).toEqual(before);
  });
  it("allows response recovery after quote expiry when the original commit was timely", () => {
    // No wall-clock TTL check here: a completed original response must never be replaced by another billed call.
    const value = evidence();
    value.request.quote.createdAt = "2020-01-01T00:00:00.000Z";
    value.request.quote.expiresAt = "2020-01-01T00:05:00.000Z";
    value.request.committedAt = new Date("2020-01-01T00:01:00.000Z");
    const fixed = Object.fromEntries(Object.entries(value.request.quote).filter(([key]) => key !== "quoteHash"));
    value.request.quote.quoteHash = studioImageHash(fixed);
    value.generation.modelSnapshot.paidImage!.quoteHash = value.request.quote.quoteHash;
    expect(() => assertStudioPaidImageEvidence(value)).not.toThrow();
  });
  const changes: Array<[string, (value: StudioPaidImageEvidence) => void]> = [
    ["legacy missing paid pin", value => { delete value.generation.modelSnapshot.paidImage; }],
    ["text task", value => { value.generation.modelSnapshot.capability = "text"; }],
    ["video task", value => { value.generation.modelSnapshot.capability = "video"; }],
    ["uncommitted prepare", value => { value.request.committedAt = null; value.request.generationId = null; }],
    ["cancelled prepare", value => { value.request.cancelledAt = new Date(); }],
    ["late commit", value => { value.request.committedAt = new Date("2026-10-24T00:05:00.001Z"); }],
    ["exact expired commit", value => { value.request.committedAt = new Date("2026-10-24T00:05:00.000Z"); }],
    ["commit before prepare", value => { value.request.committedAt = new Date("2026-10-23T23:59:59.999Z"); }],
    ["another owner", value => { value.generation.ownerId = route; }],
    ["another tenant", value => { value.request.tenantId = route; }],
    ["another scope", value => { value.request.scope = route; }],
    ["another request", value => { value.request.requestId = route; }],
    ["another generation", value => { value.request.generationId = route; }],
    ["changed prompt", value => { value.generation.input = { ...value.generation.input, prompt: "Changed" }; }],
    ["changed quote hash", value => { value.request.quote.quoteHash = "b".repeat(64); }],
    ["changed model route", value => { value.generation.modelSnapshot.routeId = provider; }],
    ["changed provider", value => { value.generation.modelSnapshot.providerConfigId = route; }],
    ["changed model", value => { value.generation.modelSnapshot.model = "another-model"; }],
    ["changed credential revision", value => { value.generation.modelSnapshot.providerFingerprint = "b".repeat(64); }],
    ["changed reserve", value => { value.generation.modelSnapshot.paidImage!.reservationUsd = "0.060000"; }],
    ["changed reference version", value => { value.generation.references = [{ ...value.generation.references[0]!, version: 3 }]; }],
  ];
  it.each(changes)("refuses %s before the original recovery owner can mutate it", (_label, change) => {
    const value = evidence(); change(value);
    expect(() => assertStudioPaidImageEvidence(value)).toThrow("STUDIO_PAID_IMAGE_EVIDENCE_CHANGED");
  });
  it("rejects internally rehashed quote lies about the wire size, original authority or estimate", () => {
    for (const change of [
      (value: StudioPaidImageEvidence) => { value.request.quote.size = "1024x1024"; },
      (value: StudioPaidImageEvidence) => { value.request.quote.contextAuthority = erpSessionAuthority({ tenantId: tenant, userId: route, permissions: [], dataScope: "self" }); },
      (value: StudioPaidImageEvidence) => { value.request.quote.pricing.estimatedUsd = "0.06000000"; },
    ]) {
      const value = evidence(); change(value);
      const fixed = Object.fromEntries(Object.entries(value.request.quote).filter(([key]) => key !== "quoteHash"));
      value.request.quote.quoteHash = studioImageHash(fixed);
      value.generation.modelSnapshot.paidImage!.quoteHash = value.request.quote.quoteHash;
      expect(() => assertStudioPaidImageEvidence(value)).toThrow("STUDIO_PAID_IMAGE_EVIDENCE_CHANGED");
    }
  });
});
