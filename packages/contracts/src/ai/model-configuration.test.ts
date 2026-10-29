import { describe, expect, it } from "vitest";
import { ConfigurationRpcSchema, TextProtocolSchema, emptyModelDefaults, modelConfigurationRemovalFailure, publicModelConfigurationError } from "./model-configuration.js";

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

describe("model configuration removal public failures", () => {
  const failures = [
    ["model_configuration_revision_conflict", 409, "rejected", "渠道或模型配置已变化 本次未删除 请读取最新配置后重新确认"],
    ["model_configuration_channel_referenced", 409, "rejected", "该渠道仍被业务路由使用 本次未删除 请先调整关联路由"],
    ["model_configuration_channel_busy", 409, "rejected", "该渠道仍有排队或进行中的任务 本次未删除 请先完成或取消相关任务"],
    ["model_configuration_model_busy", 409, "rejected", "该模型仍有排队或进行中的任务 本次未删除 请先完成或取消相关任务"],
    ["model_configuration_channel_missing", 404, "missing", "当前渠道不存在或已删除 请读取原配置核对"],
    ["model_configuration_model_missing", 404, "missing", "当前模型不存在或已删除 请读取原配置核对"],
  ] as const;

  it.each(failures)("recognizes only native %s at HTTP %i with its fixed presentation", (code, status, outcome, message) => {
    const expected = { code, status, outcome, message };
    expect(publicModelConfigurationError(code, status)).toEqual(expected);
    expect(modelConfigurationRemovalFailure(message)).toEqual(expected);
    for (const wrongStatus of [200, 503, status === 409 ? 404 : 409])
      expect(publicModelConfigurationError(code, wrongStatus)).toBeNull();
  });

  it("does not classify unknown codes, prototype keys or coercible values as a verified rejection", () => {
    for (const code of ["__proto__", "constructor", "toString", "model_configuration_unknown", "model_configuration_channel_busy ", null, {}, 409])
      expect(publicModelConfigurationError(code, 409)).toBeNull();
  });

  it("requires exact fixed iframe messages and never accepts a provider diagnostic or a modified public message", () => {
    for (const [, , , message] of failures) {
      for (const altered of [` ${message}`, `${message} `, `${message}\n`, `${message} PRIVATE_DIAGNOSTIC`, { message }])
        expect(modelConfigurationRemovalFailure(altered)).toBeNull();
    }
    expect(modelConfigurationRemovalFailure("删除结果尚未核对 请读取原配置确认 未自动重试")).toBeNull();
    expect(modelConfigurationRemovalFailure("该渠道仍有排队或进行中的任务，PRIVATE_DIAGNOSTIC")).toBeNull();
  });
});
