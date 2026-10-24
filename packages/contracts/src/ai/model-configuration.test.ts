import { describe, expect, it } from "vitest";
import { ConfigurationRpcSchema, TextProtocolSchema, emptyModelDefaults } from "./model-configuration.js";

const channel = () => ({ operation: "channel.save", name: "Synthetic local service",
  baseUrl: "http://localhost:8080/v1", apiKey: "synthetic-test-only",
  models: [{ name: "synthetic-text", capability: "text" }] });

describe("model channel text protocol contract", () => {
  it("preserves an older save without silently assigning a new protocol", () => {
    const original = channel();
    expect(ConfigurationRpcSchema.parse(original)).toEqual(original);
    expect(ConfigurationRpcSchema.parse(original)).not.toHaveProperty("textProtocol");
  });

  it.each(["responses", "chat_completions"])("accepts the explicit %s protocol", textProtocol => {
    expect(ConfigurationRpcSchema.parse({ ...channel(), textProtocol })).toMatchObject({ textProtocol });
    expect(TextProtocolSchema.parse(textProtocol)).toBe(textProtocol);
  });

  it("rejects unknown, null and non-string protocols", () => {
    for (const textProtocol of ["chat", "Responses", "responses\n", "", null, {}, 1])
      expect(ConfigurationRpcSchema.safeParse({ ...channel(), textProtocol }).success).toBe(false);
  });

  it("allows protocol selection only on channel saves", () => {
    for (const original of [{ operation: "configuration.get" },
      { operation: "channel.discover", baseUrl: "http://localhost:8080/v1", apiKey: "synthetic-test-only" },
      { operation: "defaults.save", revision: 0, defaults: emptyModelDefaults() }]) {
      expect(ConfigurationRpcSchema.safeParse(original).success).toBe(true);
      expect(ConfigurationRpcSchema.safeParse({ ...original, textProtocol: "responses" }).success).toBe(false);
    }
  });

  it("keeps authority and credential storage fields outside the caller contract", () => {
    for (const extra of [{ tenantId: "synthetic" }, { provider: "openai" }, { encryptedApiKey: "synthetic" },
      { models: [{ name: "synthetic-text", capability: "text", textProtocol: "responses" }] }])
      expect(ConfigurationRpcSchema.safeParse({ ...channel(), textProtocol: "responses", ...extra }).success).toBe(false);
  });
});
