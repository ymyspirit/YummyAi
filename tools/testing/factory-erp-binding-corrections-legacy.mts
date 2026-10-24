import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Database from "../../packages/database/src/index.js";
import type * as Storage from "../../packages/storage/src/index.js";
import type * as Fixture from "../../apps/api/src/orders/factory-erp-import.test-fixture.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import type * as S3Sdk from "../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

/** Runner-only fresh database migration. All authority comes from the explicit
 * environment argument, not a fallback to the ordinary local environment. */
export async function migrateFactoryErpBindingLegacyDatabase(database: Database.DatabaseConnection, expectedName: string, environment: NodeJS.ProcessEnv) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^order_daily_e2e_([a-f0-9]{32})$/.exec(expectedName)?.[1];
  if (!nonce || url.pathname !== `/${expectedName}` || environment.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" ||
      environment.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || environment.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0165" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Factory binding legacy migration requires its exact fresh pre0165 database and private bucket");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== expectedName || actual.ledger !== null || actual.populated !== false)
    throw new Error("Factory binding legacy migration refuses a different or populated database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ tag: string; when: number }> };
  const targets = journal.entries.filter(row => row.tag.startsWith("0165_"));
  if (targets.length !== 1) throw new Error("The canonical165 binding migration is required");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>)
    .filter(row => row.folderMillis < targets[0]!.when);
  if (migrations.length !== 164) throw new Error("The actual164 migration prefix is required");
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

async function seedActual164() {
  // No business import, connection, scanner or storage operation precedes this.
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = process.env.E2E_FACTORY_ERP_BINDING_LEGACY_SOURCE;
  const expectedRoot = fileURLToPath(new URL("../../tmp/factory-erp-binding-20261021-c6b2e941/old164-source", import.meta.url));
  if (!process.connected || !nonce || process.env.E2E_FACTORY_ERP_BINDING_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
      process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_BINDING_LEGACY_CHILD !== "164" ||
      process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
      !root || !isAbsolute(root) || resolve(root) !== resolve(expectedRoot))
    throw new Error("Actual164 binding IPC requires its pinned source and exact isolated database and bucket");
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  const oldRequire = createRequire(pathToFileURL(resolve(root, "apps/api/package.json"))); oldRequire("reflect-metadata");
  const d = await load("packages/database/src/index.ts") as typeof Database;
  const { factoryErpImportFixture } = await load("apps/api/src/orders/factory-erp-import.test-fixture.ts") as typeof Fixture;
  const oldStorage = await load("packages/storage/src/index.ts") as typeof Storage;
  const { sql } = oldRequire("drizzle-orm") as typeof Drizzle;
  const storageRequire = createRequire(pathToFileURL(resolve(root, "packages/storage/package.json")));
  const sdk = storageRequire("@aws-sdk/client-s3") as typeof S3Sdk;
  const s3 = new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const database = d.connectDatabase(), f = factoryErpImportFixture(database), purger = new oldStorage.FactoryErpSourcePurger(new sdk.S3Client({
    endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } }), process.env.S3_PRIVATE_BUCKET!);
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "original164-ledger";
  try {
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 164) throw new Error("Actual164 ledger required");
    await d.assertDatabaseMigrationsCurrent(database); await f.initialize();
    await s3.send(new sdk.PutBucketVersioningCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, VersioningConfiguration: { Status: "Enabled" } }));
    phase = "actual-formal-submitted-groups";
    const original = await f.scene({ quantities: [1, 2] }), replacement = await f.scene({ site: original.site, quantities: [1, 2] });
    const context = f.base.context, service = f.service(), externalId = `SYNTHETIC-ORIGINAL164-${original.order.id}`;
    const sources = [], applications = [];
    for (const [index, status] of ["已审核", "已出库", "已作废"].entries()) {
      phase = "actual-original164-source";
      const row = f.rawRow(original.quantity, status, externalId); row[6] = "2"; row[12] = `2026-10-21 ${String(10 + index).padStart(2, "0")}:11:12`;
      const view = await service.upload(context, f.uploadInput(original.site.factory.id, [row])), input = f.applyInput(view, original.items);
      const result = await service.apply(context, view.id, input);
      const [stored] = await d.withTenant(database.db, context, tx => tx.select().from(d.factoryErpImports).where(sql`${d.factoryErpImports.id}=${view.id}`));
      if (!stored?.encryptedPayload) throw new Error("Original164 encrypted source missing");
      const scan = f.base.vault.withSecret(stored.encryptedPayload, value => JSON.parse(value).scan as { engine: string; result: string });
      if (scan.engine !== "clamav-clamd" || scan.result !== "clean") throw new Error("Actual164 clean scan required");
      const bytes = await f.storage.readPrivate(context, { id: stored.id, tenantId: context.tenantId, assetDomain: "order", objectKey: stored.objectKey }, { requiredDomain: "order" });
      try { if (sha(bytes) !== stored.storedChecksum) throw new Error("Original164 source ciphertext checksum mismatch"); } finally { bytes.fill(0); }
      const version = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Prefix: stored.objectKey }));
      const exact = (version.Versions ?? []).filter(value => value.Key === stored.objectKey);
      if (version.IsTruncated || exact.length !== 1 || !exact[0]?.VersionId) throw new Error("Exact original164 private object version required");
      let purged = false;
      if (index === 0) {
        phase = "actual-original164-retention";
        const [definition] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
        const ddl = String(definition!.definition);
        const failures: unknown[] = []; let restoredSha256: string | null = null;
        try {
          const [deadline] = await d.withTenant(database.db, context, tx => tx.execute<{ at: string }>(sql`select to_char((expires_at+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from factory_erp_imports where id=${view.id}::uuid`));
          if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(deadline!.at)) throw new Error("Exact original164 expiry required");
          const changed = ddl.replace(/AS \$function\$[\s\S]*?\$function\$/, `AS $function$ SELECT '${deadline!.at}'::timestamptz $function$`);
          if (changed === ddl) throw new Error("Unexpected original164 source clock"); await database.client.unsafe(changed);
          const maintenance = d.factoryErpRetentionContext(context.tenantId);
          if (await d.withTenant(database.db, maintenance, tx => d.redactExpiredFactoryErpSources(tx, { importId: view.id })) !== 1)
            throw new Error("Original164 redaction did not commit");
          const [ticket] = await d.withTenant(database.db, maintenance, tx => d.claimFactoryErpSourcePurges(tx, { importId: view.id }));
          if (!ticket) throw new Error("Original164 persisted purge lease missing");
          const proof = await purger.purge(ticket, { signal: AbortSignal.timeout(20_000) });
          await d.withTenant(database.db, maintenance, tx => d.finishFactoryErpSourcePurge(tx, ticket, proof)); purged = true;
        } catch (error) { failures.push(error); }
        finally {
          try {
            await database.client.unsafe(ddl);
            const [restored] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
            restoredSha256 = sha(String(restored!.definition));
            if (String(restored!.definition) !== ddl) failures.push(new Error("Original164 source-clock restoration failed"));
          } catch (error) { failures.push(error); }
          try {
            const owned = fileURLToPath(new URL("../../tmp/factory-erp-binding-20261021-c6b2e941/qa/", import.meta.url));
            await mkdir(owned, { recursive: true });
            await writeFile(resolve(owned, "clock-legacy164.json"), JSON.stringify({ nonce, beforeSha256: sha(ddl), afterSha256: restoredSha256,
              restored: sha(ddl) === restoredSha256 }, null, 2) + "\n");
          } catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Original164 retention or exact clock restoration failed");
      }
      sources.push({ id: stored.id, objectKey: stored.objectKey, storedChecksum: stored.storedChecksum, fileChecksum: stored.fileChecksum,
        previewChecksum: stored.previewChecksum, versionId: exact[0]!.VersionId, purged, sourceProofChecksum: sha(stored.sourceProof), claimsChecksum: sha(JSON.stringify(stored.sourceClaims)) });
      applications.push({ importId: view.id, input, result });
    }
    const packet = await f.delivery.get(context, original.packet.id);
    if (packet.items.some(item => item.status !== "submitted" || item.factoryErp?.status !== "shipped" || item.factoryErp.exception !== "voided_requires_review"))
      throw new Error("Original164 submitted group and original factory observations required");
    await send({ type: "factory.erp.binding.seeded164", context, foreignContext: f.base.foreignContext, factoryId: original.site.factory.id,
      packet, replacementPacket: replacement.packet, originalItems: original.items, replacementItems: replacement.items, sources, applications });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : undefined;
    await send({ type: "factory.erp.binding.failed", phase, ...(code ? { code } : {}) });
    throw new Error("Synthetic actual164 binding fixture failed");
  } finally { f.dispose(); purger.close(); s3.destroy(); await database.client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual164();
