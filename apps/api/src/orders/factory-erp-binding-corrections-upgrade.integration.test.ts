import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ChangeFactoryErpBindingSchema } from "@yummyai/contracts/order/factory-erp-binding";
import type { ApplyFactoryErpImport, FactoryErpApplyResult, FactoryErpItemSelection } from "@yummyai/contracts/order/factory-erp-import";
import type { ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant,
  factoryErpRetentionContext, redactExpiredFactoryErpSources, claimFactoryErpSourcePurges, finishFactoryErpSourcePurge } from "@yummyai/database";
import { FactoryErpSourcePurger } from "@yummyai/storage";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { bindingSha, factoryBindingOwner, requireFactoryBindingEnvironment, withFactoryBindingSourceClock } from "../../../../tools/testing/factory-erp-binding-corrections-fixture.js";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

requireFactoryBindingEnvironment("pre-0165");
type Original164 = {
  context: TenantContext; foreignContext: TenantContext; factoryId: string;
  packet: ProductionDeliveryPackageView; replacementPacket: ProductionDeliveryPackageView;
  originalItems: FactoryErpItemSelection[]; replacementItems: FactoryErpItemSelection[];
  sources: Array<{ id: string; objectKey: string; storedChecksum: string; fileChecksum: string; previewChecksum: string;
    versionId: string; purged: boolean; sourceProofChecksum: string; claimsChecksum: string }>;
  applications: Array<{ importId: string; input: ApplyFactoryErpImport; result: FactoryErpApplyResult }>;
};
const originalTables = ["factory_erp_imports", "factory_erp_applications", "factory_erp_bindings", "factory_erp_binding_items", "factory_erp_observations", "factory_erp_application_rows", "factory_erp_source_purges", "audit_events"] as const;

describe.sequential("genuine164 bindings and physical source purge to165 explicit corrections", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  const storageRequire = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url));
  const sdk = storageRequire("@aws-sdk/client-s3") as typeof S3Sdk;
  const makeClient = () => new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true,
    region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const s3 = makeClient(), purger = new FactoryErpSourcePurger(makeClient(), process.env.S3_PRIVATE_BUCKET!);
  afterAll(async () => { try { if (child?.child.exitCode === null) await child.stop(true); }
    finally { purger.close(); s3.destroy(); await database.client.end(); } });

  it("preserves actual164 original columns, receipts and completed purge with zero correction backfill, then corrects a redacted original binding and retains its history through cleanup", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_FACTORY_ERP_BINDING_LEGACY_SOURCE;
    const expectedRoot = resolve(workspace, "tmp/factory-erp-binding-20261021-c6b2e941/old164-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Pinned actual164 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-factory-erp-binding-c6b2e941");
    const materialized = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialized).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 2958, dependencyLinks: 309,
      sourceSha256: "347563573fd3ac1949258a3cc26dc66cb9a52c33ebb061a25b4df51f18da0667" });
    expect(resolve(materialized.target)).toBe(expectedRoot); expect(source.sha256).toBe(materialized.sourceSha256); expect(source.files).toHaveLength(2958);
    const verifySource = async () => { for (const file of source.files) expect(bindingSha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256); };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/factory-erp-binding-corrections-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"),
        E2E_LEGACY_SCHEMA_TARGET: "current", E2E_FACTORY_ERP_BINDING_LEGACY_CHILD: "164" },
    }));
    const old = await child.wait("factory.erp.binding.seeded164", undefined, 120_000) as unknown as Original164;
    expect(await child.closed).toBe(0); expect(old.originalItems).toHaveLength(2); expect(old.replacementItems).toHaveLength(2);
    expect(old.sources).toHaveLength(3); expect(old.sources.filter(row => row.purged)).toHaveLength(1); expect(old.applications).toHaveLength(3);
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(164);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    const originalIds = new Map<string, string[]>();
    for (const table of originalTables) originalIds.set(table, (await withTenant(database.db, old.context,
      tx => tx.execute<{ id: string }>(sql`select ${table === "factory_erp_source_purges" ? sql`import_id` : sql`id`}::text as id from ${sql.identifier(table)} order by 1`))).map(row => row.id));
    const originalRows = async () => withTenant(database.db, old.context, async tx => {
      const result: Record<string, string> = {};
      for (const table of originalTables) result[table] = (await tx.execute<{ hash: string }>(sql`select md5(coalesce(jsonb_agg(
        to_jsonb(t)-ARRAY['revision','previous_binding_id','released_by'] order by ${table === "factory_erp_source_purges" ? sql`import_id` : sql`id`})::text,'[]')) as hash from ${sql.identifier(table)} t
        where ${table === "factory_erp_source_purges" ? sql`import_id` : sql`id`}=any(array[${sql.join(originalIds.get(table)!.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])`))[0]!.hash;
      return result;
    });
    const originalBefore = await originalRows();
    const versions = async (key: string) => {
      const response = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Prefix: key }));
      expect(response.IsTruncated).toBe(false);
      return [...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])].filter(row => row.Key === key).map(row => row.VersionId).sort();
    };
    for (const row of old.sources) expect(await versions(row.objectKey)).toEqual(row.purged ? [] : [row.versionId]);
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const migrated = (await readMigrationEvidence(database)).actualRows; expect(migrated).toHaveLength(165); expect(migrated.slice(0, 164)).toEqual(journal);
    expect(await checkpoint.snapshot()).toEqual(before); expect(await originalRows()).toEqual(originalBefore);
    const [shape] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number; forced: boolean; app: boolean }>(sql`select count(*)::int as count,
      (select relforcerowsecurity from pg_class where oid='factory_erp_binding_changes'::regclass) as forced,current_user='yummyai_app' as app from factory_erp_binding_changes`));
    expect(shape).toEqual({ count: 0, forced: true, app: true });
    const [defaults] = await withTenant(database.db, old.context, tx => tx.execute<{ roots: number; items: number }>(sql`select
      (select count(*) from factory_erp_bindings where revision<>1 or previous_binding_id is not null or released_by is not null)::int as roots,
      (select count(*) from factory_erp_binding_items where released_by is not null)::int as items`)); expect(defaults).toEqual({ roots: 0, items: 0 });
    const { importer, delivery } = factoryBindingOwner(database);
    expect(await delivery.get(old.context, old.packet.id)).toMatchObject(old.packet);
    for (const app of old.applications) expect(await importer.apply(old.context, app.importId, app.input)).toEqual(app.result);
    expect(await originalRows()).toEqual(originalBefore);
    const bindingId = old.applications[0]!.result.observations[0]!.bindingId, binding = await importer.binding(old.context, bindingId);
    const retainedSource = old.sources.at(-1)!;
    expect(binding).toMatchObject({ revision: 1, previousBindingId: null, releasedBy: null, state: "active", recordedStatus: "shipped", recordedException: "voided_requires_review" });
    const [redactedBinding] = await withTenant(database.db, old.context, tx => tx.execute<{ cleared: boolean; stamped: boolean }>(sql`select encrypted_payload is null as cleared,private_redacted_at is not null as stamped from factory_erp_bindings where id=${bindingId}::uuid`));
    expect(redactedBinding).toEqual({ cleared: true, stamped: true });
    const input = ChangeFactoryErpBindingSchema.parse({ action: "correct", expectedRevision: binding.revision, expectedItemsChecksum: binding.itemsChecksum,
      expectedObservationSequence: binding.observationSequence, source: { importId: retainedSource.id, fileChecksum: retainedSource.fileChecksum,
        previewChecksum: retainedSource.previewChecksum, rowNumber: 2 }, reasonCode: "wrong_group", items: old.replacementItems,
      wholeGroupConfirmed: true, confirmed: true, idempotencyKey: createEntityId() });
    const result = await importer.changeBinding(old.context, bindingId, input);
    expect(result).toMatchObject({ bindingId, action: "correct", originalRevision: 1, replacementRevision: 2,
      application: { importId: retainedSource.id, appliedRows: 1, observations: [{ rowNumber: 2, status: null, disposition: "exception" }] } });
    expect(await importer.binding(old.context, result.replacementBindingId!)).toMatchObject({ revision: 2, previousBindingId: bindingId, state: "active", recordedStatus: null, recordedException: "voided_requires_review" });
    expect(await originalRows()).toEqual(originalBefore);
    for (const app of old.applications) expect(await importer.apply(old.context, app.importId, app.input)).toEqual(app.result);
    const legacyUnsubmitted = { ...old.applications.at(-1)!.input, idempotencyKey: createEntityId() };
    await expect(importer.apply(old.context, retainedSource.id, legacyUnsubmitted)).rejects.toBeInstanceOf(ConflictException);
    await withFactoryBindingSourceClock(database, async set => {
      const [expiry] = await withTenant(database.db, old.context, tx => tx.execute<{ at: string }>(sql`select to_char((max(expires_at)+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from factory_erp_imports`));
      await set(expiry!.at);
      const maintenance = factoryErpRetentionContext(old.context.tenantId);
      for (const row of old.sources.filter(value => !value.purged)) {
        expect(await withTenant(database.db, maintenance, tx => redactExpiredFactoryErpSources(tx, { importId: row.id }))).toBe(1);
        const [ticket] = await withTenant(database.db, maintenance, tx => claimFactoryErpSourcePurges(tx, { importId: row.id })); expect(ticket).toBeDefined();
        const proof = await purger.purge(ticket!, { signal: AbortSignal.timeout(20_000) });
        await withTenant(database.db, maintenance, tx => finishFactoryErpSourcePurge(tx, ticket!, proof)); expect(await versions(row.objectKey)).toEqual([]);
      }
      expect(await importer.changeBinding(old.context, bindingId, input)).toEqual(result);
      expect(await importer.bindingChange(old.context, bindingId, result.id)).toEqual(result);
    }, "upgrade");
    expect(await importer.binding(old.context, bindingId)).toMatchObject({ state: "released", releasedBy: result.id, nextBindingId: result.replacementBindingId, release: result });
    for (const row of old.sources) expect(await importer.lifecycle(old.context, row.id)).toMatchObject({ access: "expired", purgeStatus: "purged" });
    const preserved = before.filter(row => !originalTables.includes(row.table as typeof originalTables[number]));
    expect((await checkpoint.snapshot()).filter(row => !originalTables.includes(row.table as typeof originalTables[number]))).toEqual(preserved);
    const oldDelivery = await delivery.get(old.context, old.packet.id);
    for (const item of oldDelivery.items) {
      const original = old.packet.items.find(row => row.id === item.id)!;
      expect(item.snapshot).toEqual(original.snapshot); expect(item.feedback).toEqual(original.feedback); expect(item.status).toBe("submitted");
      expect(item.factoryErp).toMatchObject({ bindingId, bindingRevision: 1, bindingReleased: true, bindingReleaseId: result.id,
        status: null, historicalStatus: "shipped", exception: null, importId: old.applications[1]!.importId, shippedQuantity: null, privateSourceExpired: true });
    }
    await verifySource();
  });
});
