import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentPlanReceiptQuerySchema, AgentPlanReceiptSchema, AgentPlanViewSchema, AgentPlanWorkspaceSchema,
  CreateAgentPlanSchema, StopAgentPlanSchema, PrepareAgentPlanItemSchema, AgentPlanItemReceiptSchema } from "@yummyai/contracts/ai/agent-plan";
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
const Id = z.uuidv7();
const ItemQuerySchema=PrepareAgentPlanItemSchema.omit({version:true});
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function failure(status: number, code?: "authority_changed") {
  return Response.json({ message: code ? "当前本人身份或权限已变化 请重新核对原回执" : status === 401 ? "请登录自己的运营账户" :
    status === 403 || status === 404 ? "当前无法读取或操作这笔任务" : status === 400 || status === 422 ? "原任务参数需要核对" :
      "本次响应无法核对 原任务可能已登记 请读取原回执", ...(code ? { code } : {}) }, { status, headers });
}
class TooLarge extends Error {}
async function json(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new TooLarge(); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = (await context.params).path, url = new URL(request.url);
  const workspace = method === "GET" && path.length === 1 && path[0] === "workspace";
  const receipt = method === "GET" && path.length === 1 && path[0] === "receipts";
  const create = method === "POST" && path.length === 1 && path[0] === "runs";
  const get = method === "GET" && path.length === 2 && path[0] === "runs" && Id.safeParse(path[1]).success;
  const stop = method === "POST" && path.length === 3 && path[0] === "runs" && Id.safeParse(path[1]).success && path[2] === "stop";
  const itemPrepare=method==='POST'&&path.length===5&&path[0]==='runs'&&Id.safeParse(path[1]).success&&path[2]==='items'&&Id.safeParse(path[3]).success&&path[4]==='prepare';
  const itemReceipt=method==='GET'&&path.length===5&&path[0]==='runs'&&Id.safeParse(path[1]).success&&path[2]==='items'&&Id.safeParse(path[3]).success&&path[4]==='receipt';
  if (!workspace && !receipt && !create && !get && !stop&&!itemPrepare&&!itemReceipt) return failure(404);
  if (!receipt&&!itemReceipt && url.search) return failure(400);
  let query: z.infer<typeof AgentPlanReceiptQuerySchema> | null = null;
  let originalItemQuery:z.infer<typeof ItemQuerySchema>|null=null;
  if(itemReceipt){
    if([...url.searchParams.keys()].some(key=>!['requestId','proposalChecksum'].includes(key))||url.searchParams.getAll('requestId').length!==1||url.searchParams.getAll('proposalChecksum').length!==1)return failure(400);
    const parsed=ItemQuerySchema.safeParse(Object.fromEntries(url.searchParams));if(!parsed.success)return failure(400);originalItemQuery=parsed.data;
  }
  if (receipt) {
    if ([...url.searchParams.keys()].some(key => !["requestId", "requestChecksum"].includes(key))
      || url.searchParams.getAll("requestId").length !== 1 || url.searchParams.getAll("requestChecksum").length !== 1) return failure(400);
    const parsed = AgentPlanReceiptQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return failure(400); query = parsed.data;
  }
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let input: unknown;
  if (method === "POST") {
    try {
      const body = await json(new Response(request.body), create?128*1024:8192);
      const parsed = create ? CreateAgentPlanSchema.safeParse(body) : itemPrepare?PrepareAgentPlanItemSchema.safeParse(body):StopAgentPlanSchema.safeParse(body);
      if (!parsed.success) return failure(400); input = parsed.data;
    } catch (error) { return failure(error instanceof TooLarge ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try { if(!stop)authorize(identity.view,Permission.WorkflowRead);if(create||stop||itemPrepare)authorize(identity.view,Permission.WorkflowRun); } catch { return failure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const upstreamPath = path.map(encodeURIComponent).join("/") + (query||originalItemQuery ? "?" + new URLSearchParams(query??originalItemQuery!) : "");
    const response = await apiFetch(base + "/v1/agent-plans/" + upstreamPath, { method, cache: "no-store",
      ...(method === "POST" ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(35_000)]) });
    if (!response.ok) {
      let changed = false;
      if (response.status === 409) { try { const body = await json(response, 8192);
        changed = !!body && typeof body === "object" && "code" in body && body.code === "authority_changed";
      } catch { /* Raw upstream errors are never exposed. */ } } else await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return failure([400, 401, 403, 404, 409, 422, 503].includes(response.status) ? response.status : 502, changed ? "authority_changed" : undefined);
    }
    if (response.status !== (create||itemPrepare ? 201 : 200)) { await response.body?.cancel(); await assertErpIdentityCurrent(identity); return failure(502); }
    const body = await json(response, 8 * 1024 * 1024);
    const parsed = workspace ? AgentPlanWorkspaceSchema.safeParse(body) : receipt || stop ? AgentPlanReceiptSchema.safeParse(body) : itemPrepare||itemReceipt?AgentPlanItemReceiptSchema.safeParse(body):AgentPlanViewSchema.safeParse(body);
    if (!parsed.success) { await assertErpIdentityCurrent(identity); return failure(502); }
    if (parsed.data.contextAuthority !== authority || response.headers.has("x-yummyai-context-authority") && response.headers.get("x-yummyai-context-authority") !== authority) {
      await assertErpIdentityCurrent(identity); return failure(409, "authority_changed");
    }
    if (workspace) {
      const value = AgentPlanWorkspaceSchema.parse(parsed.data);
      if (value.readWorkspace.contextAuthority !== authority || value.executionContract.executorKey !== "erp.agent.plan") return failure(502);
    } else if (receipt || stop) {
      const value = AgentPlanReceiptSchema.parse(parsed.data);
      if (query && (value.requestId !== query.requestId || value.requestChecksum !== query.requestChecksum)) return failure(502);
      if (stop && (value.disposition !== "known" || value.runId !== path[1] || value.requestId !== StopAgentPlanSchema.parse(input).requestId)) return failure(502);
    } else if(itemPrepare||itemReceipt){
      const value=AgentPlanItemReceiptSchema.parse(parsed.data),original=itemPrepare?PrepareAgentPlanItemSchema.parse(input):originalItemQuery!;
      if(value.runId!==path[1]||value.itemId!==path[3]||value.proposalChecksum!==original.proposalChecksum||value.disposition==='known'&&!value.ownerCommandId)return failure(502);
    } else {
      const value = AgentPlanViewSchema.parse(parsed.data);
      if (get && value.id !== path[1] || !value.privateAvailable && (value.goal !== null || value.contextText!==null || value.result !== null || value.collections.length > 0)
        || new Set(value.steps.map(step => step.id)).size !== value.steps.length || value.steps.some((step, index) => step.sequence !== index + 1)
        || value.collections.some(collection => !value.steps.some(step => step.id === collection.stepId && step.kind === "read" && step.phase === "completed" && step.tool === collection.tool))) return failure(502);
      if (create) {
        const original = CreateAgentPlanSchema.parse(input);
        if (value.requestId !== original.requestId || value.requestChecksum !== checksum(original)
          || canonicalJson(value.executionContract) !== canonicalJson(original.executionContract)
          || canonicalJson(value.allowedReads) !== canonicalJson(original.allowedReads)
          || canonicalJson(value.allowedCommands) !== canonicalJson(original.allowedCommands)
          || canonicalJson(value.limits) !== canonicalJson(original.limits)
          || Number(value.cost.capUsd) > original.maxCostUsd
          || value.privateAvailable && (value.goal !== original.goal || value.contextText !== original.contextText)) return failure(502);
      }
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(parsed.data, { status: response.status, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
