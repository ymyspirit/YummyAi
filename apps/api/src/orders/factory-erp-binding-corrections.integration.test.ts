import { createRequire } from "node:module";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FactoryErpBindingChangeResultSchema, type ChangeFactoryErpBinding } from "@yummyai/contracts/order/factory-erp-binding";
import { FactoryErpApplyResultSchema, FactoryErpExportRowSchema } from "@yummyai/contracts/order/factory-erp-import";
import { connectDatabase, factoryErpApplications, factoryErpApplicationRows, factoryErpBindingChanges, factoryErpBindingItems, factoryErpBindings, factoryErpImports, factoryErpObservations,
  factoryErpRetentionContext, redactExpiredFactoryErpSources, claimFactoryErpSourcePurges, finishFactoryErpSourcePurge,
  memberships, withTenant } from "@yummyai/database";
import { FactoryErpSourcePurger } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { bindingSha, factoryBindingFixture, requireFactoryBindingEnvironment, withFactoryBindingSourceClock } from "../../../../tools/testing/factory-erp-binding-corrections-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { FACTORY_ERP_READ, FACTORY_ERP_WRITE } from "./factory-erp-import.service.js";

requireFactoryBindingEnvironment("current");
function pg(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  if ("code" in error) return error as { code?: string; message?: string };
  return "cause" in error ? pg(error.cause) : {};
}
const guard = (message: string) => (error: unknown) => pg(error).code === "23514" && pg(error).message === message;

describe.sequential("factory ERP explicit binding release, correction and historical association CAS", () => {
  const database = connectDatabase(), f = factoryBindingFixture(database);
  const storageRequire = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url));
  const sdk = storageRequire("@aws-sdk/client-s3") as typeof S3Sdk;
  const makeClient = () => new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const s3 = makeClient(), bucket = process.env.S3_PRIVATE_BUCKET!, purger = new FactoryErpSourcePurger(makeClient(), bucket);
  beforeAll(async () => { await f.initialize(); await s3.send(new sdk.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } })); });
  afterEach(async () => { vi.restoreAllMocks(); await f.base.grant(); });
  // The disposable runner deletes this exact DB, versioned bucket and Redis,
  // including committed immutable evidence when an assertion interrupts a case.
  afterAll(async () => { vi.restoreAllMocks(); f.dispose(); purger.close(); s3.destroy(); await database.client.end(); });
  const source = async (id: string) => (await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpImports).where(eq(factoryErpImports.id, id))))[0]!;
  const expiry = async (id: string) => (await withTenant(database.db, f.base.context, tx => tx.execute<{ at: string }>(sql`
    select to_char((expires_at+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from factory_erp_imports where id=${id}::uuid`)))[0]!.at;
  const versions = async (key: string) => {
    const response = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: bucket, Prefix: key })); expect(response.IsTruncated).toBe(false);
    return [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])].filter(row => row.Key === key).map(row => row.VersionId).sort();
  };
  async function assertWholeRelease(bindingId: string, changeId: string) {
    const [row] = await withTenant(database.db, f.base.context, tx => tx.execute<{ root: string; count: number; released: number }>(sql`select
      b.released_by::text as root,count(i.id)::int as count,count(i.id) filter(where i.released_by=b.released_by)::int as released
      from factory_erp_bindings b join factory_erp_binding_items i on i.tenant_id=b.tenant_id and i.binding_id=b.id where b.id=${bindingId}::uuid group by b.id`));
    expect(row).toEqual({ root: changeId, count: 2, released: 2 });
  }

  it("releases the complete original group once and requires fresh explicit association pins for a linear subsequent binding without rewriting physical facts", async () => {
    const original = await f.scene(), replacement = await f.scene({ site: original.site }), saved = await f.seed(original, "已出库", undefined, true);
    const current = await f.upload(original, "已审核", saved.externalId), input = f.change(saved.binding, current.view), physical = await f.physicalState();
    const result = await f.service().changeBinding(f.base.context, saved.binding.id, input);
    expect(FactoryErpBindingChangeResultSchema.parse(result)).toMatchObject({ bindingId: saved.binding.id, action: "release", originalRevision: 1,
      originalItemsChecksum: saved.binding.itemsChecksum, originalObservationSequence: saved.binding.observationSequence, replacementBindingId: null, replacementRevision: null, application: null });
    await assertWholeRelease(saved.binding.id, result.id);
    const released = await f.service().binding(f.base.context, saved.binding.id);
    expect(released).toMatchObject({ state: "released", releasedBy: result.id, recordedStatus: "shipped", release: result });
    expect(released.items).toEqual(saved.binding.items);
    const view = await f.service().get(f.base.context, current.view.id, {});
    expect(view.rows[0]).toMatchObject({ binding: null, association: { activeBindingId: null, revision: 1, releaseId: result.id } });
    const candidates = await f.service().candidates(f.base.context, { factoryId: original.site.factory.id });
    for (const item of original.items) expect(candidates.items.find(row => row.deliveryItemId === item.deliveryItemId)?.bindingId).toBeNull();
    const packet = await f.delivery.get(f.base.context, original.packet.id);
    for (const item of packet.items) {
      expect(item.factoryErp).toMatchObject({ bindingId: saved.binding.id, bindingRevision: 1, bindingReleased: true,
        bindingReleaseId: result.id, status: null, historicalStatus: "shipped", exception: null, importId: saved.view.id, shippedQuantity: null });
      expect(item.status).toBe("submitted");
    }
    const state = await f.state();
    await expect(f.service().changeBinding(f.base.context, saved.binding.id, { ...input, idempotencyKey: createEntityId() })).rejects.toBeInstanceOf(ConflictException);
    const stale = f.applyInput(current.view, replacement.items);
    await expect(f.service().apply(f.base.context, current.view.id, stale)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service().apply(f.base.context, view.id, f.applyInput(view, replacement.items, true))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.service().apply(f.base.context, saved.view.id, saved.input)).toEqual(saved.result); expect(await f.state()).toEqual(state);
    const next = await f.service().apply(f.base.context, view.id, f.applyInput(view, replacement.items));
    const nextBinding = await f.service().binding(f.base.context, next.observations[0]!.bindingId);
    expect(nextBinding).toMatchObject({ revision: 2, previousBindingId: saved.binding.id, state: "active", releasedBy: null, recordedStatus: "scheduled" });
    expect((await f.service().binding(f.base.context, saved.binding.id)).nextBindingId).toBe(nextBinding.id);
    const first = await f.service().listBindings(f.base.context, { factoryId: original.site.factory.id, limit: 1 });
    const last = await f.service().listBindings(f.base.context, { factoryId: original.site.factory.id, limit: 1, cursor: first.nextCursor! });
    expect(first.items.map(row => row.id)).toEqual([nextBinding.id]); expect(last.items.map(row => row.id)).toEqual([saved.binding.id]); expect(last.nextCursor).toBeNull();
    expect((await f.service().listBindingChanges(f.base.context, saved.binding.id, {})).items).toEqual([result]);
    expect(await f.service().bindingChange(f.base.context, saved.binding.id, result.id)).toEqual(result);
    expect(await f.auditCount("factory_erp.binding_changed", result.id)).toBe(1); expect(await f.physicalState()).toEqual(physical);
  });

  it("atomically corrects a partially overlapping two-item group and never carries its old shipped observations into the new scheduled revision", async () => {
    const scene = await f.scene({ quantities: [1, 1, 1] }), original = { ...scene, items: scene.items.slice(0, 2), quantity: 2 };
    const saved = await f.seed(original), current = await f.upload(original, "已审核", saved.externalId), physical = await f.physicalState();
    const input = f.change(saved.binding, current.view, scene.items.slice(1)), result = await f.service().changeBinding(f.base.context, saved.binding.id, input);
    expect(result).toMatchObject({ action: "correct", replacementRevision: 2, application: { importId: current.view.id, appliedRows: 1,
      observations: [{ rowNumber: 2, bindingId: result.replacementBindingId, status: "scheduled", disposition: "advanced" }] } });
    await assertWholeRelease(saved.binding.id, result.id);
    const next = await f.service().binding(f.base.context, result.replacementBindingId!);
    expect(next).toMatchObject({ revision: 2, previousBindingId: saved.binding.id, recordedStatus: "scheduled", recordedException: null, state: "active" });
    expect(next.items.map(row => row.deliveryItemId).sort()).toEqual(scene.items.slice(1).map(row => row.deliveryItemId).sort());
    const old = await f.service().binding(f.base.context, saved.binding.id); expect(old.recordedStatus).toBe("shipped"); expect(old.items).toEqual(saved.binding.items);
    const packet = await f.delivery.get(f.base.context, scene.packet.id);
    expect(packet.items.find(item => item.id === scene.items[0]!.deliveryItemId)!.factoryErp).toMatchObject({
      bindingId: saved.binding.id, bindingRevision: 1, bindingReleased: true, bindingReleaseId: result.id,
      status: null, historicalStatus: "shipped", exception: null, importId: saved.view.id, shippedQuantity: null,
    });
    for (const item of packet.items.filter(value => next.items.some(row => row.deliveryItemId === value.id)))
      expect(item.factoryErp).toMatchObject({ bindingId: next.id, status: "scheduled", importId: current.view.id, shippedQuantity: null });
    const rows = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpObservations).where(eq(factoryErpObservations.bindingId, next.id)));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ applicationId: result.application!.id, importId: current.view.id, rawStatus: "已审核" });
    expect(await f.auditCount("factory_erp.import_applied", result.application!.id)).toBe(1); expect(await f.auditCount("factory_erp.binding_changed", result.id)).toBe(1);
    expect(await f.service().application(f.base.context, saved.view.id, saved.result.id)).toEqual(saved.result); expect(await f.physicalState()).toEqual(physical);
  });

  it("rejects stale observation CAS, wrong source identity, unchanged groups and noncurrent or incorrect new item pins with no partial release", async () => {
    const original = await f.scene(), replacement = await f.scene({ site: original.site }), foreignFactory = await f.scene();
    const saved = await f.seed(original), changed = await f.seed(original, "已作废", saved.externalId), current = await f.upload(original, "已审核", saved.externalId);
    const wrong = await f.upload(original, "已审核"), input = f.change(changed.binding, current.view, replacement.items);
    if (input.action !== "correct") throw new Error("Synthetic correction input missing");
    const invalid: ChangeFactoryErpBinding[] = [
      { ...input, expectedRevision: input.expectedRevision + 1 }, { ...input, expectedItemsChecksum: "d".repeat(64) },
      { ...input, expectedObservationSequence: saved.binding.observationSequence },
      { ...input, source: { ...input.source, fileChecksum: "d".repeat(64) } }, { ...input, source: { ...input.source, previewChecksum: "d".repeat(64) } },
      { ...input, source: { importId: wrong.view.id, fileChecksum: wrong.view.fileChecksum, previewChecksum: wrong.view.previewChecksum, rowNumber: 2 } },
      { ...input, items: original.items }, { ...input, items: replacement.items.slice(0, 1) }, { ...input, items: foreignFactory.items },
      { ...input, items: replacement.items.map((row, index) => index ? row : { ...row, fileChecksum: "d".repeat(64) }) },
      { ...input, items: replacement.items.map((row, index) => index ? row : { ...row, manufacturingChecksum: "d".repeat(64) }) },
    ];
    const before = await f.state(), physical = await f.physicalState();
    for (const request of invalid) {
      await expect(f.service().changeBinding(f.base.context, saved.binding.id, { ...request, idempotencyKey: createEntityId() })).rejects.toBeInstanceOf(ConflictException);
      expect(await f.state()).toEqual(before);
    }
    const result = await f.service().changeBinding(f.base.context, saved.binding.id, input);
    expect(result.replacementRevision).toBe(2);
    const work = await f.work.detail(f.base.context, original.productions[0]!.lineId);
    const held = await f.work.action(f.base.context, work.line.id, { action: "hold", expectedRevision: work.line.revision,
      expectedProjectionVersion: work.line.projectionVersion, reason: "Synthetic original delivery is explicitly paused", idempotencyKey: createEntityId() });
    expect(held.line.held).toBe(true);
    const [basis] = await withTenant(database.db, f.base.context, tx => tx.execute<{ current: boolean }>(sql`select factory_erp_delivery_current(${f.base.context.tenantId}::uuid,${original.items[0]!.deliveryItemId}::uuid,${original.site.factory.id}::uuid) as current`));
    expect(basis!.current).toBe(false);
    const next = await f.service().binding(f.base.context, result.replacementBindingId!), after = await f.state();
    await expect(f.service().changeBinding(f.base.context, next.id, f.change(next, current.view, original.items))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(after); expect(await f.physicalState()).toEqual(physical);
  });

  it("serializes real simultaneous release, correction and normal application so exactly one original observation basis wins without a fork", async () => {
    const original = await f.scene(), replacement = await f.scene({ site: original.site }), saved = await f.seed(original);
    const current = await f.upload(original, "已审核", saved.externalId), service = f.service(), physical = await f.physicalState();
    let release = () => {}, ready = () => {}, rejectReady: (error: Error) => void = () => {}, blockerPid = 0;
    const locked = new Promise<void>((done, reject) => { ready = done; rejectReady = reject; }), gate = new Promise<void>(done => { release = done; });
    const deadline = setTimeout(() => { release(); rejectReady(new Error("Synthetic binding serialization barrier timed out")); }, 45_000);
    const blocker = withTenant(database.db, f.base.context, async tx => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); blockerPid = pid!.pid;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`factory-erp-apply:${f.base.context.tenantId}:${original.site.factory.id}`},0))`); ready(); await gate;
    });
    const operations = [
      { name: "correct", run: () => service.changeBinding(f.base.context, saved.binding.id, f.change(saved.binding, current.view, replacement.items)) },
      { name: "apply", run: () => service.apply(f.base.context, current.view.id, f.applyInput(current.view, original.items)) },
      { name: "release", run: () => service.changeBinding(f.base.context, saved.binding.id, f.change(saved.binding, current.view)) },
    ];
    let waiters: Array<{ pid: number; blockers: number[]; wait_event: string }> = [], correctWaiterPid = 0;
    const waitForWaiters = async (count: 1 | 3) => expect.poll(async () => {
      waiters = await database.client.unsafe<Array<{ pid: number; blockers: number[]; wait_event: string }>>(
        "select pid,pg_blocking_pids(pid) as blockers,wait_event from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock%' order by pid", [blockerPid]);
      return waiters.length;
    }, { timeout: 15_000 }).toBe(count);
    let pending: Promise<PromiseSettledResult<{ name: string; result: Awaited<ReturnType<typeof service.changeBinding>> | Awaited<ReturnType<typeof service.apply>> }>[]> | undefined;
    try {
      await Promise.race([locked, blocker.then(() => { throw new Error("Synthetic factory advisory blocker ended before readiness"); })]);
      const correct = Promise.allSettled([operations[0]!].map(async operation => ({ name: operation.name, result: await operation.run() })));
      pending = correct;
      await waitForWaiters(1);
      correctWaiterPid = waiters[0]!.pid;
      expect(waiters[0]!.blockers).toContain(blockerPid); expect(waiters[0]!.wait_event).toBe("advisory");
      const remaining = Promise.allSettled(operations.slice(1).map(async operation => ({ name: operation.name, result: await operation.run() })));
      pending = Promise.all([correct, remaining]).then(([first, rest]) => [...first, ...rest]);
      await waitForWaiters(3);
      expect(blockerPid).toBeGreaterThan(0); expect(new Set(waiters.map(row => row.pid)).size).toBe(3);
      expect(waiters.map(row => row.pid)).toContain(correctWaiterPid);
      for (const waiter of waiters) { expect(waiter.blockers).toContain(blockerPid); expect(waiter.wait_event).toBe("advisory"); }
    } finally { release(); clearTimeout(deadline); try { await blocker; } finally { if (pending) await pending; } }
    if (!pending) throw new Error("Synthetic concurrent owner requests missing");
    const outcomes = await pending, success = outcomes.filter(value => value.status === "fulfilled");
    for (const [index, outcome] of outcomes.entries()) if (outcome.status === "rejected") {
      if (!(outcome.reason instanceof ConflictException)) throw new Error(
        `Unexpected concurrent ${operations[index]!.name} failure; SQLSTATE=${pg(outcome.reason).code ?? "unavailable"}; lockBarrier=${JSON.stringify({ blockerPid, correctWaiterPid, waiters })}`,
        { cause: outcome.reason });
      expect(outcome.reason).toBeInstanceOf(ConflictException);
    }
    expect(success).toHaveLength(1);
    const winner = success[0]!.value;
    const [shape] = await withTenant(database.db, f.base.context, tx => tx.execute<{ active: number; broken: number; changes: number }>(sql`select
      (select count(*) from factory_erp_bindings where factory_id=${original.site.factory.id}::uuid and released_by is null)::int as active,
      (select count(*) from factory_erp_binding_items i join factory_erp_bindings b on b.tenant_id=i.tenant_id and b.id=i.binding_id where b.factory_id=${original.site.factory.id}::uuid and i.released_by is distinct from b.released_by)::int as broken,
      (select count(*) from factory_erp_binding_changes where binding_id=${saved.binding.id}::uuid)::int as changes`));
    expect(shape).toEqual({ active: winner.name === "release" ? 0 : 1, broken: 0, changes: winner.name === "apply" ? 0 : 1 });
    expect(await f.auditCount(winner.name === "apply" ? "factory_erp.import_applied" : "factory_erp.binding_changed", winner.result.id)).toBe(1);
    expect(await f.physicalState()).toEqual(physical);
  });

  it("recovers a lost committed correction in a fresh service by the original actor body and key, including after expiry, without reviving a successful old normal request", async () => {
    const original = await f.scene(), replacement = await f.scene({ site: original.site }), saved = await f.seed(original, "已出库", undefined, true);
    const current = await f.upload(original, "已审核", saved.externalId), input = f.change(saved.binding, current.view, replacement.items), other = await f.actor();
    let committed: Awaited<ReturnType<ReturnType<typeof f.service>["changeBinding"]>> | undefined;
    const lost = new Error("Synthetic committed binding change response lost");
    await expect((async () => { committed = await f.service().changeBinding(f.base.context, saved.binding.id, input); throw lost; })()).rejects.toBe(lost);
    if (!committed) throw new Error("Actual committed correction receipt missing");
    const result = committed, before = await f.state();
    expect(await f.service().changeBinding(f.base.context, saved.binding.id, input)).toEqual(result);
    await expect(f.service().changeBinding(other, saved.binding.id, input)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service().changeBinding(f.base.context, result.replacementBindingId!, input)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service().changeBinding(f.base.context, saved.binding.id, { ...input, reasonCode: "operator_confirmed_change" })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.service().apply(f.base.context, saved.view.id, saved.input)).toEqual(saved.result);
    await expect(f.service().apply(f.base.context, current.view.id, f.applyInput(current.view, replacement.items, true))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    await withFactoryBindingSourceClock(database, async set => {
      await set(await expiry(current.view.id));
      expect(await f.service().changeBinding(f.base.context, saved.binding.id, input)).toEqual(result);
      expect(await f.service().apply(f.base.context, saved.view.id, saved.input)).toEqual(saved.result);
      const next = await f.service().binding(f.base.context, result.replacementBindingId!);
      await expect(f.service().changeBinding(f.base.context, next.id, f.change(next, current.view))).rejects.toBeInstanceOf(NotFoundException);
      expect(await f.service().bindingChange(f.base.context, saved.binding.id, result.id)).toEqual(result);
      expect(await f.state()).toEqual(before);
    });
    expect(await f.auditCount("factory_erp.binding_changed", result.id)).toBe(1);
    const [stored] = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpBindingChanges).where(eq(factoryErpBindingChanges.id, result.id)));
    expect(stored!.requestCanonical).toBe(canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: saved.binding.id, input }));
    expect(stored!.requestChecksum).toBe(bindingSha(stored!.requestCanonical));
    expect(JSON.stringify({ input: stored!.input, result: stored!.result })).not.toContain(saved.externalId);
  });

  it("requires every current tenant permission and the original ceiling before reads or replay, rechecks real source I/O and hides foreign tenant binding history", async () => {
    const original = await f.scene(), saved = await f.seed(original), current = await f.upload(original, "已审核", saved.externalId);
    const input = f.change(saved.binding, current.view), before = await f.state(), realRead = f.storage.readPrivate.bind(f.storage), read = vi.spyOn(f.storage, "readPrivate");
    await expect(f.service().binding(f.base.foreignContext, saved.binding.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service().changeBinding(f.base.foreignContext, saved.binding.id, input)).rejects.toBeInstanceOf(NotFoundException);
    for (const permission of FACTORY_ERP_WRITE) {
      await f.base.grant(FACTORY_ERP_WRITE.filter(value => value !== permission));
      await expect(f.service().changeBinding(f.base.context, saved.binding.id, input)).rejects.toBeInstanceOf(ForbiddenError);
      if (permission === Permission.OrderWrite) expect((await f.service().binding(f.base.context, saved.binding.id)).id).toBe(saved.binding.id);
      else await expect(f.service().binding(f.base.context, saved.binding.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await f.base.grant([Permission.OrderWrite], "self", FACTORY_ERP_READ);
    await expect(f.service().changeBinding(f.base.context, saved.binding.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await f.base.grant();
    const narrow = { ...f.base.context, permissionScopes: { ...f.base.context.permissionScopes, [Permission.DesignRead]: "self" as const } };
    await expect(f.service().changeBinding(narrow, saved.binding.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(read).not.toHaveBeenCalled();
    await withTenant(database.db, f.base.seed(), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.base.owner.membershipId)));
    await expect(f.service().binding(f.base.context, saved.binding.id)).rejects.toBeInstanceOf(ForbiddenError);
    await f.base.grant();
    read.mockRestore();
    const raced = vi.spyOn(f.storage, "readPrivate").mockImplementationOnce(async (...args) => {
      const bytes = await realRead(...args); await f.base.grant(FACTORY_ERP_READ); return bytes;
    });
    try {
      await expect(f.service().changeBinding(f.base.context, saved.binding.id, input)).rejects.toBeInstanceOf(ForbiddenError);
      expect(raced).toHaveBeenCalledTimes(1); expect(await f.state()).toEqual(before);
    } finally { raced.mockRestore(); await f.base.grant(); }
    const result = await f.service().changeBinding(f.base.context, saved.binding.id, input), committed = await f.state();
    await f.base.grant(FACTORY_ERP_READ);
    await expect(f.service().changeBinding(f.base.context, saved.binding.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.service().bindingChange(f.base.context, saved.binding.id, result.id)).toEqual(result);
    expect(await f.state()).toEqual(committed);
  });

  it("enforces real app-role release closure, immutable history, same-transaction audits and closed-parent guards while a legal raw control and public correction preserve rollback", async () => {
    const original = await f.scene(), replacement = await f.scene({ site: original.site }), saved = await f.seed(original), current = await f.upload(original, "已审核", saved.externalId);
    const before = await f.state(), physical = await f.physicalState(), rollback = new Error("Synthetic valid raw release rolls back");
    let flushedRelease = false, attemptedSuccessor = false;
    const raw = async (mode: "root_only" | "partial" | "no_audit" | "control" | "early_successor") => withTenant(database.db, f.base.context, async tx => {
      const input = f.change(saved.binding, current.view), id = createEntityId(), createdAt = new Date();
      const requestCanonical = canonicalJson({ version: 1, operation: "factory-erp-binding-change", bindingId: saved.binding.id, input });
      const result = FactoryErpBindingChangeResultSchema.parse({ id, bindingId: saved.binding.id, factoryId: original.site.factory.id, action: "release", reasonCode: input.reasonCode,
        source: input.source, originalRevision: saved.binding.revision, originalItemsChecksum: saved.binding.itemsChecksum, originalObservationSequence: saved.binding.observationSequence,
        replacementBindingId: null, replacementRevision: null, application: null, requestChecksum: bindingSha(requestCanonical), createdAt: createdAt.toISOString() });
      await tx.insert(factoryErpBindingChanges).values({ id, tenantId: f.base.context.tenantId, factoryId: original.site.factory.id, bindingId: saved.binding.id,
        sourceImportId: current.view.id, sourceRowNumber: 2, action: "release", replacementBindingId: null, replacementApplicationId: null, idempotencyKey: input.idempotencyKey,
        requestCanonical, requestChecksum: result.requestChecksum, input, result, createdBy: f.base.context.userId, creationTransactionId: sql`pg_current_xact_id()::text`, createdAt });
      await tx.update(factoryErpBindings).set({ releasedBy: id }).where(eq(factoryErpBindings.id, saved.binding.id));
      if (mode !== "root_only") {
        const rows = await tx.select({ id: factoryErpBindingItems.id }).from(factoryErpBindingItems).where(eq(factoryErpBindingItems.bindingId, saved.binding.id));
        for (const row of mode === "partial" ? rows.slice(0, 1) : rows) await tx.update(factoryErpBindingItems).set({ releasedBy: id }).where(eq(factoryErpBindingItems.id, row.id));
      }
      if (mode !== "no_audit") await f.base.audit.recordInTransaction(tx, f.base.context, { action: "factory_erp.binding_changed", resourceType: "factory_erp_binding_change", resourceId: id, result: "success", metadata: { bindingId: saved.binding.id, action: "release" } });
      await tx.execute(sql`set constraints all immediate`);
      if (mode === "early_successor") {
        flushedRelease = true;
        await tx.execute(sql`set constraints all deferred`);
        const [stored] = await tx.select().from(factoryErpImports).where(eq(factoryErpImports.id, current.view.id));
        const [old] = await tx.select().from(factoryErpBindings).where(eq(factoryErpBindings.id, saved.binding.id));
        if (!stored?.encryptedPayload || !old) throw new Error("Actual scanned source and released root required");
        const originalRow = f.base.vault.withSecret(stored.encryptedPayload, value => FactoryErpExportRowSchema.parse(JSON.parse(value).parsed.rows[0]));
        const selected = [...replacement.items].sort((a, b) => a.deliveryItemId.localeCompare(b.deliveryItemId));
        const body = f.applyInput(current.view, selected);
        body.rows[0]!.association = { expectedActiveBindingId: null, expectedRevision: old.revision, expectedReleaseId: id, confirmed: true };
        const applicationId = createEntityId(), bindingId = createEntityId(), observationId = createEntityId(), at = new Date();
        const canonical = canonicalJson({ version: 1, operation: "factory-erp-apply", importId: stored.id, input: body });
        const receipt = FactoryErpApplyResultSchema.parse({ id: applicationId, importId: stored.id, fileChecksum: stored.fileChecksum,
          previewChecksum: stored.previewChecksum, requestChecksum: bindingSha(canonical), createdAt: at.toISOString(), appliedRows: 1,
          observations: [{ rowNumber: originalRow.rowNumber, bindingId, observationId, disposition: "advanced", status: "scheduled" }] });
        await tx.insert(factoryErpApplications).values({ id: applicationId, tenantId: f.base.context.tenantId, importId: stored.id,
          idempotencyKey: body.idempotencyKey, requestCanonical: canonical, requestChecksum: receipt.requestChecksum, input: body, result: receipt,
          createdBy: f.base.context.userId, creationTransactionId: sql`pg_current_xact_id()::text`, createdAt: at });
        attemptedSuccessor = true;
        // Complete the ordinary owner graph if birth is ever allowed again;
        // the standalone release has no declared replacement in its receipt.
        await tx.insert(factoryErpBindings).values({ id: bindingId, tenantId: f.base.context.tenantId, factoryId: old.factoryId,
          externalKey: old.externalKey, itemsChecksum: bindingSha(canonicalJson(selected)), quantity: originalRow.itemQuantity,
          encryptedPayload: f.base.vault.encrypt(JSON.stringify({ externalId: originalRow.externalId, items: selected })), applicationId,
          revision: old.revision + 1, previousBindingId: old.id, releasedBy: null, privateRedactedAt: null,
          createdBy: f.base.context.userId, creationTransactionId: sql`pg_current_xact_id()::text`, createdAt: at });
        await tx.insert(factoryErpBindingItems).values(selected.map(item => {
          const actual = replacement.productions.find(value => value.order.id === item.productionOrderId);
          if (!actual) throw new Error("Actual replacement production quantity required");
          return { id: createEntityId(), tenantId: f.base.context.tenantId, bindingId, ...item, quantity: actual.quantity, releasedBy: null };
        }));
        const claim = stored.sourceClaims.find(value => value.rowNumber === originalRow.rowNumber);
        if (!claim) throw new Error("Actual immutable source claim required");
        await tx.insert(factoryErpObservations).values({ id: observationId, tenantId: f.base.context.tenantId, bindingId, applicationId, importId: stored.id,
          rowNumber: originalRow.rowNumber, rowChecksum: claim.rowChecksum, rawStatus: originalRow.rawStatus,
          encryptedPayload: f.base.vault.encrypt(JSON.stringify(originalRow)), privateRedactedAt: null,
          createdBy: f.base.context.userId, creationTransactionId: sql`pg_current_xact_id()::text` });
        await tx.insert(factoryErpApplicationRows).values({ id: createEntityId(), tenantId: f.base.context.tenantId, applicationId,
          rowNumber: originalRow.rowNumber, bindingId, observationId, disposition: "advanced" });
        await f.base.audit.recordInTransaction(tx, f.base.context, { action: "factory_erp.import_applied", resourceType: "factory_erp_application",
          resourceId: applicationId, result: "success", metadata: { importId: stored.id, rows: 1 } });
        await tx.execute(sql`set constraints all immediate`);
        throw new Error("Standalone release incorrectly admitted a same-transaction ordinary successor");
      }
      if (mode === "control") throw rollback;
    });
    for (const mode of ["root_only", "partial"] as const) {
      await expect(raw(mode)).rejects.toSatisfy(guard("factory_erp_binding_change_closure_required")); expect(await f.state()).toEqual(before);
    }
    await expect(raw("no_audit")).rejects.toSatisfy(guard("factory_erp_binding_change_audit_required"));
    await expect(raw("control")).rejects.toBe(rollback); expect(await f.state()).toEqual(before);
    await expect(raw("early_successor")).rejects.toSatisfy(guard("factory_erp_binding_change_correction_required"));
    expect(flushedRelease).toBe(true); expect(attemptedSuccessor).toBe(true); expect(await f.state()).toEqual(before);
    await expect(withTenant(database.db, f.base.context, tx => tx.update(factoryErpBindings).set({ releasedBy: createEntityId() }).where(eq(factoryErpBindings.id, saved.binding.id))))
      .rejects.toSatisfy(guard("factory_erp_binding_release_required"));
    const input = f.change(saved.binding, current.view, replacement.items), actualAudit = f.base.audit.recordInTransaction.bind(f.base.audit);
    for (const action of ["factory_erp.import_applied", "factory_erp.binding_changed"]) {
      const failure = new Error(`Synthetic ${action} audit failure`); let sawBornFacts = false;
      const audit = vi.spyOn(f.base.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
        const result = await actualAudit(tx, context, event);
        if (event.action === action) {
          const changes = await tx.select().from(factoryErpBindingChanges).where(eq(factoryErpBindingChanges.bindingId, saved.binding.id));
          const old = await tx.select().from(factoryErpBindings).where(eq(factoryErpBindings.id, saved.binding.id));
          sawBornFacts = changes.length === 1 && old[0]!.releasedBy === changes[0]!.id; throw failure;
        }
        return result;
      });
      try { await expect(f.service().changeBinding(f.base.context, saved.binding.id, input)).rejects.toBe(failure); expect(sawBornFacts).toBe(true); }
      finally { audit.mockRestore(); }
      expect(await f.state()).toEqual(before);
    }
    for (const attack of ["closed_observation", "fork"] as const) {
      const audit = vi.spyOn(f.base.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
        if (event.action === "factory_erp.import_applied") {
          if (attack === "closed_observation") {
            const [row] = await tx.select().from(factoryErpObservations).where(eq(factoryErpObservations.applicationId, event.resourceId!));
            await tx.insert(factoryErpObservations).values({ id: createEntityId(), tenantId: context.tenantId, bindingId: saved.binding.id,
              applicationId: row!.applicationId, importId: row!.importId, rowNumber: row!.rowNumber, rowChecksum: row!.rowChecksum, rawStatus: row!.rawStatus,
              encryptedPayload: row!.encryptedPayload, privateRedactedAt: null, createdBy: context.userId, creationTransactionId: sql`pg_current_xact_id()::text` });
          } else {
            const [row] = await tx.select().from(factoryErpBindings).where(eq(factoryErpBindings.applicationId, event.resourceId!));
            await tx.insert(factoryErpBindings).values({ ...row!, id: createEntityId(), previousBindingId: saved.binding.id, revision: saved.binding.revision + 2 });
          }
        }
        return actualAudit(tx, context, event);
      });
      try { await expect(f.service().changeBinding(f.base.context, saved.binding.id, input)).rejects.toSatisfy(guard(attack === "closed_observation" ? "factory_erp_binding_closed" : "factory_erp_binding_sequence_invalid")); }
      finally { audit.mockRestore(); }
      expect(await f.state()).toEqual(before);
    }
    const result = await f.service().changeBinding(f.base.context, saved.binding.id, input), committed = await f.state();
    await expect(withTenant(database.db, f.base.context, tx => tx.update(factoryErpBindings).set({ releasedBy: null }).where(eq(factoryErpBindings.id, saved.binding.id))))
      .rejects.toSatisfy(guard("factory_erp_binding_history_immutable"));
    await expect(withTenant(database.db, f.base.context, tx => tx.execute(sql`update factory_erp_binding_changes set input=input where id=${result.id}::uuid`)))
      .rejects.toSatisfy(error => pg(error).code === "42501");
    const [visibility] = await withTenant(database.db, f.base.foreignContext, tx => tx.execute<{ count: number; forced: boolean; app: boolean }>(sql`select count(*)::int as count,
      (select relforcerowsecurity from pg_class where oid='factory_erp_binding_changes'::regclass) as forced,current_user='yummyai_app' as app from factory_erp_binding_changes where id=${result.id}::uuid`));
    expect(visibility).toEqual({ count: 0, forced: true, app: true }); expect(await f.state()).toEqual(committed); expect(await f.physicalState()).toEqual(physical);
  });

  it("releases an already redacted and no-longer-current old group only with a new retained same-head source, then cleans that source without restoring private history", async () => {
    const original = await f.scene(), saved = await f.seed(original), stored = await source(saved.view.id), maintenance = factoryErpRetentionContext(f.base.context.tenantId);
    const fresh = await f.scene({ site: original.site }), freshSaved = await f.seed(fresh), freshSource = await source(freshSaved.view.id);
    const freshInput = f.change(freshSaved.binding, freshSaved.view), freshRelease = await f.service().changeBinding(f.base.context, freshSaved.binding.id, freshInput);
    await assertWholeRelease(freshSaved.binding.id, freshRelease.id);
    const [releasedPrivate] = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpBindings).where(eq(factoryErpBindings.id, freshSaved.binding.id)));
    expect(releasedPrivate!.encryptedPayload).not.toBeNull();
    expect(releasedPrivate).toMatchObject({ privateRedactedAt: null, releasedBy: freshRelease.id });
    expect(await versions(freshSource.objectKey)).toHaveLength(1);
    await withFactoryBindingSourceClock(database, async set => {
      await set(await expiry(saved.view.id));
      await expect(f.service().changeBinding(f.base.context, saved.binding.id, f.change(saved.binding, saved.view))).rejects.toBeInstanceOf(NotFoundException);
      expect(await withTenant(database.db, maintenance, tx => redactExpiredFactoryErpSources(tx, { importId: saved.view.id }))).toBe(1);
      const [ticket] = await withTenant(database.db, maintenance, tx => claimFactoryErpSourcePurges(tx, { importId: saved.view.id })); expect(ticket).toBeDefined();
      const proof = await purger.purge(ticket!, { signal: AbortSignal.timeout(20_000) });
      await withTenant(database.db, maintenance, tx => finishFactoryErpSourcePurge(tx, ticket!, proof)); expect(await versions(stored.objectKey)).toEqual([]);
      const current = await f.upload(original, "已审核", saved.externalId);
      const work = await f.work.detail(f.base.context, original.productions[0]!.lineId);
      const held = await f.work.action(f.base.context, work.line.id, { action: "hold", expectedRevision: work.line.revision,
        expectedProjectionVersion: work.line.projectionVersion, reason: "Synthetic historical group is explicitly paused", idempotencyKey: createEntityId() });
      expect(held.line.held).toBe(true);
      const [basis] = await withTenant(database.db, f.base.context, tx => tx.execute<{ current: boolean }>(sql`select factory_erp_delivery_current(${f.base.context.tenantId}::uuid,${original.items[0]!.deliveryItemId}::uuid,${original.site.factory.id}::uuid) as current`));
      expect(basis!.current).toBe(false);
      const physical = await f.physicalState(), old = await f.service().binding(f.base.context, saved.binding.id), input = f.change(old, current.view);
      const result = await f.service().changeBinding(f.base.context, saved.binding.id, input); await assertWholeRelease(saved.binding.id, result.id);
      expect(await f.physicalState()).toEqual(physical);
      const newSource = await source(current.view.id); await set(await expiry(current.view.id));
      expect(await withTenant(database.db, maintenance, tx => redactExpiredFactoryErpSources(tx, { importId: current.view.id }))).toBe(1);
      const [next] = await withTenant(database.db, maintenance, tx => claimFactoryErpSourcePurges(tx, { importId: current.view.id })); expect(next).toBeDefined();
      const deleted = await purger.purge(next!, { signal: AbortSignal.timeout(20_000) });
      await withTenant(database.db, maintenance, tx => finishFactoryErpSourcePurge(tx, next!, deleted)); expect(await versions(newSource.objectKey)).toEqual([]);
      expect(await withTenant(database.db, maintenance, tx => redactExpiredFactoryErpSources(tx, { importId: freshSaved.view.id }))).toBe(1);
      const [releasedTicket] = await withTenant(database.db, maintenance, tx => claimFactoryErpSourcePurges(tx, { importId: freshSaved.view.id }));
      expect(releasedTicket).toBeDefined();
      const releasedProof = await purger.purge(releasedTicket!, { signal: AbortSignal.timeout(20_000) });
      await withTenant(database.db, maintenance, tx => finishFactoryErpSourcePurge(tx, releasedTicket!, releasedProof));
      expect(await versions(freshSource.objectKey)).toEqual([]);
      const [redactedRelease] = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpBindings).where(eq(factoryErpBindings.id, freshSaved.binding.id)));
      expect(redactedRelease).toMatchObject({ encryptedPayload: null, releasedBy: freshRelease.id });
      expect(redactedRelease!.privateRedactedAt).not.toBeNull();
      expect(await f.service().bindingChange(f.base.context, freshSaved.binding.id, freshRelease.id)).toEqual(freshRelease);
      expect(await f.service().changeBinding(f.base.context, freshSaved.binding.id, freshInput)).toEqual(freshRelease);
      const [releasedItems] = await withTenant(database.db, f.base.context, tx => tx.execute<{ count: number; released: number }>(sql`select count(*)::int as count,
        count(*) filter(where released_by=${freshRelease.id}::uuid)::int as released from factory_erp_binding_items where binding_id=${freshSaved.binding.id}::uuid`));
      expect(releasedItems).toEqual({ count: 2, released: 2 });
      expect(await f.auditCount("factory_erp.source_redacted", freshSaved.view.id)).toBe(1);
      expect(await f.auditCount("factory_erp.source_purged", freshSaved.view.id)).toBe(1);
      expect(await f.auditCount("factory_erp.binding_changed", freshRelease.id)).toBe(1);
      expect(await f.service().changeBinding(f.base.context, saved.binding.id, input)).toEqual(result);
      expect(await f.service().bindingChange(f.base.context, saved.binding.id, result.id)).toEqual(result);
      const [row] = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpBindings).where(eq(factoryErpBindings.id, saved.binding.id)));
      expect(row).toMatchObject({ encryptedPayload: null, releasedBy: result.id }); expect(row!.privateRedactedAt).not.toBeNull();
      expect(await f.auditCount("factory_erp.source_purged", saved.view.id)).toBe(1); expect(await f.auditCount("factory_erp.binding_changed", result.id)).toBe(1);
      expect(await f.physicalState()).toEqual(physical);
    });
    expect(await f.service().lifecycle(f.base.context, saved.view.id)).toMatchObject({ access: "expired", purgeStatus: "purged" });
    expect(await f.service().lifecycle(f.base.context, freshSaved.view.id)).toMatchObject({ access: "expired", purgeStatus: "purged" });
  });

  it("serializes factories sharing one supplier without a supplier lock-upgrade deadlock or cross-factory binding", async () => {
    const firstSite = await f.site();
    const actual = await createSyntheticFactory(f.base.factories, f.base.context, firstSite.supplierId, "shaped_pillow", "Synthetic shared-supplier second factory");
    const capacity = await createSyntheticFactoryCapacity(database, f.base.context, { factory: actual.factory,
      bindings: [{ capabilityVersionId: actual.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10000 });
    const secondSite = { ...actual, supplierId: firstSite.supplierId, capacity };
    expect(secondSite.factory.supplierId).toBe(firstSite.factory.supplierId); expect(secondSite.factory.id).not.toBe(firstSite.factory.id);
    const first = await f.scene({ site: firstSite }), second = await f.scene({ site: secondSite });
    const externalId = `SYNTHETIC-SHARED-SUPPLIER-${createEntityId()}`;
    const firstUpload = await f.upload(first, "已审核", externalId), secondUpload = await f.upload(second, "已出库", externalId);
    const operations = [
      { scene: first, uploaded: firstUpload, status: "scheduled", rawStatus: "已审核", input: f.applyInput(firstUpload.view, first.items) },
      { scene: second, uploaded: secondUpload, status: "shipped", rawStatus: "已出库", input: f.applyInput(secondUpload.view, second.items) },
    ];
    const before = await f.state(), physical = await f.physicalState(), service = f.service();
    const actualRead = f.delivery.factoryErpItemsInTransaction.bind(f.delivery);
    const arrivals: Array<{ pid: number; factoryId: string; itemIds: string[] }> = [];
    let release = () => {}, ready = () => {}, rejectReady: (error: Error) => void = () => {};
    const bothArrived = new Promise<void>((done, reject) => { ready = done; rejectReady = reject; });
    const gate = new Promise<void>(done => { release = done; });
    // Setup is already committed. Pause only the two real owner entries after
    // their distinct ERP factory slots; never supply a replacement owner result.
    const owner = vi.spyOn(f.delivery, "factoryErpItemsInTransaction").mockImplementation(async (tx, context, ids, lock = false) => {
      if (lock) {
        const operation = operations.find(value => ids.length === value.scene.items.length &&
          ids.every(id => value.scene.items.some(item => item.deliveryItemId === id)));
        if (!operation || arrivals.length >= 2) throw new Error("Unexpected shared-supplier owner lock entry");
        const [connection] = await tx.execute<{ pid: number; owns_factory_slot: boolean }>(sql`select pg_backend_pid() as pid,
          exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted and mode='ExclusiveLock' and objsubid=1
            and ((classid::bigint<<32)|objid::bigint)=hashtextextended(${`factory-erp-apply:${context.tenantId}:${operation.scene.site.factory.id}`},0)) as owns_factory_slot`);
        expect(connection!.owns_factory_slot).toBe(true);
        arrivals.push({ pid: connection!.pid, factoryId: operation.scene.site.factory.id, itemIds: [...ids].sort() });
        if (arrivals.length === 2) ready();
        await gate;
      }
      return actualRead(tx, context, ids, lock);
    });
    const deadline = setTimeout(() => { release(); rejectReady(new Error("Synthetic shared-supplier dual owner barrier timed out")); }, 45_000);
    const pending = Promise.allSettled(operations.map(operation => service.apply(f.base.context, operation.uploaded.view.id, operation.input)));
    try {
      await Promise.race([bothArrived, pending.then(() => { throw new Error("Shared-supplier applications ended before both real owner entries"); })]);
      expect(arrivals).toHaveLength(2); expect(new Set(arrivals.map(row => row.pid)).size).toBe(2);
      expect(arrivals.map(row => row.factoryId).sort()).toEqual([firstSite.factory.id, secondSite.factory.id].sort());
    } finally { release(); clearTimeout(deadline); try { await pending; } finally { owner.mockRestore(); } }
    const outcomes = await pending;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") throw new Error(
        `Unexpected shared-supplier factory ${operations[index]!.scene.site.factory.id} apply failure; SQLSTATE=${pg(outcome.reason).code ?? "unavailable"}; ownerBarrier=${JSON.stringify(arrivals)}`,
        { cause: outcome.reason });
      const operation = operations[index]!, receipt = outcome.value;
      expect(receipt).toMatchObject({ importId: operation.uploaded.view.id, appliedRows: 1,
        observations: [{ rowNumber: 2, status: operation.status, disposition: "advanced" }] });
      const binding = await service.binding(f.base.context, receipt.observations[0]!.bindingId);
      expect(binding).toMatchObject({ factoryId: operation.scene.site.factory.id, sourceImportId: operation.uploaded.view.id,
        revision: 1, previousBindingId: null, releasedBy: null, state: "active", quantity: operation.scene.quantity, recordedStatus: operation.status });
      expect(binding.items.map(row => row.deliveryItemId).sort()).toEqual(operation.scene.items.map(row => row.deliveryItemId).sort());
      for (const item of binding.items) {
        const pin = operation.scene.items.find(value => value.deliveryItemId === item.deliveryItemId);
        const production = operation.scene.productions.find(value => value.order.id === item.productionOrderId);
        expect(item).toEqual({ ...pin, quantity: production!.quantity });
      }
      const observed = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpObservations).where(eq(factoryErpObservations.bindingId, binding.id)));
      expect(observed).toHaveLength(1); expect(observed[0]).toMatchObject({ applicationId: receipt.id, importId: operation.uploaded.view.id, rawStatus: operation.rawStatus });
      expect(await f.auditCount("factory_erp.import_applied", receipt.id)).toBe(1);
    }
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(2);
    const after = await f.state();
    for (const [table, added] of [["factory_erp_applications", 2], ["factory_erp_bindings", 2], ["factory_erp_binding_items", 4],
      ["factory_erp_observations", 2], ["factory_erp_application_rows", 2], ["audit_events", 2]] as const)
      expect(after[table]!.rows).toBe(before[table]!.rows + added);
    expect(after.factory_erp_binding_changes).toEqual(before.factory_erp_binding_changes);
    expect(await f.physicalState()).toEqual(physical);
  });
});
