import { createHash } from "node:crypto";
import { z } from "zod";
import { AssistBasisViewSchema, AssistBusinessSelectionSchema, AssistHistoryEntrySchema, AssistKindSchema, AssistModelInputSchema, AssistModelSchema, AssistViewSchema, CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { AssistTaskBasisRequestSchema, AssistTaskBasisSchema, AssistTaskQuerySchema, AssistTaskTargetsSchema, AssistTaskTargetQuerySchema, AssistTaskWorkspaceSchema } from "@yummyai/contracts/ai/task-workspace";
import { AssistTargetPageQuerySchema, AssistTargetPageViewSchema } from "@yummyai/contracts/ai/task-target-page";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AssistAutomaticAuditReuseProofSchema, AssistReceiptQuerySchema, AssistReceiptViewSchema, assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ path: string[] }> };
const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const Id = z.uuidv7();
const historyQuery = z.object({ kind: AssistKindSchema, scope: z.string().max(200).regex(/^(?:(creative|order|template|listing|finance|case|knowledge):[0-9a-f-]{36}|procurement:[0-9a-f-]{36}:[0-9a-f-]{36})$/i), automaticAudit: z.literal("1").optional() }).strict();
const historyView = z.array(AssistHistoryEntrySchema).max(20);
class TooLarge extends Error {}
const configurationFailures = {
  assist_model_changed: "模型配置已变化 请刷新模型后核对再分析 当前填写仍保留",
  assist_pricing_changed: "模型计价已变化 请刷新价格与单次上限后再分析 当前填写仍保留",
  assist_concurrency_limit: "当前已有 4 个分析任务 请等待完成后再发起 当前填写仍保留",
  assist_pricing_required: "请先为所选模型填写输入单价 输出单价和单次费用上限 当前填写仍保留",
  assist_task_budget_exceeded: "本次预估超过组织单次 AI 预算 请核对限额后再分析 当前填写仍保留",
  assist_unpriced_usage: "本月存在未计价的 AI 调用 请先核对账单与预算 当前填写仍保留",
  assist_monthly_budget_exceeded: "组织当月 AI 预算不足 请核对预算后再分析 当前填写仍保留",
} as const;
type FailureCode = "authority_changed" | "assist_target_collection_changed" | keyof typeof configurationFailures;
function failure(status: number, code?: FailureCode) {
  const configurationMessage = status === 409 && code && Object.hasOwn(configurationFailures, code)
    ? configurationFailures[code as keyof typeof configurationFailures] : undefined;
  return Response.json({ message: configurationMessage ?? (code === "assist_target_collection_changed" ? "原业务集合已变化 请从第一页重新读取" : code ? "当前权限或身份已变化 请核对原回执后继续" : status === 401 ? "请重新登录自己的运营账户" : status === 403 || status === 404 ? "当前无法读取这笔分析资料" :
    status === 400 || status === 422 ? "分析填写或原依据未通过校验 请核对原请求" : status === 409 ? "原请求或固定依据存在冲突 请先读取原回执" : "分析请求结果暂不可核对 请保留原编号 不重复发起付费任务"), ...(code ? { code } : {}) }, { status, headers: privateHeaders });
}
async function bytes(response: Response, limit: number) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("body"); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw new TooLarge(); } chunks.push(part.value); } }
  finally { reader.releaseLock(); } return Buffer.concat(chunks);
}
async function json(response: Response, limit: number): Promise<unknown> { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, limit))); }
const checksum = (value: Parameters<typeof assistRequestRecoveryText>[0]) => createHash("sha256").update(assistRequestRecoveryText(value)).digest("hex");
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const segments = (await context.params).path, root = segments[0], id = segments.length > 1 ? Id.safeParse(segments[1]?.toLowerCase()) : null;
  const image = method === "GET" && root === "runs" && segments.length === 4 && id?.success && segments[2] === "images" && /^(?:[0-9]|1[0-5])$/.test(segments[3] ?? "");
  const run = method === "GET" && root === "runs" && segments.length === 2 && id?.success;
  const single = segments.length === 1 && (method === "GET" ? ["models", "task-workspace", "task-targets", "task-target-pages", "runs", "receipts"] : ["models", "runs", "basis", "task-basis"]).includes(root ?? "");
  if (!single && !run && !image) return failure(404);
  const target = run || image ? ["runs", id!.success ? id!.data : "", ...segments.slice(2)].join("/") : root!;
  let query: Record<string, string> = {}, input: unknown;
  try {
    const search = new URL(request.url).searchParams;
    for (const [key, value] of search) { if (Object.hasOwn(query, key)) return failure(400); query[key] = value; }
    if (image) {
      // The existing image component uses this local cache-buster for retries.
      // It does not select a different upstream image or authorization context.
      z.object({ previewAttempt: z.string().regex(/^(?:0|[1-9]\d{0,8})$/).optional() }).strict().parse(query);
      query = {};
    } else if (method === "POST" || run || root === "models") { if (Object.keys(query).length) return failure(400); }
    else if (root === "receipts") query = AssistReceiptQuerySchema.parse(query);
    else if (root === "task-workspace") query = Object.fromEntries(Object.entries(AssistTaskQuerySchema.parse(query)).map(([key, value]) => [key, String(value)]));
    else if (root === "task-targets") query = AssistTaskTargetQuerySchema.parse(query);
    else if (root === "task-target-pages") query = Object.fromEntries(Object.entries(AssistTargetPageQuerySchema.parse(query)).map(([key, value]) => [key, String(value)]));
    else if (root === "runs") query = historyQuery.parse(query);
  } catch { return failure(400); }
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
    try { const raw = await json(new Response(request.body), 128 * 1024);
      const schema = root === "runs" ? CreateAssistSchema : root === "models" ? AssistModelInputSchema : root === "basis" ? AssistBusinessSelectionSchema : AssistTaskBasisRequestSchema;
      const parsed = schema.safeParse(raw); if (!parsed.success) return failure(400); input = parsed.data;
    } catch (error) { return failure(error instanceof TooLarge ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view), incoming = request.headers.get("x-yummyai-context-authority");
    if ((root === "receipts" || root === "task-target-pages" || incoming !== null) && incoming !== authority) throw new PersonalSessionError(409, "authority_changed");
    try {
      if (method === "POST" && root === "models") authorize(identity.view, Permission.ModelConfigure);
      const kind = input && typeof input === "object" && "kind" in input ? AssistKindSchema.parse(input.kind) : query.kind ? AssistKindSchema.parse(query.kind) : null;
      if (kind) for (const bit of requiredAssistPermissions(kind, method === "POST" && (root === "runs" || root === "task-basis") ? "run" : "read")) authorize(identity.view, bit);
    } catch { return failure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
    const search = new URLSearchParams(query), response = await apiFetch(`${base}/v1/ai-assists/${target}${search.size ? "?" + search : ""}`, { method, ...(input ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}),
      cache: "no-store", signal: method === "POST" && root !== "basis" && root !== "task-basis" ? AbortSignal.timeout(110_000) : AbortSignal.any([request.signal, AbortSignal.timeout(110_000)]) });
    if (!response.ok) {
      let changed: FailureCode | undefined;
      if (response.status === 409) { try { const body = await json(response, 8192); if (body && typeof body === "object" && "code" in body) {
        if (body.code === "authority_changed") changed = body.code;
        else if (root === "task-target-pages" && body.code === "assist_target_collection_changed") changed = body.code;
        else if (method === "POST" && root === "runs" && typeof body.code === "string" && Object.hasOwn(configurationFailures, body.code)) changed = body.code as keyof typeof configurationFailures;
      } } catch { /* Keep upstream text private. */ } }
      else await response.body?.cancel();
      await assertErpIdentityCurrent(identity); return failure([400, 401, 403, 404, 409, 413, 422, 503].includes(response.status) ? response.status : 502, changed);
    }
    if (response.status !== (method === "GET" ? 200 : 201)) { await response.body?.cancel(); return failure(502); }
    if (image) {
      const body = await bytes(response, 32 * 1024 * 1024); await assertErpIdentityCurrent(identity);
      return new Response(body, { headers: { ...privateHeaders, "content-type": "image/jpeg", "content-security-policy": "default-src 'none'; sandbox", "x-yummyai-context-authority": authority } });
    }
    const schema: z.ZodType = root === "receipts" ? AssistReceiptViewSchema : root === "task-workspace" ? AssistTaskWorkspaceSchema : root === "task-target-pages" ? AssistTargetPageViewSchema : root === "task-targets" ? AssistTaskTargetsSchema :
      root === "task-basis" ? AssistTaskBasisSchema : root === "basis" ? AssistBasisViewSchema : root === "models" ? method === "GET" ? z.array(AssistModelSchema.strict()) : z.object({ id: Id }).strict() :
        root === "runs" && method === "GET" && !run ? historyView : AssistViewSchema;
    const parsed = schema.safeParse(await json(response, 8 * 1024 * 1024)); if (!parsed.success) return failure(502);
    const value = parsed.data; let reuseHeader: string | undefined;
    if (root === "receipts") {
      const receipt = AssistReceiptViewSchema.parse(value);
      if (receipt.contextAuthority !== authority) return failure(409, "authority_changed");
      if (receipt.requestId !== query.requestId || receipt.requestChecksum !== query.requestChecksum || receipt.run?.request && checksum(receipt.run.request) !== query.requestChecksum) return failure(502);
    } else if (root === "task-target-pages") {
      const page = AssistTargetPageViewSchema.parse(value);
      if (page.contextAuthority !== authority) return failure(409, "authority_changed");
      if (canonicalJson(page.query) !== canonicalJson(AssistTargetPageQuerySchema.parse(query))) return failure(502);
    } else if (run || method === "POST" && root === "runs") {
      const saved = AssistViewSchema.parse(value);
      if (run && (!id?.success || saved.id !== id.data)) return failure(502);
      if (method === "POST") {
        const original = CreateAssistSchema.parse(input);
        if (saved.kind !== original.kind) return failure(502);
        const different = saved.request && assistRequestRecoveryText(saved.request) !== assistRequestRecoveryText(original);
        const rawReuse = response.headers.get("x-yummyai-assist-reuse-proof");
        if (different || rawReuse !== null) {
          let rawProof: unknown; try { rawProof = rawReuse && rawReuse.length <= 4096 ? JSON.parse(rawReuse) : null; } catch { rawProof = null; }
          const proof = AssistAutomaticAuditReuseProofSchema.safeParse(rawProof), prior = saved.request, audit = saved.artworkAudit;
          if (!different || !proof.success || original.kind !== "artwork_preflight" || !original.automaticAudit || prior?.kind !== "artwork_preflight" || !prior.automaticAudit || saved.stale || !audit ||
            proof.data.submittedRequestId !== original.requestId || proof.data.submittedRequestChecksum !== checksum(original) || proof.data.runId !== saved.id ||
            proof.data.originalRequestId !== prior.requestId || proof.data.originalRequestId === original.requestId || proof.data.originalRequestChecksum !== checksum(prior) ||
            proof.data.policy !== audit.policy || proof.data.orderLineId !== original.orderLineId || proof.data.orderLineId !== prior.orderLineId || proof.data.orderLineId !== audit.orderLineId ||
            proof.data.revision !== original.expectedRevision || proof.data.revision !== prior.expectedRevision || proof.data.revision !== audit.revision ||
            proof.data.editorVersionId !== original.expectedEditorVersionId || proof.data.editorVersionId !== prior.expectedEditorVersionId || proof.data.editorVersionId !== audit.versionId) return failure(502);
          reuseHeader = JSON.stringify(proof.data);
        }
        if (!saved.request) {
          const check = await apiFetch(`${base}/v1/ai-assists/receipts?${new URLSearchParams({ requestId: original.requestId, requestChecksum: checksum(original) })}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
          if (check.status !== 200) { await check.body?.cancel(); return failure(502); }
          const proof = AssistReceiptViewSchema.safeParse(await json(check, 8 * 1024 * 1024));
          if (!proof.success || proof.data.contextAuthority !== authority || proof.data.state !== "found" || proof.data.run?.id !== saved.id || proof.data.requestId !== original.requestId || proof.data.requestChecksum !== checksum(original)) return failure(502);
        }
      }
    } else if (root === "task-workspace" && AssistTaskWorkspaceSchema.parse(value).page !== Number(query.page)) return failure(502);
    else if (root === "task-basis" && AssistTaskBasisSchema.parse(value).input.kind !== AssistTaskBasisRequestSchema.parse(input).kind) return failure(502);
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { status: response.status, headers: { ...privateHeaders, "x-yummyai-context-authority": authority, ...(reuseHeader ? { "x-yummyai-assist-reuse-proof": reuseHeader } : {}) } });
  } catch (error) { return error instanceof PersonalSessionError ? erpAuthFailure(error, request) : failure(502); }
}
