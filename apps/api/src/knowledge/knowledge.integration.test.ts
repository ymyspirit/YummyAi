import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { KnowledgeFieldsSchema, type KnowledgeFields } from "@yummyai/contracts/knowledge";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  knowledgeVersions,
  type DatabaseConnection,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { KnowledgeService } from "./knowledge.service.js";
const disposable = /^\/order_daily_(?:e2e|test)_[a-f0-9]{32}$/.test(
  new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname,
);
describe.skipIf(!disposable)("native knowledge tenant lifecycle and immutable retrieval", () => {
  let database: DatabaseConnection, service: KnowledgeService, a: TenantContext, b: TenantContext;
  const fields: KnowledgeFields = {
    title: "Synthetic Listing 知识",
    summary: "Synthetic test only",
    body: "Synthetic Listing 文案依照确认的商品事实，不臆造包装。",
    topic: "listing",
    platform: "amazon",
    market: "US",
    spuId: null,
    sourceType: "team",
    sourceLabel: "Synthetic fixture",
    sourceUrl: "",
    owner: "Synthetic operator",
    verifiedOn: "2026-01-01",
    reviewDueOn: "2099-12-31",
    tags: ["Listing"],
  };
  const query = {
    query: "Synthetic Listing",
    topic: "listing",
    platform: "amazon",
    market: "US",
    spuIds: [],
  };
  const save = (overrides = {}) => ({
    fields,
    expectedRevision: 0,
    reason: "Synthetic create",
    requestId: randomUUID(),
    ...overrides,
  });
  beforeAll(async () => {
    database = connectDatabase(process.env.DATABASE_URL!);
    await migrateDatabase(database);
    service = new KnowledgeService(database, new AuditService(database));
    a = await tenant();
    b = await tenant();
  });
  afterAll(async () => {
    await database?.client.end();
  }); // Runner verifies deletion of the complete disposable database.
  async function transition(
    id: string,
    action: "submit" | "publish" | "reject" | "disable" | "archive",
    context = a,
  ) {
    const entry = (await service.workspace(context)).entries.find((e) => e.id === id)!;
    const payload = {
      expectedRevision: entry.revision,
      version: action === "disable" ? entry.activeVersion : entry.latestVersion,
      reason: `Synthetic ${action}`,
      requestId: randomUUID(),
    };
    const result = await service.change(context, id, action, payload);
    expect(await service.change(context, id, action, payload)).toEqual(result);
  }
  it("keeps drafts out of retrieval and requires explicit review publication", async () => {
    const payload = save(),
      created = await service.save(a, null, payload);
    expect(await service.save(a, null, payload)).toEqual(created);
    await expect(service.save(a, null, { ...payload, reason: "changed" })).rejects.toThrow(
      "已变化",
    );
    expect((await service.search(a, query)).references).toEqual([]);
    await expect(
      service.change(a, created.id, "publish", {
        expectedRevision: 1,
        version: 1,
        reason: "bypass",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("提交审核");
    await transition(created.id, "submit");
    await transition(created.id, "publish");
    const pinned = (await service.search(a, query)).references,
      original = JSON.stringify(pinned);
    expect(pinned[0]?.version).toBe(1);
    expect(pinned[0]?.excerpt).toContain("不臆造包装");
    await service.save(
      a,
      created.id,
      save({ expectedRevision: 3, fields: { ...fields, body: "Synthetic Listing 新的草稿" } }),
    );
    expect((await service.search(a, query)).references[0]?.version).toBe(1);
    await transition(created.id, "submit");
    await transition(created.id, "publish");
    expect((await service.search(a, query)).references[0]?.version).toBe(2);
    expect(JSON.stringify(pinned)).toBe(original);
    await transition(created.id, "disable");
    expect((await service.search(a, query)).references).toEqual([]);
    await transition(created.id, "archive");
    expect((await service.workspace(a)).entries).toEqual([]);
    expect((await service.history(a, created.id)).versions).toHaveLength(2);
    await expect(
      withTenant(database.db, a, (tx) =>
        tx.execute(
          sql`update knowledge_versions set reason='overwrite' where entry_id=${created.id}`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      database.client.unsafe("delete from knowledge_versions where entry_id=$1", [created.id]),
    ).rejects.toThrow("immutable");
  });
  it("isolates tenants, permissions, stale revisions and product references", async () => {
    const created = await service.save(a, null, save());
    await transition(created.id, "submit");
    await transition(created.id, "publish");
    expect((await service.workspace(b)).entries).toEqual([]);
    expect((await service.search(b, query)).references).toEqual([]);
    await expect(service.history(b, created.id)).rejects.toThrow("不存在");
    expect(
      await withTenant(database.db, b, (tx) =>
        tx.select().from(knowledgeVersions).where(eq(knowledgeVersions.entryId, created.id)),
      ),
    ).toEqual([]);
    await expect(service.workspace({ ...a, permissions: [] })).rejects.toThrow();
    await expect(
      service.save({ ...a, permissions: [Permission.WorkflowRead] }, null, save()),
    ).rejects.toThrow();
    await expect(
      transition(created.id, "disable", {
        ...a,
        permissions: [Permission.WorkflowRead, Permission.WorkflowManage],
      }),
    ).rejects.toThrow();
    await expect(service.save(a, created.id, save({ expectedRevision: 1 }))).rejects.toThrow(
      "已更新",
    );
    await expect(
      service.save(a, null, save({ fields: { ...fields, spuId: createEntityId() } })),
    ).rejects.toThrow("SPU");
    for (const overrides of [{ platform: "etsy" }, { market: "GB" }, { topic: "advertising" }])
      expect((await service.search(a, { ...query, ...overrides })).references).toEqual([]);
    expect(KnowledgeFieldsSchema.safeParse({ ...fields, sourceType: "official" }).success).toBe(
      false,
    );
  });
  it("excludes overdue knowledge and never publishes a future verification date", async () => {
    const created = await service.save(
      b,
      null,
      save({ fields: { ...fields, verifiedOn: "2099-01-01", reviewDueOn: "2099-12-31" } }),
    );
    await transition(created.id, "submit", b);
    await expect(transition(created.id, "publish", b)).rejects.toThrow("未来");
    const outdated = await service.save(
      b,
      null,
      save({ fields: { ...fields, verifiedOn: "2020-01-01", reviewDueOn: "2020-01-02" } }),
    );
    await transition(outdated.id, "submit", b);
    await expect(transition(outdated.id, "publish", b)).rejects.toThrow("复查期");
  });
  it("restricts product-scoped knowledge and rejects a different tenant's product", async () => {
    const ownSpu = await product(a),
      unrelatedOwnSpu = await product(a),
      otherSpu = await product(b);
    const scoped = await service.save(a, null, save({ fields: { ...fields, spuId: ownSpu } }));
    const reader = {
      ...a,
      permissions: a.permissions.filter((permission) => permission !== Permission.ProductRead),
    };
    expect((await service.workspace(reader)).entries.some((entry) => entry.id === scoped.id)).toBe(
      false,
    );
    await expect(service.history(reader, scoped.id)).rejects.toThrow();
    await expect(service.save(reader, scoped.id, save({ expectedRevision: 1 }))).rejects.toThrow();
    await expect(
      service.change(reader, scoped.id, "submit", {
        expectedRevision: 1,
        version: 1,
        reason: "Synthetic denied submission",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      service.save(a, null, save({ fields: { ...fields, spuId: otherSpu } })),
    ).rejects.toThrow("SPU");
    await transition(scoped.id, "submit");
    await transition(scoped.id, "publish");
    expect(
      (await service.search(a, query)).references.some(
        (reference) => reference.entryId === scoped.id,
      ),
    ).toBe(false);
    expect(
      (await service.search(a, { ...query, spuIds: [ownSpu] })).references.some(
        (reference) => reference.entryId === scoped.id,
      ),
    ).toBe(true);
    expect(
      (await service.search(a, { ...query, spuIds: [unrelatedOwnSpu] })).references.some(
        (reference) => reference.entryId === scoped.id,
      ),
    ).toBe(false);
    await expect(service.search(a, { ...query, spuIds: [otherSpu] })).rejects.toMatchObject({ status: 404 });
    await expect(service.search(a, { ...query, spuIds: [createEntityId()] })).rejects.toMatchObject({ status: 404 });
    await expect(service.search(reader, { ...query, spuIds: [ownSpu] })).rejects.toThrow();
    await expect(
      service.change(
        {
          ...a,
          permissions: [Permission.WorkflowRead, Permission.WorkflowManage, Permission.ProductRead],
        },
        scoped.id,
        "archive",
        {
          expectedRevision: 3,
          version: 1,
          reason: "Synthetic unauthorized archival",
          requestId: randomUUID(),
        },
      ),
    ).rejects.toThrow();
    await expect(
      service.change(a, scoped.id, "reject", {
        expectedRevision: 3,
        version: 1,
        reason: "Synthetic invalid transition",
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("提交审核");
    expect(
      (await service.search(a, { ...query, spuIds: [ownSpu] })).references.some(
        (reference) => reference.entryId === scoped.id,
      ),
    ).toBe(true);
    await transition(scoped.id, "archive");
  });
  async function product(context: TenantContext) {
    const plan = createEntityId(),
      spu = createEntityId();
    // Bootstrap fixtures only; production knowledge uses the catalog read boundary.
    await database.client.unsafe(
      "insert into product_plans(id,tenant_id,name,customization) values($1,$2,'Synthetic knowledge product','{}'::jsonb)",
      [plan, context.tenantId],
    );
    await database.client.unsafe(
      "insert into spus(id,tenant_id,product_plan_id,code,name,customization) values($1,$2,$3,$4,'Synthetic knowledge SPU','{}'::jsonb)",
      [spu, context.tenantId, plan, `SYN-${spu}`],
    );
    return spu;
  }
  async function tenant(): Promise<TenantContext> {
    const tenantId = createEntityId(),
      userId = createEntityId();
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Synthetic knowledge tenant',$2)",
      [tenantId, `knowledge-${tenantId}`],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic knowledge user')",
      [userId, `knowledge-${userId}`, `${userId}@example.test`],
    );
    return { tenantId, userId, dataScope: "tenant", permissions: Object.values(Permission) };
  }
});
