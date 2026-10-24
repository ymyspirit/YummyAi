import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AdGoalFieldsSchema, AdImportInputSchema, adCurrencyBasis, type AdAnalysisInput, type AdAnalysisRun, type AdCommitImport,
  type AdExportView, type AdGoalVersion, type AdImportInput } from "@yummyai/contracts/advertising";
import { adAnalysisRuns, adExports, adFacts, adGoalVersions, adImports, connectDatabase, memberships, migrateDatabase,
  roles, withTenant } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { AdSourceGateway } from "./ad-source.gateway.js";
import { AdvertisingService } from "./advertising.service.js";
import { adHash, readAdCsv } from "./ad-csv-parser.js";
import { advertisingReviewCsv } from "./ad-export.js";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_MEASUREMENT_ISOLATED !== "1" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Advertising measurement requires its dedicated matching disposable database and bucket before connection");

const permissions = [Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview];
const key = () => `synthetic-measurement-${createEntityId()}`;
const tables = ["ad_import_batches", "ad_imports", "ad_facts", "ad_products", "ad_goal_versions", "ad_observations",
  "ad_analysis_runs", "ad_actions", "ad_action_events", "ad_import_events", "ad_exports", "audit_events"];
const definition = { model: "click" as const, source: "Synthetic actual report configuration confirms click attribution" };
const header = "Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Spend";
const row = "2026-09-01 - 2026-09-15,synthetic-measurement,SP,campaign,group,USD,1000,40,10.00";
const basic = (name = key(), amount = "20.00") => ({ fileName: `${name}.csv`, content: `${header},Purchases,Sales\n${row},2,${amount}` });
const bundle = () => [basic(),
  { fileName: `${key()}-product.csv`, content: `${header},Advertised ASIN,Purchases,Sales\n${row},B012345678,2,100.00` },
  { fileName: `${key()}-search.csv`, content: `${header},Customer Search Term,Purchases,Sales\n${row},unrelated synthetic term,0,0.00` }];
type ImportFiles = z.input<typeof AdImportInputSchema>["files"];
type LegacySeed = { original: AdCommitImport; saved: Awaited<ReturnType<AdvertisingService["commit"]>>; goal: AdGoalVersion;
  runInput: AdAnalysisInput; run: AdAnalysisRun; exported: AdExportView };

describe.sequential("advertising immutable measurement evidence and current owners", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), audit = new AuditService(database);
  const gateway = new AdSourceGateway(storage, new ClamAvScanner()), service = new AdvertisingService(database, audit, gateway);
  const tenantId = createEntityId(), foreignTenantId = createEntityId();
  const actor = (tenant = tenantId) => ({ tenantId: tenant, userId: createEntityId(), roleId: createEntityId(), membershipId: createEntityId() });
  const owner = actor(), foreign = actor(foreignTenantId), actors = [owner, foreign];
  const context = (value = owner): TenantContext => ({ tenantId: value.tenantId, userId: value.userId, permissions, dataScope: "tenant" });
  const a = context(), b = context(foreign), accountIds: string[] = [], children: InvoiceProcess[] = [];
  function input(accountId: string, files: ImportFiles = [basic()], overrides: Partial<AdImportInput> = {}) {
    return AdImportInputSchema.parse({ accountId, files, marketplaceByCurrency: { USD: "US", CAD: "CA", JPY: "JP" },
      timezone: "America/Los_Angeles", attributionWindowDays: 7, attributionBasis: "click", conversionDefinition: definition,
      observedAt: "2026-10-01T18:00:00.000Z", dateOrder: null, allowPartial: false, idempotencyKey: key(), ...overrides });
  }
  async function account(value = owner) {
    const id = createEntityId(); accountIds.push(id);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon',$3,'NA','amazon_private',$4)",
      [id, value.tenantId, `Synthetic measurement account ${id}`, value.userId]);
    return id;
  }
  async function grant(value = owner, granted: readonly string[] = permissions) {
    await withTenant(database.db, context(value), tx => tx.update(roles).set({ permissions: granted }).where(eq(roles.id, value.roleId)));
  }
  async function state(ctx = a) {
    return withTenant(database.db, ctx, async tx => {
      const result: Record<string, string> = {};
      for (const table of tables) {
        const rows = await tx.execute(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by item.id)::text,'[]')) as digest from ${sql.raw(table)} item`);
        result[table] = String(rows[0]!.digest);
      }
      return result;
    });
  }
  async function commit(original: AdImportInput, ctx = a) {
    const preview = await service.preview(ctx, original); expect(preview.canCommit).toBe(true);
    const body = { ...original, previewChecksum: preview.previewChecksum };
    return { preview, body, saved: await service.commit(ctx, body) };
  }
  async function facts(accountId: string) {
    return (await service.facts(a, { accountId, search: "", page: 1, pageSize: 200 })).rows;
  }
  async function cutoff() {
    const rows = await database.client.unsafe("select clock_timestamp() as now");
    return new Date(Math.max(Date.now(), new Date(rows[0]!.now).getTime())).toISOString();
  }
  async function runInput(accountId: string) {
    return { accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null, currency: null,
      evidenceCutoffAt: await cutoff(), idempotencyKey: key() };
  }
  function goalInput(accountId: string, currency = "USD") {
    return { scope: { accountId, marketplace: "US" as const, currency, asin: "B012345678" }, expectedRevision: 0,
      fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2000,
        unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null,
        trialSpendLimitMinor: null, minimumPurchases: 2 }), idempotencyKey: key() };
  }
  async function oldRows(seed: LegacySeed) {
    const ids = seed.saved.imports.map(value => value.id);
    return withTenant(database.db, a, async tx => ({
      imports: await tx.select().from(adImports).where(inArray(adImports.id, ids)).orderBy(adImports.id),
      facts: await tx.select().from(adFacts).where(inArray(adFacts.importId, ids)).orderBy(adFacts.id),
      goals: await tx.select().from(adGoalVersions).where(eq(adGoalVersions.id, seed.goal.id)),
      runs: await tx.select().from(adAnalysisRuns).where(eq(adAnalysisRuns.id, seed.run.id)),
      exports: await tx.select().from(adExports).where(eq(adExports.id, seed.exported.id)),
    }));
  }
  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    for (const tenant of [tenantId, foreignTenantId])
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [tenant, `Synthetic advertising measurement ${tenant}`, `measurement-${tenant}`]);
    for (const value of actors) {
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [value.userId, `measurement-${value.userId}`, `${value.userId}@yummyai.invalid`, `Synthetic measurement actor ${value.userId}`]);
      await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [value.membershipId, value.tenantId, value.userId]);
      await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
        [value.roleId, value.tenantId, `Synthetic measurement role ${value.roleId}`, JSON.stringify(permissions)]);
      await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [value.tenantId, value.membershipId, value.roleId]);
    }
  });
  beforeEach(async () => { vi.restoreAllMocks(); for (const value of actors) await grant(value); });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const value of actors) {
      await grant(value);
      await withTenant(database.db, context(value), tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, value.membershipId)));
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      const stopped = await Promise.allSettled(children.map(child => child.stop(true)));
      if (stopped.some(result => result.status === "rejected")) throw new Error("Synthetic legacy advertising child cleanup incomplete");
      for (const value of actors) {
        await database.client.unsafe("delete from membership_roles where tenant_id=$1 and membership_id=$2 and role_id=$3", [value.tenantId, value.membershipId, value.roleId]);
        await database.client.unsafe("delete from roles where tenant_id=$1 and id=$2", [value.tenantId, value.roleId]);
        await database.client.unsafe("delete from memberships where tenant_id=$1 and id=$2", [value.tenantId, value.membershipId]);
      }
      expect(new Set(accountIds).size).toBe(accountIds.length);
      // The runner destroys this exact nonce database/bucket, including all
      // immutable actual import, analysis, source and audit fixture histories.
    } finally { await database.client.end(); }
  }, 30_000);

  it("keeps actual customer search terms distinct from their original targeting expression", async () => {
    const id = await account();
    const csv = `${header},Targeting,Customer Search Term,7 Day Total Orders (#),7 Day Total Sales ($)\n` +
      `${row},custom pillow,custom dog pillow,1,20.00\n${row},custom pillow,custom cat pillow,2,50.00`;
    const saved = await commit(input(id, [{ fileName: "synthetic-search-and-target.csv", content: csv }]));
    expect(saved.preview.files[0]).toMatchObject({ reportType: "search_term", acceptedRowCount: 2, rejectedRowCount: 0 });
    const rows = await facts(id); expect(rows).toHaveLength(2);
    expect(rows.map(value => value.fact.term).sort()).toEqual(["custom cat pillow", "custom dog pillow"]);
    expect(new Set(rows.map(value => value.fact.entityKey)).size).toBe(2);
    expect(rows.every(value => value.fact.sourceFields.Targeting === "custom pillow")).toBe(true);
    expect(Buffer.from((await service.readSource(a, saved.saved.imports[0]!.id)).bytes).toString("utf8")).toBe(csv);
  });

  it("pins the explicitly selected fourteen-day pair through preview storage facts and same-key replay", async () => {
    const id = await account(), original = input(id, [{ fileName: "synthetic-two-windows.csv",
      content: `${header},7 Day Total Orders (#),14 Day Total Orders (#),7 Day Total Sales ($),14 Day Total Sales ($)\n${row},1,2,20.00,50.00`,
      metricColumns: { purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" } }], { attributionWindowDays: 14 });
    const saved = await commit(original), before = await state(), [fact] = await facts(id);
    expect(saved.preview.files[0]!.measurement?.columns).toMatchObject({ purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" });
    expect(fact!.fact).toMatchObject({ metrics: { purchases: 2, salesMinor: 5000 }, measurement: { conversion: { state: "resolved", windowDays: 14, model: "click" },
      monetaryBasis: { currency: "USD", minorDigits: 2 } } });
    expect(saved.saved.imports[0]!.measurement).toEqual(saved.preview.files[0]!.measurement);
    expect((await service.commit(a, saved.body)).imports).toEqual(saved.saved.imports);
    expect(await state()).toEqual(before);
  });

  it("refuses stale preview settings and a recycled key with a different actual column selection without writes", async () => {
    const id = await account(), file = { fileName: "synthetic-fixed-columns.csv", content: `${header},7 Day Total Orders (#),14 Day Total Orders (#),7 Day Total Sales ($),14 Day Total Sales ($)\n${row},1,2,20.00,50.00`,
      metricColumns: { purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" } };
    const first = await commit(input(id, [file], { attributionWindowDays: 14 })), before = await state();
    const changed = input(id, [{ ...file, metricColumns: { purchases: "7 Day Total Orders (#)", salesMinor: "7 Day Total Sales ($)" } }],
      { attributionWindowDays: 7, idempotencyKey: first.body.idempotencyKey });
    await expect(service.commit(a, { ...changed, previewChecksum: first.preview.previewChecksum })).rejects.toMatchObject({ status: 409 });
    const preview = await service.preview(a, changed);
    await expect(service.commit(a, { ...changed, previewChecksum: preview.previewChecksum })).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
  });

  it("binds allowPartial to the reviewed preview and requires a new explicit preview before committing mixed valid and invalid rows", async () => {
    const id = await account(), file = { fileName: "synthetic-partial-preview-binding.csv",
      content: `${header},Purchases,Sales\n${row},2,20.00\n${row.replace(",10.00", ",not-a-money")},2,20.00` };
    const original = input(id, [file], { allowPartial: false });
    const store = vi.spyOn(gateway, "store"), objectWrite = vi.spyOn(storage, "putPrivate");
    const blocked = await service.preview(a, original);
    expect(blocked.canCommit).toBe(false);
    expect(blocked.files[0]).toMatchObject({ sourceRowCount: 2, acceptedRowCount: 1, rejectedRowCount: 1 });
    expect(blocked.files[0]!.diagnostics.some(value => value.severity === "error")).toBe(true);
    const before = await state();
    await expect(service.commit(a, { ...original, allowPartial: true, previewChecksum: blocked.previewChecksum })).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
    expect(store).not.toHaveBeenCalled(); expect(objectWrite).not.toHaveBeenCalled();
    const approved = await service.preview(a, { ...original, allowPartial: true });
    expect(approved.previewChecksum).not.toBe(blocked.previewChecksum);
    expect(approved.canCommit).toBe(true);
    expect(approved.files[0]).toMatchObject({ sourceRowCount: 2, acceptedRowCount: 1, rejectedRowCount: 1 });
    expect(await state()).toEqual(before); expect(objectWrite).not.toHaveBeenCalled();
    const saved = await service.commit(a, { ...original, allowPartial: true, previewChecksum: approved.previewChecksum });
    expect(saved.replayed).toBe(false); expect(saved.imports).toHaveLength(1);
    expect(saved.imports[0]).toMatchObject({ sourceRowCount: 2, acceptedRowCount: 1, rejectedRowCount: 1 });
    expect(store).toHaveBeenCalledTimes(1); expect(objectWrite).toHaveBeenCalledTimes(1);
    const rows = await facts(id); expect(rows).toHaveLength(1); expect(rows[0]!.fact.metrics.spendMinor).toBe(1000);
    expect(Buffer.from((await service.readSource(a, saved.imports[0]!.id)).bytes).toString("utf8")).toBe(file.content);
  });

  it.each([false, true])("does not commit conflicting seven/fourteen-day conversions even with allowPartial=%s", async allowPartial => {
    const id = await account(), original = input(id, [{ fileName: "synthetic-conflicting-windows.csv",
      content: `${header},7 Day Total Orders (#),14 Day Total Sales ($)\n${row},1,50.00` }], { allowPartial });
    const before = await state(), preview = await service.preview(a, original);
    expect(preview.files[0]!.measurement?.conversion.state).toBe("conflict");
    expect(preview.files[0]!.diagnostics.map(value => value.code)).toContain("CONVERSION_WINDOW_CONFLICT");
    expect(preview.files[0]!.sample[0]!.sourceFields["14 Day Total Sales ($)"]).toBe("50.00");
    expect(preview.canCommit).toBe(false);
    await expect(service.commit(a, { ...original, previewChecksum: preview.previewChecksum })).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
  });

  it.each([["JPY", "12", 12, 0], ["KWD", "1.234", 1234, 3], ["CLF", "1.2345", 12345, 4]] as const)(
    "stores %s original values with exact pinned precision rather than cents", async (currency, amount, expected, minorDigits) => {
      const id = await account(), csv = `${header},Purchases,Sales\n${row.replace(",USD,", `,${currency},`).replace(",10.00", `,${amount}`)},2,${amount}`;
      const saved = await commit(input(id, [{ fileName: `synthetic-${currency}.csv`, content: csv }]));
      const [fact] = await facts(id);
      expect(fact!.fact).toMatchObject({ currency, metrics: { spendMinor: expected, salesMinor: expected }, measurement: {
        monetaryBasis: { currency, minorDigits, currencyTableVersion: "iso4217-2026-09-17-v1" } } });
      expect(saved.saved.imports[0]!.measurement?.currencies).toEqual([{ schemaVersion: 1, currency, minorDigits, currencyTableVersion: "iso4217-2026-09-17-v1" }]);
    });

  it("keeps unknown-precision source cells and counts while withholding normalized money and conversion decisions", async () => {
    const id = await account(), csv = `${header},Purchases,Sales\n${row.replace(",USD,", ",ZZZ,")},2,123.456`;
    const saved = await commit(input(id, [{ fileName: "synthetic-unknown-currency.csv", content: csv }]));
    const [fact] = await facts(id);
    expect(fact!.fact).toMatchObject({ currency: "ZZZ", metrics: { clicks: 40, purchases: 2, spendMinor: null, salesMinor: null },
      sourceFields: { Spend: "10.00", Sales: "123.456" }, measurement: { monetaryBasis: null } });
    expect(saved.saved.imports[0]!.diagnostics.map(value => value.code)).toContain("CURRENCY_PRECISION_UNKNOWN");
    const run = await service.analyze(a, await runInput(id));
    expect(run.result.totals.every(value => value.metrics.spendMinor === null && value.metrics.salesMinor === null && value.ratios.acosBps === null)).toBe(true);
    expect(run.result.recommendations.every(value => value.kind === "watch")).toBe(true);
  });

  it("rejects contradictory currency tokens without creating a normalized currency or losing the preview's original cell", async () => {
    const id = await account(), original = input(id, [{ fileName: "synthetic-currency-contradiction.csv", content: `${header},Purchases,Sales\n${row.replace(",10.00", ",CAD 10.00")},2,20.00` }]);
    const before = await state(), preview = await service.preview(a, original);
    expect(preview.canCommit).toBe(false); expect(preview.files[0]!.rejectedRowCount).toBe(1);
    expect(preview.files[0]!.diagnostics.some(value => value.severity === "error")).toBe(true);
    await expect(service.commit(a, { ...original, previewChecksum: preview.previewChecksum })).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
  });

  it("creates a new interpretation of the same CSV for a new definition and never sums separate models or currencies", async () => {
    const id = await account(), file = basic("synthetic-same-bytes"), first = await commit(input(id, [file]));
    const firstFact = (await facts(id))[0]!;
    const view = await commit(input(id, [file], { attributionBasis: "click_and_view",
      conversionDefinition: { model: "legacy_click_and_view", source: "Synthetic source explicitly confirms historical click and view attribution" } }));
    expect(first.preview.previewChecksum).not.toBe(view.preview.previewChecksum);
    expect(first.saved.imports[0]!.checksum).toBe(view.saved.imports[0]!.checksum);
    expect(first.saved.imports[0]!.id).not.toBe(view.saved.imports[0]!.id);
    const cad = basic("synthetic-cad"); cad.content = cad.content.replace(",USD,", ",CAD,");
    await commit(input(id, [cad]));
    expect((await facts(id)).find(value => value.id === firstFact.id)).toEqual(firstFact);
    const run = await service.analyze(a, await runInput(id));
    expect(run.result.totals).toHaveLength(3);
    expect(run.result.totals.map(value => [value.currency, value.metrics.spendMinor]).sort()).toEqual([["CAD", 1000], ["USD", 1000], ["USD", 1000]]);
    expect(run.result.measurementPins?.map(value => value.currency).sort()).toEqual(["CAD", "USD", "USD"]);
  });

  it("requires genuinely mature collection evidence instead of allowing a later analysis date to mature the same captured CSV", async () => {
    const id = await account(), files = bundle();
    await service.saveGoal(a, goalInput(id));
    const early = await commit(input(id, files, { observedAt: "2026-09-16T18:00:00.000Z" }));
    const unchanged = await facts(id), first = await service.analyze(a, await runInput(id));
    expect(first.result.recommendations.some(value => value.kind === "negate_term")).toBe(false);
    expect(first.result.recommendations.some(value => value.ruleId === "AD_ATTRIBUTION_PENDING")).toBe(true);
    const recollected = await commit(input(id, files, { observedAt: "2026-09-24T18:00:00.000Z" }));
    expect(recollected.saved.imports[0]!.checksum).toBe(early.saved.imports[0]!.checksum);
    const mature = await service.analyze(a, await runInput(id));
    expect(mature.result.recommendations.some(value => value.kind === "negate_term")).toBe(true);
    const storedOld = await withTenant(database.db, a, tx => tx.select().from(adFacts).where(inArray(adFacts.id, unchanged.map(value => value.id))).orderBy(adFacts.id));
    expect(storedOld.map(value => value.fact)).toEqual([...unchanged].sort((left, right) => left.id.localeCompare(right.id)).map(value => value.fact));
  });

  it("reproduces an old evidence cutoff after later archival while issuing only watch actions and preserving the original sealed result", async () => {
    const id = await account(); await service.saveGoal(a, goalInput(id));
    const saved = await commit(input(id, bundle())), originalInput = await runInput(id), original = await service.analyze(a, originalInput);
    expect(original.result.recommendations.some(value => value.kind === "negate_term")).toBe(true);
    const digest = adHash(original.result);
    for (const source of saved.saved.imports) await service.archive(a, source.id, { reason: "Synthetic later archival Original source remains immutable", idempotencyKey: key() });
    const current = await service.analyze(a, { ...originalInput, idempotencyKey: key() });
    expect(current.result.totals).toEqual(original.result.totals);
    expect(current.result.selectedFactCount).toBe(original.result.selectedFactCount);
    expect([...current.result.evidenceImportIds].sort()).toEqual([...original.result.evidenceImportIds].sort());
    expect(current.result.recommendations.every(value => value.kind === "watch")).toBe(true);
    expect(current.result.diagnostics.map(value => value.code)).toContain("SOURCE_ARCHIVED_NOW");
    expect(adHash((await service.analyze(a, originalInput)).result)).toBe(digest);
    const databaseRow = await withTenant(database.db, a, tx => tx.select().from(adAnalysisRuns).where(eq(adAnalysisRuns.id, original.id)));
    expect(adHash(databaseRow[0]!.result)).toBe(digest);
  });

  it("pins goal and commerce amounts to actual currency precision and rolls both back with a failed audit", async () => {
    const id = await account(), goalBody = goalInput(id), goal = await service.saveGoal(a, goalBody);
    expect(goal.fields.monetaryBasis).toEqual(adCurrencyBasis("USD"));
    const commerce = { scope: goal.scope, kind: "commerce" as const, periodStart: "2026-09-01", periodEnd: "2026-09-15",
      source: "Synthetic complete commerce evidence", keyword: null, organicRank: null, totalSalesMinor: 50000, totalPurchases: 12,
      preAdContributionMinor: 12000, adsCoverageConfirmed: true, observedAt: "2026-10-01T18:00:00.000Z", idempotencyKey: key() };
    const recorded = await service.recordObservation(a, commerce);
    expect(recorded.monetaryBasis).toEqual(adCurrencyBasis("USD"));
    const replayState = await state();
    expect((await service.saveGoal(a, goalBody)).id).toBe(goal.id);
    expect((await service.recordObservation(a, commerce)).id).toBe(recorded.id);
    expect(await state()).toEqual(replayState);
    const spy = vi.spyOn(audit, "recordInTransaction").mockRejectedValue(new Error("synthetic-measurement-audit-failure"));
    await expect(service.saveGoal(a, { ...goalBody, expectedRevision: 1, idempotencyKey: key() })).rejects.toThrow("synthetic-measurement-audit-failure");
    await expect(service.recordObservation(a, { ...commerce, totalSalesMinor: 60000, idempotencyKey: key() })).rejects.toThrow("synthetic-measurement-audit-failure");
    spy.mockRestore(); expect(await state()).toEqual(replayState);
    await expect(service.saveGoal(a, { ...goalInput(await account(), "ZZZ") })).rejects.toMatchObject({ status: 422 });
  });

  it("rolls import facts measurement metadata and audit back together and discards the exact unreferenced uploaded source", async () => {
    const id = await account(), original = input(id), preview = await service.preview(a, original), before = await state();
    const uploaded: Array<{ id: string; objectKey: string }> = [], store = gateway.store.bind(gateway);
    vi.spyOn(gateway, "store").mockImplementation(async (...args) => { const value = await store(...args); uploaded.push({ id: args[1], objectKey: value.objectKey }); return value; });
    vi.spyOn(audit, "recordInTransaction").mockRejectedValueOnce(new Error("synthetic-measurement-import-audit-failure"));
    await expect(service.commit(a, { ...original, previewChecksum: preview.previewChecksum })).rejects.toThrow("synthetic-measurement-import-audit-failure");
    expect(await state()).toEqual(before); expect(uploaded).toHaveLength(1);
    for (const value of uploaded)
      await expect(storage.readPrivate(a, { ...value, tenantId, assetDomain: "advertising" }, { requiredDomain: "advertising" })).rejects.toThrow();
  });

  it("preserves independent current operation authority and tenant ownership for pinned measurement reads and writes", async () => {
    const id = await account(), original = input(id), saved = await commit(original), before = await state();
    await grant(owner, [Permission.CustomerIntelligenceRead]);
    expect((await service.facts({ ...a, permissions: [Permission.CustomerIntelligenceRead] }, { accountId: id, page: 1, pageSize: 1, search: "" })).rows[0]!.fact.measurement).toBeDefined();
    await expect(service.commit(a, saved.body)).rejects.toMatchObject({ status: 403 });
    await expect(service.facts(b, { accountId: id, page: 1, pageSize: 1, search: "" })).rejects.toMatchObject({ status: 404 });
    expect(await state()).toEqual(before);
    await grant(owner, [Permission.CustomerIntelligenceWrite]);
    const fresh = await commit(input(id), { ...a, permissions: [Permission.CustomerIntelligenceWrite] });
    expect(fresh.saved.imports[0]!.measurement).toBeDefined();
    await expect(service.facts(a, { accountId: id, page: 1, pageSize: 1, search: "" })).rejects.toMatchObject({ status: 403 });
    await grant(owner);
    expect(await state()).not.toEqual(before);
  });

  it("uses the genuine original owner for legacy rows and preserves old hash receipts while new interpretations remain separate", async () => {
    const root = process.env.E2E_ADVERTISING_MEASUREMENT_LEGACY_SOURCE;
    if (!root) throw new Error("The verified original advertising source is required");
    const id = await account(), child = observeInvoiceProcess(spawn(process.execPath,
      ["--import", "./node_modules/tsx/dist/loader.mjs", fileURLToPath(new URL("../../../../tools/testing/advertising-measurement-legacy-fixture.mts", import.meta.url))],
      { cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1" } }));
    children.push(child); child.child.send({ type: "seed", context: a, accountId: id });
    const result = await child.wait("advertising.measurement.legacy.seeded", undefined, 120_000), seed = result.seed as LegacySeed;
    expect(await child.closed).toBe(0); expect(seed.saved.imports).toHaveLength(3);
    expect(seed.saved.imports.every(value => value.measurement === undefined)).toBe(true);
    expect(seed.run.result).not.toHaveProperty("measurementVersion");
    expect(seed.exported.payload).not.toHaveProperty("csvFormatVersion");
    const before = await oldRows(seed), unchanged = await state(), oldCsv = advertisingReviewCsv(seed.exported);
    const replay = await service.commit(a, seed.original);
    expect(replay.imports).toEqual(seed.saved.imports); expect(replay.replayed).toBe(true);
    expect(await service.analyze(a, seed.runInput)).toEqual(seed.run);
    expect(advertisingReviewCsv(await service.readExport(a, seed.exported.id))).toBe(oldCsv);
    expect(await state()).toEqual(unchanged);
    await expect(service.commit(a, { ...seed.original, observedAt: "2026-09-25T18:00:00.000Z" })).rejects.toMatchObject({ status: 409 });
    await expect(service.commit(a, { ...seed.original, files: seed.original.files.map((file, index) => index === 0 ? { ...file, content: file.content.replace(",10,40", ",11,40") } : file) })).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(unchanged);
    const diagnostic = await service.analyze(a, await runInput(id));
    expect(diagnostic.result.diagnostics.map(value => value.code)).toContain("LEGACY_MEASUREMENT_UNPINNED");
    expect(diagnostic.result.recommendations.every(value => value.kind === "watch")).toBe(true);
    const upgraded = await commit(input(id, seed.original.files));
    expect(upgraded.saved.imports[0]!.id).not.toBe(seed.saved.imports[0]!.id);
    expect(upgraded.saved.imports[0]!.checksum).toBe(seed.saved.imports[0]!.checksum);
    expect(upgraded.saved.imports[0]!.measurement).toBeDefined();
    expect(await oldRows(seed)).toEqual(before);
  }, 120_000);

  it("exports an actual reviewed v2 checklist with pinned major amount and the unchanged stored minor integer", async () => {
    const id = await account(); await service.saveGoal(a, goalInput(id));
    const files = bundle(); files[2] = { fileName: `${key()}-target.csv`, content: `${header},Targeting ID,Targeting,Target bid,Targeting status,Purchases,Sales\n${row},target,custom pillow,1.00,ENABLED,2,20.00` };
    await commit(input(id, files)); const run = await service.analyze(a, await runInput(id));
    const action = (await service.workspace(a, id)).actions.find(value => value.runId === run.id && value.recommendation.kind === "lower_bid");
    expect(action?.recommendation.proposedBidMinor).toBe(85); if (!action) throw new Error("Synthetic measured lower-bid action missing");
    const adopted = await service.transition(a, action.id, { expectedRevision: action.revision, expectedStatus: action.status, status: "adopted",
      reason: "Synthetic review only No external advertising write", executedAt: null, actualBeforeMinor: null, actualAfterMinor: null,
      executionCampaignId: null, executionAdGroupId: null, executionTargetId: null, idempotencyKey: key() });
    const sealed = await service.sealExport(a, { runId: run.id, actionIds: [adopted.id], reviewReason: "Synthetic exact measured checklist", idempotencyKey: key() });
    expect(sealed.payload.csvFormatVersion).toBe(2);
    const parsed = readAdCsv(advertisingReviewCsv(sealed)), headings = parsed[0]!, values = parsed[1]!;
    expect(values[headings.indexOf("原竞价")]).toBe("USD 1.00");
    expect(values[headings.indexOf("建议竞价")]).toBe("USD 0.85");
    expect(values[headings.indexOf("保存原竞价最小整数")]).toBe("100");
    expect(values[headings.indexOf("保存建议竞价最小整数")]).toBe("85");
    expect(values[headings.indexOf("金额精度版本")]).toBe("iso4217-2026-09-17-v1");
    expect(values[headings.indexOf("转化模型")]).toBe("click");
    expect(values[headings.indexOf("转化窗口天数")]).toBe("7");
  });
});
