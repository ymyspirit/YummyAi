import { describe, expect, it } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  AdActionEventRecordSchema,
  AdHistoryKindSchema,
  AdHistoryPageSchema,
  AdHistoryQuerySchema,
  AdHistoryRecordQuerySchema,
  AdHistoryRecordResultSchema,
  AdHistoryRecordSchema,
  AdImportEventRecordSchema,
  type AdHistoryKind,
  type AdHistoryPage,
  type AdHistoryRecord,
  type AdHistoryRecordResult,
} from "./advertising-history.js";

const id = (value: number) => `01999999-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const accountId = id(1), otherAccountId = id(2), actorId = id(3), parentId = id(4);
const at = "2026-10-21T08:00:00.000Z", checksum = "a".repeat(64);
const authority = erpSessionAuthority({ tenantId: id(5), userId: actorId,
  permissions: ["customer_intelligence:read"], dataScope: "tenant" });
const scope = { accountId, marketplace: "US", currency: "USD", asin: "B012345678" };
const metrics = { impressions: 100, clicks: 10, purchases: 1, spendMinor: 100, salesMinor: 500 };
const recommendation = () => ({ key: checksum, ruleId: "SYNTHETIC_HISTORY", kind: "watch", priority: "normal",
  productId: null, goalVersionId: null, scope, accountId, currency: "USD", marketplace: "US",
  campaignId: "campaign", adGroupId: "group", targetId: null, term: null, title: "Synthetic history watch",
  reason: "Synthetic retained evidence", currentBidMinor: null, proposedBidMinor: null, changeBps: null,
  periodStart: "2026-09-01", periodEnd: "2026-09-15", metrics,
  evidenceKeys: [checksum], constraints: [], reviewAfter: "2026-10-22" });
const originalImport = () => ({ id: id(10), accountId, fileName: "synthetic-history.csv", checksum,
  periodStart: "2026-09-01", periodEnd: "2026-09-15", reportType: "campaign", timezone: "America/Los_Angeles",
  attributionWindowDays: 7, attributionBasis: "click", observedAt: "2026-09-24T18:00:00.000Z",
  recordedAt: at, sourceRowCount: 1, acceptedRowCount: 1, rejectedRowCount: 0, diagnostics: [], archivedAt: null });
const originalRun = () => ({ id: id(13), accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15",
  marketplace: null, currency: null, evidenceCutoffAt: at, status: "partial", inputChecksum: checksum, createdAt: at,
  result: { controlType: null, totals: [], products: [], recommendations: [], diagnostics: [],
    evidenceImportIds: [], goalVersionIds: [], selectedFactCount: 0, supersededFactCount: 0, dailyTrend: [] } });
const originalAction = () => ({ id: id(14), runId: id(13), status: "pending", revision: 1,
  recommendation: recommendation(), createdAt: at, updatedAt: at, executedAt: null,
  actualBeforeMinor: null, actualAfterMinor: null, execution: null,
  events: [{ id: id(17), status: "pending", reason: "Synthetic original event", at }] });
function record(kind: AdHistoryKind): AdHistoryRecord {
  const values = {
    imports: originalImport(),
    goals: { id: id(11), productId: id(19), revision: 1, scope, fields: { mode: "profit_defense",
      effectiveFrom: "2026-09-01", targetAcosBps: null, unitPriceMinor: null, unitCostMinor: null,
      coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null }, checksum, createdAt: at },
    observations: { id: id(12), scope, kind: "organic_rank", periodStart: "2026-09-01", periodEnd: "2026-09-01",
      source: "Synthetic original rank observation", keyword: "custom pillow", organicRank: 8,
      totalSalesMinor: null, totalPurchases: null, preAdContributionMinor: null,
      adsCoverageConfirmed: false, observedAt: at, createdAt: at },
    analyses: originalRun(), actions: originalAction(),
    exports: { id: id(15), runId: id(13), checksum, createdAt: at, reviewReason: "Synthetic reviewed original",
      payload: { schemaVersion: 1, run: originalRun(), actions: [originalAction()], sourcePins: [originalImport()],
        reviewedBy: actorId, marketplaceExecution: "manual" } },
    action_events: { id: id(17), actionId: parentId, accountId, status: "executed", reason: "Synthetic actual execution evidence",
      createdAt: at, expectedRevision: 1, expectedStatus: "adopted", executedAt: at,
      actualBeforeMinor: 0, actualAfterMinor: Number.MAX_SAFE_INTEGER,
      execution: { campaignId: "campaign", adGroupId: "group", targetId: "target" } },
    import_events: { id: id(18), importId: parentId, accountId, status: "archived", reason: "Synthetic archive reason", createdAt: at },
  };
  return AdHistoryRecordSchema.parse({ kind, value: values[kind] });
}
function result(kind: AdHistoryKind): AdHistoryRecordResult {
  const item = record(kind);
  return AdHistoryRecordResultSchema.parse({ accountId, recordId: item.value.id,
    parentId: kind.endsWith("_events") ? parentId : null, contextAuthority: authority, accessMode: "read", record: item,
    actionContext: kind === "actions" ? { goalVersionId: null, cooldownDays: 7, source: "legacy_default", reviewNotBefore: null } : null });
}
function page(): AdHistoryPage {
  return { accountId, kind: "imports", parentId: null, contextAuthority: authority, accessMode: "read",
    rows: [30, 29].map(value => ({ id: id(value), accountId, kind: "imports", parentId: null,
      title: `Synthetic original ${value}`, status: null, revision: null, createdAt: at,
      ownedByCurrentActor: true, periodStart: "2026-09-01", periodEnd: "2026-09-15", checksum, runId: null })),
    count: 201, pageSize: 2, requestCursor: null, nextCursor: "eyJ2IjoxfQ", hasMore: true,
    upperBound: id(30), recordedBefore: at, order: "id_desc" };
}

describe("advertising complete history transport", () => {
  it("requires an explicit account and defaults to a bounded 25-row page", () => {
    expect(AdHistoryQuerySchema.parse({ accountId, kind: "imports" })).toEqual({ accountId, kind: "imports", pageSize: 25 });
    expect(AdHistoryQuerySchema.parse({ accountId, kind: "imports", pageSize: "100" }).pageSize).toBe(100);
    for (const value of [{ kind: "imports" }, { accountId, kind: "facts" }, { accountId, kind: "imports", pageSize: 101 },
      { accountId, kind: "imports", pageSize: 0 }, { accountId, kind: "imports", pageSize: 1.5 },
      { accountId, kind: "imports", tenantId: id(5) }, { accountId, kind: "imports", accessMode: "read" }])
      expect(AdHistoryQuerySchema.safeParse(value).success).toBe(false);
  });

  it("requires a real parent only for the two event kinds", () => {
    for (const kind of AdHistoryKindSchema.options) {
      const query = { accountId, kind, ...(kind.endsWith("_events") ? { parentId } : {}) };
      expect(AdHistoryQuerySchema.safeParse(query).success).toBe(true);
      expect(AdHistoryRecordQuerySchema.safeParse(query).success).toBe(true);
      const invalid = kind.endsWith("_events") ? { accountId, kind } : { ...query, parentId };
      expect(AdHistoryQuerySchema.safeParse(invalid).success).toBe(false);
      expect(AdHistoryRecordQuerySchema.safeParse(invalid).success).toBe(false);
    }
    expect(AdHistoryRecordQuerySchema.safeParse({ accountId, kind: "imports", cursor: "e30" }).success).toBe(false);
  });

  it("keeps opaque cursors bounded without accepting URL, padding or whitespace syntax", () => {
    for (const cursor of ["", " ", "abc=", "a/b", "https://example.invalid", "a".repeat(4097)])
      expect(AdHistoryQuerySchema.safeParse({ accountId, kind: "imports", cursor }).success).toBe(false);
  });

  it("keeps more than the old 200 records while ordering equal timestamps by original ID", () => {
    const value = page();
    expect(AdHistoryPageSchema.parse(value)).toEqual(value);
    expect(value.rows[0]!.createdAt).toBe(value.rows[1]!.createdAt);
    expect(AdHistoryPageSchema.safeParse({ ...value, rows: [...value.rows].reverse() }).success).toBe(false);
  });

  it("binds summary rows to their account, kind, parent and upper bound", () => {
    const value = page(), first = value.rows[0]!;
    for (const row of [{ ...first, accountId: otherAccountId }, { ...first, kind: "analyses" },
      { ...first, parentId }, { ...first, id: id(31) }])
      expect(AdHistoryPageSchema.safeParse({ ...value, rows: [row] }).success).toBe(false);
    expect(AdHistoryPageSchema.safeParse({ ...value, rows: [first, first] }).success).toBe(false);
  });

  it("does not mark an overfull or incomplete page as a complete continuation", () => {
    const value = page();
    for (const invalid of [{ ...value, pageSize: 1 }, { ...value, count: 1 }, { ...value, nextCursor: null },
      { ...value, hasMore: false }, { ...value, rows: value.rows.slice(0, 1) }, { ...value, upperBound: null }])
      expect(AdHistoryPageSchema.safeParse(invalid).success).toBe(false);
    const empty = { ...value, rows: [], count: 0, hasMore: false, nextCursor: null, upperBound: null };
    expect(AdHistoryPageSchema.parse(empty).rows).toEqual([]);
    expect(AdHistoryPageSchema.safeParse({ ...empty, upperBound: id(30) }).success).toBe(false);
  });

  it("cannot return a later-created record inside the fixed original creation queue", () => {
    const value = page();
    expect(AdHistoryPageSchema.safeParse({ ...value,
      rows: [{ ...value.rows[0]!, createdAt: "2026-10-21T08:00:00.001Z" }, value.rows[1]!] }).success).toBe(false);
  });

  it("requires real canonical session authority rather than a SHA or caller-supplied capability", () => {
    const value = page();
    for (const contextAuthority of ["", "a".repeat(64), JSON.stringify(JSON.parse(authority), null, 2)])
      expect(AdHistoryPageSchema.safeParse({ ...value, contextAuthority }).success).toBe(false);
    expect(AdHistoryPageSchema.safeParse({ ...value, canRead: true }).success).toBe(false);
  });

  it("never labels another actor's row as an own-write or own-review recovery", () => {
    for (const accessMode of ["own_write", "own_review"] as const)
      expect(AdHistoryPageSchema.safeParse({ ...page(), accessMode,
        rows: [{ ...page().rows[0]!, ownedByCurrentActor: false }] }).success).toBe(false);
  });

  it("keeps own-write and own-review record families distinct", () => {
    const value = page();
    expect(AdHistoryPageSchema.safeParse({ ...value, accessMode: "own_write" }).success).toBe(true);
    expect(AdHistoryPageSchema.safeParse({ ...value, accessMode: "own_review" }).success).toBe(false);
    const analyses = { ...value, kind: "analyses", rows: value.rows.map(row => ({ ...row, kind: "analyses" })) };
    expect(AdHistoryPageSchema.safeParse({ ...analyses, accessMode: "own_review" }).success).toBe(true);
    expect(AdHistoryPageSchema.safeParse({ ...analyses, accessMode: "own_write" }).success).toBe(false);
  });

  it.each(AdHistoryKindSchema.options)("returns the complete strict original %s record", kind => {
    const value = result(kind);
    expect(AdHistoryRecordResultSchema.parse(value)).toEqual(value);
    expect(AdHistoryRecordResultSchema.safeParse({ ...value, recordId: id(99) }).success).toBe(false);
    expect(AdHistoryRecordResultSchema.safeParse({ ...value, accountId: otherAccountId }).success).toBe(false);
    expect(AdHistoryRecordResultSchema.safeParse({ ...value, parentId: kind.endsWith("_events") ? id(98) : parentId }).success).toBe(false);
  });

  it("does not permit a detail access mode to widen its original operation family", () => {
    expect(AdHistoryRecordResultSchema.safeParse({ ...result("imports"), accessMode: "own_write" }).success).toBe(true);
    expect(AdHistoryRecordResultSchema.safeParse({ ...result("analyses"), accessMode: "own_review" }).success).toBe(true);
    expect(AdHistoryRecordResultSchema.safeParse({ ...result("imports"), accessMode: "own_review" }).success).toBe(false);
    expect(AdHistoryRecordResultSchema.safeParse({ ...result("analyses"), accessMode: "own_write" }).success).toBe(false);
  });

  it("preserves all original action events, including the earliest execution and exact zero amounts", () => {
    const value = result("actions");
    if (value.record.kind !== "actions") throw new Error("Synthetic action record missing");
    value.record.value.events = Array.from({ length: 101 }, (_, index) => ({ id: id(1000 + index),
      status: index === 0 ? "executed" : index % 2 ? "deferred" : "pending", reason: `Synthetic retained event ${index}`, at }));
    value.record.value.execution = { campaignId: "original-campaign", adGroupId: "original-group", targetId: "original-target" };
    value.record.value.executedAt = at;
    value.record.value.actualBeforeMinor = 0;
    value.record.value.actualAfterMinor = Number.MAX_SAFE_INTEGER;
    value.actionContext!.reviewNotBefore = "2026-10-28T08:00:00.000Z";
    const parsed = AdHistoryRecordResultSchema.parse(value);
    if (parsed.record.kind !== "actions") throw new Error("Synthetic action record missing");
    expect(parsed.record.value.events).toHaveLength(101);
    expect(parsed.record.value.events[0]!.reason).toBe("Synthetic retained event 0");
    expect(parsed.record.value.execution?.targetId).toBe("original-target");
    expect(parsed.record.value.actualBeforeMinor).toBe(0);
    expect(parsed.record.value.actualAfterMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("exposes only the event whitelist instead of raw data, keys or internal actor fields", () => {
    const action = record("action_events"), archived = record("import_events");
    expect(AdActionEventRecordSchema.parse(action.value).actualBeforeMinor).toBe(0);
    for (const field of ["data", "idempotencyKey", "createdBy", "objectKey"])
      expect(AdActionEventRecordSchema.safeParse({ ...action.value, [field]: "private synthetic value" }).success).toBe(false);
    expect(AdImportEventRecordSchema.safeParse({ ...archived.value, data: { raw: "private" } }).success).toBe(false);
  });

  it("pins the actual 30-day saved goal window without guessing seven days for an own-review action", () => {
    const value = result("actions");
    if (value.record.kind !== "actions") throw new Error("Synthetic original action missing");
    value.accessMode = "own_review";
    value.record.value.recommendation.goalVersionId = id(11);
    value.record.value.executedAt = at;
    value.actionContext = { goalVersionId: id(11), cooldownDays: 30, source: "saved_goal", reviewNotBefore: "2026-11-20T08:00:00.000Z" };
    expect(AdHistoryRecordResultSchema.parse(value).actionContext).toEqual(value.actionContext);
    expect(AdHistoryRecordResultSchema.safeParse({ ...value, actionContext: { ...value.actionContext,
      reviewNotBefore: "2026-10-28T08:00:00.000Z" } }).success).toBe(false);
    expect(AdHistoryRecordResultSchema.safeParse({ ...value, actionContext: { ...value.actionContext,
      goalVersionId: id(99) } }).success).toBe(false);
  });

  it("requires narrow action context only for an action detail", () => {
    const value = result("actions"), imported = result("imports");
    expect(AdHistoryRecordResultSchema.safeParse({ ...value, actionContext: null }).success).toBe(false);
    expect(AdHistoryRecordResultSchema.safeParse({ ...imported, actionContext: value.actionContext }).success).toBe(false);
    const { actionContext: omitted, ...missing } = value; void omitted;
    expect(AdHistoryRecordResultSchema.safeParse(missing).success).toBe(false);
  });

  it("does not label an invented cooldown or absent saved goal as actual saved rules", () => {
    const value = result("actions");
    expect(AdHistoryRecordResultSchema.safeParse({ ...value,
      actionContext: { ...value.actionContext, cooldownDays: 30 } }).success).toBe(false);
    expect(AdHistoryRecordResultSchema.safeParse({ ...value,
      actionContext: { ...value.actionContext, source: "saved_goal" } }).success).toBe(false);
  });

  it("keeps legacy run and export JSON unchanged without inventing current measurement pins", () => {
    const value = result("exports"), before = JSON.stringify(value);
    expect(JSON.stringify(AdHistoryRecordResultSchema.parse(value))).toBe(before);
    if (value.record.kind !== "exports") throw new Error("Synthetic original export missing");
    expect(value.record.value.payload.run.result.measurementVersion).toBeUndefined();
    expect(value.record.value.payload.run.result.measurementPins).toBeUndefined();
    expect(AdHistoryRecordResultSchema.safeParse({ ...value, record: { ...value.record,
      value: { ...value.record.value, runId: id(99) } } }).success).toBe(false);
  });

  it("rejects an export containing another account's original source pin", () => {
    const value = result("exports");
    if (value.record.kind !== "exports") throw new Error("Synthetic original export missing");
    value.record.value.payload.sourcePins![0]!.accountId = otherAccountId;
    expect(AdHistoryRecordResultSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an export containing an action from another account or analysis", () => {
    const value = result("exports");
    if (value.record.kind !== "exports") throw new Error("Synthetic original export missing");
    value.record.value.payload.actions[0]!.recommendation.accountId = otherAccountId;
    expect(AdHistoryRecordResultSchema.safeParse(value).success).toBe(false);
    const wrongRun = result("exports");
    if (wrongRun.record.kind !== "exports") throw new Error("Synthetic original export missing");
    wrongRun.record.value.payload.actions[0]!.runId = id(99);
    expect(AdHistoryRecordResultSchema.safeParse(wrongRun).success).toBe(false);
  });

  it("preserves a same-account export that legitimately reuses the same recommendation from an earlier analysis", () => {
    const value = result("exports");
    if (value.record.kind !== "exports") throw new Error("Synthetic original export missing");
    const action = value.record.value.payload.actions[0]!;
    value.record.value.payload.run.result.recommendations = [action.recommendation];
    action.runId = id(99);
    expect(AdHistoryRecordResultSchema.parse(value)).toEqual(value);
  });

  it("does not accept a recent action summary as its complete original event detail", () => {
    const value = result("actions");
    if (value.record.kind !== "actions") throw new Error("Synthetic original action missing");
    expect(AdHistoryRecordResultSchema.safeParse({ ...value,
      record: { ...value.record, value: { ...value.record.value, events: [], eventsComplete: false } } }).success).toBe(false);
  });
});
