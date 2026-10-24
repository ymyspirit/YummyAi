import { describe, expect, it, vi } from "vitest";
import { discoverProviderModels, modelEndpoint } from "./model-catalogue.js";

describe("OpenAI model directory", () => {
  it("normalizes base addresses and only returns unique valid model identifiers", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "model-z", apiKey: "never-return" }, { id: "model-a" }, { id: "model-z" }, { id: "<html>" }, {}] }));
    const result = await discoverProviderModels("https://api.openai.com/", "synthetic-key", transport);
    expect(result).toMatchObject({ models: ["model-a", "model-z"], source: "provider", skipped: 2 });
    expect(JSON.stringify(result)).not.toContain("never-return");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({ redirect: "error", headers: { authorization: "Bearer synthetic-key" } }));
    expect(modelEndpoint("https://api.example.test/proxy/v1///")).toBe("https://api.example.test/proxy/v1");
  });
  it.each(["http://example.test", "https://user:pass@example.test", "https://example.test?key=secret", "https://example.test/v1/models", "https://example.test/v1/images/generations"])("rejects invalid endpoint %s", endpoint => {
    expect(() => modelEndpoint(endpoint)).toThrow();
  });
  it.each([401, 403, 404, 429, 500])("redacts an HTTP %s failure and does not retry", async status => {
    const transport = vi.fn().mockResolvedValue(new Response("synthetic-private-provider-body", { status }));
    const cause = await discoverProviderModels("https://api.example.test/v1", "synthetic", transport).catch(cause => cause as Error);
    expect(cause).toBeInstanceOf(Error);
    expect(String(cause)).not.toContain("synthetic-private-provider-body");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("keeps an empty list distinct from malformed or oversized responses", async () => {
    await expect(discoverProviderModels("https://api.example.test", "synthetic", vi.fn().mockResolvedValue(Response.json({ data: [] })))).resolves.toMatchObject({ models: [] });
    for (const response of [Response.json({ error: "secret" }), new Response("not-json"), new Response("x".repeat(2_000_001))]) {
      await expect(discoverProviderModels("https://api.example.test", "synthetic", vi.fn().mockResolvedValue(response))).rejects.toThrow();
    }
  });
  it("reports timeout without leaking the transport error", async () => {
    const transport = vi.fn().mockRejectedValue(new DOMException("private request", "TimeoutError"));
    await expect(discoverProviderModels("https://api.example.test", "synthetic", transport)).rejects.toThrow("读取渠道模型目录超时");
  });
});
