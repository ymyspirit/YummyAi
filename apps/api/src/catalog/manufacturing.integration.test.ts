import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ManufacturingRecipeContentSchema, type ManufacturingRecipeContent, type ManufacturingRecipeWorkspace } from "@yummyai/contracts/catalog/manufacturing";
import {
  connectDatabase, migrateDatabase, withTenant, productPlans, productSpecifications, productSpecificationVersions,
  inventoryStockItems, manufacturingRecipes, manufacturingRecipeVersions, manufacturingRecipeReviews,
  memberships, roles, membershipRoles, loadCurrentMembershipContext,
} from "@yummyai/database";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { AuditService } from "../audit/audit.service.js";
import { ManufacturingService } from "./manufacturing.service.js";
import { manufacturingBasis } from "./manufacturing.test-fixture.js";
import { approvedManufacturingForProduction, lockManufacturingProductionVersions } from "./manufacturing-production.js";

requireDisposableIntegrationEnvironment();
describe.sequential("versioned manufacturing materials, responsibility and approval", () => {
  const db = connectDatabase(), audit = new AuditService(db), service = new ManufacturingService(db, audit);
  const a: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: Object.values(Permission) };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  let source: Awaited<ReturnType<typeof basis>>, foreign: Awaited<ReturnType<typeof basis>>;
  beforeAll(async () => {
    await migrateDatabase(db);
    for (const context of [a, b]) {
      await db.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic manufacturing',$2)", [context.tenantId, randomUUID()]);
      await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic manufacturer')", [context.userId, randomUUID(), `${context.userId}@example.invalid`]);
    }
    source = await basis(a); foreign = await basis(b);
  });
  afterAll(() => db.client.end());

  const basis = (context: TenantContext) => manufacturingBasis(db, context);
  function content(own = source): ManufacturingRecipeContent {
    return ManufacturingRecipeContentSchema.parse({ specificationVersionId: own.specificationVersionId, name: "Synthetic manufacturing recipe", outputQuantity: 2, outputUnit: "each",
      materials: [{ code: "FABRIC", name: "Synthetic fabric", stockItemId: own.stockId, quantityNumerator: 3, quantityDenominator: 2, unit: "meter", lossBps: 1000,
        lossBasis: "add_to_net", responsibility: "merchant", operationCode: "CUT" }],
      operations: [{ code: "CUT", name: "Cut", processCode: "cut", responsibility: "factory", expectedSecondsPerOutput: null }] });
  }
  const request = (own = source) => ({ spuId: own.spuId, specificationId: own.specificationId, code: `BOM-${randomUUID()}`, content: content(own), idempotencyKey: randomUUID() });
  async function approved() {
    const created = await service.create(a, request());
    const review = { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic technical test approval only", idempotencyKey: randomUUID() };
    return { created, reviewed: await service.review(a, created.recipeId, review), review };
  }
  const workspace = async (id: string) => await service.get(a, id) as ManufacturingRecipeWorkspace;

  it("retains unknown drafts and exact material units, without approving or posting stock", async () => {
    const input = request(); input.content.materials[0]!.quantityNumerator = null; input.content.materials[0]!.responsibility = "unknown";
    const result = await service.create(a, input);
    expect(result.content.materials[0]).toMatchObject({ quantityNumerator: null, responsibility: "unknown" });
    expect((await workspace(result.recipeId)).approvalProblems.length).toBeGreaterThan(0);
    await expect(service.review(a, result.recipeId, { expectedVersion: 1, versionId: result.versionId, decision: "approved", note: "Synthetic test", idempotencyKey: randomUUID() })).rejects.toThrow("尚未确认");
    const [{ count }] = await withTenant(db.db, a, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from inventory_movements`));
    expect(count).toBe(0);
  });
  it("separates reviewer permission and preserves released content while another draft is edited", async () => {
    const original = request(), first = await service.create(a, original);
    const review = { expectedVersion: 1, versionId: first.versionId, decision: "approved", note: "Synthetic test review", idempotencyKey: randomUUID() };
    await expect(service.review({ ...a, permissions: a.permissions.filter(p => p !== Permission.ManufacturingReview) }, first.recipeId, review)).rejects.toThrow();
    const accepted = await service.review(a, first.recipeId, review);
    const second = await service.revise(a, first.recipeId, { expectedVersion: 1, content: { ...first.content, name: "Unreviewed draft" }, idempotencyKey: randomUUID() });
    const view = await workspace(first.recipeId);
    expect(view.currentVersion.versionId).toBe(second.versionId); expect(view.releasedVersion?.versionId).toBe(first.versionId);
    expect(await service.create(a, original)).toEqual(first);
    expect(await service.review(a, first.recipeId, review)).toEqual(accepted);
    expect((await service.estimate(a, first.recipeId, { versionId: first.versionId, outputQuantity: 3 })).lines[0])
      .toMatchObject({ exactNumerator: "99", exactDenominator: "40", wholeBaseUnitCeiling: "3" });
    await expect(service.estimate(a, first.recipeId, { versionId: second.versionId, outputQuantity: 3 })).rejects.toThrow("已批准");
  });
  it("serializes competing revisions and rejects changed requests or actors without extra versions", async () => {
    const original = request(), first = await service.create(a, original);
    const command = { expectedVersion: 1, content: first.content, idempotencyKey: randomUUID() };
    const results = await Promise.allSettled([service.revise(a, first.recipeId, command), service.revise(a, first.recipeId, { ...command, idempotencyKey: randomUUID() })]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect((await workspace(first.recipeId)).currentVersion.versionNumber).toBe(2);
    await expect(service.create(a, { ...original, content: { ...original.content, name: "Changed retry" } })).rejects.toThrow("另一内容");
    await expect(service.create({ ...a, userId: b.userId }, original)).rejects.toThrow("操作员");
  });
  it("rejects a foreign material, wrong specification and implicit unit conversion", async () => {
    const input = request(); input.content.materials[0]!.stockItemId = foreign.stockId;
    await expect(service.create(a, input)).rejects.toThrow("材料物料");
    input.content.materials[0]!.stockItemId = source.stockId; input.content.materials[0]!.unit = "gram";
    await expect(service.create(a, input)).rejects.toThrow("不自动换算");
    input.content.materials[0]!.unit = "meter"; input.content.specificationVersionId = foreign.specificationVersionId;
    await expect(service.create(a, input)).rejects.toThrow("规格版本");
    await expect(service.list(b, { spuId: source.spuId })).rejects.toThrow();
    expect(await withTenant(db.db, b, tx => tx.select().from(manufacturingRecipes).where(eq(manufacturingRecipes.spuId, source.spuId)))).toEqual([]);
  });
  it("rolls back roots, components, receipts and audit together and retries the original request once", async () => {
    const input = request(), brokenAudit = new AuditService(db), broken = new ManufacturingService(db, brokenAudit);
    vi.spyOn(brokenAudit, "recordInTransaction").mockRejectedValueOnce(new Error("synthetic audit unavailable"));
    await expect(broken.create(a, input)).rejects.toThrow("synthetic audit unavailable");
    expect(await withTenant(db.db, a, tx => tx.select().from(manufacturingRecipes).where(eq(manufacturingRecipes.code, input.code)))).toEqual([]);
    const first = await service.create(a, input);
    expect(await service.create(a, input)).toEqual(first);
    vi.spyOn(brokenAudit, "recordInTransaction").mockRejectedValueOnce(new Error("synthetic review audit unavailable"));
    const review = { expectedVersion: 1, versionId: first.versionId, decision: "approved", note: "Synthetic review", idempotencyKey: randomUUID() };
    await expect(broken.review(a, first.recipeId, review)).rejects.toThrow("synthetic review audit unavailable");
    expect((await workspace(first.recipeId)).releasedVersion).toBeNull();
    const accepted = await service.review(a, first.recipeId, review); expect(await service.review(a, first.recipeId, review)).toEqual(accepted);
  });
  it("seals original components and rejects historical mutation even by the database owner", async () => {
    const { created } = await approved();
    await expect(db.client.unsafe("update manufacturing_recipe_versions set notes='changed' where id=$1", [created.versionId])).rejects.toThrow("immutable");
    await expect(db.client.unsafe("delete from manufacturing_recipe_reviews where version_id=$1", [created.versionId])).rejects.toThrow("immutable");
    await expect(db.client.unsafe("insert into manufacturing_operations(id,tenant_id,created_by,version_id,position,code,payload) values($1,$2,$3,$4,2,'LATE',$5::jsonb)",
      [createEntityId(), a.tenantId, a.userId, created.versionId, JSON.stringify({ code: "LATE", processCode: "cut", responsibility: "factory" })])).rejects.toThrow("original version transaction");
    expect((await service.get(a, created.recipeId, created.versionId)).content).toEqual(created.content);
  });
  it("retains rejected evidence and requires another version for a changed review", async () => {
    const created = await service.create(a, request());
    await service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "rejected", note: "Synthetic change requested", idempotencyKey: randomUUID() });
    await expect(service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Changed conclusion", idempotencyKey: randomUUID() })).rejects.toThrow("另建新版本");
    expect((await workspace(created.recipeId)).releasedVersion).toBeNull();
  });
  it("keeps history after stock deactivation while refusing new material proposals", async () => {
    const own = await basis(a), created = await service.create(a, request(own));
    await service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic test", idempotencyKey: randomUUID() });
    await withTenant(db.db, a, tx => tx.update(inventoryStockItems).set({ status: "inactive" }).where(eq(inventoryStockItems.id, own.stockId)));
    expect((await service.get(a, created.recipeId, created.versionId)).content.materials[0]!.unit).toBe("meter");
    await expect(service.estimate(a, created.recipeId, { versionId: created.versionId, outputQuantity: 1 })).rejects.toThrow("停用");
  });
  it("pins source versions and rejects new operations after a product specification changes", async () => {
    const own = await basis(a), created = await service.create(a, request(own)), nextVersion = createEntityId();
    await service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic test", idempotencyKey: randomUUID() });
    await withTenant(db.db, a, async tx => {
      await tx.insert(productSpecificationVersions).values({ id: nextVersion, tenantId: a.tenantId, specificationId: own.specificationId, versionNumber: 2,
        name: "Synthetic V2", attributes: {}, facts: syntheticSpecificationFacts(), processProfileVersionId: own.profileVersionId, createdBy: a.userId });
      await tx.update(productSpecifications).set({ versionNumber: 2 }).where(eq(productSpecifications.id, own.specificationId));
    });
    await expect(service.estimate(a, created.recipeId, { versionId: created.versionId, outputQuantity: 1 })).rejects.toThrow("产品规格已更新");
    expect((await service.get(a, created.recipeId, created.versionId)).content.specificationVersionId).toBe(own.specificationVersionId);
    await expect(service.revise(a, created.recipeId, { expectedVersion: 1, content: created.content, idempotencyKey: randomUUID() })).rejects.toThrow("产品规格已更新");
    const updated = await service.revise(a, created.recipeId, { expectedVersion: 1, content: { ...created.content, specificationVersionId: nextVersion }, idempotencyKey: randomUUID() });
    expect(updated.content.specificationVersionId).toBe(nextVersion);
  });
  it("revalidates actual membership review permission before restoring an original approval", async () => {
    const memberId = createEntityId(), roleId = createEntityId(), own = await basis(a);
    await withTenant(db.db, a, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId: a.tenantId, userId: a.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: a.tenantId, name: randomUUID(), permissions: a.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: a.tenantId, membershipId: memberId, roleId });
    });
    const current = await withTenant(db.db, a, tx => loadCurrentMembershipContext(tx, a));
    const created = await service.create(current, request(own));
    const review = { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic membership review", idempotencyKey: randomUUID() };
    const accepted = await service.review(current, created.recipeId, review);
    await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions.filter(p => p !== Permission.ManufacturingReview) }).where(eq(roles.id, roleId)));
    await expect(service.review(current, created.recipeId, review)).rejects.toThrow();
    await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions }).where(eq(roles.id, roleId)));
    expect(await service.review(current, created.recipeId, review)).toEqual(accepted);
    expect(await withTenant(db.db, a, tx => tx.select().from(manufacturingRecipeReviews).where(eq(manufacturingRecipeReviews.versionId, created.versionId)))).toHaveLength(1);
  });
  it("rejects new work after archive while preserving the original receipt and authorized history", async () => {
    const own = await basis(a), input = request(own), created = await service.create(a, input);
    await withTenant(db.db, a, tx => tx.update(productPlans).set({ status: "archived" }).where(eq(productPlans.id, own.planId)));
    expect(await service.create(a, input)).toEqual(created);
    expect((await service.get(a, created.recipeId, created.versionId)).versionId).toBe(created.versionId);
    await expect(service.revise(a, created.recipeId, { expectedVersion: 1, content: created.content, idempotencyKey: randomUUID() })).rejects.toThrow();
  });
  it("paginates stable identities without dropping a second manufacturing alternative", async () => {
    const own = await basis(a);
    await service.create(a, request(own)); await service.create(a, request(own));
    const first = await service.list(a, { spuId: own.spuId, limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.nextCursor).not.toBeNull();
    const second = await service.list(a, { spuId: own.spuId, limit: 1, after: first.nextCursor });
    expect(second.items).toHaveLength(1); expect(second.items[0]!.id).not.toBe(first.items[0]!.id); expect(second.nextCursor).toBeNull();
    expect(await withTenant(db.db, a, tx => tx.select().from(manufacturingRecipeVersions).where(eq(manufacturingRecipeVersions.recipeId, first.items[0]!.id)))).toHaveLength(1);
  });
  it("enforces incomplete-approval and tenant specification constraints inside SQL", async () => {
    const input = request(); input.content.materials[0]!.lossBps = null;
    const created = await service.create(a, input);
    await expect(withTenant(db.db, a, tx => tx.insert(manufacturingRecipeReviews).values({ id: createEntityId(), tenantId: a.tenantId,
      createdBy: a.userId, recipeId: created.recipeId, versionId: created.versionId, decision: "approved", note: "Synthetic direct SQL guard test" })))
      .rejects.toMatchObject({ cause: { code: "23514", message: expect.stringContaining("complete current") } });
    await expect(withTenant(db.db, a, tx => tx.insert(manufacturingRecipes).values({ id: createEntityId(), tenantId: a.tenantId,
      createdBy: a.userId, spuId: source.spuId, specificationId: foreign.specificationId, code: randomUUID() }))).rejects.toMatchObject({ cause: { code: "23503" } });
    expect((await workspace(created.recipeId)).releasedVersion).toBeNull();
  });
  it("waits for a real parent archive transaction and rejects a new manufacturing command afterward", async () => {
    const own = await basis(a), input = request(own);
    let release!: () => void, ready!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { ready = resolve; });
    const owner = withTenant(db.db, a, async tx => {
      await tx.update(productPlans).set({ status: "archived" }).where(eq(productPlans.id, own.planId));
      ready(); await barrier;
    });
    await Promise.race([held, owner.then(() => { throw new Error("Archive transaction ended before its lock barrier"); })]);
    const pending = service.create(a, input).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      const deadline = Date.now() + 3000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await db.client.unsafe("select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%product_plans%' and pid<>pg_backend_pid()");
        waiting = rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { release(); await Promise.allSettled([owner, pending]); }
    await owner;
    const outcome = await pending;
    expect(outcome.value).toBeNull(); expect(outcome.error).toBeTruthy();
    expect(await withTenant(db.db, a, tx => tx.select().from(manufacturingRecipes).where(eq(manufacturingRecipes.spuId, own.spuId)))).toEqual([]);
  });
  it("does not reopen old component evidence if a restored transaction number equals the current transaction", async () => {
    await expect(db.client.begin(async owner => {
      const recipeId = createEntityId(), versionId = createEntityId();
      await owner.unsafe("insert into manufacturing_recipes(id,tenant_id,created_by,spu_id,specification_id,code) values($1,$2,$3,$4,$5,$6)",
        [recipeId, a.tenantId, a.userId, source.spuId, source.specificationId, randomUUID()]);
      await owner.unsafe("insert into manufacturing_recipe_versions(id,tenant_id,created_by,recipe_id,specification_id,specification_version_id,version_number,creation_transaction,created_at,name,output_quantity,output_unit,notes) values($1,$2,$3,$4,$5,$6,1,txid_current(),'2000-01-01T00:00:00Z','Synthetic restored origin',1,'each','')",
        [versionId, a.tenantId, a.userId, recipeId, source.specificationId, source.specificationVersionId]);
      await owner.unsafe("insert into manufacturing_operations(id,tenant_id,created_by,version_id,position,code,payload) values($1,$2,$3,$4,1,'LATE',$5::jsonb)",
        [createEntityId(), a.tenantId, a.userId, versionId, JSON.stringify({ code: "LATE", processCode: "cut", responsibility: "factory" })]);
    })).rejects.toThrow("original version transaction");
  });
  it("reads an explicitly approved original specification for production while current catalog proposals stay guarded", async () => {
    const own = await basis(a), input = request(own), created = await service.create(a, input);
    const read = () => withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, a, created.versionId,
      { kind: "order_work_revision", specificationVersionId: own.specificationVersionId, processProfileVersionId: own.profileVersionId }));
    await expect(read()).rejects.toThrow("已批准");
    await service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic production source approval", idempotencyKey: randomUUID() });
    const nextSpecification = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(productSpecificationVersions).values({ id: nextSpecification, tenantId: a.tenantId, specificationId: own.specificationId, versionNumber: 2,
        name: "Synthetic later specification", attributes: {}, facts: syntheticSpecificationFacts(), processProfileVersionId: own.profileVersionId, createdBy: a.userId });
      await tx.update(productSpecifications).set({ versionNumber: 2 }).where(eq(productSpecifications.id, own.specificationId));
    });
    expect((await read()).view.content.specificationVersionId).toBe(own.specificationVersionId);
    await expect(service.estimate(a, created.recipeId, { versionId: created.versionId, outputQuantity: 1 })).rejects.toThrow("产品规格已更新");
    await expect(withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, a, created.versionId,
      { kind: "order_work_revision", specificationVersionId: nextSpecification, processProfileVersionId: own.profileVersionId }))).rejects.toThrow("原产品规格");
  });
  it("rejects foreign scope, mismatched process and inactive material at the production catalog boundary", async () => {
    const own = await basis(a), created = await service.create(a, request(own));
    await service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic release approval", idempotencyKey: randomUUID() });
    const source = { kind: "order_work_revision" as const, specificationVersionId: own.specificationVersionId, processProfileVersionId: own.profileVersionId };
    await expect(withTenant(db.db, b, tx => approvedManufacturingForProduction(tx, b, created.versionId, source))).rejects.toThrow();
    await expect(withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, { ...a, permissions: [] }, created.versionId, source))).rejects.toThrow();
    await expect(withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, a, created.versionId, { ...source, processProfileVersionId: createEntityId() }))).rejects.toThrow("工艺版本");
    await withTenant(db.db, a, tx => tx.update(inventoryStockItems).set({ status: "inactive" }).where(eq(inventoryStockItems.id, own.stockId)));
    await expect(withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, a, created.versionId, source))).rejects.toThrow("物料");
  });
  it("requires the current complete specification and its process for a new product confirmation", async () => {
    const own = await basis(a), created = await service.create(a, request(own));
    await service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic native-design manufacturing approval", idempotencyKey: randomUUID() });
    const pin = await withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, a, created.versionId,
      { kind: "approved_product_confirmation", specificationVersionId: own.specificationVersionId }));
    expect(pin.processProfileVersionId).toBe(own.profileVersionId);
    await withTenant(db.db, a, async tx => {
      await tx.insert(productSpecificationVersions).values({ id: createEntityId(), tenantId: a.tenantId, specificationId: own.specificationId, versionNumber: 2,
        name: "Synthetic later specification", attributes: {}, facts: syntheticSpecificationFacts(), processProfileVersionId: own.profileVersionId, createdBy: a.userId });
      await tx.update(productSpecifications).set({ versionNumber: 2 }).where(eq(productSpecifications.id, own.specificationId));
    });
    await expect(withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, a, created.versionId,
      { kind: "approved_product_confirmation", specificationVersionId: own.specificationVersionId }))).rejects.toThrow("当前完整规格");
    await expect(withTenant(db.db, a, tx => tx.insert(productSpecificationVersions).values({ id: createEntityId(), tenantId: a.tenantId,
      specificationId: own.specificationId, versionNumber: 3, name: "Invalid missing process", attributes: {}, facts: syntheticSpecificationFacts(), createdBy: a.userId }))).rejects.toMatchObject({ cause: { code: "23514", constraint_name: "product_specification_versions_draft_process_check" } });
  });
  it("orders multiple catalog parents consistently for competing whole-order manufacturing selections", async () => {
    const one = await basis(a), two = await basis(a), first = await service.create(a, request(one)), second = await service.create(a, request(two));
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const owner = withTenant(db.db, a, async tx => { await lockManufacturingProductionVersions(tx, a, [first.versionId, second.versionId]); entered(); await hold; });
    await held;
    const competing = withTenant(db.db, a, async tx => { await tx.execute(sql`set local lock_timeout='5s'`); await lockManufacturingProductionVersions(tx, a, [second.versionId, first.versionId]); });
    const timer = setTimeout(release, 30);
    try { await expect(Promise.all([owner, competing])).resolves.toEqual([undefined, undefined]); }
    finally { clearTimeout(timer); release(); }
  });
  it("requires finished-SKU units to agree with the package facts instead of silently converting piece counts", async () => {
    const own = await basis(a), specificationVersionId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(productSpecificationVersions).values({ id: specificationVersionId, tenantId: a.tenantId, specificationId: own.specificationId, versionNumber: 2,
        name: "Synthetic two-piece SKU", attributes: {}, facts: syntheticSpecificationFacts({ packageQuantity: 2, packageContents: "Synthetic pair" }), processProfileVersionId: own.profileVersionId, createdBy: a.userId });
      await tx.update(productSpecifications).set({ versionNumber: 2 }).where(eq(productSpecifications.id, own.specificationId));
    });
    for (const unit of ["each", "pair"] as const) {
      const input = request(own); input.content.specificationVersionId = specificationVersionId; input.content.outputUnit = unit;
      const created = await service.create(a, input);
      await service.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic output-unit review", idempotencyKey: randomUUID() });
      const selected = () => withTenant(db.db, a, tx => approvedManufacturingForProduction(tx, a, created.versionId, { kind: "approved_product_confirmation", specificationVersionId }));
      if (unit === "each") await expect(selected()).rejects.toThrow("每份件数");
      else expect((await selected()).view.content.outputUnit).toBe("pair");
    }
  });
  it("wraps an original command result in current membership authority without changing the receipt", async () => {
    const actor = { ...a, userId: createEntityId() }, memberId = createEntityId(), roleId = createEntityId();
    await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic HTTP authority')", [actor.userId, randomUUID(), `${actor.userId}@example.invalid`]);
    await withTenant(db.db, actor, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId: actor.tenantId, userId: actor.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: actor.tenantId, name: randomUUID(), permissions: actor.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: actor.tenantId, membershipId: memberId, roleId });
    });
    const current = await withTenant(db.db, actor, tx => loadCurrentMembershipContext(tx, actor));
    const own = await basis(current), input = request(own), first = await service.create(current, input, true);
    await withTenant(db.db, actor, tx => tx.update(roles).set({ permissions: actor.permissions.filter(p => p !== Permission.InventoryRead) }).where(eq(roles.id, roleId)));
    const recovered = await service.create(current, input, true);
    expect(recovered.data).toEqual(first.data);
    expect(recovered.contextAuthority).not.toBe(first.contextAuthority);
    expect((await service.references(current, own.spuId)).canReadMaterials).toBe(false);
    await expect(service.materialOptions(current, { spuId: own.spuId })).rejects.toThrow();
    expect(await withTenant(db.db, actor, tx => tx.select().from(manufacturingRecipeVersions).where(eq(manufacturingRecipeVersions.recipeId, first.data.recipeId)))).toHaveLength(1);
  });
  it("paginates literal material searches and reads inactive selections independently without foreign data", async () => {
    const own = await basis(a), prefix = randomUUID() + "%_", firstId = createEntityId(), secondId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.update(inventoryStockItems).set({ status: "inactive" }).where(eq(inventoryStockItems.id, own.stockId));
      await tx.insert(inventoryStockItems).values([
        { id: firstId, tenantId: a.tenantId, code: randomUUID(), name: prefix + "one", baseUnit: "meter", createdBy: a.userId },
        { id: secondId, tenantId: a.tenantId, code: randomUUID(), name: prefix + "two", baseUnit: "meter", createdBy: a.userId },
        { id: createEntityId(), tenantId: a.tenantId, code: randomUUID(), name: prefix.replace("%_", "ab") + "noise", baseUnit: "meter", createdBy: a.userId },
      ]);
    });
    const query = { spuId: own.spuId, search: prefix, limit: 1, selected: `${own.stockId},${foreign.stockId}` };
    const first = await service.materialOptions(a, query), second = await service.materialOptions(a, { ...query, after: first.nextCursor });
    const sortedIds = [firstId, secondId].sort();
    expect(first.items.map(row => row.id)).toEqual(sortedIds.slice(0, 1));
    expect(second.items.map(row => row.id)).toEqual(sortedIds.slice(1));
    expect(second.nextCursor).toBeNull();
    expect(first.selected).toEqual([expect.objectContaining({ id: own.stockId, status: "inactive", baseUnit: "meter" })]);
    expect(first.missingSelected).toEqual([foreign.stockId]);
    expect(Object.keys(first.selected[0]!).sort()).toEqual(["id", "code", "name", "baseUnit", "status"].sort());
    await expect(service.materialOptions({ ...a, permissions: [Permission.ProductRead] }, query)).rejects.toThrow();
    await expect(service.materialOptions(b, query)).rejects.toThrow();
  });
  it("returns source facts and paged immutable history under the original SPU read scope", async () => {
    const own = await basis(a), first = await service.create(a, request(own));
    const second = await service.revise(a, first.recipeId, { expectedVersion: 1, content: { ...first.content, name: "Synthetic second draft" }, idempotencyKey: randomUUID() });
    const refs = await service.references(a, own.spuId, true);
    expect(refs.contextAuthority).toBe(catalogContextAuthority(a));
    expect(refs.data).toMatchObject({ spu: { id: own.spuId, ownerId: a.userId, active: true }, specifications: [{ versionId: own.specificationVersionId, versionNumber: 1, factsReady: true }] });
    const recent = await service.history(a, first.recipeId, { limit: 1 });
    expect(recent.items).toEqual([expect.objectContaining({ id: second.versionId, versionNumber: 2, decision: null })]);
    expect(recent.nextVersion).toBe(2);
    const older = await service.history(a, first.recipeId, { limit: 1, before: recent.nextVersion });
    expect(older.items[0]!.id).toBe(first.versionId); expect(older.nextVersion).toBeNull();
    expect((await service.get(a, first.recipeId, first.versionId)).specificationVersionNumber).toBe(1);
    const otherOwner = { ...a, userId: b.userId, dataScope: "self" as const };
    await expect(service.references(otherOwner, own.spuId)).rejects.toThrow();
    await expect(service.history(otherOwner, first.recipeId, {})).rejects.toThrow();
    await expect(service.history(b, first.recipeId, {})).rejects.toThrow();
    await withTenant(db.db, a, tx => tx.update(productPlans).set({ status: "archived" }).where(eq(productPlans.id, own.planId)));
    expect((await service.references(a, own.spuId)).sourceProblems.length).toBeGreaterThan(0);
    expect((await service.history(a, first.recipeId, {})).items).toHaveLength(2);
  });
  it("recovers original commands after a legacy relationship becomes ambiguous while blocking new mutations", async () => {
    const own = await basis(a), input = request(own), first = await service.create(a, input);
    const revision = { expectedVersion: 1, content: { ...first.content, name: "Synthetic immutable revision" }, idempotencyKey: randomUUID() };
    const second = await service.revise(a, first.recipeId, revision);
    const review = { expectedVersion: 2, versionId: second.versionId, decision: "approved", note: "Synthetic original review", idempotencyKey: randomUUID() };
    const accepted = await service.review(a, first.recipeId, review);
    // Only the disposable fixture owner may introduce a historical migration condition.
    await db.client.unsafe("update spus set legacy_plan_ambiguous=true where tenant_id=$1 and id=$2", [a.tenantId, own.spuId]);
    expect(await service.create(a, input)).toEqual(first);
    expect(await service.revise(a, first.recipeId, revision)).toEqual(second);
    expect(await service.review(a, first.recipeId, review)).toEqual(accepted);
    expect((await service.references(a, own.spuId)).sourceProblems.length).toBeGreaterThan(0);
    expect((await service.history(a, first.recipeId, {})).items).toHaveLength(2);
    await expect(service.revise(a, first.recipeId, { ...revision, expectedVersion: 2, idempotencyKey: randomUUID() })).rejects.toThrow();
  });
});
