import { createHash } from "node:crypto";
import process from "node:process";
import { ErpSessionViewSchema, erpSessionAuthority } from "../../packages/contracts/src/auth/session.js";
import { TenantContextSchema, type TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "./creative-owner-response-adoption-environment.mjs";
import type { OwnerSeed, createCreativeOwnerResponseAdoptionFixture } from "../../apps/api/src/design/creative-owner-response-adoption.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createCreativeOwnerResponseAdoptionFixture>>;
type Database = Fixture["database"];
export type CreativeOwnerResponseAdoptionBrowserRequest = { id: number; nonce: string; operation: "seed"; context: TenantContext }
  | { id: number; nonce: string; operation: "facts" | "close" };
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function invalid(): never { throw new Error("creative_owner_adoption_browser_request_invalid"); }
async function send(value: unknown) {
  await new Promise<void>((resolve, reject) => {
    if (!process.connected || !process.send) return reject(new Error("creative_owner_adoption_browser_channel_closed"));
    process.send(value, error => error ? reject(new Error("creative_owner_adoption_browser_send_failed")) : resolve());
  });
}

/** One real personal session, one failed original adaptation and one nonce.
 * Only the original synthetic producer is driven over IPC. The browser must
 * use the deployed HTTP application to preview, commit and recover its receipt. */
export async function creativeOwnerResponseAdoptionBrowserChild() {
  const environment = requireCreativeOwnerResponseAdoptionEnvironment(process.env, true);
  let fixture: Fixture | undefined, database: Database | undefined, seed: OwnerSeed | undefined, context: TenantContext | undefined;
  let closing = false, chain = Promise.resolve(), finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });

  async function batch() {
    if (!fixture || !seed?.batchId) invalid();
    const [row] = (await fixture.facts(seed)).parentBatches;
    if (!row) throw new Error("creative_owner_adoption_fixture_batch_missing");
    return { id: row.id, status: row.status, archived: !!row.archivedAt };
  }
  async function facts() {
    if (!fixture || !seed || !context) invalid();
    const actor = await fixture.current(), original = await fixture.original(seed), owner = await fixture.facts(seed), archive = await fixture.archive(seed);
    const row = original.executions.find(value => value.id === seed!.executionId);
    if (owner.role !== "yummyai_app" || !row || row.parentExecutionId !== null || seed.parentId !== seed.batchId)
      throw new Error("creative_owner_adoption_fixture_original_identity_changed");
    const requests = [];
    for (const adoption of owner.adoptions) requests.push(await fixture.service(seed).lookup(actor, seed.executionId, adoption.requestId));
    const assets = [];
    for (const file of owner.assets) {
      const bytes = await fixture.storage.readPrivate(actor, { ...file, assetDomain: "authorized" }, { requiredDomain: "authorized" });
      assets.push({ id: file.id, checksumSha256: file.checksumSha256, actualSha256: sha(bytes), byteSize: file.byteSize,
        actualByteSize: bytes.byteLength, mediaType: file.mediaType, rightsStatus: file.rightsStatus, version: file.version });
    }
    const paid = await fixture.paid.base.facts(actor);
    return { role: owner.role,
      original: { executionId: row.id, parentExecutionId: row.parentExecutionId, phase: row.phase, inputFingerprint: row.inputFingerprint,
        responseChecksum: row.responseChecksum, encryptedChecksum: row.encryptedChecksum, executionsSha256: sha(JSON.stringify(original.executions)),
        ledgerSha256: sha(JSON.stringify(original.ledger)), ledgerCount: original.ledger.length, calls: original.calls },
      archive: { encryptedSha256: archive.encryptedSha256, objectKeySha256: sha(archive.objectKey) },
      batch: await batch(),
      versions: owner.versions.map(value => ({ id: value.id, status: value.status, reviewedAt: value.reviewedAt, reviewedBy: value.reviewedBy })),
      links: owner.links.map(value => ({ id: value.id, role: value.role, assetId: value.assetId })), requests, assets,
      tables: paid.tables, liveAuthorityHash: sha(erpSessionAuthority(actor)), providerCalls: paid.providerCalls,
      ordinaryWorkerProcesses: paid.workerProcesses, modelSecretReads: (await fixture.paid.facts(actor)).modelSecretReads };
  }

  let cleaning: Promise<unknown> | undefined;
  function cleanup() {
    cleaning ??= (async () => {
      const failures: unknown[] = []; let before: Awaited<ReturnType<typeof facts>> | undefined, proof: unknown = null;
      try {
        if (fixture) {
          if (seed) try { before = await facts(); } catch (cause) { failures.push(new Error("creative_owner_adoption_fixture_authority_failed", { cause })); }
          try { await fixture.close(); } catch (cause) { failures.push(new Error("creative_owner_adoption_fixture_owner_cleanup_failed", { cause })); }
          if (before && seed) try {
            // This connection is separately owned, so real RLS verification
            // remains possible after fixture.close destroys its storage client.
            const after = await fixture.facts(seed), original = await fixture.original(seed), currentBatch = await batch();
            const authority = sha(erpSessionAuthority(await fixture.current()));
            if (after.role !== "yummyai_app" || currentBatch.status !== "cancelled" || !currentBatch.archived
              || sha(JSON.stringify(original.executions)) !== before.original.executionsSha256
              || sha(JSON.stringify(original.ledger)) !== before.original.ledgerSha256
              || JSON.stringify(original.calls) !== JSON.stringify(before.original.calls)
              || authority !== before.liveAuthorityHash
              || after.adoptions.some(value => !["committed", "cancelled"].includes(value.status)
                || value.status === "cancelled" && !!value.artifactIntents && !value.artifactDiscardedAt)
              || after.assets.some(value => value.rightsStatus !== "unverified"))
              throw new Error("creative_owner_adoption_fixture_cleanup_not_verified");
            proof = { role: after.role, batchId: currentBatch.id, status: "cancelled", archived: true,
              originalExecutionExact: true, originalBudgetExact: true, originalDispatchAndGatewayCallsExact: true,
              originalSessionAuthorityRestored: true, remainingPreparedOrProcessing: 0,
              retainedAdoptionHistory: after.adoptions.length, registeredUnreviewedAssets: after.assets.length,
              retainedUntilOuterNonceDeletion: true };
          } catch (cause) { failures.push(new Error("creative_owner_adoption_fixture_verification_failed", { cause })); }
        }
      } finally { if (database) try { await database.client.end(); } catch (cause) { failures.push(new Error("creative_owner_adoption_fixture_database_close_failed", { cause })); } }
      if (failures.length) throw new AggregateError(failures, "creative_owner_adoption_fixture_cleanup_failed");
      return proof;
    })(); return cleaning;
  }

  process.on("message", (raw: unknown) => { chain = chain.then(async () => {
    const packet = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const id = packet && typeof packet.id === "number" && Number.isSafeInteger(packet.id) && packet.id > 0 ? packet.id : 0;
    try {
      if (!packet || !id || closing || packet.nonce !== environment.nonce || !["seed", "facts", "close"].includes(String(packet.operation))) invalid();
      const keys = packet.operation === "seed" ? ["id", "nonce", "operation", "context"] : ["id", "nonce", "operation"];
      if (Object.keys(packet).some(key => !keys.includes(key))) invalid();
      if (packet.operation === "close") {
        closing = true; const proof = await cleanup(); await send({ id, ok: true, result: { closed: true, cleanup: proof } });
        process.disconnect(); finish(); return;
      }
      if (packet.operation === "seed") {
        if (fixture || database || seed) invalid();
        const incoming = TenantContextSchema.strict().parse(packet.context), api = process.env.API_BASE_URL, token = process.env.API_ACCESS_TOKEN;
        if (!api || !token) invalid();
        const response = await fetch(new URL("/v1/identity/session", api), { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: "Bearer " + token } });
        if (response.status !== 200) { await response.body?.cancel(); invalid(); }
        const session = ErpSessionViewSchema.parse(await response.json());
        const actors = JSON.parse(process.env.ERP_FIXTURE_ACTORS ?? "null") as { operator?: { userId?: string; tenantId?: string } } | null;
        if (!actors?.operator || incoming.userId !== session.userId || incoming.tenantId !== session.tenantId
          || session.userId !== actors.operator.userId || session.tenantId !== actors.operator.tenantId
          || erpSessionAuthority(incoming) !== erpSessionAuthority(session)) invalid();
        context = TenantContextSchema.strict().parse(TenantContextSchema.parse(session));
        const db = await import("../../packages/database/src/index.js"); database = db.connectDatabase(environment.url);
        const [schema] = await database.client.unsafe("select current_database() as name,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
        if (schema?.name !== environment.name || schema.migrations !== environment.schema) invalid();
        const module = await import("../../apps/api/src/design/creative-owner-response-adoption.test-fixture.js");
        // Passing the current OIDC context suppresses API-test actor creation
        // and ALL-permission grants. Its existing membership must suffice.
        fixture = await module.createCreativeOwnerResponseAdoptionFixture({ database, context });
        if (erpSessionAuthority(await fixture.current()) !== erpSessionAuthority(context)) invalid();
        seed = await fixture.seed("creative_adaptation");
        const workspace = await fixture.service(seed).workspace(await fixture.current(), seed.executionId);
        if (!workspace.basis || !workspace.canAdopt || !workspace.canInspectOriginal || workspace.requests.length
          || workspace.parentId !== seed.batchId || workspace.parentExecutionId !== null) invalid();
        const preview = await fixture.service(seed).preview(await fixture.current(), seed.executionId, workspace.basis);
        const png = Buffer.from(preview.bytes);
        if (preview.mediaType !== "image/png" || png.length < 24
          || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || png.toString("ascii", 12, 16) !== "IHDR") invalid();
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        if (!width || !height) invalid();
        await send({ id, ok: true, result: { nonce: environment.nonce, executionId: seed.executionId, ownerId: seed.operation.ownerId,
          batchId: seed.batchId, parentExecutionId: null, stepKey: seed.operation.stepKey, inputFingerprint: workspace.source.inputFingerprint,
          basis: workspace.basis, identityStamp: workspace.identityStamp, originalPhase: workspace.originalPhase,
          responseChecksum: preview.responseChecksum, artifactChecksum: preview.artifactChecksum, imageBytes: preview.bytes.byteLength,
          width, height, authorityHash: sha(erpSessionAuthority(context)) } }); return;
      }
      await send({ id, ok: true, result: await facts() });
    } catch (cause) {
      const code = cause instanceof Error && /^creative_owner_adoption_(?:browser|fixture)_[a-z_]+$/.test(cause.message)
        ? cause.message : "creative_owner_adoption_browser_operation_failed";
      await send({ id, ok: false, errorCode: code });
      if (closing) { process.exitCode = 1; process.disconnect(); finish(); }
    }
  }).catch(async () => { process.exitCode = 1; try { await cleanup(); } catch { /* Preserve failure while the nonce runner cleans all resources. */ }
    if (process.connected) process.disconnect(); finish(); }); });
  process.once("disconnect", () => { if (!closing) { closing = true;
    chain = chain.then(cleanup).then(() => { process.exitCode = 1; finish(); }, () => { process.exitCode = 1; finish(); }); } });
  await done;
}
if (process.argv.includes("--creative-owner-response-adoption-browser-child"))
  await creativeOwnerResponseAdoptionBrowserChild().catch(() => { process.exitCode = 1; });
