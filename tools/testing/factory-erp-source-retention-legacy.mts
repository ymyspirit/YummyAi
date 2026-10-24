import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.ts";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

/** Importing this runner adapter neither connects nor loads the historical graph. */
export async function migrateFactoryErpSourceRetentionLegacyDatabase(database: DatabaseConnection, expectedName: string,
  environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^order_daily_e2e_([a-f0-9]{32})$/.exec(expectedName)?.[1];
  if (!nonce || url.pathname !== `/${expectedName}` || environment.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== "pre-0164" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Factory ERP retention migration requires the exact fresh disposable pre0164 database");
  const [actual] = await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== expectedName || actual.ledger !== null || actual.populated !== false)
    throw new Error("Factory ERP retention migration refuses an existing or different database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as {
    entries: Array<{ tag: string; when: number }> };
  const targets = journal.entries.filter(row => row.tag.startsWith("0164_"));
  if (targets.length !== 1) throw new Error("The canonical164 retention migration is required");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>)
    .filter(row => row.folderMillis < targets[0]!.when);
  if (migrations.length !== 163) throw new Error("The genuine163 migration prefix is required");
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

async function seedActual163() {
  // Every guard precedes imports of business modules, connection and object I/O.
  const url = new URL(requireDisposableIntegrationEnvironment());
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const root = process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_LEGACY_SOURCE;
  const expectedRoot = fileURLToPath(new URL("../../tmp/factory-erp-lifecycle-20261021-a9f6d812/old163-source", import.meta.url));
  if (!process.connected || !nonce || process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" ||
      process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_LEGACY_CHILD !== "163" ||
      process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
      !root || !isAbsolute(root) || resolve(root) !== resolve(expectedRoot))
    throw new Error("Actual163 retention IPC requires its pinned source and exact disposable resources");
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  const oldRequire = createRequire(pathToFileURL(resolve(root, "apps/api/package.json")));
  oldRequire("reflect-metadata");
  const d = await load("packages/database/src/index.ts") as typeof import("../../packages/database/src/index.js");
  const { factoryErpImportFixture } = await load("apps/api/src/orders/factory-erp-import.test-fixture.ts") as
    typeof import("../../apps/api/src/orders/factory-erp-import.test-fixture.js");
  const { sql } = oldRequire("drizzle-orm") as typeof import("drizzle-orm");
  const storageRequire = createRequire(pathToFileURL(resolve(root, "packages/storage/package.json")));
  const { S3Client, PutBucketVersioningCommand, ListObjectVersionsCommand } = storageRequire("@aws-sdk/client-s3") as
    typeof import("../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js");
  const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const database = d.connectDatabase(), fixture = factoryErpImportFixture(database);
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  let phase = "ledger";
  try {
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 163) throw new Error("Actual163 migration ledger required");
    await d.assertDatabaseMigrationsCurrent(database);
    phase = "real-template-and-group";
    await fixture.initialize();
    await s3.send(new PutBucketVersioningCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, VersioningConfiguration: { Status: "Enabled" } }));
    const scene = await fixture.scene({ quantities: [1, 2] }), importer = fixture.service(), context = fixture.base.context;
    if (scene.items.length !== 2 || scene.packet.items.some(item => item.status !== "submitted" || item.feedback.length !== 1 || item.feedback[0]!.kind !== "submitted"))
      throw new Error("Actual163 two-item submitted-only delivery group required");
    const sources = [], applications = [];
    const externalId = `SYNTHETIC-RETENTION-ORIGINAL163-${scene.order.id}`;
    for (const [index, status] of ["已审核", "已出库", "已作废"].entries()) {
      phase = "actual-scan-import-apply";
      const row = fixture.rawRow(scene.quantity, status, externalId);
      row[6] = "2"; row[12] = `2026-10-21 ${String(10 + index).padStart(2, "0")}:11:12`;
      const upload = fixture.uploadInput(scene.site.factory.id, [row]), view = await importer.upload(context, upload);
      const input = fixture.applyInput(view, scene.items), result = await importer.apply(context, view.id, input);
      const [stored] = await d.withTenant(database.db, context, tx => tx.select().from(d.factoryErpImports).where(sql`${d.factoryErpImports.id}=${view.id}`));
      if (!stored?.encryptedPayload) throw new Error("Original163 encrypted source required");
      const scan = fixture.base.vault.withSecret(stored.encryptedPayload, value => JSON.parse(value).scan as { engine: string; result: string });
      if (scan.engine !== "clamav-clamd" || scan.result !== "clean") throw new Error("Actual163 clean ClamAV evidence required");
      const cipher = await fixture.storage.readPrivate(context, { id: stored.id, tenantId: context.tenantId, assetDomain: "order", objectKey: stored.objectKey }, { requiredDomain: "order" });
      try { if (sha(cipher) !== stored.storedChecksum) throw new Error("Original163 ciphertext checksum mismatch"); }
      finally { cipher.fill(0); }
      const versions = await s3.send(new ListObjectVersionsCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Prefix: stored.objectKey }));
      const exact = (versions.Versions ?? []).filter(version => version.Key === stored.objectKey);
      if (exact.length !== 1 || !exact[0]!.VersionId) throw new Error("Original163 versioned private source required");
      sources.push({ id: stored.id, objectKey: stored.objectKey, storedChecksum: stored.storedChecksum, fileChecksum: stored.fileChecksum,
        previewChecksum: stored.previewChecksum, requestChecksum: stored.requestChecksum, expiresAt: stored.expiresAt.toISOString(),
        versionId: exact[0]!.VersionId, sourceProofChecksum: sha(stored.sourceProof), claimsChecksum: sha(JSON.stringify(stored.sourceClaims)) });
      applications.push({ importId: view.id, input, result });
    }
    const packet = await fixture.delivery.get(context, scene.packet.id);
    if (packet.items.some(item => item.factoryErp?.status !== "shipped" || item.factoryErp.exception !== "voided_requires_review"))
      throw new Error("Original163 saved shipment and void exception required");
    await send({ type: "factory.erp.retention.seeded163", context, foreignContext: fixture.base.foreignContext, factoryId: scene.site.factory.id,
      packet, items: scene.items, productionIds: scene.productions.map(value => value.order.id), sources, applications });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : undefined;
    await send({ type: "factory.erp.retention.failed", phase, ...(code ? { code } : {}) });
    throw new Error("Synthetic genuine163 factory ERP retention setup failed");
  } finally { fixture.dispose(); s3.destroy(); await database.client.end(); }
}

/** A test-only process boundary around the real storage and database owners. */
async function purgeCurrentChild(mode: string) {
  const url = new URL(requireDisposableIntegrationEnvironment());
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!process.connected || !nonce || !["pause_after_delete", "finish"].includes(mode) ||
      process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
      process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Purge crash IPC requires its exact current disposable database and bucket");
  const incoming = new Promise<import("../../packages/database/src/factory-erp-source-retention.js").FactoryErpPurgeTicket>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic purge-ticket IPC deadline")), 15_000);
    process.once("message", value => {
      clearTimeout(timer);
      if (!value || typeof value !== "object" || !("type" in value) || value.type !== "factory.erp.retention.purge" || !("ticket" in value))
        return reject(new Error("Synthetic purge-ticket IPC shape invalid"));
      done(value.ticket as import("../../packages/database/src/factory-erp-source-retention.js").FactoryErpPurgeTicket);
    });
  });
  const d = await import("../../packages/database/src/index.js");
  const { createFactoryErpSourcePurgerFromEnvironment } = await import("../../packages/storage/src/index.js");
  const database = d.connectDatabase(), purger = createFactoryErpSourcePurgerFromEnvironment();
  const send = (value: object) => new Promise<void>((done, reject) => process.send!(value, error => error ? reject(error) : done()));
  try {
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 164) throw new Error("Current164 purge child required");
    await send({ type: "factory.erp.retention.ready" });
    const ticket = await incoming, receipt = await purger.purge(ticket);
    await send({ type: "factory.erp.retention.deleted", importId: ticket.importId, deletedVersions: receipt.deletedVersions });
    if (mode === "pause_after_delete") {
      // The parent deliberately kills this process at a proven external-I/O
      // boundary. A finite deadline still lets an abandoned child close itself.
      await new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Synthetic post-delete crash gate deadline")), 30_000));
    } else {
      const result = await d.withTenant(database.db, d.factoryErpRetentionContext(ticket.tenantId), tx => d.finishFactoryErpSourcePurge(tx, ticket, receipt));
      await send({ type: "factory.erp.retention.completed", ...result, deletedVersions: receipt.deletedVersions });
    }
  } finally { purger.close(); await database.client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_PURGE_CHILD;
  if (mode) await purgeCurrentChild(mode); else await seedActual163();
}
