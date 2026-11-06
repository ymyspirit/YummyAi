import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { orderSyncNodeRequestText, STORE_NODE_ORDER_SYNC_OPERATION } from "@yummyai/contracts/order/sync";
import { STORE_NODE_EXECUTION_PROTOCOL, type StoreNodeExecutionCredential, type StoreNodeOrderSyncLease } from "@yummyai/contracts/marketplace/store-node-execution";
import { createStoreNodeOrdersTransport } from "@yummyai/marketplace-connectors";
import { describe, expect, it, vi } from "vitest";
import { executeStoreNodeOrderSync } from "./order-sync-execution.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function fixture() {
  const seed: StoreNodeExecutionCredential = { account: { platform: "amazon", authorizationMode: "amazon_private", region: "NA", externalAccountId: "SYNTHETIC-SELLER",
    marketplaceIds: ["ATVPDKIKX0DER"], grantedScopes: [] }, credential: { sellingPartnerId: "SYNTHETIC-SELLER", clientId: "synthetic-client", clientSecret: "synthetic-original-secret", refreshToken: "synthetic-original-refresh" }, etsyAppKeySha256: null };
  const lease: StoreNodeOrderSyncLease = { protocol: STORE_NODE_EXECUTION_PROTOCOL, operation: STORE_NODE_ORDER_SYNC_OPERATION, id: createEntityId(), accountId: createEntityId(),
    nodeId: createEntityId(), certificateGeneration: 1, authorizationGeneration: createEntityId(), bindingRevision: 1,
    requestId: createEntityId(), requestChecksum: "a".repeat(64), claimId: createEntityId(), sessionId: createEntityId(), credentialUseId: createEntityId(), credentialId: createEntityId(), credentialVersion: 1,
    expiresAt: "2026-12-01T00:00:00.000Z", runExpiresAt: "2026-12-01T00:00:00.000Z", sealedCredential: { nonce: "A".repeat(16), tag: "A".repeat(22), ciphertext: "AQ", wrappedKey: "A".repeat(512) },
    input: { runId: createEntityId(), request: { checkpoint: { cursor: "original-page", highWaterAt: null, version: 1 }, updatedAfter: "2026-11-01T00:00:00.000Z", updatedBefore: "2026-11-02T00:00:00.000Z", pageSize: 50, maxPages: 1 } } };
  lease.requestChecksum = sha(orderSyncNodeRequestText(lease.accountId, lease, lease.input));
  const order = { orderId: "111-2222222-3333333", createdTime: "2026-11-01T09:00:00.000Z", lastUpdatedTime: "2026-11-01T11:30:00.000Z",
    fulfillment: { fulfillmentStatus: "UNSHIPPED" }, salesChannel: { marketplaceId: "ATVPDKIKX0DER" }, proceeds: { grandTotal: { amount: "25.00", currencyCode: "USD" } },
    orderItems: [{ orderItemId: "synthetic-item", product: { sellerSku: "SKU-1", title: "Synthetic custom pillow", price: { unitPrice: { amount: "25.00", currencyCode: "USD" } }, customization: { customizedUrl: "https://custom.example.test/private.zip" } }, quantityOrdered: 1 }],
    recipient: { deliveryAddress: { name: "Synthetic Buyer", addressLine1: "Synthetic street", city: "Seattle", stateOrRegion: "WA", postalCode: "98101", countryCode: "US" } } };
  return { seed, lease, order };
}
describe("bound node order reading", () => {
  it("reads one fixed page, carries Custom references privately, and cannot follow a provider redirect", async () => {
    const { seed, lease, order } = fixture(), classes: string[] = [];
    const request = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (String(url).includes("/auth/o2/token")) return json({ access_token: "synthetic-access" });
      const target = new URL(String(url)); expect(target.origin).toBe("https://sellingpartnerapi-na.amazon.com");
      expect(target.searchParams.get("paginationToken")).toBe("original-page");
      expect(target.searchParams.get("lastUpdatedBefore")).toBe(lease.input.request.updatedBefore);
      return json({ orders: [order], pagination: { nextToken: "next-page" } });
    });
    const result = await executeStoreNodeOrderSync({ seed, lease, request: request as typeof fetch, exchange: async (call, send) => { classes.push(call.requestClass); return send(); } });
    expect(classes).toEqual(["amazon_lwa", "amazon_orders"]); expect(request).toHaveBeenCalledTimes(2);
    expect(result.records[0]?.order.protectedDetails?.customizations[0]?.values[0]).toMatchObject({ type: "file_reference", externalReference: "https://custom.example.test/private.zip" });
    expect(JSON.stringify(result.records[0]?.order.redactedSource)).not.toContain("Synthetic Buyer");
    expect(result.nextCursor).toBe("next-page");
  });
  it("rejects changed pins, missing orders and leaked credentials rather than advancing an empty page", async () => {
    const { seed, lease, order } = fixture();
    const options = { seed, lease, exchange: async (_call: unknown, send: () => Promise<Response>) => send() };
    expect(() => createStoreNodeOrdersTransport({ ...options, lease: { ...lease, bindingRevision: 2 } })).toThrow();
    for (const body of [{}, { orders: [{ ...order, recipient: { deliveryAddress: { name: seed.credential.refreshToken, countryCode: "US" } } }] }]) {
      const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).includes("/auth/o2/token") ? json({ access_token: "synthetic-access" }) : json(body));
      await expect(executeStoreNodeOrderSync({ ...options, request: request as typeof fetch })).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(2);
    }
  });
  it("blocks arbitrary hosts, write methods, changed cursors, duplicate query fields and oversized responses", async () => {
    const { seed, lease } = fixture(), request = vi.fn(async () => json({ access_token: "synthetic-access" }));
    const transport = createStoreNodeOrdersTransport({ seed, lease, request: request as typeof fetch, exchange: async (_call, send) => send() });
    await transport("https://api.amazon.com/auth/o2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: seed.credential.refreshToken!, client_id: seed.credential.clientId!, client_secret: seed.credential.clientSecret! }) });
    const url = new URL("https://sellingpartnerapi-na.amazon.com/orders/2026-01-01/orders");
    url.search = new URLSearchParams({ marketplaceIds: "ATVPDKIKX0DER", lastUpdatedAfter: lease.input.request.updatedAfter, lastUpdatedBefore: lease.input.request.updatedBefore,
      maxResultsPerPage: "50", includedData: "BUYER,RECIPIENT,PROCEEDS,CANCELLATION,FULFILLMENT", paginationToken: "original-page" }).toString();
    const headers = { "x-amz-access-token": "synthetic-access", "user-agent": "YummyAI/0.1 (Language=TypeScript)" };
    for (const target of [url.href.replace("sellingpartnerapi-na.amazon.com", "attacker.example"), url.href.replace("original-page", "different"), url.href + "&paginationToken=original-page"])
      await expect(transport(target, { headers })).rejects.toThrow("store_node_policy_rejected");
    await expect(transport(url, { headers, method: "POST" })).rejects.toThrow("store_node_policy_rejected");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockImplementationOnce(async () => new Response("{}", { headers: { "content-length": "999999999" } }));
    await expect(transport(url, { headers })).rejects.toThrow("store_node_result_too_large");
  });
  it("returns provider throttling once without additional physical requests", async () => {
    const { seed, lease } = fixture();
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).includes("/auth/o2/token") ? json({ access_token: "synthetic-access" }) : json({}, 429));
    await expect(executeStoreNodeOrderSync({ seed, lease, request: request as typeof fetch, exchange: async (_call, send) => send() })).rejects.toMatchObject({ code: "rate_limited" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
