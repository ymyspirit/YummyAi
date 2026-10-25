import { randomUUID } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { CreativeResponseAdoptionCommandSchema } from "@yummyai/contracts/harness/creative-response-adoption";
import { creativeResponseAdoptions, withTenant, type CreativeResponseAdoptionArtifactIntent } from "@yummyai/database";
import { objectKey, type Storage } from "@yummyai/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireCreativeResponseAdoptionEnvironment } from "../../../../tools/testing/creative-response-adoption-environment.mjs";
import { HttpPodArtworkGateway } from "../../../worker/src/processors/pod-artwork.http-gateway.js";
import { HttpStudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { adoptionFixtureSha, createCreativeResponseAdoptionFixture, type AdoptionSeed } from "./creative-response-adoption.test-fixture.js";

// Fail before any client or fixture can connect to a non-disposable environment.
requireCreativeResponseAdoptionEnvironment();
type Fixture = Awaited<ReturnType<typeof createCreativeResponseAdoptionFixture>>;
const command = (basis: string | null) => CreativeResponseAdoptionCommandSchema.parse({
  requestId: randomUUID(), expectedBasis: basis, acknowledgeReviewRequired: true,
});

function checkViolation(cause: unknown) {
  // Drizzle wraps the real PostgreSQL error. An arbitrary rejection, HTTP error
  // or missing connection cannot satisfy the required database constraint proof.
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
    const value = cause as { code?: unknown; message?: unknown; cause?: unknown };
    if (value.code === "23514" && typeof value.message === "string") return { code: value.code, message: value.message };
    cause = value.cause;
  }
  return null;
}

function proposedIntent(seed: AdoptionSeed, id: string, tenantId: string): CreativeResponseAdoptionArtifactIntent {
  const checksumSha256 = adoptionFixtureSha(seed.image), fileName = `${id}-pod-output-0.png`;
  const response = JSON.parse(seed.checkpoint.rawBody) as {
    qualityCheckSnapshot: Record<string, unknown>; outputs: Array<{ metadata: Record<string, unknown> }>;
  };
  if (!seed.checkpoint.receipt.modelKey || !seed.checkpoint.receipt.modelVersion || !response.outputs[0])
    throw new Error("adoption_boundaries_original_model_missing");
  return {
    assetId: createEntityId(), objectKey: objectKey({ tenantId, domain: "authorized", sha256: checksumSha256, fileName }),
    fileName, checksumSha256, byteSize: seed.image.byteLength, mediaType: "image/png", width: 240, height: 160,
    modelKey: seed.checkpoint.receipt.modelKey, modelVersion: seed.checkpoint.receipt.modelVersion, seed: null,
    qualityCheckSnapshot: { ...response.qualityCheckSnapshot, processorDeploymentId: seed.checkpoint.deploymentId },
    outputMetadata: response.outputs[0].metadata,
  };
}

describe("original response adoption database and unresolved storage boundaries", () => {
  let fixture: Fixture | undefined, modelCalls = 0;
  beforeEach(async () => {
    fixture = undefined; modelCalls = 0;
    vi.spyOn(HttpPodArtworkGateway.prototype, "execute").mockImplementation(async () => {
      modelCalls++; throw new Error("adoption_boundaries_processor_call_forbidden");
    });
    vi.spyOn(HttpStudioGateway.prototype, "generate").mockImplementation(async () => {
      modelCalls++; throw new Error("adoption_boundaries_model_call_forbidden");
    });
    fixture = await createCreativeResponseAdoptionFixture();
  });
  afterEach(async () => {
    const failures: unknown[] = [];
    if (fixture) try { await fixture.close(); } catch (cause) { failures.push(cause); }
    try { expect(modelCalls).toBe(0); if (fixture) expect(fixture.counts.forbiddenDispatches).toBe(0); }
    catch (cause) { failures.push(cause); }
    vi.restoreAllMocks();
    if (failures.length) throw new AggregateError(failures, "adoption_boundaries_teardown_failed");
  });

  it("rejects all ten missing/JSON-null first intents as yummyai_app without freezing a corrupt intent", async () => {
    const f = fixture!, seed = await f.seed(), context = await f.current();
    const before = await f.facts(seed), archive = await f.archive(seed), workspace = await f.adoption.workspace(context, seed.executionId);
    const request = command(workspace.basis), held = f.hold("read");
    const first = f.adoption.adopt(context, seed.executionId, request)
      .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    try {
      // The fixture pauses only after the actual private archive read completed.
      await held.entered;
      const processing = await f.facts(seed), row = processing.adoptions[0];
      expect(processing.role).toBe("yummyai_app");
      expect(row).toMatchObject({ status: "processing", attemptCount: 1, artifactIntent: null, requestId: request.requestId });
      if (!row?.leaseToken) throw new Error("adoption_boundaries_first_intent_lease_missing");
      const valid = proposedIntent(seed, row.id, f.identity.tenantId);
      // Prove the control is accepted by this same trigger, then roll it back so
      // every negative probe still exercises its FIRST immutable assignment.
      await withTenant(f.database.db, context, async tx => {
        await tx.execute(sql`savepoint adoption_intent_control`);
        const written = await tx.execute<{ id: string }>(sql`update creative_response_adoptions
          set artifact_intent=${JSON.stringify(valid)}::jsonb,updated_at=clock_timestamp()
          where tenant_id=${context.tenantId}::uuid and requested_by=${context.userId}::uuid and id=${row.id}::uuid
          and lease_token=${row.leaseToken}::uuid and status='processing' and artifact_intent is null returning id`);
        expect(written).toHaveLength(1); expect(written[0]!.id).toBe(row.id);
        await tx.execute(sql`rollback to savepoint adoption_intent_control`);
        await tx.execute(sql`release savepoint adoption_intent_control`);
      });
      expect((await f.facts(seed)).adoptions).toEqual(processing.adoptions);
      for (const field of ["width", "height", "byteSize", "modelKey", "modelVersion"] as const) {
        for (const mode of ["missing", "json_null"] as const) {
          const invalid: Record<string, unknown> = { ...valid };
          if (mode === "missing") delete invalid[field]; else invalid[field] = null;
          let rejected: unknown;
          try {
            await withTenant(f.database.db, context, async tx => {
              const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
              expect(role?.role).toBe("yummyai_app");
              await tx.execute(sql`update creative_response_adoptions set artifact_intent=${JSON.stringify(invalid)}::jsonb,updated_at=clock_timestamp()
                where tenant_id=${context.tenantId}::uuid and requested_by=${context.userId}::uuid and id=${row.id}::uuid
                and lease_token=${row.leaseToken}::uuid and status='processing' and artifact_intent is null`);
            });
          } catch (cause) { rejected = cause; }
          expect(checkViolation(rejected), `${field}:${mode}`).toEqual({ code: "23514", message: "creative_adoption_artifact_intent_invalid" });
          const afterRejected = await f.facts(seed);
          expect(afterRejected.adoptions, `${field}:${mode}`).toEqual(processing.adoptions);
          expect(afterRejected.candidates, `${field}:${mode}`).toEqual(before.candidates);
          expect(afterRejected.assets, `${field}:${mode}`).toEqual(before.assets);
        }
      }
      held.clear();
      const result = await first;
      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ id: row.id, requestId: request.requestId, status: "committed", attempts: 1 });
      const after = await f.facts(seed);
      expect(after.adoptions).toHaveLength(1);
      expect(after.adoptions[0]!.artifactIntent).toMatchObject({ width: 240, height: 160, byteSize: seed.image.byteLength,
        modelKey: valid.modelKey, modelVersion: valid.modelVersion });
      expect(after.execution).toEqual(before.execution); expect(after.budget).toEqual(before.budget);
      expect(after.counts.originalDispatches).toBe(before.counts.originalDispatches);
      expect(after.versions).toEqual(before.versions); expect(await f.archive(seed)).toEqual(archive);
    } finally { held.clear(); await first; }
  });

  it("retains unresolved ownership after a non-dispatched PUT error and genuine S3 404, with no retry or cancellation effects", async () => {
    const f = fixture!, seed = await f.seed(), context = await f.current();
    const before = await f.facts(seed), archive = await f.archive(seed), workspace = await f.adoption.workspace(context, seed.executionId);
    const request = command(workspace.basis), writesBefore = f.base.counts.storageWrites;
    let putEntries = 0, cleanups = 0;
    const readFailures: Array<{ key: string; name: unknown; status: unknown }> = [];
    const unsent = new Proxy(f.storage, { get(target, property) {
      if (property === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
        putEntries++;
        expect(args[1].domain).toBe("authorized"); expect(Buffer.from(args[1].body)).toEqual(seed.image);
        // Fault injection ends here: no SDK PUT, unresolved promise or background
        // uploader is started. Production cannot assume this fixture-only fact.
        throw new Error("synthetic_unsent_put_acknowledgement_unknown");
      };
      if (property === "readPrivate") return async (...args: Parameters<Storage["readPrivate"]>) => {
        try { return await target.readPrivate(...args); }
        catch (cause) {
          if (args[1].assetDomain === "authorized") {
            const error = cause as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
            readFailures.push({ key: args[1].objectKey, name: error?.name, status: error?.$metadata?.httpStatusCode });
          }
          throw cause;
        }
      };
      if (property === "discardCreativeResponseAdoptionArtifact") return async (...args: Parameters<Storage["discardCreativeResponseAdoptionArtifact"]>) => {
        cleanups++; return target.discardCreativeResponseAdoptionArtifact(...args);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const owner = f.service(unsent);
    let primary: unknown;
    try {
      await expect(owner.adopt(context, seed.executionId, request))
        .rejects.toMatchObject({ status: 409, code: "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED" });
      const current = await f.facts(seed), row = current.adoptions[0];
      expect(row).toMatchObject({ status: "processing", attemptCount: 1, requestId: request.requestId,
        errorCode: "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED", artifactDiscardedAt: null, receipt: null });
      if (!row?.artifactIntent || !row.leaseToken) throw new Error("adoption_boundaries_unresolved_intent_missing");
      expect(putEntries).toBe(1); expect(f.base.counts.storageWrites).toBe(writesBefore);
      expect(readFailures).toEqual([{ key: row.artifactIntent.objectKey, status: 404, name: expect.stringMatching(/^(NoSuchKey|NotFound)$/) }]);
      const view = await owner.lookup(context, seed.executionId, request.requestId);
      expect(view).toMatchObject({ id: row.id, command: request, status: "processing", attempts: 1,
        canRetry: false, canCancel: false, receipt: null, artifactCleanup: "pending", errorCode: "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED" });
      expect(await owner.adopt(context, seed.executionId, request)).toEqual(view);
      await expect(owner.cancel(context, seed.executionId, row.id, { requestId: request.requestId }))
        .rejects.toMatchObject({ status: 409, code: "CREATIVE_ADOPTION_BLOCKED" });
      expect(putEntries).toBe(1); expect(cleanups).toBe(0); expect(readFailures).toHaveLength(1);
      expect(f.base.counts.storageWrites).toBe(writesBefore);
      const after = await f.facts(seed);
      expect(after.adoptions).toEqual(current.adoptions); expect(after.execution).toEqual(before.execution);
      expect(after.budget).toEqual(before.budget); expect(after.candidates).toEqual(before.candidates);
      expect(after.assets).toEqual(before.assets); expect(after.versions).toEqual(before.versions);
      expect(after.counts.originalDispatches).toBe(before.counts.originalDispatches);
      expect(await f.archive(seed)).toEqual(archive);
    } catch (cause) { primary = cause; }

    try {
      // Explicit fixture teardown, AFTER every fail-closed assertion. This exact
      // proxy never dispatched PUT and has no pending I/O. Release only its own
      // synthetic token, preserving the immutable intent; then use normal cancel.
      // This is not a production recovery API or proof of remote PUT quiescence.
      const retained = (await f.facts(seed)).adoptions[0];
      if (retained?.status === "processing") {
        const leaseToken = retained.leaseToken;
        if (!putEntries || !leaseToken || !retained.artifactIntent || f.base.counts.storageWrites !== writesBefore)
          throw new Error("adoption_boundaries_unsent_teardown_proof_missing");
        const released = await withTenant(f.database.db, context, tx => tx.update(creativeResponseAdoptions).set({ status: "prepared",
          leaseToken: null, leaseExpiresAt: null, errorCode: "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED", updatedAt: sql`clock_timestamp()` })
          .where(and(eq(creativeResponseAdoptions.id, retained.id), eq(creativeResponseAdoptions.executionId, seed.executionId),
            eq(creativeResponseAdoptions.requestedBy, context.userId), eq(creativeResponseAdoptions.requestId, request.requestId),
            eq(creativeResponseAdoptions.status, "processing"), eq(creativeResponseAdoptions.leaseToken, leaseToken))).returning());
        expect(released).toHaveLength(1); expect(released[0]!.artifactIntent).toEqual(retained.artifactIntent);
        const cancelled = await f.adoption.cancel(context, seed.executionId, retained.id, { requestId: request.requestId });
        expect(cancelled).toMatchObject({ id: retained.id, status: "cancelled", artifactCleanup: "complete", canRetry: false, canCancel: false });
      }
    } catch (cleanup) {
      throw new AggregateError(primary ? [primary, cleanup] : [cleanup], "adoption_boundaries_unsent_fixture_cleanup_failed");
    }
    if (primary) throw primary;
  });
});
