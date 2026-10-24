import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "@yummyai/ai-core";
import type { CreateProductionOrderInput, TenantContext } from "@yummyai/contracts";
import type { PrepareProductionCommand } from "@yummyai/contracts/order/production-command";
import { connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { AuditService } from "../audit/audit.service.js";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { FactoryCapacityService } from "../suppliers/factory-capacity.service.js";
import { OrderService } from "./order.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { ProductionCommandService } from "./production-command.service.js";
import { ProductionQuantityService } from "./production-quantity.service.js";
import { requireProductionQuantityEnvironment } from "./production-quantity.test-fixture.js";

requireProductionQuantityEnvironment("pre-0160");

describe.sequential("genuine159 to160 explicit production quantities", () => {
  const database = connectDatabase();
  let child: InvoiceProcess | undefined;
  afterAll(async () => {
    try { if (child?.child.exitCode === null) await child.stop(true); }
    finally { await database.client.end(); }
  });

  it("preserves every original column, hash and receipt without inventing physical reports or stop effects from old statuses", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const root = process.env.E2E_PRODUCTION_QUANTITY_LEGACY_SOURCE;
    if (!root || !isAbsolute(root) || resolve(root) !== resolve(workspace, "tmp/production-stop-20261021-b72e8c4a/old159-source"))
      throw new Error("Pinned original159 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-production-stop-b72e8c4a");
    const materialization = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(resolve(materialization.target)).toBe(resolve(root));
    expect(materialization).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 2860,
      sourceSha256: "a548804c96afa3326a1268dfe65a82ca074809b9aeecabe044a95b54a186a9d2" });
    expect(source.sha256).toBe(materialization.sourceSha256); expect(source.files).toHaveLength(2860);
    for (const file of source.files)
      expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);

    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs",
      resolve(workspace, "tools/testing/production-quantity-legacy-migration.mts")], {
      cwd: resolve(root, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    }));
    const old = await child.wait("quantity.seeded159", undefined, 120_000) as unknown as {
      context: TenantContext; planned: { id: string; orderId: string; input: CreateProductionOrderInput };
      committed: { id: string }; released: { id: string }; cancelledCommitted: { id: string };
      command: { id: string; input: PrepareProductionCommand; receipt: { productionOrderIds: string[] } };
      pending: { id: string; input: PrepareProductionCommand };
    };
    expect(await child.closed).toBe(0);
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(159);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    expect(await checkpoint.snapshot()).toEqual(before);
    const migrated = (await readMigrationEvidence(database)).actualRows;
    expect(migrated).toHaveLength(160); expect(migrated.slice(0, 159)).toEqual(ledger);

    const vault = new SecretVault(Buffer.alloc(32, 121)), audit = new AuditService(database);
    const factories = new FactoryDirectoryService(database, audit), orders = new OrderService(database, vault, audit);
    const production = new OrderProductionService(database, vault, orders, audit, undefined, factories);
    const commands = new ProductionCommandService(database, vault, production), quantities = new ProductionQuantityService(database, audit);
    const capacity = new FactoryCapacityService(database, audit);
    for (const table of ["production_quantity_reports", "production_quantity_reviews", "factory_capacity_stop_effects"]) {
      const [row] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier(table)}`));
      expect(row?.count).toBe(0);
    }
    for (const value of [old.planned, old.committed, old.released, old.cancelledCommitted]) {
      const view = await quantities.workspace(old.context, value.id, {});
      expect(view.basis).toMatchObject({ quantity: 10, cumulativeStoppedQuantity: 0, reviewId: null, currentQuantities: null });
      expect(view.reports).toEqual([]); expect(view.reviews).toEqual([]);
    }
    const reserved = await capacity.production(old.context, old.planned.id);
    expect(reserved.reservations[0]).toMatchObject({ totalUnits: 10, committedUnits: 0, releasedUnits: 0 });
    expect((await capacity.production(old.context, old.committed.id)).reservations[0]).toMatchObject({ totalUnits: 10, committedUnits: 10, releasedUnits: 0 });
    expect((await capacity.production(old.context, old.released.id)).reservations[0]).toMatchObject({ totalUnits: 10, committedUnits: 0, releasedUnits: 10 });
    expect((await capacity.production(old.context, old.cancelledCommitted.id)).reservations[0]).toMatchObject({ totalUnits: 10, committedUnits: 10, releasedUnits: 0 });
    expect((await production.create(old.context, old.planned.orderId, old.planned.input)).productionOrder.id).toBe(old.planned.id);
    expect((await commands.execute(old.context, old.command.id)).receipt).toEqual(old.command.receipt);
    expect((await commands.prepare(old.context, old.pending.input)).id).toBe(old.pending.id);
    expect(await checkpoint.snapshot()).toEqual(before);
    const originalBasis = (await quantities.workspace(old.context, old.committed.id, {})).basis;
    const [clock] = await withTenant(database.db, old.context, tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`));
    const report = await quantities.recordReport(old.context, old.committed.id, {
      idempotencyKey: randomUUID(), productionVersionId: originalBasis.productionVersionId,
      expectedProductionProjectionVersion: originalBasis.projectionVersion, expectedReviewId: null,
      expectedBasisFingerprint: originalBasis.fingerprint, observedAt: new Date(clock!.now).toISOString(),
      quantities: { unstartedQuantity: null, inProcessQuantity: null, completedQuantity: null, scrappedQuantity: null },
      evidenceCode: "SYNTHETIC_OLD_PHYSICAL_QUANTITY_UNKNOWN", evidenceAssetIds: [],
    });
    expect(report.report.input.quantities).toEqual({ unstartedQuantity: null, inProcessQuantity: null, completedQuantity: null, scrappedQuantity: null });
    expect((await quantities.workspace(old.context, old.committed.id, {})).basis.cumulativeStoppedQuantity).toBe(0);
    expect((await capacity.production(old.context, old.committed.id)).reservations[0]).toMatchObject({ totalUnits: 10, committedUnits: 10, releasedUnits: 0 });
  }, 180_000);
});
