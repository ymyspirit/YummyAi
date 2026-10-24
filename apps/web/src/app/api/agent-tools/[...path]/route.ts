import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AGENT_TOOLS_VERSION, AgentToolWorkspaceSchema, AgentToolDefinitionRequestSchema, AgentToolDefinitionSchema,
  AgentToolCallSchema, AgentToolResultSchema, AgentToolObjectQuerySchema, AgentToolObjectsSchema, agentToolDefinitionPayload,
  type AgentToolCall, type AgentToolResult,
} from "@yummyai/contracts/ai/agent-tools";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const sha = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const failure = (status: number, code?: string) => Response.json({ message: status === 401 ? "请登录自己的运营账户" : status === 409 ? "权限 工具或原资料已变化 请清除旧结果后重读" : status === 403 ? "当前缺少原工具所需权限或对象范围" : "原生工具暂不可核对 请重新读取", ...(code ? { code } : {}) }, { status, headers });
class TooLarge extends Error {}
async function json(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("body"); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new TooLarge(); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function resultMatches(call: AgentToolCall, result: AgentToolResult) {
  if (call.tool !== result.tool || call.definitionChecksum !== result.definitionChecksum || sha(call.input) !== result.inputChecksum || sha(result.data) !== result.dataChecksum) return false;
  switch (call.tool) {
    case "knowledge.search": return result.tool === call.tool;
    case "creative.history": return result.tool === call.tool && call.input.scope === result.data.scope && call.input.ownerId.toLowerCase() === result.data.ownerId.toLowerCase();
    case "factory.capacity": return result.tool === call.tool && call.input.factoryId.toLowerCase() === result.data.factoryId.toLowerCase() && call.input.query.days === result.data.days && (!call.input.query.from || call.input.query.from === result.data.from);
    default: return (result.tool === "orders.exceptions.page" || result.tool === "inventory.balances.page") && canonicalJson(call.input) === canonicalJson(result.data.query);
  }
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = (await context.params).path, route = path.length === 1 ? path[0] : "";
  if (method === "GET" ? route !== "workspace" : !["definition", "call", "objects"].includes(route)) return failure(404);
  if (new URL(request.url).search) return failure(400);
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let raw: unknown;
  if (method === "POST") { try { raw = await json(new Response(request.body), 40 * 1024); } catch (error) { return failure(error instanceof TooLarge ? 413 : 400); } }
  const definition = route === "definition" ? AgentToolDefinitionRequestSchema.safeParse(raw) : null;
  const call = route === "call" ? AgentToolCallSchema.safeParse(raw) : null;
  const objects = route === "objects" ? AgentToolObjectQuerySchema.safeParse(raw) : null;
  if (definition && !definition.success || call && !call.success || objects && !objects.success) return failure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const nativeList = objects?.success ? objects.data.scope === "design_batch" ? "design-batches" : objects.data.scope === "inspection" ? "mockup-template-inspections" : "mockup-batches" : null;
    const target = nativeList ? base + "/v1/pod/" + nativeList : base + "/v1/agent-tools/" + route;
    const response = await apiFetch(target, { method: nativeList ? "GET" : method, cache: "no-store",
      ...(nativeList || method === "GET" ? {} : { body: JSON.stringify(definition?.success ? definition.data : call?.success ? call.data : null), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]) });
    if (!response.ok) {
      let code: string | undefined;
      if (response.status === 409) { try { const body = await json(response, 8192); if (body && typeof body === "object" && "code" in body && typeof body.code === "string" && ["authority_changed", "agent_collection_changed", "agent_tool_definition_changed", "agent_tool_contract_changed"].includes(body.code)) code = body.code; } catch { /* Keep native private messages off the transport. */ } }
      else await response.body?.cancel();
      await assertErpIdentityCurrent(identity); return failure([400, 401, 403, 404, 408, 409, 422, 503].includes(response.status) ? response.status : 502, code);
    }
    if (response.status !== 200) { await response.body?.cancel(); return failure(502); }
    const body = await json(response, 8 * 1024 * 1024);
    let result: unknown;
    if (objects?.success) {
      // Original owner endpoints already filter current membership and object scope.
      // Forward only candidate identities; do not expose their raw private snapshots.
      const rows = z.array(z.object({ id: z.uuidv7(), name: z.string().optional(), createdAt: z.iso.datetime(), status: z.string().optional() })).max(objects.data.scope === "inspection" ? 500 : 200).parse(body);
      result = AgentToolObjectsSchema.parse({ version: AGENT_TOOLS_VERSION, contextAuthority: authority, query: objects.data,
        items: rows.map(row => ({ id: row.id, label: (row.name || `模板检查 ${row.createdAt} ${row.id.slice(-8)}`) + (row.status ? " · " + row.status : "") })),
        limit: objects.data.scope === "inspection" ? 500 : 200, complete: false });
    } else if (route === "workspace") {
      const value = AgentToolWorkspaceSchema.parse(body);
      if (new Set(value.tools.map(tool => tool.key)).size !== 5 || new Set(value.commands.map(command => command.domain + "." + command.kind)).size !== 37) return failure(502);
      result = value;
    } else if (definition?.success) {
      const value = AgentToolDefinitionSchema.parse(body);
      if (canonicalJson(value.selection) !== canonicalJson(definition.data.selection) || sha(agentToolDefinitionPayload(value)) !== value.definitionChecksum) return failure(502);
      result = value;
    } else if (call?.success) {
      const value = AgentToolResultSchema.parse(body);
      if (!resultMatches(call.data, value)) return failure(502);
      result = value;
    } else return failure(502);
    if ((result as { contextAuthority: string }).contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) return failure(409, "authority_changed");
    await assertErpIdentityCurrent(identity);
    return Response.json(result, { status: 200, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
