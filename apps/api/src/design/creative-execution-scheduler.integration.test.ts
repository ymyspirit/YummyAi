import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { connectDatabase, creativeExecutions, creativeStudioGenerations, migrateDatabase, withTenant } from "@yummyai/database";
import { redisConnection } from "@yummyai/jobs";
import { stageCreativeExecution } from "@yummyai/pod-core";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { Queue } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CreativeExecutionScheduler } from "../../../worker/src/processors/creative-execution.scheduler.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
  throw new Error("Scheduler integration requires the disposable acceptance runner");

describe("creative durable delivery with isolated real Redis", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment();
  beforeAll(async () => { await migrateDatabase(database); await storage.ensureBucket(); });
  afterAll(() => database.client.end());
  async function fixture() {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic scheduler',$2)", [context.tenantId, `creative-scheduler-${context.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic scheduler owner')", [context.userId, `creative-scheduler-${context.userId}`, `${context.userId}@example.test`]);
    async function generation(stage: boolean) {
      const id = createEntityId();
      const execution = await withTenant(database.db, context, async tx => {
        await tx.insert(creativeStudioGenerations).values({ id, tenantId: context.tenantId, ownerId: context.userId, scope: "unassigned", requestId: createEntityId(),
          input: StudioGenerateSchema.parse({ requestId: createEntityId(), modelId: createEntityId(), prompt: "Synthetic private prompt must never appear in Redis" }),
          references: [], modelSnapshot: { providerConfigId: createEntityId(), model: "synthetic-dispatch-only", capability: "image" } });
        return stage ? stageCreativeExecution(tx, context, { kind: "studio_generation", ownerId: id, stepKey: "generate" }, "external_request") : undefined;
      });
      return { id, execution };
    }
    const original = await generation(true), queue = new Queue(`creative-scheduler-probe-${createEntityId()}`, { connection: redisConnection() });
    const scheduler = new CreativeExecutionScheduler(database, storage, "studio_generation", queue, [context.tenantId]);
    const row = () => withTenant(database.db, context, async tx => (await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, original.execution!.id)))[0]!);
    async function cleanup() {
      if (!/^creative-scheduler-probe-[a-f0-9-]{36}$/.test(queue.name)) throw new Error("Refuse unrelated queue cleanup");
      try { await queue.obliterate({ force: true }); } finally { await scheduler.close(); }
    }
    return { context, original, queue, scheduler, row, generation, cleanup };
  }
  it("dispatches original metadata only and leaves legacy business rows without invented execution authority", async () => {
    const f = await fixture();
    try {
      const legacy = await f.generation(false);
      expect(await f.scheduler.dispatch()).toMatchObject({ queued: 1, failed: 0 });
      const jobs = await f.queue.getJobs(["waiting"]); expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data).toMatchObject({ tenantId: f.context.tenantId, requestedBy: f.context.userId, payload: { generationId: f.original.id } });
      expect(JSON.stringify(jobs[0]!.data)).not.toMatch(/permissions|private prompt|modelSnapshot|authoritySnapshot/);
      expect(jobs[0]!.data.payload.generationId).not.toBe(legacy.id);
    } finally { await f.cleanup(); }
  });
  it("recovers lost queue delivery from the same original without creating another generation", async () => {
    const f = await fixture();
    try {
      const delivery = vi.spyOn(f.queue, "add"); delivery.mockRejectedValueOnce(new Error("Synthetic delivery unavailable"));
      expect(await f.scheduler.dispatch()).toMatchObject({ queued: 0, failed: 1 });
      expect(await f.row()).toMatchObject({ dispatchCount: 1, lastDispatchedAt: null, submittedAt: null });
      expect(await f.scheduler.dispatch()).toMatchObject({ queued: 1, failed: 0 });
      expect((await f.row()).dispatchCount).toBe(2); expect(await f.queue.getWaitingCount()).toBe(1);
      expect(await f.scheduler.dispatch()).toMatchObject({ queued: 0, failed: 0 });
      const generations = await withTenant(database.db, f.context, tx => tx.select().from(creativeStudioGenerations));
      expect(generations).toHaveLength(1); delivery.mockRestore();
    } finally { await f.cleanup(); }
  });
  it("does not dispatch while the database lease is active", async () => {
    const f = await fixture();
    try {
      await withTenant(database.db, f.context, tx => tx.update(creativeExecutions).set({ phase: "preparing", attemptCount: 1,
        leaseToken: createEntityId(), leaseExpiresAt: sql`clock_timestamp()+interval '5 minutes'` }).where(eq(creativeExecutions.id, f.original.execution!.id)));
      expect(await f.scheduler.dispatch()).toMatchObject({ queued: 0, failed: 0 }); expect(await f.queue.getWaitingCount()).toBe(0);
      await withTenant(database.db, f.context, tx => tx.update(creativeExecutions).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(creativeExecutions.id, f.original.execution!.id)));
      expect(await f.scheduler.dispatch()).toMatchObject({ queued: 1, failed: 0 });
    } finally { await f.cleanup(); }
  });
  it("uses database fencing under concurrent scheduler instances", async () => {
    const f = await fixture(), second = new CreativeExecutionScheduler(database, storage, "studio_generation", f.queue, [f.context.tenantId]);
    try {
      const results = await Promise.all([f.scheduler.dispatch(), second.dispatch()]);
      expect(results.reduce((sum, result) => sum + result.queued, 0)).toBe(1); expect(await f.queue.getWaitingCount()).toBe(1);
      expect((await f.row()).dispatchCount).toBe(1);
    } finally { await f.cleanup(); await second.close(); }
  });
});
