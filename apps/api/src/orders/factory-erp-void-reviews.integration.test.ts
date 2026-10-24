import { createRequire } from "node:module";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FactoryErpVoidReviewResultSchema, type FactoryErpVoidObservationView, type ReviewFactoryErpVoid } from "@yummyai/contracts/order/factory-erp-void-review";
import { connectDatabase, factoryErpImports, factoryErpObservations, factoryErpVoidReviews, memberships,
  factoryErpRetentionContext, redactExpiredFactoryErpSources, claimFactoryErpSourcePurges, finishFactoryErpSourcePurge, withTenant, type FactoryErpSourceClaim } from "@yummyai/database";
import { FactoryErpSourcePurger } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { factoryVoidFixture, requireFactoryVoidEnvironment, voidObservationIdentity, voidReviewSha, withFactoryVoidSourceClock } from "../../../../tools/testing/factory-erp-void-reviews-fixture.js";
import { FACTORY_ERP_READ, FACTORY_ERP_WRITE } from "./factory-erp-import.service.js";
import { assertFactoryErpProofDigest, type FactoryErpDigestProofSource } from "./factory-erp-evidence.js";
import { factoryErpVoidProofRowsSql } from "./factory-erp-void-read.js";

requireFactoryVoidEnvironment("current");
function pg(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  if ("code" in error) return error as { code?: string; message?: string };
  return "cause" in error ? pg(error.cause) : {};
}
const guard = (message: string) => (error: unknown) => pg(error).code === "23514" && pg(error).message === message;

describe.sequential("factory ERP exact original void observations and operator-attested reviews", () => {
  const database = connectDatabase(), f = factoryVoidFixture(database);
  const storageRequire = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url));
  const sdk = storageRequire("@aws-sdk/client-s3") as typeof S3Sdk;
  const makeClient = () => new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true,
    region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const s3 = makeClient(), bucket = process.env.S3_PRIVATE_BUCKET!, purger = new FactoryErpSourcePurger(makeClient(), bucket);
  beforeAll(async () => { await f.initialize(); await s3.send(new sdk.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } })); });
  afterEach(async () => { vi.restoreAllMocks(); await f.base.grant(); });
  // Committed immutable evidence belongs to this exact disposable runner.
  afterAll(async () => { vi.restoreAllMocks(); f.dispose(); purger.close(); s3.destroy(); await database.client.end(); });
  type State = Awaited<ReturnType<typeof f.state>>;
  function onlyReviewDelta(before: State, after: State, count: number) {
    for (const [table, value] of Object.entries(before)) {
      if (table === "factory_erp_void_reviews" || table === "audit_events") expect(after[table]!.rows).toBe(value.rows + count);
      else expect(after[table]).toEqual(value);
    }
  }
  const source = async (id: string) => (await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpImports).where(eq(factoryErpImports.id, id))))[0]!;
  const expiry = async (ids: string[]) => (await withTenant(database.db, f.base.context, tx => tx.execute<{ at: string }>(sql`select
    to_char((max(expires_at)+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
    from factory_erp_imports where id=any(array[${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])`)))[0]!.at;
  const versions = async (key: string) => {
    const rows = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: bucket, Prefix: key })); expect(rows.IsTruncated).toBe(false);
    return [...(rows.Versions ?? []), ...(rows.DeleteMarkers ?? [])].filter(row => row.Key === key).map(row => row.VersionId).sort();
  };
  async function purgeSource(id: string) {
    const stored = await source(id), maintenance = factoryErpRetentionContext(f.base.context.tenantId);
    expect(await withTenant(database.db, maintenance, tx => redactExpiredFactoryErpSources(tx, { importId: id }))).toBe(1);
    const [ticket] = await withTenant(database.db, maintenance, tx => claimFactoryErpSourcePurges(tx, { importId: id })); expect(ticket).toBeDefined();
    const proof = await purger.purge(ticket!, { signal: AbortSignal.timeout(20_000) });
    await withTenant(database.db, maintenance, tx => finishFactoryErpSourcePurge(tx, ticket!, proof));
    expect(await versions(stored.objectKey)).toEqual([]);
  }

  it("reviews one exact void of a real cross-order whole group without replacing its successful status source or any physical fact", async () => {
    const group = await f.crossOrderScene(), scheduled = await f.observe(group.scene, "已审核"), voided = await f.observe(group.scene, "已作废", scheduled.externalId);
    const id = voided.binding.id, service = f.service(), before = await f.state(), physical = await f.physicalState();
    const detail = await service.voidObservation(f.base.context, id, voided.observationId);
    expect(detail).toMatchObject({ basis: { bindingId: id, state: "active", summary: { total: 1, pending: 1, requiresOrderHandling: 0 } },
      observation: { id: voided.observationId, importId: voided.view.id, pending: true, sourceReadable: true, latestReview: null } });
    const input = await f.reviewInput(id, voided.observationId, voided.view), result = await service.reviewVoid(f.base.context, id, input);
    expect(FactoryErpVoidReviewResultSchema.parse(result)).toMatchObject({ bindingId: id, factoryId: group.scene.site.factory.id,
      observation: voidObservationIdentity(detail.observation), source: input.source, reviewRevision: 1, previousReviewId: null,
      outcome: "confirmed_active", reasonCode: "factory_contact", provenance: "operator_attested" });
    expect(await service.voidReview(f.base.context, id, result.id)).toEqual(result);
    expect((await service.listVoidReviews(f.base.context, id, {})).items).toEqual([result]);
    const page = await service.voidObservations(f.base.context, id, { limit: 1 });
    expect(page).toMatchObject({ basis: { summary: { total: 1, pending: 0, requiresOrderHandling: 0, nextPending: null } },
      items: [{ id: voided.observationId, latestReview: result, pending: false }], nextCursor: null });
    expect((await service.binding(f.base.context, id)).recordedException).toBe("voided_requires_review");
    for (const original of [group.first, group.second]) {
      const packet = await f.delivery.get(f.base.context, original.packet.id);
      expect(packet.items).toHaveLength(1);
      expect(packet.items[0]).toMatchObject({ status: "submitted", factoryErp: { bindingId: id, status: "scheduled", exception: null,
        observationId: scheduled.observationId, importId: scheduled.view.id, rawStatus: "已审核", shippedQuantity: null,
        voidSummary: { total: 1, pending: 0, latest: { id: voided.observationId, importId: voided.view.id, latestReview: result } } } });
    }
    const [stored] = await withTenant(database.db, f.base.context, tx => tx.select().from(factoryErpVoidReviews).where(eq(factoryErpVoidReviews.id, result.id)));
    expect(stored!.requestCanonical).toBe(canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: id, input }));
    expect(stored!.requestChecksum).toBe(voidReviewSha(stored!.requestCanonical));
    expect(JSON.stringify({ input: stored!.input, result: stored!.result })).not.toContain(scheduled.externalId);
    expect(await f.auditCount("factory_erp.void_reviewed", result.id)).toBe(1);
    onlyReviewDelta(before, await f.state(), 1); expect(await f.physicalState()).toEqual(physical);
  });

  it("keeps every earlier pending void visible through paging and linear follow-up reviews while duplicate rows do not reopen and new voids do", async () => {
    const scene = await f.scene(), shipped = await f.observe(scene, "已出库"), first = await f.observe(scene, "已作废", shipped.externalId), second = await f.observe(scene, "已作废", shipped.externalId);
    const id = shipped.binding.id, service = f.service(), physical = await f.physicalState(), corrected = await f.uploadEvidence(scene, "已审核", shipped.externalId);
    const latest = await service.reviewVoid(f.base.context, id, await f.reviewInput(id, second.observationId, corrected.view, "confirmed_active", "corrected_export"));
    const page = await service.voidObservations(f.base.context, id, { limit: 1 });
    expect(page.basis.summary).toMatchObject({ total: 2, pending: 1, requiresOrderHandling: 0, latest: { id: second.observationId, pending: false }, nextPending: { id: first.observationId, pending: true } });
    expect(page.items.map(row => row.id)).toEqual([second.observationId]); expect(page.nextCursor).toBe(page.items[0]!.sequence);
    const tail = await service.voidObservations(f.base.context, id, { limit: 1, cursor: page.nextCursor! });
    expect(tail.items.map(row => row.id)).toEqual([first.observationId]); expect(tail.nextCursor).toBeNull(); expect(tail.basis.summary).toEqual(page.basis.summary);
    const followup = await service.reviewVoid(f.base.context, id, await f.reviewInput(id, first.observationId, first.view, "followup_required", "needs_factory_confirmation"));
    expect(followup).toMatchObject({ reviewRevision: 1, previousReviewId: null });
    expect((await service.voidObservations(f.base.context, id)).basis.summary.pending).toBe(1);
    const concluded = await service.reviewVoid(f.base.context, id, await f.reviewInput(id, first.observationId, first.view, "confirmed_voided", "corrected_export"));
    expect(concluded).toMatchObject({ reviewRevision: 2, previousReviewId: followup.id });
    expect((await service.voidObservations(f.base.context, id)).basis.summary).toMatchObject({ total: 2, pending: 0, requiresOrderHandling: 1, nextPending: null });
    const third = await f.observe(scene, "已作废", shipped.externalId); await f.observe(scene, "已出库", shipped.externalId);
    expect((await service.voidObservations(f.base.context, id)).basis.summary).toMatchObject({ total: 3, pending: 1, requiresOrderHandling: 1, nextPending: { id: third.observationId } });
    const incorrect = await service.reviewVoid(f.base.context, id, await f.reviewInput(id, third.observationId, corrected.view, "export_record_incorrect", "corrected_export"));
    const duplicateSource = await service.upload(f.base.context, { ...third.input, idempotencyKey: createEntityId() });
    const duplicate = await service.apply(f.base.context, duplicateSource.id, f.applyInput(duplicateSource, scene.items));
    expect(duplicate.observations[0]).toMatchObject({ observationId: third.observationId, disposition: "unchanged", status: "shipped" });
    const final = await service.voidObservations(f.base.context, id);
    expect(final.basis.summary).toMatchObject({ total: 3, pending: 0, requiresOrderHandling: 1, latest: { id: third.observationId, latestReview: incorrect } });
    const history = await service.listVoidReviews(f.base.context, id, { observationId: first.observationId, limit: 1 });
    const old = await service.listVoidReviews(f.base.context, id, { observationId: first.observationId, limit: 1, cursor: history.nextCursor! });
    expect(history.items).toEqual([concluded]); expect(old.items).toEqual([followup]); expect(old.nextCursor).toBeNull();
    expect((await service.voidReview(f.base.context, id, latest.id)).observation.id).toBe(second.observationId);
    for (const item of (await f.delivery.get(f.base.context, scene.packet.id)).items)
      expect(item).toMatchObject({ status: "submitted", factoryErp: { status: "shipped", exception: null, shippedQuantity: null, voidSummary: { requiresOrderHandling: 1 } } });
    expect(await f.physicalState()).toEqual(physical);
  });

  it("rejects wrong original observation pins, stale binding or review CAS and incompatible corrected-export sources without partial reviews", async () => {
    const scene = await f.scene(), shipped = await f.observe(scene, "已出库"), voided = await f.observe(scene, "已作废", shipped.externalId), id = shipped.binding.id;
    const input = await f.reviewInput(id, voided.observationId, voided.view), wrongHead = await f.uploadEvidence(scene, "已审核");
    const wrongQuantity = await f.uploadEvidence({ ...scene, quantity: scene.quantity + 1 }, "已审核", shipped.externalId);
    const scheduled = await f.uploadEvidence(scene, "已审核", shipped.externalId), before = await f.state();
    const invalid: ReviewFactoryErpVoid[] = [
      { ...input, expectedBindingRevision: input.expectedBindingRevision + 1 }, { ...input, expectedItemsChecksum: "d".repeat(64) },
      { ...input, expectedObservationSequence: input.expectedObservationSequence + 1 }, { ...input, expectedPreviousReviewId: createEntityId() },
      { ...input, observation: { ...input.observation, sequence: input.observation.sequence - 1 } },
      { ...input, observation: { ...input.observation, rowChecksum: "d".repeat(64) } },
      { ...input, observation: { ...input.observation, recordedAt: new Date(Date.parse(input.observation.recordedAt) + 1).toISOString() } },
      { ...input, source: { ...input.source, fileChecksum: "d".repeat(64) } },
      { ...input, source: { importId: wrongHead.view.id, rowNumber: 2, fileChecksum: wrongHead.view.fileChecksum, previewChecksum: wrongHead.view.previewChecksum } },
      { ...input, source: { importId: wrongQuantity.view.id, rowNumber: 2, fileChecksum: wrongQuantity.view.fileChecksum, previewChecksum: wrongQuantity.view.previewChecksum } },
      { ...input, outcome: "confirmed_active", reasonCode: "corrected_export" },
      { ...input, outcome: "confirmed_voided", reasonCode: "corrected_export", source: { importId: scheduled.view.id, rowNumber: 2, fileChecksum: scheduled.view.fileChecksum, previewChecksum: scheduled.view.previewChecksum } },
    ];
    for (const request of invalid) {
      await expect(f.service().reviewVoid(f.base.context, id, { ...request, idempotencyKey: createEntityId() })).rejects.toBeInstanceOf(ConflictException);
      expect(await f.state()).toEqual(before);
    }
    await expect(f.service().voidObservation(f.base.context, id, shipped.observationId)).rejects.toBeInstanceOf(NotFoundException);
    const committed = await f.service().reviewVoid(f.base.context, id, input), after = await f.state();
    await expect(f.service().reviewVoid(f.base.context, id, { ...input, idempotencyKey: createEntityId() })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(after); expect((await f.service().voidObservation(f.base.context, id, voided.observationId)).observation.latestReview).toEqual(committed);
  });

  it("keeps old reviews on a released group and never moves them through a partially overlapping correction or accepts an unexecuted stale review", async () => {
    const scene = await f.scene({ quantities: [1, 1, 1] }), original = { ...scene, items: scene.items.slice(0, 2), quantity: 2 };
    const shipped = await f.observe(original, "已出库"), voided = await f.observe(original, "已作废", shipped.externalId), id = shipped.binding.id;
    const followup = await f.service().reviewVoid(f.base.context, id, await f.reviewInput(id, voided.observationId, voided.view, "followup_required", "binding_mismatch"));
    const unsent = await f.reviewInput(id, voided.observationId, voided.view), current = await f.uploadEvidence(original, "已审核", shipped.externalId);
    const binding = await f.service().binding(f.base.context, id), physical = await f.physicalState();
    const correction = await f.service().changeBinding(f.base.context, id, f.change(binding, current.view, scene.items.slice(1)));
    const nextId = correction.replacementBindingId!, before = await f.state();
    await expect(f.service().reviewVoid(f.base.context, id, unsent)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    const old = await f.service().voidObservation(f.base.context, id, voided.observationId);
    expect(old).toMatchObject({ basis: { state: "released", summary: { total: 1, pending: 1 } }, observation: { latestReview: followup } });
    expect((await f.service().voidObservations(f.base.context, nextId)).basis.summary).toMatchObject({ total: 0, pending: 0, latest: null });
    await expect(f.service().voidObservation(f.base.context, nextId, voided.observationId)).rejects.toBeInstanceOf(NotFoundException);
    const nextScene = { ...scene, items: scene.items.slice(1), quantity: 2 }, nextVoid = await f.observe(nextScene, "已作废", shipped.externalId);
    expect(nextVoid.binding.id).toBe(nextId);
    const result = await f.service().reviewVoid(f.base.context, nextId, await f.reviewInput(nextId, nextVoid.observationId, nextVoid.view));
    expect(result.observation.id).not.toBe(voided.observationId);
    expect((await f.service().voidObservations(f.base.context, id)).basis.summary.pending).toBe(1);
    const packet = await f.delivery.get(f.base.context, scene.packet.id);
    expect(packet.items.find(item => item.id === scene.items[0]!.deliveryItemId)!.factoryErp).toMatchObject({ bindingReleased: true, status: null, historicalStatus: "shipped" });
    for (const item of packet.items.filter(value => scene.items.slice(1).some(pin => pin.deliveryItemId === value.id)))
      expect(item.factoryErp).toMatchObject({ bindingId: nextId, bindingReleased: false, status: "scheduled", exception: null, voidSummary: { total: 1, pending: 0 } });
    expect(await f.physicalState()).toEqual(physical);
  });

  it("recovers only the original actor body and key after a lost success, later review, release and real source purge without reviving private data", async () => {
    const scene = await f.scene(), shipped = await f.observe(scene, "已出库"), voided = await f.observe(scene, "已作废", shipped.externalId), id = shipped.binding.id;
    const input = await f.reviewInput(id, voided.observationId, voided.view), other = await f.actor(), physical = await f.physicalState();
    let committed: Awaited<ReturnType<ReturnType<typeof f.service>["reviewVoid"]>> | undefined;
    const lost = new Error("Synthetic committed void review response lost");
    await expect((async () => { committed = await f.service().reviewVoid(f.base.context, id, input); throw lost; })()).rejects.toBe(lost);
    if (!committed) throw new Error("Actual committed void review receipt required");
    const result = committed, before = await f.state();
    expect(await f.service().reviewVoid(f.base.context, id, input)).toEqual(result);
    await expect(f.service().reviewVoid(other, id, input)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service().reviewVoid(f.base.context, createEntityId(), input)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service().reviewVoid(f.base.context, id, { ...input, outcome: "export_record_incorrect" })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    await withFactoryVoidSourceClock(database, async set => {
      await set(await expiry([shipped.view.id, voided.view.id])); await purgeSource(shipped.view.id); await purgeSource(voided.view.id);
      expect((await f.service().voidObservation(f.base.context, id, voided.observationId)).observation).toMatchObject({ sourceReadable: false, latestReview: result });
      const expired = await f.reviewInput(id, voided.observationId, voided.view);
      await expect(f.service().reviewVoid(f.base.context, id, expired)).rejects.toBeInstanceOf(NotFoundException);
      const fresh = await f.uploadEvidence(scene, "已审核", shipped.externalId), updatedInput = await f.reviewInput(id, voided.observationId, fresh.view, "export_record_incorrect", "corrected_export");
      const updated = await f.service().reviewVoid(f.base.context, id, updatedInput);
      expect(updated).toMatchObject({ observation: input.observation, reviewRevision: 2, previousReviewId: result.id, source: updatedInput.source });
      const old = await f.service().binding(f.base.context, id), release = await f.service().changeBinding(f.base.context, id, f.change(old, fresh.view));
      expect((await f.service().binding(f.base.context, id)).releasedBy).toBe(release.id);
      const afterRelease = await f.state(); expect(await f.service().reviewVoid(f.base.context, id, input)).toEqual(result);
      expect(await f.service().reviewVoid(f.base.context, id, updatedInput)).toEqual(updated); expect(await f.state()).toEqual(afterRelease);
      await expect(f.service().reviewVoid(f.base.context, id, await f.reviewInput(id, voided.observationId, fresh.view))).rejects.toBeInstanceOf(ConflictException);
      await set(await expiry([fresh.view.id])); await purgeSource(fresh.view.id);
      const cleared = await f.state(); expect(await f.service().reviewVoid(f.base.context, id, input)).toEqual(result);
      expect(await f.service().reviewVoid(f.base.context, id, updatedInput)).toEqual(updated); expect(await f.state()).toEqual(cleared);
      expect(await f.service().voidReview(f.base.context, id, result.id)).toEqual(result);
      const history = await f.service().listVoidReviews(f.base.context, id, {});
      expect(history.items).toEqual([updated, result]); expect(JSON.stringify(history)).not.toContain(shipped.externalId);
      expect(await f.auditCount("factory_erp.void_reviewed", result.id)).toBe(1); expect(await f.auditCount("factory_erp.void_reviewed", updated.id)).toBe(1);
    });
    expect((await f.service().voidObservation(f.base.context, id, voided.observationId)).observation.sourceReadable).toBe(false);
    expect(await f.service().lifecycle(f.base.context, voided.view.id)).toMatchObject({ access: "expired", purgeStatus: "purged" });
    expect(await f.physicalState()).toEqual(physical);
  });

  it("requires current five-tenant authority before replay and rechecks actual private I/O revocation and expiry without partial reviews", async () => {
    const scene = await f.scene(), shipped = await f.observe(scene, "已出库"), voided = await f.observe(scene, "已作废", shipped.externalId), id = shipped.binding.id;
    const input = await f.reviewInput(id, voided.observationId, voided.view), before = await f.state(), realRead = f.storage.readPrivate.bind(f.storage);
    const read = vi.spyOn(f.storage, "readPrivate");
    await expect(f.service().voidObservation(f.base.foreignContext, id, voided.observationId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service().reviewVoid(f.base.foreignContext, id, input)).rejects.toBeInstanceOf(NotFoundException);
    for (const permission of FACTORY_ERP_WRITE) {
      await f.base.grant(FACTORY_ERP_WRITE.filter(value => value !== permission));
      await expect(f.service().reviewVoid(f.base.context, id, input)).rejects.toBeInstanceOf(ForbiddenError);
      if (permission === Permission.OrderWrite) expect((await f.service().voidObservations(f.base.context, id)).items[0]!.id).toBe(voided.observationId);
      else await expect(f.service().voidObservations(f.base.context, id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await f.base.grant([Permission.OrderWrite], "self", FACTORY_ERP_READ);
    await expect(f.service().reviewVoid(f.base.context, id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await f.base.grant();
    await expect(f.service().reviewVoid({ ...f.base.context, permissionScopes: { ...f.base.context.permissionScopes, [Permission.AssetRead]: "team" } }, id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await withTenant(database.db, f.base.seed(), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.base.owner.membershipId)));
    await expect(f.service().voidObservations(f.base.context, id)).rejects.toBeInstanceOf(ForbiddenError); expect(read).not.toHaveBeenCalled();
    read.mockRestore(); await f.base.grant();
    const revoked = vi.spyOn(f.storage, "readPrivate").mockImplementationOnce(async (...args) => { const bytes = await realRead(...args); await f.base.grant(FACTORY_ERP_READ); return bytes; });
    try { await expect(f.service().reviewVoid(f.base.context, id, input)).rejects.toBeInstanceOf(ForbiddenError); expect(revoked).toHaveBeenCalledTimes(1); }
    finally { revoked.mockRestore(); await f.base.grant(); }
    expect(await f.state()).toEqual(before);
    await withFactoryVoidSourceClock(database, async set => {
      const expired = vi.spyOn(f.storage, "readPrivate").mockImplementationOnce(async (...args) => { const bytes = await realRead(...args); await set(await expiry([voided.view.id])); return bytes; });
      try { await expect(f.service().reviewVoid(f.base.context, id, input)).rejects.toBeInstanceOf(NotFoundException); expect(expired).toHaveBeenCalledTimes(1); }
      finally { expired.mockRestore(); }
      expect(await f.state()).toEqual(before);
    });
    const result = await f.service().reviewVoid(f.base.context, id, input), committed = await f.state(); await f.base.grant(FACTORY_ERP_READ);
    await expect(f.service().reviewVoid(f.base.context, id, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.service().voidReview(f.base.context, id, result.id)).toEqual(result); expect(await f.state()).toEqual(committed);
  });

  it("serializes a reviewed original void against a real new observation and an original release using verified advisory waiters", async () => {
    const scene = await f.scene(), shipped = await f.observe(scene, "已出库"), voided = await f.observe(scene, "已作废", shipped.externalId), id = shipped.binding.id;
    const physical = await f.physicalState(), service = f.service();
    async function queued(first: () => Promise<unknown>, second: () => Promise<unknown>) {
      let release = () => {}, ready = () => {}, rejectReady: (error: Error) => void = () => {}, blockerPid = 0;
      const locked = new Promise<void>((done, reject) => { ready = done; rejectReady = reject; });
      const gate = new Promise<void>(done => { release = done; });
      const deadline = setTimeout(() => { release(); rejectReady(new Error("Synthetic void review lock barrier timed out")); }, 45_000);
      const blocker = withTenant(database.db, f.base.context, async tx => {
        blockerPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`factory-erp-apply:${f.base.context.tenantId}:${scene.site.factory.id}`},0))`);
        ready(); await gate;
      });
      let firstPid = 0, waiters: Array<{ pid: number; blockers: number[] }> = [];
      const wait = async (count: number) => expect.poll(async () => {
        waiters = await database.client.unsafe<Array<{ pid: number; blockers: number[] }>>(
          "select pid,pg_blocking_pids(pid) as blockers from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock%' order by pid", [blockerPid]);
        return waiters.length;
      }, { timeout: 15_000 }).toBe(count);
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await Promise.race([locked, blocker.then(() => { throw new Error("Synthetic advisory blocker exited before readiness"); })]);
        const leading = Promise.allSettled([first()]); pending = leading;
        await wait(1); firstPid = waiters[0]!.pid;
        const following = Promise.allSettled([second()]); pending = Promise.all([leading, following]).then(([a, b]) => [...a, ...b]);
        await wait(2); expect(new Set(waiters.map(row => row.pid)).size).toBe(2); expect(waiters.map(row => row.pid)).toContain(firstPid);
        for (const row of waiters) expect(row.blockers).toContain(blockerPid);
      } finally { release(); clearTimeout(deadline); try { await blocker; } finally { if (pending) await pending; } }
      if (!pending) throw new Error("Actual concurrent void owner requests missing");
      const outcomes = await pending;
      for (const outcome of outcomes) if (outcome.status === "rejected" && !(outcome.reason instanceof ConflictException))
        throw new Error(`Unexpected void concurrency SQLSTATE=${pg(outcome.reason).code ?? "unavailable"}; barrier=${JSON.stringify({ blockerPid, firstPid, waiters })}`, { cause: outcome.reason });
      return outcomes;
    }
    const request = await f.reviewInput(id, voided.observationId, voided.view), next = await f.uploadEvidence(scene, "已作废", shipped.externalId);
    const reviewedFirst = await queued(() => service.reviewVoid(f.base.context, id, request), () => service.apply(f.base.context, next.view.id, f.applyInput(next.view, scene.items)));
    expect(reviewedFirst.map(row => row.status)).toEqual(["fulfilled", "fulfilled"]);
    const page = await service.voidObservations(f.base.context, id);
    expect(page.basis.summary).toMatchObject({ total: 2, pending: 1, latest: { pending: true }, nextPending: { importId: next.view.id } });
    expect((await service.voidObservation(f.base.context, id, voided.observationId)).observation.pending).toBe(false);
    const nextVoid = page.basis.summary.nextPending!, unsent = await f.reviewInput(id, nextVoid.id, next.view), binding = await service.binding(f.base.context, id);
    const release = f.change(binding, next.view), releasedFirst = await queued(() => service.changeBinding(f.base.context, id, release), () => service.reviewVoid(f.base.context, id, unsent));
    expect(releasedFirst[0]!.status).toBe("fulfilled"); expect(releasedFirst[1]!.status).toBe("rejected");
    if (releasedFirst[1]!.status === "rejected") expect(releasedFirst[1]!.reason).toBeInstanceOf(ConflictException);
    expect((await service.voidObservations(f.base.context, id)).basis).toMatchObject({ state: "released", summary: { total: 2, pending: 1 } });
    expect((await service.listVoidReviews(f.base.context, id, {})).items).toHaveLength(1);
    expect(await f.physicalState()).toEqual(physical);
  });

  it("requires a real void, full transaction birth, exact immutable receipt and same-transaction audit even after a successful early constraint flush", async () => {
    const scene = await f.scene(), shipped = await f.observe(scene, "已出库"), voided = await f.observe(scene, "已作废", shipped.externalId), id = shipped.binding.id;
    const input = await f.reviewInput(id, voided.observationId, voided.view), before = await f.state(), physical = await f.physicalState();
    const rollback = new Error("Synthetic complete raw void control rolls back"); let birthVerified = false, earlyFlushed = false, secondAttempted = false;
    type Mode = "control" | "request" | "nonvoid" | "source" | "previous" | "result" | "no_audit" | "early_second" | "old_audit";
    const staleAuditId = createEntityId();
    async function raw(mode: Mode) {
      return withTenant(database.db, f.base.context, async tx => {
        let request: ReviewFactoryErpVoid = { ...input, idempotencyKey: createEntityId() };
        if (mode === "nonvoid") {
          const [observed] = await tx.select().from(factoryErpObservations).where(eq(factoryErpObservations.id, shipped.observationId));
          request = { ...request, observation: { id: observed!.id, sequence: observed!.sequence, importId: shipped.view.id, rowNumber: observed!.rowNumber,
            rowChecksum: observed!.rowChecksum, fileChecksum: shipped.view.fileChecksum, previewChecksum: shipped.view.previewChecksum, recordedAt: observed!.createdAt.toISOString() } };
        }
        if (mode === "source") request = { ...request, reasonCode: "corrected_export" };
        if (mode === "previous") request = { ...request, expectedPreviousReviewId: createEntityId() };
        const reviewId = mode === "old_audit" ? staleAuditId : createEntityId(), createdAt = new Date();
        const canonical = canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: id, input: request });
        const result = FactoryErpVoidReviewResultSchema.parse({ id: reviewId, bindingId: id, factoryId: scene.site.factory.id,
          observation: request.observation, source: request.source, originalBindingRevision: request.expectedBindingRevision,
          originalItemsChecksum: request.expectedItemsChecksum, originalObservationSequence: request.expectedObservationSequence,
          reviewRevision: request.expectedPreviousReviewId ? 2 : 1, previousReviewId: request.expectedPreviousReviewId,
          outcome: request.outcome, reasonCode: request.reasonCode, provenance: "operator_attested", requestChecksum: voidReviewSha(canonical), createdAt: createdAt.toISOString() });
        await tx.insert(factoryErpVoidReviews).values({ id: reviewId, tenantId: f.base.context.tenantId, factoryId: scene.site.factory.id,
          bindingId: id, observationId: request.observation.id, reviewRevision: result.reviewRevision, previousReviewId: request.expectedPreviousReviewId,
          sourceImportId: request.source.importId, sourceRowNumber: request.source.rowNumber, outcome: request.outcome,
          reasonCode: mode === "request" ? "corrected_export" : request.reasonCode, idempotencyKey: request.idempotencyKey,
          requestCanonical: canonical, requestChecksum: result.requestChecksum, input: request,
          result: mode === "result" ? { ...result, createdAt: new Date(createdAt.getTime() + 1).toISOString() } : result,
          createdBy: f.base.context.userId, creationTransactionId: "1", createdAt });
        const [born] = await tx.execute<{ actual: string; current: string }>(sql`select creation_transaction_id as actual,pg_current_xact_id()::text as current from factory_erp_void_reviews where id=${reviewId}::uuid`);
        expect(born!.actual).toBe(born!.current); expect(born!.actual).not.toBe("1"); birthVerified = true;
        if (mode !== "no_audit") await f.base.audit.recordInTransaction(tx, f.base.context, { action: "factory_erp.void_reviewed", resourceType: "factory_erp_void_review",
          resourceId: reviewId, result: "success", metadata: { bindingId: id, observationId: request.observation.id, reviewRevision: result.reviewRevision, outcome: request.outcome } });
        await tx.execute(sql`set constraints all immediate`);
        if (mode === "early_second") {
          earlyFlushed = true; await tx.execute(sql`set constraints all deferred`);
          const nextInput = { ...request, expectedPreviousReviewId: reviewId, idempotencyKey: createEntityId() }, nextId = createEntityId(), at = new Date();
          const nextCanonical = canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: id, input: nextInput });
          const nextResult = { ...result, id: nextId, reviewRevision: 2, previousReviewId: reviewId, requestChecksum: voidReviewSha(nextCanonical), createdAt: at.toISOString() };
          secondAttempted = true;
          await tx.insert(factoryErpVoidReviews).values({ id: nextId, tenantId: f.base.context.tenantId, factoryId: scene.site.factory.id, bindingId: id,
            observationId: request.observation.id, reviewRevision: 2, previousReviewId: reviewId, sourceImportId: nextInput.source.importId,
            sourceRowNumber: nextInput.source.rowNumber, outcome: nextInput.outcome, reasonCode: nextInput.reasonCode,
            idempotencyKey: nextInput.idempotencyKey, requestCanonical: nextCanonical, requestChecksum: nextResult.requestChecksum, input: nextInput, result: nextResult,
            createdBy: f.base.context.userId, creationTransactionId: sql`pg_current_xact_id()::text`, createdAt: at });
          await f.base.audit.recordInTransaction(tx, f.base.context, { action: "factory_erp.void_reviewed", resourceType: "factory_erp_void_review", resourceId: nextId,
            result: "success", metadata: { bindingId: id, observationId: request.observation.id, reviewRevision: 2, outcome: nextInput.outcome } });
          await tx.execute(sql`set constraints all immediate`);
        }
        throw rollback;
      });
    }
    await expect(raw("control")).rejects.toBe(rollback); expect(birthVerified).toBe(true); expect(await f.state()).toEqual(before);
    const rejected: Array<[Mode, string]> = [["request", "request_invalid"], ["nonvoid", "basis_changed"], ["source", "source_required"],
      ["previous", "previous_changed"], ["result", "result_invalid"], ["no_audit", "audit_required"], ["early_second", "birth_required"]];
    for (const [mode, suffix] of rejected) {
      await expect(raw(mode)).rejects.toSatisfy(guard(`factory_erp_void_review_${suffix}`)); expect(await f.state()).toEqual(before);
    }
    expect(earlyFlushed).toBe(true); expect(secondAttempted).toBe(true);
    await f.base.audit.record(f.base.context, { action: "factory_erp.void_reviewed", resourceType: "factory_erp_void_review", resourceId: staleAuditId,
      result: "success", metadata: { bindingId: id, observationId: voided.observationId, synthetic: "unlinked-prior-transaction-attack" } });
    const afterOldAudit = await f.state();
    await expect(raw("old_audit")).rejects.toSatisfy(guard("factory_erp_void_review_sealed")); expect(await f.state()).toEqual(afterOldAudit);
    const realAudit = f.base.audit.recordInTransaction.bind(f.base.audit), failure = new Error("Synthetic void audit rollback"), saw = { born: false };
    const audit = vi.spyOn(f.base.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      const saved = await realAudit(tx, context, event);
      if (event.action === "factory_erp.void_reviewed") {
        const [row] = await tx.select().from(factoryErpVoidReviews).where(eq(factoryErpVoidReviews.id, event.resourceId!));
        saw.born = row?.observationId === voided.observationId; throw failure;
      }
      return saved;
    });
    try { await expect(f.service().reviewVoid(f.base.context, id, input)).rejects.toBe(failure); expect(saw.born).toBe(true); }
    finally { audit.mockRestore(); }
    expect(await f.state()).toEqual(afterOldAudit);
    const result = await f.service().reviewVoid(f.base.context, id, input), committed = await f.state(); onlyReviewDelta(afterOldAudit, committed, 1);
    await expect(withTenant(database.db, f.base.context, tx => tx.execute(sql`update factory_erp_void_reviews set outcome='confirmed_voided' where id=${result.id}::uuid`)))
      .rejects.toSatisfy(error => pg(error).code === "42501");
    await expect(withTenant(database.db, f.base.context, tx => tx.execute(sql`delete from factory_erp_void_reviews where id=${result.id}::uuid`)))
      .rejects.toSatisfy(error => pg(error).code === "42501");
    const [visibility] = await withTenant(database.db, f.base.foreignContext, tx => tx.execute<{ count: number; forced: boolean; app: boolean }>(sql`select count(*)::int as count,
      (select relforcerowsecurity from pg_class where oid='factory_erp_void_reviews'::regclass) as forced,current_user='yummyai_app' as app from factory_erp_void_reviews where id=${result.id}::uuid`));
    expect(visibility).toEqual({ count: 0, forced: true, app: true }); expect(await f.state()).toEqual(committed); expect(await f.physicalState()).toEqual(physical);
  });
  it("authenticates a real 5000-row Chinese and null source through a bounded database canonical digest and rejects changed non-target claims or envelope pins", async () => {
    const scene = await f.scene({ quantities: [1] }), externalId = `SYNTHETIC-DIGEST-${createEntityId()}`;
    const statuses = ["已审核", "已出库", "已作废", "待人工确认"];
    const rows = Array.from({ length: 5000 }, (_, index) => {
      const row = f.rawRow(1, index === 4999 ? "已作废" : statuses[index % statuses.length]!, index === 4999 ? externalId : `合成原表编号-${index}`);
      row[1] = `合成中文来源 ${index} 不是真实订单`; row[4] = ""; row[5] = "合成双面抱枕"; row[6] = "1"; return row;
    });
    const upload = await f.service().upload(f.base.context, f.uploadInput(scene.site.factory.id, rows));
    const target = await f.service().get(f.base.context, upload.id, { offset: 4999, limit: 1 });
    expect(target.rowCount).toBe(5000); expect(target.rows).toHaveLength(1); expect(target.rows[0]!.rowNumber).toBe(5001);
    const selected = f.applyInput(target, scene.items), input = { ...selected, rows: selected.rows.map(row => ({ ...row, rowNumber: 5001 })) };
    const applied = await f.service().apply(f.base.context, target.id, input), observation = applied.observations[0]!;
    const stored = await source(target.id); expect(stored.sourceClaims).toHaveLength(5000);
    expect(new Set(stored.sourceClaims.map(claim => claim.rawStatus))).toEqual(new Set(["已审核", "已出库", "已作废", null]));
    const fullDigest = voidReviewSha(canonicalJson(stored.sourceClaims));
    const envelope = f.base.vault.withSecret(stored.sourceProof, text => JSON.parse(text) as Record<string, unknown>);
    expect(envelope).toEqual({ version: 1, tenantId: stored.tenantId, importId: stored.id, factoryId: stored.factoryId,
      fileChecksum: stored.fileChecksum, previewChecksum: stored.previewChecksum, claimsChecksum: fullDigest });
    type ProofRow = { value: FactoryErpVoidObservationView; sourceProof: FactoryErpDigestProofSource; sourceClaim: FactoryErpSourceClaim;
      sourceClaimCount: number; bindingKey: string; bindingQuantity: number; bindingFactoryId: string };
    const baseline = await f.state(), physical = await f.physicalState();
    const proofRows = await withTenant(database.db, f.base.context, tx => tx.execute<ProofRow>(factoryErpVoidProofRowsSql(
      sql`${f.base.context.tenantId}::uuid`, sql`${observation.bindingId}::uuid`, { observationId: observation.observationId, limit: 1 })));
    expect(proofRows).toHaveLength(1); const proof = proofRows[0]!;
    expect(proof.sourceProof.claimsChecksum).toBe(fullDigest); expect(proof.sourceClaimCount).toBe(1);
    expect(proof.sourceClaim).toEqual(stored.sourceClaims[4999]); expect(proof.sourceClaim.rowNumber).toBe(5001);
    expect(proof.sourceClaim.rawStatus).toBe("已作废"); expect(proof.bindingQuantity).toBe(1); expect(proof.bindingFactoryId).toBe(stored.factoryId);
    expect(() => assertFactoryErpProofDigest(f.base.vault, proof.sourceProof)).not.toThrow();
    const transported = JSON.stringify(proofRows), fullBytes = Buffer.byteLength(JSON.stringify(stored.sourceClaims));
    expect(transported).not.toContain('"sourceClaims"'); expect(Buffer.byteLength(transported)).toBeLessThan(8192);
    expect(Buffer.byteLength(transported)).toBeLessThan(fullBytes / 100);
    expect((await f.service().voidObservation(f.base.context, observation.bindingId, observation.observationId)).observation)
      .toMatchObject({ id: observation.observationId, rowNumber: 5001, sourceReadable: true, pending: true, latestReview: null });
    expect((await f.service().voidObservations(f.base.context, observation.bindingId, { limit: 1 })).items.map(row => row.id)).toEqual([observation.observationId]);
    // These are SELECT parameter copies only. No persisted immutable source,
    // claim, proof or observation is modified or replaced with a forged control.
    const copiedDigest = async (claims: FactoryErpSourceClaim[]) => {
      const [value] = await withTenant(database.db, f.base.context, tx => tx.execute<{ claimsChecksum: string; matches: number }>(sql`
        with source_copy as materialized (select ${JSON.stringify(claims)}::jsonb as claims)
        select encode(sha256(convert_to(invoice_reconciliation_canonical(claims),'UTF8')),'hex') as "claimsChecksum",
          (select count(*)::int from jsonb_array_elements(claims) c(value) where c.value->>'rowNumber'='5001') as matches from source_copy`));
      return value!;
    };
    expect(await copiedDigest(stored.sourceClaims)).toEqual({ claimsChecksum: fullDigest, matches: 1 });
    const changedElsewhere = stored.sourceClaims.map((claim, index) => index === 0 ? { ...claim, rawStatus: "已出库" as const } : claim);
    const copies = [changedElsewhere, [...stored.sourceClaims].reverse(), stored.sourceClaims.slice(1), [...stored.sourceClaims, stored.sourceClaims[4999]!]];
    for (const [index, claims] of copies.entries()) {
      const copied = await copiedDigest(claims); expect(copied.claimsChecksum).not.toBe(fullDigest);
      expect(copied.matches).toBe(index === 3 ? 2 : 1);
      expect(() => assertFactoryErpProofDigest(f.base.vault, { ...proof.sourceProof, claimsChecksum: copied.claimsChecksum })).toThrow(ConflictException);
    }
    const headers: FactoryErpDigestProofSource[] = [
      { ...proof.sourceProof, id: createEntityId() }, { ...proof.sourceProof, tenantId: f.base.foreignContext.tenantId },
      { ...proof.sourceProof, factoryId: createEntityId() }, { ...proof.sourceProof, fileChecksum: "c".repeat(64) },
      { ...proof.sourceProof, previewChecksum: "d".repeat(64) }, { ...proof.sourceProof, claimsChecksum: "e".repeat(64) },
    ];
    for (const changed of headers) expect(() => assertFactoryErpProofDigest(f.base.vault, changed)).toThrow(ConflictException);
    // Complete AEAD envelope equality is required, including version and exact
    // membership, even when a copied envelope is independently authenticated.
    const { claimsChecksum: omitted, ...missingMember } = envelope; expect(omitted).toBe(fullDigest);
    for (const changed of [{ ...envelope, version: 2 }, { ...envelope, unexpectedMember: true }, missingMember])
      expect(() => assertFactoryErpProofDigest(f.base.vault, { ...proof.sourceProof, sourceProof: f.base.vault.encrypt(canonicalJson(changed)) })).toThrow(ConflictException);
    expect(await f.state()).toEqual(baseline); expect(await f.physicalState()).toEqual(physical);
  });
});
