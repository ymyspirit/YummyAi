import { createHash } from "node:crypto";
import { z } from "zod";
import { AGENT_COMMAND_MAX_BYTES } from "@yummyai/contracts/ai/agent-command";
import { PrepareAgentFulfillmentCommandSchema, AgentFulfillmentCommandGetQuerySchema, AgentFulfillmentCommandListQuerySchema,
  AgentFulfillmentCommandReceiptQuerySchema, AgentFulfillmentCommandReceiptSchema, AgentFulfillmentCommandWorkspaceSchema,
  AgentFulfillmentCommandViewSchema, AgentFulfillmentCommandListSchema, ConfirmAgentFulfillmentCommandSchema,
  CancelAgentFulfillmentCommandSchema, AcknowledgeAgentFulfillmentCommandSchema, canonicalAgentFulfillmentOriginal,
  type AgentFulfillmentCommandView } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const Id = z.uuidv7().refine(value => value === value.toLowerCase());
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function failure(status: number, changed = false) {
  return Response.json({ message: changed ? "当前本人权限已变化 请重新核对原履约提交" : status === 401 ? "请登录自己的运营账户" :
    status === 403 || status === 404 ? "当前无法读取或操作这笔原履约提交" : status === 400 || status === 422 ? "请核对原单 原请求及本次明确决定" :
      "本次响应未能核对 请只读查询原请求和原业务回执", ...(changed ? { code: "authority_changed" } : {}) }, { status, headers });
}
class TooLarge extends Error {}
async function json(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new TooLarge(); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function coherent(value: AgentFulfillmentCommandView, authority: string, orderId: string) {
  return value.contextAuthority === authority && value.native.orderId === orderId
    && (!value.original || sha(canonicalAgentFulfillmentOriginal(value.original)) === value.originalChecksum);
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = (await context.params).path, url = new URL(request.url);
  const workspace = method === "GET" && path.length === 1 && path[0] === "workspace";
  const receipt = method === "GET" && path.length === 1 && path[0] === "receipts";
  const list = method === "GET" && path.length === 1 && path[0] === "requests";
  const get = method === "GET" && path.length === 2 && path[0] === "requests" && Id.safeParse(path[1]).success;
  const prepare = method === "POST" && path.length === 1 && path[0] === "prepare";
  const action = method === "POST" && path.length === 3 && path[0] === "requests" && Id.safeParse(path[1]).success && ["confirm", "cancel", "acknowledge"].includes(path[2]!);
  if (!workspace && !receipt && !list && !get && !prepare && !action) return failure(404);
  if ((workspace || method === "POST") && url.search) return failure(400);
  let query: Record<string, string> | null = null;
  if (receipt || list || get) {
    if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return failure(400);
    const parsed = (receipt ? AgentFulfillmentCommandReceiptQuerySchema : list ? AgentFulfillmentCommandListQuerySchema : AgentFulfillmentCommandGetQuerySchema).safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return failure(400); query = parsed.data;
  }
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let input: unknown;
  if (method === "POST") {
    try {
      const raw = await json(new Response(request.body), prepare ? AGENT_COMMAND_MAX_BYTES : 64 * 1024);
      const parsed = prepare ? PrepareAgentFulfillmentCommandSchema.safeParse(raw) : path[2] === "confirm" ? ConfirmAgentFulfillmentCommandSchema.safeParse(raw)
        : path[2] === "cancel" ? CancelAgentFulfillmentCommandSchema.safeParse(raw) : AcknowledgeAgentFulfillmentCommandSchema.safeParse(raw);
      if (!parsed.success) return failure(400); input = parsed.data;
    } catch (error) { return failure(error instanceof TooLarge ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try { authorize(identity.view, Permission.WorkflowRead, { ownerId: identity.view.userId });
      if (method === "POST") authorize(identity.view, Permission.WorkflowRun, { ownerId: identity.view.userId }); }
    catch { return failure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const upstream = path.map(encodeURIComponent).join("/") + (query ? "?" + new URLSearchParams(query) : "");
    const response = await apiFetch(base + "/v1/agent-fulfillment-commands/" + upstream, { method, cache: "no-store",
      ...(method === "POST" ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) {
      let changed = false;
      if (response.status === 409) { try { const body = await json(response, 8192); changed = !!body && typeof body === "object" && "code" in body && body.code === "authority_changed"; } catch { /* No private upstream error is exposed. */ } }
      else await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 410, 413, 422, 503].includes(response.status) ? response.status : 502, changed);
    }
    if (response.status !== (prepare ? 201 : 200)) { await response.body?.cancel(); await assertErpIdentityCurrent(identity); return failure(502); }
    const body = await json(response, 48 * 1024 * 1024);
    const parsed = workspace ? AgentFulfillmentCommandWorkspaceSchema.safeParse(body) : receipt ? AgentFulfillmentCommandReceiptSchema.safeParse(body)
      : list ? AgentFulfillmentCommandListSchema.safeParse(body) : AgentFulfillmentCommandViewSchema.safeParse(body);
    if (!parsed.success) { await assertErpIdentityCurrent(identity); return failure(502); }
    if (parsed.data.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) {
      await assertErpIdentityCurrent(identity); return failure(409, true);
    }
    if (receipt) {
      const value = AgentFulfillmentCommandReceiptSchema.parse(parsed.data);
      if (value.orderId !== query!.orderId || value.requestId !== query!.requestId || value.requestChecksum !== query!.requestChecksum) return failure(502);
    } else if (list) {
      const value = AgentFulfillmentCommandListSchema.parse(parsed.data);
      if (value.items.some(item => !coherent(item, authority, query!.orderId!) || query!.lineId && !item.native.lineIds.includes(query!.lineId))) return failure(502);
    } else if (!workspace) {
      const value = AgentFulfillmentCommandViewSchema.parse(parsed.data);
      const posted = prepare ? PrepareAgentFulfillmentCommandSchema.parse(input) : action ? (path[2] === "confirm" ? ConfirmAgentFulfillmentCommandSchema.parse(input)
        : path[2] === "cancel" ? CancelAgentFulfillmentCommandSchema.parse(input) : AcknowledgeAgentFulfillmentCommandSchema.parse(input)) : null;
      if (!coherent(value, authority, posted?.orderId ?? query!.orderId!) || (get || action) && value.native.id !== path[1]) return failure(502);
      if (prepare) {
        const expected = PrepareAgentFulfillmentCommandSchema.parse(input).original;
        if (value.native.requestId !== expected.requestId || value.native.requestChecksum !== sha(canonicalAgentFulfillmentOriginal(expected))
          || value.native.kind !== expected.kind || value.native.targetId !== expected.targetId) return failure(502);
      } else if (posted && "requestChecksum" in posted && (value.native.requestId !== posted.requestId || value.native.requestChecksum !== posted.requestChecksum)) return failure(502);
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(parsed.data, { status: response.status, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
