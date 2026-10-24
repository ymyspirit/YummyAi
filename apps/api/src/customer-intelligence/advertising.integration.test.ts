import { describe, beforeAll, afterAll, it, expect, vi } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz";
import {
  AdGoalFieldsSchema,
  AdExportViewSchema,
  type AdImportInput,
  type AdGoalVersion,
  type AdAnalysisRun,
  type AdActionView,
} from "@yummyai/contracts/advertising";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  adImports,
  adFacts,
  adGoalVersions,
} from "@yummyai/database";
import { createStorageFromEnvironment, ClamAvScanner } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { AdvertisingService } from "./advertising.service.js";
import { AuditService } from "../audit/audit.service.js";
import { MarketplaceAccountService } from "../marketplaces/marketplace-account.service.js";
import { AdSourceGateway } from "./ad-source.gateway.js";
import { adHash } from "./ad-csv-parser.js";

// Immutable histories live only in an owned disposable database and bucket.
const isolated =
  /^\/order_daily_e2e_[a-f0-9]{32}$/.test(
    new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname,
  ) && process.env.E2E_ISOLATED_DAILY === "1";
if (!isolated)
  throw new Error("Use --suite=advertising-integration; real business resources are forbidden");
describe.sequential("advertising workbench tenant persistence", () => {
  const database = connectDatabase(),
    storage = createStorageFromEnvironment();
  const tenantA = createEntityId(),
    tenantB = createEntityId(),
    userA = createEntityId(),
    userB = createEntityId(),
    accountA = createEntityId(),
    accountB = createEntityId();
  const roleA = createEntityId(), roleB = createEntityId(), membershipA = createEntityId(), membershipB = createEntityId();
  const ctx = (tenantId: string, userId: string): TenantContext => ({
    tenantId,
    userId,
    permissions: [
      Permission.CustomerIntelligenceRead,
      Permission.CustomerIntelligenceWrite,
      Permission.CustomerIntelligenceReview,
    ],
    dataScope: "tenant",
  });
  const a = ctx(tenantA, userA),
    b = ctx(tenantB, userB),
    scope = {
      accountId: accountA,
      marketplace: "US" as const,
      currency: "USD",
      asin: "B012345678",
    };
  const service = new AdvertisingService(
    database,
    new AuditService(database),
    new AdSourceGateway(storage, new ClamAvScanner()),
  );
  const headers =
    "日期范围,广告主账户 ID,广告产品,广告活动编号,广告组编号,预算货币,展示量,点击量,购买量,总成本,销售额";
  const row = "2026年09月01日 - 2026年09月15日,advertiser,SP,campaign,group,USD,1000,40,4,10,40";
  const csvs = [
    { fileName: "campaign.csv", content: `${headers}\n${row}` },
    { fileName: "product.csv", content: `${headers},推广的商品编号\n${row},B012345678` },
    {
      fileName: "target.csv",
      content: `${headers},投放方案编号,投放方案,目标竞价,投放状态\n${row},target,custom pillow,1,ENABLED`,
    },
  ];
  const importInput: AdImportInput = {
    accountId: accountA,
    marketplaceByCurrency: { USD: "US" },
    timezone: "America/Los_Angeles",
    attributionWindowDays: 7,
    attributionBasis: "click",
    observedAt: "2026-09-16T18:00:00.000Z",
    dateOrder: null,
    allowPartial: false,
    idempotencyKey: "batch-original",
    files: csvs.map((f) => ({ ...f, reportTypeHint: null, adProductHint: null })),
  };
  let importedId = "",
    goal: AdGoalVersion,
    run: AdAnalysisRun,
    action: AdActionView;
  beforeAll(async () => {
    await migrateDatabase(database);
    await storage.ensureBucket();
    for (const [tenant, user, acct, role, membership] of [
      [tenantA, userA, accountA, roleA, membershipA],
      [tenantB, userB, accountB, roleB, membershipB],
    ]) {
      await database.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Synthetic advertising',$2)",
        [tenant!, `ad-${tenant}`],
      );
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic operator')",
        [user!, `ad-${user}`, `${user}@yummyai.invalid`],
      );
      await database.client.unsafe(
        "insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon','Synthetic ad shop','NA','amazon_private',$3)",
        [acct!, tenant!, user!],
      );
      await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [membership!, tenant!, user!]);
      await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
        [role!, tenant!, `Synthetic advertising role ${role}`, JSON.stringify([...ctx(tenant!, user!).permissions, Permission.StoreManage])]);
      await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [tenant!, membership!, role!]);
    }
  });
  afterAll(async () => {
    try {
      for (const [tenant, role, membership] of [[tenantA, roleA, membershipA], [tenantB, roleB, membershipB]]) {
        await database.client.unsafe("delete from membership_roles where tenant_id=$1 and membership_id=$2 and role_id=$3", [tenant!, membership!, role!]);
        await database.client.unsafe("delete from roles where tenant_id=$1 and id=$2", [tenant!, role!]);
        await database.client.unsafe("delete from memberships where tenant_id=$1 and id=$2", [tenant!, membership!]);
      }
      // The disposable runner removes the immutable fixture history and private bucket.
    } finally { await database.client.end(); }
  });
  it("previews and commits scanned byte-exact evidence, replays without double counting, and isolates tenants", async () => {
    const preview = await service.preview(a, importInput);
    expect(preview.canCommit).toBe(true);
    expect(preview.files.map((f) => f.reportType)).toEqual([
      "campaign",
      "advertised_product",
      "targeting",
    ]);
    expect(preview.files.reduce((n, f) => n + f.acceptedRowCount, 0)).toBe(3);
    const input = { ...importInput, previewChecksum: preview.previewChecksum },
      first = await service.commit(a, input);
    importedId = first.imports[0]!.id;
    expect(first.imports).toHaveLength(3);
    expect((await service.commit(a, input)).replayed).toBe(true);
    expect(
      adHash(Buffer.from((await service.readSource(a, importedId)).bytes).toString("utf8")),
    ).toBe(adHash(csvs[0]!.content));
    expect((await service.workspace(b)).imports).toHaveLength(0);
    await expect(service.readSource(b, importedId)).rejects.toThrow();
    await expect(service.preview(b, importInput)).rejects.toThrow();
    const privileges = await withTenant(
      database.db,
      a,
      async (tx) =>
        (
          await tx.execute(
            sql`select current_user as role, has_table_privilege(current_user,'ad_facts','UPDATE') as update_facts, has_table_privilege(current_user,'ad_goal_versions','DELETE') as delete_goals`,
          )
        )[0],
    );
    expect(privileges).toMatchObject({
      role: "yummyai_app",
      update_facts: false,
      delete_goals: false,
    });
    await expect(
      withTenant(database.db, a, (tx) => tx.update(adFacts).set({ entityKey: "changed" })),
    ).rejects.toThrow();
  });
  it("rejects changed preview metadata, recycled request keys and write permissions", async () => {
    const preview = await service.preview(a, importInput);
    await expect(
      service.commit(a, {
        ...importInput,
        timezone: "UTC",
        previewChecksum: preview.previewChecksum,
      }),
    ).rejects.toThrow();
    const changed = { ...importInput, observedAt: "2026-09-17T18:00:00.000Z" },
      p = await service.preview(a, changed);
    await expect(
      service.commit(a, { ...changed, previewChecksum: p.previewChecksum }),
    ).rejects.toThrow();
    await expect(
      service.preview({ ...a, permissions: [Permission.CustomerIntelligenceRead] }, importInput),
    ).rejects.toThrow();
    const infected = new AdvertisingService(
      database,
      new AuditService(database),
      new AdSourceGateway(storage, {
        async scan() {
          return {
            result: "infected",
            engine: "test-denial",
            signatureVersion: "fixture",
            scannedAt: new Date().toISOString(),
          };
        },
      }),
    );
    await expect(
      infected.commit(a, {
        ...importInput,
        idempotencyKey: "infected-test",
        observedAt: "2026-09-18T18:00:00.000Z",
        previewChecksum: (
          await infected.preview(a, {
            ...importInput,
            idempotencyKey: "infected-test",
            observedAt: "2026-09-18T18:00:00.000Z",
          })
        ).previewChecksum,
      }),
    ).rejects.toThrow();
    expect((await service.workspace(a)).imports).toHaveLength(3);
  });
  it("creates immutable product targets and pins sealed analyses with optimistic revision checks", async () => {
    const input = {
      scope,
      expectedRevision: 0,
      fields: AdGoalFieldsSchema.parse({
        mode: "profit_defense",
        effectiveFrom: "2026-09-01",
        targetAcosBps: 2100,
        unitPriceMinor: 10000,
        unitCostMinor: 7000,
        coreKeywords: [],
        protectedTerms: [],
        trialEndDate: null,
        trialSpendLimitMinor: null,
      }),
      idempotencyKey: "goal-version-1",
    };
    goal = await service.saveGoal(a, input);
    expect(goal.revision).toBe(1);
    expect((await service.saveGoal(a, input)).id).toBe(goal.id);
    await expect(
      service.saveGoal(a, {
        ...input,
        idempotencyKey: "goal-conflict",
        fields: { ...input.fields, notes: "conflicting" },
      }),
    ).rejects.toThrow();
    await expect(
      withTenant(database.db, a, (tx) =>
        tx
          .update(adGoalVersions)
          .set({ checksum: "b".repeat(64) })
          .where(eq(adGoalVersions.id, goal.id)),
      ),
    ).rejects.toThrow();
    const analyzeInput = {
      accountId: accountA,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
      marketplace: null,
      currency: null,
      evidenceCutoffAt: new Date().toISOString(),
      idempotencyKey: "analysis-v1",
    };
    run = await service.analyze(a, analyzeInput);
    expect(run.result.totals[0]?.metrics.spendMinor).toBe(1000);
    expect(run.result.goalVersionIds).toContain(goal.id);
    expect((await service.analyze(a, analyzeInput)).id).toBe(run.id);
    action = (await service.workspace(a)).actions.find(
      (x) => x.recommendation.kind === "lower_bid",
    )!;
    expect(action.recommendation.proposedBidMinor).toBe(85);
    const facts = await service.facts(a, {
      accountId: accountA,
      search: "custom",
      page: 1,
      pageSize: 1,
    });
    expect(facts.count).toBe(1);
    expect(facts.rows[0]?.fact.term).toBe("custom pillow");
  });
  it("keeps approval, bounded actual execution, cooldown, and immutable reviewed export separate", async () => {
    const event = (status: AdActionView["status"], key: string) => ({
      expectedRevision: action.revision,
      expectedStatus: action.status,
      status,
      reason: "Synthetic human review",
      idempotencyKey: key,
      executedAt: null,
      actualBeforeMinor: null,
      actualAfterMinor: null,
      executionCampaignId: null,
      executionAdGroupId: null,
      executionTargetId: null,
    });
    await expect(
      service.transition(a, action.id, {
        ...event("executed", "skip-approve"),
        executedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    action = await service.transition(a, action.id, event("adopted", "approve-first"));
    const execution = {
      ...event("executed", "execute-first"),
      executedAt: new Date().toISOString(),
      actualBeforeMinor: 100,
      actualAfterMinor: 85,
      executionCampaignId: "campaign",
      executionAdGroupId: "group",
      executionTargetId: "target",
    };
    await expect(
      service.transition(a, action.id, {
        ...execution,
        actualAfterMinor: 1,
        idempotencyKey: "excess-cut",
      }),
    ).rejects.toThrow();
    await expect(
      service.transition(a, action.id, {
        ...execution,
        executionTargetId: "another",
        idempotencyKey: "wrong-target",
      }),
    ).rejects.toThrow();
    action = await service.transition(a, action.id, execution);
    expect(action.executedAt).toBe(execution.executedAt);
    expect((await service.transition(a, action.id, execution)).status).toBe("executed");
    const sealed = await service.sealExport(a, {
      runId: run.id,
      actionIds: [action.id],
      reviewReason: "Reviewed manual operation",
      idempotencyKey: "export-v1",
    });
    expect(sealed.checksum).toBe(adHash(sealed.payload));
    expect(sealed.payload.actions[0]?.actualAfterMinor).toBe(85);
    expect(sealed.payload.actions[0]?.execution).toEqual({
      campaignId: "campaign",
      adGroupId: "group",
      targetId: "target",
    });
    expect(sealed.payload.sourcePins).toHaveLength(3);
    expect(
      sealed.payload.sourcePins?.every(
        (s) => s.checksum.length === 64 && !Object.hasOwn(s, "rawObjectKey"),
      ),
    ).toBe(true);
    const legacy = structuredClone(sealed);
    delete legacy.payload.sourcePins;
    for (const row of legacy.payload.actions) delete row.execution;
    expect(adHash(AdExportViewSchema.parse(legacy).payload)).toBe(adHash(legacy.payload));
    action = await service.transition(a, action.id, event("observing", "observe-first"));
    await expect(
      service.transition(a, action.id, event("reviewed", "too-early-review")),
    ).rejects.toThrow();
    expect((await service.readExport(a, sealed.id)).payload.actions[0]?.status).toBe("executed");
    await expect(service.readExport(b, sealed.id)).rejects.toThrow();
    const next = await service.analyze(a, {
      accountId: accountA,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
      marketplace: null,
      currency: null,
      evidenceCutoffAt: new Date().toISOString(),
      idempotencyKey: "cooldown-analysis",
    });
    expect(next.result.recommendations.some((r) => r.ruleId === "AD_COOLDOWN")).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.parse(execution.executedAt) + 8 * 86400000));
      action = await service.transition(a, action.id, event("reviewed", "complete-review"));
      expect(action.status).toBe("reviewed");
      expect(action.execution?.targetId).toBe("target");
      expect((await service.readExport(a, sealed.id)).payload.actions[0]?.status).toBe("executed");
    } finally {
      vi.useRealTimers();
    }
  });
  it("stores source-qualified commerce and natural rank, archives instead of mutating source evidence", async () => {
    const observation = {
      scope,
      kind: "commerce" as const,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
      source: "Synthetic full-product commerce report",
      keyword: null,
      organicRank: null,
      totalSalesMinor: 5000,
      totalPurchases: 8,
      preAdContributionMinor: 2500,
      adsCoverageConfirmed: true,
      observedAt: new Date().toISOString(),
      idempotencyKey: "commerce-1",
    };
    const observed = await service.recordObservation(a, observation);
    expect((await service.recordObservation(a, observation)).id).toBe(observed.id);
    await service.recordObservation(a, {
      ...observation,
      kind: "organic_rank",
      periodEnd: observation.periodStart,
      keyword: "custom pillow",
      organicRank: 12,
      totalSalesMinor: null,
      totalPurchases: null,
      preAdContributionMinor: null,
      adsCoverageConfirmed: false,
      idempotencyKey: "organic-rank-1",
    });
    const analyzed = await service.analyze(a, {
      accountId: accountA,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
      marketplace: null,
      currency: null,
      evidenceCutoffAt: new Date().toISOString(),
      idempotencyKey: "commerce-analysis",
    });
    expect(analyzed.result.products[0]).toMatchObject({
      postAdContributionMinor: 1500,
      tacosBps: 2000,
    });
    await service.archive(a, importedId, {
      reason: "Synthetic source superseded",
      idempotencyKey: "archive-1",
    });
    expect(
      (await service.workspace(a)).imports.find((i) => i.id === importedId)?.archivedAt,
    ).not.toBeNull();
    await expect(
      withTenant(database.db, a, (tx) =>
        tx.update(adImports).set({ fileName: "rewritten.csv" }).where(eq(adImports.id, importedId)),
      ),
    ).rejects.toThrow();
    const original = (await service.workspace(a)).analyses.find((r) => r.id === run.id);
    expect(original?.result.products[0]?.goal?.id).toBe(goal.id);
  });

  it("omits removed shops and rejects new advertising work without deleting report history", async () => {
    const accounts = new MarketplaceAccountService(database, new AuditService(database));
    await accounts.remove({ ...a, permissions: [...a.permissions, Permission.StoreManage] }, accountA);
    expect((await service.workspace(a)).accounts.some((entry) => entry.id === accountA)).toBe(false);
    await expect(service.workspace(a, accountA)).rejects.toMatchObject({ status: 404 });
    await expect(service.preview(a, importInput)).rejects.toMatchObject({ status: 404 });
    const retained = await withTenant(database.db, a, (tx) => tx.select().from(adImports).where(eq(adImports.accountId, accountA)));
    expect(retained.some((entry) => entry.id === importedId)).toBe(true);
  });
});
