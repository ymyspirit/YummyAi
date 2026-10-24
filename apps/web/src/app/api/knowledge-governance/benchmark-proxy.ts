import { createHash } from "node:crypto";
import { z } from "zod";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { authorize, permissionScope } from "@yummyai/authz/authorize";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { assertBusinessBenchmarkScope, benchmarkDomainMinimumScope } from "@yummyai/authz/business-benchmark-policy";
import { Permission } from "@yummyai/authz/permissions";
import {
  BenchmarkAttemptPageQuerySchema, BenchmarkAttemptPageSchema, BenchmarkAttemptSchema,
  BenchmarkCommandReceiptSchema, BenchmarkCostSummarySchema, BenchmarkDatasetPageSchema,
  BenchmarkDatasetSchema, BenchmarkExperimentPageSchema, BenchmarkExperimentSchema,
  BenchmarkPageQuerySchema, BenchmarkReceiptSchema, BenchmarkReportPageSchema,
  BenchmarkReportSchema, BenchmarkVersionPageSchema, BenchmarkVersionSchema,
  BenchmarkDatasetFieldsSchema, BusinessBenchmarkTargetQuerySchema, BusinessBenchmarkBasisRequestSchema, BusinessBenchmarkCaseSchema, benchmarkCaseHasProducts,
  CreateBenchmarkExperimentSchema, CreateBenchmarkReportSchema, PublishBenchmarkDatasetSchema,
  RecordBenchmarkExpenseSchema, ReviewBenchmarkAttemptSchema, SaveBenchmarkDatasetSchema,
  StartBenchmarkAttemptSchema, benchmarkCommandCanonical,
  type BenchmarkAttempt, type BenchmarkCostSummary, type BenchmarkOperation, type BenchmarkReport, type BusinessBenchmarkCase, type BenchmarkResourceBindings,
} from "@yummyai/contracts/knowledge/benchmark";
import { AssistTaskTargetsSchema, AssistTaskBasisSchema } from "@yummyai/contracts/ai/task-workspace";
import { apiFetch } from "../../../server-api";
import { isSameOriginRequest } from "../../../same-origin-request";
import {
  assertErpIdentityCurrent, erpAuthFailure, erpRequestIdentity, type ErpRequestIdentity,
} from "../../../erp-auth/server";
import { PersonalSessionError } from "../../../identity/core";

const EntityId = z.uuidv7().transform(value => value.toLowerCase());
const RequestId = z.uuid().transform(value => value.toLowerCase());
const EmptyQuery = z.object({}).strict();
const maximumBytes = 8 * 1024 * 1024;
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
type ReadName = "datasets" | "dataset" | "versions" | "version" | "experiments" | "experiment"
  | "attempts" | "attempt" | "costs" | "reports" | "report" | "request" | "taskTargets" | "taskBasis";
type CommandInput = { requestId: string } & Record<string, unknown>;
type Route = { path: string; id: string | null } & (
  { name: ReadName; operation?: undefined; schema?: undefined }
  | { name: "write"; operation: BenchmarkOperation; schema: z.ZodType<CommandInput> }
);
type PageQuery = z.infer<typeof BenchmarkAttemptPageQuerySchema>;
type BusinessRole = z.infer<typeof BusinessBenchmarkTargetQuerySchema>["kind"];
class PayloadLimit extends Error {}
class InvalidPayload extends Error {}

function failure(status: number, code?: "authority_changed") {
  const message = code ? "当前身份或知识评测范围已变化 私有记录已隐藏 请重新核对"
    : status === 401 ? "请登录自己的运营账户"
      : status === 403 ? "当前账户没有此知识评测权限"
        : status === 404 ? "原知识评测记录当前不可访问"
          : status === 409 ? "原请求或评测依据存在冲突 请保留原编号核对 不自动换键"
            : status === 413 ? "完整评测内容超过限制 未截断提交或读取"
              : [400, 412, 415, 422].includes(status) ? "请核对评测字段 当前依据和原请求编号"
                : "评测原请求或结果尚未核对 请保留原编号并重新读取 不自动重做";
  return Response.json({ message, ...(code ? { code } : {}) }, { status, headers });
}

/** This namespace never falls through to the legacy knowledge transport. */
function routeFor(segments: string[], method: "GET" | "POST"): Route | null {
  const [root, rawId, action, leaf] = segments;
  const write = (operation: BenchmarkOperation, schema: z.ZodType<CommandInput>, path: string, id: string | null): Route =>
    ({ name: "write", operation, schema, path, id });
  if (segments.length === 1) {
    if (root === "task-targets" && method === "GET") return { name: "taskTargets", path: root, id: null };
    if (root === "task-basis" && method === "POST") return { name: "taskBasis", path: root, id: null };
    if (root === "datasets") return method === "GET" ? { name: "datasets", path: root, id: null }
      : write("dataset.create", SaveBenchmarkDatasetSchema, root, null);
    if (root === "experiments") return method === "GET" ? { name: "experiments", path: root, id: null }
      : write("experiment.create", CreateBenchmarkExperimentSchema, root, null);
    return null;
  }
  if (root === "requests") {
    const parsed = RequestId.safeParse(rawId);
    return method === "GET" && segments.length === 2 && parsed.success
      ? { name: "request", path: "requests/" + parsed.data, id: parsed.data } : null;
  }
  const parsed = EntityId.safeParse(rawId);
  if (!parsed.success) return null;
  const id = parsed.data, path = root + "/" + id;
  if (segments.length === 2 && method === "GET") {
    const names = { datasets: "dataset", versions: "version", experiments: "experiment", attempts: "attempt", reports: "report" } as const;
    if (root && Object.hasOwn(names, root)) return { name: names[root as keyof typeof names], path, id };
  }
  if (segments.length === 3 && root === "datasets") {
    if (method === "GET" && action === "versions") return { name: "versions", path: path + "/versions", id };
    if (method === "POST" && action === "save") return write("dataset.save", SaveBenchmarkDatasetSchema, path + "/save", id);
    if (method === "POST" && action === "publish") return write("dataset.publish", PublishBenchmarkDatasetSchema, path + "/publish", id);
  }
  if (segments.length === 3 && root === "experiments") {
    if (method === "GET" && (action === "attempts" || action === "costs" || action === "reports")) return { name: action, path: path + "/" + action, id };
    if (method === "POST" && action === "expenses") return write("expense.record", RecordBenchmarkExpenseSchema, path + "/expenses", id);
    if (method === "POST" && action === "reports") return write("report.create", CreateBenchmarkReportSchema, path + "/reports", id);
  }
  if (segments.length === 4 && root === "experiments" && action === "attempts" && leaf === "start" && method === "POST")
    return write("attempt.start", StartBenchmarkAttemptSchema, path + "/attempts/start", id);
  if (segments.length === 3 && root === "attempts" && action === "review" && method === "POST")
    return write("attempt.review", ReviewBenchmarkAttemptSchema, path + "/review", id);
  return null;
}

async function readJson(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<unknown> {
  if (!body) throw new InvalidPayload();
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new PayloadLimit(); }
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally { reader.releaseLock(); }
}
const checksum = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function permitted(view: ErpSessionView, operation?: BenchmarkOperation) {
  const permissions = ["workflow:read"];
  if (operation === "dataset.create" || operation === "dataset.save") permissions.push("workflow:manage");
  else if (operation === "dataset.publish") permissions.push("workflow:manage", "workflow:run", "workflow:approve");
  else if (operation === "experiment.create" || operation === "attempt.start") permissions.push("workflow:manage", "workflow:run");
  else if (operation) permissions.push("workflow:approve");
  return permissions.every(bit => view.permissions.includes(bit) &&
    (view.permissionScopes === undefined || view.permissionScopes[bit] !== undefined));
}
function readableScope(view: ErpSessionView, scope: "self" | "team" | "tenant", hasProducts = false) {
  const rank = { self: 0, team: 1, tenant: 2 };
  return ["workflow:read", ...(hasProducts ? ["product:read"] : [])].every(bit => {
    const current = view.permissionScopes === undefined ? view.dataScope : view.permissionScopes[bit];
    return view.permissions.includes(bit) && current !== undefined && rank[current] >= rank[scope];
  });
}
function businessRoleAllowed(view: ErpSessionView, role: BusinessRole, mode: "read" | "run" = "read", pinned: ErpSessionView["dataScope"] = "self") {
  try {
    assertBusinessBenchmarkScope(view, pinned, role);
    const rank = { self: 0, team: 1, tenant: 2 };
    for (const bit of requiredAssistPermissions(role, mode)) {
      authorize(view, bit);
      if (rank[permissionScope(view, bit)] < rank[benchmarkDomainMinimumScope(role, bit)]) return false;
    }
    return true;
  } catch { return false; }
}
function businessResourceScopesAllowed(view: ErpSessionView, role: BusinessRole, bindings: BenchmarkResourceBindings) {
  const rank = { self: 0, team: 1, tenant: 2 };
  if (requiredAssistPermissions(role, "read").some(bit => bindings.permissionScopes[bit] === undefined)) return false;
  return Object.entries(bindings.permissionScopes).every(([key, original]) => {
    if (!Object.values(Permission).some(value => value === key)) return false;
    const bit = key as Permission;
    // An original run's write grants are not new historical-read requirements.
    if (!bit.endsWith(":read") && bit !== Permission.OrderPiiRead) return true;
    try {
      authorize(view, bit);
      const minimum = role === "procurement_review" || role === "business_review" || bit.startsWith("order:") ? original : "self";
      return rank[permissionScope(view, bit)] >= Math.max(rank[minimum], rank[benchmarkDomainMinimumScope(role, bit)]);
    }
    catch { return false; }
  });
}
function businessTaskIdentity(task: BusinessBenchmarkCase["task"]) {
  switch (task.kind) {
    case "procurement_review": return { target: `${task.stockItemId}:${task.locationId}`, scope: `procurement:${task.stockItemId}:${task.locationId}` };
    case "business_review": return { target: task.runId, scope: `finance:${task.runId}` };
    case "creative": return { target: task.projectId ?? null, scope: `creative:${task.scopeId}` };
    case "order_review": case "artwork_preflight": return { target: task.orderLineId, scope: `order:${task.orderLineId}` };
    case "template_config": return { target: task.inspectionId, scope: `template:${task.inspectionId}` };
    case "sku_package": return { target: task.listingId, scope: `listing:${task.listingId}` };
    case "after_sales_review": return { target: task.caseId, scope: `case:${task.caseId}` };
  }
}
function businessTarget(role: BusinessRole, value: string) {
  const parts = value.split(":"), count = role === "procurement_review" ? 2 : 1;
  if (parts.length !== count) return null;
  const ids = parts.map(part => EntityId.safeParse(part));
  return ids.every(part => part.success) ? ids.map(part => part.data).join(":") : null;
}
function validVersionManifest(value: z.infer<typeof BenchmarkVersionSchema>, view: ErpSessionView) {
  if (value.description === undefined) return false;
  const fields = BenchmarkDatasetFieldsSchema.parse({ name: value.name, description: value.description, items: value.items.map(item => item.fields) });
  const items = value.items.map(item => ({ id: item.id, caseId: item.caseId, ordinal: item.ordinal, fields: item.fields,
    caseChecksum: item.caseChecksum, basisFingerprint: item.basisFingerprint, taskFingerprint: item.taskFingerprint,
    sourcePins: item.sourcePins, method: item.method, expiresAt: item.expiresAt }));
  return value.items.every(item => item.fields.role === "knowledge_answer"
    ? item.caseId !== null && item.caseChecksum === checksum(item.fields.evaluation)
    : item.caseId === null && item.caseChecksum === checksum(item.fields) && businessRoleAllowed(view, item.fields.role, "read", value.dataScope) &&
      (!item.fields.task.salesPlan || readableProductScope(view, value.dataScope)) &&
      item.sourcePins.every(source => !("kind" in source) || !source.resourceBindings || businessResourceScopesAllowed(view, item.fields.role as BusinessRole, source.resourceBindings))) &&
    checksum({ version: "knowledge-benchmark-dataset-v1", fields, items }) === value.checksum;
}
function readableProductScope(view: ErpSessionView, pinned: ErpSessionView["dataScope"]) {
  try { authorize(view, Permission.ProductRead); return { self: 0, team: 1, tenant: 2 }[permissionScope(view, Permission.ProductRead)] >= { self: 0, team: 1, tenant: 2 }[pinned]; }
  catch { return false; }
}
function validPage<T extends { id: string }>(value: { items: T[]; nextCursor: string | null; total: number }, query: PageQuery, valid: (item: T) => boolean) {
  return value.items.length <= query.limit && value.total >= value.items.length && new Set(value.items.map(item => item.id)).size === value.items.length &&
    value.items.every((item, index) => (!query.cursor || item.id < query.cursor) && (index === 0 || value.items[index - 1]!.id > item.id) && valid(item)) &&
    (value.nextCursor === null || value.items.length === query.limit && value.nextCursor === value.items.at(-1)?.id && value.total > value.items.length);
}
function validAttempt(value: BenchmarkAttempt) {
  return (!value.assessment || value.assessment.attemptId === value.id) && (!value.review || value.review.attemptId === value.id) &&
    (value.resultAvailable || value.result === null) && (value.result === null || value.assessment === null || checksum(value.result) === value.assessment.outputChecksum);
}
function validCosts(value: BenchmarkCostSummary) {
  return value.baseline.arm === "baseline" && value.candidate.arm === "candidate" &&
    new Set(value.latestExpenses.map(item => item.arm)).size === value.latestExpenses.length &&
    value.latestExpenses.every(item => item.experimentId === value.experimentId);
}
function validReport(value: BenchmarkReport) {
  const { manifestChecksum, ...body } = value;
  return value.summary.experimentId === value.experimentId && validCosts(value.summary) && checksum(body) === manifestChecksum;
}
function validCommand(value: z.infer<typeof BenchmarkCommandReceiptSchema>) {
  const root = value.operation === "dataset.create" || value.operation === "experiment.create";
  return (root ? value.parentId === null : value.parentId !== null) &&
    (value.operation !== "dataset.save" || value.receipt.id === value.parentId);
}

function parseRead(route: Route, raw: unknown, query: PageQuery, view: ErpSessionView): unknown {
  let value: unknown;
  const require = (condition: boolean) => { if (!condition) throw new InvalidPayload(); };
  switch (route.name) {
    case "datasets": {
      const page = BenchmarkDatasetPageSchema.parse(raw);
      require(validPage(page, query, () => true)); value = page; break;
    }
    case "dataset": {
      const record = BenchmarkDatasetSchema.parse(raw);
      require(record.id === route.id && record.itemCount === record.fields.items.length && record.name === record.fields.name &&
        record.fields.items.every(item => item.role === "knowledge_answer" || businessRoleAllowed(view, item.role))); value = record; break;
    }
    case "versions": {
      const page = BenchmarkVersionPageSchema.parse(raw);
      require(validPage(page, query, item => item.datasetId === route.id && readableScope(view, item.dataScope))); value = page; break;
    }
    case "version": {
      const record = BenchmarkVersionSchema.parse(raw);
      require(record.id === route.id && readableScope(view, record.dataScope, record.items.some(item => benchmarkCaseHasProducts(item.fields))) && validVersionManifest(record, view)); value = record; break;
    }
    case "experiments": {
      const page = BenchmarkExperimentPageSchema.parse(raw);
      require(validPage(page, query, item => item.modelId === item.model.id && readableScope(view, item.dataScope))); value = page; break;
    }
    case "experiment": {
      const record = BenchmarkExperimentSchema.parse(raw);
      require(record.id === route.id && record.modelId === record.model.id && readableScope(view, record.dataScope)); value = record; break;
    }
    case "attempts": {
      const page = BenchmarkAttemptPageSchema.parse(raw);
      require(validPage(page, query, item => item.experimentId === route.id && (!query.itemId || item.itemId === query.itemId) && (!query.arm || item.arm === query.arm) && validAttempt(item))); value = page; break;
    }
    case "attempt": {
      const record = BenchmarkAttemptSchema.parse(raw);
      require(record.id === route.id && validAttempt(record)); value = record; break;
    }
    case "costs": {
      const record = BenchmarkCostSummarySchema.parse(raw);
      require(record.experimentId === route.id && validCosts(record)); value = record; break;
    }
    case "reports": {
      const page = BenchmarkReportPageSchema.parse(raw);
      require(validPage(page, query, item => item.experimentId === route.id && validReport(item))); value = page; break;
    }
    case "report": {
      const record = BenchmarkReportSchema.parse(raw);
      require(record.id === route.id && validReport(record)); value = record; break;
    }
    case "request": {
      const record = BenchmarkCommandReceiptSchema.parse(raw);
      require(record.requestId === route.id && validCommand(record)); value = record; break;
    }
    default: throw new InvalidPayload();
  }
  return value;
}

async function upstreamFailure(response: Response, identity: ErpRequestIdentity, verifyingWrite = false) {
  const raw = response.status === 409 ? await readJson(response.body, 8192).catch(() => null) : null;
  if (!response.bodyUsed) await response.body?.cancel().catch(() => {});
  await assertErpIdentityCurrent(identity);
  if (raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed") return failure(409, "authority_changed");
  // A committed POST followed by a missing receipt is an unknown result, not a
  // denial or evidence that the original mutation did not commit.
  if (verifyingWrite && ![401, 403].includes(response.status)) return failure(502);
  return failure([400, 401, 403, 404, 409, 412, 413, 415, 422, 429, 503].includes(response.status) ? response.status : 502);
}
function authFailure(error: PersonalSessionError, request: Request) {
  const result = erpAuthFailure(error, request);
  Object.entries(headers).forEach(([key, value]) => result.headers.set(key, value));
  return result;
}

export async function benchmarkProxy(request: Request, segments: string[], method: "GET" | "POST") {
  const route = routeFor(segments, method);
  if (!route) return failure(404);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return failure(400);
  const rawQuery = Object.fromEntries(params);
  const paged = ["datasets", "versions", "experiments", "attempts", "reports"].includes(route.name);
  const parsedQuery = (route.name === "taskTargets" ? BusinessBenchmarkTargetQuerySchema : route.name === "attempts" ? BenchmarkAttemptPageQuerySchema : paged ? BenchmarkPageQuerySchema : EmptyQuery).safeParse(rawQuery);
  if (!parsedQuery.success) return failure(400);
  const query: PageQuery = paged ? BenchmarkAttemptPageQuerySchema.parse(parsedQuery.data) : { limit: 20 };
  const targetQuery = route.name === "taskTargets" ? BusinessBenchmarkTargetQuerySchema.parse(parsedQuery.data) : null;
  let input: CommandInput | undefined;
  let basisInput: z.infer<typeof BusinessBenchmarkBasisRequestSchema> | undefined;
  if (method === "POST") {
    if (!isSameOriginRequest(request)) return failure(403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return failure(415);
    try {
      const raw = await readJson(request.body, maximumBytes);
      if (route.name === "write") input = route.schema.parse(raw);
      else if (route.name === "taskBasis") {
        const selection = BusinessBenchmarkBasisRequestSchema.parse(raw), targetId = businessTarget(selection.kind, selection.targetId);
        if (!targetId) return failure(400);
        basisInput = { ...selection, targetId };
      } else return failure(404);
    }
    catch (error) { return failure(error instanceof PayloadLimit ? 413 : 400); }
  }
  let identity: ErpRequestIdentity | undefined;
  try {
    identity = await erpRequestIdentity(request);
    const authority = erpSessionAuthority(identity.view);
    if (!permitted(identity.view, route.operation)) return failure(403);
    // This preview performs the original owner's run admission without starting
    // a model call, so its workflow permission gate matches a new attempt.
    if (route.name === "taskBasis" && !permitted(identity.view, "attempt.start")) return failure(403);
    const businessRole = targetQuery?.kind ?? basisInput?.kind;
    if (businessRole && !businessRoleAllowed(identity.view, businessRole, route.name === "taskBasis" ? "run" : "read")) return failure(403);
    if (route.operation === "dataset.create" || route.operation === "dataset.save") {
      const dataset = SaveBenchmarkDatasetSchema.parse(input);
      if (dataset.fields.items.some(item => item.role !== "knowledge_answer" && !businessRoleAllowed(identity!.view, item.role))) return failure(403);
    }
    if (request.headers.get("x-yummyai-context-authority") !== authority) return failure(409, "authority_changed");
    const base = process.env.API_BASE_URL?.replace(/\/$/, "");
    if (!base) return failure(503);
    const suffix = paged || targetQuery ? "?" + new URLSearchParams(Object.entries(parsedQuery.data).map(([key, value]) => [key, String(value)])) : "";
    const signal = route.name === "write" ? AbortSignal.timeout(120_000) : AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const response = await apiFetch(`${base}/v1/knowledge-governance/benchmarks/${route.path}${suffix}`, {
      method, cache: "no-store", redirect: "error", signal,
      ...(input || basisInput ? { body: JSON.stringify(input ?? basisInput), headers: { "content-type": "application/json" } } : {}),
    });
    await assertErpIdentityCurrent(identity);
    if (!response.ok) return await upstreamFailure(response, identity);
    if (response.status !== (route.name === "write" ? 201 : 200)) { await response.body?.cancel().catch(() => {}); return failure(502); }
    const raw = await readJson(response.body, maximumBytes);
    await assertErpIdentityCurrent(identity);
    let value: unknown;
    if (route.name === "write" && input) {
      const receipt = BenchmarkReceiptSchema.parse(raw);
      if (route.operation === "dataset.save" && (receipt.id !== route.id || receipt.revision !== Number(input.expectedRevision) + 1) ||
        (route.operation === "dataset.create" || route.operation === "experiment.create") && receipt.revision !== 1) throw new InvalidPayload();
      const original = await apiFetch(`${base}/v1/knowledge-governance/benchmarks/requests/${input.requestId}`, {
        method: "GET", cache: "no-store", redirect: "error", signal,
      });
      await assertErpIdentityCurrent(identity);
      if (!original.ok) return await upstreamFailure(original, identity, true);
      if (original.status !== 200) { await original.body?.cancel().catch(() => {}); return failure(502); }
      const recorded = BenchmarkCommandReceiptSchema.parse(await readJson(original.body, maximumBytes));
      await assertErpIdentityCurrent(identity);
      const requestChecksum = createHash("sha256").update(benchmarkCommandCanonical(route.operation, route.id, input)).digest("hex");
      if (!validCommand(recorded) || recorded.requestId !== input.requestId || recorded.operation !== route.operation || recorded.parentId !== route.id || recorded.requestChecksum !== requestChecksum ||
        recorded.receipt.id !== receipt.id || recorded.receipt.revision !== receipt.revision) throw new InvalidPayload();
      value = receipt;
    } else if (route.name === "taskTargets" && targetQuery) {
      const targets = AssistTaskTargetsSchema.parse(raw);
      if (targets.items.length > 40 || new Set(targets.items.map(item => item.id)).size !== targets.items.length ||
        targets.items.some(item => businessTarget(targetQuery.kind, item.id) !== item.id)) throw new InvalidPayload();
      value = targets;
    } else if (route.name === "taskBasis" && basisInput) {
      const basis = AssistTaskBasisSchema.parse(raw), task = BusinessBenchmarkCaseSchema.shape.task.parse(basis.input), fixed = businessTaskIdentity(task);
      if (task.kind !== basisInput.kind || task.expectedTaskFingerprint !== basis.fingerprint || (task.taskGoal ?? "") !== basisInput.taskGoal || fixed.target !== basisInput.targetId || basis.scope !== fixed.scope ||
        task.kind === "business_review" && task.comparisonRunId !== null || task.kind === "after_sales_review" && (task.locale !== "en-US" || task.contextNotes !== basisInput.taskGoal)) throw new InvalidPayload();
      if (task.salesPlan && !readableProductScope(identity.view, "self")) return failure(403);
      value = basis;
    } else value = parseRead(route, raw, query, identity.view);
    await assertErpIdentityCurrent(identity);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumBytes) throw new PayloadLimit();
    return Response.json(value, { status: response.status, headers: { ...headers, "x-yummyai-context-authority": authority } });
  } catch (error) {
    if (error instanceof PersonalSessionError) return authFailure(error, request);
    if (identity) {
      try { await assertErpIdentityCurrent(identity); }
      catch (currentError) { if (currentError instanceof PersonalSessionError) return authFailure(currentError, request); }
    }
    return failure(502);
  }
}
