import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentReadCallSchema, AgentReadPageViewSchema, AgentReadWorkspaceSchema } from "@yummyai/contracts/ai/agent-read";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { authorize, permissionScope } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const privateHeaders = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
function failure(status: number, code?: "authority_changed" | "agent_collection_changed") {
  return Response.json({ message: code === "agent_collection_changed" ? "读取期间原集合已变化 请清除旧页并从第一页重读" : status === 401 ? "请登录自己的运营账户" :
    status === 403 ? "当前缺少该工具所需的租户范围读取权限" : status === 400 || status === 422 ? "工具参数或固定执行契约需核对" : "只读结果暂不可核对 未执行任何业务写入", ...(code ? { code } : {}) }, { status, headers: privateHeaders });
}
class TooLarge extends Error {}
async function json(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("body"); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw new TooLarge(); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = (await context.params).path;
  const workspace = method === "GET" && path.length === 1 && path[0] === "workspace";
  if (!workspace && !(method === "POST" && path.length === 1 && path[0] === "call")) return failure(404);
  if (new URL(request.url).search) return failure(400);
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let raw: unknown;
  if (method === "POST") { try { raw = await json(new Response(request.body), 32 * 1024); } catch (error) { return failure(error instanceof TooLarge ? 413 : 400); } }
  const input = workspace ? null : AgentReadCallSchema.safeParse(raw); if (!workspace && !input?.success) return failure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    if (input?.success) {
      const permission = input.data.tool === "orders.exceptions.page" ? Permission.OrderRead : Permission.InventoryRead;
      try { authorize(identity.view, permission); if (permissionScope(identity.view, permission) !== "tenant") return failure(403); } catch { return failure(403); }
    }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const response = await apiFetch(base + "/v1/agent-reads/" + (workspace ? "workspace" : "call"), { method, cache: "no-store",
      ...(input?.success ? { body: JSON.stringify(input.data), headers: { "content-type": "application/json" } } : {}), signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]) });
    if (!response.ok) {
      let code: "authority_changed" | "agent_collection_changed" | undefined;
      if (response.status === 409) { try { const body = await json(response, 8192); if (body && typeof body === "object" && "code" in body && (body.code === "authority_changed" || body.code === "agent_collection_changed")) code = body.code; } catch { /* Never expose raw owner errors. */ } }
      else await response.body?.cancel();
      await assertErpIdentityCurrent(identity); return failure([400, 401, 403, 404, 409, 422, 503].includes(response.status) ? response.status : 502, code);
    }
    if (response.status !== 200) { await response.body?.cancel(); return failure(502); }
    const body = await json(response, 8 * 1024 * 1024), parsed = workspace ? AgentReadWorkspaceSchema.safeParse(body) : AgentReadPageViewSchema.safeParse(body);
    if (!parsed.success) return failure(502);
    if (parsed.data.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) return failure(409, "authority_changed");
    if (workspace) {
      const value = AgentReadWorkspaceSchema.parse(parsed.data);
      if (new Set(value.tools.map(tool => tool.key)).size !== 2 || value.tools.some(tool => tool.descriptor.key !== tool.key || tool.descriptor.effect !== "read" ||
        !value.executionContract.tools.some(pin => pin.key === tool.key && pin.version === tool.descriptor.version))) return failure(502);
    } else if (input?.success) {
      const value = AgentReadPageViewSchema.parse(parsed.data);
      if (value.tool !== input.data.tool || canonicalJson(value.query) !== canonicalJson(input.data.input) || value.items.length > input.data.input.pageSize ||
        value.readCount > value.total || value.readCount < value.items.length || input.data.input.cursor === null && value.readCount !== value.items.length ||
        value.complete !== (value.readCount === value.total) || value.complete !== (value.nextCursor === null) || !value.complete && value.items.length === 0 ||
        new Set(value.items.map(item => item.id)).size !== value.items.length) return failure(502);
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(parsed.data, { status: response.status, headers: { ...privateHeaders, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
