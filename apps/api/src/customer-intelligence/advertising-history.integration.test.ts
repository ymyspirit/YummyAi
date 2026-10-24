import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AdActionEventInputSchema, AdGoalFieldsSchema, AdImportInputSchema, AdObservationInputSchema, type AdActionView, type AdAnalysisRun, type AdExportView,
  type AdGoalVersion, type AdImportView, type AdObservation } from "@yummyai/contracts/advertising";
import { AdHistoryPageSchema, AdHistoryRecordResultSchema, type AdHistoryKind, type AdHistoryPage,
  type AdHistoryQuery } from "@yummyai/contracts/advertising/history";
import { adActions, connectDatabase, marketplaceAccounts, memberships, migrateDatabase, roles, withTenant } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { AdSourceGateway } from "./ad-source.gateway.js";
import { adHash } from "./ad-csv-parser.js";
import { advertisingReviewCsv } from "./ad-export.js";
import { AdvertisingService } from "./advertising.service.js";
import { listAdvertisingHistory, readAdvertisingHistory } from "./advertising-history.js";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_HISTORY_ISOLATED !== "1" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Advertising history requires its dedicated matching disposable database and bucket before connection");

const read = Permission.CustomerIntelligenceRead, write = Permission.CustomerIntelligenceWrite, review = Permission.CustomerIntelligenceReview;
const permissions = [read, write, review], key = () => `synthetic-history-${createEntityId()}`;
const tables = ["ad_import_batches", "ad_imports", "ad_facts", "ad_products", "ad_goal_versions", "ad_observations",
  "ad_analysis_runs", "ad_actions", "ad_action_events", "ad_import_events", "ad_exports", "audit_events"];
const header = "Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Purchases,Spend,Sales";
const csvRow = "2026-09-01 - 2026-09-15,synthetic-history,SP,campaign,group,USD,1000,40,4,10.00,40.00";
const sourceFiles = (prefix: string) => [
  { fileName: `${prefix}-campaign.csv`, content: `${header}\n${csvRow}` },
  { fileName: `${prefix}-product.csv`, content: `${header},Advertised ASIN\n${csvRow},B012345678` },
  { fileName: `${prefix}-target.csv`, content: `${header},Targeting ID,Targeting,Bid,State\n${csvRow},target,custom pillow,1.00,ENABLED` },
];
const scope = (accountId: string, asin = "B012345678") => ({ accountId, marketplace: "US" as const, currency: "USD", asin });
type Actor = { tenantId: string; userId: string; membershipId: string; roleId: string; wideRoleId: string };
type Scenario = { accountId: string; imports: AdImportView[]; goal: AdGoalVersion; observation: AdObservation;
  run: AdAnalysisRun; action: AdActionView; exported: AdExportView };

describe.sequential("advertising complete immutable history and own-operation recovery", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), audit = new AuditService(database);
  const service = new AdvertisingService(database, audit, new AdSourceGateway(storage, new ClamAvScanner()));
  const tenantId = createEntityId(), foreignTenantId = createEntityId();
  const actor = (tenant = tenantId): Actor => ({ tenantId: tenant, userId: createEntityId(), membershipId: createEntityId(), roleId: createEntityId(), wideRoleId: createEntityId() });
  const owner = actor(), coworker = actor(), foreign = actor(foreignTenantId), actors = [owner, coworker, foreign];
  const context = (value = owner, granted: readonly string[] = permissions): TenantContext => ({
    tenantId: value.tenantId, userId: value.userId, permissions: granted, dataScope: "tenant" });
  const a = context(), b = context(foreign), accounts: string[] = [];
  const imports: AdImportView[] = [], runs: AdAnalysisRun[] = [];
  let bigAccount: string, ownGoal: AdGoalVersion, ownObservation: AdObservation, ownAction: AdActionView;
  let sharedImport: AdImportView, sharedGoal: AdGoalVersion, sharedObservation: AdObservation, sharedRun: AdAnalysisRun;
  let other: Scenario, outside: Scenario, originalExport: AdExportView, crossRunExport: AdExportView;
  const goalInputs = new Map<string, Parameters<AdvertisingService["saveGoal"]>[1]>();
  const runInputs = new Map<string, Parameters<AdvertisingService["analyze"]>[1]>();
  const exportInputs = new Map<string, Parameters<AdvertisingService["sealExport"]>[1]>();

  async function grant(value = owner, granted: readonly string[] = permissions, dataScope: "tenant" | "self" | "team" = "tenant", wide: readonly string[] = []) {
    await withTenant(database.db, context(value), async tx => {
      await tx.update(roles).set({ permissions: granted, dataScope }).where(eq(roles.id, value.roleId));
      await tx.update(roles).set({ permissions: wide, dataScope: "tenant" }).where(eq(roles.id, value.wideRoleId));
    });
  }
  async function account(value = owner) {
    const id = createEntityId(); accounts.push(id);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon',$3,'NA','amazon_private',$4)",
      [id, value.tenantId, `Synthetic advertising history ${id}`, value.userId]);
    return id;
  }
  async function clock() {
    const [value] = await database.client.unsafe("select clock_timestamp() as now");
    return new Date(Math.max(Date.now(), new Date(value!.now).getTime())).toISOString();
  }
  async function commit(accountId: string, files = sourceFiles(key()), value = owner) {
    const input = AdImportInputSchema.parse({ accountId, files, marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
      attributionWindowDays: 7, attributionBasis: "click", conversionDefinition: { model: "click", source: "Synthetic report settings explicitly confirm click attribution" },
      observedAt: "2026-10-01T18:00:00.000Z", allowPartial: false, idempotencyKey: key() });
    const preview = await service.preview(context(value), input); expect(preview.canCommit).toBe(true);
    return (await service.commit(context(value), { ...input, previewChecksum: preview.previewChecksum })).imports;
  }
  async function goal(accountId: string, value = owner, asin?: string, expectedRevision = 0, cooldownDays = 30) {
    const input = { scope: scope(accountId, asin), expectedRevision, fields: AdGoalFieldsSchema.parse({
      mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100, unitPriceMinor: 10000, unitCostMinor: 7000,
      coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null, cooldownDays,
    }), idempotencyKey: key() };
    const saved = await service.saveGoal(context(value), input); goalInputs.set(saved.id, input); return saved;
  }
  async function observation(accountId: string, value = owner) {
    return service.recordObservation(context(value), AdObservationInputSchema.parse({ scope: scope(accountId), kind: "organic_rank", periodStart: "2026-09-15", periodEnd: "2026-09-15",
      source: "Synthetic actual original rank evidence", keyword: "custom pillow", organicRank: 8,
      totalSalesMinor: null, totalPurchases: null, preAdContributionMinor: null, observedAt: "2026-10-01T18:00:00.000Z", idempotencyKey: key() }));
  }
  async function analyze(accountId: string, value = owner) {
    const input = { accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null, currency: null,
      evidenceCutoffAt: await clock(), idempotencyKey: key() };
    const saved = await service.analyze(context(value), input); runInputs.set(saved.id, input); return saved;
  }
  async function transition(action: AdActionView, status: "adopted" | "deferred" | "pending" | "executed" | "observing" | "reviewed", value = owner) {
    return service.transition(context(value), action.id, AdActionEventInputSchema.parse({ expectedRevision: action.revision, expectedStatus: action.status, status,
      reason: `Synthetic actual ${status} evidence ${action.revision}`, idempotencyKey: key(),
      ...(status === "executed" ? { executedAt: await clock(), actualBeforeMinor: 100, actualAfterMinor: 85,
        executionCampaignId: action.recommendation.campaignId, executionAdGroupId: action.recommendation.adGroupId,
        executionTargetId: action.recommendation.targetId } : {}) }));
  }
  async function scenario(value: Actor): Promise<Scenario> {
    const accountId = await account(value), actualImports = await commit(accountId, sourceFiles(key()), value);
    const actualGoal = await goal(accountId, value), actualObservation = await observation(accountId, value), run = await analyze(accountId, value);
    const action = (await service.workspace(context(value), accountId)).actions.find(item => item.recommendation.kind === "lower_bid");
    expect(action).toBeDefined(); if (!action) throw new Error("Synthetic history bid action missing");
    const adopted = await transition(action, "adopted", value);
    const exportInput = { runId: run.id, actionIds: [adopted.id], reviewReason: "Synthetic reviewed original history checklist", idempotencyKey: key() };
    const exported = await service.sealExport(context(value), exportInput); exportInputs.set(exported.id, exportInput);
    return { accountId, imports: actualImports, goal: actualGoal, observation: actualObservation, run, action: adopted, exported };
  }
  async function history(kind: AdHistoryKind, accountId = bigAccount, ctx = a, parentId?: string, pageSize = 25, cursor?: string) {
    return AdHistoryPageSchema.parse(await service.history(ctx, { accountId, kind, pageSize, ...(parentId ? { parentId } : {}), ...(cursor ? { cursor } : {}) }));
  }
  async function record(kind: AdHistoryKind, id: string, accountId = bigAccount, ctx = a, parentId?: string) {
    return AdHistoryRecordResultSchema.parse(await service.record(ctx, id, { accountId, kind, ...(parentId ? { parentId } : {}) }));
  }
  async function all(kind: AdHistoryKind, accountId = bigAccount, ctx = a, parentId?: string, pageSize = 25) {
    const pages: AdHistoryPage[] = []; let cursor: string | undefined;
    do {
      const current = await history(kind, accountId, ctx, parentId, pageSize, cursor); pages.push(current);
      expect(current.requestCursor).toBe(cursor ?? null);
      expect(current.upperBound).toBe(pages[0]!.upperBound); expect(current.recordedBefore).toBe(pages[0]!.recordedBefore);
      if (pages.length > 500) throw new Error("Synthetic advertising pagination did not terminate");
      cursor = current.nextCursor ?? undefined;
    } while (cursor);
    const rows = pages.flatMap(page => page.rows);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length); expect(rows).toHaveLength(pages[0]!.count);
    expect(rows.map(row => row.id)).toEqual(rows.map(row => row.id).sort().reverse());
    expect(pages.at(-1)!.hasMore).toBe(false); return { pages, rows };
  }
  async function state(ctx = a) {
    return withTenant(database.db, ctx, async tx => {
      const result: Record<string, string> = {};
      for (const table of tables) {
        const [row] = await tx.execute(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by item.id)::text,'[]')) as digest from ${sql.raw(table)} item`);
        result[table] = String(row!.digest);
      }
      return result;
    });
  }

  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    for (const tenant of [tenantId, foreignTenantId])
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [tenant, `Synthetic ad history ${tenant}`, `ad-history-${tenant}`]);
    for (const value of actors) {
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [value.userId, `ad-history-${value.userId}`, `${value.userId}@yummyai.invalid`, `Synthetic history actor ${value.userId}`]);
      await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [value.membershipId, value.tenantId, value.userId]);
      for (const [id, granted] of [[value.roleId, permissions], [value.wideRoleId, []]] as const) {
        await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [id, value.tenantId, `Synthetic ad history role ${id}`, JSON.stringify(granted)]);
        await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [value.tenantId, value.membershipId, id]);
      }
    }
    bigAccount = await account();
    const files = [...sourceFiles("synthetic-history-original"), ...Array.from({ length: 198 }, (_, index) => ({
      fileName: `synthetic-history-${index}.csv`, content: `${header}\n${csvRow.replace(",campaign,", `,campaign-${index},`)}` }))];
    for (let index = 0; index < files.length; index += 20) imports.push(...await commit(bigAccount, files.slice(index, index + 20)));
    expect(imports).toHaveLength(201);
    sharedImport = (await commit(bigAccount, [{ fileName: "synthetic-shared-writer.csv", content: `${header}\n${csvRow.replace(",campaign,", ",coworker-campaign,")}` }], coworker))[0]!;
    sharedGoal = await goal(bigAccount, coworker, "B098765432"); sharedObservation = await observation(bigAccount, coworker); sharedRun = await analyze(bigAccount, coworker);
    ownGoal = await goal(bigAccount); ownObservation = await observation(bigAccount);
    for (let index = 0; index < 11; index++) runs.push(await analyze(bigAccount));
    const action = (await service.workspace(a, bigAccount)).actions.find(item => item.recommendation.kind === "lower_bid");
    if (!action) throw new Error("Synthetic full history original bid action missing");
    ownAction = action;
    for (let index = 0; index < 100; index++) ownAction = await transition(ownAction, index % 2 ? "pending" : "deferred", index % 3 ? owner : coworker);
    expect(ownAction.events).toHaveLength(101);
    ownAction = await transition(ownAction, "adopted");
    originalExport = await service.sealExport(a, { runId: ownAction.runId, actionIds: [ownAction.id], reviewReason: "Synthetic original immutable export before later changes", idempotencyKey: key() });
    ownAction = await transition(ownAction, "deferred"); ownAction = await transition(ownAction, "pending");
    other = await scenario(coworker); outside = await scenario(foreign);
    crossRunExport = await service.sealExport(a, { runId: other.run.id, actionIds: [other.action.id], reviewReason: "Synthetic tenant reviewer of another actor original run", idempotencyKey: key() });
  }, 180_000);

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(actors.map(async value => {
      try { await grant(value); }
      finally { await withTenant(database.db, context(value), tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, value.membershipId))); }
    }));
  });
  afterAll(async () => {
    try {
      const restored = await Promise.allSettled(actors.map(value => grant(value)));
      expect(restored.every(value => value.status === "fulfilled")).toBe(true);
      expect(new Set(accounts).size).toBe(accounts.length);
      // Immutable source/fact/event/audit history is deliberately kept inside
      // this exact nonce only. The disposable runner destroys its DB and bucket.
      console.info("Synthetic advertising history owned fixture", { tenantId, foreignTenantId, accountIds: accounts,
        imports: imports.length, runs: runs.length, actionId: ownAction?.id, eventCount: ownAction?.events.length });
    } finally { await database.client.end(); }
  });

  it("reads every actual import beyond 200 and every original analysis beyond ten without duplicates or omissions", async () => {
    const before = await state(), workspace = await service.workspace(a, bigAccount);
    expect(workspace.imports.length).toBeLessThanOrEqual(200); expect(workspace.analyses.length).toBeLessThanOrEqual(10);
    const imported = await all("imports", bigAccount, a, undefined, 25), analyzed = await all("analyses", bigAccount, a, undefined, 3);
    expect(imported.rows.map(row => row.id).sort()).toEqual([...imports.map(row => row.id), sharedImport.id].sort());
    expect(analyzed.rows.map(row => row.id).sort()).toEqual([...runs.map(row => row.id), sharedRun.id].sort());
    const oldestImport = imports.find(row => !workspace.imports.some(item => item.id === row.id));
    const oldestRun = runs.find(row => !workspace.analyses.some(item => item.id === row.id));
    expect(oldestImport).toBeDefined(); expect(oldestRun).toBeDefined();
    expect((await record("imports", oldestImport!.id)).record.value).toEqual(oldestImport);
    expect((await record("analyses", oldestRun!.id)).record.value).toEqual(oldestRun);
    expect(await state()).toEqual(before);
  });

  it("uses original ID order for genuine same-transaction timestamps without losing a tied row", async () => {
    const accountId = await account(), now = Date.now();
    try {
      // Fix only the synthetic application's Date while genuine scans, uploads
      // and the multi-file owner transaction run. No old created_at is edited.
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
      await commit(accountId);
    } finally { vi.useRealTimers(); }
    const rows = await withTenant(database.db, a, tx => tx.execute(sql`select id,created_at::text as exact_created_at from ad_imports
      where account_id=${accountId}::uuid order by id desc`));
    expect(rows).toHaveLength(3); expect(new Set(rows.map(row => row.exact_created_at)).size).toBe(1);
    expect((await all("imports", accountId, a, undefined, 1)).rows.map(row => row.id)).toEqual(rows.map(row => row.id));
  });

  it("fixes the original creation queue while exposing current projection changes and a fresh first page", async () => {
    const accountId = await account(), initial = await commit(accountId), first = await history("imports", accountId, a, undefined, 1);
    const newer = (await commit(accountId, [{ fileName: "synthetic-later-queue.csv", content: `${header}\n${csvRow.replace(",campaign,", ",later-campaign,")}` }]))[0]!;
    const target = initial.find(row => row.id !== first.rows[0]!.id)!;
    const archived = await service.archive(a, target.id, { reason: "Synthetic archive after the original history queue was fixed", idempotencyKey: key() });
    const next = await history("imports", accountId, a, undefined, 1, first.nextCursor!);
    expect(next.count).toBe(initial.length); expect(next.recordedBefore).toBe(first.recordedBefore);
    expect(next.rows.map(row => row.id)).not.toContain(newer.id);
    const detail = await record("imports", archived.id, accountId); expect(detail.record.value).toEqual(archived);
    expect((await history("imports", accountId)).rows.map(row => row.id)).toContain(newer.id);
  });

  it("rejects malformed, noncanonical and invented anchor cursors with a precise 400", async () => {
    const first = await history("imports", bigAccount, a, undefined, 1), cursor = first.nextCursor!;
    const envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const duplicate = Buffer.from(`{"v":1,${JSON.stringify(envelope).slice(1)}`).toString("base64url");
    const invalid = ["x", Buffer.from([0xff, 0xfe]).toString("base64url"),
      Buffer.from(JSON.stringify(envelope, null, 2)).toString("base64url"), duplicate,
      encode({ ...envelope, upperBound: createEntityId() }), encode({ ...envelope, afterId: createEntityId() }),
      encode({ ...envelope, recordedBefore: "2999-01-01T00:00:00.000000Z" })];
    const before = await state();
    // The global HTTP error filter maps strict Schema failures to 400; a direct
    // service call retains ZodError before reaching the cursor decoder.
    await expect(service.history(a, { accountId: bigAccount, kind: "imports", pageSize: 1, cursor: cursor + "=" })).rejects.toBeInstanceOf(ZodError);
    for (const value of invalid) await expect(service.history(a, { accountId: bigAccount, kind: "imports", pageSize: 1, cursor: value })).rejects.toMatchObject({ status: 400 });
    expect(await state()).toEqual(before);
  });

  it("binds cursors to actor, current authority, account, kind, page size and the actual event parent", async () => {
    const first = await history("imports", bigAccount, a, undefined, 1), cursor = first.nextCursor!;
    const query: AdHistoryQuery = { accountId: bigAccount, kind: "imports", pageSize: 1, cursor };
    for (const [ctx, change] of [[context(coworker), {}], [a, { accountId: other.accountId }], [a, { kind: "goals" }], [a, { pageSize: 2 }]] as const)
      await expect(service.history(ctx, { ...query, ...change })).rejects.toMatchObject({ status: 400 });
    const events = await history("action_events", bigAccount, a, ownAction.id, 1);
    await expect(service.history(a, { accountId: bigAccount, kind: "action_events", pageSize: 1, parentId: other.action.id, cursor: events.nextCursor! })).rejects.toMatchObject({ status: 404 });
    await grant(owner, [read]);
    await expect(service.history(a, query)).rejects.toMatchObject({ status: 400 });
  });

  it("keeps Read-only history independent of write and review permissions", async () => {
    await grant(owner, [read]); const ctx = context(owner, [read]), before = await state();
    for (const [kind, id] of [["imports", imports[0]!.id], ["goals", ownGoal.id], ["observations", ownObservation.id],
      ["analyses", runs[0]!.id], ["actions", ownAction.id], ["exports", originalExport.id]] as const) {
      expect((await history(kind, bigAccount, ctx)).accessMode).toBe("read");
      expect((await record(kind, id, bigAccount, ctx)).recordId).toBe(id);
    }
    expect(await state()).toEqual(before);
  });

  it("recovers only the current Write actor's original imports observations and parent archive events", async () => {
    const eventAccount = await account(), source = (await commit(eventAccount))[0]!;
    await service.archive(context(coworker), source.id, { reason: "Synthetic coworker archive of the original writer source", idempotencyKey: key() });
    await grant(owner, [write]); const ctx = context(owner, [write]), before = await state();
    const own = await all("imports", bigAccount, ctx); expect(own.rows).toHaveLength(201);
    expect(own.pages.every(page => page.accessMode === "own_write")).toBe(true);
    expect(own.rows.every(row => row.ownedByCurrentActor)).toBe(true);
    expect((await record("observations", ownObservation.id, bigAccount, ctx)).accessMode).toBe("own_write");
    await expect(record("imports", sharedImport.id, bigAccount, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(record("observations", sharedObservation.id, bigAccount, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(history("analyses", bigAccount, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(service.readSource(ctx, imports[0]!.id)).rejects.toMatchObject({ status: 403 });
    const events = await all("import_events", eventAccount, ctx, source.id, 1);
    expect(events.rows).toHaveLength(1); expect(events.rows[0]!.ownedByCurrentActor).toBe(true);
    expect((await record("import_events", events.rows[0]!.id, eventAccount, ctx, source.id)).accessMode).toBe("own_write");
    expect(await state()).toEqual(before);
  });

  it("recovers only original Review records and requires the original action or export run to belong to that actor", async () => {
    await grant(owner, [review]); const ctx = context(owner, [review]), before = await state();
    expect((await all("analyses", bigAccount, ctx)).rows.map(row => row.id).sort()).toEqual(runs.map(row => row.id).sort());
    for (const [kind, id] of [["goals", ownGoal.id], ["analyses", runs[0]!.id], ["actions", ownAction.id], ["exports", originalExport.id]] as const)
      expect((await record(kind, id, bigAccount, ctx)).accessMode).toBe("own_review");
    for (const [kind, id, accountId] of [["goals", sharedGoal.id, bigAccount], ["analyses", sharedRun.id, bigAccount],
      ["actions", other.action.id, other.accountId], ["exports", crossRunExport.id, other.accountId]] as const)
      await expect(record(kind, id, accountId, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(history("imports", bigAccount, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(service.facts(ctx, { accountId: bigAccount, page: 1, pageSize: 1, search: "" })).rejects.toMatchObject({ status: 403 });
    expect(await state()).toEqual(before);
  });

  it("keeps the complete parent-owned event timeline including another operator's actual transitions", async () => {
    await grant(owner, [review]); const ctx = context(owner, [review]), before = await state();
    const timeline = await all("action_events", bigAccount, ctx, ownAction.id, 25);
    expect(timeline.rows).toHaveLength(ownAction.events.length); expect(timeline.rows.length).toBeGreaterThanOrEqual(101);
    expect(timeline.rows.every(row => row.ownedByCurrentActor)).toBe(true);
    expect(timeline.rows.map(row => row.id).sort()).toEqual(ownAction.events.map(row => row.id).sort());
    for (const row of [timeline.rows[0]!, timeline.rows.at(-1)!]) {
      const item = await record("action_events", row.id, bigAccount, ctx, ownAction.id);
      expect(item.record.value).not.toHaveProperty("data"); expect(item.record.value).not.toHaveProperty("idempotencyKey");
    }
    const action = await record("actions", ownAction.id, bigAccount, ctx);
    if (action.record.kind !== "actions") throw new Error("Synthetic action result missing");
    expect(action.record.value.events).toEqual(ownAction.events);
    expect(await state()).toEqual(before);
  });

  it("reads the latest actual revision by original ID without rewriting older sealed export contents", async () => {
    const original = await record("exports", originalExport.id), immutable = adHash(originalExport.payload);
    ownAction = await transition(ownAction, "deferred");
    const current = await record("actions", ownAction.id);
    expect(current.record.value).toEqual(ownAction);
    expect((await record("exports", originalExport.id)).record).toEqual(original.record);
    expect(adHash(originalExport.payload)).toBe(immutable);
    ownAction = await transition(ownAction, "pending");
  });

  it("returns the original thirty-day goal rule to a Review-only actor and blocks premature review", async () => {
    const actual = await scenario(owner); let action = await transition(actual.action, "executed"); action = await transition(action, "observing");
    const execution = action.execution; expect(execution?.targetId).toBe(actual.action.recommendation.targetId);
    await grant(owner, [review]); const ctx = context(owner, [review]);
    const saved = await record("actions", action.id, actual.accountId, ctx);
    expect(saved.actionContext).toEqual({ goalVersionId: actual.goal.id, cooldownDays: 30, source: "saved_goal",
      reviewNotBefore: new Date(Date.parse(action.executedAt!) + 30 * 86400000).toISOString() });
    const before = await state();
    await expect(service.transition(ctx, action.id, AdActionEventInputSchema.parse({ expectedRevision: action.revision, expectedStatus: action.status,
      status: "reviewed", reason: "Synthetic premature thirty-day review", idempotencyKey: key() }))).rejects.toMatchObject({ status: 409 });
    const detail = await record("actions", action.id, actual.accountId, ctx);
    if (detail.record.kind !== "actions") throw new Error("Synthetic execution result missing");
    expect(detail.record.value.execution).toEqual(execution); expect(await state()).toEqual(before);
  });

  it("rechecks current membership and the request ceiling before every old cursor and exact ID read", async () => {
    const first = await history("imports", bigAccount, a, undefined, 1), before = await state();
    await grant(owner, []);
    await expect(history("imports", bigAccount, a, undefined, 1, first.nextCursor!)).rejects.toMatchObject({ status: 403 });
    await expect(record("imports", imports[0]!.id)).rejects.toMatchObject({ status: 403 });
    await grant(owner);
    await expect(history("imports", bigAccount, context(owner, []))).rejects.toMatchObject({ status: 403 });
    await withTenant(database.db, a, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, owner.membershipId)));
    await expect(record("analyses", runs[0]!.id)).rejects.toMatchObject({ status: 403 });
    expect(await state()).toEqual(before);
  });

  it("never lets tenant Read widen self or unbound-team operation recovery to another account", async () => {
    for (const dataScope of ["self", "team"] as const) {
      await grant(owner, [review], dataScope, [read]);
      // Tenant Read may inspect this account, while current Review still has
      // no ownership of its trusted account root.
      expect((await record("actions", other.action.id, other.accountId)).accessMode).toBe("read");
      await expect(record("actions", other.action.id, other.accountId, context(owner, [review]))).rejects.toMatchObject({ status: 404 });
    }
  });

  it("rejects account and parent mismatches and known foreign-tenant IDs while forced RLS hides their rows", async () => {
    const before = await state();
    await expect(record("imports", imports[0]!.id, other.accountId)).rejects.toMatchObject({ status: 404 });
    await expect(record("actions", other.action.id, bigAccount)).rejects.toMatchObject({ status: 404 });
    await expect(history("action_events", bigAccount, a, other.action.id)).rejects.toMatchObject({ status: 404 });
    await expect(record("imports", outside.imports[0]!.id, outside.accountId)).rejects.toMatchObject({ status: 404 });
    await expect(record("imports", imports[0]!.id, bigAccount, b)).rejects.toMatchObject({ status: 404 });
    const rows = await withTenant(database.db, a, tx => tx.select().from(adActions).where(eq(adActions.id, outside.action.id)));
    expect(rows).toEqual([]); expect(await state()).toEqual(before);
  });

  it("reads archived imports and a deleted account by their authorized exact IDs with no storage or fact rewrites", async () => {
    const actual = await scenario(owner), imported = actual.imports[0]!;
    const archived = await service.archive(a, imported.id, { reason: "Synthetic retained archive before account removal", idempotencyKey: key() });
    await withTenant(database.db, a, tx => tx.update(marketplaceAccounts).set({ status: "disabled", deletedAt: new Date() }).where(eq(marketplaceAccounts.id, actual.accountId)));
    const before = await state();
    expect((await record("imports", imported.id, actual.accountId)).record.value).toEqual(archived);
    expect((await record("analyses", actual.run.id, actual.accountId)).record.value).toEqual(actual.run);
    const events = await all("import_events", actual.accountId, a, imported.id, 1); expect(events.rows).toHaveLength(1);
    const saved = await record("import_events", events.rows[0]!.id, actual.accountId, a, imported.id);
    expect(saved.record.value).toMatchObject({ importId: imported.id, accountId: actual.accountId, status: "archived" });
    expect(await state()).toEqual(before);
  });

  it("rejects event IDs under a different parent and invalid record query fields instead of returning an empty success", async () => {
    const timeline = await history("action_events", bigAccount, a, ownAction.id, 1), eventId = timeline.rows[0]!.id;
    await expect(record("action_events", eventId, other.accountId, a, other.action.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.record(a, createEntityId(), { accountId: bigAccount, kind: "actions" })).rejects.toMatchObject({ status: 404 });
    for (const query of [{ accountId: bigAccount, kind: "imports", parentId: ownAction.id },
      { accountId: bigAccount, kind: "action_events" }, { accountId: bigAccount, kind: "imports", tenantId }])
      await expect(service.history(a, query as never)).rejects.toBeInstanceOf(ZodError);
  });

  it("uses the actual newer goal revision even when the application clock moved backwards", async () => {
    const accountId = await account(); await commit(accountId); const now = Date.now();
    let first: AdGoalVersion, second: AdGoalVersion;
    try {
      // Only Date is faked; database/network timers and all real owner checks
      // remain enabled. Two real writes reproduce the actual clock-order case.
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now + 60_000);
      first = await goal(accountId);
      vi.setSystemTime(now); second = await goal(accountId, owner, undefined, 1);
    } finally { vi.useRealTimers(); }
    expect(first!.createdAt > second!.createdAt).toBe(true); expect(second!.revision).toBe(2);
    const run = await analyze(accountId), action = (await service.workspace(a, accountId)).actions
      .find(item => item.runId === run.id && item.recommendation.kind === "lower_bid");
    expect(action?.recommendation.goalVersionId).toBe(second!.id);
    if (!action) throw new Error("Synthetic latest revision action missing");
    const adopted = await transition(action, "adopted"); expect(adopted.status).toBe("adopted");
    const before = await state(); expect((await service.saveGoal(a, goalInputs.get(first!.id)!)).id).toBe(first!.id);
    expect(await state()).toEqual(before);
  });

  it("hides cross-account parent event pollution inside the real tenant transaction without committing it", async () => {
    const before = await state(), eventId = createEntityId(), reason = "Synthetic cross-account event fixture must never be exposed";
    const rollback = new Error("synthetic-history-cross-account-fixture-rollback");
    await expect(withTenant(database.db, a, async tx => {
      // Old tenant-only FKs can represent this contradictory fixture. Neither
      // the history parent lookup nor exact-ID lookup may make it visible.
      await tx.execute(sql`insert into ad_action_events(id,tenant_id,account_id,created_by,action_id,status,reason,data,idempotency_key,input_checksum)
        values(${eventId}::uuid,${tenantId}::uuid,${other.accountId}::uuid,${owner.userId}::uuid,${ownAction.id}::uuid,
          'deferred',${reason},'{}'::jsonb,${key()},${adHash([eventId, "synthetic-parent-pollution"])})`);
      const page = await listAdvertisingHistory(tx, a, { accountId: bigAccount, kind: "action_events", parentId: ownAction.id, pageSize: 100 });
      expect(page.rows.map(row => row.id)).not.toContain(eventId);
      await expect(readAdvertisingHistory(tx, a, eventId, { accountId: bigAccount, kind: "action_events", parentId: ownAction.id })).rejects.toMatchObject({ status: 404 });
      await expect(readAdvertisingHistory(tx, a, eventId, { accountId: other.accountId, kind: "action_events", parentId: ownAction.id })).rejects.toMatchObject({ status: 404 });
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await state()).toEqual(before);
  });

  it("refuses a tenant-only FK action from another account run and a selected run containing another account source", async () => {
    const actual = await scenario(owner), crossActionId = createEntityId(), badRunId = createEntityId(), badActionId = createEntityId();
    const crossKey = adHash([crossActionId, "synthetic-cross-account-run"]), badKey = adHash([badActionId, "synthetic-cross-account-source"]);
    const crossRec = { ...actual.action.recommendation, key: crossKey }, badRec = { ...actual.action.recommendation, key: badKey };
    const originalInput = runInputs.get(actual.run.id)!;
    const badResult = { ...actual.run.result, recommendations: [badRec], evidenceImportIds: [other.imports[0]!.id],
      measurementPins: actual.run.result.measurementPins?.slice(0, 1).map(pin => ({ ...pin, importId: other.imports[0]!.id, sourceChecksum: other.imports[0]!.checksum })) };
    // Explicit contradictory SQL fixtures test the historical tenant-only FK
    // boundary. They are never presented as real analyzed/approved evidence.
    await withTenant(database.db, a, async tx => {
      await tx.execute(sql`insert into ad_actions(id,tenant_id,account_id,created_by,run_id,recommendation_key,recommendation,status,revision)
        values(${crossActionId}::uuid,${tenantId}::uuid,${actual.accountId}::uuid,${owner.userId}::uuid,${other.run.id}::uuid,
          ${crossKey},${JSON.stringify(crossRec)}::jsonb,'pending',1)`);
      await tx.execute(sql`insert into ad_analysis_runs(id,tenant_id,account_id,created_by,input,input_checksum,idempotency_key,result,status)
        values(${badRunId}::uuid,${tenantId}::uuid,${actual.accountId}::uuid,${owner.userId}::uuid,${JSON.stringify(originalInput)}::jsonb,
          ${adHash([badRunId, "synthetic-input"])},${key()},${JSON.stringify(badResult)}::jsonb,'partial')`);
      await tx.execute(sql`insert into ad_actions(id,tenant_id,account_id,created_by,run_id,recommendation_key,recommendation,status,revision)
        values(${badActionId}::uuid,${tenantId}::uuid,${actual.accountId}::uuid,${owner.userId}::uuid,${badRunId}::uuid,
          ${badKey},${JSON.stringify(badRec)}::jsonb,'adopted',1)`);
    });
    const before = await state();
    await expect(record("actions", crossActionId, actual.accountId)).rejects.toMatchObject({ status: 404 });
    await expect(service.transition(a, crossActionId, AdActionEventInputSchema.parse({ expectedRevision: 1, expectedStatus: "pending", status: "adopted",
      reason: "Synthetic cross-run admission must be refused", idempotencyKey: key() }))).rejects.toMatchObject({ status: 404 });
    await expect(service.transition(a, badActionId, AdActionEventInputSchema.parse({ expectedRevision: 1, expectedStatus: "adopted", status: "executed",
      reason: "Synthetic foreign source execution must be refused", executedAt: await clock(), actualBeforeMinor: 100, actualAfterMinor: 85,
      executionCampaignId: badRec.campaignId, executionAdGroupId: badRec.adGroupId, executionTargetId: badRec.targetId, idempotencyKey: key() }))).rejects.toMatchObject({ status: 409 });
    await expect(service.sealExport(a, { runId: badRunId, actionIds: [badActionId], reviewReason: "Synthetic foreign source export must be refused", idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
  });

  it("scale: reads beyond 10000 goal observation and action rows without making workspace or exact owner operations scan a capped whole history", async () => {
    const actual = await scenario(owner), scaleGoal = await goal(actual.accountId, owner, "B098765432");
    const fixtureIds = () => {
      const prefix = createEntityId().slice(0, 24);
      return Array.from({ length: 10000 }, (_, index) => prefix + (index + 1).toString(16).padStart(12, "0"));
    };
    const goalIds = fixtureIds(), productIds = fixtureIds(), observationIds = fixtureIds(), actionIds = fixtureIds();
    // These additional rows are an explicitly authorized synthetic SQL scale
    // fixture, not claimed to be 30000 real operator approvals. The supporting
    // account/product/run/source and the workflow below come from real owners.
    await withTenant(database.db, a, async tx => {
      await tx.execute(sql`insert into ad_products(id,tenant_id,account_id,created_by,marketplace,currency,asin,revision)
        select seed.id,${tenantId}::uuid,${actual.accountId}::uuid,${owner.userId}::uuid,'US','USD',concat('B',lpad(seed.ordinality::text,9,'0')),1
        from unnest(string_to_array(${productIds.join(",")},',')::uuid[]) with ordinality seed(id,ordinality)`);
      await tx.execute(sql`insert into ad_goal_versions(id,tenant_id,account_id,created_by,product_id,revision,fields,checksum,idempotency_key,input_checksum)
        select seed.id,source.tenant_id,source.account_id,source.created_by,seed.product_id,1,source.fields,source.checksum,
          concat('synthetic-history-scale-goal-',seed.id),encode(sha256(convert_to(seed.id::text,'UTF8')),'hex')
        from unnest(string_to_array(${goalIds.join(",")},',')::uuid[],string_to_array(${productIds.join(",")},',')::uuid[]) seed(id,product_id)
        cross join ad_goal_versions source where source.id=${scaleGoal.id}::uuid`);
      await tx.execute(sql`insert into ad_observations(id,tenant_id,account_id,created_by,data,idempotency_key,input_checksum)
        select seed.id,source.tenant_id,source.account_id,source.created_by,source.data,concat('synthetic-history-scale-observation-',seed.id),
          encode(sha256(convert_to(seed.id::text,'UTF8')),'hex')
        from unnest(string_to_array(${observationIds.join(",")},',')::uuid[]) seed(id)
        cross join ad_observations source where source.id=${actual.observation.id}::uuid`);
      await tx.execute(sql`insert into ad_actions(id,tenant_id,account_id,created_by,run_id,recommendation_key,recommendation,status,revision)
        select seed.id,source.tenant_id,source.account_id,source.created_by,source.run_id,
          encode(sha256(convert_to(seed.id::text,'UTF8')),'hex'),
          jsonb_set(source.recommendation,'{key}',to_jsonb(encode(sha256(convert_to(seed.id::text,'UTF8')),'hex'))),'pending',1
        from unnest(string_to_array(${actionIds.join(",")},',')::uuid[]) seed(id)
        cross join ad_actions source where source.id=${actual.action.id}::uuid`);
    });
    const before = await state(), workspace = await service.workspace(a, actual.accountId);
    for (const kind of ["goals", "observations", "actions"] as const) {
      expect(workspace[kind].length).toBeLessThanOrEqual(200);
      expect(workspace.historyWindow?.[kind]).toMatchObject({ loaded: 200, limit: 200, hasMore: true });
      const first = await history(kind, actual.accountId, a, undefined, 100);
      expect(first.count).toBeGreaterThan(10000); expect(first.hasMore).toBe(true);
      const table = { goals: "ad_goal_versions", observations: "ad_observations", actions: "ad_actions" }[kind];
      const tail = await withTenant(database.db, a, tx => tx.execute<{ id: string }>(sql`select id from ${sql.raw(table)}
        where account_id=${actual.accountId}::uuid order by id asc limit 2`));
      // Cursors are a canonical range, not an authorization capability. Use two
      // real authorized anchors to inspect the actual last row at this scale.
      const envelope = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
      const cursor = Buffer.from(JSON.stringify({ ...envelope, afterId: tail[1]!.id })).toString("base64url");
      const last = await history(kind, actual.accountId, a, undefined, 100, cursor);
      expect(last.count).toBe(first.count); expect(last.rows.map(row => row.id)).toEqual([tail[0]!.id]); expect(last.hasMore).toBe(false);
      expect((await record(kind, tail[0]!.id, actual.accountId)).recordId).toBe(tail[0]!.id);
    }
    expect((await service.saveGoal(a, goalInputs.get(actual.goal.id)!)).id).toBe(actual.goal.id);
    expect((await service.analyze(a, runInputs.get(actual.run.id)!)).id).toBe(actual.run.id);
    expect(await service.sealExport(a, exportInputs.get(actual.exported.id)!)).toEqual(actual.exported);
    expect(await state()).toEqual(before);
    const executed = await transition(actual.action, "executed"); expect(executed.execution?.targetId).toBe(actual.action.recommendation.targetId);
    const observed = await transition(executed, "observing");
    const sealed = await service.sealExport(a, { runId: actual.run.id, actionIds: [observed.id],
      reviewReason: "Synthetic exact selected action export beyond scale history", idempotencyKey: key() });
    expect(sealed.payload.actions[0]!.events).toHaveLength(observed.events.length);
    expect(advertisingReviewCsv(await service.readExport(a, sealed.id))).toBe(advertisingReviewCsv(sealed));
    console.info("Synthetic advertising history scale support", { accountId: actual.accountId, runId: actual.run.id,
      goalIds: [goalIds[0], goalIds.at(-1)], productIds: [productIds[0], productIds.at(-1)],
      observationIds: [observationIds[0], observationIds.at(-1)], actionIds: [actionIds[0], actionIds.at(-1)],
      syntheticRowsPerKind: 10000 });
  }, 90_000);
});
