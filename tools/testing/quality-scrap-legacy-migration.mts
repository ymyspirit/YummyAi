import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.ts";

/** The runner may import this function without connecting or seeding anything. */
export async function migrateQualityScrapLegacyDatabase(connection: DatabaseConnection, expectedName: string) {
  if (process.env.E2E_QUALITY_SCRAP_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0161" ||
      !/^order_daily_e2e_[a-f0-9]{32}$/.test(expectedName)) throw new Error("Quality scrap legacy migration requires its exact disposable runner");
  const [actual] = await connection.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
  if (actual?.name !== expectedName || actual.ledger !== null || actual.populated !== false)
    throw new Error("Quality scrap legacy migration requires the exact fresh nonce database");
  const requireDatabase = createRequire(new URL("../../packages/database/package.json", import.meta.url));
  const { readMigrationFiles } = requireDatabase("drizzle-orm/migrator");
  const migrationsFolder = fileURLToPath(new URL("../../packages/database/migrations/", import.meta.url));
  const journal = JSON.parse(await readFile(new URL("../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  const target = journal.entries.find(row => row.tag === "0161_quality_scrap_attribution");
  if (!target) throw new Error("Canonical quality scrap migration missing");
  const migrations = (readMigrationFiles({ migrationsFolder }) as Array<{ folderMillis: number; sql: string[]; hash: string }>)
    .filter(row => row.folderMillis < target.when);
  if (migrations.length !== 160) throw new Error("The genuine160 migration prefix is required");
  await connection.client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");
    await tx.unsafe("create schema drizzle");
    await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
    for (const migration of migrations) {
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash, migration.folderMillis]);
    }
  });
}

async function seedActual160() {
  // This boundary executes before any original business or database import.
  const root = process.env.E2E_QUALITY_SCRAP_LEGACY_SOURCE, value = process.env.DATABASE_URL;
  const expectedRoot = fileURLToPath(new URL("../../tmp/quality-scrap-20261021-c54e17a8/old160-source", import.meta.url));
  if (!process.connected || !root || !isAbsolute(root) || resolve(root) !== resolve(expectedRoot) || !value ||
      process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_QUALITY_SCRAP_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0161")
    throw new Error("Actual160 scrap IPC requires its protected original source and isolated runner");
  const url = new URL(value), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Actual160 scrap IPC refuses an ordinary database or bucket");
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  createRequire(pathToFileURL(resolve(root, "apps/api/package.json")))("reflect-metadata");
  const d = await load("packages/database/src/index.ts") as typeof import("../../packages/database/src/index.js");
  const { factoryCapacityFixture } = await load("apps/api/src/suppliers/factory-capacity.test-fixture.ts") as typeof import("../../apps/api/src/suppliers/factory-capacity.test-fixture.js");
  const { ProductionQuantityService } = await load("apps/api/src/orders/production-quantity.service.ts") as typeof import("../../apps/api/src/orders/production-quantity.service.js");
  const database = d.connectDatabase(), owner = factoryCapacityFixture(database), quantities = new ProductionQuantityService(database, owner.audit);
  let phase = "ledger";
  const send = (message: object) => new Promise<void>((done, reject) => process.send!(message, error => error ? reject(error) : done()));
  try {
    if ((await d.readMigrationEvidence(database)).actualRows.length !== 160) throw new Error("Actual160 ledger required");
    await owner.initialize();
    const group = (key: string, quantity: number, passed: boolean) => ({ key, label: `Synthetic original160 ${key}`, quantity,
      criterionResults: [{ code: "ACTUAL", scoreBps: passed ? 10000 : 0, passed, evidenceAssetIds: [] }],
      defects: passed ? [] : [{ code: "COLOR", severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic actual original160 group defect", evidenceAssetIds: [] }] });
    async function production() {
      const site = await owner.factory(), pool = await owner.pool(site, 80), source = await owner.source(site, 10, pool.pool);
      const actual = await owner.production.create(owner.context, source.order.id, source.input), id = actual.productionOrder.id;
      for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
        const current = await owner.production.get(owner.context, id);
        await owner.production.recordMilestone(owner.context, id, { type, expectedProjectionVersion: current.productionOrder.projectionVersion,
          externalEventId: randomUUID(), occurredAt: (await owner.clock()).now, evidence: { code: "SYNTHETIC_ORIGINAL160_EVENT", note: null, assetIds: [] } });
      }
      const standard = await owner.production.createQualityStandard(owner.context, { name: `Synthetic original160 standard ${randomUUID()}`, minimumScoreBps: 9000,
        criteria: [{ code: "ACTUAL", label: "Original160 actual physical group", weightBps: 10000, blocking: true }] });
      return { id, source, versionId: actual.versions[0]!.id, standardId: standard.id };
    }
    async function rootFor(value: Awaited<ReturnType<typeof production>>, held: number) {
      const current = await owner.production.qualityGroups(owner.context, value.id);
      const input = { formatVersion: 3, productionVersionId: current.productionVersionId, expectedProductionProjectionVersion: current.projectionVersion,
        expectedRootInspectionId: current.rootInspectionId, parentGroupId: null, qualityStandardVersionId: value.standardId,
        inspectedAt: (await owner.clock()).now, evidenceAssetIds: [], segregationConfirmed: true,
        groups: [group("GOOD", 4, true), group("HELD", held, false)], idempotencyKey: randomUUID() };
      const saved = await owner.production.inspectGroups(owner.context, value.id, input);
      return { input, saved, held: saved.workspace.groups.find(row => row.result === "failed")! };
    }
    async function physical(value: { id: string }) {
      const basis = (await quantities.workspace(owner.context, value.id, {})).basis;
      const reportInput = { idempotencyKey: randomUUID(), productionVersionId: basis.productionVersionId, expectedProductionProjectionVersion: basis.projectionVersion,
        expectedReviewId: basis.reviewId, expectedBasisFingerprint: basis.fingerprint, observedAt: (await owner.clock()).now,
        quantities: { unstartedQuantity: 0, inProcessQuantity: 0, completedQuantity: 8, scrappedQuantity: 2 }, evidenceCode: "SYNTHETIC_ORIGINAL160_COUNT", evidenceAssetIds: [] };
      const report = await quantities.recordReport(owner.context, value.id, reportInput);
      const reviewInput = { idempotencyKey: randomUUID(), reportId: report.report.id, expectedProductionProjectionVersion: basis.projectionVersion,
        expectedReviewId: basis.reviewId, expectedBasisFingerprint: basis.fingerprint, stoppedDelta: 0, unstartedAcrossAllPoolsConfirmed: false,
        occurredAt: (await owner.clock()).now, evidenceCode: "SYNTHETIC_ORIGINAL160_REVIEW" };
      const review = await quantities.review(owner.context, value.id, reviewInput);
      return { reportInput, report: report.report, reviewInput, review: review.review };
    }
    phase = "groupable";
    const first = await production(), firstRoot = await rootFor(first, 6), firstCount = await physical(first);
    if (!(await owner.production.qualityGroups(owner.context, first.id)).groups.find(row => row.id === firstRoot.held.id)?.quantityBlockers?.length)
      throw new Error("Original160 must retain its real unresolved scrap group blocker");
    phase = "before-root";
    const prior = await production(), priorCount = await physical(prior), priorRoot = await rootFor(prior, 4);
    phase = "old-child";
    const occupied = await production(), occupiedRoot = await rootFor(occupied, 6);
    const childInput = { type: "remake", originalProductionOrderId: occupied.id, qualityGroupId: occupiedRoot.held.id,
      defectId: occupiedRoot.held.defects[0]!.id, remakeQuantity: 2, expectedProductionProjectionVersion: occupiedRoot.saved.workspace.projectionVersion,
      physicalSelectionConfirmed: true, manufacturing: occupied.source.input.manufacturing, capacityPlan: occupied.source.input.capacityPlan,
      expectedCompletionAt: occupied.source.input.expectedCompletionAt, reason: "Synthetic original160 pinned replacement", idempotencyKey: randomUUID() };
    const child = await owner.production.recover(owner.context, childInput), occupiedCount = await physical(occupied);
    await send({ type: "scrap.seeded160", context: owner.context,
      groupable: { ...first, root: firstRoot, count: firstCount },
      beforeRoot: { ...prior, root: priorRoot, count: priorCount },
      occupied: { ...occupied, root: occupiedRoot, count: occupiedCount, childInput, child } });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : undefined;
    await send({ type: "scrap.failed160", phase, ...(code ? { code } : {}) });
    throw new Error("Synthetic genuine160 scrap setup failed");
  } finally { await database.client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await seedActual160();
