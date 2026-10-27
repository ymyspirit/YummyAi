import { z } from "zod";
import { orderRequirementDraftInput } from "@yummyai/contracts/order/requirement-interpretation";
import { AssistBasisViewSchema, AssistModelSchema, AssistViewSchema, CreateAssistSchema, businessAssistSelection, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { AssistTaskBasisSchema, AssistTaskTargetsSchema, AssistTaskWorkspaceSchema } from "@yummyai/contracts/ai/task-workspace";
import { AssistTargetPageViewSchema } from "@yummyai/contracts/ai/task-target-page";
import { AssistAutomaticAuditReuseProofSchema, AssistReceiptViewSchema, assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
export type AssistAutomaticAuditReuseProof = z.infer<typeof AssistAutomaticAuditReuseProofSchema>;
export type AssistInput = CreateAssist extends infer T
  ? T extends CreateAssist
    ? Omit<T, "modelId" | "requestId">
    : never
  : never;
const assistConfigurationErrors = {
  assist_model_changed: "模型配置已变化 请刷新模型后核对再分析 当前填写仍保留",
  assist_pricing_changed: "模型计价已变化 请刷新价格与单次上限后再分析 当前填写仍保留",
  assist_concurrency_limit: "当前已有 4 个分析任务 请等待完成后再发起 当前填写仍保留",
  assist_pricing_required: "请先为所选模型填写输入单价 输出单价和单次费用上限 当前填写仍保留",
  assist_task_budget_exceeded: "本次预估超过组织单次 AI 预算 请核对限额后再分析 当前填写仍保留",
  assist_unpriced_usage: "本月存在未计价的 AI 调用 请先核对账单与预算 当前填写仍保留",
  assist_monthly_budget_exceeded: "组织当月 AI 预算不足 请核对预算后再分析 当前填写仍保留",
} as const;
type AssistConfigurationError = keyof typeof assistConfigurationErrors;
export class AssistRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: "authority_changed" | "agent_collection_changed" | "assist_target_collection_changed" | AssistConfigurationError | null = null,
  ) {
    super(message);
  }
}
export function assistReadDenied(cause: unknown): cause is AssistRequestError {
  return cause instanceof AssistRequestError && ([401, 403, 404].includes(cause.status) || cause.code === "authority_changed");
}
const historySchema = z.array(AssistViewSchema.pick({ id: true, status: true, createdAt: true, modelLabel: true }).strict()).max(20);
export function assistErrorMessage(status: number, code?: string | null) {
  if (status === 409 && code && Object.hasOwn(assistConfigurationErrors, code)) return assistConfigurationErrors[code as AssistConfigurationError];
  return code === "authority_changed" ? "当前身份或授权范围已变化 原私有资料已隐藏 请重新核对" : code === "agent_collection_changed" || code === "assist_target_collection_changed" ? "读取期间原集合已变化 已清除旧页 请从第一页重新读取" :
    status === 401 ? "请重新登录自己的运营账户" : status === 403 || status === 404 ? "当前无法读取这笔分析或业务资料" :
      status === 400 || status === 422 ? "原填写或固定依据未通过校验 请核对原请求" : status === 409 ? "原依据或请求状态有冲突 请先读取原回执" :
        "请求结果暂时无法核对 原任务仍可能已登记 请读取原回执 不要重复发起付费任务";
}
export async function assistJsonRequest<T>(url: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal, authority?: string, onReuse?: (proof: AssistAutomaticAuditReuseProof) => void): Promise<T> {
  let response: Response;
  try { response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(authority ? { "x-yummyai-context-authority": authority } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: body === undefined || url.startsWith("/api/agent-reads/") || /\/(?:basis|task-basis)(?:\?|$)/.test(url)
      ? AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
  }); } catch { throw new AssistRequestError(0, assistErrorMessage(0)); }
  const reader = response.body?.getReader(); if (!reader) throw new AssistRequestError(502, assistErrorMessage(502));
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
    if (size > (response.ok ? 8 * 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("size"); } chunks.push(part.value); }
  } catch { throw new AssistRequestError(response.ok ? 502 : response.status, assistErrorMessage(response.ok ? 502 : response.status)); }
  finally { reader.releaseLock(); }
  let raw: unknown;
  try { const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; } raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AssistRequestError(response.ok ? 502 : response.status, assistErrorMessage(response.ok ? 502 : response.status)); }
  if (!response.ok) { const code = raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string" &&
    (raw.code === "authority_changed" || raw.code === "agent_collection_changed" || raw.code === "assist_target_collection_changed" || response.status === 409 && Object.hasOwn(assistConfigurationErrors, raw.code))
      ? raw.code as NonNullable<AssistRequestError["code"]> : null;
    throw new AssistRequestError(response.status, assistErrorMessage(response.status, code), code); }
  if (authority && response.headers.get("x-yummyai-context-authority") !== authority) throw new AssistRequestError(409, assistErrorMessage(409, "authority_changed"), "authority_changed");
  const parsed = schema.safeParse(raw); if (!parsed.success) throw new AssistRequestError(502, "原响应结构无法核对 未采用不完整或替代数据");
  if (authority && parsed.data && typeof parsed.data === "object" && "contextAuthority" in parsed.data && parsed.data.contextAuthority !== authority)
    throw new AssistRequestError(409, assistErrorMessage(409, "authority_changed"), "authority_changed");
  const rawReuse = response.headers.get("x-yummyai-assist-reuse-proof");
  if (rawReuse !== null) {
    let raw: unknown; try { raw = rawReuse.length <= 4096 ? JSON.parse(rawReuse) : null; } catch { raw = null; }
    const proof = AssistAutomaticAuditReuseProofSchema.safeParse(raw), original = CreateAssistSchema.safeParse(body), saved = AssistViewSchema.safeParse(parsed.data);
    const hash = async (value: CreateAssist) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(assistRequestRecoveryText(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
    if (!proof.success || !original.success || original.data.kind !== "artwork_preflight" || !original.data.automaticAudit || !saved.success || saved.data.kind !== "artwork_preflight" ||
      saved.data.request?.kind !== "artwork_preflight" || !saved.data.request.automaticAudit || saved.data.stale || !saved.data.artworkAudit || proof.data.runId !== saved.data.id ||
      proof.data.submittedRequestId !== original.data.requestId || proof.data.submittedRequestChecksum !== await hash(original.data) ||
      proof.data.originalRequestId !== saved.data.request.requestId || proof.data.originalRequestId === original.data.requestId || proof.data.originalRequestChecksum !== await hash(saved.data.request) ||
      proof.data.policy !== saved.data.artworkAudit.policy || proof.data.orderLineId !== original.data.orderLineId || proof.data.orderLineId !== saved.data.request.orderLineId || proof.data.orderLineId !== saved.data.artworkAudit.orderLineId ||
      proof.data.revision !== original.data.expectedRevision || proof.data.revision !== saved.data.request.expectedRevision || proof.data.revision !== saved.data.artworkAudit.revision ||
      proof.data.editorVersionId !== original.data.expectedEditorVersionId || proof.data.editorVersionId !== saved.data.request.expectedEditorVersionId || proof.data.editorVersionId !== saved.data.artworkAudit.versionId)
      throw new AssistRequestError(502, "原生产审核复用凭据无法核对 未把新请求标为已登记");
    onReuse?.(proof.data);
  }
  return parsed.data;
}
export async function assistApi<T>(path: string, body?: unknown, signal?: AbortSignal, authority?: string, onReuse?: (proof: AssistAutomaticAuditReuseProof) => void): Promise<T> {
  const root = path.split("?")[0];
  const schema: z.ZodType<unknown> = root === "receipts" ? AssistReceiptViewSchema : root === "task-workspace" ? AssistTaskWorkspaceSchema :
    root === "task-target-pages" ? AssistTargetPageViewSchema : root === "task-targets" ? AssistTaskTargetsSchema : root === "task-basis" ? AssistTaskBasisSchema : root === "basis" ? AssistBasisViewSchema :
      root === "models" ? body === undefined ? z.array(AssistModelSchema.strict()) : z.object({ id: z.uuidv7() }).strict() :
        root === "runs" && body === undefined ? historySchema : AssistViewSchema;
  return await assistJsonRequest(`/api/ai-assists/${path}`, schema, body, signal, authority, onReuse) as T;
}
export function sameAssistInput(request: CreateAssist | null, input: AssistInput | null): boolean {
  if (!request || !input || request.kind !== input.kind) return false;
  if (JSON.stringify(request.salesPlan ?? null) !== JSON.stringify(input.salesPlan ?? null))
    return false;
  if (input.taskGoal !== undefined && (request.taskGoal ?? "") !== input.taskGoal) return false;
  if (
    input.expectedTaskFingerprint &&
    request.expectedTaskFingerprint !== input.expectedTaskFingerprint
  )
    return false;
  if (request.kind === "knowledge_answer" && input.kind === "knowledge_answer")
    return (
      request.scopeId === input.scopeId &&
      request.purpose === input.purpose &&
      request.evidenceStoreId === input.evidenceStoreId &&
      request.previousRunId === input.previousRunId &&
      JSON.stringify(request.search) === JSON.stringify(input.search)
    );
  if ("expectedFingerprint" in request && "expectedFingerprint" in input) {
    return (
      request.expectedFingerprint === input.expectedFingerprint &&
      JSON.stringify(businessAssistSelection(request)) ===
        JSON.stringify(businessAssistSelection(input))
    );
  }
  if (request.kind === "template_config" && input.kind === "template_config")
    return request.inspectionId === input.inspectionId;
  if (request.kind === "sku_package" && input.kind === "sku_package")
    return (
      request.listingId === input.listingId && request.expectedVersionId === input.expectedVersionId
    );
  if (request.kind === "creative" && input.kind === "creative")
    return (
      request.scopeId === input.scopeId &&
      request.prompt === input.prompt &&
      JSON.stringify(request.requirements) === JSON.stringify(input.requirements) &&
      input.sources.length === request.sources.length &&
      input.sources.every((s, i) => {
        const pin = request.sources[i];
        return (
          pin?.researchItemId === s.researchItemId &&
          (!s.snapshotId || pin.snapshotId === s.snapshotId) &&
          (s.studyRevisionId === undefined || pin.studyRevisionId === s.studyRevisionId)
        );
      })
    );
  if (request.kind === "order_review" && input.kind === "order_review")
    return (
      request.orderLineId === input.orderLineId &&
      request.expectedRevision === input.expectedRevision &&
      request.expectedSourceVersionId === input.expectedSourceVersionId &&
      orderRequirementDraftInput(request.draft ?? null) === orderRequirementDraftInput(input.draft ?? null)
    );
  return (
    request.kind === "artwork_preflight" &&
    input.kind === "artwork_preflight" &&
    request.orderLineId === input.orderLineId &&
    request.expectedRevision === input.expectedRevision &&
    request.expectedEditorVersionId === input.expectedEditorVersionId
  );
}
