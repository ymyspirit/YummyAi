import { createHash } from "node:crypto";
import process from "node:process";
import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireCreativeResponseAdoptionEnvironment } from "./creative-response-adoption-environment.mjs";
import type { AdoptionSeed, createCreativeResponseAdoptionFixture } from "../../apps/api/src/design/creative-response-adoption.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createCreativeResponseAdoptionFixture>>;
type Database = Fixture["database"];
export type CreativeResponseAdoptionBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext; scenario: "adopt" | "clear" }
  | { id: number; nonce: string; operation: "facts" | "cancel-parent" | "close" };
export type CreativeResponseAdoptionCleanupPhase = "authority" | "owner_cleanup" | "verification" | "database_close";
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function invalid(): never { throw new Error("creative_adoption_browser_request_invalid"); }
function failed(phase: CreativeResponseAdoptionCleanupPhase, cause: unknown) {
  return new Error("creative_adoption_fixture_cleanup_" + phase + "_failed", { cause });
}
function cleanupPhases(error: unknown) {
  const result = new Set<CreativeResponseAdoptionCleanupPhase>(), visited = new Set<Error>();
  function visit(value: unknown, depth: number) {
    if (!(value instanceof Error) || visited.has(value) || depth > 6 || visited.size >= 32) return;
    visited.add(value);
    const match = /^creative_adoption_fixture_cleanup_(authority|owner_cleanup|verification|database_close)_failed$/.exec(value.message);
    if (match) result.add(match[1] as CreativeResponseAdoptionCleanupPhase);
    if (value instanceof AggregateError) for (const item of value.errors) visit(item, depth + 1);
    visit(value.cause, depth + 1);
  }
  visit(error, 0); return [...result];
}
async function send(value: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) return reject(new Error("creative_adoption_browser_channel_closed"));
    process.send(value, error => error ? reject(new Error("creative_adoption_browser_send_failed")) : resolve());
  });
}

/** One authenticated operator, one tracked original candidate, one nonce. The
 * child creates its synthetic original through the real batch/recovery owners;
 * adoption is performed by the compiled ERP, never an IPC success callback. */
export async function creativeResponseAdoptionBrowserChild() {
  const environment = requireCreativeResponseAdoptionEnvironment(process.env, true);
  let fixture: Fixture | undefined, database: Database | undefined, seed: AdoptionSeed | undefined;
  let context: TenantContext | undefined, closing = false, chain = Promise.resolve(), finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });

  async function facts() {
    if (!fixture || !seed || !context) invalid();
    const value = await fixture.facts(seed), originalArchive = await fixture.archive(seed);
    if (value.role !== "yummyai_app" || !value.execution || !value.batch || !value.item) throw new Error("creative_adoption_fixture_non_owner_facts_missing");
    const current = await fixture.current(), requests = [];
    for (const row of value.adoptions) requests.push(await fixture.adoption.lookup(current, seed.executionId, row.requestId));
    const assets = [];
    for (const request of requests) if (request.receipt) {
      const artifact = request.receipt.artifact, asset = value.assets.find(row => row.id === artifact.assetId);
      if (!asset || asset.assetDomain !== "authorized") throw new Error("creative_adoption_fixture_registered_asset_missing");
      const bytes = await fixture.storage.readPrivate(current, { id: asset.id, tenantId: current.tenantId, assetDomain: "authorized", objectKey: asset.objectKey },
        { requiredDomain: "authorized", maxBytes: asset.byteSize });
      assets.push({ id: asset.id, checksumSha256: asset.checksumSha256, actualSha256: sha(bytes), byteSize: asset.byteSize, actualByteSize: bytes.byteLength,
        mediaType: asset.mediaType, rightsStatus: asset.rightsStatus, aiGenerated: asset.aiGenerated, version: asset.version });
    }
    const paid = await fixture.base.facts(current);
    return { role: value.role, execution: { id: value.execution.id, phase: value.execution.phase, sha256: sha(JSON.stringify(value.execution)),
      inputFingerprint: value.execution.inputFingerprint, responseChecksum: value.execution.responseChecksum, encryptedChecksum: value.execution.encryptedChecksum,
      originalCostUsd: value.execution.receipt?.costUsd ?? null },
    archive: { sha256: originalArchive.sha256, objectKeySha256: sha(originalArchive.key), byteSize: originalArchive.bytes.byteLength },
    budget: { count: value.budget.length, sha256: sha(JSON.stringify(value.budget)) },
    batch: { id: value.batch.id, status: value.batch.status, archived: !!value.batch.archivedAt },
    candidates: value.candidates.map(row => ({ id: row.id, status: row.status, assetId: row.assetId, assetVersion: row.assetVersion,
      checksumSha256: row.checksumSha256, modelKey: row.modelKey, modelVersion: row.modelVersion })),
    versions: { count: value.versions.length, sha256: sha(JSON.stringify(value.versions)) }, requests, assets, tables: paid.tables,
    originalDispatches: value.counts.originalDispatches, forbiddenDispatches: value.counts.forbiddenDispatches };
  }
  let cleaning: Promise<unknown> | undefined;
  function cleanup() {
    cleaning ??= (async () => {
      const failures: unknown[] = []; let before: Awaited<ReturnType<typeof facts>> | undefined, proof: unknown = null;
      try {
        if (fixture) {
          if (seed) try { before = await facts(); } catch (cause) { failures.push(failed("authority", cause)); }
          try { await fixture.close(); } catch (cause) { failures.push(failed("owner_cleanup", cause)); }
          if (before && seed) try {
            // The separately owned connection remains open after base.close, so
            // verification is an actual non-owner read after formal cleanup.
            const after = await fixture.facts(seed);
            if (after.role !== "yummyai_app" || !after.batch?.archivedAt || after.batch.status !== "cancelled" || !after.execution
              || sha(JSON.stringify(after.execution)) !== before.execution.sha256 || sha(JSON.stringify(after.budget)) !== before.budget.sha256
              || after.versions.length !== before.versions.count || sha(JSON.stringify(after.versions)) !== before.versions.sha256
              || after.adoptions.some(row => !["committed", "cancelled"].includes(row.status)
                || row.status === "cancelled" && !!row.artifactIntent && !row.artifactDiscardedAt))
              throw new Error("creative_adoption_fixture_owner_cleanup_not_verified");
            proof = { role: after.role, batchId: after.batch.id, status: after.batch.status, archived: true, originalExecutionExact: true,
              originalBudgetExact: true, originalArchiveVerifiedBeforeOwnerClose: before.archive, retainedOriginalExecutions: 1,
              retainedAdoptionHistory: after.adoptions.length, remainingPreparedOrProcessing: 0,
              registeredAssetsRetainedUntilOuterNonceDeletion: before.assets.length, forbiddenDispatches: after.counts.forbiddenDispatches };
          } catch (cause) { failures.push(failed("verification", cause)); }
        }
      } finally { if (database) try { await database.client.end(); } catch (cause) { failures.push(failed("database_close", cause)); } }
      if (failures.length) throw new AggregateError(failures, "creative_adoption_fixture_cleanup_failed");
      return proof;
    })();
    return cleaning;
  }

  process.on("message", (raw: unknown) => { chain = chain.then(async () => {
    const packet = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const id = packet && typeof packet.id === "number" && Number.isSafeInteger(packet.id) && packet.id > 0 ? packet.id : 0;
    try {
      if (!packet || !id || closing || packet.nonce !== environment.nonce || !["seed", "facts", "cancel-parent", "close"].includes(String(packet.operation))) invalid();
      const keys = packet.operation === "seed" ? ["id", "nonce", "operation", "context", "scenario"] : ["id", "nonce", "operation"];
      if (Object.keys(packet).some(key => !keys.includes(key))) invalid();
      if (packet.operation === "close") {
        closing = true; const proof = await cleanup(); await send({ id, ok: true, result: { closed: true, cleanup: proof } }); process.disconnect(); finish(); return;
      }
      if (packet.operation === "seed") {
        if (fixture || database || seed || !["adopt", "clear"].includes(String(packet.scenario))) invalid();
        const incoming = TenantContextSchema.strict().parse(packet.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
        if (!api || !token) invalid();
        const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
        if (response.status !== 200) { await response.body?.cancel(); invalid(); }
        const session = ErpSessionViewSchema.parse(await response.json());
        const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
        if (!actors?.operator || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId || session.userId !== actors.operator.userId
          || session.tenantId !== actors.operator.tenantId || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
        context = TenantContextSchema.strict().parse(TenantContextSchema.parse(session));
        const db = await import("../../packages/database/src/index.js"), vault = await import("../../packages/ai-core/src/environment-vault.js");
        database = db.connectDatabase(environment.url);
        const [schema] = await database.client.unsafe("select current_database() as name,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
        if (schema?.name !== environment.name || schema.migrations !== environment.schema) invalid();
        const module = await import("../../apps/api/src/design/creative-response-adoption.test-fixture.js");
        fixture = await module.createCreativeResponseAdoptionFixture(process.env, { database, context,
          vault: vault.createEnvironmentSecretVault("POD_EXECUTION_ENCRYPTION_KEY", "yummyai:pod-execution-v1") });
        seed = await fixture.seed(packet.scenario === "clear" ? { phase: "uncertain", costUsd: null } : { phase: "failed" });
        const workspace = await fixture.adoption.workspace(await fixture.current(), seed.executionId);
        if (!workspace.basis || !workspace.canAdopt || !workspace.canInspectOriginal || workspace.requests.length) throw new Error("creative_adoption_fixture_initial_admission_missing");
        await send({ id, ok: true, result: { nonce: environment.nonce, executionId: seed.executionId, candidateId: seed.candidateId, batchId: seed.batchId,
          basis: workspace.basis, identityStamp: workspace.identityStamp, responseChecksum: seed.checkpoint.receipt.responseChecksum,
          artifactChecksum: sha(seed.image), imageBytes: seed.image.byteLength, width: 240, height: 160, originalPhase: seed.phase,
          authorityHash: sha(erpSessionAuthority(context)) } }); return;
      }
      if (!fixture || !seed || !context) invalid();
      if (packet.operation === "cancel-parent") {
        await fixture.pod.cancelDesignBatch(await fixture.current(), seed.batchId);
        await send({ id, ok: true, result: await facts() }); return;
      }
      await send({ id, ok: true, result: await facts() });
    } catch (cause) {
      const code = cause instanceof Error && /^creative_adoption_(?:browser|fixture)_[a-z_]+$/.test(cause.message) ? cause.message : "creative_adoption_browser_operation_failed";
      await send({ id, ok: false, errorCode: code, cleanupPhases: cleanupPhases(cause) });
      if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
    }
  }).catch(async () => { process.exitCode = 1; try { await cleanup(); } catch { /* Keep the failed child outcome. */ } if (process.connected) process.disconnect(); finish(); }); });
  process.once("disconnect", () => { if (!closing) { closing = true; chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); }); } });
  await done;
}
if (process.argv.includes("--creative-response-adoption-browser-child")) await creativeResponseAdoptionBrowserChild().catch(() => { process.exitCode = 1; });
