import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { AssistViewSchema, type AssistView } from "@yummyai/contracts/ai/assist";
import {
  AGENT_CHAT_EVENT_VERSION,
  agentChatAssistRequest,
  type AgentChatEvent,
} from "@yummyai/contracts/ai/agent-chat";
import { AssistRequestError } from "../ai-assist/assist-client";
import { readAgentChatHistory, streamAgentChatRun } from "./agent-chat-client";

const authority = "synthetic-current-dialogue-authority",
  fingerprint = "c".repeat(64);
const encoder = new TextEncoder();
function nativeRun() {
  const request = agentChatAssistRequest({
    requestId: randomUUID(),
    scopeId: randomUUID(),
    previousRunId: null,
    modelId: createEntityId(),
    message: "Synthetic original question",
  });
  if (request.kind !== "knowledge_answer") throw new Error("synthetic_knowledge_turn_required");
  return AssistViewSchema.parse({
    id: createEntityId(),
    kind: "knowledge_answer",
    scope: "knowledge:" + request.scopeId,
    status: "completed",
    createdAt: "2026-10-30T00:00:00.000Z",
    completedAt: "2026-10-30T00:00:01.000Z",
    modelLabel: "Synthetic model",
    model: "synthetic",
    promptVersion: "synthetic",
    inputFingerprint: fingerprint,
    stale: false,
    maxTaskCostUsd: null,
    request,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    error: null,
    diagnostics: [],
    sources: [],
    checks: [],
    result: {
      summary: "已核对原知识资料",
      findings: [],
      directions: [],
      matches: [],
      missingInformation: [],
    },
  });
}
function event(run: AssistView, sequence: number, value: Record<string, unknown>) {
  return {
    version: AGENT_CHAT_EVENT_VERSION,
    runId: run.id,
    requestId: run.request!.requestId,
    contextAuthority: authority,
    sequence,
    ...value,
  };
}
function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}
function reply(
  events: unknown[],
  options: { bytewise?: boolean; authority?: string | null; contentType?: string } = {},
) {
  const bytes = encoder.encode(events.map(sse).join(""));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": options.contentType ?? "text/event-stream; charset=utf-8",
      ...(options.authority === null
        ? {}
        : { "x-yummyai-context-authority": options.authority ?? authority }),
    },
  });
}
async function receive(run: AssistView, execute = true) {
  const events: AgentChatEvent[] = [];
  await streamAgentChatRun(
    run.id,
    { requestId: run.request!.requestId, inputFingerprint: run.inputFingerprint },
    authority,
    execute,
    new AbortController().signal,
    (event) => {
      events.push(event);
    },
  );
  return events;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Interactive Agent verified SSE client", () => {
  it("accepts split UTF-8 bytes and CRLF events while retaining an exact original final answer", async () => {
    const run = nativeRun(),
      values = [
        event(run, 1, { type: "status", text: "读取原资料" }),
        event(run, 2, { type: "text_delta", text: "已核对" }),
        event(run, 3, { type: "text_delta", text: "原知识资料" }),
        event(run, 4, { type: "completed", run }),
      ];
    const transport = vi.fn(async () => reply(values, { bytewise: true }));
    vi.stubGlobal("fetch", transport);
    const received = await receive(run);
    expect(received).toEqual(values);
    expect(received.at(-1)).toMatchObject({
      type: "completed",
      run: { id: run.id, inputTokens: null, outputTokens: null, costUsd: null },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const sent = transport.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>;
    expect(sent[0]![0]).toBe("/api/agent-chat/runs/" + run.id + "/stream");
    const init = sent[0]![1];
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      requestId: run.request!.requestId,
      inputFingerprint: fingerprint,
    });
  });

  it("delivers a received text delta while the upstream stream remains open", async () => {
    const run = nativeRun(),
      events: AgentChatEvent[] = [];
    let push: ReadableStreamDefaultController<Uint8Array> | undefined, delivered!: () => void;
    const first = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller;
        controller.enqueue(
          encoder.encode(sse(event(run, 1, { type: "text_delta", text: "真实首段" }))),
        );
      },
    });
    const transport = vi.fn(
      async () =>
        new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "x-yummyai-context-authority": authority,
          },
        }),
    );
    vi.stubGlobal("fetch", transport);
    const pending = streamAgentChatRun(
      run.id,
      { requestId: run.request!.requestId, inputFingerprint: fingerprint },
      authority,
      true,
      new AbortController().signal,
      (value) => {
        events.push(value);
        if (value.type === "text_delta") delivered();
      },
    );
    await first;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "text_delta", text: "真实首段" });
    push!.enqueue(encoder.encode(sse(event(run, 2, { type: "completed", run }))));
    push!.close();
    await pending;
    expect(events.at(-1)?.type).toBe("completed");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("uses GET without a body for reconnecting and never recreates or reexecutes the task", async () => {
    const run = nativeRun(),
      transport = vi.fn(async () => reply([event(run, 1, { type: "completed", run })]));
    vi.stubGlobal("fetch", transport);
    await receive(run, false);
    expect(transport).toHaveBeenCalledTimes(1);
    const init = (
      transport.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit]>
    )[0]![1];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("content-type");
  });

  it.each(["run", "request", "fingerprint", "duplicate_sequence", "backward_sequence"])(
    "rejects a %s substitution before adopting a completed answer",
    async (substitution) => {
      const run = nativeRun(),
        values = [
          event(run, 1, { type: "text_delta", text: "可核对的部分" }),
          event(run, 2, { type: "completed", run }),
        ];
      if (substitution === "run")
        values[1] = event(run, 2, { type: "completed", runId: createEntityId(), run });
      if (substitution === "request")
        values[1] = event(run, 2, { type: "completed", requestId: randomUUID(), run });
      if (substitution === "fingerprint")
        values[1] = event(run, 2, {
          type: "completed",
          run: { ...run, inputFingerprint: "d".repeat(64) },
        });
      if (substitution === "duplicate_sequence")
        values[1] = event(run, 1, { type: "completed", run });
      if (substitution === "backward_sequence") {
        values[0] = event(run, 2, { type: "text_delta", text: "部分" });
        values[1] = event(run, 1, { type: "completed", run });
      }
      const transport = vi.fn(async () => reply(values));
      vi.stubGlobal("fetch", transport);
      await expect(receive(run)).rejects.toMatchObject({ status: 502 });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["missing_header", "foreign_header", "foreign_event_authority"])(
    "rejects %s with an authority change so private UI state can be purged",
    async (substitution) => {
      const run = nativeRun(),
        values = [
          event(run, 1, {
            type: "completed",
            run,
            ...(substitution === "foreign_event_authority"
              ? { contextAuthority: "synthetic-other-authority" }
              : {}),
          }),
        ];
      const transport = vi.fn(async () =>
        reply(values, {
          authority:
            substitution === "missing_header"
              ? null
              : substitution === "foreign_header"
                ? "synthetic-other-authority"
                : authority,
        }),
      );
      vi.stubGlobal("fetch", transport);
      await expect(receive(run)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it("marks EOF without a terminal receipt as unknown and never submits a replacement request", async () => {
    const run = nativeRun(),
      transport = vi.fn(async () =>
        reply([event(run, 1, { type: "text_delta", text: "尚未核对的部分结果" })]),
      );
    vi.stubGlobal("fetch", transport);
    await expect(receive(run)).rejects.toMatchObject({ status: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("treats a private-read revocation frame as forbidden rather than retaining it as an ordinary connection problem", async () => {
    const run = nativeRun(),
      transport = vi.fn(async () =>
        reply([event(run, 1, { type: "error", code: "read_unavailable" })]),
      );
    vi.stubGlobal("fetch", transport);
    await expect(receive(run)).rejects.toMatchObject({ status: 403 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a queued run masquerading as a final answer", async () => {
    const run = nativeRun(),
      transport = vi.fn(async () =>
        reply([
          event(run, 1, {
            type: "completed",
            run: { ...run, status: "queued", completedAt: null, result: null },
          }),
        ]),
      );
    vi.stubGlobal("fetch", transport);
    await expect(receive(run)).rejects.toMatchObject({ status: 502 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("accepts a real failed terminal receipt with unknown usage without inventing an answer or a zero fee", async () => {
    const run = nativeRun(),
      failed = { ...run, status: "failed", result: null, error: "渠道响应未核对" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply([event(run, 1, { type: "completed", run: failed })])),
    );
    const received = await receive(run, false);
    expect(received.at(-1)).toMatchObject({
      type: "completed",
      run: { status: "failed", result: null, inputTokens: null, outputTokens: null, costUsd: null },
    });
  });

  it("rejects another conversation's history even when the transport authority matches", async () => {
    const run = nativeRun();
    if (run.request?.kind !== "knowledge_answer")
      throw new Error("synthetic_knowledge_turn_required");
    const requested = run.request.scopeId,
      other = randomUUID();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { contextAuthority: authority, scopeId: other, turns: [run], hasMore: false },
          { headers: { "x-yummyai-context-authority": authority } },
        ),
      ),
    );
    await expect(readAgentChatHistory(requested, authority)).rejects.toBeInstanceOf(
      AssistRequestError,
    );
  });
});
