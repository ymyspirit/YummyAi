import { z } from "zod";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { AssistViewSchema } from "@yummyai/contracts/ai/assist";
import {
  AgentChatWorkspaceSchema,
  AgentChatHistorySchema,
  CreateAgentChatTurnSchema,
  AgentChatStreamRequestSchema,
  AgentChatEventSchema,
  agentChatAssistRequest,
  type AgentChatEvent,
} from "@yummyai/contracts/ai/agent-chat";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import {
  assertErpIdentityCurrent,
  erpAuthFailure,
  erpRequestIdentity,
} from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
export const maxDuration = 660;
type Context = { params: Promise<{ path: string[] }> };
const privateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const uuid = z.uuid(),
  runId = z.uuidv7();
function failure(status: number, changed = false) {
  return Response.json(
    {
      message: changed
        ? "本人身份或资料权限已变化 请重新核对会话"
        : status === 400
          ? "请核对问题内容 请勿填写密码 密钥或个人身份资料"
          : status === 401
            ? "请登录自己的运营账户"
            : status === 403 || status === 404
              ? "当前会话或知识资料不可访问"
              : status === 409
                ? "原请求或知识范围已变化 请读取原任务后继续"
                : "本次请求结果暂不可核对 请保留原编号并读取原结果",
      ...(changed ? { code: "authority_changed" } : {}),
    },
    { status, headers: privateHeaders },
  );
}
async function json(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("body_unavailable");
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > limit) throw new Error("body_limit");
      chunks.push(part.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const parts = (await context.params).path;
  const workspace = method === "GET" && parts.length === 1 && parts[0] === "workspace";
  const history =
    method === "GET" &&
    parts.length === 2 &&
    parts[0] === "conversations" &&
    uuid.safeParse(parts[1]).success;
  const create = method === "POST" && parts.length === 1 && parts[0] === "turns";
  const stream =
    parts.length === 3 &&
    parts[0] === "runs" &&
    parts[2] === "stream" &&
    runId.safeParse(parts[1]).success;
  if (!workspace && !history && !create && !stream) return failure(404);
  if (new URL(request.url).searchParams.size) return failure(400);
  let input: unknown;
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return failure(415);
    try {
      input = (create ? CreateAgentChatTurnSchema : AgentChatStreamRequestSchema).parse(
        await json(new Response(request.body), 32 * 1024),
      );
    } catch {
      return failure(400);
    }
  }
  try {
    const identity = await erpRequestIdentity(request),
      authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) return failure(409, true);
    try {
      authorize(identity.view, Permission.WorkflowRead);
      if (method === "POST") authorize(identity.view, Permission.WorkflowRun);
    } catch {
      return failure(403);
    }
    const base = identity.service.configuration.apiBase;
    const target = stream
      ? `runs/${runId.parse(parts[1])}/stream`
      : history
        ? `conversations/${uuid.parse(parts[1])}`
        : parts[0];
    const controller = new AbortController();
    const response = await apiFetch(`${base}/v1/agent-chat/${target}`, {
      method,
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: stream ? "text/event-stream" : "application/json",
        ...(input ? { "content-type": "application/json" } : {}),
      },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.any([
        request.signal,
        controller.signal,
        AbortSignal.timeout(stream ? 650_000 : 120_000),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(
        [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 502,
      );
    }
    await assertErpIdentityCurrent(identity);
    if (stream) {
      if (
        response.status !== 200 ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "text/event-stream" ||
        response.headers.get("x-yummyai-context-authority") !== authority ||
        !response.body
      ) {
        await response.body?.cancel();
        return failure(502);
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true }),
        encoder = new TextEncoder();
      const expectedRun = runId.parse(parts[1]);
      let sequence = 0,
        requestId: string | null = input
          ? AgentChatStreamRequestSchema.parse(input).requestId
          : null;
      let ended = false,
        buffered = "",
        byteCount = 0,
        cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        async start(output) {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              byteCount += next.value.byteLength;
              if (byteCount > 16 * 1024 * 1024) throw new Error("stream_limit");
              buffered += decoder.decode(next.value, { stream: true });
              if (buffered.length > 8 * 1024 * 1024) throw new Error("frame_limit");
              let boundary: RegExpExecArray | null;
              while ((boundary = /\r?\n\r?\n|\r\r/.exec(buffered))) {
                const block = buffered.slice(0, boundary.index);
                buffered = buffered.slice(boundary.index + boundary[0].length);
                const lines = block
                  .split(/\r\n|\n|\r/)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart());
                if (!lines.length) continue;
                const event = AgentChatEventSchema.parse(JSON.parse(lines.join("\n")));
                if (
                  ended ||
                  event.runId !== expectedRun ||
                  event.contextAuthority !== authority ||
                  event.sequence !== sequence + 1 ||
                  (requestId && event.requestId !== requestId)
                )
                  throw new Error("stream_binding_invalid");
                await assertErpIdentityCurrent(identity);
                requestId = event.requestId;
                sequence = event.sequence;
                if (
                  event.type === "completed" &&
                  (event.run.status === "queued" ||
                    event.run.status === "running" ||
                    !event.run.request ||
                    event.run.request.kind !== "knowledge_answer" ||
                    event.run.scope !== "knowledge:" + event.run.request.scopeId ||
                    (input &&
                      event.run.inputFingerprint !==
                        AgentChatStreamRequestSchema.parse(input).inputFingerprint))
                )
                  throw new Error("stream_result_invalid");
                if (event.type === "completed" || event.type === "error") ended = true;
                if (cancelled) return;
                output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              }
            }
            decoder.decode();
            if (buffered.trim() || !ended) throw new Error("stream_incomplete");
          } catch (error) {
            if (!cancelled && requestId) {
              const event: AgentChatEvent = {
                version: "agent-chat-event-v1",
                runId: expectedRun,
                requestId,
                contextAuthority: authority,
                sequence: sequence + 1,
                type: "error",
                code:
                  error instanceof PersonalSessionError
                    ? "authority_changed"
                    : "stream_unavailable",
              };
              output.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
            if (!cancelled) output.close();
          }
        },
        async cancel() {
          cancelled = true;
          controller.abort();
          await reader.cancel().catch(() => {});
        },
      });
      return new Response(body, {
        headers: {
          ...privateHeaders,
          "content-type": "text/event-stream; charset=utf-8",
          "x-yummyai-context-authority": authority,
          "x-accel-buffering": "no",
        },
      });
    }
    if (response.status !== (create ? 201 : 200)) {
      await response.body?.cancel();
      return failure(502);
    }
    const raw = await json(response, 8 * 1024 * 1024);
    const parsed = workspace
      ? AgentChatWorkspaceSchema.parse(raw)
      : history
        ? AgentChatHistorySchema.parse(raw)
        : AssistViewSchema.parse(raw);
    if ("contextAuthority" in parsed && parsed.contextAuthority !== authority)
      return failure(409, true);
    if (history) {
      const result = AgentChatHistorySchema.parse(parsed);
      if (
        result.scopeId !== parts[1] ||
        result.turns.some(
          (turn) =>
            turn.kind !== "knowledge_answer" ||
            turn.scope !== "knowledge:" + result.scopeId ||
            (turn.request &&
              (turn.request.kind !== "knowledge_answer" ||
                turn.request.scopeId !== result.scopeId)),
        )
      )
        return failure(502);
    }
    if (create) {
      const run = AssistViewSchema.parse(parsed);
      const expected = agentChatAssistRequest(CreateAgentChatTurnSchema.parse(input));
      if (
        run.kind !== "knowledge_answer" ||
        run.scope !== "knowledge:" + CreateAgentChatTurnSchema.parse(input).scopeId ||
        !run.request ||
        canonicalJson(run.request) !== canonicalJson(expected)
      )
        return failure(502);
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(parsed, {
      status: response.status,
      headers: { ...privateHeaders, "x-yummyai-context-authority": authority },
    });
  } catch (error) {
    return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502);
  }
}
