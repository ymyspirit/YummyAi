import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { PreparationView } from "@yummyai/contracts/catalog/sales-plan-agent";
import { connectDatabase, migrateDatabase, withTenant, developmentEvents } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import type { AssistService } from "../ai/assist.service.js";
import { SalesPlanService } from "./sales-plan.service.js";
import { SalesPlanLaunchService } from "./sales-plan-launch.service.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { ProductService, DrizzleCatalogRepository } from "./product.service.js";
import { SalesPlanPreparationService } from "./sales-plan-agent.service.js";

describe.sequential("persistent tenant-scoped sales preparation", () => {
  const db = connectDatabase(), catalog = new ProductDevelopmentService(db, createStorageFromEnvironment());
  const a: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
  const b = { ...a, tenantId: createEntityId(), userId: createEntityId() }, colleague = { ...a, userId: createEntityId() };
  const listings = new ListingService(new DrizzleListingRepository(db)), plans = new SalesPlanService(db, listings);
  const assists = { create: vi.fn(), get: vi.fn() } as unknown as AssistService;
  const launch = new SalesPlanLaunchService(db, plans, catalog, assists, {} as never, {} as never);
  const agent = new SalesPlanPreparationService(db, plans, launch, assists);
  let planId: string, productId: string, view: PreparationView;
  const command = () => ({ expectedRevision: view.currentPlanRevision, expectedRunRevision: view.run.revision, idempotencyKey: randomUUID() });
  const directory = new URL("../../../../tmp/sales-preparation-integration/", import.meta.url);
  const record = (cleanup: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL(`${a.tenantId}.json`, directory), JSON.stringify({ tenants: [a.tenantId, b.tenantId],
      users: [a.userId, b.userId, colleague.userId], planId, productId, runId: view?.run.id, cleanup,
      retainedHistory: "immutable preparation events and listing versions, removed with the disposable database" }));
  };
  beforeAll(async () => {
    await migrateDatabase(db);
    for (const c of [a, b]) await db.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic preparation',$2)", [c.tenantId, `prep-${c.tenantId}`]);
    for (const c of [a, b, colleague]) await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic preparation')", [c.userId, c.userId, `${c.userId}@example.test`]);
    const { spu } = await catalog.createSpu(a, { code: `PREP-${a.tenantId.slice(-8)}`, name: "Synthetic preparation carrier", idempotencyKey: randomUUID() });
    productId = spu.productPlanId;
    planId = (await plans.create(a, { spuId: spu.id, fields: { name: "Synthetic preparation", mode: "custom", fulfillment: "fbm" }, idempotencyKey: randomUUID() })).plan.id;
    record("pending");
  }, 60_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      if (planId) {
        const detail = await plans.get(a, planId);
        for (const listing of detail.listings) await listings.archive(a, listing.id);
        await plans.archive(a, planId, { expectedRevision: detail.plan.revision, idempotencyKey: randomUUID() });
      }
      if (productId) await new ProductService(new DrizzleCatalogRepository(db)).transition(a, productId, "archived");
      expect((await plans.list(a, {})).total).toBe(0);
      record("verified-active-lists-clear");
    } finally { await db.client.end(); }
  }, 60_000);

  it("pins an actual missing-facts plan and reuses an active run across duplicate starts", async () => {
    const input = { expectedRevision: 1, idempotencyKey: randomUUID() };
    view = await agent.start(a, planId, input);
    expect(view.run.status).toBe("blocked");
    expect(view.run.steps[0]?.state).toBe("blocked");
    const ids = await Promise.all([agent.start(a, planId, input), agent.start(a, planId, { ...input, idempotencyKey: randomUUID() })]);
    expect(ids.every(v => v.run.id === view.run.id)).toBe(true);
    expect((await agent.list(a, planId)).runs).toHaveLength(1);
    expect((await plans.get(a, planId)).listings).toHaveLength(0);
    expect(assists.create).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toMatch(/sourceFingerprint|lease|intent|requestHash/);
    record("pending");
  });
  it("enforces tenant, creator and current permissions on every read and command", async () => {
    await expect(agent.get(b, planId, view.run.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(agent.get(colleague, planId, view.run.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(agent.get({ ...a, permissions: [Permission.ProductRead] }, planId, view.run.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(agent.resume({ ...a, permissions: a.permissions.filter(p => p !== Permission.ListingWrite) }, planId, view.run.id, command())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(agent.resume(a, planId, view.run.id, { ...command(), expectedRunRevision: 1 })).rejects.toBeInstanceOf(ConflictException);
  });
  it("reconciles a committed draft after response loss without a second version", async () => {
    const realLaunch = launch.get.bind(launch);
    // Synthetic upstream approval projection; the draft service, version ledger,
    // task journal and RLS below are real. Browser acceptance uses real approvals.
    vi.spyOn(launch, "get").mockImplementation(async (...args) => {
      const result = await realLaunch(...args);
      return { ...result, stages: result.stages.map(stage => ["product", "design"].includes(stage.key) ? { ...stage, status: "ready" as const, detail: "Synthetic upstream ready", issues: [] } : stage) };
    });
    const original = plans.draft.bind(plans);
    const writes = vi.spyOn(plans, "draft").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("private synthetic transport failure");
    });
    view = await agent.resume(a, planId, view.run.id, command());
    expect(view.run.status).toBe("blocked");
    expect(view.run.message).not.toContain("private");
    const listing = (await plans.get(a, planId)).listings[0]!;
    expect(await listings.listVersions(a, listing.id)).toHaveLength(1);
    writes.mockRestore();
    const retry = command();
    view = await agent.resume(a, planId, view.run.id, retry);
    expect(view.run.listingId).toBe(listing.id);
    expect(await listings.listVersions(a, listing.id)).toHaveLength(1);
    expect((await agent.resume(a, planId, view.run.id, retry)).run.revision).toBe(view.run.revision);
    expect((await listings.getWorkspace(a, listing.id)).listing.status).toBe("draft");
    expect(view.run.status).toBe("blocked");
  });
  it("keeps reads inert and explicitly rebases a changed sales-plan revision", async () => {
    const count = view.run.revision;
    await agent.get(a, planId, view.run.id);
    await agent.list(a, planId);
    expect((await agent.get(a, planId, view.run.id)).run.revision).toBe(count);
    const detail = await plans.get(a, planId);
    await plans.save(a, planId, { fields: { ...detail.plan.fields, title: "Synthetic updated title" }, expectedRevision: detail.plan.revision, idempotencyKey: randomUUID() });
    view = await agent.get(a, planId, view.run.id);
    expect(view.sourceChanged).toBe(true);
    await expect(agent.resume(a, planId, view.run.id, { ...command(), expectedRevision: 1 })).rejects.toBeInstanceOf(ConflictException);
    view = await agent.resume(a, planId, view.run.id, command());
    expect(view.run.planRevision).toBe(2);
    expect(view.sourceChanged).toBe(false);
    expect(await listings.listVersions(a, view.run.listingId!)).toHaveLength(2);
  });
  it("resumes the same authorized analysis after uncertainty and prevents concurrent paid calls", async () => {
    const analysisId = createEntityId(), requestIds: string[] = [];
    let lost = true;
    const result = { id: analysisId, status: "queued", stale: false, costUsd: null };
    vi.mocked(assists.get).mockResolvedValue(result as never);
    vi.mocked(assists.create).mockImplementation(async (_context, raw) => {
      const request = raw as { requestId: string };
      requestIds.push(request.requestId);
      if (lost) { lost = false; throw new Error("synthetic response lost"); }
      return result as never;
    });
    vi.spyOn(launch, "basis").mockResolvedValue({ input: { kind: "creative", scopeId: planId,
      salesPlan: { id: planId, revision: 2 } }, fingerprint: "a".repeat(64), sources: [], checks: [], diagnostics: [], rows: [], scope: `creative:${planId}`, href: "/sales-plans" } as never);
    const input = { ...command(), kind: "creative", modelId: createEntityId(), expectedFingerprint: "a".repeat(64) };
    view = await agent.analyze(a, planId, view.run.id, input);
    expect(view.run.analyses).toHaveLength(0);
    view = await agent.resume(a, planId, view.run.id, command());
    expect(view.run.analyses, JSON.stringify({ message: view.run.message, history: view.history.slice(-4), calls: requestIds.length })).toEqual([{ id: analysisId, kind: "creative" }]);
    expect(new Set(requestIds).size).toBe(1);
    expect((await agent.analyze(a, planId, view.run.id, input)).analysis?.id).toBe(analysisId);
    await expect(agent.basis(a, planId, view.run.id, { kind: "creative", expectedRevision: 2, expectedRunRevision: view.run.revision })).rejects.toThrow("原分析任务仍在执行");
  });
  it("recovers an expired lease but never revives a cancelled task", async () => {
    await withTenant(db.db, a, async tx => {
      const [event] = await tx.select().from(developmentEvents).where(and(eq(developmentEvents.resourceId, planId), eq(developmentEvents.createdBy, a.userId)))
        .orderBy(desc(developmentEvents.createdAt), desc(developmentEvents.id)).limit(1);
      const run = event!.result.run as Record<string, unknown>;
      await tx.insert(developmentEvents).values({ id: createEntityId(), tenantId: a.tenantId, createdBy: a.userId,
        resourceId: planId, action: "sales_plan.preparation_checkpoint", reason: "Synthetic interrupted local execution",
        idempotencyKey: randomUUID(), requestHash: "b".repeat(64),
        result: { run: { ...run, revision: view.run.revision + 1, status: "running", lease: { token: randomUUID(), until: "2020-01-01T00:00:00.000Z" } } } });
    });
    view = await agent.get(a, planId, view.run.id);
    expect(view.busy).toBe(false);
    view = await agent.resume(a, planId, view.run.id, command());
    const cancel = command();
    view = await agent.cancel(a, planId, view.run.id, cancel);
    expect(view.run.status).toBe("cancelled");
    expect((await agent.cancel(a, planId, view.run.id, cancel)).run.status).toBe("cancelled");
    await expect(agent.resume(a, planId, view.run.id, command())).rejects.toThrow("已取消任务不能恢复");
    expect(view.canContinue).toBe(false);
  });
});
