import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Database from "../../packages/database/src/index.js";
import type * as Storage from "../../packages/storage/src/index.js";
import type * as Fixture from "../../apps/api/src/orders/factory-erp-import.test-fixture.js";
import type * as BindingContract from "../../packages/contracts/src/order/factory-erp-binding.js";
import type * as Ids from "../../packages/contracts/src/common/ids.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import type * as S3Sdk from "../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

/** Runner-only migration of an exact fresh nonce database to the actual165 prefix. */
export async function migrateFactoryErpVoidReviewLegacyDatabase(database: Database.DatabaseConnection, expectedName: string, environment: NodeJS.ProcessEnv) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^order_daily_e2e_([a-f0-9]{32})$/.exec(expectedName)?.[1];
  if (!nonce || url.pathname !== `/${expectedName}` || environment.E2E_FACTORY_ERP_VOID_REVIEW_ISOLATED !== "1" ||
      environment.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" || environment.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
      environment.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0166" ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Factory void legacy migration requires its exact fresh pre0166 database and private bucket");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== expectedName || actual.ledger !== null || actual.populated !== false)
    throw new Error("Factory void legacy migration refuses a different or populated database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ tag: string; when: number }> };
  const targets = journal.entries.filter(row => row.tag.startsWith("0166_"));
  if (targets.length !== 1) throw new Error("The canonical166 void-review migration is required");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>)
    .filter(row => row.folderMillis < targets[0]!.when);
  if (migrations.length !== 165) throw new Error("The actual165 migration prefix is required");
  await database.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedActual165() {
  // No dynamic business import, connection or I/O precedes this exact guard.
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = process.env.E2E_FACTORY_ERP_VOID_REVIEW_LEGACY_SOURCE;
  const expectedRoot = fileURLToPath(new URL("../../tmp/factory-erp-void-review-20261021-b8d4c307/old165-source", import.meta.url));
  if (!process.connected || !nonce || process.env.E2E_FACTORY_ERP_VOID_REVIEW_ISOLATED !== "1" ||
      process.env.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
      process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_VOID_REVIEW_LEGACY_CHILD !== "165" ||
      process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
      !root || !isAbsolute(root) || resolve(root) !== resolve(expectedRoot))
    throw new Error("Actual165 void IPC requires its pinned source and exact isolated database and bucket");
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "old165-database-module", cleanup = async () => {};
  try {
    const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
    const oldRequire = createRequire(pathToFileURL(resolve(root, "apps/api/package.json"))); oldRequire("reflect-metadata");
    const d = await load("packages/database/src/index.ts") as typeof Database;
    phase = "old165-esm-api-fixture";
    // The old API package is ESM. Its actual fixture keeps the old database
    // migration module's top-level await in ESM rather than requiring it as CJS.
    const oldFixture = await load("apps/api/src/orders/factory-erp-import.test-fixture.ts") as typeof Fixture;
    const { factoryErpImportFixture } = oldFixture;
    await send({ type: "factory.erp.void.phase", phase, exportKeys: Object.keys(oldFixture).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key)).sort().slice(0, 20) });
    if (typeof factoryErpImportFixture !== "function") throw Object.assign(new Error("Original165 fixture export missing"), { code: "ERR_OLD_FIXTURE_EXPORT" });
    const { ChangeFactoryErpBindingSchema } = await load("packages/contracts/src/order/factory-erp-binding.ts") as typeof BindingContract;
    const { createEntityId } = await load("packages/contracts/src/common/ids.ts") as typeof Ids;
    phase = "old165-storage-module";
    const oldStorage = await load("packages/storage/src/index.ts") as typeof Storage;
    const { sql } = oldRequire("drizzle-orm") as typeof Drizzle;
    const storageRequire = createRequire(pathToFileURL(resolve(root, "packages/storage/package.json")));
    const sdk = storageRequire("@aws-sdk/client-s3") as typeof S3Sdk;
    const client = () => new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
    const s3 = client(); cleanup = async () => { s3.destroy(); };
    phase = "old165-owner-construction";
    const database = d.connectDatabase(); cleanup = async () => { s3.destroy(); await database.client.end(); };
    const f = factoryErpImportFixture(database); cleanup = async () => { f.dispose(); s3.destroy(); await database.client.end(); };
    const purger = new oldStorage.FactoryErpSourcePurger(client(), process.env.S3_PRIVATE_BUCKET!);
    cleanup = async () => { f.dispose(); purger.close(); s3.destroy(); await database.client.end(); };
    phase = "original165-ledger";
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 165) throw new Error("Actual165 ledger required");
    await d.assertDatabaseMigrationsCurrent(database); await f.initialize();
    await s3.send(new sdk.PutBucketVersioningCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, VersioningConfiguration: { Status: "Enabled" } }));
    phase = "actual-formal-submitted-groups";
    const original = await f.scene({ quantities: [1, 2] }), replacement = await f.scene({ site: original.site, quantities: [1, 2] });
    const context = f.base.context, service = f.service(), externalId = `SYNTHETIC-ORIGINAL165-${original.order.id}`;
    const sources = [], applications = [];
    let lastView: Awaited<ReturnType<typeof service.upload>> | undefined;
    for (const [index, status] of ["已出库", "已作废", "已作废"].entries()) {
      phase = "actual-original165-source";
      const row = f.rawRow(original.quantity, status, externalId); row[6] = "2";
      row[11] = "2026-10-21 00:00:00"; row[12] = `2026-10-21 ${String(10 + index).padStart(2, "0")}:11:12`;
      const view = await service.upload(context, f.uploadInput(original.site.factory.id, [row]));
      const association = view.rows[0]?.association;
      if (!association) throw new Error("Actual165 preview association pin required");
      const originalInput = f.applyInput(view, original.items), input = { ...originalInput, rows: originalInput.rows.map(value => ({ ...value,
        association: { expectedActiveBindingId: association.activeBindingId, expectedRevision: association.revision,
          expectedReleaseId: association.releaseId, confirmed: true as const } })) };
      const result = await service.apply(context, view.id, input); lastView = view;
      const [stored] = await d.withTenant(database.db, context, tx => tx.select().from(d.factoryErpImports).where(sql`${d.factoryErpImports.id}=${view.id}`));
      if (!stored?.encryptedPayload) throw new Error("Original165 encrypted source missing");
      const scan = f.base.vault.withSecret(stored.encryptedPayload, value => JSON.parse(value).scan as { engine: string; result: string });
      if (scan.engine !== "clamav-clamd" || scan.result !== "clean") throw new Error("Actual165 clean scan required");
      const bytes = await f.storage.readPrivate(context, { id: stored.id, tenantId: context.tenantId, assetDomain: "order", objectKey: stored.objectKey }, { requiredDomain: "order" });
      try { if (sha(bytes) !== stored.storedChecksum) throw new Error("Original165 source ciphertext checksum mismatch"); } finally { bytes.fill(0); }
      const versions = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Prefix: stored.objectKey }));
      const exact = (versions.Versions ?? []).filter(value => value.Key === stored.objectKey);
      if (versions.IsTruncated || exact.length !== 1 || !exact[0]?.VersionId) throw new Error("Exact original165 private object version required");
      let purged = false;
      if (index === 0) {
        phase = "actual-original165-retention";
        const [definition] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
        const ddl = String(definition!.definition), failures: unknown[] = []; let restoredSha256: string | null = null;
        try {
          const [deadline] = await d.withTenant(database.db, context, tx => tx.execute<{ at: string }>(sql`select to_char((expires_at+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from factory_erp_imports where id=${view.id}::uuid`));
          if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(deadline!.at)) throw new Error("Exact original165 expiry required");
          const changed = ddl.replace(/AS \$function\$[\s\S]*?\$function\$/, `AS $function$ SELECT '${deadline!.at}'::timestamptz $function$`);
          if (changed === ddl) throw new Error("Unexpected original165 source clock"); await database.client.unsafe(changed);
          const maintenance = d.factoryErpRetentionContext(context.tenantId);
          if (await d.withTenant(database.db, maintenance, tx => d.redactExpiredFactoryErpSources(tx, { importId: view.id })) !== 1)
            throw new Error("Original165 redaction did not commit");
          const [ticket] = await d.withTenant(database.db, maintenance, tx => d.claimFactoryErpSourcePurges(tx, { importId: view.id }));
          if (!ticket) throw new Error("Original165 persisted purge lease missing");
          const proof = await purger.purge(ticket, { signal: AbortSignal.timeout(20_000) });
          await d.withTenant(database.db, maintenance, tx => d.finishFactoryErpSourcePurge(tx, ticket, proof)); purged = true;
        } catch (error) { failures.push(error); }
        finally {
          try {
            await database.client.unsafe(ddl);
            const [restored] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
            restoredSha256 = sha(String(restored!.definition));
            if (String(restored!.definition) !== ddl) failures.push(new Error("Original165 source-clock restoration failed"));
          } catch (error) { failures.push(error); }
          try {
            const owned = fileURLToPath(new URL("../../tmp/factory-erp-void-review-20261021-b8d4c307/qa/", import.meta.url));
            await mkdir(owned, { recursive: true });
            await writeFile(resolve(owned, "clock-legacy165.json"), JSON.stringify({ nonce, beforeSha256: sha(ddl), afterSha256: restoredSha256,
              restored: sha(ddl) === restoredSha256 }, null, 2) + "\n");
          } catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Original165 retention or exact clock restoration failed");
      }
      sources.push({ id: stored.id, objectKey: stored.objectKey, storedChecksum: stored.storedChecksum, fileChecksum: stored.fileChecksum,
        previewChecksum: stored.previewChecksum, versionId: exact[0]!.VersionId, purged, sourceProofChecksum: sha(stored.sourceProof), claimsChecksum: sha(JSON.stringify(stored.sourceClaims)) });
      applications.push({ importId: view.id, input, result });
    }
    phase = "actual-original165-correction";
    if (!lastView) throw new Error("Original165 retained void source missing");
    const originalBindingId = applications[0]!.result.observations[0]!.bindingId;
    const binding = await service.binding(context, originalBindingId);
    const changeInput = ChangeFactoryErpBindingSchema.parse({ action: "correct", expectedRevision: binding.revision, expectedItemsChecksum: binding.itemsChecksum,
      expectedObservationSequence: binding.observationSequence, source: { importId: lastView.id, fileChecksum: lastView.fileChecksum,
        previewChecksum: lastView.previewChecksum, rowNumber: lastView.rows[0]!.rowNumber }, reasonCode: "wrong_group",
      items: replacement.items, wholeGroupConfirmed: true, confirmed: true, idempotencyKey: createEntityId() });
    const changeResult = await service.changeBinding(context, originalBindingId, changeInput);
    if (!changeResult.replacementBindingId || !changeResult.application) throw new Error("Actual165 linear correction and original application required");
    const packet = await f.delivery.get(context, original.packet.id), replacementPacket = await f.delivery.get(context, replacement.packet.id);
    if (packet.items.some(item => item.status !== "submitted" || !item.factoryErp?.bindingReleased || item.factoryErp.historicalStatus !== "shipped") ||
        replacementPacket.items.some(item => item.status !== "submitted" || item.factoryErp?.exception !== "voided_requires_review"))
      throw new Error("Original165 submitted-only groups and released/current observations required");
    await send({ type: "factory.erp.void.seeded165", context, foreignContext: f.base.foreignContext, factoryId: original.site.factory.id,
      packet, replacementPacket, originalBindingId, activeBindingId: changeResult.replacementBindingId,
      originalVoidIds: applications.slice(1).map(row => row.result.observations[0]!.observationId),
      activeVoidId: changeResult.application.observations[0]!.observationId,
      originalItems: original.items, replacementItems: replacement.items, sources, applications,
      change: { input: changeInput, result: changeResult } });
  } catch (error) {
    const codes: string[] = []; let current: unknown = error;
    for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
      if ("code" in current && typeof current.code === "string" && /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(current.code)) codes.push(current.code);
      current = "cause" in current ? current.cause : null;
    }
    const errorName = error instanceof Error && /^[A-Za-z]{1,40}Error$/.test(error.name) ? error.name : "Error";
    // No raw message, SQL, parameters, source cells, environment or stderr.
    await send({ type: "factory.erp.void.failed", phase, errorName, codes, ...(codes[0] ? { code: codes[0] } : {}) });
    throw new Error("Synthetic actual165 void fixture failed");
  } finally { await cleanup(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual165();
