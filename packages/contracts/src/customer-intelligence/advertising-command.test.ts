import { describe, expect, it } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AdActionEventInputSchema, AdAnalysisInputSchema, AdArchiveInputSchema, AdCommitImportSchema,
  AdExportInputSchema, AdObservationInputSchema, AdSaveGoalInputSchema, adCurrencyBasis } from "./advertising-workbench.js";
import { AD_COMMAND_CONTRACT, AD_COMMAND_MAX_CIPHERTEXT_BYTES, AD_COMMAND_MAX_PLAINTEXT_BYTES,
  AdCommandAccountQuerySchema, AdCommandDetailSchema, AdCommandEmptyBodySchema, AdCommandKindSchema,
  AdCommandListSchema, AdCommandOriginalSchema, AdCommandQuerySchema, AdCommandResultSchema,
  AdCommandScopeSchema, AdCommandSummarySchema, adCommandScopeKey, canonicalAdCommandOriginal,
  PrepareAdCommandSchema, type AdCommandDetail, type AdCommandResult,
  type AdCommandSummary, type PrepareAdCommand } from "./advertising-command.js";

const id = (value: number) => `019aaaaa-aaaa-7aaa-8aaa-${value.toString(16).padStart(12, "0")}`;
const accountId = id(1), otherAccountId = id(2), actionId = id(3), importId = id(4), runId = id(5), productId = id(6);
const at = "2026-10-21T08:00:00.100Z", completedAt = "2026-10-21T08:00:01.100Z", expiresAt = "2026-10-28T08:00:00.100Z";
const hash = "a".repeat(64), requestKey = "SYNTHETIC-AD-COMMAND-ORIGINAL";
const authority = erpSessionAuthority({ tenantId: id(7), userId: id(8), permissions: ["customer_intelligence:write", "customer_intelligence:review"], dataScope: "tenant" });
const scope = { accountId, marketplace: "US", currency: "USD", asin: "B012345678" };
const originals: PrepareAdCommand[] = [
  { kind: "import_commit", accountId, targetId: null, input: AdCommitImportSchema.parse({ accountId,
    marketplaceByCurrency: { USD: "US", KWD: "AE" }, timezone: "America/Los_Angeles", attributionWindowDays: 14,
    attributionBasis: "click", conversionDefinition: { model: "click", source: "Synthetic original report settings explicitly confirm click attribution" },
    observedAt: at, files: [{ fileName: "合成原报表.csv", content: "\uFEFFSearch Term,Targeting,14 Day Total Orders (#),14 Day Total Sales ($)\r\n\"原始词,带引号\",target,2,20.00\r\n",
      metricColumns: { purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" } }],
    allowPartial: false, previewChecksum: hash, idempotencyKey: requestKey }) },
  { kind: "goal_save", accountId, targetId: null, input: AdSaveGoalInputSchema.parse({ scope, expectedRevision: 3,
    fields: { mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100, unitPriceMinor: 10000, unitCostMinor: 7000,
      coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null, cooldownDays: 30,
      monetaryBasis: adCurrencyBasis("USD"), notes: "Synthetic actual economics 不能改为今天目标" }, idempotencyKey: requestKey }) },
  { kind: "observation_record", accountId, targetId: null, input: AdObservationInputSchema.parse({ scope: { ...scope, currency: "KWD" },
    kind: "commerce", periodStart: "2026-09-01", periodEnd: "2026-09-15", source: "Synthetic original commerce source",
    keyword: null, organicRank: null, totalSalesMinor: Number.MAX_SAFE_INTEGER, totalPurchases: 2, preAdContributionMinor: -1234,
    adsCoverageConfirmed: true, monetaryBasis: adCurrencyBasis("KWD"), observedAt: at, idempotencyKey: requestKey }) },
  { kind: "analysis_run", accountId, targetId: null, input: AdAnalysisInputSchema.parse({ accountId, periodStart: "2026-09-01",
    periodEnd: "2026-09-15", marketplace: null, currency: null, evidenceCutoffAt: at, idempotencyKey: requestKey }) },
  { kind: "action_transition", accountId, targetId: actionId, input: AdActionEventInputSchema.parse({ expectedRevision: 9,
    expectedStatus: "adopted", status: "executed", reason: "Synthetic actual manual execution 原活动与竞价",
    executedAt: at, actualBeforeMinor: 1000, actualAfterMinor: 850, executionCampaignId: "CAMPAIGN-ORIGINAL",
    executionAdGroupId: "GROUP-ORIGINAL", executionTargetId: "TARGET-ORIGINAL", idempotencyKey: requestKey }) },
  { kind: "import_archive", accountId, targetId: importId, input: AdArchiveInputSchema.parse({
    reason: "Synthetic archive 原来源保留不撤销事实", idempotencyKey: requestKey }) },
  { kind: "export_seal", accountId, targetId: runId, input: AdExportInputSchema.parse({ runId, actionIds: [actionId, id(9)],
    reviewReason: "Synthetic explicit review 原结果不等于平台执行成功", idempotencyKey: requestKey }) },
];
function receipt(original: PrepareAdCommand): AdCommandResult {
  const parentId = original.kind === "goal_save" ? productId
    : ["action_transition", "import_archive", "export_seal"].includes(original.kind) ? original.targetId : null;
  const version = original.kind === "goal_save" ? original.input.expectedRevision + 1
    : original.kind === "action_transition" ? original.input.expectedRevision + 1 : null;
  return { kind: original.kind, id: id(20 + originals.indexOf(original)), parentId, version };
}
function summary(original = originals[0]!, commandId = id(100)): AdCommandSummary {
  return { id: commandId, kind: original.kind, accountId, targetId: original.targetId, scopeKey: adCommandScopeKey(original),
    status: "prepared", requestKey, createdAt: at, expiresAt, completedAt: null, acknowledged: false,
    originalRetained: true, result: null, contextAuthority: authority };
}
function prepared(original = originals[0]!): AdCommandDetail {
  return { ...summary(original), canExecute: true, canCancel: true, canAcknowledge: false, blockReason: null };
}
function succeeded(original = originals[0]!): AdCommandDetail {
  return { ...prepared(original), status: "succeeded", completedAt, result: receipt(original), canExecute: false,
    canCancel: false, canAcknowledge: true };
}

describe("durable advertising original-command contract", () => {
  it.each(originals.map(original => [original.kind, original] as const))(
    "keeps the complete actual %s owner input rather than rebuilding preview revision or dates", (_kind, original) => {
      expect(PrepareAdCommandSchema.parse(original)).toEqual(original);
      const retained = AdCommandOriginalSchema.parse({ id: id(100), accountId, original, blockReason: null, contextAuthority: authority });
      expect(retained.original).toEqual(original);
      expect(JSON.parse(canonicalAdCommandOriginal(original))).toEqual(original);
    });

  it("covers exactly seven actual writes without a marketplace execution or read operation", () => {
    expect(new Set(originals.map(original => original.kind))).toEqual(new Set(AdCommandKindSchema.options));
    for (const kind of ["preview", "history", "read_source", "execute_advertising", "publish", "workspace"])
      expect(AdCommandKindSchema.safeParse(kind).success).toBe(false);
    expect(AD_COMMAND_CONTRACT).toBe("advertising-command-v1");
  });

  it("requires the exact parent target for an action archive or seal and a null root for the four other writes", () => {
    for (const original of originals) {
      const targeted = ["action_transition", "import_archive", "export_seal"].includes(original.kind);
      expect(PrepareAdCommandSchema.safeParse({ ...original, targetId: targeted ? null : id(99) }).success).toBe(false);
    }
    const seal = originals[6]!;
    expect(PrepareAdCommandSchema.safeParse({ ...seal, targetId: id(99) }).success).toBe(false);
  });

  it("binds every input-carried account to its original envelope account", () => {
    for (const original of originals.slice(0, 4))
      expect(PrepareAdCommandSchema.safeParse({ ...original, accountId: otherAccountId }).success).toBe(false);
    expect(AdCommandOriginalSchema.safeParse({ id: id(100), accountId: otherAccountId, original: originals[0],
      blockReason: null, contextAuthority: authority }).success).toBe(false);
  });

  it("normalizes only UUID identity aliases while retaining the original business values", () => {
    for (const original of originals) {
      const parsed = PrepareAdCommandSchema.parse({ ...original, accountId: accountId.toUpperCase(), targetId: original.targetId?.toUpperCase() ?? null });
      expect(parsed).toEqual(original);
    }
    expect(AdCommandScopeSchema.parse({ kind: "action_transition", accountId: accountId.toUpperCase(), targetId: actionId.toUpperCase() }))
      .toEqual({ kind: "action_transition", accountId, targetId: actionId });
  });

  it("rejects duplicate action identity aliases after lowercase normalization", () => {
    const original = originals[6]!; if (original.kind !== "export_seal") throw new Error("Synthetic seal missing");
    expect(PrepareAdCommandSchema.safeParse({ ...original, input: { ...original.input,
      actionIds: [actionId, actionId.toUpperCase()] } }).success).toBe(false);
  });

  it("keeps system-generated event keys unavailable to manual prepared submissions", () => {
    for (const original of originals) for (const idempotencyKey of ["generated:synthetic-original", "invalidate:synthetic-original"])
      expect(PrepareAdCommandSchema.safeParse({ ...original, input: { ...original.input, idempotencyKey } }).success).toBe(false);
  });

  it("execution-time precision rejects a nonzero submillisecond instead of truncating the original manual execution", () => {
    const original = originals.find(value => value.kind === "action_transition")!;
    if (original.kind !== "action_transition") throw new Error("Synthetic original transition missing");
    expect(PrepareAdCommandSchema.safeParse(original).success).toBe(true);
    for (const executedAt of ["2026-10-21T08:00:00.100001Z", "2026-10-21T08:00:00.0001Z"])
      expect(PrepareAdCommandSchema.safeParse({ ...original, input: { ...original.input, executedAt } }).success).toBe(false);
  });

  it("execution-time precision accepts zero-tail microseconds and retains the complete exactly representable original text", () => {
    const original = originals.find(value => value.kind === "action_transition")!;
    if (original.kind !== "action_transition") throw new Error("Synthetic original transition missing");
    const executedAt = "2026-10-21T08:00:00.100000Z", complete = { ...original, input: { ...original.input, executedAt } };
    expect(PrepareAdCommandSchema.parse(complete)).toEqual(complete);
    expect(JSON.parse(canonicalAdCommandOriginal(PrepareAdCommandSchema.parse(complete))).input.executedAt).toBe(executedAt);
  });

  it("rejects caller-selected identity authority results and replacement execute bodies", () => {
    for (const original of originals) {
      for (const extra of [{ tenantId: id(7) }, { actorId: id(8) }, { authoritySnapshot: {} }, { result: receipt(original) }])
        expect(PrepareAdCommandSchema.safeParse({ ...original, ...extra }).success).toBe(false);
      expect(PrepareAdCommandSchema.safeParse({ ...original, input: { ...original.input, executeAutomatically: true } }).success).toBe(false);
    }
    expect(AdCommandEmptyBodySchema.parse({})).toEqual({});
    for (const value of [undefined, null, [], { input: originals[0]!.input }, { confirmed: true }, { expectedRevision: 10 }])
      expect(AdCommandEmptyBodySchema.safeParse(value).success).toBe(false);
  });

  it("separates product slots by their real ASIN marketplace and currency without changing operation kind", () => {
    const goal = originals[1]!, observation = originals[2]!;
    expect(adCommandScopeKey(goal)).toBe("product:US:USD:B012345678");
    expect(adCommandScopeKey(observation)).toBe("product:US:KWD:B012345678");
    if (goal.kind !== "goal_save") throw new Error("Synthetic goal missing");
    const second = PrepareAdCommandSchema.parse({ ...goal, input: { ...goal.input, scope: { ...goal.input.scope, asin: "B098765432" } } });
    expect(adCommandScopeKey(second)).not.toBe(adCommandScopeKey(goal));
    expect(AdCommandSummarySchema.safeParse({ ...summary(goal), scopeKey: "root" }).success).toBe(false);
    expect(AdCommandSummarySchema.safeParse({ ...summary(originals[4]!), scopeKey: "root" }).success).toBe(false);
  });

  it("preserves exact CSV Unicode BOM CRLF column pins file order and the reviewed checksum in canonical storage", () => {
    const original = originals[0]!; if (original.kind !== "import_commit") throw new Error("Synthetic import missing");
    const next = PrepareAdCommandSchema.parse({ ...original, input: { ...original.input, files: [original.input.files[0]!,
      { ...original.input.files[0]!, fileName: "second.csv", content: "Currency,Spend\r\nUSD,0.00\r\n" }] } });
    if (next.kind !== "import_commit") throw new Error("Synthetic import missing");
    const text = canonicalAdCommandOriginal(next), copied = JSON.parse(text) as PrepareAdCommand;
    expect(copied).toEqual(next); expect(next.input.files[0]!.content.startsWith("\uFEFF")).toBe(true);
    expect(next.input.files[0]!.content.endsWith("\r\n")).toBe(true);
    expect(next.input.previewChecksum).toBe(hash); expect(next.input.observedAt).toBe(at);
    expect(canonicalAdCommandOriginal({ ...next, input: { ...next.input, files: [...next.input.files].reverse() } })).not.toBe(text);
    expect(canonicalAdCommandOriginal({ ...next, input: { ...next.input, allowPartial: true } })).not.toBe(text);
    expect(canonicalAdCommandOriginal({ ...next, input: { ...next.input, idempotencyKey: requestKey.toLowerCase() } })).not.toBe(text);
  });

  it("retains a full twenty-MiB original CSV batch and applies the existing five-MiB and twenty-file owner limits", () => {
    const original = originals[0]!; if (original.kind !== "import_commit") throw new Error("Synthetic import missing");
    const content = "A\n" + "x".repeat(5 * 1024 * 1024 - 2);
    const files = Array.from({ length: 4 }, (_, index) => ({ ...original.input.files[0]!, fileName: `synthetic-full-${index}.csv`, content }));
    const parsed = PrepareAdCommandSchema.parse({ ...original, input: { ...original.input, files } });
    if (parsed.kind !== "import_commit") throw new Error("Synthetic full import missing");
    expect(parsed.input.files).toHaveLength(4);
    expect(parsed.input.files.every(file => file.content === content)).toBe(true);
    expect(parsed.input.files.reduce((sum, file) => sum + new TextEncoder().encode(file.content).byteLength, 0)).toBe(20 * 1024 * 1024);
    expect(PrepareAdCommandSchema.safeParse({ ...original, input: { ...original.input, files: [{ ...files[0]!, content: content + "x" }] } }).success).toBe(false);
    expect(PrepareAdCommandSchema.safeParse({ ...original, input: { ...original.input, files: Array.from({ length: 21 }, () => original.input.files[0]!) } }).success).toBe(false);
    expect(AD_COMMAND_MAX_PLAINTEXT_BYTES).toBe(32 * 1024 * 1024); expect(AD_COMMAND_MAX_CIPHERTEXT_BYTES).toBe(45 * 1024 * 1024);
  });

  it("requires accountId on each exact-ID action query and retains strict root and history filters", () => {
    expect(AdCommandAccountQuerySchema.parse({ accountId: accountId.toUpperCase() })).toEqual({ accountId });
    expect(AdCommandQuerySchema.parse({ accountId, targetId: "root" })).toEqual({ accountId, targetId: null });
    expect(AdCommandQuerySchema.parse({ accountId, before: id(100).toUpperCase(), view: "recorded" })).toEqual({ accountId, before: id(100), view: "recorded" });
    for (const value of [{}, { accountId, tenantId: id(7) }, { accountId, kind: "preview" }, { accountId, targetId: null },
      { accountId, before: "last" }, { accountId, view: "all" }, { accountId, canExecute: true }])
      expect(AdCommandQuerySchema.safeParse(value).success).toBe(false);
    for (const value of [{}, { accountId, kind: "import_commit" }, { accountId, userId: id(8) }, { accountId, body: {} }])
      expect(AdCommandAccountQuerySchema.safeParse(value).success).toBe(false);
  });

  it.each(originals.map(original => [original.kind, original] as const))(
    "uses the immutable actual %s receipt with its required parent and revision", (_kind, original) => {
      const result = receipt(original); expect(AdCommandResultSchema.parse(result)).toEqual(result);
      const parented = ["goal_save", "action_transition", "import_archive", "export_seal"].includes(original.kind);
      const versioned = original.kind === "goal_save" || original.kind === "action_transition";
      expect(AdCommandResultSchema.safeParse({ ...result, parentId: parented ? null : id(99) }).success).toBe(false);
      expect(AdCommandResultSchema.safeParse({ ...result, version: versioned ? null : 1 }).success).toBe(false);
      expect(AdCommandDetailSchema.parse(succeeded(original)).result).toEqual(result);
    });

  it("never gives a prepared cancelled or expired command an invented successful result", () => {
    const original = originals[4]!, initial = prepared(original), done = succeeded(original);
    expect(AdCommandDetailSchema.safeParse({ ...initial, result: done.result }).success).toBe(false);
    expect(AdCommandDetailSchema.safeParse({ ...done, result: null }).success).toBe(false);
    expect(AdCommandDetailSchema.safeParse({ ...done, result: { ...done.result!, kind: "import_archive", version: null } }).success).toBe(false);
    expect(AdCommandDetailSchema.safeParse({ ...done, result: { ...done.result!, parentId: id(99) } }).success).toBe(false);
    for (const status of ["cancelled", "expired"] as const) {
      const terminal = { ...initial, status, completedAt, originalRetained: false, canExecute: false, canCancel: false, canAcknowledge: true };
      expect(AdCommandDetailSchema.parse(terminal).result).toBeNull();
      expect(AdCommandDetailSchema.safeParse({ ...terminal, result: done.result }).success).toBe(false);
      expect(AdCommandDetailSchema.safeParse({ ...terminal, originalRetained: true }).success).toBe(false);
    }
  });

  it("allows acknowledgement to clear only the original copy while keeping the same immutable receipt and original key", () => {
    const done = succeeded();
    expect(AdCommandDetailSchema.safeParse({ ...done, acknowledged: true }).success).toBe(false);
    const acknowledged = AdCommandDetailSchema.parse({ ...done, acknowledged: true, originalRetained: false, canAcknowledge: false });
    expect(acknowledged.result).toEqual(done.result); expect(acknowledged.requestKey).toBe(requestKey);
    expect(AdCommandDetailSchema.safeParse({ ...prepared(), acknowledged: true, originalRetained: false }).success).toBe(false);
  });

  it("pins seven days exactly and rejects completion before preparation without rewriting dates", () => {
    const value = succeeded(); expect(AdCommandDetailSchema.parse(value).createdAt).toBe(at);
    for (const invalid of [{ ...value, expiresAt: "2026-10-28T08:00:00.101Z" },
      { ...value, completedAt: "2026-10-21T08:00:00.099Z" }])
      expect(AdCommandDetailSchema.safeParse(invalid).success).toBe(false);
  });

  it("blocks fresh execution for lost basis authority input or expiry without faking successful work", () => {
    for (const blockReason of ["basis_changed", "permission_denied", "input_unavailable", "expired"] as const) {
      expect(AdCommandDetailSchema.safeParse({ ...prepared(), blockReason }).success).toBe(false);
      expect(AdCommandDetailSchema.parse({ ...prepared(), blockReason, canExecute: false }).result).toBeNull();
    }
    expect(AdCommandDetailSchema.safeParse({ ...prepared(), originalRetained: false }).success).toBe(false);
    expect(AdCommandDetailSchema.safeParse({ ...prepared(), canAcknowledge: true }).success).toBe(false);
    expect(AdCommandDetailSchema.safeParse({ ...succeeded(), canCancel: true }).success).toBe(false);
  });

  it("makes an unavailable original explicit instead of representing missing ciphertext as an empty successful body", () => {
    const value = { id: id(100), accountId, original: null, blockReason: "input_unavailable", contextAuthority: authority };
    expect(AdCommandOriginalSchema.parse(value).original).toBeNull();
    expect(AdCommandOriginalSchema.safeParse({ ...value, blockReason: null }).success).toBe(false);
    expect(AdCommandOriginalSchema.safeParse({ ...value, original: originals[0] }).success).toBe(false);
  });

  it("requires canonical current ERP authority on metadata and a separately retrieved original", () => {
    for (const contextAuthority of ["unknown", "a".repeat(64), JSON.stringify(JSON.parse(authority), null, 2)]) {
      expect(AdCommandSummarySchema.safeParse({ ...summary(), contextAuthority }).success).toBe(false);
      expect(AdCommandOriginalSchema.safeParse({ id: id(100), accountId, original: originals[0], blockReason: null, contextAuthority }).success).toBe(false);
    }
  });

  it("binds metadata pages to one account and authority without exposing duplicates or more than fifty records", () => {
    const items = Array.from({ length: 50 }, (_, index) => summary(originals[0]!, id(1000 - index)));
    const value = { accountId, items, nextCursor: items.at(-1)!.id, unavailableCount: 0, contextAuthority: authority };
    expect(AdCommandListSchema.parse(value).items).toHaveLength(50);
    for (const invalid of [{ ...value, accountId: otherAccountId }, { ...value, items: [...items, summary()] },
      { ...value, items: [items[0]!, items[0]!] }, { ...value, unavailableCount: 51 },
      { ...value, items: [{ ...items[0]!, contextAuthority: "different" }] }])
      expect(AdCommandListSchema.safeParse(invalid).success).toBe(false);
    expect(AdCommandListSchema.parse({ ...value, items: [], unavailableCount: 50 }).items).toEqual([]);
  });

  it("keeps a descending metadata page and its hidden rows inside the same fifty-row scan boundary", () => {
    const items = Array.from({ length: 50 }, (_, index) => summary(originals[0]!, id(1000 - index)));
    const value = { accountId, items, nextCursor: items.at(-1)!.id, unavailableCount: 0, contextAuthority: authority };
    expect(AdCommandListSchema.safeParse({ ...value, items: [...items].reverse() }).success).toBe(false);
    expect(AdCommandListSchema.safeParse({ ...value, unavailableCount: 1 }).success).toBe(false);
    expect(AdCommandListSchema.safeParse({ ...value, nextCursor: items[0]!.id }).success).toBe(false);
  });

  it("keeps list and action receipts small and never accepts a private body authority snapshot or current balance", () => {
    for (const extra of [{ original: originals[0] }, { encryptedInput: "must-not-escape" }, { authoritySnapshot: {} },
      { balanceAfter: { amountMinor: 0 } }, { preview: { files: [] } }]) {
      expect(AdCommandSummarySchema.safeParse({ ...summary(), ...extra }).success).toBe(false);
      expect(AdCommandDetailSchema.safeParse({ ...prepared(), ...extra }).success).toBe(false);
    }
  });
});
