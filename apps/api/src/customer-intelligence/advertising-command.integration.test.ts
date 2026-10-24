import { createHash, randomBytes } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AdActionEventInputSchema, AdGoalFieldsSchema, AdImportInputSchema, AdObservationInputSchema, adCurrencyBasis,
  type AdActionView, type AdAnalysisRun, type AdImportView } from "@yummyai/contracts/advertising";
import { AD_COMMAND_MAX_PLAINTEXT_BYTES, AdCommandDetailSchema, AdCommandListSchema, AdCommandOriginalSchema,
  PrepareAdCommandSchema, type AdCommandKind, type AdCommandResult, type PrepareAdCommand } from "@yummyai/contracts/advertising/command";
import { connectDatabase, expireAdvertisingCommandInputs, memberships, migrateDatabase, roles, withTenant } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { AdSourceGateway } from "./ad-source.gateway.js";
import { adHash } from "./ad-csv-parser.js";
import { AdvertisingCommandOwnerAdapter } from "./advertising-command-owner.js";
import { AdvertisingCommandService } from "./advertising-command.service.js";
import { createAdvertisingCommandVault } from "./advertising-command-vault.js";
import { AdvertisingService } from "./advertising.service.js";

// This guard runs before any database/storage construction. The normal database
// and bucket can never be selected by importing this dedicated integration file.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_COMMAND_ISOLATED !== "1" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Advertising commands require their dedicated matching disposable database and bucket before connection");

const read = Permission.CustomerIntelligenceRead, write = Permission.CustomerIntelligenceWrite, review = Permission.CustomerIntelligenceReview;
const permissions = [read, write, review], key = () => `synthetic-command-${createEntityId()}`;
const kinds: AdCommandKind[] = ["import_commit", "goal_save", "observation_record", "analysis_run", "action_transition", "import_archive", "export_seal"];
const businessTables = ["ad_import_batches", "ad_imports", "ad_facts", "ad_products", "ad_goal_versions", "ad_observations",
  "ad_analysis_runs", "ad_actions", "ad_action_events", "ad_import_events", "ad_exports", "advertising_original_write_proofs", "advertising_owner_mutation_evidence"];
const allTables = [...businessTables, "advertising_commands", "audit_events", "advertising_command_audit_receipts"];
const header = "Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Purchases,Spend,Sales";
const csvRow = "2026-09-01 - 2026-09-15,synthetic-command,SP,campaign,group,USD,1000,40,4,10.00,40.00";
const sourceFiles = (prefix: string) => [
  { fileName: `${prefix}-campaign.csv`, content: `${header}\n${csvRow}` },
  { fileName: `${prefix}-product.csv`, content: `${header},Advertised ASIN\n${csvRow},B012345678` },
  { fileName: `${prefix}-target.csv`, content: `${header},Targeting ID,Targeting,Bid,State\n${csvRow},target,custom pillow,1.00,ENABLED` },
];
const scope = (accountId: string, asin = "B012345678") => ({ accountId, marketplace: "US" as const, currency: "USD", asin });
const operation = (kind: AdCommandKind) => ["import_commit", "observation_record", "import_archive"].includes(kind) ? write : review;
const ownerAudit: Record<AdCommandKind, string> = { import_commit: "advertising.import", goal_save: "advertising.goal.version",
  observation_record: "advertising.observation", analysis_run: "advertising.analyze", action_transition: "advertising.action.transition",
  import_archive: "advertising.import.archive", export_seal: "advertising.export.seal" };
type Actor = { tenantId: string; userId: string; membershipId: string; roleId: string; wideRoleId: string };
type Scenario = { accountId: string; original: PrepareAdCommand; action?: AdActionView; imports?: AdImportView[]; run?: AdAnalysisRun };
type Upload = { id: string; objectKey: string };
type Proof = { tenant_id: string; account_id: string; kind: AdCommandKind; result_id: string; command_id: string | null;
  request_key: string; actor_id: string; target_id: string | null; parent_id: string | null; version: number | null;
  owner_input_checksum: string | null; creation_transaction_id: string };
function pg(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  const value = error as { code?: string; message?: string; cause?: unknown };
  return value.cause ? pg(value.cause) : value;
}

describe.sequential("seven advertising original commands and actual owner outcomes", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment(), scanner = new ClamAvScanner(), audit = new AuditService(database);
  const gateway = new AdSourceGateway(storage, scanner), advertising = new AdvertisingService(database, audit, gateway);
  const adapter = new AdvertisingCommandOwnerAdapter(advertising), encryptionKey = randomBytes(32);
  const vault = createAdvertisingCommandVault({ NODE_ENV: "production", ADVERTISING_COMMAND_ENCRYPTION_KEY: encryptionKey.toString("base64url") });
  const service = () => new AdvertisingCommandService(database, vault, adapter, audit), commands = service();
  const tenantId = createEntityId(), foreignTenantId = createEntityId();
  const actor = (tenant = tenantId): Actor => ({ tenantId: tenant, userId: createEntityId(), membershipId: createEntityId(), roleId: createEntityId(), wideRoleId: createEntityId() });
  const owner = actor(), coworker = actor(), foreign = actor(foreignTenantId), actors = [owner, coworker, foreign], accounts: string[] = [];
  const context = (value = owner, granted: readonly string[] = permissions): TenantContext => ({ tenantId: value.tenantId,
    userId: value.userId, permissions: granted, dataScope: "tenant" });
  const a = context();
  async function grant(value = owner, granted: readonly string[] = permissions, dataScope: "tenant" | "self" | "team" = "tenant", wide: readonly string[] = []) {
    await withTenant(database.db, context(value), async tx => {
      // A lock leaked across a scanner/storage callback fails this fixture rather
      // than waiting forever while a test tries to revoke current membership.
      await tx.execute(sql`set local lock_timeout='3s'`);
      await tx.execute(sql`set local statement_timeout='10s'`);
      await tx.update(roles).set({ permissions: granted, dataScope }).where(eq(roles.id, value.roleId));
      await tx.update(roles).set({ permissions: wide, dataScope: "tenant" }).where(eq(roles.id, value.wideRoleId));
    });
  }
  async function account(value = owner) {
    const id = createEntityId(); accounts.push(id);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon',$3,'NA','amazon_private',$4)",
      [id, value.tenantId, `Synthetic advertising command ${id}`, value.userId]);
    return id;
  }
  async function clock() {
    const [row] = await database.client.unsafe("select clock_timestamp() as now");
    return new Date(Math.max(Date.now(), new Date(row!.now).getTime())).toISOString();
  }
  function goalInput(accountId: string, expectedRevision = 0, asin?: string) {
    return { scope: scope(accountId, asin), expectedRevision, fields: AdGoalFieldsSchema.parse({ mode: "profit_defense",
      effectiveFrom: "2026-09-01", targetAcosBps: 2100, unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [],
      trialEndDate: null, trialSpendLimitMinor: null, cooldownDays: 30 }), idempotencyKey: key() };
  }
  async function importInput(accountId: string, files = sourceFiles(key())) {
    const input = AdImportInputSchema.parse({ accountId, files, marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
      attributionWindowDays: 7, attributionBasis: "click", conversionDefinition: { model: "click", source: "Synthetic actual report settings confirm click attribution" },
      observedAt: "2026-10-01T18:00:00.000Z", allowPartial: false, idempotencyKey: key() });
    const preview = await advertising.preview(a, input); expect(preview.canCommit).toBe(true);
    return { ...input, previewChecksum: preview.previewChecksum };
  }
  async function bidBasis(accountId: string) {
    const imports = (await advertising.commit(a, await importInput(accountId))).imports;
    await advertising.saveGoal(a, goalInput(accountId));
    const run = await advertising.analyze(a, { accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null,
      currency: null, evidenceCutoffAt: await clock(), idempotencyKey: key() });
    const action = (await advertising.workspace(a, accountId)).actions.find(item => item.runId === run.id && item.recommendation.kind === "lower_bid");
    if (!action) throw new Error("Synthetic command original bid action missing");
    return { imports, run, action };
  }
  async function scenario(kind: AdCommandKind, existingAccountId?: string): Promise<Scenario> {
    const accountId = existingAccountId ?? await account();
    let original: PrepareAdCommand, extra: Omit<Scenario, "accountId" | "original"> = {};
    if (kind === "import_commit") original = { kind, accountId, targetId: null, input: await importInput(accountId) };
    else if (kind === "goal_save") original = { kind, accountId, targetId: null, input: goalInput(accountId) };
    else if (kind === "observation_record") original = { kind, accountId, targetId: null, input: AdObservationInputSchema.parse({ scope: scope(accountId),
      kind: "commerce", periodStart: "2026-09-01", periodEnd: "2026-09-15", source: "Synthetic actual original commerce ledger",
      keyword: null, organicRank: null, totalSalesMinor: 12345, totalPurchases: 3, preAdContributionMinor: -1,
      observedAt: "2026-10-01T18:00:00.100Z", idempotencyKey: key() }) };
    else if (kind === "import_archive") {
      const imports = (await advertising.commit(a, await importInput(accountId, sourceFiles(key()).slice(0, 1)))).imports;
      extra = { imports }; original = { kind, accountId, targetId: imports[0]!.id, input: { reason: "Synthetic original source superseded without deleting evidence", idempotencyKey: key() } };
    } else {
      const basis = await bidBasis(accountId); extra = basis;
      if (kind === "analysis_run") original = { kind, accountId, targetId: null, input: { accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15",
        marketplace: null, currency: null, evidenceCutoffAt: await clock(), idempotencyKey: key() } };
      else if (kind === "action_transition") original = { kind, accountId, targetId: basis.action.id, input: AdActionEventInputSchema.parse({
        expectedRevision: basis.action.revision, expectedStatus: basis.action.status, status: "deferred", reason: "Synthetic explicit original defer evidence", idempotencyKey: key() }) };
      else {
        const adopted = await advertising.transition(a, basis.action.id, AdActionEventInputSchema.parse({ expectedRevision: basis.action.revision,
          expectedStatus: basis.action.status, status: "adopted", reason: "Synthetic actual review before immutable export", idempotencyKey: key() }));
        extra.action = adopted;
        original = { kind: "export_seal", accountId, targetId: basis.run.id, input: { runId: basis.run.id, actionIds: [adopted.id],
          reviewReason: "Synthetic original reviewed checklist remains immutable", idempotencyKey: key() } };
      }
    }
    return { accountId, original: PrepareAdCommandSchema.parse(original), ...extra };
  }
  function raw(original: PrepareAdCommand, ctx = a) {
    switch (original.kind) {
      case "import_commit": return advertising.commit(ctx, original.input);
      case "goal_save": return advertising.saveGoal(ctx, original.input);
      case "observation_record": return advertising.recordObservation(ctx, original.input);
      case "analysis_run": return advertising.analyze(ctx, original.input);
      case "action_transition": return advertising.transition(ctx, original.targetId, original.input);
      case "import_archive": return advertising.archive(ctx, original.targetId, original.input);
      case "export_seal": return advertising.sealExport(ctx, original.input);
    }
  }
  async function state(tables: readonly string[] = allTables, ctx = a) {
    return withTenant(database.db, ctx, async tx => {
      const result: Record<string, string> = {};
      for (const table of tables) {
        const [row] = await tx.execute(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)::text,'[]')) as digest from ${sql.raw(table)} item`);
        result[table] = String(row!.digest);
      }
      return result;
    });
  }
  async function commandRow(id: string) {
    const [row] = await withTenant(database.db, a, tx => tx.execute<{ id: string; status: string; encrypted_input: string | null; result_id: string | null;
      request_checksum: string; owner_input_checksum: string; authority_snapshot: TenantContext; created_at: Date; expires_at: Date; redacted_at: Date | null }>(sql`select * from advertising_commands where id=${id}::uuid`));
    if (!row) throw new Error("Synthetic original command row missing"); return row;
  }
  async function proof(original: PrepareAdCommand) {
    const [row] = await withTenant(database.db, a, tx => tx.execute<Proof>(sql`select * from advertising_original_write_proofs where account_id=${original.accountId}::uuid
      and kind=${original.kind} and request_key=${original.input.idempotencyKey}
      ${["action_transition", "import_archive"].includes(original.kind) ? sql`and target_id=${original.targetId}::uuid` : sql``}`));
    if (!row) throw new Error("Synthetic actual advertising proof missing"); return row;
  }
  async function prepared(s: Scenario, ctx = a) {
    const before = await state(businessTables), value = AdCommandDetailSchema.parse(await commands.prepare(ctx, s.original));
    expect(value).toMatchObject({ kind: s.original.kind, accountId: s.accountId, targetId: s.original.targetId, status: "prepared", result: null,
      requestKey: s.original.input.idempotencyKey, originalRetained: true, canExecute: true });
    expect(Date.parse(value.expiresAt) - Date.parse(value.createdAt)).toBe(7 * 86400000);
    expect(await state(businessTables)).toEqual(before);
    const saved = await commandRow(value.id); expect(saved.encrypted_input).not.toContain("Synthetic");
    expect(saved.request_checksum).toMatch(/^[a-f0-9]{64}$/); expect(saved.owner_input_checksum).toMatch(/^[a-f0-9]{64}$/);
    return value;
  }
  async function original(s: Scenario, id: string, ctx = a) {
    return AdCommandOriginalSchema.parse(await service().original(ctx, id, s.accountId));
  }
  async function assertActual(s: Scenario, commandId: string, result: AdCommandResult) {
    const actual = await proof(s.original), saved = await commandRow(commandId);
    expect(actual).toMatchObject({ tenant_id: tenantId, account_id: s.accountId, kind: s.original.kind, command_id: commandId,
      actor_id: owner.userId, request_key: s.original.input.idempotencyKey, target_id: s.original.targetId, result_id: result.id,
      parent_id: result.parentId, version: result.version });
    expect(actual.creation_transaction_id).toMatch(/^\d+$/); expect(saved.result_id).toBe(actual.result_id);
    const rows = await withTenant(database.db, a, tx => tx.execute<{ action: string; actor_id: string; creation_transaction_id: string }>(sql`
      select e.action,e.actor_user_id as actor_id,r.creation_transaction_id from audit_events e
      join advertising_command_audit_receipts r on r.tenant_id=e.tenant_id and r.audit_id=e.id
      where (e.action='advertising.command.execute' and e.entity_id=${commandId}::uuid)
      or (e.action=${ownerAudit[s.original.kind]} and e.entity_id=${s.original.kind === "action_transition" || s.original.kind === "import_archive" ? result.parentId : result.id}::uuid
        and r.creation_transaction_id=${actual.creation_transaction_id})`));
    expect(rows.map(row => row.action).sort()).toEqual([ownerAudit[s.original.kind], "advertising.command.execute"].sort());
    expect(rows.every(row => row.actor_id === owner.userId && row.creation_transaction_id === actual.creation_transaction_id)).toBe(true);
    if (s.original.kind === "import_commit") {
      const imports = await withTenant(database.db, a, tx => tx.execute<{ id: string; checksum: string; file_name: string }>(sql`select id,checksum,file_name from ad_imports where batch_id=${result.id}::uuid order by file_name`));
      expect(imports).toHaveLength(s.original.input.files.length);
      for (const file of s.original.input.files) {
        const imported = imports.find(row => row.file_name === file.fileName); expect(imported).toBeDefined();
        const source = await advertising.readSource(a, imported!.id); expect(Buffer.from(source.bytes).toString("utf8")).toBe(file.content);
        expect(createHash("sha256").update(source.bytes).digest("hex")).toBe(imported!.checksum);
      }
    } else if (s.original.kind === "action_transition" || s.original.kind === "import_archive") {
      expect(result.id).not.toBe(s.original.targetId); expect(result.parentId).toBe(s.original.targetId);
      const rows = await withTenant(database.db, a, tx => tx.execute<{ id: string }>(sql`select id from ${sql.raw(s.original.kind === "action_transition" ? "ad_action_events" : "ad_import_events")}
        where id=${result.id}::uuid and idempotency_key=${s.original.input.idempotencyKey}`)); expect(rows).toHaveLength(1);
    }
  }
  async function assertDiscarded(uploaded: Upload[]) {
    expect(uploaded.length).toBeGreaterThan(0);
    for (const item of uploaded) {
      const rows = await withTenant(database.db, a, tx => tx.execute(sql`select id from ad_imports where id=${item.id}::uuid`)); expect(rows).toEqual([]);
      await expect(storage.readPrivate(a, { ...item, tenantId, assetDomain: "advertising" }, { requiredDomain: "advertising" })).rejects.toThrow();
    }
  }
  function captureUploads() {
    const uploaded: Upload[] = [], put = storage.putPrivate.bind(storage);
    vi.spyOn(storage, "putPrivate").mockImplementation(async (...args) => {
      const receipt = await put(...args); uploaded.push({ id: args[1].fileName.slice(0, -4), objectKey: receipt.objectKey }); return receipt;
    }); return uploaded;
  }

  beforeAll(async () => {
    await migrateDatabase(database); await storage.ensureBucket();
    for (const tenant of [tenantId, foreignTenantId]) await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)",
      [tenant, `Synthetic original advertising ${tenant}`, `ad-command-${tenant}`]);
    for (const value of actors) {
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [value.userId, `ad-command-${value.userId}`, `${value.userId}@yummyai.invalid`, `Synthetic advertising command actor ${value.userId}`]);
      await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [value.membershipId, value.tenantId, value.userId]);
      for (const [id, granted] of [[value.roleId, permissions], [value.wideRoleId, []]] as const) {
        await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
          [id, value.tenantId, `Synthetic advertising command role ${id}`, JSON.stringify(granted)]);
        await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [value.tenantId, value.membershipId, id]);
      }
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const value of actors) {
      try { await grant(value); }
      finally { await withTenant(database.db, context(value), tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, value.membershipId))); }
    }
  });
  afterAll(async () => {
    try {
      const restored = await Promise.allSettled(actors.map(value => grant(value))); expect(restored.every(value => value.status === "fulfilled")).toBe(true);
      // No immutable business row is deleted in place. Only the coordinated
      // runner destroys this exact disposable database and private bucket.
      console.info("Synthetic advertising command owned fixture", { tenantId, foreignTenantId, accountIds: accounts, kinds: kinds.length });
    } finally { encryptionKey.fill(0); await database.client.end(); }
  });

  it.each(kinds)("recovers the original %s in a new service and commits exactly one real result with both same-transaction audits", async kind => {
    const s = await scenario(kind), ctx = context(owner, [operation(kind)]), pending = await prepared(s, ctx);
    const afterPrepare = await state();
    expect((await original(s, pending.id, structuredClone(ctx))).original).toEqual(s.original);
    expect((await commands.prepare(structuredClone(ctx), structuredClone(s.original))).id).toBe(pending.id);
    expect(await state()).toEqual(afterPrepare);
    const [first, replay] = await Promise.all([commands.execute(ctx, pending.id, s.accountId), service().execute(structuredClone(ctx), pending.id, s.accountId)]);
    expect(first.status).toBe("succeeded"); expect(first.result).not.toBeNull(); expect(replay.result).toEqual(first.result);
    await assertActual(s, pending.id, first.result!);
    const afterExecute = await state(); expect((await service().execute(structuredClone(ctx), pending.id, s.accountId)).result).toEqual(first.result);
    expect(await state()).toEqual(afterExecute);
    await grant(owner, [read]); const reader = context(owner, [read]);
    expect(await commands.get(reader, pending.id, s.accountId)).toMatchObject({ result: first.result, canExecute: false, canAcknowledge: true });
    expect((await commands.execute(reader, pending.id, s.accountId)).result).toEqual(first.result);
    await commands.acknowledge(reader, pending.id, s.accountId);
    expect(await original(s, pending.id, reader)).toMatchObject({ original: null, blockReason: "input_unavailable" });
    expect((await commandRow(pending.id)).encrypted_input).toBeNull();
    const acknowledged = await state(); expect((await commands.acknowledge(reader, pending.id, s.accountId)).result).toEqual(first.result);
    expect(AdCommandListSchema.parse(await commands.list(reader, { accountId: s.accountId, view: "active" })).items).toEqual([]);
    expect(AdCommandListSchema.parse(await commands.list(reader, { accountId: s.accountId, view: "recorded" })).items.map(row => row.id)).toContain(pending.id);
    expect(await state()).toEqual(acknowledged);
    await grant(); await expect(raw(s.original)).rejects.toMatchObject({ status: 409 }); expect(await state()).toEqual(acknowledged);
  }, 60_000);

  it.each(kinds)("does not adopt an existing raw %s as a newly prepared command or create a second audit on exact raw replay", async kind => {
    const s = await scenario(kind); await raw(s.original); const actual = await proof(s.original), before = await state();
    expect(actual.command_id).toBeNull();
    await expect(commands.prepare(a, s.original)).rejects.toMatchObject({ status: 409 });
    await expect(commands.prepare(context(coworker), s.original)).rejects.toMatchObject({ status: 409 });
    await raw(s.original); expect(await proof(s.original)).toEqual(actual); expect(await state()).toEqual(before);
    if (kind === "import_commit") {
      await expect(commands.prepare(a, { ...s.original, input: { ...s.original.input, idempotencyKey: key() } })).rejects.toMatchObject({ status: 409 });
      expect(await state()).toEqual(before);
    }
  }, 60_000);

  it.each(["advertising.import", "advertising.command.execute"])("rolls back the actual batch, proof, command outcome and both audits and discards uploads when %s fails", async action => {
    const s = await scenario("import_commit"), pending = await prepared(s), before = await state(), uploaded = captureUploads();
    const record = audit.recordInTransaction.bind(audit);
    vi.spyOn(audit, "recordInTransaction").mockImplementation(async (...args) => { const id = await record(...args);
      if (args[2].action === action) throw new Error("Synthetic advertising command audit failure"); return id; });
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toThrow("Synthetic advertising command audit failure");
    expect(await state()).toEqual(before); await assertDiscarded(uploaded);
    expect((await original(s, pending.id)).original).toEqual(s.original); expect((await commandRow(pending.id)).status).toBe("prepared");
  });

  it("rolls back the mutable action, original event proof and outcome together after the command audit fails", async () => {
    const s = await scenario("action_transition"), pending = await prepared(s), before = await state(), record = audit.recordInTransaction.bind(audit);
    vi.spyOn(audit, "recordInTransaction").mockImplementation(async (...args) => { const id = await record(...args);
      if (args[2].action === "advertising.command.execute") throw new Error("Synthetic mutable action rollback"); return id; });
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toThrow("Synthetic mutable action rollback");
    expect(await state()).toEqual(before); expect(await commands.get(a, pending.id, s.accountId)).toMatchObject({ status: "prepared", canExecute: true });
  });

  it("binds the original key to actor, complete body and target while hiding exact commands from other actors, accounts and tenants", async () => {
    const s = await scenario("goal_save"), pending = await prepared(s), another = await account(), before = await state();
    if (s.original.kind !== "goal_save") throw new Error("Synthetic goal required");
    await expect(commands.prepare(a, { ...s.original, input: { ...s.original.input, fields: { ...s.original.input.fields, notes: "Changed original evidence" } } }))
      .rejects.toMatchObject({ status: 409, response: { code: "advertising_command_request_mismatch" } });
    await expect(commands.prepare(context(coworker), s.original)).rejects.toMatchObject({ status: 409 });
    for (const ctx of [context(coworker), context(foreign)]) {
      await expect(commands.get(ctx, pending.id, s.accountId)).rejects.toMatchObject({ status: 404 });
      await expect(commands.original(ctx, pending.id, s.accountId)).rejects.toMatchObject({ status: 404 });
      await expect(commands.execute(ctx, pending.id, s.accountId)).rejects.toMatchObject({ status: 404 });
    }
    await expect(commands.get(a, pending.id, another)).rejects.toMatchObject({ status: 404 });
    await expect(commands.cancel(a, pending.id, another)).rejects.toMatchObject({ status: 404 });
    expect(await state()).toEqual(before);
  });

  it("preserves the real owner key namespace across different accounts and different import parents", async () => {
    const first = await scenario("goal_save"), second = await scenario("goal_save");
    second.original.input.idempotencyKey = first.original.input.idempotencyKey;
    const one = await prepared(first), two = await prepared(second); expect(one.id).not.toBe(two.id);
    await commands.cancel(a, one.id, first.accountId); await commands.cancel(a, two.id, second.accountId);
    const accountId = await account(), imports = (await advertising.commit(a, await importInput(accountId))).imports, sharedKey = key();
    const originals: Scenario[] = imports.slice(0, 2).map(source => ({ accountId, original: { kind: "import_archive", accountId,
      targetId: source.id, input: { reason: "Synthetic separate actual import parent", idempotencyKey: sharedKey } } }));
    const three = await prepared(originals[0]!), four = await prepared(originals[1]!); expect(three.id).not.toBe(four.id);
    expect((await commands.execute(a, three.id, accountId)).result!.parentId).toBe(originals[0]!.original.targetId);
    expect((await commands.execute(a, four.id, accountId)).result!.parentId).toBe(originals[1]!.original.targetId);
  });

  it("rechecks database membership and the original operation instead of trusting stale claims or borrowing tenant Read for self Write", async () => {
    const otherAccount = await account(coworker), s = await scenario("observation_record", otherAccount), pending = await prepared(s), before = await state();
    await grant(owner, [read]);
    expect(await commands.get(a, pending.id, s.accountId)).toMatchObject({ canExecute: false, blockReason: "permission_denied" });
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 403 });
    await grant(owner, [write], "self", [read]);
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 404 });
    await grant(owner, [write], "team", [read]);
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 404 });
    await grant();
    await withTenant(database.db, a, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, owner.membershipId)));
    await expect(commands.get(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 403 });
    await withTenant(database.db, a, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, owner.membershipId)));
    expect(await state()).toEqual(before);
  });

  it("does not borrow a new wider session ceiling to execute a preparation whose original Write scope was narrower", async () => {
    const s = await scenario("observation_record"), ctx: TenantContext = { ...a, permissions: [write], dataScope: "self" };
    await grant(owner, [write], "self"); const pending = await prepared(s, ctx);
    const saved = await commandRow(pending.id); expect(saved.authority_snapshot.dataScope).toBe("self"); expect(saved.authority_snapshot.permissions).toEqual([write]);
    await grant(); expect((await original(s, pending.id)).original).toEqual(s.original);
    const observed: TenantContext[] = [], execute = adapter.execute.bind(adapter);
    vi.spyOn(adapter, "execute").mockImplementation((current, body) => { observed.push(current); return execute(current, body); });
    expect((await commands.execute(a, pending.id, s.accountId)).status).toBe("succeeded");
    expect(observed).toHaveLength(1); expect(observed[0]!.dataScope).toBe("self"); expect(observed[0]!.permissions).toEqual([write]);
  });

  it("preserves the exact goal body when a different actual goal version makes its expected revision stale", async () => {
    const s = await scenario("goal_save"), pending = await prepared(s);
    if (s.original.kind !== "goal_save") throw new Error("Synthetic goal required");
    await advertising.saveGoal(a, { ...s.original.input, idempotencyKey: key(), fields: { ...s.original.input.fields, notes: "Actual competing reviewed goal" } });
    const before = await state(); expect(await commands.get(a, pending.id, s.accountId)).toMatchObject({ status: "prepared", canExecute: false, blockReason: "basis_changed" });
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 409 });
    expect((await original(s, pending.id)).original).toEqual(s.original); expect(await state()).toEqual(before);
  });

  it("does not update an original transition revision or archive basis after a real competing action", async () => {
    const action = await scenario("action_transition"), archive = await scenario("import_archive");
    const aPending = await prepared(action), iPending = await prepared(archive);
    if (action.original.kind !== "action_transition" || archive.original.kind !== "import_archive") throw new Error("Synthetic targeted originals required");
    await advertising.transition(a, action.original.targetId, { ...action.original.input, idempotencyKey: key(), reason: "Actual competing defer" });
    await advertising.archive(a, archive.original.targetId, { ...archive.original.input, idempotencyKey: key() });
    const before = await state();
    for (const [s, id] of [[action, aPending.id], [archive, iPending.id]] as const) {
      expect(await commands.get(a, id, s.accountId)).toMatchObject({ canExecute: false, blockReason: "basis_changed" });
      await expect(commands.execute(a, id, s.accountId)).rejects.toMatchObject({ status: 409 });
      expect((await original(s, id)).original).toEqual(s.original);
    }
    expect(await state()).toEqual(before);
  });

  it("keeps the retained ciphertext usable after a temporary wrong encryption key without using decryption on metadata lists", async () => {
    const s = await scenario("observation_record"), pending = await prepared(s), before = await state(), cipher = (await commandRow(pending.id)).encrypted_input,
      temporary = randomBytes(32);
    try {
      const wrongVault = createAdvertisingCommandVault({ NODE_ENV: "production", ADVERTISING_COMMAND_ENCRYPTION_KEY: temporary.toString("base64url") });
      const decrypt = vi.spyOn(wrongVault, "withSecret"), wrong = new AdvertisingCommandService(database, wrongVault, adapter, audit);
      const list = AdCommandListSchema.parse(await wrong.list(a, { accountId: s.accountId }));
      expect(list.items.map(row => row.id)).toContain(pending.id); expect(decrypt).not.toHaveBeenCalled();
      expect(await wrong.original(a, pending.id, s.accountId)).toMatchObject({ original: null, blockReason: "input_unavailable" });
      await expect(wrong.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 409 });
      expect((await commandRow(pending.id)).encrypted_input).toBe(cipher); expect(await state()).toEqual(before);
      expect((await original(s, pending.id)).original).toEqual(s.original); expect((await service().execute(a, pending.id, s.accountId)).status).toBe("succeeded");
    } finally { temporary.fill(0); }
  });

  it("cancels a preparation without business facts and permanently retains the original key after acknowledgement", async () => {
    const s = await scenario("observation_record"), pending = await prepared(s), before = await state(businessTables);
    await expect(commands.acknowledge(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 409 });
    const cancelled = await commands.cancel(context(owner, [write]), pending.id, s.accountId); expect(cancelled).toMatchObject({ status: "cancelled", originalRetained: false, result: null });
    await commands.acknowledge(a, pending.id, s.accountId); const terminal = await state();
    expect(await commands.prepare(a, s.original)).toMatchObject({ id: pending.id, status: "cancelled", acknowledged: true });
    expect(await commands.execute(a, pending.id, s.accountId)).toMatchObject({ status: "cancelled", result: null });
    await expect(raw(s.original)).rejects.toMatchObject({ status: 409 }); expect(await state(businessTables)).toEqual(before); expect(await state()).toEqual(terminal);
  });

  it("settles a real execute versus cancel race to one terminal state without an orphan actual proof or duplicate event", async () => {
    const s = await scenario("observation_record"), pending = await prepared(s);
    const outcomes = await Promise.allSettled([commands.execute(a, pending.id, s.accountId), service().cancel(a, pending.id, s.accountId)]);
    expect(outcomes.every(outcome => outcome.status === "fulfilled")).toBe(true);
    const final = await commands.get(a, pending.id, s.accountId); expect(["cancelled", "succeeded"]).toContain(final.status);
    const proofs = await withTenant(database.db, a, tx => tx.execute(sql`select result_id from advertising_original_write_proofs where command_id=${pending.id}::uuid`));
    expect(proofs).toHaveLength(final.status === "succeeded" ? 1 : 0);
    if (final.status === "succeeded") await assertActual(s, pending.id, final.result!);
    const before = await state(); expect((await commands.execute(a, pending.id, s.accountId)).result).toEqual(final.result); expect(await state()).toEqual(before);
  });

  it("does not hold a membership lock during the actual clean scan and refuses upload after current Write is revoked", async () => {
    const s = await scenario("import_commit"), pending = await prepared(s), before = await state(), scan = scanner.scan.bind(scanner), put = vi.spyOn(storage, "putPrivate");
    vi.spyOn(scanner, "scan").mockImplementationOnce(async (...args) => { const result = await scan(...args); expect(result.result).toBe("clean"); await grant(owner, [read, review]); return result; });
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 403 }); expect(put).not.toHaveBeenCalled();
    expect(await state()).toEqual(before); await grant(); expect((await original(s, pending.id)).original).toEqual(s.original);
  });

  it("discards only the exact unreferenced real upload when Write is revoked after storage returns its receipt", async () => {
    const s = await scenario("import_commit"), pending = await prepared(s), before = await state(), put = storage.putPrivate.bind(storage), uploaded: Upload[] = [];
    vi.spyOn(storage, "putPrivate").mockImplementationOnce(async (...args) => { const receipt = await put(...args);
      uploaded.push({ id: args[1].fileName.slice(0, -4), objectKey: receipt.objectKey }); await grant(owner, [read, review]); return receipt; });
    await expect(commands.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 403 }); expect(await state()).toEqual(before);
    await grant(); await assertDiscarded(uploaded); expect((await original(s, pending.id)).original).toEqual(s.original);
  });

  it("never adopts a different raw batch that wins the same-content race while its own command is being scanned", async () => {
    const s = await scenario("import_commit"), pending = await prepared(s), scan = scanner.scan.bind(scanner), uploaded = captureUploads();
    if (s.original.kind !== "import_commit") throw new Error("Synthetic import required");
    const originalInput = s.original.input, rawInput = { ...originalInput, idempotencyKey: key() };
    let winner: AdImportView[] = [];
    const independent = new AsyncResource("synthetic-independent-raw-import");
    vi.spyOn(scanner, "scan").mockImplementationOnce(async (...args) => { const result = await scan(...args);
      // A separate raw owner call is intentional. ALS for the prepared command
      // must not leak into this independently created async request.
      winner = await independent.runInAsyncScope(() => advertising.commit(a, rawInput)).then(value => value.imports);
      return result;
    });
    try { await expect(commands.execute(a, pending.id, s.accountId)).rejects.toMatchObject({ status: 409 }); }
    finally { independent.emitDestroy(); }
    expect(winner).toHaveLength(originalInput.files.length); expect((await commandRow(pending.id)).status).toBe("prepared");
    const actual = await proof({ ...s.original, input: rawInput }); expect(actual.command_id).toBeNull();
    const retained = new Set((await withTenant(database.db, a, tx => tx.execute<{ object_key: string }>(sql`select object_key from ad_imports where account_id=${s.accountId}::uuid`))).map(row => row.object_key));
    const discarded = uploaded.filter(item => !retained.has(item.objectKey)); await assertDiscarded(discarded);
    for (const file of winner) expect((await advertising.readSource(a, file.id)).bytes.length).toBeGreaterThan(0);
    expect((await original(s, pending.id)).original).toEqual(s.original);
  }, 60_000);

  it("recovers a complete near-20-MiB four-file CSV original without leaking it into metadata or clipping any source bytes", async () => {
    const accountId = await account(), cap = 5 * 1024 * 1024;
    const files = Array.from({ length: 4 }, (_, file) => {
      const first = `${header},Original note\r\n`;
      const rows: string[] = []; let bytes = Buffer.byteLength(first);
      while (true) {
        // Each row is a real distinct campaign fact. Repeating the same
        // campaign/period is correctly quarantined as DUPLICATE_ROW by the parser.
        const next = `${csvRow.replace(",campaign,", `,campaign-${file}-${rows.length},`)},${"x".repeat(3000)}`;
        if (bytes + Buffer.byteLength(next) + 2 > cap) break;
        rows.push(next); bytes += Buffer.byteLength(next) + 2;
      }
      return { fileName: `synthetic-complete-${file}.csv`, content: first + rows.join("\r\n") + "\r\n" };
    });
    expect(files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)).toBeGreaterThan(20 * 1024 * 1024 - 16_000);
    const s: Scenario = { accountId, original: PrepareAdCommandSchema.parse({ kind: "import_commit", accountId, targetId: null, input: await importInput(accountId, files) }) };
    const pending = await prepared(s), before = await state(), list = await commands.list(a, { accountId });
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(64 * 1024); expect(JSON.stringify(list)).not.toContain("Original note");
    const recovered = await original(s, pending.id); expect(recovered.original).toEqual(s.original);
    if (recovered.original?.kind !== "import_commit") throw new Error("Synthetic complete original import missing");
    expect(recovered.original.input.files.map(file => createHash("sha256").update(file.content).digest("hex")))
      .toEqual(files.map(file => createHash("sha256").update(file.content).digest("hex")));
    expect(await state()).toEqual(before);
  }, 120_000);

  it("rejects canonical UTF-8 amplification above 32 MiB and over-size individual CSV files without persisting a truncated command", async () => {
    const s = await scenario("import_commit"); if (s.original.kind !== "import_commit") throw new Error("Synthetic import required");
    const before = await state(), amplified = PrepareAdCommandSchema.parse({ ...s.original, input: { ...s.original.input, files: Array.from({ length: 4 }, (_, i) => ({
      fileName: `synthetic-amplified-${i}.csv`, content: "\\".repeat(4 * 1024 * 1024) })) } });
    expect(Buffer.byteLength(JSON.stringify(amplified))).toBeGreaterThan(AD_COMMAND_MAX_PLAINTEXT_BYTES);
    await expect(Promise.resolve().then(() => commands.prepare(a, amplified))).rejects.toMatchObject({ status: 413 });
    await expect(Promise.resolve().then(() => commands.prepare(a, { ...s.original, input: { ...s.original.input, files: [{ fileName: "synthetic-over.csv", content: "界".repeat(2 * 1024 * 1024) }] } })))
      .rejects.toMatchObject({ status: 413 });
    expect(await state()).toEqual(before);
  }, 60_000);

  it("advances a 50-slot metadata cursor across entirely hidden operation rows without decrypting or losing the older authorized command", async () => {
    const accountId = await account(), oldest = await scenario("observation_record", accountId), first = await prepared(oldest);
    for (let index = 0; index < 51; index++) await commands.prepare(a, { kind: "goal_save", accountId, targetId: null, input: goalInput(accountId, 0, `B${String(index).padStart(9, "0")}`) });
    const decrypt = vi.spyOn(vault, "withSecret"), before = await state(); await grant(owner, [write]); const ctx = context(owner, [write]);
    const page = AdCommandListSchema.parse(await commands.list(ctx, { accountId }));
    expect(page.items).toEqual([]); expect(page.unavailableCount).toBe(50); expect(page.nextCursor).not.toBeNull();
    const next = AdCommandListSchema.parse(await commands.list(ctx, { accountId, before: page.nextCursor! }));
    expect(next.items.map(row => row.id)).toEqual([first.id]); expect(next.unavailableCount).toBe(1); expect(next.nextCursor).toBeNull();
    expect(decrypt).not.toHaveBeenCalled(); expect(await state()).toEqual(before);
  });

  it("keeps database-minted proof and mutation evidence read-only under the actual forced-RLS application role", async () => {
    const s = await scenario("observation_record"), pending = await prepared(s); await commands.execute(a, pending.id, s.accountId);
    const before = await state();
    for (const table of ["advertising_original_write_proofs", "advertising_owner_mutation_evidence", "advertising_command_audit_receipts"]) {
      for (const statement of [sql`insert into ${sql.raw(table)} select * from ${sql.raw(table)} limit 1`,
        sql`update ${sql.raw(table)} set tenant_id=tenant_id`, sql`delete from ${sql.raw(table)}`]) {
        await expect(withTenant(database.db, a, tx => tx.execute(statement))).rejects.toSatisfy((error: unknown) => pg(error).code === "42501");
      }
    }
    expect(await state()).toEqual(before);
    const visibility = await withTenant(database.db, context(foreign), tx => tx.execute(sql`select result_id from advertising_original_write_proofs where command_id=${pending.id}::uuid`));
    expect(visibility).toEqual([]);
  });

  it("rejects a forged session marker that attempts to claim a prepared observation without its actual body and dual transaction outcome", async () => {
    const s = await scenario("observation_record"), pending = await prepared(s), before = await state();
    if (s.original.kind !== "observation_record") throw new Error("Synthetic observation required");
    const changed = { ...s.original.input, source: "Synthetic forged different original evidence" },
      { idempotencyKey, ...data } = changed;
    await expect(withTenant(database.db, a, async tx => {
      await tx.execute(sql`select set_config('app.advertising_command_id',${pending.id},true)`);
      await tx.execute(sql`insert into ad_observations(id,tenant_id,account_id,created_by,data,idempotency_key,input_checksum)
        values(${createEntityId()}::uuid,${tenantId}::uuid,${s.accountId}::uuid,${owner.userId}::uuid,
        ${JSON.stringify({ ...data, monetaryBasis: adCurrencyBasis(data.scope.currency) })}::jsonb,${idempotencyKey},${adHash({ ...changed, idempotencyKey: undefined })})`);
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514");
    expect(await state()).toEqual(before); expect((await original(s, pending.id)).original).toEqual(s.original);
  });

  it("requires the reverse actual-owner outcome even when a real prepared marker and correct same-transaction owner audit exist", async () => {
    const s = await scenario("observation_record"), pending = await prepared(s), before = await state();
    if (s.original.kind !== "observation_record") throw new Error("Synthetic observation required");
    const input = s.original.input, { idempotencyKey, ...data } = input, id = createEntityId(); let inserted = false;
    await expect(withTenant(database.db, a, async tx => {
      await tx.execute(sql`select set_config('app.advertising_command_id',${pending.id},true)`);
      await tx.execute(sql`insert into ad_observations(id,tenant_id,account_id,created_by,data,idempotency_key,input_checksum)
        values(${id}::uuid,${tenantId}::uuid,${s.accountId}::uuid,${owner.userId}::uuid,
        ${JSON.stringify({ ...data, monetaryBasis: adCurrencyBasis(data.scope.currency) })}::jsonb,${idempotencyKey},${adHash({ ...input, idempotencyKey: undefined })})`);
      await audit.recordInTransaction(tx, a, { action: "advertising.observation", resourceType: "ad_observation", resourceId: id,
        result: "success", metadata: { kind: data.kind } }); inserted = true;
      // No coordinator outcome or execute audit is manufactured by this raw caller.
    })).rejects.toSatisfy((error: unknown) => pg(error).code === "23514" && pg(error).message === "advertising_original_outcome_missing");
    expect(inserted).toBe(true); expect(await state()).toEqual(before); expect(await commands.get(a, pending.id, s.accountId)).toMatchObject({ status: "prepared", result: null });
  });

  it("execution-time precision rejects inexact preparation and raw execution but commits a real exactly representable execution event", async () => {
    const s = await scenario("action_transition"); if (!s.action || s.original.kind !== "action_transition") throw new Error("Synthetic bid action required");
    const adopted = await advertising.transition(a, s.action.id, AdActionEventInputSchema.parse({ expectedRevision: s.action.revision,
      expectedStatus: s.action.status, status: "adopted", reason: "Synthetic actual manual review before precision check", idempotencyKey: key() }));
    const at = await clock(), exactAt = `${at.slice(0, -1)}000Z`, inexactAt = `${at.slice(0, -1)}001Z`;
    expect(exactAt).not.toBe(at); expect(new Date(exactAt).toISOString()).toBe(at);
    const input = AdActionEventInputSchema.parse({ expectedRevision: adopted.revision, expectedStatus: adopted.status, status: "executed",
      reason: "Synthetic actual execution of original bid with exact physical millisecond", executedAt: exactAt,
      actualBeforeMinor: 100, actualAfterMinor: 85, executionCampaignId: adopted.recommendation.campaignId,
      executionAdGroupId: adopted.recommendation.adGroupId, executionTargetId: adopted.recommendation.targetId, idempotencyKey: key() });
    const before = await state(), bad = { ...input, executedAt: inexactAt };
    await expect(Promise.resolve().then(() => commands.prepare(a, { kind: "action_transition", accountId: s.accountId, targetId: adopted.id, input: bad })))
      .rejects.toMatchObject({ status: 400, response: { code: "advertising_command_input_invalid" } });
    await expect(advertising.transition(a, adopted.id, bad)).rejects.toMatchObject({ status: 422 }); expect(await state()).toEqual(before);
    const originalExecution: Scenario = { accountId: s.accountId, original: PrepareAdCommandSchema.parse({ kind: "action_transition",
      accountId: s.accountId, targetId: adopted.id, input }) };
    const pending = await prepared(originalExecution), done = await commands.execute(a, pending.id, s.accountId);
    expect(done.status).toBe("succeeded"); expect(done.result).toMatchObject({ kind: "action_transition", parentId: adopted.id, version: adopted.revision + 1 });
    await assertActual(originalExecution, pending.id, done.result!);
    expect((await original(originalExecution, pending.id)).original).toEqual(originalExecution.original);
    const [actual] = await withTenant(database.db, a, tx => tx.execute<{ executed_at: Date; event_at: string }>(sql`
      select a.executed_at,e.data->>'executedAt' as event_at from ad_actions a join ad_action_events e on e.action_id=a.id
      where a.id=${adopted.id}::uuid and e.id=${done.result!.id}::uuid`));
    expect(actual!.event_at).toBe(exactAt); expect(new Date(actual!.executed_at).toISOString()).toBe(at);
  });

  it("invalid-transition preparation rejects pending to reviewed without creating a command or any business or audit row", async () => {
    const s = await scenario("action_transition"); if (s.original.kind !== "action_transition") throw new Error("Synthetic pending transition required");
    const input = AdActionEventInputSchema.parse({ ...s.original.input, status: "reviewed", reason: "Synthetic invalid direct jump without real execution or observation", idempotencyKey: key() });
    const before = await state();
    await expect(commands.prepare(a, { ...s.original, input })).rejects.toMatchObject({ status: 409 });
    await expect(advertising.transition(a, s.original.targetId, input)).rejects.toMatchObject({ status: 409 }); expect(await state()).toEqual(before);
    const [count] = await withTenant(database.db, a, tx => tx.execute<{ n: number }>(sql`select count(*)::int as n from advertising_commands where account_id=${s.accountId}::uuid`));
    expect(count!.n).toBe(0);
  });

  it("uses the database seven-day clock to expire prepared input and redact successful input without changing original facts or result proofs", async () => {
    const pendingScenario = await scenario("observation_record"), succeededScenario = await scenario("goal_save");
    const pending = await prepared(pendingScenario), preparedSuccess = await prepared(succeededScenario);
    const succeeded = await commands.execute(a, preparedSuccess.id, succeededScenario.accountId), business = await state(businessTables);
    const [databaseIdentity] = await database.client.unsafe("select current_database() as database");
    expect(databaseIdentity!.database).toBe(`order_daily_e2e_${nonce}`);
    const [definition] = await database.client.unsafe("select pg_get_functiondef('public.advertising_command_now()'::regprocedure) as definition");
    const originalDefinition = String(definition!.definition), beforeHash = createHash("sha256").update(originalDefinition).digest("hex");
    const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "tmp/advertising-command-20261021-e3a58d70");
    await mkdir(root, { recursive: true }); const output = await mkdtemp(resolve(root, "qa-clock-"));
    let afterHash: string | null = null, redacted = 0;
    try {
      await database.client.unsafe("create or replace function public.advertising_command_now() returns timestamptz language sql volatile security invoker set search_path=pg_catalog,public as $$ select clock_timestamp()+interval '8 days' $$");
      for (const id of [pending.id, preparedSuccess.id]) redacted += await withTenant(database.db, a,
        tx => expireAdvertisingCommandInputs(tx, { actorId: owner.userId, commandId: id, limit: 1 }));
      expect(redacted).toBe(2);
      expect(await commands.get(a, pending.id, pendingScenario.accountId)).toMatchObject({ status: "expired", originalRetained: false, result: null, canExecute: false, blockReason: "expired" });
      expect(await original(pendingScenario, pending.id)).toMatchObject({ original: null, blockReason: "expired" });
      expect(await commands.get(a, preparedSuccess.id, succeededScenario.accountId)).toMatchObject({ status: "succeeded", originalRetained: false, result: succeeded.result });
      expect(await original(succeededScenario, preparedSuccess.id)).toMatchObject({ original: null, blockReason: "input_unavailable" });
      expect((await commandRow(pending.id)).encrypted_input).toBeNull(); expect((await commandRow(preparedSuccess.id)).encrypted_input).toBeNull();
      expect(await withTenant(database.db, a, tx => expireAdvertisingCommandInputs(tx, { actorId: owner.userId, commandId: pending.id, limit: 1 }))).toBe(0);
      await expect(raw(pendingScenario.original)).rejects.toMatchObject({ status: 409 });
      expect(await state(businessTables)).toEqual(business);
    } finally {
      try {
        await database.client.unsafe(originalDefinition);
        const [restored] = await database.client.unsafe("select pg_get_functiondef('public.advertising_command_now()'::regprocedure) as definition");
        afterHash = createHash("sha256").update(String(restored!.definition)).digest("hex"); expect(afterHash).toBe(beforeHash);
      } finally {
        await writeFile(resolve(output, "clock-restore.json"), JSON.stringify({ schemaVersion: 1, nonce, database: databaseIdentity!.database,
          function: "public.advertising_command_now()", beforeSha256: beforeHash, afterSha256: afterHash, restored: beforeHash === afterHash,
          commandIds: [pending.id, preparedSuccess.id], redacted }, null, 2) + "\n");
      }
    }
  });
});
