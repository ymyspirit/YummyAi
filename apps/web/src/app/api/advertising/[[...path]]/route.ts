import { createHash } from "node:crypto";
import {AdHistoryQuerySchema,AdHistoryRecordQuerySchema,AdHistoryPageSchema,AdHistoryRecordResultSchema} from "@yummyai/contracts/advertising/history";
import {
  AdImportInputSchema, AdCommitImportSchema, AdSaveGoalInputSchema,
  AdObservationInputSchema, AdAnalysisInputSchema, AdActionEventInputSchema,
  AdFactQuerySchema, AdArchiveInputSchema, AdExportInputSchema,
  AdWorkspaceQuerySchema, AdEmptyQuerySchema, AdvertisingWorkspaceSchema,
  AdFactPageSchema, AdImportPreviewSchema, AdCommitImportResultSchema,
  AdGoalVersionSchema, AdObservationSchema, AdAnalysisRunSchema,
  AdActionViewSchema, AdImportViewSchema, AdExportViewSchema,
  type AdFileMeasurement, type AdImportInput, type AdMetricColumnSelection,
} from "@yummyai/contracts/advertising";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";

export const dynamic = "force-dynamic";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const reads = new RegExp(`^(workspace|facts|history|records/${uuid}|imports/${uuid}/source|exports/${uuid}(?:/csv)?)$`);
const writes = new RegExp(`^(imports(?:/preview|/${uuid}/archive)?|goals|observations|analyses|actions/${uuid}/events|exports)$`);
const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
type Context = { params: Promise<{ path?: string[] }> };

function measurementBinding(measurement: AdFileMeasurement | undefined, input: AdImportInput, columns?: AdMetricColumnSelection) {
  if (input.conversionDefinition || columns) bind(Boolean(measurement));
  if (!measurement) return;
  if (input.conversionDefinition) bind(measurement.conversion.model === input.conversionDefinition.model
    && measurement.conversion.source === (input.conversionDefinition.source.length >= 3 ? input.conversionDefinition.source : null));
  if (columns) for (const [key, value] of Object.entries(columns))
    bind(measurement.columns[key as keyof AdMetricColumnSelection] === value);
  if (measurement.conversion.state === "resolved")
    bind(Boolean(input.conversionDefinition) && measurement.conversion.model === input.conversionDefinition?.model
      && measurement.conversion.source === input.conversionDefinition?.source
      && (input.attributionWindowDays === null || measurement.conversion.windowDays === input.attributionWindowDays));
}

async function bytes(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new SyntaxError("Missing response body");
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new RangeError("Advertising body exceeds byte limit");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
const decode = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const jsonBody = async (stream: ReadableStream<Uint8Array> | null, limit: number) => JSON.parse(decode(await bytes(stream, limit))) as unknown;
const bind = (valid: boolean) => { if (!valid) throw new Error("Advertising response binding failed"); };
const sameScope = (a: { accountId: string; marketplace: string; currency: string; asin: string }, b: typeof a) =>
  a.accountId === b.accountId && a.marketplace === b.marketplace && a.currency === b.currency && a.asin === b.asin;

function writeSchema(path: string) {
  return path === "imports/preview" ? AdImportInputSchema
    : path === "imports" ? AdCommitImportSchema
    : path === "goals" ? AdSaveGoalInputSchema
    : path === "observations" ? AdObservationInputSchema
    : path === "analyses" ? AdAnalysisInputSchema
    : path === "exports" ? AdExportInputSchema
    : path.startsWith("actions/") ? AdActionEventInputSchema : AdArchiveInputSchema;
}

function validated(path: string, raw: unknown, input: unknown, query: URLSearchParams) {
  if(path==="history"){
    const result=AdHistoryPageSchema.parse(raw),expected=AdHistoryQuerySchema.parse(Object.fromEntries(query));
    bind(result.accountId===expected.accountId.toLowerCase()&&result.kind===expected.kind&&result.parentId===(expected.parentId?.toLowerCase()??null)
      &&result.pageSize===expected.pageSize&&result.requestCursor===(expected.cursor??null));
    return result;
  }
  if(path.startsWith("records/")){
    const result=AdHistoryRecordResultSchema.parse(raw),expected=AdHistoryRecordQuerySchema.parse(Object.fromEntries(query));
    bind(result.accountId===expected.accountId.toLowerCase()&&result.recordId===path.split("/")[1]&&result.record.kind===expected.kind
      &&result.parentId===(expected.parentId?.toLowerCase()??null));
    return result;
  }
  if (path === "workspace") {
    const result = AdvertisingWorkspaceSchema.parse(raw);
    bind(result.accountId === (query.get("accountId") ?? null));
    return result;
  }
  if (path === "facts") {
    const result = AdFactPageSchema.parse(raw), expected = AdFactQuerySchema.parse(Object.fromEntries(query));
    bind(result.accountId === expected.accountId && result.page === expected.page && result.pageSize === expected.pageSize);
    bind(!expected.reportType || result.rows.every(row => row.fact.reportType === expected.reportType));
    return result;
  }
  if (path === "imports/preview") {
    const result = AdImportPreviewSchema.parse(raw), expected = AdImportInputSchema.parse(input);
    bind(result.files.length === expected.files.length);
    result.files.forEach((file, index) => {
      const source = expected.files[index]!;
      bind(file.fileName === source.fileName && file.checksum === createHash("sha256").update(source.content, "utf8").digest("hex"));
      if (file.acceptedRowCount) measurementBinding(file.measurement, expected, source.metricColumns);
      if (file.measurement) for (const fact of file.sample) {
        bind(Boolean(fact.measurement) && JSON.stringify(fact.measurement?.columns) === JSON.stringify(file.measurement.columns)
          && JSON.stringify(fact.measurement?.conversion) === JSON.stringify(file.measurement.conversion));
        if (fact.measurement?.monetaryBasis) bind(file.measurement.currencies.some(item => JSON.stringify(item) === JSON.stringify(fact.measurement!.monetaryBasis)));
      }
    });
    return result;
  }
  if (path === "imports") {
    const result = AdCommitImportResultSchema.parse(raw), expected = AdCommitImportSchema.parse(input);
    bind(result.imports.length === expected.files.length);
    const sourcePins = new Map<string, number>();
    for (const file of expected.files) {
      const pin = `${file.fileName}:${createHash("sha256").update(file.content, "utf8").digest("hex")}`;
      sourcePins.set(pin, (sourcePins.get(pin) ?? 0) + 1);
    }
    for (const file of result.imports) {
      const pin = `${file.fileName}:${file.checksum}`, remaining = sourcePins.get(pin) ?? 0;
      bind(file.accountId === expected.accountId && remaining > 0);
      const source = expected.files.find(item => `${item.fileName}:${createHash("sha256").update(item.content, "utf8").digest("hex")}` === pin);
      bind(file.timezone === expected.timezone && file.attributionWindowDays === expected.attributionWindowDays
        && file.attributionBasis === expected.attributionBasis && file.observedAt === new Date(expected.observedAt).toISOString()
        && (!source?.reportTypeHint || file.reportType === source.reportTypeHint));
      measurementBinding(file.measurement, expected, source?.metricColumns);
      sourcePins.set(pin, remaining - 1);
    }
    bind([...sourcePins.values()].every(remaining => remaining === 0));
    bind(new Set(result.imports.map(file => file.id)).size === result.imports.length);
    return result;
  }
  if (path === "goals") {
    const result = AdGoalVersionSchema.parse(raw), expected = AdSaveGoalInputSchema.parse(input);
    const { monetaryBasis: actualBasis, ...actualFields } = result.fields;
    const { monetaryBasis: expectedBasis, ...expectedFields } = expected.fields;
    bind(sameScope(result.scope, expected.scope) && result.revision === expected.expectedRevision + 1
      && JSON.stringify(actualFields) === JSON.stringify(expectedFields)
      && (!actualBasis || actualBasis.currency === expected.scope.currency)
      && (!expectedBasis || JSON.stringify(actualBasis) === JSON.stringify(expectedBasis)));
    return result;
  }
  if (path === "observations") {
    const result = AdObservationSchema.parse(raw), expected = AdObservationInputSchema.parse(input);
    const normalized = { ...expected, observedAt: new Date(expected.observedAt).toISOString() };
    const actual = result as unknown as Record<string, unknown>;
    bind(Object.entries(normalized).every(([key, value]) => key === "idempotencyKey" || JSON.stringify(actual[key]) === JSON.stringify(value)));
    bind(!result.monetaryBasis || result.monetaryBasis.currency === expected.scope.currency);
    return result;
  }
  if (path === "analyses") {
    const result = AdAnalysisRunSchema.parse(raw), expected = AdAnalysisInputSchema.parse(input);
    bind(result.accountId === expected.accountId && result.periodStart === expected.periodStart && result.periodEnd === expected.periodEnd
      && result.marketplace === expected.marketplace && result.currency === expected.currency && result.evidenceCutoffAt === new Date(expected.evidenceCutoffAt).toISOString());
    return result;
  }
  if (path.startsWith("actions/")) {
    const result = AdActionViewSchema.parse(raw), expected = AdActionEventInputSchema.parse(input);
    // Idempotent replay returns the current projection. Its immutable event,
    // rather than today's status, proves the already-recorded transition.
    bind(result.id === path.split("/")[1] && result.revision >= expected.expectedRevision + 1
      && result.events.some(event => event.status === expected.status && event.reason === expected.reason));
    if (result.revision === expected.expectedRevision + 1) bind(result.status === expected.status);
    if (expected.status === "executed") bind(result.executedAt === new Date(expected.executedAt!).toISOString()
      && result.actualBeforeMinor === expected.actualBeforeMinor && result.actualAfterMinor === expected.actualAfterMinor
      && result.execution?.campaignId === expected.executionCampaignId && result.execution.adGroupId === expected.executionAdGroupId
      && result.execution.targetId === expected.executionTargetId);
    return result;
  }
  if (path.endsWith("/archive")) {
    const result = AdImportViewSchema.parse(raw); bind(result.id === path.split("/")[1] && result.archivedAt !== null); return result;
  }
  const result = AdExportViewSchema.parse(raw);
  if (path === "exports") {
    const expected = AdExportInputSchema.parse(input);
    bind(result.runId === expected.runId && result.payload.run.id === expected.runId);
    bind(result.payload.actions.length === expected.actionIds.length && new Set(result.payload.actions.map(action => action.id)).size === expected.actionIds.length
      && result.payload.actions.every(action => expected.actionIds.includes(action.id)));
  } else bind(result.id === path.split("/")[1]);
  return result;
}

async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const path = ((await context.params).path ?? []).join("/");
  if (!(method === "GET" ? reads : writes).test(path)) return failure(404);
  if (method === "POST" && !isSameOriginRequest(request)) return failure(403);
  if (method === "POST" && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure(400);
  const query = new URLSearchParams();
  let input: unknown;
  try {
    const search = new URL(request.url).searchParams, keys = [...search.keys()];
    if (new Set(keys).size !== keys.length) return failure(400);
    const schema = method === "GET" && path === "facts" ? AdFactQuerySchema
      : method === "GET" && path === "workspace" ? AdWorkspaceQuerySchema
      : method === "GET" && path === "history" ? AdHistoryQuerySchema
      : method === "GET" && path.startsWith("records/") ? AdHistoryRecordQuerySchema : AdEmptyQuerySchema;
    for (const [key, value] of Object.entries(schema.parse(Object.fromEntries(search)))) query.set(key, String(value));
    if (method === "POST") input = writeSchema(path).parse(await jsonBody(request.body, 24 * 1024 * 1024));
  } catch (error) { return failure(error instanceof RangeError ? 413 : 400); }
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  try {
    const suffix = query.size ? `?${query}` : "";
    const response = await apiFetch(`${base}/v1/advertising/${path}${suffix}`, {
      method, redirect: "error", cache: "no-store",
      ...(input === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
      signal: method === "POST" ? AbortSignal.timeout(120_000) : AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      let authorityChanged = false;
      if (response.status === 409) {
        const error = await jsonBody(response.body, 8192).catch(() => null);
        authorityChanged = Boolean(error && typeof error === "object" && "code" in error && error.code === "authority_changed");
      } else await response.body?.cancel().catch(() => undefined);
      return failure([400, 401, 403, 404, 409, 413, 422, 429, 503].includes(response.status) ? response.status : 502,
        authorityChanged ? "authority_changed" : undefined);
    }
    bind(response.status === (method === "POST" ? 201 : 200));
    const source = path.startsWith("imports/") && path.endsWith("/source"), csv = path.endsWith("/csv");
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (source || csv) {
      bind(mediaType === "text/csv");
      const body = await bytes(response.body, source ? 5 * 1024 * 1024 : 32 * 1024 * 1024);
      decode(body);
      return new Response(body, { headers: { ...privateHeaders, "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="advertising-${source ? "source" : "review"}-${path.split("/")[1]}.csv"` } });
    }
    bind(mediaType === "application/json");
    const result = validated(path, await jsonBody(response.body, 32 * 1024 * 1024), input, query);
    const headers = { ...privateHeaders, ...(method === "GET" && path.startsWith("exports/")
      ? { "content-disposition": `attachment; filename="advertising-review-${path.split("/")[1]}.json"` } : {}) };
    return Response.json(result, { status: response.status, headers });
  } catch { return failure(502); }
}
function failure(status: number, code?: "authority_changed") {
  const messages: Record<number, string> = { 400: "广告字段或读取范围无效 请核查后重试", 401: "身份会话已失效 请重新登录",
    403: "当前成员不能执行这项广告操作", 404: "广告资料不存在或不可访问", 409: "广告内容或状态已变化 请刷新核对",
    413: "广告内容超过读取上限", 422: "广告来源或业务检查未通过 请核对原报告", 429: "广告操作过于频繁 请稍后重试",
    502: "广告响应未通过校验 请重试原操作", 503: "广告服务暂不可用 请稍后重试" };
  return Response.json({ message: messages[status], ...(code ? { code } : {}) }, { status, headers: privateHeaders });
}
export const GET = (request: Request, context: Context) => proxy(request, context, "GET");
export const POST = (request: Request, context: Context) => proxy(request, context, "POST");
