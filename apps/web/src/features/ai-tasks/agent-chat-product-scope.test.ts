import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { agentChatAssistRequest } from "@yummyai/contracts/ai/agent-chat";
import { AssistViewSchema, CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { exactAgentChatProduct, restoredAgentChatProduct } from "./agent-chat-product-scope";

const product = { id: createEntityId(), code: "SYNTHETIC-PILLOW", name: "定制异形抱枕" };
const second = { id: createEntityId(), code: "SYNTHETIC-COVER", name: "定制轮胎罩" };
const scopeId = randomUUID();
function nativeRequest(spuIds: string[]) {
  return CreateAssistSchema.parse({
    kind: "knowledge_answer",
    requestId: randomUUID(),
    scopeId,
    modelId: createEntityId(),
    purpose: "dialogue",
    previousRunId: null,
    evidenceStoreId: null,
    taskGoal: "Synthetic original question",
    search: {
      query: "Synthetic original question",
      topic: "all",
      platform: "all",
      market: "ALL",
      spuIds,
    },
  });
}
function originalTurn(spuIds: string[]) {
  return AssistViewSchema.parse({
    id: createEntityId(),
    kind: "knowledge_answer",
    scope: "knowledge:" + scopeId,
    status: "completed",
    createdAt: "2026-10-30T00:00:00.000Z",
    completedAt: "2026-10-30T00:01:00.000Z",
    modelLabel: "Synthetic product-context model",
    model: "synthetic",
    promptVersion: "synthetic-v1",
    inputFingerprint: "a".repeat(64),
    stale: false,
    maxTaskCostUsd: null,
    request: nativeRequest(spuIds),
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: null,
    diagnostics: [],
    sources: [],
    checks: [],
    result: null,
  });
}

describe("agent dialogue exact product scope", () => {
  it("recognizes the one complete catalog name, including the documented leading-prefix alias", () => {
    expect(exactAgentChatProduct("定制异形抱枕的生产文件要求", [product, second])).toEqual(product);
    expect(exactAgentChatProduct("异形抱枕的生产文件要求", [product, second])).toEqual(product);
    expect(exactAgentChatProduct("轮胎罩的包装要求", [product, second])).toEqual(second);
  });

  it("does not guess from fragments, product codes, or ambiguous names", () => {
    expect(exactAgentChatProduct("抱枕怎么做", [product, second])).toBeNull();
    expect(exactAgentChatProduct(product.code, [product, second])).toBeNull();
    expect(
      exactAgentChatProduct("异形抱枕要求", [product, { ...second, name: "异形抱枕" }]),
    ).toBeNull();
    expect(exactAgentChatProduct("异形抱枕和轮胎罩", [product, second])).toBeNull();
  });

  it("keeps a partial product catalogue explicit rather than assuming its one visible match is globally unique", () => {
    expect(exactAgentChatProduct("异形抱枕要求", [product], true)).toBeNull();
    expect(exactAgentChatProduct("未登记商品", [product, second])).toBeNull();
  });

  it("does not match a Latin product name embedded in another word", () => {
    const hat = { ...product, name: "Hat" };
    expect(exactAgentChatProduct("TopHat size", [hat])).toBeNull();
    expect(exactAgentChatProduct("Hatband", [hat])).toBeNull();
    expect(exactAgentChatProduct("Hat size", [hat])).toEqual(hat);
  });

  it("pins an explicit product in the exact native intent while retaining backward-compatible general knowledge", () => {
    const input = {
      requestId: randomUUID(),
      scopeId,
      previousRunId: null,
      modelId: createEntityId(),
      message: "Synthetic product question",
    };
    const general = agentChatAssistRequest(input),
      specific = agentChatAssistRequest({ ...input, spuIds: [product.id] });
    expect(general.kind === "knowledge_answer" && general.search.spuIds).toEqual([]);
    expect(specific.kind === "knowledge_answer" && specific.search.spuIds).toEqual([product.id]);
    expect(assistRequestRecoveryText(specific)).not.toBe(assistRequestRecoveryText(general));
    expect(() => agentChatAssistRequest({ ...input, spuIds: [product.id, second.id] })).toThrow();
  });

  it("restores the original product instead of deriving one from a later question", () => {
    const first = originalTurn([product.id]),
      followup = originalTurn([product.id]);
    if (followup.request?.kind === "knowledge_answer") followup.request.taskGoal = "轮胎罩的工艺";
    expect(restoredAgentChatProduct([first, followup])).toEqual({
      id: product.id,
      blockedReason: "",
    });
    expect(restoredAgentChatProduct([originalTurn([])])).toEqual({ id: "", blockedReason: "" });
  });

  it("keeps legacy multi-product and changing-scope conversations read-only rather than dropping product IDs", () => {
    expect(
      restoredAgentChatProduct([originalTurn([product.id, second.id])]).blockedReason,
    ).toContain("多个商品");
    expect(
      restoredAgentChatProduct([originalTurn([product.id]), originalTurn([second.id])])
        .blockedReason,
    ).toContain("不同商品范围");
  });

  it("does not reconstruct unavailable original scope from a newer readable turn", () => {
    const expired = { ...originalTurn([product.id]), request: null };
    expect(restoredAgentChatProduct([expired, originalTurn([product.id])])).toEqual({
      id: "",
      blockedReason: "原对话适用商品尚不可核对 请读取原任务后继续",
    });
    expect(restoredAgentChatProduct([])).toEqual({ id: "", blockedReason: "" });
  });
});
