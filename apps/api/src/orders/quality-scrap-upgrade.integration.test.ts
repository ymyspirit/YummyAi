import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "@yummyai/ai-core";
import { ConflictException } from "@nestjs/common";
import type { CreateProductionOrderInput, CreateProductionRecoveryInput, TenantContext } from "@yummyai/contracts";
import { RecordQualityGroupsInputSchema, type QualityGroupsWorkspace, type QualityPhysicalGroupView, type RecordQualityGroupsInput } from "@yummyai/contracts/order/quality-groups";
import type { ProductionQuantityReportInput, ProductionQuantityReportView, ProductionQuantityReviewInput, ProductionQuantityReviewView } from "@yummyai/contracts/order/production-quantity";
import { AllocateQualityScrapInputSchema } from "@yummyai/contracts/order/quality-scrap";
import { connectDatabase, migrateDatabase, assertDatabaseMigrationsCurrent, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { AuditService } from "../audit/audit.service.js";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderService } from "./order.service.js";
import { ProductionQuantityService } from "./production-quantity.service.js";
import { QualityScrapService } from "./quality-scrap.service.js";
import { requireQualityScrapEnvironment } from "./quality-scrap.test-fixture.js";

requireQualityScrapEnvironment("pre-0161");
type LegacyScene = { id: string; versionId: string; standardId: string; source: { order: { id: string }; input: CreateProductionOrderInput };
  root: { input: RecordQualityGroupsInput; saved: { inspectionId: string; workspace: QualityGroupsWorkspace }; held: QualityPhysicalGroupView };
  count: { reportInput: ProductionQuantityReportInput; report: ProductionQuantityReportView;
    reviewInput: ProductionQuantityReviewInput; review: ProductionQuantityReviewView } };

describe.sequential("genuine160 to161 fixed scrap attribution upgrade", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  afterAll(async () => { try { if (child?.child.exitCode === null) await child.stop(true); } finally { await database.client.end(); } });
  it("preserves all actual160 columns and receipts with zero inferred allocations and unlocks only an explicit post-upgrade physical attribution", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const root = process.env.E2E_QUALITY_SCRAP_LEGACY_SOURCE, expectedRoot = resolve(workspace, "tmp/quality-scrap-20261021-c54e17a8/old160-source");
    if (!root || !isAbsolute(root) || resolve(root) !== expectedRoot) throw new Error("Pinned actual160 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-quality-scrap-c54e17a8");
    const materialization = JSON.parse(await readFile(`${prefix}-legacy-materialization.json`, "utf8"));
    const source = JSON.parse(await readFile(`${prefix}-source-before.json`, "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(resolve(materialization.target)).toBe(expectedRoot);
    expect(materialization).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 2881,
      sourceSha256: "4909303a45670a3068e798921518ae886a2b39b7af9e3e4d568f1bc69b8ac68c" });
    expect(source.sha256).toBe(materialization.sourceSha256); expect(source.files).toHaveLength(2881);
    for (const file of source.files) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", resolve(workspace, "tools/testing/quality-scrap-legacy-migration.mts")], {
      cwd: resolve(root, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    }));
    const old = await child.wait("scrap.seeded160", undefined, 120_000) as unknown as { context: TenantContext;
      groupable: LegacyScene; beforeRoot: LegacyScene; occupied: LegacyScene & { childInput: CreateProductionRecoveryInput;
        child: { recoveryId: string; replacementProductionOrderId: string } } };
    expect(await child.closed).toBe(0);
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(160);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
    expect(await checkpoint.snapshot()).toEqual(before);
    const migrated = (await readMigrationEvidence(database)).actualRows;
    expect(migrated).toHaveLength(161); expect(migrated.slice(0, 160)).toEqual(ledger);
    const vault = new SecretVault(Buffer.alloc(32, 121)), audit = new AuditService(database), factories = new FactoryDirectoryService(database, audit);
    const orders = new OrderService(database, vault, audit), production = new OrderProductionService(database, vault, orders, audit, undefined, factories);
    const quantities = new ProductionQuantityService(database, audit), scraps = new QualityScrapService(database, audit);
    for (const table of ["quality_scrap_reviews", "quality_scrap_allocations"]) {
      const [count] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier(table)}`));
      expect(count?.count).toBe(0);
    }
    for (const value of [old.groupable, old.beforeRoot, old.occupied]) {
      expect((await production.create(old.context, value.source.order.id, value.source.input)).productionOrder.id).toBe(value.id);
      expect((await quantities.recordReport(old.context, value.id, value.count.reportInput)).report).toEqual(value.count.report);
      expect((await quantities.review(old.context, value.id, value.count.reviewInput)).review).toEqual(value.count.review);
      expect(await production.inspectGroups(old.context, value.id, value.root.input)).toMatchObject({ inspectionId: value.root.saved.inspectionId, replayed: true });
      const view = await scraps.workspace(old.context, value.id, {});
      expect(view.reviews).toEqual([]); expect(view.basis).toMatchObject({ actualScrappedQuantity: 2, mappedScrappedQuantity: 0, unassignedQuantity: 2 });
    }
    expect(await production.recover(old.context, old.occupied.childInput)).toEqual(old.occupied.child);
    expect(await checkpoint.snapshot()).toEqual(before);
    const groupable = await scraps.workspace(old.context, old.groupable.id, {}), prior = await scraps.workspace(old.context, old.beforeRoot.id, {});
    expect(groupable.basis.lots).toContainEqual(expect.objectContaining({ sourceQuantityReviewId: old.groupable.count.review.id, quantity: 2, scope: "groupable" }));
    expect(prior.basis).toMatchObject({ outsideRootQuantity: 2, unassignedGroupQuantity: 0 });
    expect(prior.basis.lots).toContainEqual(expect.objectContaining({ sourceQuantityReviewId: old.beforeRoot.count.review.id, scope: "before_root" }));
    expect((await production.qualityGroups(old.context, old.occupied.id)).groups.find(row => row.id === old.occupied.root.held.id)).toMatchObject({ quantity: 6, remakeQuantity: 2 });
    const beforeExplicit = await checkpoint.snapshot();
    const groupBasis = await production.qualityGroups(old.context, old.groupable.id);
    await expect(production.inspectGroups(old.context, old.groupable.id, { ...old.groupable.root.input, parentGroupId: old.groupable.root.held.id,
      expectedProductionProjectionVersion: groupBasis.projectionVersion, expectedRootInspectionId: groupBasis.rootInspectionId,
      inspectedAt: (await databaseTime()).now, groups: [{ ...old.groupable.root.input.groups[0]!, key: "REPAIRED", label: "Synthetic unassigned old scrap must block", quantity: 4 }],
      idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect(await checkpoint.snapshot()).toEqual(beforeExplicit);
    const basis = groupable.basis;
    const allocation = AllocateQualityScrapInputSchema.parse({ idempotencyKey: randomUUID(), productionVersionId: basis.productionVersionId,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedRootInspectionId: basis.rootInspectionId,
      expectedQuantityReviewId: basis.quantityReviewId, expectedScrapReviewId: null, expectedBasisFingerprint: basis.fingerprint,
      physicalSegregationConfirmed: true, occurredAt: (await databaseTime()).now, evidenceCode: "SYNTHETIC_EXPLICIT_POST_UPGRADE_SCRAP", evidenceAssetIds: [],
      allocations: [{ qualityGroupId: old.groupable.root.held.id, sourceQuantityReviewId: old.groupable.count.review.id, quantity: 2 }] });
    const saved = await scraps.allocate(old.context, old.groupable.id, allocation); expect(saved.replayed).toBe(false);
    const current = await production.qualityGroups(old.context, old.groupable.id);
    const reinspected = await production.inspectGroups(old.context, old.groupable.id, RecordQualityGroupsInputSchema.parse({ ...old.groupable.root.input,
      expectedProductionProjectionVersion: current.projectionVersion, expectedRootInspectionId: current.rootInspectionId,
      parentGroupId: old.groupable.root.held.id, inspectedAt: (await databaseTime()).now, idempotencyKey: randomUUID(),
      groups: [{ ...old.groupable.root.input.groups[0]!, key: "REPAIRED", label: "Synthetic original160 remaining four", quantity: 4 }] }));
    expect(reinspected.workspace.groups.find(row => row.id === old.groupable.root.held.id)).toMatchObject({ quantity: 6, active: false, scrappedQuantity: 2, remainingScrapRemakeQuantity: 2 });
    expect(reinspected.workspace.groups.filter(row => row.parentGroupId === old.groupable.root.held.id && row.active).reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
    expect((await quantities.workspace(old.context, old.groupable.id, {})).reviews.find(row => row.id === old.groupable.count.review.id)).toEqual(old.groupable.count.review);
    for (const file of source.files) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    async function databaseTime() {
      const [clock] = await withTenant(database.db, old.context, tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`));
      return { now: new Date(clock!.now).toISOString() };
    }
  }, 180_000);
});
