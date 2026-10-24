import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentDependencyPlanListQuerySchema, AgentDependencyPlanPageSchema, AgentDependencyPlanReceiptQuerySchema,
  AgentDependencyPlanReceiptSchema, AgentDependencyPlanViewSchema, AgentDependencyPlanWorkspaceSchema,
  CreateAgentDependencyPlanSchema, PrepareAgentDependencyPlanSchema, CancelAgentDependencyPlanSchema,
  canonicalAgentDependencyPlanRequest, agentDependencyPlanSourcePayload,
} from "@yummyai/contracts/ai/agent-dependency-plan";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
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
const Id = z.uuidv7(), sha = (value: string) => createHash("sha256").update(value).digest("hex");
function failure(status: number, changed = false) {
  return Response.json({ message: changed ? "当前本人身份或权限已变化 请重新读取原依赖任务" : status === 401 ? "请登录自己的运营账户" :
    status === 403 || status === 404 ? "当前无法读取或操作这笔依赖任务" : status === 400 || status === 422 ? "请核对原发票来源和任务填写" :
      "本次响应未能核对 请读取原任务与原业务回执", ...(changed ? { code: "authority_changed" } : {}) }, { status, headers });
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
  const list = method === "GET" && path.length === 1 && path[0] === "requests";
  const create = method === "POST" && path.length === 1 && path[0] === "requests";
  const get = method === "GET" && path.length === 2 && path[0] === "requests" && Id.safeParse(path[1]).success;
  const prepare = method === "POST" && path.length === 3 && path[0] === "requests" && Id.safeParse(path[1]).success && path[2] === "prepare";
  const cancel = method === "POST" && path.length === 3 && path[0] === "requests" && Id.safeParse(path[1]).success && path[2] === "cancel";
  if (!workspace && !receipt && !list && !create && !get && !prepare && !cancel) return failure(404);
  if (!receipt && !list && url.search) return failure(400);
  let query: Record<string, string> | null = null, input: unknown;
  if (receipt || list) {
    const keys = receipt ? ["requestId", "requestChecksum"] : ["limit", "before", "upperId"];
    if ([...url.searchParams.keys()].some(key => !keys.includes(key) || url.searchParams.getAll(key).length !== 1)) return failure(400);
    const parsed = receipt ? AgentDependencyPlanReceiptQuerySchema.safeParse(Object.fromEntries(url.searchParams)) : AgentDependencyPlanListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return failure(400);
    query = Object.fromEntries(Object.entries(parsed.data).map(([key, value]) => [key, String(value)]));
  }
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
    try {
      const raw = await json(new Response(request.body), 8192);
      const parsed = create ? CreateAgentDependencyPlanSchema.safeParse(raw) : prepare ? PrepareAgentDependencyPlanSchema.safeParse(raw) : CancelAgentDependencyPlanSchema.safeParse(raw);
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
    const response = await apiFetch(base + "/v1/agent-dependency-plans/" + upstream, { method, cache: "no-store",
      ...(method === "POST" ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) {
      let changed = false;
      if (response.status === 409) { try { const body = await json(response, 8192); changed = !!body && typeof body === "object" && "code" in body && body.code === "authority_changed"; } catch { /* No private upstream error is exposed. */ } }
      else await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 410, 413, 422, 503].includes(response.status) ? response.status : 502, changed);
    }
    if (response.status !== (create || prepare ? 201 : 200)) { await response.body?.cancel(); await assertErpIdentityCurrent(identity); return failure(502); }
    const body = await json(response, 512 * 1024);
    const parsed = workspace ? AgentDependencyPlanWorkspaceSchema.safeParse(body) : receipt ? AgentDependencyPlanReceiptSchema.safeParse(body) :
      list ? AgentDependencyPlanPageSchema.safeParse(body) : AgentDependencyPlanViewSchema.safeParse(body);
    await assertErpIdentityCurrent(identity);
    if (!parsed.success) return failure(502);
    if (parsed.data.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) return failure(409, true);
    if (receipt) {
      const value = AgentDependencyPlanReceiptSchema.parse(parsed.data);
      if (value.requestId !== query!.requestId || value.requestChecksum !== query!.requestChecksum) return failure(502);
    } else if (list) {
      const value = AgentDependencyPlanPageSchema.parse(parsed.data), seen = new Set<string>();
      if (value.limit !== Number(query!.limit) || query!.upperId && value.upperId !== query!.upperId) return failure(502);
      for (const item of value.items) {
        if (seen.has(item.id) || value.upperId && item.id > value.upperId || query!.before && item.id >= query!.before) return failure(502);
        seen.add(item.id);
      }
      if (value.items.some((item, index) => index > 0 && value.items[index - 1]!.id <= item.id)
        || value.nextBefore !== null && value.nextBefore !== value.items.at(-1)?.id) return failure(502);
    } else if (!workspace) {
      const value = AgentDependencyPlanViewSchema.parse(parsed.data);
      if ((get || prepare || cancel) && value.id !== path[1]!.toLowerCase()) return failure(502);
      if (create) {
        const expected = CreateAgentDependencyPlanSchema.parse(input);
        if (value.requestId !== expected.requestId || value.requestChecksum !== sha(canonicalAgentDependencyPlanRequest(expected))
          || value.parentAgentCommandId !== expected.parentAgentCommandId || value.dueAt !== expected.dueAt) return failure(502);
      } else if (prepare || cancel) {
        const expected = CancelAgentDependencyPlanSchema.parse(cancel ? input : { version: value.version, requestId: PrepareAgentDependencyPlanSchema.parse(input).requestId });
        if (value.requestId !== expected.requestId) return failure(502);
        if (prepare && value.source && value.source.sourceChecksum !== PrepareAgentDependencyPlanSchema.parse(input).sourceChecksum) return failure(502);
      }
      if (value.source && sha(canonicalJson(agentDependencyPlanSourcePayload(value.source))) !== value.source.sourceChecksum) return failure(502);
      if (value.childDraft && value.childOriginalChecksum !== null && (sha(canonicalAgentCommandOriginal(value.childDraft)) !== value.childOriginalChecksum
        || sha(canonicalAgentCommandRequest("prepare", { version: AGENT_COMMAND_VERSION, requestId: value.childRequestId, original: value.childDraft })) !== value.childPreparationRequestChecksum)) return failure(502);
    }
    return Response.json(parsed.data, { status: response.status, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
