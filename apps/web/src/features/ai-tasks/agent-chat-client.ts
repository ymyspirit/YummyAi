import { z } from "zod";
import {
  AgentChatEventSchema,
  AgentChatHistorySchema,
  AgentChatStreamRequestSchema,
  AgentChatWorkspaceSchema,
  CreateAgentChatTurnSchema,
  type AgentChatEvent,
  type AgentChatStreamRequest,
  type CreateAgentChatTurn,
} from "@yummyai/contracts/ai/agent-chat";
import { AssistViewSchema } from "@yummyai/contracts/ai/assist";
import { assistErrorMessage, AssistRequestError } from "../ai-assist/assist-client";

const invalid = () => new AssistRequestError(502, "原对话响应未通过核对 请只读取原任务 不重复发送");
const runId = (value: string) => z.uuidv7().parse(value).toLowerCase();
const scopeId = (value: string) => z.uuid().parse(value).toLowerCase();

async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  let size = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) throw invalid();
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new AssistRequestError(
      response.ok ? 502 : response.status,
      assistErrorMessage(response.ok ? 502 : response.status),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function response(
  url: string,
  authority: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 120_000,
) {
  try {
    return await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        "x-yummyai-context-authority": authority,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
    });
  } catch (failure) {
    if (signal?.aborted) throw failure;
    throw new AssistRequestError(0, "对话响应暂不可核对 请只读取原任务 不重发付费请求");
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  authority: string,
  status: number,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const reply = await response("/api/agent-chat/" + path, authority, body, signal);
  const raw = await json(reply);
  if (!reply.ok) {
    const changed =
      raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new AssistRequestError(
      reply.status,
      assistErrorMessage(reply.status, changed ? "authority_changed" : null),
      changed ? "authority_changed" : null,
    );
  }
  if (reply.headers.get("x-yummyai-context-authority") !== authority)
    throw new AssistRequestError(
      409,
      assistErrorMessage(409, "authority_changed"),
      "authority_changed",
    );
  const parsed = schema.safeParse(raw);
  if (reply.status !== status || !parsed.success) throw invalid();
  signal?.throwIfAborted();
  return parsed.data;
}

export async function readAgentChatWorkspace(authority: string, signal?: AbortSignal) {
  const value = await request(
    "workspace",
    AgentChatWorkspaceSchema,
    authority,
    200,
    undefined,
    signal,
  );
  if (value.contextAuthority !== authority)
    throw new AssistRequestError(
      409,
      assistErrorMessage(409, "authority_changed"),
      "authority_changed",
    );
  return value;
}

export async function readAgentChatHistory(id: string, authority: string, signal?: AbortSignal) {
  const expected = scopeId(id),
    value = await request(
      "conversations/" + expected,
      AgentChatHistorySchema,
      authority,
      200,
      undefined,
      signal,
    );
  if (value.contextAuthority !== authority)
    throw new AssistRequestError(
      409,
      assistErrorMessage(409, "authority_changed"),
      "authority_changed",
    );
  if (
    value.scopeId.toLowerCase() !== expected ||
    value.turns.some(
      (turn) =>
        turn.kind !== "knowledge_answer" ||
        turn.scope !== "knowledge:" + expected ||
        (turn.request &&
          (turn.request.kind !== "knowledge_answer" ||
            turn.request.scopeId.toLowerCase() !== expected)),
    )
  )
    throw invalid();
  return value;
}

export async function createAgentChatTurn(raw: CreateAgentChatTurn, authority: string) {
  const input = CreateAgentChatTurnSchema.parse(raw);
  return request("turns", AssistViewSchema, authority, 201, input);
}

/** GET observes an existing task. POST is used once after its exact create receipt. */
export async function streamAgentChatRun(
  id: string,
  original: AgentChatStreamRequest,
  authority: string,
  execute: boolean,
  signal: AbortSignal,
  onEvent: (event: AgentChatEvent) => void | Promise<void>,
) {
  const expected = runId(id),
    input = AgentChatStreamRequestSchema.parse(original);
  const reply = await response(
    "/api/agent-chat/runs/" + expected + "/stream",
    authority,
    execute ? input : undefined,
    signal,
    650_000,
  );
  if (!reply.ok) {
    const raw = await json(reply);
    const changed =
      raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed";
    throw new AssistRequestError(
      reply.status,
      assistErrorMessage(reply.status, changed ? "authority_changed" : null),
      changed ? "authority_changed" : null,
    );
  }
  if (
    reply.status !== 200 ||
    reply.headers.get("content-type")?.split(";")[0].trim() !== "text/event-stream"
  )
    throw invalid();
  if (reply.headers.get("x-yummyai-context-authority") !== authority)
    throw new AssistRequestError(
      409,
      assistErrorMessage(409, "authority_changed"),
      "authority_changed",
    );
  const reader = reply.body?.getReader();
  if (!reader) throw invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "",
    size = 0,
    sequence = 0,
    terminal = false;
  const consume = async (block: string) => {
    const lines = block.split(/\r\n|\n|\r/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    const parsed = AgentChatEventSchema.safeParse(JSON.parse(data));
    if (!parsed.success) throw invalid();
    const event = parsed.data;
    if (event.contextAuthority !== authority)
      throw new AssistRequestError(
        409,
        assistErrorMessage(409, "authority_changed"),
        "authority_changed",
      );
    if (
      event.runId.toLowerCase() !== expected ||
      event.requestId !== input.requestId ||
      event.sequence <= sequence
    )
      throw invalid();
    sequence = event.sequence;
    if (event.type === "completed" && event.run.inputFingerprint !== input.inputFingerprint)
      throw invalid();
    if (
      event.type === "completed" &&
      (event.run.status === "queued" || event.run.status === "running")
    )
      throw invalid();
    if (event.type === "error" && event.code === "authority_changed")
      throw new AssistRequestError(
        409,
        assistErrorMessage(409, "authority_changed"),
        "authority_changed",
      );
    if (event.type === "error" && event.code === "read_unavailable")
      throw new AssistRequestError(403, "当前原对话已不可读取 原回答与填写已隐藏");
    terminal = event.type === "completed" || event.type === "error";
    await onEvent(event);
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024) throw invalid();
      buffer += decoder.decode(part.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n|\r\r/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        await consume(block);
        if (terminal) return;
      }
      if (buffer.length > 262_144) throw invalid();
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consume(buffer);
    if (!terminal)
      throw new AssistRequestError(0, "流式连接已断开 原任务仍可能完成 请只读取原任务 不重复发送");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
