import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { INITIAL_RULES, SaveRuleInputSchema, type RuleFields } from "@yummyai/contracts/rules";
import { connectDatabase, migrateDatabase, withTenant, businessRules, businessRuleVersions, type DatabaseConnection } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { RuleCenterService, resolveOrderRules } from "./rule-center.service.js";

const disposable = /^\/order_daily_(?:e2e|test)_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname);
describe.skipIf(!disposable)("rule center tenant history and dispatch pins", () => {
  let database: DatabaseConnection, service: RuleCenterService;
  let a: TenantContext, b: TenantContext;
  beforeAll(async () => {
    database = connectDatabase(process.env.DATABASE_URL!); await migrateDatabase(database);
    service = new RuleCenterService(database, new AuditService(database));
    a = await tenant(); b = await tenant();
  });
  afterAll(async () => { await database?.client.end(); }); // The isolated runner drops and verifies the whole fixture DB in finally.
  const fields: RuleFields = { name: "Synthetic operator rule", category: "acceptance", instructions: "核对合成测试图片的文字方向", source: "Synthetic fixture only",
    appliesTo: "order_design", scopeKind: "product_type", productType: "shaped_pillow", spuId: null };
  const save = (overrides = {}) => ({ fields, expectedRevision: 0, changeReason: "Synthetic create", idempotencyKey: randomUUID(), ...overrides });

  it("registers known standards once and honestly separates automatic, manual and unavailable", async () => {
    expect(await service.initialize(a)).toEqual({ created: INITIAL_RULES.length });
    expect(await service.initialize(a)).toEqual({ created: 0 });
    const workspace = await service.workspace(a);
    expect(workspace.rules).toHaveLength(INITIAL_RULES.length);
    expect(workspace.rules.find(row => row.code === "system:super-resolution")?.latest.execution).toBe("unavailable");
    expect(workspace.rules.find(row => row.code === "system:operator-review")?.latest.execution).toBe("manual");
    expect(workspace.rules.find(row => row.code === "system:pillow-factory")?.latest.execution).toBe("automatic");
    const snapshot = await withTenant(database.db, a, tx => resolveOrderRules(tx, "shaped_pillow", null));
    expect(snapshot.rules).toHaveLength(INITIAL_RULES.length - 2);
    expect(snapshot.rules.some(rule => rule.code === "system:test-cleanup")).toBe(false);
    const pipeline = workspace.rules.find(row => row.code === "system:pillow-pipeline-v1-2026-09-19")!;
    expect(pipeline).toMatchObject({ activeVersion: null, latest: { binding: "pillow_pipeline_v1", execution: "automatic" } });
    expect(snapshot.rules.some(rule => rule.ruleId === pipeline.id)).toBe(false);
    expect((await service.history(a, pipeline.id)).events.map(event => event.action)).toEqual(["create"]);
    const tire = await withTenant(database.db, a, tx => resolveOrderRules(tx, "tire_cover", null));
    expect(tire.rules.some(rule => rule.code === "system:pillow-factory")).toBe(false);
  });

  it("publishes the new pipeline identity explicitly without modifying frozen legacy rules", async () => {
    const original = await pins(), before = JSON.stringify(original);
    const pipeline = (await service.workspace(a)).rules.find(row => row.code === "system:pillow-pipeline-v1-2026-09-19")!;
    await service.changeState(a, pipeline.id, "publish", { expectedRevision: pipeline.revision, version: 1, changeReason: "Synthetic explicit pipeline approval" });
    const next = await pins();
    expect(next.rules.find(rule => rule.ruleId === pipeline.id)?.execution).toBe("automatic");
    expect(next.rules.find(rule => rule.code === "system:super-resolution")?.execution).toBe("unavailable");
    expect(next.rules.find(rule => rule.code === "system:subject-measurement")?.execution).toBe("unavailable");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("preserves old content and pins while draft, publication and disable move forward", async () => {
    const input = save(); const created = await service.save(a, null, input);
    expect(await service.save(a, null, input)).toEqual(created);
    await expect(service.save(a, null, { ...input, changeReason: "changed replay" })).rejects.toThrow("内容已变化");
    expect((await pins()).rules.some(rule => rule.ruleId === created.id)).toBe(false);
    await service.changeState(a, created.id, "publish", { expectedRevision: 1, version: 1, changeReason: "Synthetic publish" });
    const pinned = await pins(), original = JSON.stringify(pinned);
    await service.save(a, created.id, save({ expectedRevision: 2, fields: { ...fields, instructions: "Synthetic new requirement" } }));
    expect((await pins()).rules.find(rule => rule.ruleId === created.id)?.instructions).toBe(fields.instructions);
    await expect(service.changeState(a, created.id, "publish", { expectedRevision: 2, version: 2, changeReason: "stale" })).rejects.toThrow("已更新");
    await service.changeState(a, created.id, "publish", { expectedRevision: 3, version: 2, changeReason: "Synthetic v2" });
    expect((await pins()).rules.find(rule => rule.ruleId === created.id)?.version).toBe(2);
    expect(JSON.stringify(pinned)).toBe(original);
    const history = await service.history(a, created.id);
    expect(history.versions.map(row => row.version)).toEqual([2, 1]);
    expect(history.versions[1]?.instructions).toBe(fields.instructions);
    expect(history.versions.every(row => row.execution === "manual")).toBe(true);
    await service.changeState(a, created.id, "disable", { expectedRevision: 4, version: 2, changeReason: "Synthetic disable" });
    expect((await pins()).rules.some(rule => rule.ruleId === created.id)).toBe(false);
    expect((await service.history(a, created.id)).events).toHaveLength(5);
    await expect(withTenant(database.db, a, tx => tx.execute(sql`update business_rule_versions set change_reason='overwrite' where rule_id=${created.id}`))).rejects.toThrow();
    await expect(withTenant(database.db, a, tx => tx.execute(sql`delete from business_rule_versions where rule_id=${created.id}`))).rejects.toThrow();
    // Even owner-role accidental edits are stopped by the immutable history trigger.
    await expect(database.client.unsafe("update business_rule_versions set change_reason='overwrite' where rule_id=$1", [created.id])).rejects.toThrow("immutable");
  });

  it("enforces tenant isolation, permission boundaries, reference scope and built-in ownership", async () => {
    expect((await service.workspace(b)).rules).toEqual([]);
    const row = (await service.workspace(a)).rules[0]!;
    await expect(service.history(b, row.id)).rejects.toThrow("不存在");
    await expect(service.save(b, row.id, save({ expectedRevision: row.revision }))).rejects.toThrow("不存在");
    expect(await withTenant(database.db, b, tx => tx.select().from(businessRuleVersions).where(eq(businessRuleVersions.ruleId, row.id)))).toEqual([]);
    await expect(service.workspace({ ...a, permissions: [] })).rejects.toThrow();
    await expect(service.save({ ...a, permissions: [Permission.WorkflowRead] }, null, save())).rejects.toThrow();
    await expect(service.changeState({ ...a, permissions: [Permission.WorkflowManage] }, row.id, "disable", { expectedRevision: row.revision, version: 1, changeReason: "not approved" })).rejects.toThrow();
    const builtin = (await service.workspace(a)).rules.find(rule => rule.code === "system:pillow-factory")!;
    await expect(service.save(a, builtin.id, save({ expectedRevision: builtin.revision }))).rejects.toThrow("内置自动规则");
    await expect(service.save(a, null, save({ fields: { ...fields, scopeKind: "spu", productType: null, spuId: createEntityId() } }))).rejects.toThrow("SPU");
    expect(SaveRuleInputSchema.safeParse(save({ fields: { ...fields, binding: "pillow_factory" } })).success).toBe(false);
    expect(SaveRuleInputSchema.safeParse(save({ fields: { ...fields, scopeKind: "spu", spuId: null } })).success).toBe(false);
    expect(await withTenant(database.db, b, tx => tx.update(businessRules).set({ activeVersion: null }).where(eq(businessRules.id, row.id)).returning())).toEqual([]);
  });
  it("allows versioned edits to built-in manual requirements without changing active task rules or automatic bindings", async () => {
    const row = (await service.workspace(a)).rules.find(rule => rule.code === "system:pillow-contour")!;
    const before = (await pins()).rules.find(rule => rule.ruleId === row.id)!;
    const fields = { name: row.latest.name, category: row.latest.category, instructions: "Synthetic edited contour check", source: "Synthetic factory note",
      appliesTo: row.latest.appliesTo, scopeKind: row.latest.scopeKind, productType: row.latest.productType, spuId: row.latest.spuId };
    await service.save(a, row.id, save({ fields, expectedRevision: row.revision }));
    expect((await pins()).rules.find(rule => rule.ruleId === row.id)?.instructions).toBe(before.instructions);
    const draft = (await service.workspace(a)).rules.find(rule => rule.id === row.id)!;
    expect(draft.latest.binding).toBe("manual");
    expect(draft.latest.execution).toBe("manual");
    expect(draft.activeVersion).toBe(1);
    await service.changeState(a, row.id, "publish", { expectedRevision: draft.revision, version: 2, changeReason: "Synthetic approve edited text" });
    expect((await pins()).rules.find(rule => rule.ruleId === row.id)?.instructions).toBe(fields.instructions);
    expect((await service.history(a, row.id)).versions.find(version => version.version === 1)?.instructions).toBe(before.instructions);
    const current = (await service.workspace(a)).rules.find(rule => rule.id === row.id)!;
    await expect(service.save(a, row.id, save({ expectedRevision: current.revision, fields: { ...fields, binding: "pillow_factory" } }))).rejects.toThrow();
  });
  async function pins() { return withTenant(database.db, a, tx => resolveOrderRules(tx, "shaped_pillow", null)); }
  async function tenant(): Promise<TenantContext> {
    const tenantId = createEntityId(), userId = createEntityId();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic rules tenant',$2)", [tenantId, `rules-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic rules user')", [userId, `rules-${userId}`, `${userId}@example.test`]);
    return { tenantId, userId, dataScope: "tenant", permissions: Object.values(Permission) };
  }
});
