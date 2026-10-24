import { apiFetch } from "../../../../server-api";
import { StudioRpcSchema } from "@yummyai/contracts/pod/creative-studio";
import { ConfigurationRpcSchema, ConfigurationSnapshotSchema, ModelCatalogueSchema, PublicModelProviderSchema } from "@yummyai/contracts/ai/model-configuration";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { Permission } from "@yummyai/authz/permissions";
import { StudioPersonalInvokeSchema, StudioWorkspaceQuerySchema, StudioWorkspaceSchema, parseStudioPersonalReply,
  STUDIO_PERSONAL_MEDIA_LIMIT, STUDIO_PERSONAL_METADATA_LIMIT } from "@yummyai/contracts/pod/studio-personal";
import { readStudioJson, requireStudioPersonalIdentity, studioPersonalCall, studioPersonalException, studioPersonalFailure } from "../../../../creative-studio-personal-server";
import { invalidWebAuthMode, localServiceAuth, localServiceRequest } from "../../../../web-auth-mode";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { PersonalSessionError } from "../../../../identity/core";
import { erpAuthFailure } from "../../../../erp-auth/server";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }
export async function PATCH(request: Request, context: Context) { return proxy(request, context, "PATCH"); }
async function proxy(request: Request, context: Context, method: string) {
  const { path } = await context.params;
  const route = path.join("/");
  if (route === "workspace" && method === "GET" || route === "invoke" && method === "POST")
    return personalStudio(request, route);
  const target = route === "rpc" && method === "POST" ? "creative-studio/rpc"
    : route === "configuration" && method === "POST" ? "ai/configuration"
    : route === "models" && method === "POST" ? "creative-studio/models"
      : route === "providers" && ["GET", "POST"].includes(method) ? "ai/model-configs"
        : /^providers\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(route) && method === "PATCH" ? `ai/model-configs/${path[1]}` : null;
  if (!target) return fail(404);
  if (request.headers.get("sec-fetch-site") === "cross-site" || method !== "GET" && !isSameOriginRequest(request)) return fail(403);
  if (invalidWebAuthMode()) return fail(503);
  const settingsRoute = target === "ai/configuration" || target.startsWith("ai/model-configs");
  // Personal settings use the existing OIDC session path in apiFetch. Other
  // creative endpoints retain their loopback development-only boundary.
  const personalSettings = settingsRoute && !localServiceAuth();
  if (personalSettings) return personalConfiguration(request, target, route, method);
  if (!personalSettings && (process.env.NODE_ENV === "production" || !localServiceRequest(request)))
    return fail(403, "创作接入目前用于本地 ERP，部署需接入用户 OIDC 会话");
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return fail(503);
  try {
    let body: string | undefined;
    if (method !== "GET") {
      if (!request.headers.get("content-type")?.startsWith("application/json")) return fail(415);
      const limit = route === "rpc" ? 28 * 1024 * 1024 : 128 * 1024;
      if (Number(request.headers.get("content-length")) > limit) return fail(413);
      const reader = request.body?.getReader(); if (!reader) return fail(400);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); return fail(413); } chunks.push(part.value); }
      body = Buffer.concat(chunks).toString("utf8");
      let value: unknown; try { value = JSON.parse(body); } catch { return fail(400); }
      if (route === "rpc" && !StudioRpcSchema.safeParse(value).success) return fail(400);
      if (route === "configuration" && !ConfigurationRpcSchema.safeParse(value).success) return fail(400);
    }
    const response = await apiFetch(`${base}/v1/${target}`, { method, body, headers: body ? { "content-type": "application/json" } : undefined, cache: "no-store", signal: AbortSignal.timeout(100_000) });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { message?: unknown };
      // Only deliberate short Chinese business messages cross the BFF. Provider responses and credentials never do.
      const message = typeof result.message === "string" && /^[\u3400-\u9fff]/.test(result.message) && result.message.length <= 200 ? result.message : undefined;
      return fail(response.status, message);
    }
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (cause) {
    if (cause instanceof PersonalSessionError) {
      const response = erpAuthFailure(cause), payload = await response.json() as { message: string };
      return fail(response.status, payload.message);
    }
    return fail(502);
  }
}
async function personalStudio(request: Request, route: "workspace" | "invoke") {
  if (invalidWebAuthMode()) return studioPersonalFailure(503);
  if (localServiceAuth() || process.env.NODE_ENV === "production" && process.env.CANVAS_STUDIO_PRODUCTION_ENABLED !== "1") return studioPersonalFailure(403);
  if (request.headers.get("sec-fetch-site") === "cross-site" || request.method !== "GET" && !isSameOriginRequest(request)) return studioPersonalFailure(403);
  const params = new URL(request.url).searchParams;
  try {
    if (route === "workspace") {
      if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return studioPersonalFailure(400);
      const query = StudioWorkspaceQuerySchema.safeParse(Object.fromEntries(params));
      if (!query.success) return studioPersonalFailure(400);
      const identity = await requireStudioPersonalIdentity(request, [Permission.DesignRead, Permission.AssetRead]);
      const authority = erpSessionAuthority(identity.view);
      return await studioPersonalCall(request, identity, `creative-studio/workspace?scope=${encodeURIComponent(query.data.scope)}`, { method: "GET" }, {
        parse(raw) {
          const value = StudioWorkspaceSchema.parse(raw);
          if (value.scope !== query.data.scope || value.contextAuthority !== authority) throw new PersonalSessionError(409, "authority_changed");
          return value;
        },
      }, 256 * 1024);
    }
    if (params.size) return studioPersonalFailure(400);
    const identity = await requireStudioPersonalIdentity(request, [Permission.DesignRead, Permission.AssetRead]);
    const input = StudioPersonalInvokeSchema.safeParse(await readStudioJson(request, STUDIO_PERSONAL_MEDIA_LIMIT));
    if (!input.success) return studioPersonalFailure(400);
    const authority = erpSessionAuthority(identity.view);
    if (input.data.contextAuthority !== authority) throw new PersonalSessionError(409, "authority_changed");
    return await studioPersonalCall(request, identity, "creative-studio/invoke", { method: "POST",
      body: JSON.stringify(input.data), headers: { "content-type": "application/json" } },
    { parse: raw => parseStudioPersonalReply(raw, input.data.request, authority) },
    ["state.get", "asset.preview", "generation.get"].includes(input.data.request.operation) ? STUDIO_PERSONAL_MEDIA_LIMIT : STUDIO_PERSONAL_METADATA_LIMIT);
  } catch (error) { return studioPersonalException(error, request); }
}
async function personalConfiguration(request: Request, target: string, route: string, method: string) {
  if (new URL(request.url).searchParams.size) return studioPersonalFailure(400);
  try {
    const identity = await requireStudioPersonalIdentity(request, [Permission.ModelConfigure]);
    let body: string | undefined, discover = false;
    if (method !== "GET") {
      const raw = await readStudioJson(request, 128 * 1024);
      if (route === "configuration") {
        const input = ConfigurationRpcSchema.safeParse(raw);
        if (!input.success) return studioPersonalFailure(400);
        discover = input.data.operation === "channel.discover";
        body = JSON.stringify(input.data);
      } else body = JSON.stringify(raw);
    }
    const schema = route === "configuration" ? discover ? ModelCatalogueSchema : ConfigurationSnapshotSchema
      : method === "GET" ? PublicModelProviderSchema.array().max(1000) : PublicModelProviderSchema;
    return await studioPersonalCall(request, identity, target, { method, body,
      headers: body ? { "content-type": "application/json" } : undefined }, schema, 2 * 1024 * 1024);
  } catch (error) { return studioPersonalException(error, request); }
}
function fail(status: number, message?: string) {
  const messages: Record<number, string> = { 400: "请求格式无效，请核对输入", 401: "ERP 登录已失效", 403: "没有权限执行此操作", 404: "记录不存在", 409: "记录或状态已变化，请刷新后重试", 413: "单个素材不能超过 20 MiB", 415: "请求格式不受支持", 422: "素材未通过安全检查", 503: "ERP 服务未就绪" };
  return Response.json({ error: message ?? messages[status] ?? "连接 ERP 失败，当前内容尚未保存" }, { status, headers: { "cache-control": "private, no-store" } });
}
