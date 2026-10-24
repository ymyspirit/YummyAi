import {
  AgentFulfillmentWorkspaceSchema, AgentFulfillmentDefinitionRequestSchema, AgentFulfillmentDefinitionSchema,
  AgentFulfillmentCandidatesQuerySchema, AgentFulfillmentCandidatesSchema, AgentFulfillmentCallSchema, AgentFulfillmentResultSchema,
} from "@yummyai/contracts/ai/agent-fulfillment";
import { verifyAgentFulfillmentDefinition, verifyAgentFulfillmentCandidates, verifyAgentFulfillmentResult } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const failure = (status: number, code?: string) => Response.json({
  message: status === 401 ? "请登录自己的运营账户" : status === 409 ? "身份 工具或原对象已变化 请清除旧结果后重读" :
    status === 403 || status === 404 ? "当前不能读取这项原业务资源" : "原业务资源暂时无法核对 请重新读取",
  ...(code ? { code } : {}),
}, { status, headers });
class TooLarge extends Error {}
async function json(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new TooLarge(); } chunks.push(part.value); }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { reader.releaseLock(); }
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const parts = (await context.params).path, route = parts.length === 1 ? parts[0] : "";
  if (method === "GET" ? route !== "workspace" : !["definition", "candidates", "call"].includes(route)) return failure(404);
  if (new URL(request.url).search) return failure(400);
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let raw: unknown;
  if (method === "POST") { try { raw = await json(new Response(request.body), 40 * 1024); }
    catch (error) { return failure(error instanceof TooLarge ? 413 : 400); } }
  const definition = route === "definition" ? AgentFulfillmentDefinitionRequestSchema.safeParse(raw) : null;
  const candidates = route === "candidates" ? AgentFulfillmentCandidatesQuerySchema.safeParse(raw) : null;
  const call = route === "call" ? AgentFulfillmentCallSchema.safeParse(raw) : null;
  if (definition && !definition.success || candidates && !candidates.success || call && !call.success) return failure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const response = await apiFetch(base + "/v1/agent-fulfillment/" + route, { method, cache: "no-store",
      ...(method === "GET" ? {} : { body: JSON.stringify(definition?.success ? definition.data : candidates?.success ? candidates.data : call?.success ? call.data : null),
        headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]),
    });
    if (!response.ok) {
      let code: string | undefined;
      if (response.status === 409) { try { const body = await json(response, 8192);
        if (body && typeof body === "object" && "code" in body && typeof body.code === "string" &&
          ["authority_changed", "agent_fulfillment_definition_changed", "agent_fulfillment_contract_changed", "agent_fulfillment_source_changed"].includes(body.code)) code = body.code;
      } catch { /* Never forward private native diagnostics. */ } }
      else await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 408, 409, 422, 503].includes(response.status) ? response.status : 502, code);
    }
    if (response.status !== 200) { await response.body?.cancel(); return failure(502); }
    const body = await json(response, 8 * 1024 * 1024);
    let result: { contextAuthority: string };
    if (route === "workspace") { const value = AgentFulfillmentWorkspaceSchema.parse(body); await verifyAgentFulfillmentDefinition(value.definition); if (value.definition.contextAuthority !== value.contextAuthority) return failure(409, "authority_changed"); result = value; }
    else if (definition?.success) { const value = AgentFulfillmentDefinitionSchema.parse(body); await verifyAgentFulfillmentDefinition(value); result = value; }
    else if (candidates?.success) { const value = AgentFulfillmentCandidatesSchema.parse(body); await verifyAgentFulfillmentCandidates(value, candidates.data); result = value; }
    else if (call?.success) { const value = AgentFulfillmentResultSchema.parse(body); await verifyAgentFulfillmentResult(value, call.data); result = value; }
    else return failure(502);
    if (result.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority)
      return failure(409, "authority_changed");
    await assertErpIdentityCurrent(identity);
    return Response.json(result, { status: 200, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
