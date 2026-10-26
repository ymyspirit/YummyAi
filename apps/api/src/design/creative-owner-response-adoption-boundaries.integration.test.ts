import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { assetFiles, creativeExecutionChecksum, creativeOwnerResponseAdoptions as adoptions, withTenant, type TenantTransaction } from "@yummyai/database";
import { decodeCreativeOutputs } from "@yummyai/pod-core";
import { objectKey, type Storage } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "../../../../tools/testing/creative-owner-response-adoption-environment.mjs";
import { creativeAdoptionOwnerAssetMetadata, creativeAdoptionOwnerScopePin, loadCreativeResponseAdoptionOwner,
  pinCreativeResponseAdoptionOwner } from "./creative-response-adoption-owner.js";
import { CreativeOwnerResponseAdoptionService } from "./creative-owner-response-adoption.service.js";
import { createCreativeOwnerResponseAdoptionFixture, ownerFixtureSha } from "./creative-owner-response-adoption.test-fixture.js";

requireCreativeOwnerResponseAdoptionEnvironment();
type Fixture = Awaited<ReturnType<typeof createCreativeOwnerResponseAdoptionFixture>>;
function databaseCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error); if ("code" in error && typeof error.code === "string") return error.code;
    error = "cause" in error ? error.cause : null;
  }
  return null;
}
describe("owner adoption SQL fences and explicit template review", () => {
  let f: Fixture;
  beforeEach(async () => { f = await createCreativeOwnerResponseAdoptionFixture(); });
  afterEach(async () => { if (f) await f.close(); });
  async function prepared() {
    const seed = await f.seed("creative_adaptation"), command = await f.command(seed);
    const scanner = { async scan(): Promise<never> { throw new Error("SYNTHETIC_OWNER_SCAN_UNAVAILABLE"); } };
    const rejected = new CreativeOwnerResponseAdoptionService(f.database, f.storage, { vault: f.vault, scanner });
    await expect(rejected.adopt(await f.current(), seed.executionId, command)).rejects.toMatchObject({ code: "CREATIVE_OWNER_ADOPTION_SCAN_FAILED" });
    const facts = await f.facts(seed), row = facts.adoptions[0];
    if (!row || row.status !== "prepared" || row.planPin || row.artifactIntents) throw new Error("owner_fixture_prepared_failure_missing");
    expect(facts.assets).toEqual([]); return { seed, command, row };
  }

  it("uses a failed scan to leave a cancellable original request without uploading or changing the owner", async () => {
    const { seed, command, row } = await prepared(), before = await f.original(seed);
    const cancelled = await f.service(seed).cancel(await f.current(), seed.executionId, row.id, command);
    expect(cancelled).toMatchObject({ status: "cancelled", artifactCleanup: "not_required" });
    await expect(f.adopt(seed, command)).rejects.toMatchObject({ status: 409 });
    expect(await f.original(seed)).toEqual(before); expect((await f.facts(seed)).assets).toEqual([]);
  });

  it.each(["receipt", "owner_receipt", "committed_at", "artifact_discarded_at"])("rejects premature %s through the real application role", async column => {
    const { seed, row } = await prepared(), actor = await f.current(), before = await f.facts(seed);
    let rejected: unknown;
    try { await withTenant(f.database.db, actor, async tx => {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`); expect(role?.role).toBe("yummyai_app");
      const value = column.endsWith("_at") ? sql`clock_timestamp()` : sql`'{}'::jsonb`;
      await tx.execute(sql`update creative_owner_response_adoptions set ${sql.identifier(column)}=${value} where id=${row.id}::uuid`);
    }); } catch (cause) { rejected = cause; }
    expect(databaseCode(rejected)).toBe("23514"); expect(await f.facts(seed)).toEqual(before);
  });

  it("requires exact eleven-field intents and rejects invalid dimensions MIME and private object addresses in SQL", async () => {
    const { seed, row } = await prepared(), actor = await f.current(), archive = await f.archive(seed), original = await f.execution(seed.operation);
    const plan = await withTenant(f.database.db, actor, tx => pinCreativeResponseAdoptionOwner(tx, actor, original, archive.response)), output = plan.outputs[0]!;
    const fileName = `${row.id}-owner-0.png`, intent = { assetId: createEntityId(), role: output.role, fileName,
      objectKey: objectKey({ tenantId: actor.tenantId, domain: "authorized", sha256: output.checksumSha256, fileName }),
      checksumSha256: output.checksumSha256, byteSize: output.byteSize, mediaType: output.mediaType,
      width: output.width, height: output.height, aiGenerated: output.aiGenerated,
      rightsMetadata: creativeAdoptionOwnerAssetMetadata(plan, output, row.id) };
    const claim = (tx: TenantTransaction) => tx.update(adoptions).set({ status: "processing", attemptCount: row.attemptCount + 1,
      leaseToken: createEntityId(), leaseExpiresAt: sql`clock_timestamp()+interval '180 seconds'`, errorCode: null }).where(eq(adoptions.id, row.id));
    const write = (tx: TenantTransaction, value: unknown) => tx.execute(sql`update creative_owner_response_adoptions set plan_pin=${JSON.stringify(plan.pin)}::jsonb,
      artifact_intents=${JSON.stringify(value)}::jsonb where id=${row.id}::uuid`);
    // A successful control may use a savepoint. Every expected SQL exception
    // gets its own transaction: postgres.js retains a transaction's first
    // query error even when a manually issued SAVEPOINT has been rolled back.
    await withTenant(f.database.db, actor, async tx => {
      await tx.execute(sql`savepoint owner_intent_outer`);
      try {
        await claim(tx); await write(tx, [intent]);
      } finally { await tx.execute(sql`rollback to savepoint owner_intent_outer`); await tx.execute(sql`release savepoint owner_intent_outer`); }
    });
    const mutations: Array<[string, unknown]> = [
      ["not_array", {}], ["empty", []], ["width_object", [{ ...intent, width: {} }]],
      ["height_string", [{ ...intent, height: "300" }]], ["width_null_raster", [{ ...intent, width: null }]],
      ["extra_field", [{ ...intent, approved: true }]], ["wrong_mime", [{ ...intent, mediaType: "image/svg+xml" }]],
      ["extension", [{ ...intent, mediaType: "image/jpeg" }]], ["foreign_key", [{ ...intent, objectKey: intent.objectKey.replace(actor.tenantId, createEntityId()) }]],
      ["byte_string", [{ ...intent, byteSize: String(intent.byteSize) }]], ["duplicate_role", [intent, { ...intent, assetId: createEntityId() }]],
      ["duplicate_asset", [intent, { ...intent, role: "other" }]],
    ];
    for (const [name, value] of mutations) {
      let rejected: unknown;
      try { await withTenant(f.database.db, actor, async tx => { await claim(tx); await write(tx, value); }); }
      catch (cause) { rejected = cause; }
      expect(databaseCode(rejected), name).toBe("23514");
      expect((await f.facts(seed)).adoptions[0]).toEqual(row);
    }
    expect((await f.facts(seed)).adoptions[0]).toEqual(row);
  });

  it("refuses a genuinely unarchived failed local execution even when all null source fields agree", async () => {
    const seed = await f.unarchived(), actor = await f.current(), original = await f.execution(seed.operation);
    const before = await f.original(seed); let rejected: unknown;
    try { await withTenant(f.database.db, actor, async tx => {
      const scope = await loadCreativeResponseAdoptionOwner(tx, actor, original), ownerBasis = creativeAdoptionOwnerScopePin(scope);
      const source = { version: 1, executionId: original.id, kind: original.kind, ownerId: seed.operation.ownerId, parentId: null,
        originalPhase: original.phase, effect: original.effect, inputFingerprint: original.inputFingerprint,
        executionChecksum: creativeExecutionChecksum({ ...original, updatedAt: null, responsePurgedAt: null }), authorityChecksum: original.authorityChecksum,
        contractChecksum: creativeExecutionChecksum(original.executionContract), methodChecksum: creativeExecutionChecksum(original.methodSelection), ownerBasis,
        responseObjectKey: null, encryptedChecksum: null, responseChecksum: null, responseExpiresAt: null,
        submissionToken: null, submittedAt: null, receipt: null };
      const basis = creativeExecutionChecksum(source), request = { requestId: randomUUID(), expectedBasis: basis, acknowledgeReviewRequired: true };
      await tx.execute(sql`insert into creative_owner_response_adoptions(id,tenant_id,execution_id,requested_by,kind,owner_id,parent_id,
        request_id,request_checksum,expected_basis,request,source_pin) values(${createEntityId()}::uuid,${actor.tenantId}::uuid,${original.id}::uuid,
        ${actor.userId}::uuid,${original.kind},${seed.operation.ownerId}::uuid,null,${request.requestId}::uuid,${creativeExecutionChecksum(request)},${basis},
        ${JSON.stringify(request)}::jsonb,${JSON.stringify(source)}::jsonb)`);
    }); } catch (cause) { rejected = cause; }
    expect(databaseCode(rejected)).toBe("23514"); expect((await f.facts(seed)).adoptions).toEqual([]); expect(await f.original(seed)).toEqual(before);
  });

  it("keeps committed facts immutable and requires the independent explicit template confirmation with current asset write permission", async () => {
    const seed = await f.seed("template_compile"), actor = await f.current(), command = await f.command(seed), before = await f.original(seed);
    const adopted = await f.adopt(seed, command), initial = await f.facts(seed), specId = await f.approvedPrintSpec();
    expect(initial.assets.every(file => file.rightsStatus === "unverified")).toBe(true);
    const input = { name: "Synthetic confirmed adoption " + createEntityId(), platform: "amazon" as const, locale: "en-US", productCategory: "canvas_art" as const,
      slots: [{ slotKey: "main", label: "Synthetic", ordinal: 0, required: true, inspectionId: seed.inspectionId!, acceptedPrintSpecVersionIds: [specId] }] };
    await expect(f.mockups.createTemplatePack(actor, input)).rejects.toThrow();
    const reviewer = await f.paid.actor(actor.tenantId, "tenant");
    let reviewerContext = await f.paid.grant(reviewer.context, f.permissions.filter(value => value !== Permission.AssetWrite), "tenant");
    const review = await f.mockups.getInspection(reviewerContext, seed.inspectionId!);
    await expect(f.mockups.confirmInspection(reviewerContext, seed.inspectionId!, review.reviewFingerprint)).rejects.toThrow();
    expect((await f.facts(seed)).assets.every(file => file.rightsStatus === "unverified")).toBe(true);
    reviewerContext = await f.paid.grant(reviewer.context, f.permissions, "tenant");
    await expect(f.mockups.confirmInspection(reviewerContext, seed.inspectionId!, "0".repeat(64))).rejects.toMatchObject({ status: 409 });
    try {
      await withTenant(f.database.db, actor, tx => tx.update(assetFiles).set({ version: 2 }).where(eq(assetFiles.id, seed.sourceAssetId!)));
      await expect(f.mockups.confirmInspection(reviewerContext, seed.inspectionId!, review.reviewFingerprint)).rejects.toThrow();
      expect((await f.facts(seed)).assets.every(file => file.rightsStatus === "unverified")).toBe(true);
    } finally { await withTenant(f.database.db, actor, tx => tx.update(assetFiles).set({ version: 1 }).where(eq(assetFiles.id, seed.sourceAssetId!))); }
    const originalExecution = await f.execution(seed.operation);
    const evidenceRead = await withTenant(f.database.db, reviewerContext, async tx => {
      const plain = await tx.select().from(adoptions).where(eq(adoptions.id, adopted.id));
      const locked = await tx.select().from(adoptions).where(eq(adoptions.id, adopted.id)).for("share");
      const value = plain[0], original = originalExecution;
      const digest = (input: unknown) => creativeExecutionChecksum(JSON.parse(JSON.stringify(input)));
      return { plainCount: plain.length, forShareCount: locked.length, requesterIsReviewer: value?.requestedBy === reviewerContext.userId,
        parsedReceipt: !!value?.receipt, ownerReceipt: !!value?.ownerReceipt, intents: !!value?.artifactIntents, planPin: !!value?.planPin,
        originalCompletionAbsent: !original.completionEvidence && !original.completionChecksum,
        executionHashMatches: value?.sourcePin.executionChecksum === digest({ ...original, updatedAt: null, responsePurgedAt: null }),
        basisHashMatches: value?.expectedBasis === digest(value?.sourcePin), requestHashMatches: value?.requestChecksum === digest(value?.request) };
    });
    expect(evidenceRead).toEqual({ plainCount: 1, forShareCount: 0, requesterIsReviewer: false, parsedReceipt: true,
      ownerReceipt: true, intents: true, planPin: true, originalCompletionAbsent: true,
      executionHashMatches: true, basisHashMatches: true, requestHashMatches: true });
    await f.mockups.confirmInspection(reviewerContext, seed.inspectionId!, review.reviewFingerprint);
    const confirmed = await f.facts(seed);
    expect(confirmed.inspections[0]?.confirmedBy).toBe(reviewer.userId); expect(confirmed.inspections[0]?.confirmedAt).toBeInstanceOf(Date);
    expect(confirmed.assets.every(file => file.rightsStatus === "approved")).toBe(true);
    expect((await f.mockups.createTemplatePack(actor, input)).status).toBe("draft");
    await expect(withTenant(f.database.db, actor, tx => tx.update(adoptions).set({ errorCode: "FORGED_AFTER_COMMIT" }).where(eq(adoptions.id, adopted.id))))
      .rejects.toSatisfy(error => databaseCode(error) === "23514");
    expect((await f.service(seed).lookup(actor, seed.executionId, command.requestId)).receipt).toEqual(adopted.receipt);
    expect(await f.original(seed)).toEqual(before);
  });

  it("confirms the exact original bytes after a real template artifact PUT loses its ACK without repeating its model or command", async () => {
    const seed = await f.seed("template_compile"), actor = await f.current(), command = await f.command(seed);
    const before = await f.original(seed), archive = await f.archive(seed);
    if (archive.response.kind !== "local") throw new Error("owner_fixture_native_local_archive_required");
    const outputs = decodeCreativeOutputs(archive.response);
    expect(outputs.length).toBeGreaterThanOrEqual(4);
    let lost = false;
    const puts: Array<{ key: string; sha256: string; byteSize: number }> = [];
    const reads: Array<{ key: string; sha256: string; byteSize: number; maxBytes: number | undefined; bounded: boolean }> = [];
    const observed = new Proxy(f.storage, { get(target, key) {
      if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
        const stored = await target.putPrivate(...args);
        if (args[1].domain === "authorized") {
          puts.push({ key: stored.objectKey, sha256: stored.checksumSha256, byteSize: args[1].body.byteLength });
          if (!lost) { lost = true; throw new Error("SYNTHETIC_OWNER_ARTIFACT_PUT_ACK_LOST_AFTER_STORAGE"); }
        }
        return stored;
      };
      if (key === "readPrivate") return async (...args: Parameters<Storage["readPrivate"]>) => {
        const bytes = await target.readPrivate(...args);
        if (args[1].assetDomain === "authorized") reads.push({ key: args[1].objectKey, sha256: ownerFixtureSha(bytes),
          byteSize: bytes.byteLength, maxBytes: args[2]?.maxBytes, bounded: args[2]?.signal instanceof AbortSignal });
        return bytes;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const service = new CreativeOwnerResponseAdoptionService(f.database, observed, { vault: f.vault });
    const result = await service.adopt(actor, seed.executionId, command), actual = await f.facts(seed);
    expect(lost).toBe(true); expect(result).toMatchObject({ status: "committed", attempts: 1, artifactCleanup: "registered" });
    expect(puts).toHaveLength(outputs.length); expect(actual.assets).toHaveLength(outputs.length);
    expect(reads.filter(row => row.key === puts[0]!.key)).toHaveLength(2);
    for (const intent of actual.adoptions[0]!.artifactIntents!) {
      expect(reads.filter(row => row.key === intent.objectKey).every(row => row.sha256 === intent.checksumSha256
        && row.byteSize === intent.byteSize && row.maxBytes === intent.byteSize && row.bounded)).toBe(true);
      expect(puts.filter(row => row.key === intent.objectKey)).toHaveLength(1);
      expect(outputs.map(output => ownerFixtureSha(output.bytes))).toContain(intent.checksumSha256);
    }
    const io = { puts: puts.length, reads: reads.length };
    expect(await service.adopt(actor, seed.executionId, command)).toEqual(result);
    expect(await service.lookup(actor, seed.executionId, command.requestId)).toEqual(result);
    expect({ puts: puts.length, reads: reads.length }).toEqual(io);
    expect(actual.inspections[0]).toMatchObject({ status: "completed", confirmedAt: null, confirmedBy: null });
    expect(actual.assets.every(file => file.rightsStatus === "unverified")).toBe(true);
    expect(await f.original(seed)).toEqual(before); expect(await f.archive(seed)).toEqual(archive);
  });

  it("cleans every exact multi artifact intent after all real PUTs finish but the final source check rejects commit", async () => {
    const seed = await f.seed("template_compile"), actor = await f.current(), command = await f.command(seed);
    const before = await f.original(seed), archive = await f.archive(seed), initial = await f.facts(seed);
    if (archive.response.kind !== "local") throw new Error("owner_fixture_native_local_archive_required");
    const outputs = decodeCreativeOutputs(archive.response);
    expect(outputs.length).toBeGreaterThanOrEqual(4);
    let putCount = 0, confirmedCount = 0, sourceChanged = false;
    const observed = new Proxy(f.storage, { get(target, key) {
      if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
        const stored = await target.putPrivate(...args); if (args[1].domain === "authorized") putCount++; return stored;
      };
      if (key === "readPrivate") return async (...args: Parameters<Storage["readPrivate"]>) => {
        const bytes = await target.readPrivate(...args);
        if (args[1].assetDomain === "authorized" && ++confirmedCount === outputs.length) {
          expect(putCount).toBe(outputs.length);
          // Actual current source state changes after the last real byte read.
          // The final service transaction must recheck it before owner writes.
          await withTenant(f.database.db, actor, tx => tx.update(assetFiles).set({ version: 2 }).where(eq(assetFiles.id, seed.sourceAssetId!)));
          sourceChanged = true;
        }
        return bytes;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const service = new CreativeOwnerResponseAdoptionService(f.database, observed, { vault: f.vault });
    let prepared: Awaited<ReturnType<Fixture["facts"]>>["adoptions"][number] | undefined;
    try {
      await expect(service.adopt(actor, seed.executionId, command)).rejects.toMatchObject({ status: 409 });
      expect(sourceChanged).toBe(true); expect(putCount).toBe(outputs.length); expect(confirmedCount).toBe(outputs.length);
      const failed = await f.facts(seed); prepared = failed.adoptions[0];
      expect(prepared).toMatchObject({ status: "prepared", receipt: null, ownerReceipt: null, leaseToken: null, leaseExpiresAt: null });
      expect(prepared!.artifactIntents).toHaveLength(outputs.length); expect(prepared!.planPin).not.toBeNull();
      expect(failed.assets).toEqual([]); expect(failed.inspections).toEqual(initial.inspections);
      expect(await f.original(seed)).toEqual(before);
      for (const intent of prepared!.artifactIntents!) {
        const bytes = await f.storage.readPrivate(actor, { id: intent.assetId, tenantId: actor.tenantId,
          assetDomain: "authorized", objectKey: intent.objectKey }, { requiredDomain: "authorized", maxBytes: intent.byteSize });
        expect(ownerFixtureSha(bytes)).toBe(intent.checksumSha256);
      }
    } finally {
      if (sourceChanged) await withTenant(f.database.db, actor, tx => tx.update(assetFiles).set({ version: 1 }).where(eq(assetFiles.id, seed.sourceAssetId!)));
    }
    if (!prepared?.artifactIntents) throw new Error("owner_fixture_multi_file_intents_missing");
    const cancelled = await service.cancel(await f.current(), seed.executionId, prepared.id, command);
    expect(cancelled).toMatchObject({ status: "cancelled", attempts: 1, artifactCleanup: "complete", receipt: null });
    const after = await f.facts(seed);
    expect(after.adoptions[0]!.artifactIntents).toEqual(prepared.artifactIntents);
    expect(after.adoptions[0]!.planPin).toEqual(prepared.planPin);
    expect(after.adoptions[0]!.artifactDiscardedAt).toBeInstanceOf(Date);
    expect(after.assets).toEqual([]); expect(after.inspections).toEqual(initial.inspections);
    // Resolve the existing storage package's pinned SDK instead of adding a
    // dependency to API. This client only verifies this nonce's exact keys.
    const sdkPath = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url)).resolve("@aws-sdk/client-s3");
    const sdk = await import(pathToFileURL(sdkPath).href);
    const client = new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
    try {
      for (const intent of prepared.artifactIntents) {
        const listed = await client.send(new sdk.ListObjectVersionsCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Prefix: intent.objectKey, MaxKeys: 100 }));
        expect(listed.IsTruncated).toBe(false); expect(listed.Versions ?? []).toEqual([]); expect(listed.DeleteMarkers ?? []).toEqual([]);
        expect(listed.CommonPrefixes ?? []).toEqual([]);
        await expect(f.storage.readPrivate(actor, { id: intent.assetId, tenantId: actor.tenantId, assetDomain: "authorized", objectKey: intent.objectKey },
          { requiredDomain: "authorized", maxBytes: intent.byteSize })).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
      }
    } finally { client.destroy(); }
    expect(await f.original(seed)).toEqual(before); expect(await f.archive(seed)).toEqual(archive);
  });
});
