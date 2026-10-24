import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import { FACTORY_ERP_HEADERS, type FactoryErpItemSelection } from "@yummyai/contracts/order/factory-erp-import";
import type { CreateProductionDelivery, ProductionDeliveryPackageView, ProductionDeliverySnapshot, RecordProductionDeliveryFeedback } from "@yummyai/contracts/order/production-delivery";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
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

const disposable = new URL(requireDisposableIntegrationEnvironment());
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(disposable.pathname)?.[1];
if (!nonce || process.env.E2E_FACTORY_ERP_IMPORT_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0163" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory ERP upgrade requires its exact isolated pre0163 database and bucket before connection");

const tables = ["factory_erp_imports", "factory_erp_applications", "factory_erp_bindings", "factory_erp_binding_items", "factory_erp_observations", "factory_erp_application_rows"] as const;
const sha = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
type Original162 = {
  context: TenantContext; foreignContext: TenantContext; productionOrderId: string; factoryId: string; packetId: string; deliveryItemId: string;
  deliveryInput: CreateProductionDelivery; feedbackInput: RecordProductionDeliveryFeedback; snapshot: ProductionDeliverySnapshot;
  feedback: ProductionDeliveryPackageView["items"][number]["feedback"];
  jpeg: { checksum: string; byteSize: number; mediaType: string }; sourceObject: { id: string; key: string; checksum: string };
};

describe.sequential("genuine162 to163 factory export observations", () => {
  const database = connectDatabase();
  let child: InvoiceProcess | undefined;
  afterAll(async () => {
    try { if (child?.child.exitCode === null) await child.stop(true); }
    finally { await database.client.end(); }
  });

  it("preserves every original162 column and real submitted JPG without backfill, then accepts only an explicit new scanned export binding", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const root = process.env.E2E_FACTORY_ERP_IMPORT_LEGACY_SOURCE;
    const expectedRoot = resolve(workspace, "tmp/factory-erp-import-20261021-f3a7c920/old162-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Pinned original162 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-factory-erp-import-f3a7c920");
    const materialization = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(materialization).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false,
      sourceFiles: 2917, dependencyLinks: 309, sourceSha256: "71dae1ba674d672971c1614ea343a57215305f270545eac35dbe080981eac33a" });
    expect(resolve(materialization.target)).toBe(expectedRoot);
    expect(source.sha256).toBe(materialization.sourceSha256); expect(source.files).toHaveLength(2917);
    const verifySource = async () => {
      for (const file of source.files) expect(sha(await readFile(resolve(root, file.path))), file.path).toBe(file.sha256);
    };
    await verifySource();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/factory-erp-import-legacy.mts")], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"),
        // current here means the pinned old graph's actual latest schema162.
        // Its IPC child independently verifies ledger162 before using this fixture.
        E2E_LEGACY_SCHEMA_TARGET: "current", E2E_FACTORY_QUANTITY_ISOLATED: "1", E2E_FACTORY_ERP_IMPORT_LEGACY_CHILD: "162" },
    }));
    const old = await child.wait("factory.erp.seeded162", undefined, 120_000) as unknown as Original162;
    expect(await child.closed).toBe(0);
    const ledger = (await readMigrationEvidence(database)).actualRows;
    expect(ledger).toHaveLength(162);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    const migrated = (await readMigrationEvidence(database)).actualRows;
    expect(migrated).toHaveLength(163); expect(migrated.slice(0, 162)).toEqual(ledger);
    expect(await checkpoint.snapshot()).toEqual(before);
    const shape = await database.client.unsafe("select c.relname as name,c.relrowsecurity as enabled,c.relforcerowsecurity as forced,has_table_privilege('yummyai_app',c.oid,'SELECT') as readable,has_table_privilege('yummyai_app',c.oid,'INSERT') as insertable,has_table_privilege('yummyai_app',c.oid,'UPDATE') as mutable,has_table_privilege('yummyai_app',c.oid,'DELETE') as deletable from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by c.relname", [[...tables]]);
    expect(shape).toHaveLength(6);
    for (const row of shape) expect(row).toMatchObject({ enabled: true, forced: true, readable: true, insertable: true, mutable: false, deletable: false });
    const emptyNewTables = async () => {
      for (const table of tables) {
        const [count] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier(table)}`));
        expect(count?.count, table).toBe(0);
      }
    };
    await emptyNewTables();

    const vault = new SecretVault(Buffer.alloc(32, 121)), audit = new AuditService(database), storage = createStorageFromEnvironment();
    const orders = new OrderService(database, vault, audit), factories = new FactoryDirectoryService(database, audit);
    const reports = new AmazonOrderReportService(database, vault, orders, audit, new HttpAmazonReportArchiveGateway(),
      { schedule: async () => undefined }, { schedule: async () => undefined });
    const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: async () => undefined }, new ClamAvProductionEditorScanner());
    const production = new OrderProductionService(database, vault, orders, audit, editor, factories);
    const delivery = new OrderProductionDeliveryService(database, vault, editor, production, audit, factories);
    const sourceGateway = new FactoryErpSourceGateway(storage, vault, new ClamAvScanner());
    const importer = new FactoryErpImportService(database, vault, sourceGateway, delivery, audit);
    const replayedPackage = await delivery.create(old.context, old.deliveryInput);
    expect(replayedPackage.id).toBe(old.packetId);
    const replayedFeedback = await delivery.recordFeedback(old.context, old.packetId, old.deliveryItemId, old.feedbackInput);
    const item = replayedFeedback.items.find(value => value.id === old.deliveryItemId)!;
    expect(item.snapshot).toEqual(old.snapshot); expect(item.feedback).toEqual(old.feedback);
    expect(item.status).toBe("submitted"); expect(item.factoryErp).toBeNull();
    const file = await editor.renderFile(old.context, old.snapshot.editorProjectId, old.snapshot.renderId, old.snapshot.file.key);
    try { expect({ checksum: sha(file.body), byteSize: file.body.byteLength, mediaType: file.mediaType }).toEqual(old.jpeg); }
    finally { file.body.fill(0); }
    const encryptedImage = await storage.readPrivate(old.context, { id: old.sourceObject.id, tenantId: old.context.tenantId,
      assetDomain: "order", objectKey: old.sourceObject.key }, { requiredDomain: "order" });
    try { expect(sha(encryptedImage)).toBe(old.sourceObject.checksum); } finally { encryptedImage.fill(0); }
    await emptyNewTables(); expect(await checkpoint.snapshot()).toEqual(before);
    const [physical] = await withTenant(database.db, old.context, tx => tx.execute<{ reports: number; reviews: number; feedback: number }>(sql`
      select (select count(*)::int from production_quantity_reports) as reports,
        (select count(*)::int from production_quantity_reviews) as reviews,
        (select count(*)::int from production_delivery_feedback) as feedback`));
    expect(physical).toEqual({ reports: 0, reviews: 0, feedback: 1 });

    // This is a NEW explicit operator application to genuine old submitted
    // files, after the preceding no-backfill and unchanged-history assertions.
    const raw = [`SYNTHETIC-EXPLICIT-OLD162-${old.productionOrderId}`, "Synthetic owned factory export", "SYNTHETIC-REFERENCE-ONLY", "SYNTHETIC-LABEL-ONLY",
      "", "", "1", "2", "Synthetic carrier", "Synthetic service", "已出库", "2026-10-21 08:09:10", "2026-10-21 09:10:11"];
    const quote = (value: string) => /[,\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    const bytes = Buffer.from([FACTORY_ERP_HEADERS, raw].map(row => row.map(quote).join(",")).join("\r\n"));
    const upload = { factoryId: old.factoryId, fileName: "synthetic-explicit-old162.csv", contentBase64: bytes.toString("base64"),
      checksumSha256: sha(bytes), options: { csvEncoding: "utf-8" as const, delimiter: "," as const }, idempotencyKey: randomUUID() };
    let view;
    try { view = await importer.upload(old.context, upload); } finally { bytes.fill(0); }
    const selection: FactoryErpItemSelection = { deliveryItemId: old.deliveryItemId, productionOrderId: old.productionOrderId,
      productionVersionId: old.snapshot.productionVersionId, fileChecksum: old.snapshot.file.checksum,
      manufacturingChecksum: old.snapshot.manufacturing!.plan.checksum };
    const apply = { fileChecksum: view.fileChecksum, previewChecksum: view.previewChecksum, idempotencyKey: randomUUID(), confirmed: true as const,
      rows: [{ rowNumber: 2, items: [selection], wholeGroupConfirmed: true as const }] };
    const result = await importer.apply(old.context, view.id, apply);
    expect(result).toMatchObject({ appliedRows: 1, observations: [{ rowNumber: 2, status: "shipped", disposition: "advanced" }] });
    expect(await importer.apply(old.context, view.id, apply)).toEqual(result);
    const after = await delivery.get(old.context, old.packetId);
    expect(after.items[0]).toMatchObject({ status: "submitted", factoryErp: { status: "shipped", shippedQuantity: null } });
    expect(after.items[0]!.snapshot).toEqual(old.snapshot); expect(after.items[0]!.feedback).toEqual(old.feedback);
    expect((await checkpoint.snapshot()).filter(row => row.table !== "audit_events")).toEqual(before.filter(row => row.table !== "audit_events"));
    for (const table of tables) {
      const [foreign] = await withTenant(database.db, old.foreignContext, tx => tx.execute<{ count: number; nonOwner: boolean }>(sql`
        select count(*)::int as count,current_user='yummyai_app' as "nonOwner" from ${sql.identifier(table)}`));
      expect(foreign?.count, table).toBe(0); expect(foreign?.nonOwner).toBe(true);
    }
    await verifySource();
  }, 180_000);
});
