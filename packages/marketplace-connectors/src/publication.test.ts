import { describe, expect, it, vi } from "vitest";

import type { MarketplaceConnectorError } from "./errors.js";
import { HttpMarketplaceDraftGateway } from "./publication.js";

describe("marketplace draft gateway", () => {
  it("runs Amazon putListingsItem in validation preview mode without creating a listing", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth/o2/token")) return json({ access_token: "access", expires_in: 3600 });
      expect(url).toContain("/listings/2021-08-01/items/A1SELLER/SKU-1");
      expect(url).toContain("mode=VALIDATION_PREVIEW");
      expect(url).toContain("marketplaceIds=ATVPDKIKX0DER");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toMatchObject({ productType: "HOME", requirements: "LISTING" });
      return json({
        sku: "SKU-1",
        status: "INVALID",
        submissionId: "submission-1",
        issues: [{ code: "90220", message: "Brand is required", severity: "ERROR", attributeNames: ["brand"] }],
      }, 200, { "x-amzn-ratelimit-limit": "5.5" });
    });
    const result = await new HttpMarketplaceDraftGateway(request as typeof fetch, {
      AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test",
    }).create({
      authorizationMode: "amazon_private",
      externalAccountId: "A1SELLER",
      platform: "amazon",
      region: "NA",
    }, {
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      sellingPartnerId: "A1SELLER",
    }, {
      platform: "amazon",
      marketplaceId: "ATVPDKIKX0DER",
      locale: "en-US",
      productType: "HOME",
      sku: "SKU-1",
      attributes: { item_name: [{ value: "Personalized pillow" }] },
    });
    expect(result).toMatchObject({
      status: "validation_failed",
      externalState: "INVALID",
      externalSubmissionId: "submission-1",
      issues: [{ code: "90220", path: "brand", severity: "blocker" }],
      quota: { platform: "amazon", windows: [{ scope: "second", limit: 5.5 }] },
    });
    expect(result.externalListingId).toBeUndefined();
  });

  it("creates an Etsy draft with current readiness profile fields and rotates the refresh token", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return json({ access_token: "12345.access", refresh_token: "12345.rotated", expires_in: 3600 });
      }
      expect(url).toBe("https://openapi.etsy.com/v3/application/shops/9001/listings");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer 12345.access");
      expect(headers.get("x-api-key")).toBe("etsy-key:etsy-shared");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("readiness_state_id")).toBe("77");
      expect(body.get("shipping_profile_id")).toBe("66");
      expect(body.get("tags")).toBe("pillow,gift");
      expect(body.has("processing_min")).toBe(false);
      return json({ listing_id: 456, state: "draft" }, 200, {
        "x-limit-per-second": "10",
        "x-remaining-this-second": "7",
        "x-limit-per-day": "10000",
        "x-remaining-today": "9123",
      });
    });
    const result = await new HttpMarketplaceDraftGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    }).create({
      authorizationMode: "etsy_oauth",
      externalAccountId: "9001",
      platform: "etsy",
      region: "GLOBAL",
    }, { userId: "12345", refreshToken: "12345.old" }, {
      platform: "etsy",
      marketplaceId: "etsy",
      locale: "en-US",
      title: "Personalized pillow",
      description: "Gift-ready pillow",
      tags: ["pillow", "gift"],
      price: { amount: 26.4, currency: "USD" },
      quantity: 10,
      whoMade: "i_did",
      whenMade: "2020_2026",
      taxonomyId: 123,
      shippingProfileId: 66,
      readinessStateId: 77,
    });
    expect(result).toMatchObject({
      status: "draft_created",
      externalListingId: "456",
      externalState: "draft",
      refreshedCredential: { refreshToken: "12345.rotated" },
      quota: {
        platform: "etsy",
        windows: [
          { scope: "second", limit: 10, remaining: 7 },
          { scope: "day", limit: 10000, remaining: 9123 },
        ],
      },
    });
  });

  it("submits an Amazon Listing after preview and reconciles current issues", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth/o2/token")) return json({ access_token: "access", expires_in: 3600 });
      if (init?.method === "PUT") {
        expect(url).not.toContain("VALIDATION_PREVIEW");
        return json({ sku: "SKU-1", status: "ACCEPTED", submissionId: "submission-live", issues: [] });
      }
      expect(url).toContain("includedData=summaries%2Cissues");
      return json({
        sku: "SKU-1",
        summaries: [{ status: ["BUYABLE", "DISCOVERABLE"] }],
        issues: [{ code: "WARN-1", message: "Optional detail missing", severity: "WARNING" }],
      });
    });
    const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, {
      AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test",
    });
    const account = { authorizationMode: "amazon_private" as const, externalAccountId: "A1SELLER", platform: "amazon" as const, region: "NA" as const };
    const credential = { clientId: "client", clientSecret: "secret", refreshToken: "refresh", sellingPartnerId: "A1SELLER" };
    const payload = { platform: "amazon" as const, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SKU-1", attributes: {} };
    await expect(gateway.submit(account, credential, payload)).resolves.toMatchObject({
      status: "submission_accepted",
      externalListingId: "SKU-1",
      externalSubmissionId: "submission-live",
    });
    await expect(gateway.getStatus(account, credential, payload, "SKU-1")).resolves.toMatchObject({
      status: "published",
      externalState: "BUYABLE,DISCOVERABLE",
      issues: [{ code: "WARN-1", severity: "warning" }],
    });
  });

  it("uploads Etsy images in rank order, activates the draft, and confirms active state", async () => {
    const ranks: string[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return json({ access_token: "12345.access", refresh_token: "12345.refresh", expires_in: 3600 });
      }
      if (url.endsWith("/images")) {
        expect(new Headers(init?.headers).has("content-type")).toBe(false);
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        ranks.push(String(form.get("rank")));
        expect(form.get("image")).toBeInstanceOf(Blob);
        return json({ listing_image_id: 700 + ranks.length }, 201);
      }
      if (url.includes("/shops/9001/listings/456")) {
        expect(new URLSearchParams(String(init?.body)).get("state")).toBe("active");
        return json({ listing_id: 456, state: "active" });
      }
      expect(url).toBe("https://openapi.etsy.com/v3/application/listings/456");
      return json({ listing_id: 456, state: "active" });
    });
    const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    });
    const account = { authorizationMode: "etsy_oauth" as const, externalAccountId: "9001", platform: "etsy" as const, region: "GLOBAL" as const };
    const credential = { userId: "12345", refreshToken: "12345.refresh" };
    const media = [
      { assetId: "second", bytes: Uint8Array.from([2]), fileName: "second.jpg", mediaType: "image/jpeg", rank: 2 },
      { assetId: "first", bytes: Uint8Array.from([1]), fileName: "first.jpg", mediaType: "image/jpeg", rank: 1 },
    ];
    await expect(gateway.uploadMedia(account, credential, "456", media)).resolves.toMatchObject({
      status: "media_uploaded",
      externalMediaIds: ["701", "702"],
    });
    expect(ranks).toEqual(["1", "2"]);
    await expect(gateway.activate(account, credential, "456")).resolves.toMatchObject({ status: "activation_accepted" });
    const payload = {
      platform: "etsy" as const, marketplaceId: "etsy", locale: "en-US", title: "Pillow", description: "Pillow",
      tags: [], price: { amount: 10, currency: "USD" }, quantity: 1, whoMade: "i_did" as const,
      whenMade: "2020_2026", taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3,
    };
    await expect(gateway.getStatus(account, credential, payload, "456")).resolves.toMatchObject({ status: "published", externalState: "active" });
  });

  it("configures Etsy inventory and current personalization before activation", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return json({ access_token: "12345.access", refresh_token: "12345.refresh", expires_in: 3600 });
      }
      requests.push({ body: JSON.parse(String(init?.body)), url });
      return json({});
    });
    const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    });
    const payload = {
      platform: "etsy" as const,
      marketplaceId: "etsy",
      locale: "en-US",
      title: "Pillow",
      description: "Pillow",
      tags: [],
      price: { amount: 10, currency: "USD" },
      quantity: 1,
      whoMade: "i_did" as const,
      whenMade: "2020_2026",
      taxonomyId: 1,
      shippingProfileId: 2,
      readinessStateId: 3,
      inventory: {
        products: [{
          sku: "PILLOW-PINK",
          propertyValues: [{ propertyId: 200, propertyName: "Color", valueIds: [301], values: ["Pink"] }],
          offerings: [{ price: { amount: 24.5, currency: "USD" }, quantity: 4, isEnabled: true, readinessStateId: 3 }],
        }],
        priceOnProperty: [200],
        quantityOnProperty: [],
        skuOnProperty: [200],
        readinessStateOnProperty: [],
      },
      personalization: { instructions: "Enter a name", required: true, maxAllowedCharacters: 24 },
    };
    await expect(gateway.configure({
      authorizationMode: "etsy_oauth",
      externalAccountId: "9001",
      platform: "etsy",
      region: "GLOBAL",
    }, { userId: "12345", refreshToken: "12345.refresh" }, payload, "456")).resolves.toMatchObject({
      status: "configuration_applied",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "https://openapi.etsy.com/v3/application/listings/456/inventory?legacy=true",
      body: {
        price_on_property: [200],
        products: [{ sku: "PILLOW-PINK" }],
        sku_on_property: [200],
      },
    });
    expect(requests[1]?.url).toContain("/shops/9001/listings/456/personalization?supports_multiple_personalization_questions=true");
    expect(requests[1]?.body).toMatchObject({
      personalization_questions: [{ instructions: "Enter a name", max_allowed_characters: 24, required: true }],
    });
  });

  it("normalizes Etsy Money and inventory responses to the approved writable state", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/oauth/token")) return json({ access_token: "12345.access", refresh_token: "12345.refresh", expires_in: 3600 });
      if (url.includes("/inventory?legacy=true")) return json({
        products: [{
          product_id: 991,
          sku: "PILLOW-PINK",
          property_values: [{ property_id: 200, property_name: "Color", value_ids: [301], values: ["Pink"] }],
          offerings: [{ offering_id: 881, price: { amount: 2450, divisor: 100, currency_code: "USD" }, quantity: 4, is_enabled: true, readiness_state_id: 3 }],
        }],
        price_on_property: [200], quantity_on_property: [], sku_on_property: [200], readiness_state_on_property: [],
      });
      return json({
        listing_id: 456,
        state: "active",
        title: "Pillow",
        description: "Pillow\nwith personalization",
        tags: ["gift", "pillow"],
        taxonomy_id: 1,
        shipping_profile_id: 2,
        readiness_state_id: 3,
        is_supply: false,
        who_made: "i_did",
        when_made: "2020_2026",
        is_personalizable: true,
        personalization_is_required: true,
        personalization_char_count_max: 24,
        personalization_instructions: "Enter a name",
        price: { amount: 2450, divisor: 100, currency_code: "USD" },
        quantity: 4,
      });
    });
    const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    });
    const payload = {
      platform: "etsy" as const, marketplaceId: "etsy", locale: "en-US", title: "Pillow", description: "Pillow",
      tags: [], price: { amount: 24.5, currency: "USD" }, quantity: 4, whoMade: "i_did" as const,
      whenMade: "2020_2026", taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3,
      inventory: {
        products: [{
          sku: "PILLOW-PINK",
          propertyValues: [{ propertyId: 200, propertyName: "Color", valueIds: [301], values: ["Pink"] }],
          offerings: [{ price: { amount: 24.5, currency: "USD" }, quantity: 4, isEnabled: true, readinessStateId: 3 }],
        }],
        priceOnProperty: [200], quantityOnProperty: [], skuOnProperty: [200], readinessStateOnProperty: [],
      },
    };
    await expect(gateway.readOnlineListing({
      authorizationMode: "etsy_oauth", externalAccountId: "9001", platform: "etsy", region: "GLOBAL",
    }, { userId: "12345", refreshToken: "12345.refresh" }, payload, "456")).resolves.toMatchObject({
      snapshot: {
        externalState: "active",
        content: {
          title: "Pillow",
          description: "Pillow\nwith personalization",
          tags: ["gift", "pillow"],
          taxonomyId: 1,
          shippingProfileId: 2,
          readinessStateId: 3,
          isSupply: false,
          whoMade: "i_did",
          whenMade: "2020_2026",
          personalization: { instructions: "Enter a name", required: true, maxAllowedCharacters: 24 },
        },
        price: [[{ amount: 24.5, currency: "USD" }]],
        inventory: {
          products: [{ sku: "PILLOW-PINK", offerings: [{ price: 24.5, quantity: 4, is_enabled: true }] }],
          price_on_property: [200], sku_on_property: [200],
        },
      },
    });
  });

  it("patches only approved Amazon price and inventory attributes", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth/o2/token")) return json({ access_token: "access", expires_in: 3600 });
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        productType: "HOME",
        patches: [
          { op: "replace", path: "/attributes/purchasable_offer", value: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 26.4 }] }] }] },
          { op: "replace", path: "/attributes/fulfillment_availability", value: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }] },
        ],
      });
      return json({ sku: "SKU-1", status: "ACCEPTED", submissionId: "sync-1", issues: [] });
    });
    const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, { AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test" });
    const price = [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 26.4 }] }] }];
    const inventory = [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }];
    await expect(gateway.updateOnlineListingPriceInventory({
      authorizationMode: "amazon_private", externalAccountId: "A1SELLER", platform: "amazon", region: "NA",
    }, { clientId: "client", clientSecret: "secret", refreshToken: "refresh", sellingPartnerId: "A1SELLER" }, {
      platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SKU-1",
      attributes: { purchasable_offer: price, fulfillment_availability: inventory },
    }, "SKU-1")).resolves.toMatchObject({ snapshot: { externalState: "ACCEPTED", price, inventory } });
  });

  it("reads and replaces the complete approved Amazon Listing state", async () => {
    const attributes = {
      item_name: [{ language_tag: "en_US", value: "Personalized pillow" }],
      purchasable_offer: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 26.4 }] }] }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }],
    };
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth/o2/token")) return json({ access_token: "access", expires_in: 3600 });
      if (init?.method === "PUT") {
        expect(JSON.parse(String(init.body))).toEqual({ productType: "HOME", requirements: "LISTING", attributes });
        return json({ sku: "SKU-1", status: "ACCEPTED", submissionId: "sync-full-1", issues: [] });
      }
      expect(url).toContain("includedData=attributes%2Csummaries%2Cissues%2CfulfillmentAvailability");
      return json({ productType: "HOME", attributes, summaries: [{ status: ["BUYABLE"] }], issues: [] });
    });
    const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, { AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test" });
    const account = { authorizationMode: "amazon_private" as const, externalAccountId: "A1SELLER", platform: "amazon" as const, region: "NA" as const };
    const credential = { clientId: "client", clientSecret: "secret", refreshToken: "refresh", sellingPartnerId: "A1SELLER" };
    const payload = { platform: "amazon" as const, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SKU-1", attributes };

    await expect(gateway.readOnlineListing(account, credential, payload, "SKU-1")).resolves.toMatchObject({
      snapshot: {
        externalState: "BUYABLE",
        content: { productType: "HOME", attributes: { item_name: attributes.item_name } },
        price: attributes.purchasable_offer,
        inventory: attributes.fulfillment_availability,
      },
    });
    await expect(gateway.updateOnlineListingContent(account, credential, payload, "SKU-1")).resolves.toMatchObject({
      snapshot: {
        externalState: "ACCEPTED",
        content: { productType: "HOME", attributes: { item_name: attributes.item_name } },
        price: attributes.purchasable_offer,
        inventory: attributes.fulfillment_availability,
      },
    });
  });

  it("updates Etsy content, inventory, and personalization as one guarded operation", async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) return json({ access_token: "12345.access", refresh_token: "12345.refresh", expires_in: 3600 });
      if (url.includes("/personalization")) {
        requests.push({ body: JSON.parse(String(init?.body)), url });
        return json({});
      }
      if (url.includes("/inventory?legacy=true")) {
        requests.push({ body: JSON.parse(String(init?.body)), url });
        return json({ products: [], price_on_property: [], quantity_on_property: [], sku_on_property: [], readiness_state_on_property: [] });
      }
      const body = new URLSearchParams(String(init?.body));
      requests.push({ body: Object.fromEntries(body), url });
      return json({ listing_id: 456, state: "active" });
    });
    const gateway = new HttpMarketplaceDraftGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    });
    const payload = {
      platform: "etsy" as const, marketplaceId: "etsy", locale: "en-US", title: "Named pillow", description: "Line one\nLine two",
      tags: ["pillow", "gift"], price: { amount: 24.5, currency: "USD" }, quantity: 4, whoMade: "i_did" as const,
      whenMade: "2020_2026", taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3, isSupply: false,
      personalization: { instructions: "Enter a name", required: true, maxAllowedCharacters: 24 },
      inventory: {
        products: [{ sku: "PILLOW-PINK", propertyValues: [], offerings: [{ price: { amount: 24.5, currency: "USD" }, quantity: 4, isEnabled: true, readinessStateId: 3 }] }],
        priceOnProperty: [], quantityOnProperty: [], skuOnProperty: [], readinessStateOnProperty: [],
      },
    };
    await expect(gateway.updateOnlineListingContent({
      authorizationMode: "etsy_oauth", externalAccountId: "9001", platform: "etsy", region: "GLOBAL",
    }, { userId: "12345", refreshToken: "12345.refresh" }, payload, "456")).resolves.toMatchObject({
      snapshot: { externalState: "UPDATE_ACCEPTED", content: { title: "Named pillow", personalization: payload.personalization } },
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.body).toMatchObject({ title: "Named pillow", description: "Line one\nLine two", tags: "pillow,gift", is_personalizable: "true" });
    expect(requests[1]?.body).toMatchObject({ products: [{ sku: "PILLOW-PINK" }] });
    expect(requests[2]?.body).toMatchObject({ personalization_questions: [{ instructions: "Enter a name", required: true, max_allowed_characters: 24 }] });
  });

  it("marks a partially applied Etsy full-content update as uncertain", async () => {
    let listingUpdated = false;
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/oauth/token")) return json({ access_token: "12345.access", refresh_token: "12345.refresh", expires_in: 3600 });
      if (url.includes("/inventory?legacy=true")) return json({ error: "inventory rejected" }, 400);
      listingUpdated = true;
      return json({ listing_id: 456, state: "active" });
    });
    const promise = new HttpMarketplaceDraftGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    }).updateOnlineListingContent({ authorizationMode: "etsy_oauth", externalAccountId: "9001", platform: "etsy", region: "GLOBAL" }, {
      userId: "12345", refreshToken: "12345.refresh",
    }, {
      platform: "etsy", marketplaceId: "etsy", locale: "en-US", title: "Pillow", description: "Pillow", tags: [],
      price: { amount: 10, currency: "USD" }, quantity: 1, whoMade: "i_did", whenMade: "2020_2026",
      taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3,
      inventory: {
        products: [{ sku: "SKU", propertyValues: [], offerings: [{ price: { amount: 10, currency: "USD" }, quantity: 1, isEnabled: true, readinessStateId: 3 }] }],
        priceOnProperty: [], quantityOnProperty: [], skuOnProperty: [], readinessStateOnProperty: [],
      },
    }, "456");
    await expect(promise).rejects.toMatchObject({ outcomeUncertain: true, retryable: false } satisfies Partial<MarketplaceConnectorError>);
    expect(listingUpdated).toBe(true);
  });

  it("marks a lost Etsy create response as uncertain so a retry cannot duplicate the draft", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/oauth/token")) {
        return json({ access_token: "12345.access", refresh_token: "12345.old", expires_in: 3600 });
      }
      throw new TypeError("socket closed");
    });
    const promise = new HttpMarketplaceDraftGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    }).create({ authorizationMode: "etsy_oauth", externalAccountId: "9001", platform: "etsy", region: "GLOBAL" }, {
      userId: "12345", refreshToken: "12345.old",
    }, {
      platform: "etsy", marketplaceId: "etsy", locale: "en-US", title: "Pillow", description: "Pillow",
      tags: [], price: { amount: 10, currency: "USD" }, quantity: 1, whoMade: "i_did",
      whenMade: "2020_2026", taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3,
    });
    await expect(promise).rejects.toMatchObject({
      code: "upstream_terminal",
      outcomeUncertain: true,
      retryable: false,
    } satisfies Partial<MarketplaceConnectorError>);
  });
});

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}
