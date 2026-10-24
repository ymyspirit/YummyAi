import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SaveShiposConnectionSchema, SyncShiposOrdersSchema } from "./shipos.js";
describe("ShipOS readonly commands", () => {
  it("permits a name-only draft but requires paired credentials when replacing them", () => {
    const input = { name: "ShipOS", status: "draft", expectedVersion: 0, idempotencyKey: randomUUID() };
    expect(SaveShiposConnectionSchema.safeParse(input).success).toBe(true);
    expect(SaveShiposConnectionSchema.safeParse({ ...input, appKey: "synthetic" }).success).toBe(false);
    expect(SaveShiposConnectionSchema.safeParse({ ...input, appKey: "synthetic", appSecret: "synthetic", clearCredentials: true }).success).toBe(false);
    expect(SaveShiposConnectionSchema.safeParse({ ...input, appKey: "synthetic\r\nheader", appSecret: "synthetic" }).success).toBe(false);
  });
  it("bounds existing-order batches and rejects tenant selection, endpoint overrides or billing commands", () => {
    const input = { orderNumbers: ["SYNTH-1"], expectedVersion: 1, idempotencyKey: randomUUID() };
    expect(SyncShiposOrdersSchema.safeParse(input).success).toBe(true);
    for (const value of [{ ...input, tenantId: randomUUID() }, { ...input, action: "createOrder" }, { ...input, endpoint: "https://other.test" }, { ...input, orderNumbers: ["A", "A"] }, { ...input, orderNumbers: Array.from({ length: 6 }, (_, i) => `SYNTH-${i}`) }, { ...input, orderNumbers: ["A,B"] }]) expect(SyncShiposOrdersSchema.safeParse(value).success).toBe(false);
  });
  it("requires explicit complete carrier mapping and rejects duplicate channels", () => {
    const input = { name: "ShipOS", status: "draft", expectedVersion: 0, idempotencyKey: randomUUID() };
    const mapping = { channel: "Synthetic channel", carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground", shipFromCountryCode: "CN" };
    expect(SaveShiposConnectionSchema.safeParse({ ...input, channelMappings: [mapping] }).success).toBe(true);
    for (const mappings of [[mapping, mapping], [{ ...mapping, carrierCode: "guess from tracking" }], [{ ...mapping, shipFromCountryCode: "" }]])
      expect(SaveShiposConnectionSchema.safeParse({ ...input, channelMappings: mappings }).success).toBe(false);
  });
});
