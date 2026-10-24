import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { IncomingWorkspaceViewSchema, IncomingLineWorkspaceViewSchema } from "@yummyai/contracts/procurement/incoming";
import { PrepareIncomingCommandSchema, IncomingCommandEmptyBodySchema, IncomingCommandScopeSchema,
  IncomingCommandViewSchema, IncomingCommandListSchema, IncomingOrderCommandsSchema } from "@yummyai/contracts/procurement/incoming-command";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";

const Id = z.uuidv7().transform(value => value.toLowerCase());
const actions = new Set(["execute", "cancel", "acknowledge"]);
type RouteContext = { params: Promise<{ path: string[] }> };
export const GET = (request: Request, context: RouteContext) => proxy(request, context, "GET");
export const POST = (request: Request, context: RouteContext) => proxy(request, context, "POST");

async function proxy(request: Request, context: RouteContext, method: "GET" | "POST") {
  const { path } = await context.params;
  const search = new URL(request.url).searchParams;
  const query = Object.fromEntries(search);
  if (search.size !== Object.keys(query).length) return failure(400);
  let suffix: string, shape: z.ZodType, original: z.infer<typeof PrepareIncomingCommandSchema> | undefined;
  let target: string | undefined, commandId: string | undefined, body: unknown;
  try {
    if (path[0] === "commands" && path.length === 1) {
      if (method === "GET") {
        const scope = IncomingCommandScopeSchema.parse(query); target = scope.targetId;
        suffix = "commands?" + new URLSearchParams(scope); shape = IncomingCommandListSchema;
      } else {
        z.object({}).strict().parse(query); suffix = "commands"; shape = IncomingCommandViewSchema;
      }
    } else if (path[0] === "commands" && (path.length === 2 && method === "GET" || path.length === 3 && method === "POST" && actions.has(path[2]!))) {
      commandId = Id.parse(path[1]); z.object({}).strict().parse(query);
      suffix = `commands/${commandId}${path[2] ? "/" + path[2] : ""}`; shape = IncomingCommandViewSchema;
    } else if (method === "GET" && path[0] === "orders" && (path.length === 2 || path.length === 3 && path[2] === "commands")) {
      target = Id.parse(path[1]);
      if (path.length === 2) { z.object({}).strict().parse(query); suffix = `orders/${target}`; shape = IncomingWorkspaceViewSchema; }
      else {
        const options = z.object({ before: Id.optional() }).strict().parse(query);
        suffix = `orders/${target}/commands${options.before ? "?before=" + options.before : ""}`; shape = IncomingOrderCommandsSchema;
      }
    } else if (method === "GET" && path[0] === "lines" && path.length === 2) {
      target = Id.parse(path[1]); z.object({}).strict().parse(query); suffix = `lines/${target}`; shape = IncomingLineWorkspaceViewSchema;
    } else return failure(404);
  } catch { return failure(400); }
  if (method === "POST") {
    if (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json")) return failure(403);
    const reader = request.body?.getReader(); if (!reader) return failure(400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > 262_144) { await reader.cancel(); return failure(413); }
        chunks.push(next.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (path.length === 1) { original = PrepareIncomingCommandSchema.parse(value); body = original; }
      else body = IncomingCommandEmptyBodySchema.parse(value);
    } catch { return failure(400); }
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/procurement/incoming/${suffix}`, { method, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "content-type": "application/json" },
      signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(45_000) });
    if (!response.ok) {
      const error = [400, 409, 422].includes(response.status) ? await response.json().catch(() => null) : null;
      const code = typeof error?.code === "string" && /^(incoming_[a-z_]+|authority_changed)$/.test(error.code) ? error.code : undefined;
      return failure(response.status, typeof error?.message === "string" && error.message.length < 400 ? error.message : undefined, code);
    }
    const parsed = shape.safeParse(await response.json()); if (!parsed.success) return failure(502);
    const value = parsed.data as Record<string, unknown>;
    if (target && path[0] === "orders" && value.purchaseOrderId !== target || target && path[0] === "lines" && (value.line as { id: string }).id !== target) return failure(502);
    if (path[0] === "commands" && method === "GET" && path.length === 1) {
      const scope = IncomingCommandScopeSchema.parse(query), list = IncomingCommandListSchema.parse(value);
      if (list.items.some(row => row.kind !== scope.kind || row.targetId !== scope.targetId || row.acknowledged || row.contextAuthority !== list.contextAuthority)) return failure(502);
    }
    if (shape === IncomingOrderCommandsSchema) {
      const list = IncomingOrderCommandsSchema.parse(value);
      if (list.items.some(row => row.acknowledged || row.contextAuthority !== list.contextAuthority)) return failure(502);
    }
    if (shape === IncomingCommandViewSchema) {
      const row = IncomingCommandViewSchema.parse(value);
      if (commandId && row.id !== commandId || original && (row.kind !== original.kind || row.targetId !== original.targetId ||
        row.postingId !== (original.kind === "return_rejected" ? original.postingId : null) || row.original && canonicalJson(row.original) !== canonicalJson(original))) return failure(502);
      if (path[2] && row.status === "prepared" || path[2] === "acknowledge" && !row.acknowledged) return failure(502);
    }
    return Response.json(value, { status: response.status, headers: privateHeaders });
  } catch { return failure(502); }
}
const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
function failure(status: number, message?: string, code?: string) {
  return Response.json({ code: code ?? (status >= 500 ? "incoming_result_unconfirmed" : undefined), message: message ??
    (status === 401 ? "登录已失效 请重新登录" : status === 403 ? "当前账号没有原来料记录的访问或操作权限" : status === 404 ? "原来料记录不可访问" :
      status === 400 ? "请核对原填写和操作参数" : "本次结果暂时无法确认 请读取原提交核对") }, { status, headers: privateHeaders });
}
