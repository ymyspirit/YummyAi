import { CreateIntegrationApiClientInputSchema, CreateWebhookEndpointInputSchema } from "./integration.js";
import { describe, expect, it } from "vitest";

describe("integration contracts", () => {
  it("requires unique least-privilege API scopes", () => {
    expect(CreateIntegrationApiClientInputSchema.parse({ label: "BI read", scopes: ["forecast:read", "operations:read"], expiresAt: null, idempotencyKey: "api-client-1" }).scopes).toHaveLength(2);
    expect(() => CreateIntegrationApiClientInputSchema.parse({ label: "duplicate", scopes: ["forecast:read", "forecast:read"], expiresAt: null, idempotencyKey: "api-client-2" })).toThrow(/unique/i);
  });

  it("requires HTTPS except for loopback webhooks", () => {
    const base = { label: "forecast sink", eventTypes: ["forecast.completed"], maxAttempts: 5, idempotencyKey: "webhook-endpoint-1" } as const;
    expect(CreateWebhookEndpointInputSchema.parse({ ...base, url: "https://example.test/yummyai" }).url).toBe("https://example.test/yummyai");
    expect(CreateWebhookEndpointInputSchema.parse({ ...base, url: "http://127.0.0.1:9090/yummyai" }).url).toContain("127.0.0.1");
    expect(CreateWebhookEndpointInputSchema.parse({ ...base, url: "http://[::1]:9090/yummyai" }).url).toContain("[::1]");
    expect(() => CreateWebhookEndpointInputSchema.parse({ ...base, url: "http://example.test/yummyai" })).toThrow(/HTTPS/i);
  });
});
