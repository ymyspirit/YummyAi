import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AGENT_COMMAND_MAX_BYTES, AdoptAgentCommandSchema, PrepareAgentCommandSchema, AgentCommandReceiptQuerySchema,
  AgentCommandReceiptSchema, AgentCommandViewSchema, AgentCommandWorkspaceSchema, ConfirmAgentCommandSchema,
  CancelAgentCommandSchema, canonicalAgentCommandRequest, canonicalAgentCommandOriginal,
} from "@yummyai/contracts/ai/agent-command";
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
const Id = z.uuidv7();
function failure(status: number, changed = false) {
  return Response.json({ message: changed ? "当前本人身份或权限已变化 请重新读取原操作" : status === 401 ? "请登录自己的运营账户" :
    status === 403 || status === 404 ? "当前无法读取或操作这笔原提交" : status === 400 || status === 422 ? "请重新核对原提交的填写与版本" :
      "本次响应未能核对 请先读取原请求和原业务回执", ...(changed ? { code: "authority_changed" } : {}) }, { status, headers });
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
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = (await context.params).path, url = new URL(request.url);
  const workspace = method === "GET" && path.length === 1 && path[0] === "workspace";
  const receipt = method === "GET" && path.length === 1 && path[0] === "receipts";
  const prepare = method === "POST" && path.length === 1 && path[0] === "prepare";
  const adopt = method === "POST" && path.length === 1 && path[0] === "adopt";
  const get = method === "GET" && path.length === 2 && path[0] === "requests" && Id.safeParse(path[1]).success;
  const action = method === "POST" && path.length === 3 && path[0] === "requests" && Id.safeParse(path[1]).success && ["confirm", "cancel", "acknowledge"].includes(path[2]!);
  if (!workspace && !receipt && !prepare && !adopt && !get && !action) return failure(404);
  if (!receipt && url.search) return failure(400);
  let query: z.infer<typeof AgentCommandReceiptQuerySchema> | null = null;
  if (receipt) {
    if ([...url.searchParams.keys()].some(key => !["requestId", "requestChecksum"].includes(key)) ||
      url.searchParams.getAll("requestId").length !== 1 || url.searchParams.getAll("requestChecksum").length !== 1) return failure(400);
    const parsed = AgentCommandReceiptQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return failure(400); query = parsed.data;
  }
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let input: unknown;
  if (method === "POST") {
    try {
      const raw = await json(new Response(request.body), prepare ? AGENT_COMMAND_MAX_BYTES : 64 * 1024);
      const parsed = prepare ? PrepareAgentCommandSchema.safeParse(raw) : adopt ? AdoptAgentCommandSchema.safeParse(raw) :
        path[2] === "confirm" ? ConfirmAgentCommandSchema.safeParse(raw) : CancelAgentCommandSchema.safeParse(raw);
      if (!parsed.success) return failure(400); input = parsed.data;
    } catch (error) { return failure(error instanceof TooLarge ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try { authorize(identity.view, Permission.WorkflowRead); if (method === "POST") authorize(identity.view, Permission.WorkflowRun); }
    catch { return failure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const upstream = path.map(encodeURIComponent).join("/") + (query ? "?" + new URLSearchParams(query) : "");
    const response = await apiFetch(base + "/v1/agent-commands/" + upstream, { method, cache: "no-store",
      ...(method === "POST" ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) {
      let changed = false;
      if (response.status === 409) { try { const body = await json(response, 8192);
        changed = !!body && typeof body === "object" && "code" in body && body.code === "authority_changed"; } catch { /* No private upstream error is exposed. */ }
      } else await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 410, 413, 422, 503].includes(response.status) ? response.status : 502, changed);
    }
    if (response.status !== (prepare || adopt ? 201 : 200)) { await response.body?.cancel(); await assertErpIdentityCurrent(identity); return failure(502); }
    const body = await json(response, 48 * 1024 * 1024);
    const parsed = workspace ? AgentCommandWorkspaceSchema.safeParse(body) : receipt ? AgentCommandReceiptSchema.safeParse(body) : AgentCommandViewSchema.safeParse(body);
    if (!parsed.success) { await assertErpIdentityCurrent(identity); return failure(502); }
    if (parsed.data.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) {
      await assertErpIdentityCurrent(identity); return failure(409, true);
    }
    if (receipt) {
      const value = AgentCommandReceiptSchema.parse(parsed.data);
      if (value.requestId !== query!.requestId || value.requestChecksum !== query!.requestChecksum) return failure(502);
    } else if (!workspace) {
      const value = AgentCommandViewSchema.parse(parsed.data);
      if ((get || action) && value.id !== path[1] || !value.privateAvailable && (value.snapshot !== null || value.confirmationToken !== null || value.canConfirm)) return failure(502);
      if (value.snapshot?.original && createHash("sha256").update(canonicalAgentCommandOriginal(value.snapshot.original)).digest("hex") !== value.originalChecksum) return failure(502);
      if (prepare || adopt) {
        const operation = prepare ? "prepare" : "adopt";
        const expected = createHash("sha256").update(canonicalAgentCommandRequest(operation, input)).digest("hex");
        const request = prepare ? PrepareAgentCommandSchema.parse(input) : AdoptAgentCommandSchema.parse(input);
        if (value.requestId !== request.requestId || value.requestChecksum !== expected) return failure(502);
        if ("reference" in request && (value.domain !== request.reference.domain || value.ownerCommandId !== request.reference.commandId)) return failure(502);
        if ("original" in request && (value.domain !== request.original.domain || value.kind !== request.original.command.kind)) return failure(502);
      } else if (action) {
        const original = path[2] === "confirm" ? ConfirmAgentCommandSchema.parse(input) : CancelAgentCommandSchema.parse(input);
        if (value.requestId !== original.requestId || value.ownerCommandId !== original.ownerCommandId) return failure(502);
      }
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(parsed.data, { status: response.status, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
