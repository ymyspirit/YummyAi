import { describe, expect, it, vi } from "vitest";

import { PrintfulProductionOrderConnector, PrintifyProductionOrderConnector } from "./production-order.connector.js";

describe("supplier production order connectors", () => {
  it("creates a Printify draft and submits it through the separate production endpoint", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "printify-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "printify-1" }), { status: 200 }));
    const connector = new PrintifyProductionOrderConnector({ accessToken: "secret", accountId: "shop-7" }, request);
    expect(await connector.createDraft(input())).toEqual({ provider: "printify", externalOrderId: "printify-1", status: "draft" });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.printify.com/v1/shops/shop-7/orders.json");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ external_id: "po-1", send_shipping_notification: false, line_items: [{ product_id: "product-4", variant_id: 4012, quantity: 2 }] });
    expect(await connector.submit("printify-1")).toEqual({ provider: "printify", externalOrderId: "printify-1", status: "submitted" });
    expect(request.mock.calls[1]?.[0]).toBe("https://api.printify.com/v1/shops/shop-7/orders/printify-1/send_to_production.json");
  });

  it("creates an unconfirmed Printful draft and confirms only in the explicit submit call", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, result: { id: 91 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, result: { id: 91 } }), { status: 200 }));
    const connector = new PrintfulProductionOrderConnector({ accessToken: "secret", accountId: "store-3" }, request);
    expect(await connector.createDraft(input())).toEqual({ provider: "printful", externalOrderId: "91", status: "draft" });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.printful.com/orders?confirm=false&update_existing=true");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ external_id: "po-1", items: [{ sync_variant_id: 4012, quantity: 2, files: [{ type: "default", url: "https://assets.example.test/print.png" }] }] });
    expect(await connector.submit("91")).toEqual({ provider: "printful", externalOrderId: "91", status: "submitted" });
    expect(request.mock.calls[1]?.[0]).toBe("https://api.printful.com/orders/91/confirm");
  });

  it("returns status-only errors without leaking token or provider response bodies", async () => {
    const connector = new PrintifyProductionOrderConnector({ accessToken: "never-log-me", accountId: "shop-7" }, vi.fn<typeof fetch>().mockResolvedValue(new Response("recipient address leaked", { status: 422 })));
    await expect(connector.createDraft(input())).rejects.toThrow("Printify production order request failed (422)");
    await expect(connector.createDraft(input())).rejects.not.toThrow(/never-log-me|recipient address leaked/);
  });
});

function input() {
  return {
    externalOrderId: "po-1", shippingMethod: "STANDARD",
    recipient: { firstName: "Ada", lastName: "Lovelace", company: null, address1: "1 Example St", address2: null, city: "Seattle", region: "WA", postalCode: "98101", countryCode: "US", email: null, phone: null },
    lines: [{ externalLineId: "line-1", providerProductId: "product-4", providerVariantId: "4012", quantity: 2, fileUrls: ["https://assets.example.test/print.png"] }],
  };
}
