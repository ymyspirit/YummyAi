import { describe, expect, it, vi } from "vitest";

import { EtsyPersonalizationSafetyError } from "./errors.js";
import { HttpMarketplaceDraftGateway, type MarketplacePublicationPayload, type PublicationAccountContext } from "./publication.js";

const account: PublicationAccountContext = { authorizationMode: "etsy_oauth", externalAccountId: "9001", platform: "etsy", region: "GLOBAL" };
const credential = { userId: "12345", refreshToken: "12345.refresh" };
const desired = { instructions: "Enter a name", required: true, maxAllowedCharacters: 24 };
const payload: Extract<MarketplacePublicationPayload, { platform: "etsy" }> = {
  platform: "etsy", marketplaceId: "etsy", locale: "en-US", title: "Named pillow", description: "Original artwork",
  tags: ["pillow"], price: { amount: 25, currency: "USD" }, quantity: 4, whoMade: "i_did", whenMade: "2020_2026",
  taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3, personalization: desired,
  inventory: {
    products: [{ sku: "PILLOW", propertyValues: [], offerings: [{ price: { amount: 25, currency: "USD" }, quantity: 4, isEnabled: true }] }],
    priceOnProperty: [], quantityOnProperty: [], skuOnProperty: [], readinessStateOnProperty: [],
  },
};
const textQuestion = {
  question_id: 123, question_type: "text_input", question_text: "Engraving name", instructions: "Enter a name",
  required: true, max_allowed_characters: 24, max_allowed_files: null, options: null, add_on_price: null,
};

function provider(current: unknown, personalizationStatus = 200) {
  const mutations: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  let remote = current;
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/token")) return json({ access_token: "12345.access", refresh_token: "12345.refresh", expires_in: 3600 });
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const raw = String(init?.body);
      const body = raw.startsWith("{") ? JSON.parse(raw) as Record<string, unknown> : Object.fromEntries(new URLSearchParams(raw));
      mutations.push({ url, method, body });
      if (url.endsWith("/personalization")) {
        if (personalizationStatus !== 200) return json({ error: "conflict" }, personalizationStatus);
        remote = body;
        return json(body);
      }
    }
    if (url.endsWith("/personalization")) return json(remote);
    if (url.includes("/inventory")) return json({ products: [] });
    return json({ listing_id: 456, state: "active", title: "Named pillow", is_personalizable: true, production_partner_ids: [91], personalization_instructions: "legacy must not win", personalization_is_required: false, personalization_char_count_max: 999 });
  });
  const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, { ETSY_APP_KEYSTRING: "test-key", ETSY_APP_SHARED_SECRET: "test-secret" });
  return { gateway, request, mutations };
}

const unsupported = [
  ["multiple questions", { personalization_questions: [textQuestion, { ...textQuestion, question_id: 124 }] }],
  ["dropdown", { personalization_questions: [{ question_id: 123, question_type: "dropdown", options: [{ option_id: 1, label: "Blue" }] }] }],
  ["file upload", { personalization_questions: [{ question_id: 123, question_type: "unlabeled_upload", max_allowed_files: 3 }] }],
  ["labeled upload", { personalization_questions: [{ question_id: 123, question_type: "labeled_upload", options: [{ label: "Front" }, { label: "Back" }], max_allowed_files: 2 }] }],
  ["add-on pricing", { personalization_questions: [{ ...textQuestion, add_on_price: { amount: 500, divisor: 100, currency_code: "USD" } }] }],
  ["unknown field", { personalization_questions: [{ ...textQuestion, future_option: { keep: true } }] }],
  ["unknown type", { personalization_questions: [{ ...textQuestion, question_type: "future_type" }] }],
  ["unknown profile data", { personalization_questions: [], future_profile: "keep this" }],
] as const;

describe("Etsy personalization data safety", () => {
  it.each(unsupported)("preserves %s on read and blocks every full write before any mutation", async (_name, current) => {
    const { gateway, mutations } = provider(current);
    const result = await gateway.readOnlineListing(account, credential, payload, "456");
    expect(result.snapshot.content).toMatchObject({ personalization: { editing: "etsy_required", source: current } });
    expect(result.issues).toEqual([expect.objectContaining({ code: "ETSY_PERSONALIZATION_REQUIRES_ETSY", message: expect.stringContaining("请到 Etsy 编辑") })]);
    for (const action of ["configure", "updateOnlineListingContent"] as const) {
      for (const content of [payload, { ...payload, personalization: undefined }]) {
        await expect(gateway[action](account, credential, content, "456")).rejects.toBeInstanceOf(EtsyPersonalizationSafetyError);
      }
    }
    expect(mutations).toEqual([]);
  });

  it("reads current questions instead of missing or contradictory legacy fields", async () => {
    const { gateway, request } = provider({ personalization_questions: [textQuestion] });
    const result = await gateway.readOnlineListing(account, credential, payload, "456");
    expect(result.snapshot.content).toMatchObject({ personalization: desired });
    expect(request).toHaveBeenCalledWith("https://openapi.etsy.com/v3/application/listings/456/personalization", expect.objectContaining({ headers: expect.anything() }));
  });

  it("preserves existing text identity and label, and never opts into replacing multiple questions", async () => {
    const { gateway, mutations } = provider({ personalization_questions: [textQuestion] });
    await gateway.configure(account, credential, { ...payload, personalization: { ...desired, instructions: "Enter the recipient name" } }, "456");
    const write = mutations.find((entry) => entry.url.endsWith("/personalization"));
    expect(write?.body).toEqual({ personalization_questions: [{ question_id: 123, question_type: "text_input", question_text: "Engraving name", instructions: "Enter the recipient name", required: true, max_allowed_characters: 24 }] });
    expect(mutations.every((entry) => !entry.url.includes("supports_multiple_personalization_questions"))).toBe(true);
  });

  it("keeps historical long instructions readable and untouched when updating other content", async () => {
    const instructions = "A".repeat(150);
    const { gateway, mutations } = provider({ personalization_questions: [{ ...textQuestion, instructions }] });
    const content = { ...payload, personalization: { ...desired, instructions } };
    const read = await gateway.readOnlineListing(account, credential, content, "456");
    expect(read.snapshot.content).toMatchObject({ personalization: { instructions } });
    await gateway.updateOnlineListingContent(account, credential, content, "456");
    expect(mutations.some((entry) => entry.url.includes("/personalization"))).toBe(false);
    for (const write of mutations) {
      expect(write.body).not.toHaveProperty("is_personalizable");
      expect(write.body).not.toHaveProperty("production_partner_ids");
    }
  });

  it.each(["A".repeat(121), "!Enter a name", "ENTER NAME here"])("rejects invalid new instructions before creating or changing anything: %s", async (instructions) => {
    const { gateway, mutations } = provider({ personalization_questions: [] });
    const content = { ...payload, personalization: { ...desired, instructions } };
    await expect(gateway.create(account, credential, content)).rejects.toBeInstanceOf(EtsyPersonalizationSafetyError);
    await expect(gateway.configure(account, credential, content, "456")).rejects.toBeInstanceOf(EtsyPersonalizationSafetyError);
    await expect(gateway.updateOnlineListingContent(account, credential, content, "456")).rejects.toBeInstanceOf(EtsyPersonalizationSafetyError);
    expect(mutations).toEqual([]);
  });

  it("does not interpret disabled local personalization as authorization to remove an existing question", async () => {
    const { gateway, mutations } = provider({ personalization_questions: [textQuestion] });
    await expect(gateway.updateOnlineListingContent(account, credential, { ...payload, personalization: undefined }, "456")).rejects.toMatchObject({ reason: "deletion" });
    expect(mutations).toEqual([]);
  });

  it.each([{}, { personalization_questions: null }, { personalization_questions: [null] }])("fails closed on malformed personalization reads: %j", async (current) => {
    const { gateway, mutations } = provider(current);
    await expect(gateway.configure(account, credential, payload, "456")).rejects.toMatchObject({ outcomeUncertain: false });
    expect(mutations).toEqual([]);
  });

  it("keeps Etsy's conflict protection for questions changed after preflight and reports partial content updates", async () => {
    const { gateway, mutations } = provider({ personalization_questions: [] }, 409);
    await expect(gateway.updateOnlineListingContent(account, credential, payload, "456")).rejects.toMatchObject({ outcomeUncertain: true, retryable: false });
    expect(mutations.filter((entry) => entry.url.endsWith("/personalization"))).toHaveLength(1);
    expect(mutations.every((entry) => !entry.url.includes("supports_multiple_personalization_questions"))).toBe(true);
  });

  it("requires reconciliation if draft inventory changed before Etsy rejects concurrent personalization", async () => {
    const { gateway } = provider({ personalization_questions: [] }, 409);
    await expect(gateway.configure(account, credential, payload, "456")).rejects.toMatchObject({ outcomeUncertain: true, retryable: false });
  });
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
