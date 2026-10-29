import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { AssistViewSchema, CreateAssistSchema } from "./assist.js";
import { assistRequestRecoveryText } from "./assist-recovery.js";
import {
  AGENT_CHAT_EVENT_VERSION,
  AgentChatEventSchema,
  AgentChatHistorySchema,
  AgentChatStreamRequestSchema,
  CreateAgentChatTurnSchema,
  agentChatAssistRequest,
} from "./agent-chat.js";

const hash = "b".repeat(64);
const turn = () =>
  CreateAgentChatTurnSchema.parse({
    requestId: randomUUID(),
    scopeId: randomUUID(),
    previousRunId: null,
    modelId: createEntityId(),
    message: "Synthetic scoped operating question",
  });
const run = () => {
  const input = agentChatAssistRequest(turn());
  if (input.kind !== "knowledge_answer") throw new Error("synthetic_knowledge_request_required");
  return AssistViewSchema.parse({
    id: createEntityId(),
    kind: "knowledge_answer",
    scope: "knowledge:" + input.scopeId,
    status: "completed",
    createdAt: "2026-10-30T00:00:00.000Z",
    completedAt: "2026-10-30T00:00:01.000Z",
    modelLabel: "Synthetic model",
    model: "synthetic-model",
    promptVersion: "synthetic",
    inputFingerprint: hash,
    stale: false,
    maxTaskCostUsd: null,
    request: input,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: null,
    diagnostics: [],
    sources: [],
    checks: [],
    result: {
      summary: "Synthetic scoped answer",
      findings: [],
      directions: [],
      matches: [],
      missingInformation: [],
    },
  });
};

describe("Interactive Agent original request contracts", () => {
  it("normalizes one substantive message without accepting caller authority or budget overrides", () => {
    const input = turn();
    expect(CreateAgentChatTurnSchema.parse({ ...input, message: "  核对生产要求  " }).message).toBe(
      "核对生产要求",
    );
    for (const message of ["", " \n ", "a".repeat(2001)])
      expect(CreateAgentChatTurnSchema.safeParse({ ...input, message }).success).toBe(false);
    for (const field of [
      "tenantId",
      "userId",
      "permissions",
      "contextAuthority",
      "maxCostUsd",
      "maxOutputTokens",
      "purpose",
    ])
      expect(
        CreateAgentChatTurnSchema.safeParse({ ...input, [field]: "synthetic-untrusted" }).success,
      ).toBe(false);
  });

  it("binds the full turn to the native durable request while bounding only the retrieval query", () => {
    const input = { ...turn(), previousRunId: createEntityId(), message: "界".repeat(2000) };
    const before = JSON.stringify(input),
      request = agentChatAssistRequest(input);
    expect(request).toMatchObject({
      kind: "knowledge_answer",
      purpose: "dialogue",
      evidenceStoreId: null,
      requestId: input.requestId,
      scopeId: input.scopeId,
      previousRunId: input.previousRunId,
      modelId: input.modelId,
      taskGoal: input.message,
      search: { query: "界".repeat(300), topic: "all", platform: "all", market: "ALL", spuIds: [] },
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(assistRequestRecoveryText(request)).toBe(
      JSON.stringify(CreateAssistSchema.parse(request)),
    );
    expect(assistRequestRecoveryText(request)).toBe(
      assistRequestRecoveryText(agentChatAssistRequest({ ...input })),
    );
    expect(assistRequestRecoveryText(request)).not.toBe(
      assistRequestRecoveryText(
        agentChatAssistRequest({ ...input, message: input.message.slice(0, -1) + "变" }),
      ),
    );
  });

  it("requires an exact original receipt fingerprint when opening or reconnecting a stream", () => {
    const proof = { requestId: randomUUID(), inputFingerprint: hash };
    expect(AgentChatStreamRequestSchema.parse(proof)).toEqual(proof);
    for (const inputFingerprint of ["", "b".repeat(63), "B".repeat(64), "not-a-checksum"])
      expect(AgentChatStreamRequestSchema.safeParse({ ...proof, inputFingerprint }).success).toBe(
        false,
      );
    for (const field of ["message", "modelId", "scopeId", "restart", "retry", "tenantId"])
      expect(
        AgentChatStreamRequestSchema.safeParse({ ...proof, [field]: "synthetic" }).success,
      ).toBe(false);
  });

  it("pins the chosen product scope in the original native intent without changing conversation or request identity", () => {
    const productId = createEntityId(),
      input = { ...turn(), spuIds: [productId] };
    const before = JSON.stringify(input),
      native = agentChatAssistRequest(input);
    expect(native).toMatchObject({
      kind: "knowledge_answer",
      requestId: input.requestId,
      scopeId: input.scopeId,
      previousRunId: input.previousRunId,
      modelId: input.modelId,
      search: { spuIds: [productId] },
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(assistRequestRecoveryText(native)).toBe(
      JSON.stringify(CreateAssistSchema.parse(native)),
    );
    expect(assistRequestRecoveryText(native)).not.toBe(
      assistRequestRecoveryText(agentChatAssistRequest({ ...input, spuIds: [] })),
    );
    expect(assistRequestRecoveryText(native)).not.toBe(
      assistRequestRecoveryText(agentChatAssistRequest({ ...input, spuIds: [createEntityId()] })),
    );
    expect(
      CreateAgentChatTurnSchema.safeParse({ ...input, tenantId: createEntityId() }).success,
    ).toBe(false);
    expect(
      AgentChatStreamRequestSchema.safeParse({
        requestId: input.requestId,
        inputFingerprint: hash,
        spuIds: input.spuIds,
      }).success,
    ).toBe(false);
  });

  it("rejects multiple product choices and malformed product references instead of silently broadening scope", () => {
    const input = turn(),
      productId = createEntityId();
    expect(CreateAgentChatTurnSchema.parse({ ...input, spuIds: [] }).spuIds).toEqual([]);
    expect(CreateAgentChatTurnSchema.parse({ ...input, spuIds: [productId] }).spuIds).toEqual([
      productId,
    ]);
    for (const spuIds of [
      [productId, createEntityId()],
      [productId, productId],
      [randomUUID()],
      ["all"],
      ["*"],
    ])
      expect(CreateAgentChatTurnSchema.safeParse({ ...input, spuIds }).success).toBe(false);
  });
});

describe("Interactive Agent stream and history envelopes", () => {
  const envelope = () => ({
    version: AGENT_CHAT_EVENT_VERSION,
    runId: createEntityId(),
    requestId: randomUUID(),
    contextAuthority: "synthetic-current-authority",
    sequence: 1,
  });

  it("allows display text deltas but rejects hidden reasoning, arbitrary payloads and invalid sequence numbers", () => {
    const event = { ...envelope(), type: "text_delta", text: "正在核对 已收到的真实增量" };
    expect(AgentChatEventSchema.parse(event)).toEqual(event);
    for (const type of ["reasoning_delta", "tool_execute", "business_approved", "invoice_paid"])
      expect(AgentChatEventSchema.safeParse({ ...event, type }).success).toBe(false);
    for (const sequence of [0, -1, 1.5])
      expect(AgentChatEventSchema.safeParse({ ...event, sequence }).success).toBe(false);
    expect(
      AgentChatEventSchema.safeParse({ ...event, rawPrompt: "synthetic-private-prompt" }).success,
    ).toBe(false);
    expect(AgentChatEventSchema.safeParse({ ...event, text: "" }).success).toBe(false);
  });

  it("adopts a final answer only when its native run and request match the event coordinates", () => {
    const native = run(),
      requestId = native.request!.requestId;
    const event = { ...envelope(), type: "completed", runId: native.id, requestId, run: native };
    expect(AgentChatEventSchema.parse(event)).toEqual(event);
    expect(AgentChatEventSchema.safeParse({ ...event, runId: createEntityId() }).success).toBe(
      false,
    );
    expect(AgentChatEventSchema.safeParse({ ...event, requestId: randomUUID() }).success).toBe(
      false,
    );
    expect(
      AgentChatEventSchema.safeParse({ ...event, run: { ...native, request: null } }).success,
    ).toBe(false);
  });

  it("keeps incomplete history explicit and preserves unknown usage through a successful answer", () => {
    const native = run();
    if (native.request?.kind !== "knowledge_answer")
      throw new Error("synthetic_knowledge_request_required");
    const history = AgentChatHistorySchema.parse({
      contextAuthority: "synthetic-current-authority",
      scopeId: native.request.scopeId,
      turns: [native],
      hasMore: true,
    });
    expect(history.hasMore).toBe(true);
    expect(history.turns[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      maxTaskCostUsd: null,
    });
    expect(history.turns[0]!.result?.summary).toBe("Synthetic scoped answer");
    expect(AgentChatHistorySchema.safeParse({ ...history, hasMore: undefined }).success).toBe(
      false,
    );
  });

  it("rejects another scope, a different task family or evaluation records in conversation history", () => {
    const native = run();
    if (native.request?.kind !== "knowledge_answer")
      throw new Error("synthetic_knowledge_request_required");
    const history = {
      contextAuthority: "synthetic-current-authority",
      scopeId: native.request.scopeId,
      turns: [native],
      hasMore: false,
    };
    expect(AgentChatHistorySchema.safeParse({ ...history, scopeId: randomUUID() }).success).toBe(
      false,
    );
    for (const changed of [
      { ...native, scope: "knowledge:" + randomUUID() },
      { ...native, kind: "creative" },
      { ...native, request: { ...native.request, purpose: "evaluation" } },
    ])
      expect(AgentChatHistorySchema.safeParse({ ...history, turns: [changed] }).success).toBe(
        false,
      );
  });

  it("requires a terminal native status before accepting a completed stream envelope", () => {
    const native = run(),
      event = {
        ...envelope(),
        type: "completed",
        runId: native.id,
        requestId: native.request!.requestId,
        run: native,
      };
    for (const status of ["queued", "running"])
      expect(AgentChatEventSchema.safeParse({ ...event, run: { ...native, status } }).success).toBe(
        false,
      );
    for (const status of ["failed", "cancelled"])
      expect(
        AgentChatEventSchema.safeParse({ ...event, run: { ...native, status, result: null } })
          .success,
      ).toBe(true);
  });

  it("restricts public stream errors to safe recovery codes", () => {
    const event = { ...envelope(), type: "error", code: "result_unknown" };
    expect(AgentChatEventSchema.parse(event)).toEqual(event);
    expect(
      AgentChatEventSchema.safeParse({ ...event, code: "provider-secret-response" }).success,
    ).toBe(false);
    expect(
      AgentChatEventSchema.safeParse({ ...event, providerError: "synthetic-secret" }).success,
    ).toBe(false);
  });
});
