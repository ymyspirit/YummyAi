import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { assetFiles, creativeDesignBatches, creativeDesignCandidates, withTenant } from "@yummyai/database";
import { CreativeResponseAdoptionCommandSchema, CreativeResponseAdoptionReceiptSchema, CreativeResponseAdoptionRequestViewSchema,
  CreativeResponseAdoptionWorkspaceSchema } from "@yummyai/contracts/harness/creative-response-adoption";
import type { Storage } from "@yummyai/storage";
import { ClamAvScanner } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireCreativeResponseAdoptionEnvironment } from "../../../../tools/testing/creative-response-adoption-environment.mjs";
import { HttpPodArtworkGateway } from "../../../worker/src/processors/pod-artwork.http-gateway.js";
import { HttpStudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { adoptionFixtureSha, createCreativeResponseAdoptionFixture, type AdoptionSeed } from "./creative-response-adoption.test-fixture.js";

// Reject before beforeEach constructs any database, object-store or scanner client.
requireCreativeResponseAdoptionEnvironment();

type Fixture = Awaited<ReturnType<typeof createCreativeResponseAdoptionFixture>>;
const error = (code: string) => ({ status: 409, code });
const command = (basis: string) => CreativeResponseAdoptionCommandSchema.parse({ requestId: randomUUID(), expectedBasis: basis, acknowledgeReviewRequired: true });

describe("original terminal candidate response adoption through its real owner", () => {
  let f: Fixture;
  let processorCalls = 0, studioCalls = 0;
  beforeEach(async () => {
    processorCalls = 0; studioCalls = 0;
    vi.spyOn(HttpPodArtworkGateway.prototype, "execute").mockImplementation(async () => { processorCalls++; throw new Error("adoption_test_forbidden_processor_call"); });
    vi.spyOn(HttpStudioGateway.prototype, "generate").mockImplementation(async () => { studioCalls++; throw new Error("adoption_test_forbidden_model_call"); });
    f = await createCreativeResponseAdoptionFixture();
  });
  afterEach(async () => {
    const failures: unknown[] = [];
    if (f) try { await f.close(); } catch (cause) { failures.push(cause); }
    try {
      if (f) expect(f.counts.forbiddenDispatches).toBe(0);
      expect(processorCalls).toBe(0); expect(studioCalls).toBe(0);
    } catch (cause) { failures.push(cause); }
    vi.restoreAllMocks();
    if (failures.length) throw new AggregateError(failures, "adoption_test_teardown_failed");
  });

  async function workspace(seed: AdoptionSeed) {
    return CreativeResponseAdoptionWorkspaceSchema.parse(await f.adoption.workspace(await f.current(), seed.executionId));
  }
  async function unchangedOriginal(seed: AdoptionSeed, before: Awaited<ReturnType<Fixture["facts"]>>, archived?: Awaited<ReturnType<Fixture["archive"]>>) {
    const after = await f.facts(seed);
    expect(after.role).toBe("yummyai_app"); expect(after.execution).toEqual(before.execution); expect(after.budget).toEqual(before.budget);
    expect(after.counts.originalDispatches).toBe(before.counts.originalDispatches);
    expect(after.versions).toEqual(before.versions);
    if (archived) expect(await f.archive(seed)).toEqual(archived);
    return after;
  }

  it.each(["failed", "uncertain"] as const)("adopts the %s original into generated unverified owner bytes without rewriting its terminal or fees", async phase => {
    const seed = await f.seed({ phase }), before = await f.facts(seed), archived = await f.archive(seed);
    const snapshot = await workspace(seed);
    expect(snapshot).toMatchObject({ executionId: seed.executionId, candidateId: seed.candidateId, originalPhase: phase,
      canInspectOriginal: true, canAdopt: true, noNewModelCall: true, resultRequiresReview: true, requests: [] });
    expect(snapshot.basis).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.source).toMatchObject({ responseChecksum: seed.checkpoint.receipt.responseChecksum, originalCostUsd: "0.01234567", providerInvoiceVerified: false });
    const readsBefore = f.counts.adoptionReads, writesBefore = f.counts.adoptionWrites;
    const preview = await f.adoption.preview(await f.current(), seed.executionId, snapshot.basis!);
    expect(Buffer.from(preview.bytes)).toEqual(seed.image); expect(preview.mediaType).toBe("image/png");
    expect(preview.basis).toBe(snapshot.basis); expect(preview.responseChecksum).toBe(seed.checkpoint.receipt.responseChecksum);
    expect(preview.artifactChecksum).toBe(adoptionFixtureSha(seed.image));
    expect(preview.artifactChecksum).not.toBe(preview.responseChecksum);
    expect(f.counts.adoptionReads).toBeGreaterThan(readsBefore); expect(f.counts.adoptionWrites).toBe(writesBefore);
    const previewed = await unchangedOriginal(seed, before, archived);
    expect(previewed.adoptions).toEqual(before.adoptions); expect(previewed.candidates).toEqual(before.candidates);
    const scan = vi.spyOn(ClamAvScanner.prototype, "scan"); // Observe the actual ClamAV implementation, not a clean-result substitute.
    const request = command(snapshot.basis!);
    const adopted = CreativeResponseAdoptionRequestViewSchema.parse(await f.adoption.adopt(await f.current(), seed.executionId, request));
    expect(adopted).toMatchObject({ executionId: seed.executionId, requestId: request.requestId, command: request, status: "committed", attempts: 1,
      leaseActive: false, canRetry: false, artifactCleanup: "registered" });
    const receipt = CreativeResponseAdoptionReceiptSchema.parse(adopted.receipt);
    expect(receipt).toMatchObject({ executionId: seed.executionId, candidateId: seed.candidateId, originalPhase: phase,
      inputFingerprint: before.execution!.inputFingerprint, responseChecksum: before.execution!.responseChecksum,
      encryptedChecksum: before.execution!.encryptedChecksum, originalCostUsd: "0.01234567", disposition: "generated",
      rightsStatus: "unverified", approval: "review_required", artifact: { checksumSha256: adoptionFixtureSha(seed.image), width: 240, height: 160 } });
    expect(scan).toHaveBeenCalled();
    const after = await unchangedOriginal(seed, before, archived);
    expect(after.candidates).toHaveLength(1); expect(after.versions).toHaveLength(0);
    expect(after.candidates[0]).toMatchObject({ id: seed.candidateId, status: "generated", assetId: receipt.artifact.assetId });
    const file = after.assets.find(asset => asset.id === receipt.artifact.assetId);
    expect(file).toMatchObject({ rightsStatus: "unverified", aiGenerated: true, checksumSha256: receipt.artifact.checksumSha256, assetDomain: "authorized" });
    expect(Buffer.from(await f.storage.readPrivate(await f.current(), { ...file!, assetDomain: "authorized" }, { requiredDomain: "authorized" }))).toEqual(seed.image);
    const beforeLookup = { ...f.counts };
    expect(await f.adoption.lookup(await f.current(), seed.executionId, request.requestId)).toEqual(adopted);
    expect(f.counts).toEqual(beforeLookup);
  });

  it("retains unknown cost and its occupied original budget after successful local adoption", async () => {
    const seed = await f.seed({ phase: "uncertain", costUsd: null }), before = await f.facts(seed), archived = await f.archive(seed);
    expect(before.execution!.receipt!.costUsd).toBeNull(); expect(before.budget).toHaveLength(1);
    expect(before.budget[0]).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
    const snapshot = await workspace(seed), request = command(snapshot.basis!);
    const adopted = await f.adoption.adopt(await f.current(), seed.executionId, request);
    expect(adopted.receipt!.originalCostUsd).toBeNull(); await unchangedOriginal(seed, before, archived);
  });

  it.each(["missing", "wrong-execution", "wrong-receipt", "expired", "purged"] as const)("rejects a genuinely %s original archive without manufacturing a candidate result", async archive => {
    const seed = await f.seed({ archive }), before = await f.facts(seed);
    const snapshot = await workspace(seed), writes = f.counts.adoptionWrites;
    if (archive === "expired" || archive === "purged") {
      expect(snapshot.canAdopt).toBe(false); expect(snapshot.canInspectOriginal).toBe(false);
      expect(snapshot.source.archiveState).toBe(archive);
    } else {
      await expect(f.adoption.preview(await f.current(), seed.executionId, snapshot.basis!))
        .rejects.toMatchObject(error(archive === "missing" ? "CREATIVE_ADOPTION_ARCHIVE_UNAVAILABLE" : "CREATIVE_ADOPTION_ARCHIVE_INVALID"));
    }
    expect(f.counts.adoptionWrites).toBe(writes);
    const after = await unchangedOriginal(seed, before);
    expect(after.candidates).toEqual(before.candidates); expect(after.assets).toEqual(before.assets);
  });

  it.each([Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview, Permission.AssetRead, Permission.AssetWrite])("rechecks current %s independently of the original ceiling", async permission => {
    const seed = await f.seed(), before = await f.facts(seed), snapshot = await workspace(seed), context = await f.current();
    await f.grant(f.initial.permissions.filter(value => value !== permission));
    await expect(f.adoption.adopt(context, seed.executionId, command(snapshot.basis!))).rejects.toMatchObject({ status: 403 });
    if (permission === Permission.DesignRead || permission === Permission.AssetRead) {
      await expect(f.adoption.workspace(context, seed.executionId)).rejects.toMatchObject({ status: 403 });
    } else expect(await f.adoption.workspace(context, seed.executionId)).toMatchObject({ basis: null, canInspectOriginal: false, canAdopt: false });
    await f.restorePermissions();
    const after = await unchangedOriginal(seed, before); expect(after.candidates).toEqual(before.candidates); expect(after.assets).toEqual(before.assets);
  });

  it("rejects another applicant with tenant-wide rights and a cross-tenant original without exposing archive bytes", async () => {
    const seed = await f.seed(), snapshot = await workspace(seed), before = await f.facts(seed);
    const peer = await f.base.actor(f.identity.tenantId, "tenant"), outside = await f.base.actor();
    const reads = f.counts.adoptionReads;
    await expect(f.adoption.adopt(await f.current(peer), seed.executionId, command(snapshot.basis!))).rejects.toMatchObject(error("CREATIVE_ADOPTION_BLOCKED"));
    await expect(f.adoption.workspace(await f.current(outside), seed.executionId)).rejects.toMatchObject({ status: 404 });
    expect(f.counts.adoptionReads).toBe(reads); await unchangedOriginal(seed, before);
  });

  it("reuses one immutable adoption under real concurrent same-key requests and rejects changed request identity", async () => {
    const seed = await f.seed(), snapshot = await workspace(seed), request = command(snapshot.basis!), before = await f.facts(seed);
    const held = f.hold("read"), context = await f.current();
    const first = f.adoption.adopt(context, seed.executionId, request);
    try {
      await held.entered;
      const second = await f.adoption.adopt(context, seed.executionId, request);
      expect(second).toMatchObject({ executionId: seed.executionId, requestId: request.requestId, command: request, status: "processing", attempts: 1, leaseActive: true });
      held.clear();
      const committed = await first;
      expect(committed.id).toBe(second.id); expect(committed.status).toBe("committed");
      const reads = f.counts.adoptionReads, writes = f.counts.adoptionWrites;
      expect(await f.adoption.adopt(context, seed.executionId, request)).toEqual(committed);
      expect(f.counts.adoptionReads).toBe(reads); expect(f.counts.adoptionWrites).toBe(writes);
      await expect(f.adoption.adopt(context, seed.executionId, { ...request, expectedBasis: "f".repeat(64) })).rejects.toMatchObject({ status: 409 });
      await expect(f.adoption.adopt(context, seed.executionId, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
      expect((await workspace(seed)).requests).toHaveLength(1); await unchangedOriginal(seed, before);
    } finally { held.clear(); await first.catch(() => undefined); }
  });

  it.each(["revoke", "cancel"] as const)("blocks final owner adoption when %s occurs during actual private IO", async change => {
    const seed = await f.seed(), snapshot = await workspace(seed), request = command(snapshot.basis!), before = await f.facts(seed), archived = await f.archive(seed);
    const context = await f.current(), held = f.hold("put");
    const operation = f.adoption.adopt(context, seed.executionId, request);
    try {
      await held.entered;
      if (change === "revoke") await f.grant(f.initial.permissions.filter(value => value !== Permission.AssetWrite));
      else await f.pod.cancelDesignBatch(context, seed.batchId);
      held.clear();
      await expect(operation).rejects.toMatchObject(error("CREATIVE_ADOPTION_BLOCKED"));
      await f.restorePermissions();
      const after = await unchangedOriginal(seed, before, archived);
      expect(after.candidates[0]!.assetId).toBeNull(); expect(after.assets).toEqual(before.assets);
      const recovered = await f.adoption.lookup(await f.current(), seed.executionId, request.requestId);
      expect(recovered).toMatchObject({ command: request, status: "prepared", receipt: null, leaseActive: false, errorCode: "CREATIVE_ADOPTION_BLOCKED" });
      if (change === "cancel") expect(after.batch!.status).toBe("cancelled");
    } finally { held.clear(); await operation.catch(() => undefined); await f.restorePermissions(); }
  });

  it("retains the original candidate and source when current reference rights are withdrawn", async () => {
    const ref = await f.reference(), seed = await f.seed({ referenceAssetIds: [ref.id] });
    const before = await f.facts(seed), snapshot = await workspace(seed), context = await f.current();
    await withTenant(f.database.db, context, tx => tx.update(assetFiles).set({ rightsStatus: "rejected" }).where(eq(assetFiles.id, ref.id)));
    await expect(f.adoption.adopt(context, seed.executionId, command(snapshot.basis!))).rejects.toMatchObject(error("CREATIVE_ADOPTION_BLOCKED"));
    const after = await unchangedOriginal(seed, before);
    expect(after.candidates).toEqual(before.candidates); expect(after.candidates[0]!.assetId).toBeNull();
  });

  it("keeps a failed upload's exact adoption manifest and retries only that original key without another model submission", async () => {
    const seed = await f.seed(), snapshot = await workspace(seed), request = command(snapshot.basis!), before = await f.facts(seed), archived = await f.archive(seed);
    let lost = false;
    const loseAcknowledgement = new Proxy(f.storage, { get(target, key) {
      if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
        const stored = await target.putPrivate(...args); if (!lost) { lost = true; throw new Error("synthetic_adoption_artifact_ack_lost"); } return stored;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(f.service(loseAcknowledgement).adopt(await f.current(), seed.executionId, request))
      .rejects.toMatchObject(error("CREATIVE_ADOPTION_ARTIFACT_IO_FAILED"));
    const pending = await f.adoption.lookup(await f.current(), seed.executionId, request.requestId);
    expect(pending).toMatchObject({ command: request, status: "prepared", attempts: 1, receipt: null, errorCode: "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED" });
    const afterFailure = await unchangedOriginal(seed, before, archived);
    expect(afterFailure.candidates).toEqual(before.candidates); expect(afterFailure.assets).toEqual(before.assets);
    const committed = await f.adoption.adopt(await f.current(), seed.executionId, request);
    expect(committed).toMatchObject({ id: pending!.id, status: "committed", attempts: 2, requestId: request.requestId });
    await unchangedOriginal(seed, before, archived);
    expect((await f.adoption.cancel(await f.current(), seed.executionId, committed.id, { requestId: request.requestId })).receipt).toEqual(committed.receipt);
  });

  it("cancels a prepared local attempt without erasing original history or permitting a cancelled request to write", async () => {
    const seed = await f.seed({ archive: "missing" }), snapshot = await workspace(seed), request = command(snapshot.basis!), before = await f.facts(seed);
    await expect(f.adoption.adopt(await f.current(), seed.executionId, request)).rejects.toMatchObject(error("CREATIVE_ADOPTION_ARCHIVE_UNAVAILABLE"));
    const prepared = await f.adoption.lookup(await f.current(), seed.executionId, request.requestId);
    expect(prepared).toMatchObject({ status: "prepared", canCancel: true });
    const cancelled = await f.adoption.cancel(await f.current(), seed.executionId, prepared!.id, { requestId: request.requestId });
    expect(cancelled).toMatchObject({ id: prepared!.id, status: "cancelled", receipt: null, canRetry: false, canCancel: false });
    expect(await f.adoption.cancel(await f.current(), seed.executionId, prepared!.id, { requestId: request.requestId })).toEqual(cancelled);
    await expect(f.adoption.adopt(await f.current(), seed.executionId, request)).rejects.toMatchObject({ status: 409 });
    const after = await unchangedOriginal(seed, before); expect(after.candidates).toEqual(before.candidates);
  });

  it("rejects application-role rewrites of original adoption identity and committed receipt", async () => {
    const seed = await f.seed(), snapshot = await workspace(seed), request = command(snapshot.basis!);
    const adopted = await f.adoption.adopt(await f.current(), seed.executionId, request), context = await f.current();
    for (const patch of [sql`request_id=${randomUUID()}::uuid`, sql`receipt=null`]) {
      await expect(withTenant(f.database.db, context, tx => tx.execute(sql`update creative_response_adoptions set ${patch} where id=${adopted.id}::uuid`))).rejects.toThrow();
    }
    expect(await f.adoption.lookup(context, seed.executionId, request.requestId)).toEqual(adopted);
    const batch = (await withTenant(f.database.db, context, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, seed.batchId))))[0];
    expect(batch!.status).not.toBe("approved");
    const candidates = await withTenant(f.database.db, context, tx => tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, seed.candidateId)));
    expect(candidates[0]!.status).toBe("generated");
  });
});
