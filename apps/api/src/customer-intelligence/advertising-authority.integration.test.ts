import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AdContextAuthoritySchema, AdGoalFieldsSchema, AdImportInputSchema, AdvertisingWorkspaceSchema, type AdActionView, type AdAnalysisRun, type AdCommitImport, type AdExportView, type AdGoalVersion } from "@yummyai/contracts/advertising";
import { RecordAdvertisingReportInputSchema } from "@yummyai/contracts/customer-intelligence";
import { adFacts, adImportBatches, adImports, connectDatabase, loadCurrentMembershipContext, memberships, migrateDatabase, roles, withTenant } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { AdSourceGateway } from "./ad-source.gateway.js";
import { AdvertisingService } from "./advertising.service.js";
import { CustomerIntelligenceService } from "./customer-intelligence.service.js";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_AUTHORITY_ISOLATED !== "1" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(databaseUrl.pathname) ||
  !/^order-daily-e2e-[a-f0-9]{32}$/.test(process.env.S3_PRIVATE_BUCKET ?? ""))
  throw new Error("Run advertising authority only through its disposable acceptance runner");

const read = Permission.CustomerIntelligenceRead, write = Permission.CustomerIntelligenceWrite, review = Permission.CustomerIntelligenceReview;
const permissions = [read, write, review];
const tables = ["ad_import_batches", "ad_imports", "ad_facts", "ad_products", "ad_goal_versions", "ad_observations", "ad_analysis_runs", "ad_actions", "ad_action_events", "ad_import_events", "ad_exports", "advertising_reports", "advertising_metric_lines", "audit_events"];
const headers = "日期范围,广告主账户 ID,广告产品,广告活动编号,广告组编号,预算货币,展示量,点击量,购买量,总成本,销售额";
const row = "2026年09月01日 - 2026年09月15日,advertiser,SP,campaign,group,USD,1000,40,4,10,40";
const csvs = [
  { fileName: "synthetic-campaign.csv", content: `${headers}\n${row}` },
  { fileName: "synthetic-product.csv", content: `${headers},推广的商品编号\n${row},B012345678` },
  { fileName: "synthetic-target.csv", content: `${headers},投放方案编号,投放方案,目标竞价,投放状态\n${row},target,custom pillow,1,ENABLED` },
];
const key = () => `synthetic-${createEntityId()}`;
const scope = (accountId: string) => ({ accountId, marketplace: "US" as const, currency: "USD", asin: "B012345678" });
const input = (accountId: string) => AdImportInputSchema.parse({ accountId, marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
  attributionWindowDays: 7, attributionBasis: "click", observedAt: "2026-09-16T18:00:00.000Z", dateOrder: null,
  allowPartial: false, idempotencyKey: key(), files: csvs });
const goalInput = (accountId: string) => ({ scope: scope(accountId), expectedRevision: 0, fields: AdGoalFieldsSchema.parse({ mode: "profit_defense",
  effectiveFrom: "2026-09-01", targetAcosBps: 2100, unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null,
  trialSpendLimitMinor: null, notes: "Synthetic confirmed economics" }), idempotencyKey: key() });
const analysisInput = (accountId: string) => ({ accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null,
  currency: null, evidenceCutoffAt: new Date().toISOString(), idempotencyKey: key() });
const observation = (accountId: string) => ({ scope: scope(accountId), kind: "commerce" as const, periodStart: "2026-09-01", periodEnd: "2026-09-15",
  source: "Synthetic full-product commerce evidence", keyword: null, organicRank: null, totalSalesMinor: 5000, totalPurchases: 8,
  preAdContributionMinor: 2500, adsCoverageConfirmed: true, observedAt: new Date().toISOString(), idempotencyKey: key() });
const event = (action: AdActionView) => ({ expectedRevision: action.revision, expectedStatus: action.status, status: "adopted" as const,
  reason: "Synthetic operator review, no marketplace request", executedAt: null, actualBeforeMinor: null, actualAfterMinor: null,
  executionCampaignId: null, executionAdGroupId: null, executionTargetId: null, idempotencyKey: key() });
const legacyInput = (accountId: string | null) => RecordAdvertisingReportInputSchema.parse({ provider: accountId ? "amazon_ads" : "manual", accountId,
  externalReportId: key(), scopeKey: "synthetic-shop", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-15T23:59:59.000Z",
  attributionWindowDays: 7, sourceCurrency: "USD", observedAt: "2026-09-16T18:00:00.000Z", idempotencyKey: key(),
  lines: [{ lineKey: "synthetic-term", entityLevel: "search_term", externalCampaignId: "campaign", externalAdGroupId: "group",
    normalizedTerm: "custom pillow", identityRedacted: true, listingId: null, skuId: null, impressions: 1000, clicks: 40, orders: 4, spendMinor: 1000, salesMinor: 4000 }] });
type Scenario = { accountId: string; importInput: AdCommitImport; importIds: string[]; goal: AdGoalVersion; runInput: ReturnType<typeof analysisInput>; run: AdAnalysisRun; action: AdActionView; exported?: AdExportView };

describe.sequential("advertising current membership and independent operation authority", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), scanner = new ClamAvScanner(), audit = new AuditService(database);
  const gateway = new AdSourceGateway(storage, scanner), service = new AdvertisingService(database, audit, gateway);
  const legacy = new CustomerIntelligenceService(database, audit);
  const tenantId = createEntityId(), foreignTenantId = createEntityId();
  const actor = (tenant = tenantId) => ({ tenantId: tenant, userId: createEntityId(), roleId: createEntityId(), wideRoleId: createEntityId(), membershipId: createEntityId() });
  const owner = actor(), coworker = actor(), foreign = actor(foreignTenantId), actors = [owner, coworker, foreign];
  const context = (value = owner): TenantContext => ({ tenantId: value.tenantId, userId: value.userId, permissions, dataScope: "tenant" });
  const a = context(), b = context(foreign);
  const accountIds: string[] = [];
  let own: Scenario, other: Scenario, outside: Scenario;
  async function grant(value = owner, granted: readonly string[] = permissions, dataScope: "self" | "team" | "tenant" = "tenant", wide: readonly string[] = []) {
    await withTenant(database.db, context(value), async tx => {
      await tx.update(roles).set({ permissions: granted, dataScope }).where(eq(roles.id, value.roleId));
      await tx.update(roles).set({ permissions: wide, dataScope: "tenant" }).where(eq(roles.id, value.wideRoleId));
    });
  }
  const current = () => withTenant(database.db, a, tx => loadCurrentMembershipContext(tx, a));
  async function account(value = owner) {
    const id = createEntityId(); accountIds.push(id);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon',$3,'NA','amazon_private',$4)",
      [id, value.tenantId, `Synthetic authority account ${id}`, value.userId]);
    return id;
  }
  async function commit(accountId: string, value = owner) {
    const body = input(accountId), preview = await service.preview(context(value), body), original = { ...body, previewChecksum: preview.previewChecksum };
    expect(preview.canCommit).toBe(true);
    const saved = await service.commit(context(value), original);
    return { original, saved };
  }
  async function scenario(value = owner, withExport = false): Promise<Scenario> {
    const id = await account(value), imported = await commit(id, value), ctx = context(value);
    const goal = await service.saveGoal(ctx, goalInput(id)), runInput = analysisInput(id), run = await service.analyze(ctx, runInput);
    const action = (await service.workspace(ctx, id)).actions.find(item => item.recommendation.kind === "lower_bid");
    expect(action?.recommendation.proposedBidMinor).toBe(85);
    if (!action) throw new Error("Synthetic lower-bid candidate missing");
    const result: Scenario = { accountId: id, importInput: imported.original, importIds: imported.saved.imports.map(item => item.id), goal, runInput, run, action };
    if (withExport) {
      result.action = await service.transition(ctx, action.id, event(action));
      result.exported = await service.sealExport(ctx, { runId: run.id, actionIds: [action.id], reviewReason: "Synthetic reviewed manual checklist", idempotencyKey: key() });
    }
    return result;
  }
  async function state(ctx = a) {
    return withTenant(database.db, ctx, async tx => {
      const snapshot: Record<string, string> = {};
      for (const table of tables) {
        const rows = await tx.execute(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by item.id)::text,'[]')) as digest from ${sql.raw(table)} item`);
        snapshot[table] = String(rows[0]!.digest);
      }
      return snapshot;
    });
  }
  async function assertDiscarded(uploaded: Array<{ id: string; objectKey: string }>) {
    expect(uploaded.length).toBeGreaterThan(0);
    for (const item of uploaded) {
      expect(await withTenant(database.db, a, tx => tx.select().from(adImports).where(eq(adImports.id, item.id)))).toEqual([]);
      await expect(storage.readPrivate(a, { ...item, tenantId, assetDomain: "advertising" }, { requiredDomain: "advertising" })).rejects.toThrow();
    }
  }
  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    for (const id of [tenantId, foreignTenantId]) await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [id, `Synthetic advertising authority ${id}`, `advertising-authority-${id}`]);
    for (const value of actors) {
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [value.userId, `advertising-authority-${value.userId}`, `${value.userId}@yummyai.invalid`, `Synthetic actor ${value.userId}`]);
      await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [value.membershipId, value.tenantId, value.userId]);
      for (const id of [value.roleId, value.wideRoleId]) {
        await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [id, value.tenantId, `Synthetic advertising role ${id}`, JSON.stringify(id === value.roleId ? permissions : [])]);
        await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [value.tenantId, value.membershipId, id]);
      }
    }
    own = await scenario(owner, true); other = await scenario(coworker, true); outside = await scenario(foreign, true);
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
      for (const value of actors) {
        await database.client.unsafe("delete from membership_roles where tenant_id=$1 and membership_id=$2 and role_id in ($3,$4)", [value.tenantId, value.membershipId, value.roleId, value.wideRoleId]);
        await database.client.unsafe("delete from roles where tenant_id=$1 and id in ($2,$3)", [value.tenantId, value.roleId, value.wideRoleId]);
        await database.client.unsafe("delete from memberships where tenant_id=$1 and id=$2", [value.tenantId, value.membershipId]);
      }
      // Immutable synthetic evidence and these exact accountIds remain until the
      // runner destroys its nonce database and bucket; no business row is deleted.
      expect(new Set(accountIds).size).toBe(accountIds.length);
    } finally { await database.client.end(); }
  });

  it.each(["workspace", "facts", "readSource", "readExport"] as const)("Read-only can %s without write or review", async method => {
    await grant(owner, [read]); const ctx = { ...a, permissions: [read] };
    if (method === "workspace") {
      const value = AdvertisingWorkspaceSchema.parse(await service.workspace(ctx, own.accountId));
      expect(value).toMatchObject({ accountId: own.accountId, access: { canRead: true, canWrite: false, canReview: false } });
      expect(value.imports.map(item => item.id).sort()).toEqual([...own.importIds].sort());
      expect(value.accounts.find(item => item.id === other.accountId)?.access.canRead).toBe(true);
    } else if (method === "facts") {
      const page = await service.facts(ctx, { accountId: own.accountId, search: "", page: 1, pageSize: 2 });
      expect(page).toMatchObject({ accountId: own.accountId, count: 3, page: 1, pageSize: 2 }); expect(page.rows).toHaveLength(2);
      expect(AdContextAuthoritySchema.safeParse(page.contextAuthority).success).toBe(true);
      expect(JSON.parse(page.contextAuthority)).toMatchObject({ tenantId, userId: owner.userId, permissions: [read] });
      expect(page.rows.every(item => item.accountId === own.accountId)).toBe(true);
    } else if (method === "readSource") {
      const source = await service.readSource(ctx, own.importIds[0]!);
      expect(Buffer.from(source.bytes).toString("utf8")).toBe(csvs[0]!.content);
    } else expect(await service.readExport(ctx, own.exported!.id)).toEqual(own.exported);
  });
  it.each(["preview", "commit", "recordObservation", "archive"] as const)("Write-only can %s and receives only its actual receipt", async method => {
    const id = await account();
    let original: AdCommitImport | undefined, importId: string | undefined;
    if (method === "commit") { const body = input(id); original = { ...body, previewChecksum: (await service.preview(a, body)).previewChecksum }; }
    if (method === "archive") importId = (await commit(id)).saved.imports[0]!.id;
    await grant(owner, [write]); const ctx = { ...a, permissions: [write] };
    if (method === "preview") expect((await service.preview(ctx, input(id))).canCommit).toBe(true);
    else if (method === "commit") expect((await service.commit(ctx, original!)).imports).toHaveLength(3);
    else if (method === "recordObservation") expect(await service.recordObservation(ctx, observation(id))).toMatchObject({ scope: scope(id), totalSalesMinor: 5000 });
    else expect((await service.archive(ctx, importId!, { reason: "Synthetic source superseded", idempotencyKey: key() })).archivedAt).not.toBeNull();
    const workspace = await service.workspace(ctx, id);
    expect(workspace.access).toEqual({ canRead: false, canWrite: true, canReview: false });
    for (const property of ["imports", "goals", "observations", "actions", "analyses"] as const) expect(workspace[property]).toEqual([]);
    await expect(service.facts(ctx, { accountId: id, search: "", page: 1, pageSize: 50 })).rejects.toMatchObject({ status: 403 });
  });
  it.each(["saveGoal", "analyze", "transition", "sealExport"] as const)("Review-only can %s without borrowing read or write", async method => {
    const seeded = method === "saveGoal" ? null : await scenario(owner, method === "sealExport");
    const id = seeded?.accountId ?? await account();
    await grant(owner, [review]); const ctx = { ...a, permissions: [review] };
    if (method === "saveGoal") expect((await service.saveGoal(ctx, goalInput(id))).revision).toBe(1);
    else if (method === "analyze") expect((await service.analyze(ctx, analysisInput(id))).result.selectedFactCount).toBe(3);
    else if (method === "transition") expect((await service.transition(ctx, seeded!.action.id, event(seeded!.action))).status).toBe("adopted");
    else expect((await service.sealExport(ctx, { runId: seeded!.run.id, actionIds: [seeded!.action.id], reviewReason: "Synthetic explicit review", idempotencyKey: key() })).payload.marketplaceExecution).toBe("manual");
    const workspace = await service.workspace(ctx, id);
    expect(workspace.access).toEqual({ canRead: false, canWrite: false, canReview: true });
    for (const property of ["imports", "goals", "observations", "actions", "analyses"] as const) expect(workspace[property]).toEqual([]);
    await expect(service.preview(ctx, input(id))).rejects.toMatchObject({ status: 403 });
  });
  it.each(["self", "team"] as const)("uses the trusted account creator for %s scope, not an unrelated current teammate", async dataScope => {
    await grant(owner, permissions, dataScope); const ctx = await current();
    const workspace = await service.workspace(ctx);
    expect(workspace.accounts.some(item => item.id === own.accountId)).toBe(true);
    expect(workspace.accounts.some(item => item.id === other.accountId)).toBe(false);
    for (const operation of [() => service.workspace(ctx, other.accountId), () => service.preview(ctx, input(other.accountId)), () => service.saveGoal(ctx, { ...goalInput(other.accountId), expectedRevision: 1 })])
      await expect(operation()).rejects.toMatchObject({ status: 404 });
    await expect(service.readSource(ctx, other.importIds[0]!)).rejects.toMatchObject({ status: 404 });
  });
  it.each([write, review])("does not borrow tenant Read scope to expand a self-scoped %s operation", async operation => {
    await grant(owner, [operation], "self", [read]); const ctx = await current(); expect(ctx.dataScope).toBe("tenant");
    const workspace = await service.workspace(ctx, other.accountId);
    expect(workspace.accounts.find(item => item.id === other.accountId)?.access).toEqual({ canRead: true, canWrite: false, canReview: false });
    expect(workspace.imports).toHaveLength(3);
    if (operation === write) await expect(service.preview(ctx, input(other.accountId))).rejects.toMatchObject({ status: 404 });
    else await expect(service.analyze(ctx, analysisInput(other.accountId))).rejects.toMatchObject({ status: 404 });
  });
  it.each([read, write, review])("rechecks current %s before old-request replay or private read", async revoked => {
    const stale = await current(); await grant(owner, permissions.filter(value => value !== revoked));
    if (revoked === read) {
      await expect(service.readSource(stale, own.importIds[0]!)).rejects.toMatchObject({ status: 403 });
      await expect(service.readExport(stale, own.exported!.id)).rejects.toMatchObject({ status: 403 });
      expect((await service.workspace(stale, own.accountId)).imports).toEqual([]);
    } else if (revoked === write) await expect(service.commit(stale, own.importInput)).rejects.toMatchObject({ status: 403 });
    else await expect(service.analyze(stale, own.runInput)).rejects.toMatchObject({ status: 403 });
  });
  it("intersects a fresh membership with the request ceiling and does not trust forged request permissions", async () => {
    await expect(service.workspace({ ...a, permissions: [] })).rejects.toMatchObject({ status: 403 });
    await grant(owner, [read]);
    await expect(service.preview(a, input(own.accountId))).rejects.toMatchObject({ status: 403 });
    expect((await service.workspace(a)).access).toEqual({ canRead: true, canWrite: false, canReview: false });
  });
  it("rejects disabled and absent memberships even when the request claims every advertising permission", async () => {
    await withTenant(database.db, a, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, owner.membershipId)));
    await expect(service.workspace(a)).rejects.toMatchObject({ status: 403 });
    await expect(service.workspace({ ...a, userId: createEntityId() })).rejects.toMatchObject({ status: 403 });
  });
  it("keeps legitimate foreign-tenant actors outside source, action, export and account boundaries", async () => {
    for (const operation of [() => service.workspace(b, own.accountId), () => service.readSource(b, own.importIds[0]!),
      () => service.readExport(b, own.exported!.id), () => service.transition(b, own.action.id, event(own.action))])
      await expect(operation()).rejects.toMatchObject({ status: 404 });
    expect((await service.workspace(b, outside.accountId)).imports.map(item => item.id).sort()).toEqual([...outside.importIds].sort());
  });
  it("uses the non-owner RLS role and immutable facts even for direct SQL", async () => {
    const result = await withTenant(database.db, a, async tx => {
      const role = (await tx.execute(sql`select current_user as name, has_table_privilege(current_user,'ad_facts','UPDATE') as can_update`))[0];
      const hidden = await tx.select().from(adImports).where(eq(adImports.id, outside.importIds[0]!)); return { role, hidden };
    });
    expect(result).toMatchObject({ role: { name: "yummyai_app", can_update: false }, hidden: [] });
    await expect(withTenant(database.db, a, tx => tx.insert(adImportBatches).values({ id: createEntityId(), tenantId: foreignTenantId,
      accountId: outside.accountId, createdBy: owner.userId, idempotencyKey: key(), inputChecksum: "f".repeat(64) }))).rejects.toThrow();
    await expect(withTenant(database.db, a, tx => tx.update(adFacts).set({ entityKey: "f".repeat(64) }))).rejects.toThrow();
  });
  it("checks the source read again after real storage I/O and never returns bytes to a revoked reader", async () => {
    const original = storage.readPrivate.bind(storage); const stale = await current();
    const readSpy = vi.spyOn(storage, "readPrivate").mockImplementationOnce(async (...args) => { const bytes = await original(...args); await grant(owner, [write, review]); return bytes; });
    await expect(service.readSource(stale, own.importIds[0]!)).rejects.toMatchObject({ status: 403 }); expect(readSpy).toHaveBeenCalledTimes(1);
  });
  it("rechecks the writer after a real clean scan and prevents upload when authority was revoked", async () => {
    const id = await account(), body = input(id), request = { ...body, previewChecksum: (await service.preview(a, body)).previewChecksum }, before = await state();
    const original = scanner.scan.bind(scanner), put = vi.spyOn(storage, "putPrivate");
    vi.spyOn(scanner, "scan").mockImplementationOnce(async (...args) => { const scan = await original(...args); expect(scan.result).toBe("clean"); await grant(owner, [read, review]); return scan; });
    await expect(service.commit(a, request)).rejects.toMatchObject({ status: 403 }); expect(put).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });
  it("cleans only its exact unreferenced upload after post-storage write revocation", async () => {
    const id = await account(), body = input(id), request = { ...body, previewChecksum: (await service.preview(a, body)).previewChecksum }, before = await state();
    const original = storage.putPrivate.bind(storage), uploaded: Array<{ id: string; objectKey: string }> = [];
    vi.spyOn(storage, "putPrivate").mockImplementationOnce(async (...args) => { const receipt = await original(...args); uploaded.push({ id: args[1].fileName.slice(0, -4), objectKey: receipt.objectKey }); await grant(owner, [read, review]); return receipt; });
    await expect(service.commit(a, request)).rejects.toMatchObject({ status: 403 }); expect(await state()).toEqual(before);
    await grant(); await assertDiscarded(uploaded);
    expect(Buffer.from((await service.readSource(a, own.importIds[0]!)).bytes).toString("utf8")).toBe(csvs[0]!.content);
  });
  it("rolls back the full batch, facts, invalidations and audit and discards uploads if same-transaction audit fails", async () => {
    const id = await account(), body = input(id), request = { ...body, previewChecksum: (await service.preview(a, body)).previewChecksum }, before = await state();
    const originalPut = storage.putPrivate.bind(storage), originalAudit = audit.recordInTransaction.bind(audit), uploaded: Array<{ id: string; objectKey: string }> = [];
    vi.spyOn(storage, "putPrivate").mockImplementation(async (...args) => { const receipt = await originalPut(...args); uploaded.push({ id: args[1].fileName.slice(0, -4), objectKey: receipt.objectKey }); return receipt; });
    vi.spyOn(audit, "recordInTransaction").mockImplementationOnce(async (...args) => { await originalAudit(...args); throw new Error("Synthetic audit rollback"); });
    await expect(service.commit(a, request)).rejects.toThrow("Synthetic audit rollback"); expect(await state()).toEqual(before);
    await assertDiscarded(uploaded);
  });
  it("deduplicates concurrent same-content imports and discards only the losing request's uploads", async () => {
    const id = await account(), body = input(id), preview = await service.preview(a, body), original = { ...body, previewChecksum: preview.previewChecksum };
    const first = await Promise.all([service.commit(a, original), service.commit(a, { ...original, idempotencyKey: key() })]);
    expect(first[0]!.imports.map(item => item.id)).toEqual(first[1]!.imports.map(item => item.id));
    expect(first.map(item => item.replayed).sort()).toEqual([false, true]);
    const saved = await withTenant(database.db, a, tx => tx.select().from(adImports).where(eq(adImports.accountId, id)));
    expect(saved).toHaveLength(3); for (const row of saved) expect(createHash("sha256").update((await service.readSource(a, row.id)).bytes).digest("hex")).toBe(row.checksum);
    const audits = await withTenant(database.db, a, tx => tx.execute(sql`select count(*)::int as n from audit_events where action='advertising.import' and entity_id in (select id from ad_import_batches where account_id=${id}::uuid)`));
    expect(audits[0]!.n).toBe(1);
  });
  it("keeps exact old replay but rejects the same key with changed observation metadata without new facts", async () => {
    const before = await state(); expect((await service.commit(a, own.importInput)).replayed).toBe(true);
    const { previewChecksum: omitted, ...original } = own.importInput; void omitted;
    const changed = { ...original, observedAt: "2026-09-17T18:00:00.000Z" }, preview = await service.preview(a, changed);
    await expect(service.commit(a, { ...changed, previewChecksum: preview.previewChecksum })).rejects.toMatchObject({ status: 409 }); expect(await state()).toEqual(before);
  });
  it("never treats scanner unavailability as clean and does not create a private object or fact", async () => {
    const id = await account(), body = input(id), request = { ...body, previewChecksum: (await service.preview(a, body)).previewChecksum }, before = await state();
    const put = vi.spyOn(storage, "putPrivate"); vi.spyOn(scanner, "scan").mockRejectedValueOnce(new Error("Synthetic scanner unavailable"));
    await expect(service.commit(a, request)).rejects.toMatchObject({ status: 422 }); expect(put).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });
  it("rejects altered raw source bytes and reports missing objects without fabricating original evidence", async () => {
    const original = storage.readPrivate.bind(storage), before = await state();
    vi.spyOn(storage, "readPrivate").mockImplementationOnce(async (...args) => { await original(...args); return Buffer.from("synthetic altered bytes"); });
    await expect(service.readSource(a, own.importIds[0]!)).rejects.toThrow();
    vi.spyOn(storage, "readPrivate").mockRejectedValueOnce(new Error("Synthetic missing source object"));
    await expect(service.readSource(a, own.importIds[0]!)).rejects.toThrow(); expect(await state()).toEqual(before);
  });
  it("allows the legacy JSON report owner to return a Write-only receipt without requiring Read", async () => {
    await grant(owner, [write]); const body = legacyInput(own.accountId), ctx = { ...a, permissions: [write] };
    const receipt = await legacy.recordAdvertisingReport(ctx, body);
    expect(receipt.accountId).toBe(own.accountId); expect(receipt.lines).toHaveLength(1);
    expect(receipt.totals?.spendMinor).toBe(1000);
    expect((await legacy.recordAdvertisingReport(ctx, body)).id).toBe(receipt.id);
    await expect(legacy.workspace(ctx)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects revoked current Write before replaying an existing legacy JSON report", async () => {
    const body = legacyInput(own.accountId), receipt = await legacy.recordAdvertisingReport(a, body), before = await state();
    await grant(owner, [read, review]);
    await expect(legacy.recordAdvertisingReport(a, body)).rejects.toMatchObject({ status: 403 });
    expect((await legacy.workspace(a)).advertisingReports.some(item => item.id === receipt.id)).toBe(true); expect(await state()).toEqual(before);
  });
  it.each(["self", "team"] as const)("keeps legacy JSON %s writes within actual account ownership and denies unowned null-account evidence", async dataScope => {
    await grant(owner, [write], dataScope, [read]); const ctx = await current();
    expect((await legacy.recordAdvertisingReport(ctx, legacyInput(own.accountId))).accountId).toBe(own.accountId);
    await expect(legacy.recordAdvertisingReport(ctx, legacyInput(other.accountId))).rejects.toMatchObject({ status: 403 });
    await expect(legacy.recordAdvertisingReport(ctx, legacyInput(null))).rejects.toMatchObject({ status: 403 });
  });
  it("rolls back legacy JSON header, lines and its audit if the in-transaction audit fails", async () => {
    const before = await state(), originalAudit = audit.recordInTransaction.bind(audit);
    vi.spyOn(audit, "recordInTransaction").mockImplementationOnce(async (...args) => { await originalAudit(...args); throw new Error("Synthetic legacy audit rollback"); });
    await expect(legacy.recordAdvertisingReport(a, legacyInput(own.accountId))).rejects.toThrow("Synthetic legacy audit rollback"); expect(await state()).toEqual(before);
  });
  it("requires current tenant Read for the mixed legacy workspace and cannot borrow a wide Write grant", async () => {
    await grant(owner, [read], "self", [write]); const stale = await current(); expect(stale.dataScope).toBe("tenant");
    await expect(legacy.workspace(stale)).rejects.toMatchObject({ status: 403 });
    await grant(owner, [read]); expect((await legacy.workspace(a)).advertisingReports).toBeInstanceOf(Array);
    await grant(owner, [write]); await expect(legacy.workspace(a)).rejects.toMatchObject({ status: 403 });
  });
});
