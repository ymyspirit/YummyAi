import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { AssistViewSchema } from "@yummyai/contracts/ai/assist";
import {
  agentChatAssistRequest,
  CreateAgentChatTurnSchema,
  type AgentChatEvent,
} from "@yummyai/contracts/ai/agent-chat";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { PersonalSessionError } from "../../../../identity/core";

const mocks = vi.hoisted(() => ({
  upstream: vi.fn<typeof fetch>(),
  identity: vi.fn(),
  current: vi.fn<() => Promise<void>>(),
  failure: vi.fn(),
}));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({
  erpRequestIdentity: mocks.identity,
  assertErpIdentityCurrent: mocks.current,
  erpAuthFailure: mocks.failure,
}));
import { GET, POST } from "./route";

const origin = "http://chat-web.test";
const actor: ErpSessionView = {
  authenticated: true,
  canUseErp: true,
  tenantId: createEntityId(),
  userId: createEntityId(),
  displayName: "Synthetic agent dialogue operator",
  organizationName: "Synthetic isolated tenant",
  dataScope: "tenant",
  permissions: ["workflow:read", "workflow:run"],
  permissionScopes: { "workflow:read": "tenant", "workflow:run": "tenant" },
};
const authority = erpSessionAuthority(actor);
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const turn = () =>
  CreateAgentChatTurnSchema.parse({
    requestId: randomUUID(),
    scopeId: randomUUID(),
    previousRunId: null,
    modelId: createEntityId(),
    message: "Synthetic complete knowledge question",
  });
function view(input = turn(), status: "queued" | "completed" | "failed" = "queued") {
  return AssistViewSchema.parse({
    id: createEntityId(),
    kind: "knowledge_answer",
    scope: "knowledge:" + input.scopeId,
    status,
    createdAt: "2026-10-30T00:00:00.000Z",
    completedAt: status === "queued" ? null : "2026-10-30T00:01:00.000Z",
    modelLabel: "Synthetic stream model",
    model: "synthetic",
    promptVersion: "synthetic-v1",
    inputFingerprint: "a".repeat(64),
    stale: false,
    maxTaskCostUsd: null,
    request: agentChatAssistRequest(input),
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: status === "failed" ? "Synthetic original failure" : null,
    diagnostics: [],
    sources: [],
    checks: [],
    result:
      status === "completed"
        ? {
            summary: "Synthetic verified final answer",
            findings: [],
            directions: [],
            matches: [],
            missingInformation: [],
          }
        : null,
  });
}
function incoming(path: string[], body?: unknown, stamp = authority, requestOrigin = origin) {
  return new Request(origin + "/api/agent-chat/" + path.join("/"), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-yummyai-context-authority": stamp,
      ...(body === undefined
        ? {}
        : {
            origin: requestOrigin,
            "content-type": "application/json",
            authorization: "synthetic-browser-credential",
          }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const streamHeaders = () => ({
  "content-type": "text/event-stream; charset=utf-8",
  "x-yummyai-context-authority": authority,
});
function envelope(run: ReturnType<typeof view>, sequence: number) {
  return {
    version: "agent-chat-event-v1" as const,
    runId: run.id,
    requestId: run.request!.requestId,
    contextAuthority: authority,
    sequence,
  };
}
const sse = (event: unknown, ending = "\n\n") => "data: " + JSON.stringify(event) + ending;
function finalEvent(run: ReturnType<typeof view>, sequence: number): AgentChatEvent {
  return { ...envelope(run, sequence), type: "completed", run };
}
const startBody = (run: ReturnType<typeof view>) => ({
  requestId: run.request!.requestId,
  inputFingerprint: run.inputFingerprint,
});

describe("authenticated agent conversation BFF stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upstream.mockReset();
    mocks.current.mockReset();
    mocks.current.mockResolvedValue();
    mocks.identity.mockResolvedValue({
      view: actor,
      service: { configuration: { apiBase: "http://chat-api.test" } },
    });
    mocks.failure.mockImplementation((error: PersonalSessionError) =>
      Response.json({ code: error.code }, { status: error.status }),
    );
  });

  it("rejects foreign writes and stale authority before any upstream submission", async () => {
    const path = ["turns"],
      input = turn();
    expect(
      (await POST(incoming(path, input, authority, "http://foreign.test"), context(path))).status,
    ).toBe(403);
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(
      (await POST(incoming(path, input, "synthetic-stale-authority"), context(path))).status,
    ).toBe(409);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("checks each original native field and scope on create and never forwards browser credentials", async () => {
    const input = turn(),
      run = view(input),
      path = ["turns"];
    mocks.upstream.mockResolvedValueOnce(Response.json(run, { status: 201 }));
    const result = await POST(incoming(path, input), context(path));
    expect(result.status).toBe(201);
    expect((await result.json()).request).toEqual(agentChatAssistRequest(input));
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(mocks.upstream).toHaveBeenCalledWith(
      "http://chat-api.test/v1/agent-chat/turns",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        headers: { accept: "application/json", "content-type": "application/json" },
        redirect: "error",
      }),
    );
    for (const changed of [
      { ...run, scope: "knowledge:" + randomUUID() },
      { ...run, request: agentChatAssistRequest({ ...input, previousRunId: createEntityId() }) },
    ]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(changed, { status: 201 }));
      expect((await POST(incoming(path, input), context(path))).status).toBe(502);
    }
    expect(mocks.upstream).toHaveBeenCalledTimes(3);
  });

  it("forwards a real text chunk before the upstream produces its completed envelope", async () => {
    const run = view(turn(), "completed"),
      path = ["runs", run.id, "stream"],
      encoder = new TextEncoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    mocks.upstream.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
          },
        }),
        { headers: streamHeaders() },
      ),
    );
    const reply = await POST(incoming(path, startBody(run)), context(path));
    expect(reply.headers.get("x-accel-buffering")).toBe("no");
    expect(reply.headers.get("x-yummyai-context-authority")).toBe(authority);
    const reader = reply.body!.getReader();
    upstream.enqueue(
      encoder.encode(sse({ ...envelope(run, 1), type: "text_delta", text: "实时收到" })),
    );
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("实时收到");
    expect(new TextDecoder().decode(first.value)).not.toContain("completed");
    upstream.enqueue(encoder.encode(sse(finalEvent(run, 2))));
    upstream.close();
    let rest = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      rest += new TextDecoder().decode(part.value);
    }
    reader.releaseLock();
    expect(rest).toContain("Synthetic verified final answer");
    expect(mocks.upstream).toHaveBeenCalledOnce();
  });

  it("accepts fragmented UTF8 and standard CRLF without buffering the whole response", async () => {
    const run = view(turn(), "completed"),
      path = ["runs", run.id, "stream"];
    const bytes = new TextEncoder().encode(
      sse({ ...envelope(run, 1), type: "text_delta", text: "生产资料" }, "\r\n\r\n") +
        sse(finalEvent(run, 2), "\r\n\r\n"),
    );
    mocks.upstream.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
        { headers: streamHeaders() },
      ),
    );
    const result = await GET(incoming(path), context(path));
    const text = await result.text();
    expect(text).toContain("生产资料");
    expect(text).toContain("Synthetic verified final answer");
    expect(text).not.toContain("stream_unavailable");
    expect(
      mocks.upstream.mock.calls.every(
        ([, init]) => init?.method === "GET" && init.body === undefined,
      ),
    ).toBe(true);
  });

  it.each(["run", "request", "authority", "sequence"] as const)(
    "drops an incorrectly bound %s frame before private text reaches the browser",
    async (kind) => {
      const run = view(turn(), "completed"),
        path = ["runs", run.id, "stream"];
      const bad = {
        ...envelope(run, 2),
        type: "text_delta",
        text: "synthetic-private-mismatched-text",
        ...(kind === "run"
          ? { runId: createEntityId() }
          : kind === "request"
            ? { requestId: randomUUID() }
            : kind === "authority"
              ? { contextAuthority: "synthetic-foreign-authority" }
              : { sequence: 8 }),
      };
      mocks.upstream.mockResolvedValueOnce(
        new Response(
          sse({ ...envelope(run, 1), type: "status", text: "准备读取" }) +
            sse(bad) +
            sse(finalEvent(run, 3)),
          { headers: streamHeaders() },
        ),
      );
      const result = await POST(incoming(path, startBody(run)), context(path));
      const text = await result.text();
      expect(text).toContain("准备读取");
      expect(text).not.toContain("synthetic-private-mismatched-text");
      expect(text).not.toContain("Synthetic verified final answer");
      expect(text).toContain('"code":"stream_unavailable"');
      expect(mocks.upstream).toHaveBeenCalledOnce();
    },
  );

  it("fences a changed final input fingerprint and a nonterminal completion", async () => {
    const run = view(turn(), "completed"),
      path = ["runs", run.id, "stream"];
    for (const changed of [
      { ...run, inputFingerprint: "b".repeat(64) },
      { ...run, status: "running" },
    ]) {
      mocks.upstream.mockResolvedValueOnce(
        new Response(
          sse({ ...envelope(run, 1), type: "status", text: "准备读取" }) +
            sse({ ...envelope(run, 2), type: "completed", run: changed }),
          { headers: streamHeaders() },
        ),
      );
      const result = await POST(incoming(path, startBody(run)), context(path));
      const text = await result.text();
      expect(text).not.toContain("Synthetic verified final answer");
      expect(text).toContain('"code":"stream_unavailable"');
    }
    expect(mocks.upstream).toHaveBeenCalledTimes(2);
  });

  it("rechecks the original identity before each emitted frame and signals authority loss without leaking the late chunk", async () => {
    const run = view(turn(), "completed"),
      path = ["runs", run.id, "stream"];
    mocks.current
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    mocks.upstream.mockResolvedValueOnce(
      new Response(
        sse({ ...envelope(run, 1), type: "status", text: "原任务已读取" }) +
          sse({
            ...envelope(run, 2),
            type: "text_delta",
            text: "synthetic-revoked-private-answer",
          }) +
          sse(finalEvent(run, 3)),
        { headers: streamHeaders() },
      ),
    );
    const result = await POST(incoming(path, startBody(run)), context(path));
    const text = await result.text();
    expect(text).toContain("原任务已读取");
    expect(text).toContain('"code":"authority_changed"');
    expect(text).not.toContain("synthetic-revoked-private-answer");
    expect(text).not.toContain("Synthetic verified final answer");
    expect(mocks.upstream).toHaveBeenCalledOnce();
  });

  it("keeps failed original calls and read-unavailable errors explicit without rewriting them as successful answers", async () => {
    const run = view(turn(), "failed"),
      path = ["runs", run.id, "stream"];
    mocks.upstream.mockResolvedValueOnce(
      new Response(sse(finalEvent(run, 1)), { headers: streamHeaders() }),
    );
    const failed = await POST(incoming(path, startBody(run)), context(path));
    expect(await failed.text()).toContain('"status":"failed"');
    mocks.upstream.mockResolvedValueOnce(
      new Response(sse({ ...envelope(run, 1), type: "error", code: "read_unavailable" }), {
        headers: streamHeaders(),
      }),
    );
    const denied = await GET(incoming(path), context(path));
    const text = await denied.text();
    expect(text).toContain('"code":"read_unavailable"');
    expect(text).not.toContain("Synthetic verified final answer");
  });

  it("preserves an incomplete connection as unknown and never makes a second paid submission", async () => {
    const run = view(turn(), "completed"),
      path = ["runs", run.id, "stream"];
    mocks.upstream.mockResolvedValueOnce(
      new Response(sse({ ...envelope(run, 1), type: "text_delta", text: "原连接部分回复" }), {
        headers: streamHeaders(),
      }),
    );
    const result = await POST(incoming(path, startBody(run)), context(path));
    const text = await result.text();
    expect(text).toContain("原连接部分回复");
    expect(text).toContain('"code":"stream_unavailable"');
    expect(text).not.toContain('"type":"completed"');
    expect(mocks.upstream).toHaveBeenCalledOnce();
  });

  it("binds every historical turn to its actual conversation and sanitizes upstream failures", async () => {
    const run = view(turn(), "completed"),
      scope = run.request!.kind === "knowledge_answer" ? run.request!.scopeId : "",
      path = ["conversations", scope];
    mocks.upstream.mockResolvedValueOnce(
      Response.json({
        contextAuthority: authority,
        scopeId: scope,
        turns: [{ ...run, scope: "knowledge:" + randomUUID() }],
        hasMore: false,
      }),
    );
    const mismatch = await GET(incoming(path), context(path));
    expect(mismatch.status).toBe(502);
    expect(await mismatch.text()).not.toContain("Synthetic verified final answer");
    mocks.upstream.mockResolvedValueOnce(
      Response.json({ message: "synthetic-private-provider-secret" }, { status: 500 }),
    );
    const failed = await GET(incoming(["workspace"]), context(["workspace"]));
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("synthetic-private-provider-secret");
    expect(mocks.upstream.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });
});
