import { createHash } from "node:crypto";
import { z } from "zod";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { authorize } from "@yummyai/authz/authorize";
import { Permission } from "@yummyai/authz/permissions";
import {
  KnowledgeEvaluationReportSchema,
  KnowledgeConversationSchema,
  KnowledgeSavedRecordSchema,
  ArchiveKnowledgeEvaluationSchema,
  ReviewKnowledgeEvaluationSchema,
  SaveKnowledgeEvaluationSchema,
  StartKnowledgeEvaluationSchema,
  type KnowledgeEvaluationReport,
} from "@yummyai/contracts/knowledge/governance";
import {
  KnowledgeEvaluationComparisonQuerySchema,
  KnowledgeEvaluationComparisonSchema,
  KnowledgeEvaluationRunPageQuerySchema,
  KnowledgeEvaluationRunPageSchema,
} from "@yummyai/contracts/knowledge/evaluation-read";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";
import { assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity } from "../../../../erp-auth/server";
import { PersonalSessionError } from "../../../../identity/core";
import { benchmarkProxy } from "../benchmark-proxy";
export const dynamic = "force-dynamic";
const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const getPath = new RegExp(
  `^(workspace|conversations|documents/${id}|source-reviews/${id}|evaluations/${id}/runs|evaluation-runs/${id}|${id}/history)$`,
  "i",
);
const postPath = new RegExp(
  `^(documents/upload|documents/${id}/(original|confirm|purge|archive)|candidates/${id}/decide|sources/create|sources/${id}/(check|control|archive)|source-reviews/${id}/review|needs/create|needs/${id}/(save|archive)|conflicts/${id}/resolve|evaluations/create|evaluations/${id}/(save|archive|start)|evaluation-runs/${id}/review)$`,
  "i",
);
const evaluationPath = new RegExp(`^(evaluations/create|evaluations/${id}/(save|archive|start|runs|run-page)|evaluation-runs/${id}(/review)?|evaluation-comparisons)$`, "i");
const EvaluationId = z.uuidv7().transform(value => value.toLowerCase());
const EmptyQuery = z.object({}).strict();
const EvaluationReport = KnowledgeEvaluationReportSchema.strict();
const EvaluationPage = KnowledgeEvaluationRunPageSchema.safeExtend({ items: z.array(EvaluationReport).max(20) });
const EvaluationComparison = KnowledgeEvaluationComparisonSchema.safeExtend({ baseline: EvaluationReport, candidate: EvaluationReport });
const evaluationHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
type EvaluationRoute = { name: "create" | "save" | "archive" | "start" | "runs" | "page" | "report" | "review" | "comparison"; id: string | null };
class EvaluationPayloadLimit extends Error {}
type Context = { params: Promise<{ path: string[] }> };
export async function GET(r: Request, c: Context) {
  return proxy(r, c, "GET");
}
export async function POST(r: Request, c: Context) {
  return proxy(r, c, "POST");
}
async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const segments = (await context.params).path;
  if (segments[0] === "benchmarks") return benchmarkProxy(request, segments.slice(1), method);
  const path = segments.join("/");
  if (evaluationPath.test(path)) {
    const route = evaluationRoute(segments, method);
    return route ? evaluationProxy(request, route, method) : evaluationFailure(404);
  }
  if (!(method === "GET" ? getPath : postPath).test(path)) return failure(404, "知识入口不存在");
  if (method === "GET" && path === "conversations" && request.headers.has("x-yummyai-context-authority"))
    return personalConversations(request);
  if (
    method === "POST" &&
    (!isSameOriginRequest(request) ||
      !request.headers.get("content-type")?.startsWith("application/json"))
  )
    return failure(403, "请求来源或格式不正确");
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503, "知识服务暂时不可用");
  let body: string | undefined;
  if (method === "POST") {
    const reader = request.body?.getReader();
    if (!reader) return failure(400, "缺少填写内容");
    let length = 0;
    const chunks: Uint8Array[] = [];
    const limit = path === "documents/upload" ? 7_400_000 : 1_000_000;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) {
        await reader.cancel();
        return failure(413, "资料超过大小限制");
      }
      chunks.push(next.value);
    }
    body = Buffer.concat(chunks).toString("utf8");
    try {
      JSON.parse(body);
    } catch {
      return failure(400, "填写内容格式不正确");
    }
  }
  try {
    const response = await apiFetch(base + "/v1/knowledge-governance/" + path, {
      method,
      body,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      signal:
        method === "GET"
          ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(path === "documents/upload" ? 60_000 : 30_000),
    });
    if (!response.ok) {
      const data = [400, 409].includes(response.status)
        ? await response.json().catch(() => null)
        : null;
      return failure(
        response.status,
        typeof data?.message === "string"
          ? data.message.slice(0, 500)
          : response.status === 403
            ? "当前账号没有此操作权限"
            : response.status === 401
              ? "登录已失效，请重新登录"
              : "知识服务暂时不可用，请重试",
      );
    }
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return failure(502, "请求未完成；请刷新记录核对结果后再重试");
  }
}
async function personalConversations(request: Request) {
  if (new URL(request.url).searchParams.size) return conversationFailure(400);
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    if (request.headers.get("x-yummyai-context-authority") !== authority) throw new PersonalSessionError(409, "authority_changed");
    try { authorize(identity.view, Permission.WorkflowRead); } catch { return conversationFailure(403); }
    const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return conversationFailure(503);
    const response = await apiFetch(`${base}/v1/knowledge-governance/conversations`, { cache: "no-store", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) {
      const raw = response.status === 409 ? await evaluationJson(response, 8192, true).catch(() => null) : null;
      if (!response.bodyUsed) await response.body?.cancel();
      await assertErpIdentityCurrent(identity);
      return conversationFailure([400, 401, 403, 404, 409, 422, 503].includes(response.status) ? response.status : 502,
        response.status === 409 && raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : undefined);
    }
    if (response.status !== 200) { await response.body?.cancel(); return conversationFailure(502); }
    const value = KnowledgeConversationSchema.strict().array().max(20).parse(await evaluationJson(response, 8 * 1024 * 1024, true));
    if (new Set(value.map(item => item.scopeId)).size !== value.length) return conversationFailure(502);
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { headers: { ...evaluationHeaders, "x-yummyai-context-authority": authority } });
  } catch (cause) { return cause instanceof PersonalSessionError ? erpAuthFailure(cause, request) : conversationFailure(502); }
}
function conversationFailure(status: number, code?: "authority_changed") {
  return Response.json({ message: code ? "当前身份或知识权限范围已变化 请重新核对本人权限" : status === 401 ? "请登录自己的运营账户" :
    status === 403 || status === 404 ? "当前无法读取原知识对话" : status === 400 ? "知识对话查询格式不正确" : "知识对话暂时无法核对 请重新读取原记录", ...(code ? { code } : {}) }, { status, headers: evaluationHeaders });
}
function evaluationRoute(path: string[], method: "GET" | "POST"): EvaluationRoute | null {
  if (method === "GET" && path.length === 1 && path[0] === "evaluation-comparisons") return { name: "comparison", id: null };
  if (method === "POST" && path.length === 2 && path[0] === "evaluations" && path[1] === "create") return { name: "create", id: null };
  const parsed = EvaluationId.safeParse(path[1]);
  if (!parsed.success) return null;
  if (path[0] === "evaluations" && path.length === 3) {
    if (method === "POST" && path[2] === "save") return { name: "save", id: parsed.data };
    if (method === "POST" && path[2] === "archive") return { name: "archive", id: parsed.data };
    if (method === "POST" && path[2] === "start") return { name: "start", id: parsed.data };
    if (method === "GET" && path[2] === "runs") return { name: "runs", id: parsed.data };
    if (method === "GET" && path[2] === "run-page") return { name: "page", id: parsed.data };
  }
  if (path[0] === "evaluation-runs") {
    if (method === "GET" && path.length === 2) return { name: "report", id: parsed.data };
    if (method === "POST" && path.length === 3 && path[2] === "review") return { name: "review", id: parsed.data };
  }
  return null;
}
async function evaluationJson(response: Response, maximum: number, strictUtf8 = false): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_evaluation_payload");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new EvaluationPayloadLimit(); }
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks);
    return JSON.parse(strictUtf8 ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.toString("utf8"));
  } finally { reader.releaseLock(); }
}
async function evaluationProxy(request: Request, route: EvaluationRoute, method: "GET" | "POST") {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return evaluationFailure(400);
  const rawQuery = Object.fromEntries(params);
  const page = route.name === "page" ? KnowledgeEvaluationRunPageQuerySchema.safeParse(rawQuery) : null;
  const comparison = route.name === "comparison" ? KnowledgeEvaluationComparisonQuerySchema.safeParse(rawQuery) : null;
  if (route.name === "page" ? !page?.success : route.name === "comparison" ? !comparison?.success : !EmptyQuery.safeParse(rawQuery).success)
    return evaluationFailure(400);
  let input: unknown;
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return evaluationFailure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return evaluationFailure(415);
    try {
      const raw = await evaluationJson(new Response(request.body), 1_000_000);
      input = route.name === "create" || route.name === "save" ? SaveKnowledgeEvaluationSchema.parse(raw)
        : route.name === "archive" ? ArchiveKnowledgeEvaluationSchema.parse(raw)
          : route.name === "start" ? StartKnowledgeEvaluationSchema.parse(raw) : ReviewKnowledgeEvaluationSchema.parse(raw);
    } catch (error) { return evaluationFailure(error instanceof EvaluationPayloadLimit ? 413 : 400); }
  }
  try {
    const identity = await erpRequestIdentity(request), authority = erpSessionAuthority(identity.view);
    const permission = (bit: string) => identity.view.permissions.includes(bit) &&
      (identity.view.permissionScopes === undefined || identity.view.permissionScopes[bit] !== undefined);
    if (!permission("workflow:read") || route.name === "start" && (!permission("workflow:run") || !permission("workflow:manage")) ||
      ["create", "save", "archive"].includes(route.name) && !permission("workflow:manage") ||
      route.name === "review" && !permission("workflow:approve")) return evaluationFailure(403);
    const clientAuthority = request.headers.get("x-yummyai-context-authority");
    if (clientAuthority !== null && clientAuthority !== authority) return evaluationFailure(409, "authority_changed");
    const base = process.env.API_BASE_URL?.replace(/\/$/, "");
    if (!base) return evaluationFailure(503);
    let path = route.name === "comparison" ? "evaluation-comparisons" : route.name === "create" ? "evaluations/create"
      : route.name === "report" || route.name === "review" ? `evaluation-runs/${route.id}${route.name === "review" ? "/review" : ""}`
        : `evaluations/${route.id}/${route.name === "page" ? "run-page" : route.name}`;
    if (page?.success) path += "?" + new URLSearchParams({ limit: String(page.data.limit), ...(page.data.cursor ? { cursor: page.data.cursor.toLowerCase() } : {}) });
    if (comparison?.success) path += "?" + new URLSearchParams({ baselineRunId: comparison.data.baselineRunId.toLowerCase(), candidateRunId: comparison.data.candidateRunId.toLowerCase() });
    const response = await apiFetch(`${base}/v1/knowledge-governance/${path}`, {
      method, cache: "no-store", redirect: "error",
      signal: method === "GET" ? AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      ...(method === "POST" ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}),
    });
    await assertErpIdentityCurrent(identity);
    if (!response.ok) {
      const raw = response.status === 409 ? await evaluationJson(response, 8_192).catch(() => null) : null;
      if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      await assertErpIdentityCurrent(identity);
      if (raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed") return evaluationFailure(409, "authority_changed");
      return evaluationFailure([400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(response.status) ? response.status : 502);
    }
    if (response.status !== (method === "GET" ? 200 : 201)) {
      await response.body?.cancel().catch(() => {});
      return evaluationFailure(502);
    }
    const raw = await evaluationJson(response, 16 * 1024 * 1024);
    let value: unknown;
    if (route.name === "report") {
      const report = EvaluationReport.parse(raw);
      if (report.id !== route.id || !validEvaluationReport(report, identity.view)) return evaluationFailure(502);
      value = report;
    } else if (route.name === "runs") {
      const rows = z.array(EvaluationReport).max(20).parse(raw);
      if (!validEvaluationPage(rows, route.id!, identity.view)) return evaluationFailure(502);
      value = rows;
    } else if (route.name === "page" && page?.success) {
      const result = EvaluationPage.parse(raw);
      if (result.items.length > page.data.limit || !validEvaluationPage(result.items, route.id!, identity.view, page.data.cursor?.toLowerCase()) ||
        result.nextCursor !== null && (result.items.length !== page.data.limit || result.nextCursor !== result.items.at(-1)?.id)) return evaluationFailure(502);
      value = result;
    } else if (route.name === "comparison" && comparison?.success) {
      const result = EvaluationComparison.parse(raw);
      if (result.baseline.id !== comparison.data.baselineRunId.toLowerCase() || result.candidate.id !== comparison.data.candidateRunId.toLowerCase() ||
        !validEvaluationReport(result.baseline, identity.view) || !validEvaluationReport(result.candidate, identity.view)) return evaluationFailure(502);
      value = result;
    } else {
      const result = KnowledgeSavedRecordSchema.strict().parse(raw);
      if (["save", "archive", "review"].includes(route.name) && result.id !== route.id) return evaluationFailure(502);
      value = result;
    }
    await assertErpIdentityCurrent(identity);
    return Response.json(value, { status: response.status, headers: { ...evaluationHeaders, "x-yummyai-context-authority": authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) {
      const response = erpAuthFailure(error, request);
      Object.entries(evaluationHeaders).forEach(([key, value]) => response.headers.set(key, value));
      return response;
    }
    return evaluationFailure(502);
  }
}
function validEvaluationPage(rows: KnowledgeEvaluationReport[], caseId: string, session: ErpSessionView, cursor?: string) {
  return new Set(rows.map(row => row.id)).size === rows.length && rows.every((row, index) => row.caseId === caseId &&
    (cursor === undefined || row.id < cursor) && (index === 0 || rows[index - 1]!.id > row.id) && validEvaluationReport(row, session));
}
function validEvaluationReport(row: KnowledgeEvaluationReport, session: ErpSessionView) {
  const protocol = row.protocol, assessment = row.assessment, request = row.answer.request;
  if (row.answer.kind !== "knowledge_answer" || row.answer.scope !== `knowledge:${row.caseId}` || request &&
    (request.kind !== "knowledge_answer" || request.scopeId !== row.caseId || request.purpose !== "evaluation")) return false;
  if (protocol) {
    const rank = { self: 0, team: 1, tenant: 2 };
    const bits = ["workflow:read", ...(row.caseSnapshot.search.spuIds.length ? ["product:read"] : [])];
    if (bits.some(bit => {
      const scope = session.permissionScopes === undefined ? session.dataScope : session.permissionScopes[bit];
      return !session.permissions.includes(bit) || scope === undefined || rank[scope] < rank[protocol.dataScope];
    })) return false;
    if (protocol.runId !== row.id || protocol.inputFingerprint !== row.answer.inputFingerprint || protocol.promptVersion !== row.answer.promptVersion ||
      protocol.assertionVersion !== row.assertionVersion || protocol.caseChecksum !== createHash("sha256").update(canonicalJson(row.caseSnapshot)).digest("hex") ||
      request && request.modelId !== protocol.modelId || row.answer.accessPolicy && row.answer.accessPolicy.dataScope !== protocol.dataScope) return false;
  }
  if (assessment && (!protocol || assessment.runId !== row.id || assessment.basisFingerprint !== protocol.basisFingerprint ||
    assessment.assertionVersion !== row.assertionVersion || canonicalJson(assessment.checks) !== canonicalJson(row.checks) ||
    assessment.retrievalRecall !== row.retrievalRecall || assessment.citedRecall !== row.citedRecall)) return false;
  if (row.assessmentState === "recorded" && !assessment || assessment && row.assessmentState !== "recorded") return false;
  return true;
}
function evaluationFailure(status: number, code?: "authority_changed") {
  const message = code ? "当前身份或权限范围已变化 请重新核对原评测"
    : status === 401 ? "请登录自己的运营账户" : status === 403 ? "当前账户没有此评测权限" : status === 404 ? "原评测当前不可访问"
      : status === 409 ? "原请求或评测依据已变化 请核对原回执" : [400, 413, 415, 422].includes(status) ? "请核对评测字段与原请求"
        : "评测结果暂时无法确认 请保留原请求编号并重新读取记录";
  return Response.json({ message, ...(code ? { code } : {}) }, { status, headers: evaluationHeaders });
}
function failure(status: number, message: string) {
  return Response.json({ message }, { status, headers: { "cache-control": "private, no-store" } });
}
