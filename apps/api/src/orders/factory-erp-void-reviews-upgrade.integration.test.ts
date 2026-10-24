import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { ChangeFactoryErpBinding, FactoryErpBindingChangeResult } from "@yummyai/contracts/order/factory-erp-binding";
import type { ApplyFactoryErpImport, FactoryErpApplyResult, FactoryErpItemSelection } from "@yummyai/contracts/order/factory-erp-import";
import { ReviewFactoryErpVoidSchema } from "@yummyai/contracts/order/factory-erp-void-review";
import type { ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant,
  factoryErpRetentionContext, redactExpiredFactoryErpSources, claimFactoryErpSourcePurges, finishFactoryErpSourcePurge } from "@yummyai/database";
import { FactoryErpSourcePurger } from "@yummyai/storage";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { factoryVoidOwner, requireFactoryVoidEnvironment, voidObservationIdentity, voidReviewSha, withFactoryVoidSourceClock } from "../../../../tools/testing/factory-erp-void-reviews-fixture.js";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

requireFactoryVoidEnvironment("pre-0166");
type Original165 = {
  context: TenantContext; foreignContext: TenantContext; factoryId: string;
  packet: ProductionDeliveryPackageView; replacementPacket: ProductionDeliveryPackageView;
  originalBindingId: string; activeBindingId: string; originalVoidIds: string[]; activeVoidId: string;
  originalItems: FactoryErpItemSelection[]; replacementItems: FactoryErpItemSelection[];
  sources: Array<{ id: string; objectKey: string; storedChecksum: string; fileChecksum: string; previewChecksum: string;
    versionId: string; purged: boolean; sourceProofChecksum: string; claimsChecksum: string }>;
  applications: Array<{ importId: string; input: ApplyFactoryErpImport; result: FactoryErpApplyResult }>;
  change: { input: ChangeFactoryErpBinding; result: FactoryErpBindingChangeResult };
};
const originalTables = ["factory_erp_imports", "factory_erp_applications", "factory_erp_bindings", "factory_erp_binding_items", "factory_erp_observations",
  "factory_erp_application_rows", "factory_erp_binding_changes", "factory_erp_source_purges", "audit_events"] as const;

describe.sequential("genuine165 released and current void observations to166 operator reviews", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  const storageRequire = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url));
  const sdk = storageRequire("@aws-sdk/client-s3") as typeof S3Sdk;
  const client = () => new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true,
    region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const s3 = client(), purger = new FactoryErpSourcePurger(client(), process.env.S3_PRIVATE_BUCKET!);
  afterAll(async () => { try { if (child?.child.exitCode === null) await child.stop(true); }
    finally { purger.close(); s3.destroy(); await database.client.end(); } });

  it("preserves actual165 columns, released roots, exact old receipts and purged source with zero review backfill, then reviews only a current original void through source cleanup", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_FACTORY_ERP_VOID_REVIEW_LEGACY_SOURCE;
    const expectedRoot = resolve(workspace, "tmp/factory-erp-void-review-20261021-b8d4c307/old165-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Pinned actual165 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-factory-erp-void-review-b8d4c307");
    const materialized = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialized).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 2972, dependencyLinks: 309,
      sourceSha256: "73546b4a91de80515f2d0f9da67a4974f916c7dacb9a249c652bc6028b898a18" });
    expect(resolve(materialized.target)).toBe(expectedRoot); expect(source.sha256).toBe(materialized.sourceSha256); expect(source.files).toHaveLength(2972);
    const verifySource = async () => { for (const file of source.files) expect(voidReviewSha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256); };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/factory-erp-void-reviews-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"),
        E2E_LEGACY_SCHEMA_TARGET: "current", E2E_FACTORY_ERP_VOID_REVIEW_LEGACY_CHILD: "165" },
    }));
    let seeded: unknown;
    try { seeded = await child.wait("factory.erp.void.seeded165", undefined, 120_000); }
    catch (error) {
      const safeCode = /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/;
      const events = child.events.filter(event => event.type === "factory.erp.void.failed" || event.type === "factory.erp.void.phase").slice(-8).map(event => {
        const metadata: Record<string, unknown> = event;
        return { type: event.type, phase: /^[a-z][a-z0-9-]{0,63}$/.test(event.phase ?? "") ? event.phase : "unknown",
          errorName: typeof metadata.errorName === "string" && /^[A-Za-z]{1,40}Error$/.test(metadata.errorName) ? metadata.errorName : "Error",
          codes: Array.isArray(metadata.codes) ? metadata.codes.filter((code): code is string => typeof code === "string" && safeCode.test(code)).slice(0, 6) : [],
          exportKeys: Array.isArray(metadata.exportKeys) ? metadata.exportKeys.filter((key): key is string => typeof key === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key)).slice(0, 20) : [] };
      });
      const diagnostic = { exitCode: child.child.exitCode, signal: child.child.signalCode, events };
      const owned = resolve(workspace, "tmp/factory-erp-void-review-20261021-b8d4c307/qa"); await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, "legacy165-child-failure.json"), JSON.stringify(diagnostic, null, 2) + "\n");
      throw new Error(`Actual165 seed did not complete: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    const old = seeded as Original165;
    expect(await child.closed).toBe(0); expect(old.originalItems).toHaveLength(2); expect(old.replacementItems).toHaveLength(2);
    expect(old.originalVoidIds).toHaveLength(2); expect(new Set(old.originalVoidIds).size).toBe(2);
    expect(old.sources).toHaveLength(3); expect(old.sources.filter(row => row.purged)).toHaveLength(1); expect(old.applications).toHaveLength(3);
    expect(old.change.result).toMatchObject({ bindingId: old.originalBindingId, action: "correct", originalRevision: 1, replacementRevision: 2,
      replacementBindingId: old.activeBindingId, application: { observations: [{ observationId: old.activeVoidId, disposition: "exception" }] } });
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(165);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    const ids = new Map<string, string[]>();
    for (const table of originalTables) ids.set(table, (await withTenant(database.db, old.context,
      tx => tx.execute<{ id: string }>(sql`select ${table === "factory_erp_source_purges" ? sql`import_id` : sql`id`}::text as id from ${sql.identifier(table)} order by 1`))).map(row => row.id));
    // Full original columns are compared at migration; only the deliberate,
    // irreversible private redaction columns are excluded after real cleanup.
    const originalRows = async (privateColumns = true) => withTenant(database.db, old.context, async tx => {
      const result: Record<string, string> = {};
      for (const table of originalTables) result[table] = (await tx.execute<{ hash: string }>(sql`select md5(coalesce(jsonb_agg(
        ${privateColumns ? sql`to_jsonb(t)` : sql`to_jsonb(t)-ARRAY['encrypted_payload','private_redacted_at']`}
        order by ${table === "factory_erp_source_purges" ? sql`import_id` : sql`id`})::text,'[]')) as hash from ${sql.identifier(table)} t
        where ${table === "factory_erp_source_purges" ? sql`import_id` : sql`id`}=any(array[${sql.join(ids.get(table)!.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])`))[0]!.hash;
      return result;
    });
    const originalBefore = await originalRows(), metadataBefore = await originalRows(false);
    const versions = async (key: string) => {
      const response = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Prefix: key }));
      expect(response.IsTruncated).toBe(false);
      return [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])].filter(row => row.Key === key).map(row => row.VersionId).sort();
    };
    for (const row of old.sources) expect(await versions(row.objectKey)).toEqual(row.purged ? [] : [row.versionId]);
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const migrated = (await readMigrationEvidence(database)).actualRows; expect(migrated).toHaveLength(166); expect(migrated.slice(0, 165)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before); expect(await originalRows()).toEqual(originalBefore);
    const [shape] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number; forced: boolean; app: boolean }>(sql`select count(*)::int as count,
      (select relforcerowsecurity from pg_class where oid='factory_erp_void_reviews'::regclass) as forced,current_user='yummyai_app' as app from factory_erp_void_reviews`));
    expect(shape).toEqual({ count: 0, forced: true, app: true });
    const { importer, delivery } = factoryVoidOwner(database);
    for (const app of old.applications) expect(await importer.apply(old.context, app.importId, app.input)).toEqual(app.result);
    expect(await importer.changeBinding(old.context, old.originalBindingId, old.change.input)).toEqual(old.change.result);
    expect(await originalRows()).toEqual(originalBefore);
    const oldPage = await importer.voidObservations(old.context, old.originalBindingId, { limit: 1 });
    expect(oldPage).toMatchObject({ basis: { state: "released", summary: { total: 2, pending: 2, requiresOrderHandling: 0 } },
      items: [{ id: old.originalVoidIds[1], pending: true, latestReview: null }], nextCursor: expect.any(Number) });
    const tail = await importer.voidObservations(old.context, old.originalBindingId, { cursor: oldPage.nextCursor!, limit: 1 });
    expect(tail.basis.summary).toEqual(oldPage.basis.summary); expect(tail.items.map(row => row.id)).toEqual([old.originalVoidIds[0]]); expect(tail.nextCursor).toBeNull();
    const active = await importer.voidObservation(old.context, old.activeBindingId, old.activeVoidId), retained = old.sources.at(-1)!;
    expect(active).toMatchObject({ basis: { state: "active", bindingRevision: 2, summary: { total: 1, pending: 1, requiresOrderHandling: 0 } },
      observation: { id: old.activeVoidId, sourceReadable: true, latestReview: null, pending: true } });
    expect((await importer.listVoidReviews(old.context, old.originalBindingId)).items).toEqual([]);
    expect((await importer.listVoidReviews(old.context, old.activeBindingId)).items).toEqual([]);
    const request = ReviewFactoryErpVoidSchema.parse({ expectedBindingRevision: active.basis.bindingRevision, expectedItemsChecksum: active.basis.itemsChecksum,
      expectedObservationSequence: active.basis.observationSequence, observation: voidObservationIdentity(active.observation), expectedPreviousReviewId: null,
      source: { importId: retained.id, fileChecksum: retained.fileChecksum, previewChecksum: retained.previewChecksum, rowNumber: 2 },
      outcome: "confirmed_voided", reasonCode: "corrected_export", provenance: "operator_attested", confirmed: true, idempotencyKey: createEntityId() });
    const oldDetail = await importer.voidObservation(old.context, old.originalBindingId, old.originalVoidIds[1]!);
    const releasedRequest = { ...request, expectedBindingRevision: oldDetail.basis.bindingRevision, expectedItemsChecksum: oldDetail.basis.itemsChecksum,
      expectedObservationSequence: oldDetail.basis.observationSequence, observation: voidObservationIdentity(oldDetail.observation), idempotencyKey: createEntityId() };
    await expect(importer.reviewVoid(old.context, old.originalBindingId, releasedRequest)).rejects.toBeInstanceOf(ConflictException);
    expect(await originalRows()).toEqual(originalBefore);
    const result = await importer.reviewVoid(old.context, old.activeBindingId, request);
    expect(result).toMatchObject({ bindingId: old.activeBindingId, observation: request.observation, source: request.source,
      originalBindingRevision: 2, reviewRevision: 1, previousReviewId: null, outcome: "confirmed_voided" });
    expect(await importer.voidReview(old.context, old.activeBindingId, result.id)).toEqual(result);
    expect((await importer.voidObservations(old.context, old.activeBindingId)).basis.summary).toMatchObject({ total: 1, pending: 0, requiresOrderHandling: 1, nextPending: null });
    expect((await importer.voidObservations(old.context, old.originalBindingId)).basis.summary).toMatchObject({ total: 2, pending: 2 });
    expect(await originalRows()).toEqual(originalBefore);
    await withFactoryVoidSourceClock(database, async set => {
      const [expiry] = await withTenant(database.db, old.context, tx => tx.execute<{ at: string }>(sql`select to_char((max(expires_at)+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from factory_erp_imports`));
      await set(expiry!.at); const maintenance = factoryErpRetentionContext(old.context.tenantId);
      for (const row of old.sources.filter(value => !value.purged)) {
        expect(await withTenant(database.db, maintenance, tx => redactExpiredFactoryErpSources(tx, { importId: row.id }))).toBe(1);
        const [ticket] = await withTenant(database.db, maintenance, tx => claimFactoryErpSourcePurges(tx, { importId: row.id })); expect(ticket).toBeDefined();
        const proof = await purger.purge(ticket!, { signal: AbortSignal.timeout(20_000) });
        await withTenant(database.db, maintenance, tx => finishFactoryErpSourcePurge(tx, ticket!, proof)); expect(await versions(row.objectKey)).toEqual([]);
      }
      for (const app of old.applications) expect(await importer.apply(old.context, app.importId, app.input)).toEqual(app.result);
      expect(await importer.changeBinding(old.context, old.originalBindingId, old.change.input)).toEqual(old.change.result);
      expect(await importer.reviewVoid(old.context, old.activeBindingId, request)).toEqual(result);
      expect(await importer.voidReview(old.context, old.activeBindingId, result.id)).toEqual(result);
    }, "upgrade");
    expect(await originalRows(false)).toEqual(metadataBefore);
    for (const row of old.sources) {
      expect(await importer.lifecycle(old.context, row.id)).toMatchObject({ access: "expired", purgeStatus: "purged" });
      const [stored] = await withTenant(database.db, old.context, tx => tx.execute<{ proof: string; claims: unknown; cleared: boolean; stamped: boolean }>(sql`select
        source_proof as proof,source_claims as claims,encrypted_payload is null as cleared,private_redacted_at is not null as stamped from factory_erp_imports where id=${row.id}::uuid`));
      expect(stored).toMatchObject({ cleared: true, stamped: true }); expect(voidReviewSha(stored!.proof)).toBe(row.sourceProofChecksum);
      expect(voidReviewSha(JSON.stringify(stored!.claims))).toBe(row.claimsChecksum); expect(await versions(row.objectKey)).toEqual([]);
    }
    expect((await importer.voidObservation(old.context, old.activeBindingId, old.activeVoidId)).observation).toMatchObject({ sourceReadable: false, latestReview: result, pending: false, requiresOrderHandling: true });
    expect((await importer.voidObservations(old.context, old.originalBindingId)).basis.summary).toMatchObject({ total: 2, pending: 2, requiresOrderHandling: 0 });
    expect((await importer.listVoidReviews(old.context, old.activeBindingId)).items).toEqual([result]);
    const [audits] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from audit_events where action='factory_erp.void_reviewed' and entity_id=${result.id}`));
    expect(audits!.count).toBe(1);
    const preserved = before.filter(row => !originalTables.includes(row.table as typeof originalTables[number]));
    expect((await checkpoint.snapshot()).filter(row => !originalTables.includes(row.table as typeof originalTables[number]))).toEqual(preserved);
    const originalPacket = await delivery.get(old.context, old.packet.id), activePacket = await delivery.get(old.context, old.replacementPacket.id);
    for (const packet of [originalPacket, activePacket]) for (const item of packet.items) {
      const oldItem = [...old.packet.items, ...old.replacementPacket.items].find(value => value.id === item.id)!;
      expect(item.snapshot).toEqual(oldItem.snapshot); expect(item.feedback).toEqual(oldItem.feedback); expect(item.status).toBe("submitted");
      expect(item.factoryErp?.shippedQuantity).toBeNull(); expect(item.factoryErp?.privateSourceExpired).toBe(true);
    }
    for (const item of originalPacket.items) expect(item.factoryErp).toMatchObject({ bindingId: old.originalBindingId, bindingReleased: true,
      bindingReleaseId: old.change.result.id, status: null, historicalStatus: "shipped", exception: null, voidSummary: { total: 2, pending: 2 } });
    for (const item of activePacket.items) expect(item.factoryErp).toMatchObject({ bindingId: old.activeBindingId, bindingReleased: false,
      status: null, exception: null, voidSummary: { total: 1, pending: 0, requiresOrderHandling: 1 } });
    await verifySource();
  });
});
