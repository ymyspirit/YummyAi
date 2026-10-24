import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotFoundException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import type { ApplyFactoryErpImport, FactoryErpApplyResult, FactoryErpItemSelection } from "@yummyai/contracts/order/factory-erp-import";
import type { ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant,
  factoryErpRetentionContext, FACTORY_ERP_RETENTION_ACTOR, redactExpiredFactoryErpSources, claimFactoryErpSourcePurges,
  finishFactoryErpSourcePurge } from "@yummyai/database";
import { createStorageFromEnvironment, ClamAvScanner, FactoryErpSourcePurger } from "@yummyai/storage";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { ClamAvProductionEditorScanner, ProductionEditorService } from "../design/production-editor.service.js";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { HttpAmazonReportArchiveGateway } from "./amazon-report-archive.gateway.js";
import { FactoryErpImportService } from "./factory-erp-import.service.js";
import { FactoryErpSourceGateway } from "./factory-erp-source.gateway.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderService } from "./order.service.js";

const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (!nonce || process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_ISOLATED !== "1" || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0164" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory ERP source retention upgrade requires its exact disposable genuine163 database and bucket before connection");
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const tables = ["factory_erp_imports", "factory_erp_applications", "factory_erp_bindings", "factory_erp_binding_items", "factory_erp_observations", "factory_erp_application_rows"] as const;
type Original163 = {
  context: TenantContext; foreignContext: TenantContext; factoryId: string; packet: ProductionDeliveryPackageView;
  items: FactoryErpItemSelection[]; productionIds: string[];
  sources: Array<{ id: string; objectKey: string; storedChecksum: string; fileChecksum: string; previewChecksum: string;
    requestChecksum: string; expiresAt: string; versionId: string; sourceProofChecksum: string; claimsChecksum: string }>;
  applications: Array<{ importId: string; input: ApplyFactoryErpImport; result: FactoryErpApplyResult }>;
};

describe.sequential("genuine163 scanned factory source graph to164 physical retention", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  const requireStorage = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url));
  const sdk = requireStorage("@aws-sdk/client-s3") as typeof S3Sdk;
  const makeClient = () => new sdk.S3Client({ endpoint: process.env.S3_ENDPOINT!, forcePathStyle: true,
    region: process.env.S3_REGION ?? "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const s3 = makeClient(), purger = new FactoryErpSourcePurger(makeClient(), process.env.S3_PRIVATE_BUCKET!);
  afterAll(async () => { try { if (child?.child.exitCode === null) await child.stop(true); }
    finally { purger.close(); s3.destroy(); await database.client.end(); } });

  it("preserves the complete actual163 scanned two-item graph at migration then irreversibly purges only its private copies and replays its original non-private results", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_FACTORY_ERP_SOURCE_RETENTION_LEGACY_SOURCE;
    const expectedRoot = resolve(workspace, "tmp/factory-erp-lifecycle-20261021-a9f6d812/old163-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Pinned original163 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-factory-erp-lifecycle-a9f6d812");
    const materialization = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialization).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false,
      sourceFiles: 2942, dependencyLinks: 309, sourceSha256: "cdda52a98abcd7742430edacf42aebe801d0057f78f1bd98e67cdd9ec1874b1a" });
    expect(resolve(materialization.target)).toBe(expectedRoot); expect(source.sha256).toBe(materialization.sourceSha256); expect(source.files).toHaveLength(2942);
    const verifySource = async () => { for (const file of source.files) expect(sha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256); };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/factory-erp-source-retention-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"),
        E2E_LEGACY_SCHEMA_TARGET: "current", E2E_FACTORY_ERP_SOURCE_RETENTION_LEGACY_CHILD: "163" },
    }));
    const old = await child.wait("factory.erp.retention.seeded163", undefined, 120_000) as unknown as Original163;
    expect(await child.closed).toBe(0); expect(old.items).toHaveLength(2); expect(old.sources).toHaveLength(3); expect(old.applications).toHaveLength(3);
    const journal = (await readMigrationEvidence(database)).actualRows; expect(journal).toHaveLength(163);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    const oldUsers = (await database.client.unsafe("select id::text as id from app_users order by id")).map(row => String(row.id));
    const originalUsers = async () => (await database.client.unsafe("select md5(coalesce(jsonb_agg(to_jsonb(u) order by id)::text,'[]')) as hash from app_users u where id=any($1::uuid[])", [oldUsers]))[0]!.hash;
    const usersBefore = await originalUsers();
    const originalMeta = async () => withTenant(database.db, old.context, async tx => {
      const hashes: Record<string, string> = {};
      for (const table of tables) hashes[table] = (await tx.execute<{ hash: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(t)-'encrypted_payload'-'private_redacted_at' order by id)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!.hash;
      return hashes;
    });
    const metadataBefore = await originalMeta();
    const oldAuditIds = (await withTenant(database.db, old.context, tx => tx.execute<{ id: string }>(sql`select id::text as id from audit_events order by id`))).map(row => row.id);
    const originalAudits = async () => (await withTenant(database.db, old.context, tx => tx.execute<{ hash: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(a) order by id)::text,'[]')) as hash from audit_events a where id=any(array[${sql.join(oldAuditIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])`)))[0]!.hash;
    const auditsBefore = await originalAudits();
    const exactVersions = async (key: string) => {
      const value = await s3.send(new sdk.ListObjectVersionsCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Prefix: key }));
      expect(value.IsTruncated).toBe(false);
      return [...(value.Versions ?? []), ...(value.DeleteMarkers ?? [])].filter(item => item.Key === key).map(item => item.VersionId).sort();
    };
    const verifyObjects = async () => {
      for (const original of old.sources) {
        expect(await exactVersions(original.objectKey)).toEqual([original.versionId]);
        const object = await s3.send(new sdk.GetObjectCommand({ Bucket: process.env.S3_PRIVATE_BUCKET!, Key: original.objectKey, VersionId: original.versionId }));
        const bytes = await object.Body!.transformToByteArray(); try { expect(sha(bytes)).toBe(original.storedChecksum); } finally { bytes.fill(0); }
      }
    };
    await verifyObjects();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const migrated = (await readMigrationEvidence(database)).actualRows; expect(migrated).toHaveLength(164); expect(migrated.slice(0, 163)).toEqual(journal);
    expect((await checkpoint.snapshot()).filter(row => row.table !== "app_users")).toEqual(before.filter(row => row.table !== "app_users"));
    expect(await originalUsers()).toBe(usersBefore);
    const system = await database.client.unsafe("select id::text as id,oidc_subject from app_users where not(id=any($1::uuid[]))", [oldUsers]);
    expect(system).toHaveLength(1); expect(system[0]).toEqual({ id: FACTORY_ERP_RETENTION_ACTOR, oidc_subject: "system:factory-erp-source-retention" });
    const [shape] = await database.client.unsafe("select count(*)::int as rows,(select relforcerowsecurity from pg_class where oid='factory_erp_source_purges'::regclass) as forced from factory_erp_source_purges");
    expect(shape).toEqual({ rows: 0, forced: true }); expect(await originalMeta()).toEqual(metadataBefore); await verifyObjects();
    const [newPrivate] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select
      (select count(*) from factory_erp_imports where private_redacted_at is not null)+(select count(*) from factory_erp_bindings where private_redacted_at is not null)+
      (select count(*) from factory_erp_observations where private_redacted_at is not null) as count`)); expect(Number(newPrivate!.count)).toBe(0);

    const vault = new SecretVault(Buffer.alloc(32, 121)), audit = new AuditService(database), storage = createStorageFromEnvironment();
    const orders = new OrderService(database, vault, audit), factories = new FactoryDirectoryService(database, audit);
    const reports = new AmazonOrderReportService(database, vault, orders, audit, new HttpAmazonReportArchiveGateway(), { schedule: async () => undefined }, { schedule: async () => undefined });
    const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: async () => undefined }, new ClamAvProductionEditorScanner());
    const production = new OrderProductionService(database, vault, orders, audit, editor, factories), delivery = new OrderProductionDeliveryService(database, vault, editor, production, audit, factories);
    const importer = new FactoryErpImportService(database, vault, new FactoryErpSourceGateway(storage, vault, new ClamAvScanner()), delivery, audit);
    expect(await delivery.get(old.context, old.packet.id)).toEqual(old.packet);
    for (const app of old.applications) expect(await importer.apply(old.context, app.importId, app.input)).toEqual(app.result);
    expect(await originalAudits()).toBe(auditsBefore);
    const [definition] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
    const originalDefinition = String(definition!.definition), beforeClock = sha(originalDefinition); let afterClock: string | null = null;
    try {
      const [deadline] = await withTenant(database.db, old.context, tx => tx.execute<{ at: string }>(sql`select to_char((max(expires_at)+interval '1 second') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from factory_erp_imports`));
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(deadline!.at)) throw new Error("Exact original163 source expiry required");
      const altered = originalDefinition.replace(/AS \$function\$[\s\S]*?\$function\$/, `AS $function$ SELECT '${deadline!.at}'::timestamptz $function$`);
      if (altered === originalDefinition) throw new Error("Unexpected retention clock shape"); await database.client.unsafe(altered);
      for (const original of old.sources) {
        const current = factoryErpRetentionContext(old.context.tenantId);
        await expect(withTenant(database.db, old.foreignContext, tx => tx.execute(sql`select import_id from factory_erp_source_purges where import_id=${original.id}::uuid`))).resolves.toHaveLength(0);
        expect(await withTenant(database.db, current, tx => redactExpiredFactoryErpSources(tx, { importId: original.id }))).toBe(1);
        const tickets = await withTenant(database.db, current, tx => claimFactoryErpSourcePurges(tx, { importId: original.id })); expect(tickets).toHaveLength(1);
        const receipt = await purger.purge(tickets[0]!); expect(receipt).toEqual({ verifiedAbsent: true, deletedVersions: 1 });
        await withTenant(database.db, current, tx => finishFactoryErpSourcePurge(tx, tickets[0]!, receipt)); expect(await exactVersions(original.objectKey)).toEqual([]);
        expect(await importer.lifecycle(old.context, original.id)).toMatchObject({ access: "expired", purgeStatus: "purged", attempts: 1 });
      }
      for (const app of old.applications) {
        expect(await importer.apply(old.context, app.importId, app.input)).toEqual(app.result);
        expect(await importer.application(old.context, app.importId, app.result.id)).toEqual(app.result);
        await expect(importer.get(old.context, app.importId, {})).rejects.toBeInstanceOf(NotFoundException);
      }
      const [remainingPrivate] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select
        (select count(*) from factory_erp_imports where encrypted_payload is not null or private_redacted_at is null)+
        (select count(*) from factory_erp_bindings where encrypted_payload is not null or private_redacted_at is null)+
        (select count(*) from factory_erp_observations where encrypted_payload is not null or private_redacted_at is null) as count`));
      expect(Number(remainingPrivate!.count)).toBe(0);
      expect(await originalMeta()).toEqual(metadataBefore); expect(await originalAudits()).toBe(auditsBefore); expect(await originalUsers()).toBe(usersBefore);
      const changed = new Set(["factory_erp_imports", "factory_erp_observations", "factory_erp_bindings", "audit_events", "app_users"]);
      expect((await checkpoint.snapshot()).filter(row => !changed.has(row.table))).toEqual(before.filter(row => !changed.has(row.table)));
    } finally {
      try {
        await database.client.unsafe(originalDefinition);
        const [restored] = await database.client.unsafe("select pg_get_functiondef('public.factory_erp_source_now()'::regprocedure) as definition");
        afterClock = sha(String(restored!.definition)); expect(afterClock).toBe(beforeClock);
      } finally {
        const owned = resolve(workspace, "tmp/factory-erp-lifecycle-20261021-a9f6d812"); await mkdir(owned, { recursive: true });
        await writeFile(resolve(owned, "qa-retention-upgrade-clock-restore.json"), JSON.stringify({ nonce, beforeSha256: beforeClock, afterSha256: afterClock, restored: beforeClock === afterClock }, null, 2) + "\n");
      }
    }
    // Moving only the test source clock back cannot resurrect already removed
    // private source data or turn a purged lifecycle receipt into retained data.
    for (const original of old.sources) expect(await importer.lifecycle(old.context, original.id)).toMatchObject({ access: "expired", purgeStatus: "purged" });
    const after = await delivery.get(old.context, old.packet.id);
    for (const item of after.items) {
      const beforeItem = old.packet.items.find(value => value.id === item.id)!;
      expect(item.snapshot).toEqual(beforeItem.snapshot); expect(item.feedback).toEqual(beforeItem.feedback); expect(item.status).toBe("submitted");
      expect(item.factoryErp).toMatchObject({ status: "shipped", exception: "voided_requires_review", privateSourceExpired: true,
        observationId: beforeItem.factoryErp!.observationId, importId: beforeItem.factoryErp!.importId, externalId: "", trackingReference: "", shippedQuantity: null });
    }
    await verifySource();
  });
});
