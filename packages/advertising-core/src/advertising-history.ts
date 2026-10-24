import type { TenantContext } from "@yummyai/contracts";
import { AdActionStatusSchema,AdGoalFieldsSchema } from "@yummyai/contracts/advertising";
import {
AdActionEventRecordSchema,AdHistoryPageSchema,AdHistoryQuerySchema,AdHistoryRecordQuerySchema,
AdHistoryRecordResultSchema,AdHistoryRowSchema,AdImportEventRecordSchema,
type AdHistoryAccessMode,type AdHistoryKind,type AdHistoryPage,type AdHistoryQuery,
type AdHistoryRecord,type AdHistoryRecordQuery,type AdHistoryRecordResult,
} from "@yummyai/contracts/advertising/history";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import {
adActionEvents,adActions,adAnalysisRuns,adExports,adGoalVersions,adImportEvents,adImports,
adObservations,adProducts,type TenantTransaction,
} from "@yummyai/database";
import { and,asc,eq,sql,type SQL } from "drizzle-orm";
import type { AnyPgColumn,AnyPgTable } from "drizzle-orm/pg-core";
import { createHash } from "node:crypto";
import { z } from "zod";
import { advertisingAccess,advertisingContextAuthority,requireAdvertisingAccount } from "./advertising-authority.js";
import { actionView,exportView,goalView,importView,observationView,runView } from "./advertising-views.js";

type HistoryTable = AnyPgTable & {
  id: AnyPgColumn; tenantId: AnyPgColumn; accountId: AnyPgColumn; createdBy: AnyPgColumn; createdAt: AnyPgColumn;
};
type Binding = {
  table: HistoryTable; title: SQL; status?: AnyPgColumn | SQL; revision?: AnyPgColumn;
  periodStart?: AnyPgColumn | SQL; periodEnd?: AnyPgColumn | SQL; checksum?: AnyPgColumn; runId?: AnyPgColumn | SQL;
};
type Scope = {
  accountId: string; contextAuthority: string; accessMode: AdHistoryAccessMode; parentOwner: string | null;
};
type Cursor = { v: 1; scopeHash: string; upperBound: string; afterId: string; recordedBefore: string };
type Summary = {
  id: string; accountId: string; title: string; status: string | null; revision: number | null; createdAt: string;
  ownerId: string; periodStart: string | null; periodEnd: string | null; checksum: string | null; runId: string | null;
};

// These bindings select metadata only. Large original results and private source
// storage coordinates are loaded solely by the exact-record endpoint.
const bindings: Record<AdHistoryKind, Binding> = {
  imports: { table: adImports, title: sql`${adImports.fileName}`,
    status: sql`case when ${adImports.archivedAt} is null then 'active' else 'archived' end`,
    periodStart: adImports.periodStart, periodEnd: adImports.periodEnd, checksum: adImports.checksum },
  goals: { table: adGoalVersions,
    title: sql`concat((select ${adProducts.asin} from ${adProducts} where ${adProducts.tenantId}=${adGoalVersions.tenantId}
      and ${adProducts.accountId}=${adGoalVersions.accountId} and ${adProducts.id}=${adGoalVersions.productId}),' / v',${adGoalVersions.revision})`,
    revision: adGoalVersions.revision, checksum: adGoalVersions.checksum },
  observations: { table: adObservations,
    title: sql`concat(${adObservations.data}->>'kind',' / ',${adObservations.data}->'scope'->>'asin')`,
    periodStart: sql`${adObservations.data}->>'periodStart'`, periodEnd: sql`${adObservations.data}->>'periodEnd'`,
    checksum: adObservations.inputChecksum },
  analyses: { table: adAnalysisRuns,
    title: sql`concat(${adAnalysisRuns.input}->>'periodStart',' / ',${adAnalysisRuns.input}->>'periodEnd')`,
    status: adAnalysisRuns.status, periodStart: sql`${adAnalysisRuns.input}->>'periodStart'`,
    periodEnd: sql`${adAnalysisRuns.input}->>'periodEnd'`, checksum: adAnalysisRuns.inputChecksum, runId: adAnalysisRuns.id },
  actions: { table: adActions, title: sql`${adActions.recommendation}->>'title'`, status: adActions.status,
    revision: adActions.revision, periodStart: sql`${adActions.recommendation}->>'periodStart'`,
    periodEnd: sql`${adActions.recommendation}->>'periodEnd'`, checksum: adActions.recommendationKey, runId: adActions.runId },
  exports: { table: adExports, title: sql`concat('封存 ',${adExports.id}::text)`, status: sql`'sealed'`,
    periodStart: sql`${adExports.data}->'run'->>'periodStart'`, periodEnd: sql`${adExports.data}->'run'->>'periodEnd'`,
    checksum: adExports.checksum, runId: adExports.runId },
  action_events: { table: adActionEvents, title: sql`${adActionEvents.reason}`, status: adActionEvents.status,
    checksum: adActionEvents.inputChecksum,
    runId: sql`(select ${adActions.runId} from ${adActions} where ${adActions.tenantId}=${adActionEvents.tenantId}
      and ${adActions.accountId}=${adActionEvents.accountId} and ${adActions.id}=${adActionEvents.actionId})` },
  import_events: { table: adImportEvents, title: sql`${adImportEvents.reason}`, status: sql`'archived'`, checksum: adImportEvents.inputChecksum },
};

/** The caller supplies its already refreshed, intersected authority and RR
 * tenant transaction. A cursor selects a position; it never grants access. */
export async function listAdvertisingHistory(
  tx: TenantTransaction, current: TenantContext, raw: AdHistoryQuery,
): Promise<AdHistoryPage> {
  const query = normalizedQuery(AdHistoryQuerySchema.parse(raw));
  const scope = await resolveScope(tx, current, query);
  const scopeHash = cursorScope(current, query, scope);
  const cursor = query.cursor ? decodeCursor(query.cursor, scopeHash) : null;
  const recordedBefore = cursor?.recordedBefore ?? await databaseClock(tx);
  const where = visibleWhere(current, query, scope.accessMode);
  const table = bindings[query.kind].table;
  const recordedWhere = and(where, sql`${table.createdAt}<=${recordedBefore}::timestamptz`)!;
  if (cursor) {
    const [{ valid }] = await tx.execute<{ valid: boolean }>(sql`select ${recordedBefore}::timestamptz<=clock_timestamp() as valid`);
    if (!valid) invalidCursor();
    const anchors = await tx.execute<{ id: string }>(sql`select ${table.id} as id from ${table} where ${recordedWhere}
      and (${table.id}=${cursor.upperBound}::uuid or ${table.id}=${cursor.afterId}::uuid)`);
    if (!anchors.some(row => row.id === cursor.upperBound) || !anchors.some(row => row.id === cursor.afterId)) invalidCursor();
  }
  const binding = bindings[query.kind];
  const rows = await tx.execute<Summary>(sql`select ${table.id} as id,${table.accountId} as "accountId",
    ${binding.title} as title,${binding.status ?? sql`null`} as status,${binding.revision ?? sql`null`} as revision,
    to_char(${table.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
    ${table.createdBy} as "ownerId",${binding.periodStart ?? sql`null`} as "periodStart",${binding.periodEnd ?? sql`null`} as "periodEnd",
    ${binding.checksum ?? sql`null`} as checksum,${binding.runId ?? sql`null`} as "runId"
    from ${table} where ${recordedWhere}
    ${cursor ? sql`and ${table.id}<=${cursor.upperBound}::uuid and ${table.id}<${cursor.afterId}::uuid` : sql``}
    order by ${table.id} desc limit ${query.pageSize + 1}`);
  const page = rows.slice(0, query.pageSize);
  const upperBound = cursor?.upperBound ?? page[0]?.id ?? null;
  const [{ count }] = await tx.execute<{ count: string }>(sql`select count(*)::text as count from ${table} where ${recordedWhere}
    ${upperBound ? sql`and ${table.id}<=${upperBound}::uuid` : sql``}`);
  const hasMore = rows.length > query.pageSize;
  return AdHistoryPageSchema.parse({
    accountId: scope.accountId, kind: query.kind, parentId: query.parentId ?? null,
    contextAuthority: scope.contextAuthority, accessMode: scope.accessMode,
    rows: page.map(row => AdHistoryRowSchema.parse({
      id: row.id, accountId: row.accountId, kind: query.kind, parentId: query.parentId ?? null,
      title: row.title, status: row.status, revision: row.revision, createdAt: row.createdAt,
      ownedByCurrentActor: (scope.parentOwner ?? row.ownerId) === current.userId.toLowerCase(),
      periodStart: row.periodStart, periodEnd: row.periodEnd, checksum: row.checksum, runId: row.runId,
    })),
    count: safeCount(count), pageSize: query.pageSize, requestCursor: query.cursor ?? null,
    nextCursor: hasMore ? encodeCursor({ v: 1, scopeHash, upperBound: upperBound!, afterId: page.at(-1)!.id, recordedBefore }) : null,
    hasMore, upperBound, recordedBefore, order: "id_desc",
  });
}

export async function readAdvertisingHistory(
  tx: TenantTransaction, current: TenantContext, rawId: string, raw: AdHistoryRecordQuery,
): Promise<AdHistoryRecordResult> {
  const id = parseId(rawId);
  const query = normalizedQuery(AdHistoryRecordQuerySchema.parse(raw));
  const scope = await resolveScope(tx, current, query);
  const where = visibleWhere(current, query, scope.accessMode);
  let record: AdHistoryRecord;
  let actionContext: AdHistoryRecordResult["actionContext"] = null;
  switch (query.kind) {
    case "imports": {
      const [row] = await tx.select().from(adImports).where(and(where, eq(adImports.id, id))).limit(1);
      if (!row) missing();
      record = { kind: "imports", value: importView(row) };
      break;
    }
    case "goals": {
      const [row] = await tx.select({ goal: adGoalVersions, product: adProducts }).from(adGoalVersions)
        .innerJoin(adProducts, and(eq(adProducts.tenantId, adGoalVersions.tenantId),
          eq(adProducts.accountId, adGoalVersions.accountId), eq(adProducts.id, adGoalVersions.productId)))
        .where(and(where, eq(adGoalVersions.id, id))).limit(1);
      if (!row) missing();
      record = { kind: "goals", value: goalView(row.goal, row.product) };
      break;
    }
    case "observations": {
      const [row] = await tx.select().from(adObservations).where(and(where, eq(adObservations.id, id))).limit(1);
      if (!row) missing();
      record = { kind: "observations", value: observationView(row) };
      break;
    }
    case "analyses": {
      const [row] = await tx.select().from(adAnalysisRuns).where(and(where, eq(adAnalysisRuns.id, id))).limit(1);
      if (!row) missing();
      record = { kind: "analyses", value: runView(row) };
      break;
    }
    case "actions": {
      const [row] = await tx.select().from(adActions).where(and(where, eq(adActions.id, id))).limit(1);
      if (!row) missing();
      const events = await tx.select().from(adActionEvents).where(and(eq(adActionEvents.tenantId, current.tenantId),
        eq(adActionEvents.accountId, scope.accountId), eq(adActionEvents.actionId, row.id)))
        .orderBy(asc(adActionEvents.createdAt), asc(adActionEvents.id));
      record = { kind: "actions", value: actionView(row, events) };
      actionContext = await readActionContext(tx, current, row);
      break;
    }
    case "exports": {
      const [row] = await tx.select().from(adExports).where(and(where, eq(adExports.id, id))).limit(1);
      if (!row) missing();
      record = { kind: "exports", value: exportView(row) };
      break;
    }
    case "action_events": {
      const [row] = await tx.select().from(adActionEvents).where(and(where, eq(adActionEvents.id, id))).limit(1);
      if (!row) missing();
      record = { kind: "action_events", value: actionEventView(row) };
      break;
    }
    case "import_events": {
      const [row] = await tx.select().from(adImportEvents).where(and(where, eq(adImportEvents.id, id))).limit(1);
      if (!row) missing();
      record = { kind: "import_events", value: AdImportEventRecordSchema.parse({ id: row.id,
        importId: row.importId, accountId: row.accountId, status: "archived", reason: row.reason, createdAt: row.createdAt.toISOString() }) };
      break;
    }
  }
  return AdHistoryRecordResultSchema.parse({ accountId: scope.accountId, recordId: id, parentId: query.parentId ?? null,
    contextAuthority: scope.contextAuthority, accessMode: scope.accessMode, record, actionContext });
}

async function resolveScope(tx: TenantTransaction, current: TenantContext, query: AdHistoryRecordQuery): Promise<Scope> {
  const account = await requireAdvertisingAccount(tx, current, query.accountId, null, true);
  const access = advertisingAccess(current, account.createdBy);
  const writeKind = ["imports", "observations", "import_events"].includes(query.kind);
  const accessMode: AdHistoryAccessMode = access.canRead ? "read"
    : writeKind && access.canWrite ? "own_write" : !writeKind && access.canReview ? "own_review" : missing();
  let parentOwner: string | null = null;
  if (query.kind === "action_events") {
    const [parent] = await tx.select({ ownerId: adActions.createdBy }).from(adActions)
      .where(and(visibleWhere(current, { accountId: query.accountId, kind: "actions" }, accessMode),
        eq(adActions.id, query.parentId!))).limit(1);
    if (!parent) missing();
    parentOwner = parent.ownerId;
  } else if (query.kind === "import_events") {
    const [parent] = await tx.select({ ownerId: adImports.createdBy }).from(adImports)
      .where(and(visibleWhere(current, { accountId: query.accountId, kind: "imports" }, accessMode),
        eq(adImports.id, query.parentId!))).limit(1);
    if (!parent) missing();
    parentOwner = parent.ownerId;
  }
  return { accountId: account.id, contextAuthority: advertisingContextAuthority(current), accessMode, parentOwner };
}

function visibleWhere(current: TenantContext, query: AdHistoryRecordQuery, mode: AdHistoryAccessMode): SQL {
  const table = bindings[query.kind].table;
  const conditions: SQL[] = [eq(table.tenantId, current.tenantId), eq(table.accountId, query.accountId)];
  const events = query.kind === "action_events" || query.kind === "import_events";
  if (mode !== "read" && !events) conditions.push(eq(table.createdBy, current.userId));
  if (query.kind === "goals") conditions.push(sql`exists(select 1 from ${adProducts}
    where ${adProducts.tenantId}=${adGoalVersions.tenantId} and ${adProducts.accountId}=${adGoalVersions.accountId}
      and ${adProducts.id}=${adGoalVersions.productId})`);
  if (query.kind === "actions" || query.kind === "exports") {
    const source = query.kind === "actions" ? adActions : adExports;
    conditions.push(sql`exists(select 1 from ${adAnalysisRuns} where ${adAnalysisRuns.tenantId}=${source.tenantId}
      and ${adAnalysisRuns.accountId}=${source.accountId} and ${adAnalysisRuns.id}=${source.runId}
      ${mode !== "read" ? sql`and ${adAnalysisRuns.createdBy}=${current.userId}::uuid` : sql``})`);
  }
  if (query.kind === "observations") conditions.push(sql`lower(${adObservations.data}->'scope'->>'accountId')=${adObservations.accountId}::text`);
  if (query.kind === "analyses") conditions.push(sql`lower(${adAnalysisRuns.input}->>'accountId')=${adAnalysisRuns.accountId}::text`);
  if (query.kind === "actions") conditions.push(sql`lower(${adActions.recommendation}->>'accountId')=${adActions.accountId}::text`);
  if (query.kind === "exports") conditions.push(sql`lower(${adExports.data}->'run'->>'accountId')=${adExports.accountId}::text
    and lower(${adExports.data}->'run'->>'id')=${adExports.runId}::text`);
  if (query.kind === "action_events") conditions.push(eq(adActionEvents.actionId, query.parentId!));
  if (query.kind === "import_events") conditions.push(eq(adImportEvents.importId, query.parentId!));
  return and(...conditions)!;
}

async function readActionContext(tx: TenantTransaction, current: TenantContext, row: typeof adActions.$inferSelect) {
  const rec = row.recommendation;
  let cooldownDays = 7, source: "saved_goal" | "legacy_default" = "legacy_default";
  if (rec.goalVersionId) {
    const [goal] = await tx.select({ accountId: adGoalVersions.accountId, productId: adGoalVersions.productId,
      fields: adGoalVersions.fields, productAccountId: sql<string | null>`(select ${adProducts.accountId} from ${adProducts}
        where ${adProducts.tenantId}=${adGoalVersions.tenantId} and ${adProducts.id}=${adGoalVersions.productId})` }).from(adGoalVersions)
      .where(and(eq(adGoalVersions.tenantId, current.tenantId), eq(adGoalVersions.id, rec.goalVersionId))).limit(1);
    if (goal) {
      if (goal.accountId !== row.accountId || goal.productAccountId !== row.accountId || goal.productId !== rec.productId) invalidRecord();
      const parsed = AdGoalFieldsSchema.safeParse(goal.fields);
      if (!parsed.success) invalidRecord();
      cooldownDays = parsed.data.cooldownDays;
      source = "saved_goal";
    }
  }
  return { goalVersionId: rec.goalVersionId, cooldownDays, source,
    reviewNotBefore: row.executedAt ? new Date(row.executedAt.getTime() + cooldownDays * 86400000).toISOString() : null };
}

function actionEventView(row: typeof adActionEvents.$inferSelect) {
  const data = row.data;
  const number = (name: string, positive = false) => {
    const value = data[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) invalidRecord();
    return value;
  };
  const string = (name: string) => {
    const value = data[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") invalidRecord();
    return value;
  };
  const expected = data.expectedStatus;
  const expectedStatus = expected === undefined || expected === null ? null : AdActionStatusSchema.safeParse(expected);
  if (expectedStatus !== null && !expectedStatus.success) invalidRecord();
  const executedAt = string("executedAt");
  if (executedAt !== null && !z.iso.datetime({ offset: true }).safeParse(executedAt).success) invalidRecord();
  return AdActionEventRecordSchema.parse({ id: row.id, actionId: row.actionId, accountId: row.accountId,
    status: row.status, reason: row.reason, createdAt: row.createdAt.toISOString(), expectedRevision: number("expectedRevision", true),
    expectedStatus: expectedStatus?.data ?? null, executedAt: executedAt === null ? null : new Date(executedAt).toISOString(),
    actualBeforeMinor: number("actualBeforeMinor"), actualAfterMinor: number("actualAfterMinor"),
    execution: row.status === "executed" ? { campaignId: string("executionCampaignId"),
      adGroupId: string("executionAdGroupId"), targetId: string("executionTargetId") } : null,
  });
}

function normalizedQuery<T extends AdHistoryRecordQuery>(query: T): T {
  return { ...query, accountId: query.accountId.toLowerCase(), ...(query.parentId ? { parentId: query.parentId.toLowerCase() } : {}) };
}

function cursorScope(current: TenantContext, query: AdHistoryQuery, scope: Scope) {
  return createHash("sha256").update(canonicalJson({ tenantId: current.tenantId.toLowerCase(), userId: current.userId.toLowerCase(),
    contextAuthority: scope.contextAuthority, accountId: scope.accountId, kind: query.kind, parentId: query.parentId ?? null,
    pageSize: query.pageSize, accessMode: scope.accessMode })).digest("hex");
}
function encodeCursor(cursor: Cursor) { return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url"); }
function decodeCursor(raw: string, scopeHash: string): Cursor {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (raw.length > 4096 || bytes.toString("base64url") !== raw) invalidCursor();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidCursor();
    const object = value as Record<string, unknown>;
    if (object.v !== 1 || object.scopeHash !== scopeHash || !lowerId(object.upperBound) || !lowerId(object.afterId)
      || object.afterId > object.upperBound || typeof object.recordedBefore !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(object.recordedBefore)
      || !z.iso.datetime().safeParse(object.recordedBefore).success) invalidCursor();
    const cursor: Cursor = { v: 1, scopeHash, upperBound: object.upperBound, afterId: object.afterId, recordedBefore: object.recordedBefore };
    if (text !== JSON.stringify(cursor)) invalidCursor();
    return cursor;
  } catch (error) {
    if (error instanceof OriginalOwnerError && error.status === 400) throw error;
    invalidCursor();
  }
}
async function databaseClock(tx: TenantTransaction) {
  const [{ instant }] = await tx.execute<{ instant: string }>(sql`select to_char(clock_timestamp() at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as instant`);
  return instant;
}
function safeCount(value: string) {
  if (!/^\d+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new OriginalOwnerError(422, "广告历史数量超过安全整数范围");
  return Number(value);
}
function lowerId(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && EntityIdSchema.safeParse(value).success;
}
function parseId(value: string) {
  const parsed = EntityIdSchema.safeParse(value);
  if (!parsed.success) throw new OriginalOwnerError(400, "广告历史记录编号无效");
  return parsed.data.toLowerCase();
}
function invalidCursor(): never { throw new OriginalOwnerError(400, "广告历史分页位置无效 请重新读取"); }
function missing(): never { throw new OriginalOwnerError(404, "广告历史记录不存在或不可访问"); }
function invalidRecord(): never { throw new OriginalOwnerError(409, "原广告历史依据无法核对 请保留原记录并检查来源"); }
