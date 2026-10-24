import { createHash } from "node:crypto";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  CalculateFinanceAllocatedProfitInputSchema, FinanceAllocatedProfitRunPageSchema,
  FinanceAllocatedProfitRunViewSchema, FinanceAllocatedProfitSlicePageSchema,
  FinanceCostAllocationBaseViewSchema, FinanceCostAllocationListInputSchema,
  FinanceCostAllocationPreviewInputSchema, FinanceCostAllocationPreviewViewSchema,
  FinanceCostAllocationSourceListInputSchema, FinanceCostAllocationSourcePageSchema,
  FinanceCostAllocationTargetListInputSchema, FinanceCostAllocationTargetPageSchema,
  FinanceCostAllocationVersionInputSchema, FinanceCostAllocationVersionPageSchema,
  FinanceCostAllocationVersionViewSchema, financeAllocatedProfitInputIdentity,
  financeCostPreviewChecksumIdentity, financeCostTargetBasisIdentity,
  financeCostVersionChecksumIdentity, normalizeFinanceCostAllocationPreviewInput,
  type CalculateFinanceAllocatedProfitInput, type FinanceAllocatedProfitRun,
  type FinanceCostAllocationPreview, type FinanceCostAllocationPreviewInput,
  type FinanceCostAllocationTarget, type FinanceCostAllocationVersion,
  type FinanceCostAllocationVersionInput,
} from "@yummyai/contracts/finance/cost-allocation";
import type { z } from "zod";
import { apiFetch } from "../../../../../server-api";
import { isSameOriginRequest } from "../../../../../same-origin-request";
import { PersonalSessionError } from "../../../../../identity/core";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
type List = z.infer<typeof FinanceCostAllocationListInputSchema>;
type ReadPlan = { kind: "base" | "version" | "run"; id: string }
  | { kind: "sources"; id: string; input: z.infer<typeof FinanceCostAllocationSourceListInputSchema> }
  | { kind: "targets"; input: z.infer<typeof FinanceCostAllocationTargetListInputSchema> }
  | { kind: "versions" | "runs"; input: List }
  | { kind: "slices"; id: string; input: List };
type CursorPosition = { v: 1; scope: string; upperKey: string; key: string };
type Page<T> = { items: T[]; limit: number; upperBoundKey: string | null; nextCursor: string | null; hasMore: boolean };
const Id = EntityIdSchema.transform(value => value.toLowerCase());
const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const MAX_REQUEST_BYTES = 256 * 1024, MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function GET(request: Request, context: Context) {
  const { path } = await context.params;
  const plan = readPlan(request, path); if (plan instanceof Response) return plan;
  const input = "input" in plan ? plan.input : null;
  const period = plan.kind === "targets" && plan.input.dimension === "period";
  const position = input?.cursor ? cursorPosition(input.cursor, period) : null;
  if (input?.cursor && !position) return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  const params = new URLSearchParams();
  if (input) {
    params.set("limit", String(input.limit)); if (input.cursor) params.set("cursor", input.cursor);
    if (plan.kind === "sources") params.set("dimension", plan.input.dimension);
    if (plan.kind === "targets") { params.set("dimension", plan.input.dimension); if (plan.input.key) params.set("key", plan.input.key); }
    if (plan.kind === "versions" || plan.kind === "runs") {
      if (plan.input.baseRunId) params.set("baseRunId", plan.input.baseRunId);
      if (plan.input.allocationId) params.set("allocationId", plan.input.allocationId);
    }
  }
  const endpoint = plan.kind === "base" ? `bases/${plan.id}` : plan.kind === "sources" ? `bases/${plan.id}/sources`
    : plan.kind === "version" ? `versions/${plan.id}` : plan.kind === "run" ? `runs/${plan.id}`
      : plan.kind === "slices" ? `runs/${plan.id}/slices` : plan.kind;
  try {
    const response = await apiFetch(`${base}/v1/finance/cost-allocations/${endpoint}${params.size ? `?${params}` : ""}`, {
      cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]),
    });
    if (!response.ok) return upstreamFailure(response);
    if (response.status !== 200) { await response.body?.cancel(); return failure(502); }
    const raw = await boundedJson(response, MAX_RESPONSE_BYTES);
    if (plan.kind === "base") {
      const value = FinanceCostAllocationBaseViewSchema.parse(raw);
      return value.id === plan.id ? success(value) : failure(502);
    }
    if (plan.kind === "version") {
      const value = FinanceCostAllocationVersionViewSchema.parse(raw);
      return value.id === plan.id && validVersion(value) ? success(value) : failure(502);
    }
    if (plan.kind === "run") {
      const value = FinanceAllocatedProfitRunViewSchema.parse(raw);
      return value.id === plan.id && validRun(value) ? success(value) : failure(502);
    }
    if (plan.kind === "sources") {
      const value = FinanceCostAllocationSourcePageSchema.parse(raw);
      return validPage(value, plan.input, position, row => row.rootFactId) ? success(value) : failure(502);
    }
    if (plan.kind === "targets") {
      const value = FinanceCostAllocationTargetPageSchema.parse(raw);
      return validPage(value, plan.input, position, row => row.key, period)
        && value.items.every(row => row.dimension === plan.input.dimension && (!plan.input.key || row.key === plan.input.key) && validTarget(row)) ? success(value) : failure(502);
    }
    if (plan.kind === "versions") {
      const value = FinanceCostAllocationVersionPageSchema.parse(raw);
      return validPage(value, plan.input, position, row => row.id) && value.items.every(row =>
        (!plan.input.baseRunId || row.baseRunId === plan.input.baseRunId) && (!plan.input.allocationId || row.allocationId === plan.input.allocationId)) ? success(value) : failure(502);
    }
    if (plan.kind === "runs") {
      const value = FinanceAllocatedProfitRunPageSchema.parse(raw);
      return validPage(value, plan.input, position, row => row.id) && value.items.every(row => validRun(row)
        && (!plan.input.baseRunId || row.baseRunId === plan.input.baseRunId)
        && (!plan.input.allocationId || row.versionPins.some(pin => pin.allocationId === plan.input.allocationId))) ? success(value) : failure(502);
    }
    if (plan.kind !== "slices") return failure(502);
    const value = FinanceAllocatedProfitSlicePageSchema.parse(raw);
    return validPage(value, plan.input, position, row => row.id) && value.items.every(row => row.runId === plan.id && (!row.target || validTarget(row.target))) ? success(value) : failure(502);
  } catch (error) { return caughtFailure(error); }
}

export async function POST(request: Request, context: Context) {
  const { path } = await context.params;
  if (path.length !== 1 || !["preview", "versions", "runs"].includes(path[0]!)) return failure(404);
  if ([...new URL(request.url).searchParams].length) return failure(400);
  if (!isSameOriginRequest(request)) return failure(403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return failure(415);
  let input: FinanceCostAllocationPreviewInput | FinanceCostAllocationVersionInput | CalculateFinanceAllocatedProfitInput;
  try {
    const raw = await boundedJson(request, MAX_REQUEST_BYTES);
    input = path[0] === "preview" ? FinanceCostAllocationPreviewInputSchema.parse(raw)
      : path[0] === "versions" ? FinanceCostAllocationVersionInputSchema.parse(raw) : CalculateFinanceAllocatedProfitInputSchema.parse(raw);
  } catch (error) { return failure(error instanceof BodyTooLarge ? 413 : 400); }
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/finance/cost-allocations/${path[0]}`, {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      signal: path[0] === "preview" ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) return upstreamFailure(response);
    const status = path[0] === "preview" ? 200 : 201;
    if (response.status !== status) { await response.body?.cancel(); return failure(502); }
    const raw = await boundedJson(response, MAX_RESPONSE_BYTES);
    if (path[0] === "preview") {
      const original = FinanceCostAllocationPreviewInputSchema.parse(input), value = FinanceCostAllocationPreviewViewSchema.parse(raw);
      return validPreview(value) && matchesPreview(original, value) ? success(value, status) : failure(502);
    }
    if (path[0] === "versions") {
      const original = FinanceCostAllocationVersionInputSchema.parse(input), value = FinanceCostAllocationVersionViewSchema.parse(raw);
      const { previewChecksum, idempotencyKey, ...previewInput } = original; void idempotencyKey;
      if (!validVersion(value) || !matchesPreview(previewInput, value.preview) || value.preview.previewChecksum !== previewChecksum) return failure(502);
      if (original.allocationId === null ? value.allocationId !== value.id || value.versionNumber !== 1 || value.previousVersionId !== null
        : value.allocationId !== original.allocationId || value.versionNumber !== original.expectedVersion! + 1 || value.previousVersionId === null || value.previousVersionId === value.id) return failure(502);
      return success(value, status);
    }
    const original = CalculateFinanceAllocatedProfitInputSchema.parse(input), value = FinanceAllocatedProfitRunViewSchema.parse(raw);
    return validRun(value) && value.baseRunId === original.baseRunId && value.baseInputChecksum === original.baseInputChecksum
      && value.dimension === original.dimension && canonicalJson([...original.versionIds].sort()) === canonicalJson(value.versionPins.map(pin => pin.id).sort()) ? success(value, status) : failure(502);
  } catch (error) { return caughtFailure(error); }
}

function readPlan(request: Request, path: string[]): ReadPlan | Response {
  let kind: ReadPlan["kind"];
  if (path.length === 2 && path[0] === "bases") kind = "base";
  else if (path.length === 3 && path[0] === "bases" && path[2] === "sources") kind = "sources";
  else if (path.length === 1 && path[0] === "targets") kind = "targets";
  else if (path.length === 1 && path[0] === "versions") kind = "versions";
  else if (path.length === 1 && path[0] === "runs") kind = "runs";
  else if (path.length === 2 && path[0] === "versions") kind = "version";
  else if (path.length === 2 && path[0] === "runs") kind = "run";
  else if (path.length === 3 && path[0] === "runs" && path[2] === "slices") kind = "slices";
  else return failure(404);
  let id: string | null = null;
  if (path.length > 1) { const parsed = Id.safeParse(path[1]); if (!parsed.success) return failure(400); id = parsed.data; }
  const allowed = kind === "sources" ? ["dimension", "limit", "cursor"] : kind === "targets" ? ["dimension", "key", "limit", "cursor"]
    : kind === "versions" || kind === "runs" ? ["baseRunId", "allocationId", "limit", "cursor"] : kind === "slices" ? ["limit", "cursor"] : [];
  const params = new URL(request.url).searchParams, seen = new Set<string>();
  for (const [key] of params) { if (!allowed.includes(key) || seen.has(key)) return failure(400); seen.add(key); }
  const raw = Object.fromEntries(params);
  if (kind === "base" || kind === "version" || kind === "run") return { kind, id: id! };
  if (kind === "sources") {
    const input = FinanceCostAllocationSourceListInputSchema.safeParse({ ...raw, baseRunId: id! });
    return input.success ? { kind, id: id!, input: input.data } : failure(400);
  }
  if (kind === "targets") {
    const input = FinanceCostAllocationTargetListInputSchema.safeParse(raw);
    return input.success ? { kind, input: { ...input.data, ...(input.data.key && input.data.dimension !== "period" ? { key: input.data.key.toLowerCase() } : {}) } } : failure(400);
  }
  const input = FinanceCostAllocationListInputSchema.safeParse(raw); if (!input.success) return failure(400);
  return kind === "slices" ? { kind, id: id!, input: input.data } : { kind, input: input.data };
}

function validTarget(target: FinanceCostAllocationTarget) { return target.basisChecksum === hash(financeCostTargetBasisIdentity(target)); }
function validPreview(preview: FinanceCostAllocationPreview) {
  return preview.previewChecksum === hash(financeCostPreviewChecksumIdentity(preview)) && preview.sources.every(source => source.shares.every(share => validTarget(share.target)));
}
function validVersion(version: FinanceCostAllocationVersion) { return validPreview(version.preview) && version.checksum === hash(financeCostVersionChecksumIdentity(version)); }
function validRun(run: FinanceAllocatedProfitRun) {
  return run.inputChecksum === hash(financeAllocatedProfitInputIdentity(run))
    && new Set(run.versionPins.map(pin => pin.id)).size === run.versionPins.length
    && new Set(run.versionPins.map(pin => pin.allocationId)).size === run.versionPins.length
    && run.breakdowns.every(row => validTarget(row.target));
}
function matchesPreview(input: FinanceCostAllocationPreviewInput, preview: FinanceCostAllocationPreview) {
  const sources = new Map<string, Array<{ key: string; weight: string }>>();
  for (const source of preview.sources) {
    const targets = source.shares.map(share => ({ key: share.target.key, weight: share.weight })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const prior = sources.get(source.rootFactId); if (prior && canonicalJson(prior) !== canonicalJson(targets)) return false;
    sources.set(source.rootFactId, targets);
  }
  const actual: FinanceCostAllocationPreviewInput = { baseRunId: preview.baseRunId, baseInputChecksum: preview.baseInputChecksum,
    allocationId: preview.allocationId, expectedVersion: preview.expectedVersion, dimension: preview.dimension, method: preview.method,
    reasonCode: preview.reasonCode, basisDescription: preview.basisDescription, sources: [...sources].map(([rootFactId, targets]) => ({ rootFactId, targets })) };
  return canonicalJson(normalizeFinanceCostAllocationPreviewInput(input)) === canonicalJson(normalizeFinanceCostAllocationPreviewInput(actual));
}
function hash(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

/** Decode a transport position only. The API owner checks the actual actor/query scope. */
function cursorPosition(raw: string, period: boolean): CursorPosition | null {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(raw)) return null;
  try {
    const bytes = Buffer.from(raw, "base64url"); if (bytes.toString("base64url") !== raw) return null;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "key,scope,upperKey,v" || item.v !== 1 || typeof item.scope !== "string" || !/^[a-f0-9]{64}$/.test(item.scope)
      || typeof item.upperKey !== "string" || typeof item.key !== "string" || item.key > item.upperKey || !validPageKey(item.key, period) || !validPageKey(item.upperKey, period)) return null;
    const position: CursorPosition = { v: 1, scope: item.scope, upperKey: item.upperKey, key: item.key };
    return text === JSON.stringify(position) ? position : null;
  } catch { return null; }
}
function validPageKey(key: string, period: boolean) {
  return period ? FinanceCostAllocationTargetListInputSchema.safeParse({ dimension: "period", key }).success : key === key.toLowerCase() && Id.safeParse(key).success;
}
function validPage<T>(page: Page<T>, input: { limit: number; cursor?: string }, position: CursorPosition | null, keyOf: (item: T) => string, period = false) {
  const keys = page.items.map(keyOf);
  if (page.limit !== input.limit || keys.some(key => !validPageKey(key, period)) || keys.some((key, index) => index > 0 && key >= keys[index - 1]!)
    || page.upperBoundKey !== null && !validPageKey(page.upperBoundKey, period) || page.hasMore !== (page.nextCursor !== null)) return false;
  if (position ? page.upperBoundKey !== position.upperKey || keys.some(key => key >= position.key || key > position.upperKey)
    : page.upperBoundKey !== (keys[0] ?? null)) return false;
  if (page.nextCursor) {
    const next = cursorPosition(page.nextCursor, period);
    if (!next || next.upperKey !== page.upperBoundKey || next.key !== keys.at(-1) || page.nextCursor === input.cursor || position && next.scope !== position.scope) return false;
  }
  return true;
}

class BodyTooLarge extends Error {}
async function boundedJson(source: Pick<Request, "headers" | "body">, maximum: number): Promise<unknown> {
  const size = source.headers.get("content-length");
  if (size && /^(?:0|[1-9][0-9]*)$/.test(size) && BigInt(size) > BigInt(maximum)) { await source.body?.cancel(); throw new BodyTooLarge(); }
  const reader = source.body?.getReader(); if (!reader) throw new Error("empty_json");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > maximum) { await reader.cancel(); throw new BodyTooLarge(); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))) as unknown;
}
async function upstreamFailure(response: Response) {
  let code: string | undefined;
  try { const value = await boundedJson(response, 65_536); if (value && typeof value === "object" && "code" in value && typeof value.code === "string" && Object.hasOwn(errorMessages, value.code)) code = value.code; }
  catch { /* Error bodies, including unknown messages, never cross the BFF. */ }
  return failure([400, 401, 403, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 502, code);
}
function caughtFailure(error: unknown) { return error instanceof PersonalSessionError ? failure(error.status, error.code === "authority_changed" ? error.code : undefined) : failure(502); }
function success(value: unknown, status = 200) { return Response.json(value, { status, headers: privateHeaders }); }
const errorMessages: Record<string, string> = {
  authority_changed: "当前权限或资料范围已变化 请核对原请求结果",
  finance_cost_allocation_request_mismatch: "原请求键已绑定另一份提交 请核对原结果",
  finance_cost_allocation_preview_changed: "原费用或目标已变化 请重新预览并明确批准",
  finance_cost_allocation_base_changed: "原汇总计算摘要已变化 请重新核对",
  finance_cost_allocation_base_incomplete: "原汇总计算依据尚未完整核对",
  finance_cost_allocation_base_not_aggregate: "请选择原完整汇总维度计算",
  finance_cost_allocation_version_changed: "原分摊版本已变化 请读取当前版本",
  finance_cost_allocation_version_overlap: "所选版本重复覆盖原费用 请重新核对",
  finance_cost_allocation_version_mismatch: "分摊版本与原计算或维度不一致",
  finance_cost_allocation_target_changed: "真实目标关系已变化 请重新核对",
  finance_cost_allocation_correction_chain_changed: "原费用纠错链已变化 请重新核对",
  finance_cost_allocation_already_attributed: "原费用已有本维度归属 不能重复分摊",
  finance_cost_allocation_not_cost: "只能选择原口径中的真实费用",
  finance_cost_allocation_source_unavailable: "原来源依据暂时无法核对",
  finance_cost_allocation_scope_too_large: "本次范围过大 请明确缩小原费用与目标范围",
  finance_cost_allocation_cursor_invalid: "分页位置与读取范围不一致 请重新读取首页",
  finance_cost_allocation_input_invalid: "填写或读取条件无效 请核对原文",
  finance_cost_allocation_not_found: "原分摊记录或来源当前不可访问",
};
function failure(status: number, code?: string) {
  const messages: Record<number, string> = { 400: "费用分摊条件、编号或游标无效 请核对", 401: "本人会话已失效 请重新登录 ERP", 403: "当前本人没有此财务操作权限", 404: "原分摊记录或来源当前不可访问", 409: "原依据或版本已变化 请核对原提交结果", 413: "原填写超过允许大小 请缩小明确范围", 415: "请使用同源 JSON 提交", 422: "分摊填写未通过精确核对 请核对原文", 429: "读取或提交过于频繁 请稍后重试", 503: "财务服务暂不可用 请保留原请求" };
  return Response.json({ code: code ?? (status >= 500 ? "finance_cost_allocation_result_unconfirmed" : "finance_cost_allocation_request_rejected"), message: code && errorMessages[code] ? errorMessages[code] : messages[status] ?? "本次结果暂无法核对 请保留原请求" }, { status, headers: privateHeaders });
}
