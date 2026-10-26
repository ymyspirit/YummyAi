import { HttpException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { STUDIO_IMAGE_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import { stageCreativeExecution, studioImageHash } from "@yummyai/pod-core";
import { aiBudgetLedger, aiBudgetPolicies, assetFiles, connectDatabase, creativeStudioGenerations, creativeStudioImageRequests, modelRoutes, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireStudioPaidImageEnvironment } from "../../../../tools/testing/studio-paid-image-environment.mjs";
import { StudioPaidImageScheduler } from "../../../worker/src/processors/studio-image-paid-scheduler.js";
import { studioPersonalAuthority } from "./creative-studio-personal.test-fixture.js";
import { createStudioPaidImageFixture, paidImageFixturePricing, paidImageFixtureSha } from "./studio-paid-image.test-fixture.js";

requireStudioPaidImageEnvironment();
type Fixture = Awaited<ReturnType<typeof createStudioPaidImageFixture>>;
type Facts = Awaited<ReturnType<Fixture["facts"]>>;
function errorView(error: unknown) {
  const status = error instanceof HttpException ? error.getStatus() : error instanceof ForbiddenError ? 403
    : error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : null;
  const response = error instanceof HttpException ? error.getResponse() : null;
  return { status, code: response && typeof response === "object" && "code" in response ? response.code
    : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null };
}
async function rejected(operation: Promise<unknown>) {
  try { await operation; }
  catch (error) { return errorView(error); }
  throw new Error("studio_paid_image_expected_rejection");
}
function unchanged(before: Facts, after: Facts) {
  expect(after.role).toBe("yummyai_app");
  expect(after.tables).toEqual(before.tables);
  expect(after.queueCalls).toEqual(before.queueCalls);
  expect(after.calls).toEqual(before.calls);
}
function found(value: Awaited<ReturnType<Fixture["lookup"]>>) {
  expect(value.status).toBe("found");
  if (value.status !== "found") throw new Error("studio_paid_image_expected_original");
  return value.request;
}
function databaseCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return null;
}
async function constraintRejected(operation: Promise<unknown>) {
  try { await operation; }
  catch (error) { expect(databaseCode(error)).toBe("23514"); return; }
  throw new Error("studio_paid_image_expected_database_constraint");
}
describe("73e2c9b1 single-image paid development with real owners and no external payment", () => {
  let f: Fixture;
  beforeEach(async () => { f = await createStudioPaidImageFixture(); });
  afterEach(async () => { if (f) await f.close(); });
  async function basis(options: { priced?: boolean; budget?: boolean; project?: boolean } = {}) {
    const actor = await f.actor(), context = actor.context, channel = await f.channel(context, options.priced ?? true);
    if (options.budget !== false) await f.policy(context);
    const scope = options.project === false ? "unassigned" : (await f.project(context)).id;
    const input = await f.request(context, channel.modelId);
    f.admission(context, false);
    return { actor, context, channel, scope, input };
  }

  it("preserves an absent budget policy during early fixture cleanup", async () => {
    const { context } = await f.actor();
    await f.channel(context);
    const scope = (await f.project(context)).id;
    await f.rememberPolicy(context);
    expect((await f.budgetPolicy(context)).policy).toBeNull();
    await f.base.invoke(context, { operation: "state.set", scope, namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY, revision: 0,
      value: { version: 1, drafts: [{ id: "early-cleanup", prompt: "Synthetic early cleanup", references: [], config: {} }], activeId: "early-cleanup" } });
    const cleanup = await f.close();
    expect(cleanup.budgetPolicies).toEqual([]);
    expect(cleanup.projectStates).toEqual([{ id: scope, status: "cancelled", archived: true }]);
    expect(cleanup).toMatchObject({ remainingActiveChannels: 0, remainingPreparedRequests: 0, remainingLiveDocuments: 0, remainingQueuedOrRunning: 0 });
  });

  it("prepares while OFF and blocks direct create commit and Worker submission", async () => {
    const { context, scope, input } = await basis();
    const prepared = await f.prepare(context, scope, input);
    expect(prepared).toMatchObject({ status: "prepared", generationId: null, admission: { enabled: false, code: "operator_paused" },
      execution: { phase: null, costUsd: null, budgetState: null, budgetAmountUsd: null }, result: null });
    const before = await f.facts(context);
    expect(await rejected(f.generations.create(context, scope, input))).toEqual({ status: 409, code: "studio_paid_execution_paused" });
    expect(await rejected(f.commit(context, prepared))).toEqual({ status: 409, code: "studio_paid_execution_paused" });
    unchanged(before, await f.facts(context));
    expect(before.rows).toEqual([]); expect(before.executions).toEqual([]); expect(before.budget).toEqual([]);
    f.admission(context, true);
    const queued = await f.commit(context, prepared);
    f.admission(context, false);
    const queuedBefore = await f.facts(context);
    expect(await f.processGeneration(context, queued.generationId!)).toEqual({ id: queued.generationId, disposition: "operator_paused" });
    unchanged(queuedBefore, await f.facts(context));
    expect(f.calls).toEqual([]);
  });

  it("requires explicit image pricing and rejects token defaults wrong capability and malformed single-image input", async () => {
    const { context, channel, scope, input } = await basis({ priced: false });
    const before = await f.facts(context);
    expect(await rejected(f.prepare(context, scope, input))).toEqual({ status: 409, code: "studio_image_pricing_required" });
    for (const invalid of [{ ...input, capability: "video" }, { ...input, capability: "text" }, { ...input, count: 2 },
      { ...input, selectionRevision: undefined }]) {
      expect(await rejected(f.paid.prepare(context, { scope, input: invalid }))).toEqual({ status: 400, code: "studio_paid_image_invalid" });
    }
    unchanged(before, await f.facts(context));
    const selected = await f.readChannel(context, channel.id);
    expect((await rejected(f.configure(context, { operation: "studio.image-pricing.save", channelId: channel.id, modelId: channel.modelId,
      revision: selected.revision, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1, maxTaskCostUsd: null } }))).status).toBe(400);
    unchanged(before, await f.facts(context));
    await f.price(context, channel.id, channel.modelId);
    const request = await f.request(context, channel.modelId);
    const prepared = await f.prepare(context, scope, request);
    expect(prepared.quote).toMatchObject({ unit: "image", currency: "USD", count: 1, basis: "operator_estimate", pricing: paidImageFixturePricing });
  });

  it("pins normalized input and five-minute quote immutably and handles expired history and explicit cancellation", async () => {
    const { context, channel, scope } = await basis();
    const input = await f.request(context, channel.modelId, { size: "1:1" });
    const prepared = await f.prepare(context, scope, input), { quoteHash, ...quote } = prepared.quote;
    expect(prepared.originalInput).toEqual(input); expect(prepared.originalInput.size).toBe("1:1");
    expect(prepared.input.size).toBe("1024x1024"); expect(quote.size).toBe("1024x1024");
    expect(quote.contextAuthority).toBe(studioPersonalAuthority(context));
    expect(quoteHash).toBe(studioImageHash(quote)); expect(quote.inputFingerprint).toBe(studioImageHash(prepared.input));
    expect(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt)).toBe(300_000);
    expect(await f.prepare(context, scope, input)).toEqual(prepared);
    const before = await f.facts(context);
    expect(await rejected(f.prepare(context, scope, { ...input, prompt: "Changed original input" }))).toEqual({ status: 409, code: "studio_paid_image_changed" });
    const stored = before.requests.find(row => row.id === prepared.id)!;
    expect(stored.originalInput).toEqual(input); expect(stored.input).toEqual(prepared.input);
    await expect(withTenant(f.database.db, context, tx => tx.update(creativeStudioImageRequests)
      .set({ quote: { ...stored.quote, pricing: { ...stored.quote.pricing, estimatedUsd: "0.00000000" } } })
      .where(eq(creativeStudioImageRequests.id, prepared.id)))).rejects.toThrow();
    unchanged(before, await f.facts(context));
    const expired = await f.expiredHistory(context, prepared);
    f.admission(context, true);
    const expiredBefore = await f.facts(context);
    expect(await rejected(f.commit(context, expired))).toEqual({ status: 409, code: "studio_paid_image_expired" });
    unchanged(expiredBefore, await f.facts(context));
    const cancelled = await f.cancel(context, prepared);
    expect(cancelled.status).toBe("cancelled"); expect(await f.cancel(context, cancelled)).toEqual(cancelled);
    const cancelledBefore = await f.facts(context);
    expect(await rejected(f.commit(context, prepared))).toEqual({ status: 409, code: "studio_paid_image_cancelled" });
    unchanged(cancelledBefore, await f.facts(context));
  });

  it("commits once under concurrency and recovers lost queue ACK through pure exact lookup and paged requests", async () => {
    const { context, scope, channel, input } = await basis();
    const prepared = await f.prepare(context, scope, input);
    f.admission(context, true);
    const replies = await Promise.all([f.commit(context, prepared), f.commit(context, prepared)]);
    expect(replies[0]!.generationId).toBe(replies[1]!.generationId); expect(f.queueCalls).toHaveLength(1);
    let facts = await f.facts(context);
    expect(facts.rows).toHaveLength(1); expect(facts.executions).toHaveLength(1); expect(facts.budget).toHaveLength(1);
    expect(facts.rows[0]).toMatchObject({ requestId: input.requestId, input: prepared.input, references: prepared.quote.references,
      modelSnapshot: { capability: "image", routeId: input.modelId, paidImage: { imageRequestId: prepared.id,
        quoteHash: prepared.quote.quoteHash, reservationUsd: "0.050000", estimatedUsd: "0.02000000" } } });
    expect(facts.budget[0]).toMatchObject({ requestId: replies[0]!.generationId, state: "reserved", amountUsd: "0.050000" });
    const second = await f.prepare(context, scope, await f.request(context, channel.modelId));
    f.loseQueueAck();
    const submitted = await f.commit(context, second);
    expect(submitted.status).toBe("queued"); expect(f.queueCalls).toHaveLength(2);
    facts = await f.facts(context);
    for (let index = 0; index < 2; index++) {
      expect(found(await f.lookup(context, scope, second.requestId)).generationId).toBe(submitted.generationId);
      expect((await f.commit(context, second)).generationId).toBe(submitted.generationId);
    }
    const firstPage = await f.page(context, scope, 1);
    expect(firstPage.items).toHaveLength(1); expect(firstPage.nextCursor).not.toBeNull();
    const nextPage = await f.page(context, scope, 1, firstPage.nextCursor!);
    expect(nextPage.items).toHaveLength(1); expect(nextPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...nextPage.items].map(row => row.requestId))).toEqual(new Set([input.requestId, second.requestId]));
    unchanged(facts, await f.facts(context));
    expect(f.calls).toEqual([]);
    expect(facts.tables.creative_design_candidates!.count).toBe(0);
    const deliveries: Array<{ jobId: string; tenantId: string; userId: string; generationId: string }> = [];
    let dispatcherClosed = false;
    const scheduler = new StudioPaidImageScheduler(f.database, {
      async enqueue(value) { deliveries.push({ ...value }); },
      async close() { dispatcherClosed = true; },
    });
    try {
      expect(await scheduler.dispatch()).toEqual({ queued: 2, failed: 0, skipped: 0 });
      expect(deliveries.filter(row => row.generationId === submitted.generationId)).toEqual([{
        jobId: expect.any(String), tenantId: context.tenantId, userId: context.userId, generationId: submitted.generationId,
      }]);
      const dispatched = await f.facts(context);
      expect(dispatched.rows).toEqual(facts.rows); expect(dispatched.requests).toEqual(facts.requests);
      expect(dispatched.budget).toEqual(facts.budget); expect(dispatched.calls).toEqual(facts.calls);
      for (const row of dispatched.executions) {
        const previous = facts.executions.find(item => item.id === row.id)!;
        expect(row).toEqual({ ...previous, dispatchCount: 1, lastDispatchedAt: expect.any(Date), updatedAt: expect.any(Date) });
      }
      expect(await scheduler.dispatch()).toEqual({ queued: 0, failed: 0, skipped: 0 });
      expect(deliveries).toHaveLength(2);
    } finally { await scheduler.close(); }
    expect(dispatcherClosed).toBe(true);
  });

  it("expires a pinned quote while commit waits on the actual shared budget lock without committing any effects", async () => {
    const { context, scope, input } = await basis(), original = await f.prepare(context, scope, input);
    const blocker = connectDatabase(f.environment.url);
    let pending: Promise<{ value: unknown; error?: never } | { error: unknown; value?: never }> | undefined;
    let before: Facts | undefined, requestId: string | undefined;
    try {
      await withTenant(blocker.db, context, async tx => {
        const [role] = await tx.execute<{ role: string; pid: number }>(sql`select current_user as role,pg_backend_pid() as pid`);
        expect(role?.role).toBe("yummyai_app");
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":ai-assist-budget"},0))`);
        const prepared = await f.shortLivedHistory(context, original);
        requestId = prepared.requestId;
        expect(Date.parse(prepared.quote.expiresAt) - Date.parse(prepared.quote.createdAt)).toBe(5_000);
        before = await f.facts(context);
        const [owner] = await withTenant(f.database.db, context, own => own.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`));
        expect(owner?.pid).toBeTypeOf("number"); expect(owner?.pid).not.toBe(role?.pid);
        f.admission(context, true);
        pending = f.commit(context, prepared).then(value => ({ value }), error => ({ error }));
        let blockedAt = 0;
        await expect.poll(async () => {
          const [observed] = await tx.execute<{ blocked: boolean; now: string }>(
            sql`select ${role!.pid}=any(pg_blocking_pids(${owner!.pid})) as blocked,clock_timestamp()::text as now`);
          if (observed?.blocked) blockedAt = Date.parse(observed.now);
          return observed?.blocked === true;
        }, { timeout: 4_000 }).toBe(true);
        expect(blockedAt).toBeLessThan(Date.parse(prepared.quote.expiresAt));
        await expect.poll(async () => {
          const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
          return Date.parse(clock!.now);
        }, { timeout: 7_000 }).toBeGreaterThanOrEqual(Date.parse(prepared.quote.expiresAt));
      });
      if (!pending || !before || !requestId) throw new Error("studio_paid_image_budget_interleave_not_observed");
      const outcome = await pending;
      expect("error" in outcome).toBe(true);
      expect(errorView(outcome.error)).toEqual({ status: 409, code: "studio_paid_image_expired" });
      unchanged(before, await f.facts(context));
      const retained = found(await f.lookup(context, scope, requestId));
      expect(retained).toMatchObject({ requestId, status: "prepared", generationId: null,
        execution: { phase: null, budgetState: null, budgetAmountUsd: null } });
      expect(f.queueCalls).toEqual([]); expect(f.calls).toEqual([]);
    } finally {
      try { await pending; } finally { await blocker.client.end(); }
    }
  });

  it("blocks changed quote model reference and cancelled parent before reservation or queue delivery", async () => {
    const { context, channel, scope, input } = await basis();
    const reference = await f.reference(context, scope);
    const prepared = await f.prepare(context, scope, { ...input, referenceKeys: [reference.key] });
    f.admission(context, true);
    let before = await f.facts(context);
    expect(await rejected(f.paid.commit(context, { scope, requestId: prepared.requestId, quoteHash: "0".repeat(64), confirmed: true })))
      .toEqual({ status: 409, code: "studio_paid_image_changed" });
    unchanged(before, await f.facts(context));
    await withTenant(f.database.db, context, tx => tx.update(assetFiles).set({ version: 2 }).where(eq(assetFiles.id, reference.assetId)));
    before = await f.facts(context);
    expect(await rejected(f.commit(context, prepared))).toEqual({ status: 409, code: "studio_paid_image_changed" });
    unchanged(before, await f.facts(context));
    const second = await f.prepare(context, scope, await f.request(context, channel.modelId));
    await f.price(context, channel.id, channel.modelId, { ...paidImageFixturePricing, estimatedUsd: "0.03000000" });
    before = await f.facts(context);
    expect(await rejected(f.commit(context, second))).toEqual({ status: 409, code: "studio_paid_image_changed" });
    unchanged(before, await f.facts(context));
    const current = await f.prepare(context, scope, await f.request(context, channel.modelId));
    await withTenant(f.database.db, context, tx => tx.update(modelRoutes).set({ status: "disabled" }).where(eq(modelRoutes.id, channel.modelId)));
    before = await f.facts(context);
    expect(await rejected(f.commit(context, current))).toEqual({ status: 409, code: "studio_paid_image_changed" });
    unchanged(before, await f.facts(context));
    const parent = await f.project(context), otherChannel = await f.channel(context);
    const parentPrepared = await f.prepare(context, parent.id, await f.request(context, otherChannel.modelId));
    await f.base.pod.cancelDesignBatch(context, parent.id);
    before = await f.facts(context);
    expect((await rejected(f.commit(context, parentPrepared))).status).toBe(409);
    unchanged(before, await f.facts(context));
    expect((await f.cancel(context, parentPrepared)).status).toBe("cancelled");
  });

  it("requires organization budgets and serializes two reservations against remaining monthly funds", async () => {
    const { context, channel, scope, input } = await basis({ budget: false });
    let before = await f.facts(context);
    expect(await rejected(f.prepare(context, scope, input))).toEqual({ status: 409, code: "studio_image_budget_required" });
    unchanged(before, await f.facts(context));
    await f.policy(context);
    const first = await f.prepare(context, scope, await f.request(context, channel.modelId));
    const second = await f.prepare(context, scope, await f.request(context, channel.modelId));
    f.admission(context, true);
    await f.policy(context, "0.010000");
    before = await f.facts(context);
    expect(await rejected(f.commit(context, first))).toEqual({ status: 409, code: "studio_image_budget_required" });
    unchanged(before, await f.facts(context));
    await f.policy(context, "1.000000", "0.075000");
    const outcomes = await Promise.allSettled([f.commit(context, first), f.commit(context, second)]);
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const denied = outcomes.find(row => row.status === "rejected");
    if (!denied || denied.status !== "rejected") throw new Error("studio_paid_image_expected_monthly_rejection");
    expect(errorView(denied.reason)).toEqual({ status: 409, code: "studio_image_budget_required" });
    const after = await f.facts(context);
    expect(after.rows).toHaveLength(1); expect(after.budget).toHaveLength(1);
    expect(after.budget[0]).toMatchObject({ state: "reserved", amountUsd: "0.050000" });
    expect(f.queueCalls).toHaveLength(1); expect(f.calls).toHaveLength(0);
  });

  it("does not let peers tenants another scope or stale authority claim a prepared request", async () => {
    const { actor, context, scope, input } = await basis();
    const prepared = await f.prepare(context, scope, input);
    const peer = await f.actor(context.tenantId, "tenant"), other = await f.actor();
    expect(await f.lookup(peer.context, "unassigned", input.requestId)).toEqual({ status: "missing", scope: "unassigned", requestId: input.requestId });
    expect((await f.page(peer.context, "unassigned")).items).toEqual([]);
    expect(await f.lookup(other.context, "unassigned", input.requestId)).toEqual({ status: "missing", scope: "unassigned", requestId: input.requestId });
    f.admission(context, true);
    let before = await f.facts(context);
    f.admission(peer.context, true);
    expect(await rejected(f.paid.commit(peer.context, { scope: "unassigned", requestId: input.requestId, quoteHash: prepared.quote.quoteHash, confirmed: true })))
      .toEqual({ status: 404, code: "studio_paid_image_missing" });
    f.admission(context, true);
    expect(await rejected(f.lookup(context, "unassigned", input.requestId))).toEqual({ status: 409, code: "studio_paid_image_changed" });
    unchanged(before, await f.facts(context));
    await f.grant(context, f.base.permissions.filter(permission => permission !== Permission.AssetWrite));
    before = await f.facts(context);
    expect((await rejected(f.commit(actor.context, prepared))).status).toBe(403);
    unchanged(before, await f.facts(context));
    try {
      await f.base.active(actor, false);
      const inactiveBefore = await f.facts(context);
      expect((await rejected(f.lookup(actor.context, scope, prepared.requestId))).status).toBe(403);
      unchanged(inactiveBefore, await f.facts(context));
    } finally { await f.base.active(actor, true); }
    expect(f.queueCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });

  it("leaves legacy unpriced task history unchanged and rechecks operator admission before Worker claim", async () => {
    const { context, scope, channel, input } = await basis();
    const legacy = await f.legacy(context, scope, channel.modelId);
    f.admission(context, true);
    let before = await f.facts(context);
    expect(await f.processGeneration(context, legacy)).toEqual({ id: legacy, disposition: "legacy_not_admitted" });
    unchanged(before, await f.facts(context));
    const prepared = await f.prepare(context, scope, input), committed = await f.commit(context, prepared);
    f.admission(context, false);
    before = await f.facts(context);
    expect(await f.processGeneration(context, committed.generationId!)).toEqual({ id: committed.generationId, disposition: "operator_paused" });
    unchanged(before, await f.facts(context));
    const old = before.rows.find(row => row.id === legacy)!;
    expect(old.input.capability).toBeUndefined(); expect(old.input.selectionRevision).toBeUndefined(); expect(old.modelSnapshot.paidImage).toBeUndefined();
  });

  it("abandons an unknown prepared key durably and refuses both late prepare and abandoning an already committed image", async () => {
    const { context, scope, channel } = await basis();
    const requestId = createEntityId(), input = await f.request(context, channel.modelId, { requestId });
    expect(await f.lookup(context, scope, requestId)).toEqual({ status: "missing", scope, requestId });
    const cancelled = await f.paid.abandon(context, { scope, requestId });
    expect(cancelled).toMatchObject({ version: 1, scope, requestId, status: "cancelled" });
    expect(await f.paid.abandon(context, { scope, requestId })).toEqual(cancelled);
    const before = await f.facts(context);
    expect(await rejected(f.prepare(context, scope, input))).toEqual({ status: 409, code: "studio_paid_image_cancelled" });
    unchanged(before, await f.facts(context));
    const prepared = await f.prepare(context, scope, await f.request(context, channel.modelId));
    const parent = await f.project(context), unknownOnParent = createEntityId();
    await f.base.pod.cancelDesignBatch(context, parent.id);
    expect(await f.paid.abandon(context, { scope: parent.id, requestId: unknownOnParent }))
      .toMatchObject({ scope: parent.id, requestId: unknownOnParent, status: "cancelled" });
    const reference = await f.reference(context, scope);
    const privatePrepared = await f.prepare(context, scope, await f.request(context, channel.modelId, { referenceKeys: [reference.key] }));
    const originalAsset = (await f.facts(context)).assets.find(row => row.id === reference.assetId)!;
    try {
      await withTenant(f.database.db, context, tx => tx.update(assetFiles).set({ rightsMetadata: {
        ...originalAsset.rightsMetadata, source: { kind: "licensed", reference: "Synthetic expired isolated license",
          licenseExpiresAt: "2020-01-01T00:00:00.000Z" },
      } }).where(eq(assetFiles.id, reference.assetId)));
      expect((await rejected(f.lookup(context, scope, privatePrepared.requestId))).status).toBe(409);
      const envelope = await f.invoke(context, { operation: "paid.image.abandon", scope, requestId: privatePrepared.requestId });
      expect(envelope).toMatchObject({ version: 1, scope, operation: "paid.image.abandon", contextAuthority: studioPersonalAuthority(context),
        data: { version: 1, scope, requestId: privatePrepared.requestId, status: "cancelled" } });
      if (envelope.operation !== "paid.image.abandon") throw new Error("studio_paid_image_expected_abandon_reply");
      expect(Object.keys(envelope.data).sort()).toEqual(["id", "requestId", "scope", "status", "version"]);
      const unchangedBefore = await f.facts(context);
      expect(await f.invoke(context, { operation: "paid.image.abandon", scope, requestId: privatePrepared.requestId })).toEqual(envelope);
      unchanged(unchangedBefore, await f.facts(context));
    } finally {
      await withTenant(f.database.db, context, tx => tx.update(assetFiles).set({ rightsMetadata: originalAsset.rightsMetadata })
        .where(eq(assetFiles.id, reference.assetId)));
    }
    const abandonedBefore = await f.facts(context);
    expect(await rejected(f.prepare(context, scope, await f.request(context, channel.modelId, { requestId: privatePrepared.requestId,
      referenceKeys: [reference.key] })))).toEqual({ status: 409, code: "studio_paid_image_cancelled" });
    unchanged(abandonedBefore, await f.facts(context));
    f.admission(context, true);
    const committed = await f.commit(context, prepared), committedBefore = await f.facts(context);
    expect(await rejected(f.paid.abandon(context, { scope, requestId: committed.requestId })))
      .toEqual({ status: 409, code: "studio_paid_image_changed" });
    unchanged(committedBefore, await f.facts(context));
  });

  it("rejects malformed immutable JSON pins and rolls back an orphan paid generation before a later no-op can forge its birth", async () => {
    const { context, scope, input } = await basis(), prepared = await f.prepare(context, scope, input);
    const before = await f.facts(context), original = before.requests.find(row => row.id === prepared.id)!;
    type Broken = { input: Record<string, unknown>; originalInput: Record<string, unknown>; quote: Record<string, unknown> };
    const mutations: Array<(value: Broken) => void> = [
      value => { delete value.quote.selectionRevision; delete value.input.selectionRevision; delete value.originalInput.selectionRevision; },
      value => { value.quote.selectionRevision = null; value.input.selectionRevision = null; value.originalInput.selectionRevision = null; },
      value => { delete value.quote.selectionRevision; },
      value => { value.input.selectionRevision = null; },
      value => { value.quote.modelId = null; value.input.modelId = null; value.originalInput.modelId = null; },
      value => { value.quote.providerConfigId = 123; },
      value => { value.quote.providerFingerprint = null; },
      value => { value.quote.contextAuthority = {}; },
      value => { value.quote.pricing = null; },
      value => { value.quote.pricing = { ...paidImageFixturePricing, estimatedUsd: 1 }; },
      value => { value.quote.pricing = { ...paidImageFixturePricing, reservationUsd: null }; },
    ];
    for (const mutate of mutations) {
      const requestId = createEntityId(), { quoteHash: ignoredHash, ...quote } = prepared.quote;
      void ignoredHash;
      const value: Broken = { input: { ...prepared.input, requestId }, originalInput: { ...original.originalInput, requestId },
        quote: { ...quote, pricing: { ...quote.pricing }, references: [...quote.references] } };
      mutate(value);
      value.quote.inputFingerprint = studioImageHash(value.input);
      const brokenQuote = { ...value.quote, quoteHash: studioImageHash(value.quote) };
      await constraintRejected(withTenant(f.database.db, context, tx => tx.insert(creativeStudioImageRequests).values({
        id: createEntityId(), tenantId: context.tenantId, ownerId: context.userId, scope, requestId,
        originalInput: value.originalInput as unknown as typeof original.originalInput,
        input: value.input as unknown as typeof original.input, quote: brokenQuote as unknown as typeof original.quote,
      })));
    }
    unchanged(before, await f.facts(context));
    const orphanId = createEntityId();
    let stagedBeforeCommit = false;
    await constraintRejected(withTenant(f.database.db, context, async tx => {
      await tx.insert(creativeStudioGenerations).values({
        id: orphanId, tenantId: context.tenantId, ownerId: context.userId, scope, requestId: input.requestId,
        input: prepared.input, references: prepared.quote.references, modelSnapshot: {
          providerConfigId: prepared.quote.providerConfigId, routeId: prepared.quote.modelId, providerFingerprint: prepared.quote.providerFingerprint,
          model: prepared.quote.model, capability: "image", paidImage: { imageRequestId: prepared.id, quoteHash: prepared.quote.quoteHash,
            reservationUsd: prepared.quote.pricing.reservationUsd, estimatedUsd: prepared.quote.pricing.estimatedUsd },
        },
      });
      await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: context.tenantId, requestId: orphanId,
        taskType: "studio_image", modelKey: prepared.quote.model, provider: "openai-compatible", amountUsd: prepared.quote.pricing.reservationUsd, state: "reserved" });
      await stageCreativeExecution(tx, context, { kind: "studio_generation", ownerId: orphanId, stepKey: "generate" }, "external_request");
      stagedBeforeCommit = true;
      // The matching committed request is deliberately absent. A deferred
      // constraint must reject this transaction, even though its other pins match.
    }));
    expect(stagedBeforeCommit).toBe(true);
    const touched = await withTenant(f.database.db, context, async tx => ({
      generations: await tx.update(creativeStudioGenerations).set({ updatedAt: new Date() }).where(eq(creativeStudioGenerations.id, orphanId)).returning({ id: creativeStudioGenerations.id }),
      holds: await tx.update(aiBudgetLedger).set({ state: "reserved" }).where(eq(aiBudgetLedger.requestId, orphanId)).returning({ id: aiBudgetLedger.id }),
    }));
    expect(touched).toEqual({ generations: [], holds: [] });
    unchanged(before, await f.facts(context)); expect(f.calls).toHaveLength(0);
  });

  it.each([false, true])("uses real Processor storage scanning and exact original bytes with reviewed reference=%s", async withReference => {
    const { context, scope, input } = await basis();
    const reference = withReference ? await f.reference(context, scope) : null;
    const originalInput = { ...input, referenceKeys: reference ? [reference.key] : [] };
    const prepared = await f.prepare(context, scope, originalInput);
    expect(prepared.originalInput).toEqual(originalInput);
    expect(prepared.quote.inputFingerprint).toBe(studioImageHash(prepared.input));
    f.admission(context, true);
    const committed = await f.commit(context, prepared), id = committed.generationId!;
    await Promise.all([f.processGeneration(context, id), f.processGeneration(context, id)]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "POST", path: reference ? "/v1/images/edits" : "/v1/images/generations",
      n: 1, model: prepared.quote.model, size: prepared.quote.size, quality: prepared.quote.quality,
      referenceChecksums: reference ? [reference.checksum] : [] });
    const result = found(await f.lookup(context, scope, prepared.requestId));
    expect(result.originalInput).toEqual(originalInput); expect(result.input).toEqual(prepared.input);
    expect(result).toMatchObject({ status: "completed", generationId: id, execution: {
      phase: "completed", costUsd: "0.01234567", budgetState: "committed", budgetAmountUsd: "0.012346" },
    result: { namespace: "image_files", key: "image:" + id, mediaType: "image/png", checksumSha256: paidImageFixtureSha(f.image), rightsStatus: "unverified" } });
    const after = await f.facts(context), asset = after.assets.find(row => row.id === result.result!.assetId)!;
    expect(after.role).toBe("yummyai_app"); expect(after.scans).toBeGreaterThan(0);
    const bytes = await f.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    expect(paidImageFixtureSha(bytes)).toBe(paidImageFixtureSha(f.image));
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 1024, height: 1024 });
    expect(after.executions[0]).toMatchObject({ phase: "completed", responseChecksum: after.executions[0]!.receipt!.responseChecksum });
    expect(after.executions[0]!.responseObjectKey).not.toBeNull(); expect(after.executions[0]!.completionEvidence).not.toBeNull();
    expect(after.tables.creative_design_candidates!.count).toBe(0); expect(after.tables.creative_design_versions!.count).toBe(0);
    expect(after.entries.filter(row => row.key === "image:" + id)).toHaveLength(1);
    expect(found(await f.lookup(context, scope, prepared.requestId))).toEqual(result);
    await f.page(context, scope); await f.commit(context, prepared);
    unchanged(after, await f.facts(context));
  });

  it("keeps an accepted but unknown image submission uncertain without another model call or released budget", async () => {
    const { context, scope, input } = await basis(), prepared = await f.prepare(context, scope, input);
    f.admission(context, true); f.mode("unknown_submission");
    const committed = await f.commit(context, prepared), id = committed.generationId!;
    await expect(f.processGeneration(context, id)).rejects.toThrow("studio_generation_failed");
    const original = found(await f.lookup(context, scope, input.requestId));
    expect(original).toMatchObject({ status: "uncertain", execution: { phase: "uncertain", costUsd: null, budgetState: "reserved", budgetAmountUsd: "0.050000" }, result: null });
    const before = await f.facts(context);
    expect(f.calls).toHaveLength(1);
    await f.processGeneration(context, id); await f.commit(context, prepared); await f.lookup(context, scope, input.requestId); await f.page(context, scope);
    expect((await rejected(f.cancel(context, prepared))).code).toBe("studio_paid_image_changed");
    unchanged(before, await f.facts(context));
    expect(f.calls).toHaveLength(1); expect(before.assets).toHaveLength(0);
    const deliveries: string[] = [];
    const scheduler = new StudioPaidImageScheduler(f.database, {
      async enqueue(value) { deliveries.push(value.generationId); }, async close() {},
    });
    try { expect(await scheduler.dispatch()).toEqual({ queued: 0, failed: 0, skipped: 0 }); }
    finally { await scheduler.close(); }
    expect(deliveries).toEqual([]); unchanged(before, await f.facts(context));
  });

  it("retains unknown actual fees and blocks later same-model calls after a recorded overrun", async () => {
    const { context, channel, scope, input } = await basis();
    const prepared = await f.prepare(context, scope, input);
    f.admission(context, true); f.mode("unknown_cost");
    const first = await f.commit(context, prepared); await f.processGeneration(context, first.generationId!);
    expect(found(await f.lookup(context, scope, input.requestId))).toMatchObject({ status: "completed",
      execution: { costUsd: null, budgetState: "reserved", budgetAmountUsd: "0.050000" } });
    f.mode("overrun");
    const second = await f.prepare(context, scope, await f.request(context, channel.modelId));
    const committed = await f.commit(context, second); await f.processGeneration(context, committed.generationId!);
    const overrun = found(await f.lookup(context, scope, second.requestId));
    expect(overrun.execution).toMatchObject({ costUsd: "0.12345678", budgetState: "committed", budgetAmountUsd: "0.123457" });
    const before = await f.facts(context);
    expect(await rejected(f.prepare(context, scope, await f.request(context, channel.modelId))))
      .toEqual({ status: 409, code: "studio_image_budget_required" });
    unchanged(before, await f.facts(context));
    expect(f.calls).toHaveLength(2);
  });

  it("retains the original late response and fee but cannot adopt it after current write authority is revoked", async () => {
    const { context, scope, input } = await basis(), prepared = await f.prepare(context, scope, input);
    f.admission(context, true);
    const committed = await f.commit(context, prepared), held = f.holdTransport();
    const pending = f.processGeneration(context, committed.generationId!);
    try {
      await held.entered;
      await f.grant(context, f.base.permissions.filter(permission => permission !== Permission.AssetWrite));
    } finally { held.clear(); }
    await pending.catch(() => undefined);
    const after = await f.facts(context), execution = after.executions[0]!;
    expect(f.calls).toHaveLength(1); expect(execution.submittedAt).not.toBeNull();
    expect(execution.receipt?.costUsd).toBe("0.01234567"); expect(execution.responseObjectKey).not.toBeNull();
    expect(execution.phase).not.toBe("completed"); expect(after.assets).toHaveLength(0);
    expect(after.entries).toHaveLength(0); expect(after.budget[0]).toMatchObject({ state: "committed", amountUsd: "0.012346" });
    expect(after.tables.creative_design_candidates!.count).toBe(0); expect(after.tables.creative_design_versions!.count).toBe(0);
  });

  it("budget admin creates and CAS-updates real policy while preserving other caps and every reserved or committed ledger field", async () => {
    const actor = await f.actor(undefined, "tenant"), context = actor.context;
    await f.rememberPolicy(context);
    const empty = await f.budgetWorkspace(context);
    expect(empty).toMatchObject({ version: 1, revision: null, occupiedUsd: "0.000000", policy: null });
    const beforeRead = await f.facts(context);
    const read = await f.invoke(context, { operation: "paid.image.budget.get", scope: "unassigned" });
    expect(read).toMatchObject({ operation: "paid.image.budget.get", contextAuthority: studioPersonalAuthority(context), data: empty });
    unchanged(beforeRead, await f.facts(context));
    const settings = { revision: null, monthlyCapUsd: "10.000000", defaultTaskCapUsd: "1.000000", imageTaskCapUsd: "0.200000" };
    const reply = await f.invoke(context, { operation: "paid.image.budget.save", scope: "unassigned", settings });
    if (reply.operation !== "paid.image.budget.save") throw new Error("studio_paid_image_expected_budget_reply");
    const saved = reply.data;
    expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.policy).toEqual({ monthlyCapUsd: settings.monthlyCapUsd, defaultTaskCapUsd: settings.defaultTaskCapUsd,
      imageTaskCapUsd: settings.imageTaskCapUsd, imageCapSource: "specific" });
    await withTenant(f.database.db, context, tx => tx.update(aiBudgetPolicies).set({
      taskCapsUsd: sql`jsonb_set(jsonb_set(${aiBudgetPolicies.taskCapsUsd},'{legacy_precision}','0.123456789123456789'::jsonb,true),'{another_ai_task}','0.375'::jsonb,true)`,
    }).where(eq(aiBudgetPolicies.tenantId, context.tenantId)));
    const channel = await f.channel(context), scope = (await f.project(context)).id;
    const first = await f.prepare(context, scope, await f.request(context, channel.modelId));
    const second = await f.prepare(context, scope, await f.request(context, channel.modelId));
    f.admission(context, true); await f.commit(context, first);
    const committed = await f.commit(context, second); await f.processGeneration(context, committed.generationId!);
    f.admission(context, false);
    const occupied = await f.budgetWorkspace(context);
    expect(occupied.occupiedUsd).toBe("0.062346"); expect(occupied.revision).not.toBe(saved.revision);
    const before = await f.facts(context);
    expect(before.budget.map(row => ({ state: row.state, amountUsd: row.amountUsd })).sort((a, b) => a.state.localeCompare(b.state)))
      .toEqual([{ state: "committed", amountUsd: "0.012346" }, { state: "reserved", amountUsd: "0.050000" }]);
    const [otherBefore] = await withTenant(f.database.db, context, tx => tx.execute<{ caps: string }>(
      sql`select (task_caps_usd-'studio_image')::text as caps from ai_budget_policies where tenant_id=${context.tenantId}`));
    expect(otherBefore?.caps).toContain("0.123456789123456789");
    const updated = await f.saveBudget(context, { revision: occupied.revision, monthlyCapUsd: "0.010000",
      defaultTaskCapUsd: "0.010000", imageTaskCapUsd: "0.010000" });
    expect(updated).toMatchObject({ occupiedUsd: occupied.occupiedUsd, periodStart: occupied.periodStart, periodEnd: occupied.periodEnd,
      policy: { monthlyCapUsd: "0.010000", defaultTaskCapUsd: "0.010000", imageTaskCapUsd: "0.010000", imageCapSource: "specific" } });
    expect(updated.revision).not.toBe(occupied.revision);
    const [otherAfter] = await withTenant(f.database.db, context, tx => tx.execute<{ caps: string }>(
      sql`select (task_caps_usd-'studio_image')::text as caps from ai_budget_policies where tenant_id=${context.tenantId}`));
    expect(otherAfter).toEqual(otherBefore);
    const after = await f.facts(context); unchanged(before, after); expect(after.budget).toEqual(before.budget);
    expect((await f.budgetWorkspace(context)).revision).toBe(updated.revision);
  });

  it("budget scope and current permission reject peers foreign revisions stale CAS and concurrent lost updates without touching task history", async () => {
    const actor = await f.actor(undefined, "tenant"), context = actor.context;
    const initial = await f.saveBudget(context, { revision: null, monthlyCapUsd: "10.000000", defaultTaskCapUsd: "1.000000", imageTaskCapUsd: "0.200000" });
    const settings = { revision: initial.revision, monthlyCapUsd: "12.000000", defaultTaskCapUsd: "1.000000", imageTaskCapUsd: "0.300000" };
    const self = await f.actor(context.tenantId, "self"), peer = await f.actor(context.tenantId, "tenant"), foreign = await f.actor(undefined, "tenant");
    const peerWithoutConfigure = await f.grant(peer.context, f.base.permissions.filter(value => value !== Permission.ModelConfigure), "tenant");
    const before = await f.facts(context), policy = await f.budgetPolicy(context), foreignBefore = await f.facts(foreign.context);
    for (const denied of [self.context, peerWithoutConfigure]) {
      expect(await rejected(f.budgetWorkspace(denied))).toEqual({ status: 403, code: "studio_image_budget_forbidden" });
      expect(await rejected(f.budgets.save(denied, settings))).toEqual({ status: 403, code: "studio_image_budget_forbidden" });
    }
    expect(await f.budgetWorkspace(foreign.context)).toMatchObject({ revision: null, policy: null, occupiedUsd: "0.000000" });
    expect(await rejected(f.budgets.save(foreign.context, settings))).toEqual({ status: 409, code: "studio_image_budget_changed" });
    expect(await rejected(f.budgets.save(foreign.context, { ...settings, revision: null, tenantId: context.tenantId })))
      .toEqual({ status: 400, code: "studio_image_budget_invalid" });
    try {
      await f.grant(context, f.base.permissions.filter(value => value !== Permission.ModelConfigure), "tenant");
      expect(await rejected(f.budgetWorkspace(actor.context))).toEqual({ status: 403, code: "studio_image_budget_forbidden" });
      expect(await rejected(f.budgets.save(actor.context, settings))).toEqual({ status: 403, code: "studio_image_budget_forbidden" });
    } finally { await f.grant(context, f.base.permissions, "tenant"); }
    unchanged(before, await f.facts(context)); unchanged(foreignBefore, await f.facts(foreign.context));
    expect(await f.budgetPolicy(context)).toEqual(policy);
    const updated = await f.saveBudget(context, settings), staleBefore = await f.facts(context), updatedPolicy = await f.budgetPolicy(context);
    expect(await rejected(f.budgets.save(context, settings))).toEqual({ status: 409, code: "studio_image_budget_changed" });
    unchanged(staleBefore, await f.facts(context)); expect(await f.budgetPolicy(context)).toEqual(updatedPolicy);
    const attempts = [{ revision: updated.revision, monthlyCapUsd: "20.000000", defaultTaskCapUsd: "2.000000", imageTaskCapUsd: "0.400000" },
      { revision: updated.revision, monthlyCapUsd: "21.000000", defaultTaskCapUsd: "3.000000", imageTaskCapUsd: "0.500000" }];
    const outcomes = await Promise.allSettled(attempts.map(value => f.saveBudget(context, value)));
    expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const denied = outcomes.find(value => value.status === "rejected");
    if (!denied || denied.status !== "rejected") throw new Error("studio_paid_image_expected_budget_cas_rejection");
    expect(errorView(denied.reason)).toEqual({ status: 409, code: "studio_image_budget_changed" });
    const winner = outcomes.find(value => value.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("studio_paid_image_expected_budget_cas_winner");
    expect(await f.budgetWorkspace(context)).toEqual(winner.value);
    unchanged(staleBefore, await f.facts(context)); expect(f.calls).toEqual([]); expect(f.queueCalls).toEqual([]);
  });

  it("boundary hold clock uses the real post-lock timestamp rather than the transaction start for a new reservation", async () => {
    const { context, scope, input } = await basis(), prepared = await f.prepare(context, scope, input);
    const blocker = connectDatabase(f.environment.url);
    let pending: Promise<{ value: Awaited<ReturnType<Fixture["commit"]>>; error?: never } | { error: unknown; value?: never }> | undefined;
    let releaseMicros: string | undefined;
    const before = await f.facts(context);
    try {
      await withTenant(blocker.db, context, async tx => {
        const [blocking] = await tx.execute<{ role: string; pid: number }>(sql`select current_user as role,pg_backend_pid() as pid`);
        expect(blocking?.role).toBe("yummyai_app");
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${context.tenantId + ":ai-assist-budget"},0))`);
        const [owner] = await withTenant(f.database.db, context, own => own.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`));
        expect(owner?.pid).toBeTypeOf("number"); expect(owner?.pid).not.toBe(blocking?.pid);
        f.admission(context, true);
        pending = f.commit(context, prepared).then(value => ({ value }), error => ({ error }));
        await expect.poll(async () => {
          const [blocked] = await tx.execute<{ blocked: boolean }>(
            sql`select ${blocking!.pid}=any(pg_blocking_pids(${owner!.pid})) as blocked`);
          return blocked?.blocked === true;
        }, { timeout: 10_000 }).toBe(true);
        const [clock] = await tx.execute<{ micros: string }>(sql`select (extract(epoch from clock_timestamp())*1000000)::bigint::text as micros`);
        releaseMicros = clock!.micros;
        // This sample is taken while the exact commit connection is blocked.
        // The budget lock is released only when this real transaction returns.
      });
      if (!pending || !releaseMicros) throw new Error("studio_paid_image_budget_clock_interleave_not_observed");
      const result = await pending; expect("value" in result).toBe(true);
      if (!result.value?.generationId) throw new Error("studio_paid_image_budget_clock_commit_failed");
      const hold = await f.paidHoldTimes(context, result.value.generationId);
      expect(hold).toMatchObject({ role: "yummyai_app", amountUsd: "0.050000", state: "reserved" });
      expect(BigInt(hold.generationCreatedAtMicros)).toBeLessThan(BigInt(releaseMicros));
      expect(BigInt(hold.createdAtMicros)).toBeGreaterThanOrEqual(BigInt(releaseMicros));
      expect(BigInt(hold.createdAtMicros)).toBeGreaterThanOrEqual(BigInt(hold.monthStartMicros));
      const after = await f.facts(context);
      expect(after.modelSecretReads).toBe(before.modelSecretReads); expect(after.calls).toEqual([]); expect(after.queueCalls).toHaveLength(1);
      expect(after.rows).toHaveLength(1); expect(after.budget).toHaveLength(1);
    } finally {
      try { await pending; } finally { await blocker.client.end(); }
    }
  });

  it("boundary old-month unsubmitted hold cannot reach provider secret or gateway and is never moved into the current month", async () => {
    const { context, scope, input } = await basis(), prepared = await f.prepare(context, scope, input);
    const seeded = await f.priorMonthHold(context, prepared), id = seeded.generationId!;
    const before = await f.facts(context), hold = await f.paidHoldTimes(context, id);
    expect(before.executions).toHaveLength(1);
    expect(before.executions[0]).toMatchObject({ submittedAt: null, submissionToken: null, responseObjectKey: null, receipt: null });
    expect(before.budget[0]).toMatchObject({ requestId: id, state: "reserved", amountUsd: prepared.quote.pricing.reservationUsd });
    expect(BigInt(hold.createdAtMicros)).toBeLessThan(BigInt(hold.monthStartMicros));
    expect(BigInt(hold.generationCreatedAtMicros)).toBeGreaterThanOrEqual(BigInt(hold.monthStartMicros));
    f.admission(context, true);
    await expect(f.processGeneration(context, id)).rejects.toThrow("studio_generation_failed");
    const after = await f.facts(context), retained = await f.paidHoldTimes(context, id);
    expect(after.executions[0]).toMatchObject({ phase: "failed", errorCode: "CREATIVE_ORIGINAL_BUDGET_CHANGED",
      submittedAt: null, submissionToken: null, responseObjectKey: null, responseChecksum: null, receipt: null });
    expect(after.rows[0]).toMatchObject({ id, status: "failed", assetId: null });
    expect(after.budget[0]).toEqual({ ...before.budget[0], state: "released" });
    expect(retained.createdAtSql).toBe(hold.createdAtSql); expect(retained.createdAtMicros).toBe(hold.createdAtMicros);
    expect(retained.ledgerId).toBe(hold.ledgerId); expect(after.budget).toHaveLength(1);
    expect(after.modelSecretReads).toBe(before.modelSecretReads); expect(after.calls).toEqual([]); expect(after.queueCalls).toEqual([]);
    expect(after.assets).toEqual([]); expect(after.tables.creative_design_candidates!.count).toBe(0);
    expect(await f.processGeneration(context, id)).toEqual({ id, disposition: "already_claimed" });
    unchanged(after, await f.facts(context));
  });

  it("boundary raw image cap rejects hidden submicro precision for prepare and commit but accepts insignificant trailing zeros without rewriting policy", async () => {
    const { context, scope, input } = await basis();
    await f.rawImageCap(context, "0.050000000000000001");
    const invalidPolicy = await f.budgetPolicy(context), beforePrepare = await f.facts(context);
    expect(invalidPolicy.taskCapsSql).toContain("0.050000000000000001");
    expect(await rejected(f.prepare(context, scope, input))).toEqual({ status: 409, code: "studio_image_budget_required" });
    unchanged(beforePrepare, await f.facts(context)); expect(await f.budgetPolicy(context)).toEqual(invalidPolicy);
    await f.rawImageCap(context, "0.050000000000000000000");
    const validPolicy = await f.budgetPolicy(context), prepared = await f.prepare(context, scope, input);
    expect(prepared.status).toBe("prepared"); expect(await f.budgetPolicy(context)).toEqual(validPolicy);
    await f.rawImageCap(context, "0.050000000000000001"); f.admission(context, true);
    const beforeCommit = await f.facts(context), invalidAgain = await f.budgetPolicy(context);
    expect(await rejected(f.commit(context, prepared))).toEqual({ status: 409, code: "studio_image_budget_required" });
    unchanged(beforeCommit, await f.facts(context)); expect(await f.budgetPolicy(context)).toEqual(invalidAgain);
    await f.rawImageCap(context, "0.050000000000000000000");
    const allowed = await f.budgetPolicy(context), committed = await f.commit(context, prepared);
    expect(committed).toMatchObject({ status: "queued", generationId: expect.any(String) });
    expect(await f.budgetPolicy(context)).toEqual(allowed);
    const after = await f.facts(context);
    expect(after.budget).toHaveLength(1); expect(after.budget[0]).toMatchObject({ state: "reserved", amountUsd: "0.050000" });
    expect(after.modelSecretReads).toBe(beforePrepare.modelSecretReads); expect(after.calls).toEqual([]); expect(after.queueCalls).toHaveLength(1);
  });

  it("boundary archived response in the current month resumes after lost storage ACK without another submit secret read or fee change", async () => {
    const { context, scope, input } = await basis(), prepared = await f.prepare(context, scope, input);
    f.admission(context, true); const committed = await f.commit(context, prepared), id = committed.generationId!;
    f.loseArchiveAck();
    expect(await f.processGeneration(context, id)).toEqual({ id, disposition: "recovery_pending" });
    const staged = await f.facts(context), original = staged.executions[0]!, hold = await f.paidHoldTimes(context, id);
    expect(original).toMatchObject({ phase: "response_staging", submittedAt: expect.any(Date), submissionToken: expect.any(String),
      responseObjectKey: expect.any(String), responseChecksum: expect.any(String), leaseToken: null, receipt: { costUsd: "0.01234567" } });
    expect(staged.calls).toHaveLength(1); expect(staged.modelSecretReads).toBeGreaterThan(0);
    expect(staged.budget[0]).toMatchObject({ state: "committed", amountUsd: "0.012346" });
    expect(BigInt(hold.createdAtMicros)).toBeGreaterThanOrEqual(BigInt(hold.monthStartMicros));
    // A changed invalid live cap must guard a first submission, not invalidate
    // an already submitted original response. This does not simulate a real
    // month boundary or claim cross-month historical acceptance.
    await f.rawImageCap(context, "0.050000000000000001");
    await f.archivedRecoveryDue(context, id);
    const beforeRecovery = await f.facts(context), policy = await f.budgetPolicy(context);
    expect(await f.processGeneration(context, id)).toEqual({ id, disposition: "completed" });
    const after = await f.facts(context), recovered = after.executions[0]!;
    expect(after.calls).toEqual(staged.calls); expect(after.modelSecretReads).toBe(staged.modelSecretReads);
    expect(recovered).toMatchObject({ phase: "completed", submittedAt: original.submittedAt, submissionToken: original.submissionToken,
      responseObjectKey: original.responseObjectKey, responseChecksum: original.responseChecksum, receipt: original.receipt });
    expect(after.budget).toEqual(beforeRecovery.budget); expect(await f.paidHoldTimes(context, id)).toEqual(hold);
    expect(await f.budgetPolicy(context)).toEqual(policy);
    const result = found(await f.lookup(context, scope, input.requestId));
    expect(result).toMatchObject({ status: "completed", execution: { phase: "completed", costUsd: "0.01234567", budgetState: "committed", budgetAmountUsd: "0.012346" },
      result: { checksumSha256: paidImageFixtureSha(f.image), rightsStatus: "unverified" } });
    const asset = after.assets.find(row => row.id === result.result!.assetId)!;
    const bytes = await f.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    expect(paidImageFixtureSha(bytes)).toBe(paidImageFixtureSha(f.image)); expect(after.queueCalls).toEqual(staged.queueCalls);
  });
});
