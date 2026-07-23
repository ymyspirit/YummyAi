import type { MarketplaceConnectorContext, MarketplaceCredentialAccessor } from "./connector.js";
import { describe, expect, it, vi } from "vitest";

import { AmazonShipmentWritebackConnector, EtsyShipmentWritebackConnector } from "./shipment-writeback.js";

const credentials: MarketplaceCredentialAccessor = { withCredential: (work) => work({ accessToken: "secret-token" }) };
const input = {
  externalOrderId: "123456789", shipDate: "2026-07-22T10:00:00.000Z",
  packages: [{ packageReferenceId: "PKG-1", trackingNumber: "TRACK-1", carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground", lines: [{ externalLineId: "LINE-1", quantity: 1 }] }],
};

describe("shipment writeback connectors", () => {
  it("maps an approved Amazon shipment to confirmShipment", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204, headers: { "x-amzn-requestid": "amazon-ack-1" } }));
    const connector = new AmazonShipmentWritebackConnector(request, {});
    const context: MarketplaceConnectorContext = { tenantId: "tenant", accountId: "account", platform: "amazon", region: "NA", externalAccountId: "seller", marketplaceIds: ["ATVPDKIKX0DER"] };
    const result = await connector.confirm(context, credentials, input, new AbortController().signal);
    expect(result).toEqual({ status: "accepted", providerCode: "HTTP_204", externalReference: "amazon-ack-1" });
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/orders/v0/orders/123456789/shipmentConfirmation"), expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ marketplaceId: "ATVPDKIKX0DER", packageDetail: { packageReferenceId: "PKG-1", trackingNumber: "TRACK-1", orderItems: [{ orderItemId: "LINE-1", quantity: 1 }] } });
  });

  it("posts Etsy tracking with transactions_w-compatible fields", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200, headers: { "x-request-id": "etsy-ack-1" } }));
    const connector = new EtsyShipmentWritebackConnector(request, { ETSY_APP_KEYSTRING: "key", ETSY_APP_SHARED_SECRET: "shared" });
    const context: MarketplaceConnectorContext = { tenantId: "tenant", accountId: "account", platform: "etsy", region: "GLOBAL", externalAccountId: "42", marketplaceIds: [] };
    const result = await connector.confirm(context, credentials, input, new AbortController().signal);
    expect(result).toEqual({ status: "accepted", providerCode: "HTTP_200", externalReference: "etsy-ack-1" });
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/shops/42/receipts/123456789/tracking"), expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ tracking_code: "TRACK-1", carrier_name: "UPS", mail_class: "Ground", send_bcc: false, ship_date: "2026-07-22" });
  });

  it("classifies a lost mutation response as uncertain without leaking credentials", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("Authorization: Bearer secret-token"));
    const connector = new AmazonShipmentWritebackConnector(request, {});
    const context: MarketplaceConnectorContext = { tenantId: "tenant", accountId: "account", platform: "amazon", region: "NA", externalAccountId: "seller", marketplaceIds: ["ATVPDKIKX0DER"] };
    const result = await connector.confirm(context, credentials, input, new AbortController().signal);
    expect(result).toEqual({ status: "uncertain", providerCode: "NETWORK_OUTCOME_UNKNOWN", externalReference: null });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
