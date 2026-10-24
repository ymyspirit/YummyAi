import { createHash } from "node:crypto";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { CreateIntegrationApiClientInputSchema, CreatedIntegrationApiClientViewSchema, RevokeIntegrationApiClientInputSchema,
  RevokedIntegrationApiClientViewSchema, IntegrationWorkspaceViewSchema, integrationApiClientRequestCanonical } from "@yummyai/contracts/integration";
import { authorize, permissionScope } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const scopeRank = { self: 0, team: 1, tenant: 2 };
class BodyLimit extends Error {}
const failure = (status: number, code?: "authority_changed") => Response.json({ message: status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前没有开放集成操作权限" : status === 404 ? "当前无法读取这笔客户端记录" : status === 400 || status === 422 ? "客户端填写或请求格式需核对" : status === 409 ? "当前授权或原请求状态需重新核对" : "客户端请求结果暂时无法核对 请保留原编号", ...(code ? { code } : {}) }, { status, headers });
async function readJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("missing_body"); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw new BodyLimit(); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params;
  const workspace = method === "GET" && path.length === 1 && path[0] === "workspace";
  const create = method === "POST" && path.length === 1 && path[0] === "clients";
  const revoke = method === "POST" && path.length === 3 && path[0] === "clients" && path[2] === "revoke";
  if (!workspace && !create && !revoke) return failure(404);
  const id = revoke ? EntityIdSchema.safeParse(path[1]?.toLowerCase()) : null;
  if (revoke && !id?.success || new URL(request.url).search) return failure(400);
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let raw: unknown;
  if (method === "POST") { try { raw = await readJson(new Response(request.body), 32 * 1024); } catch (error) { return failure(error instanceof BodyLimit ? 413 : 400); } }
  const input = create ? CreateIntegrationApiClientInputSchema.safeParse(raw) : revoke ? RevokeIntegrationApiClientInputSchema.safeParse(raw) : null;
  if (method === "POST" && !input?.success) return failure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    try { authorize(identity.view, workspace ? Permission.IntegrationRead : Permission.IntegrationManage); } catch { return failure(403); }
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    if (create && input?.success && "scopes" in input.data) {
      try { for (const bit of input.data.scopes) {
        authorize(identity.view, bit); const maximum = permissionScope(identity.view, bit), selected = input.data.scopeLimits?.[bit];
        if (selected && scopeRank[selected] > scopeRank[maximum]) return failure(403);
      } } catch { return failure(403); }
      if (input.data.teamIds?.some(team => !identity.view.teamIds?.includes(team))) return failure(403);
    }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const target = workspace ? "workspace" : create ? "api-clients" : "api-clients/" + (id?.success ? id.data : "") + "/revoke";
    const response = await apiFetch(base + "/v1/integrations/" + target, { method, cache: "no-store", ...(input?.success ? { body: JSON.stringify(input.data), headers: { "content-type": "application/json" } } : {}), signal: workspace ? AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(30_000) });
    if (!response.ok) {
      let authorityChanged = false;
      if (response.status === 409) { try { const error = await readJson(response, 8192); authorityChanged = Boolean(error && typeof error === "object" && "code" in error && error.code === "authority_changed"); } catch { /* Unknown bodies never become messages. */ } }
      else await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 422, 503].includes(response.status) ? response.status : 502, authorityChanged ? "authority_changed" : undefined);
    }
    if (response.status !== (workspace ? 200 : 201)) { await response.body?.cancel(); return failure(502); }
    const body = await readJson(response, 8 * 1024 * 1024);
    const parsed = workspace ? IntegrationWorkspaceViewSchema.safeParse(body) : create ? CreatedIntegrationApiClientViewSchema.safeParse(body) : RevokedIntegrationApiClientViewSchema.safeParse(body);
    if (!parsed.success) return failure(502);
    if (parsed.data.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) return failure(409, "authority_changed");
    if (workspace) { const value = IntegrationWorkspaceViewSchema.parse(parsed.data); if (value.agentCatalog.contextAuthority !== authority) return failure(409, "authority_changed"); }
    else {
      const value = create ? CreatedIntegrationApiClientViewSchema.parse(parsed.data) : RevokedIntegrationApiClientViewSchema.parse(parsed.data);
      if (revoke && (!id?.success || value.client.id !== id.data || value.client.status !== "revoked" || value.client.credentialState !== "revoked")) return failure(502);
      if (create && input?.success && "scopes" in input.data) {
        const original = input.data, delegation = value.client.delegation;
        if (!delegation || value.client.keyPrefix !== `yai_${value.client.id}` || value.client.label !== original.label || canonicalJson([...value.client.scopes].sort()) !== canonicalJson([...original.scopes].sort()) ||
          (value.client.expiresAt ? new Date(value.client.expiresAt).toISOString() : null) !== (original.expiresAt ? new Date(original.expiresAt).toISOString() : null) ||
          delegation.requestChecksum !== createHash("sha256").update(integrationApiClientRequestCanonical(original)).digest("hex") ||
          canonicalJson(Object.keys(delegation.permissionScopes).sort()) !== canonicalJson([...original.scopes].sort()) ||
          original.scopeLimits && canonicalJson(delegation.permissionScopes) !== canonicalJson(original.scopeLimits) ||
          original.teamIds && canonicalJson([...delegation.teamIds].sort()) !== canonicalJson([...original.teamIds].sort())) return failure(502);
        if ("bearerToken" in value && value.bearerToken !== null && (typeof value.bearerToken !== "string" || !value.bearerToken.startsWith(`yai_${value.client.id}.`) || value.client.status !== "active" || value.client.credentialState !== "pinned")) return failure(502);
      }
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(parsed.data, { status: workspace ? 200 : 201, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
