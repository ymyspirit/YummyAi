import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { CalculateFinanceProfitInput, FinanceProfitRunView, RecordFinanceStatementInput } from "@yummyai/contracts/finance";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { FinanceService } from "./finance.service.js";
import { FinanceCostAllocationService } from "./finance-cost-allocation.service.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_COST_ALLOCATION_ISOLATED !== "1"
  || process.env.E2E_FINANCE_MONETARY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0156"
  || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
  throw new Error("Actual155 allocation upgrade requires its dedicated disposable database before connection");

// The child can load only the original, individually hash-verified155 owners.
// No new allocation schema/service exists in that source snapshot.
const seed = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const root=process.env.E2E_FINANCE_COST_ALLOCATION_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
if(!process.connected||process.env.E2E_FINANCE_COST_ALLOCATION_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0156')throw Error('Original155 isolated IPC required');
createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('reflect-metadata');
const {connectDatabase,readMigrationEvidence}=await load('packages/database/src/index.ts');
const {financeMonetaryFixture,monetaryFact,monetaryStatement,monetaryKey}=await load('apps/api/src/finance/finance-monetary.fixtures.ts');
const db=connectDatabase();try{
 if((await readMigrationEvidence(db)).actualRows.length!==155)throw Error('Actual155 schema required');
 const f=financeMonetaryFixture(db);await f.initialize();const {context,service}=f;
 const statementInput=monetaryStatement('USD',[monetaryFact('USD',1000,{factType:'sale_revenue',direction:'credit'}),
  monetaryFact('USD',100),monetaryFact('USD',101,{factType:'carrier_cost'})]);
 const statement=await service.recordStatement(context,statementInput);
 const metric=await service.upsertProfitMetric(context,{metricId:null,name:'Synthetic actual155 allocation upgrade',reportingCurrency:'USD',
  revenueFactTypes:['sale_revenue'],costFactTypes:['production_cost','carrier_cost'],requiredFactTypes:['sale_revenue','production_cost','carrier_cost'],
  reasonCode:'SYNTHETIC',idempotencyKey:monetaryKey()});
 const runInput={metricId:metric.id,expectedMetricVersion:1,statementIds:[statement.id],fxRateIds:[],coverageDimension:'aggregate',idempotencyKey:monetaryKey()};
 const base=await service.calculateProfit(context,runInput);
 if(base.status!=='complete'||base.profitMinor!==799)throw Error('Original155 verified contribution total required');
 process.send({type:'seeded155',context,statementInput,statementId:statement.id,runInput,base,
  rootFactId:statement.lines.find(x=>x.factType==='carrier_cost').id});
}finally{await db.client.end();}
`;

describe.sequential("actual155 to156 preserves original finance facts, runs and identities", () => {
  const database = connectDatabase(); let processHandle: InvoiceProcess | undefined;
  afterAll(async () => { if (processHandle && processHandle.child.exitCode === null) await processHandle.stop(true); await database.client.end(); });
  it("replays the byte-verified original155 requests unchanged and adds an independently approved period projection after migration", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_FINANCE_COST_ALLOCATION_LEGACY_SOURCE;
    if (!root || !isAbsolute(root)) throw new Error("Original155 source path required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-finance-allocation-87a6c2d9");
    const metadata = JSON.parse(await readFile(prefix + "-old155.json", "utf8"));
    const manifest = JSON.parse(await readFile(prefix + "-source-before.json", "utf8"));
    expect(resolve(root)).toBe(resolve(metadata.snapshot)); expect(metadata.noEnvironmentCopied).toBe(true); expect(metadata.ordinaryServicesStarted).toBe(false);
    expect(manifest.files).toHaveLength(2702); expect(manifest.sha256).toBe("7727fadf41b97a27f86e01e132c83b095061b627f5fb14a5bddfb4eb4954593f");
    expect(metadata.sourceSha256).toBe(manifest.sha256);
    for (const file of manifest.files) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seed], {
      cwd: resolve(root, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    })); processHandle = child;
    const seeded = await child.wait("seeded155", undefined, 120_000) as unknown as {
      context: TenantContext; statementInput: RecordFinanceStatementInput; statementId: string; runInput: CalculateFinanceProfitInput; base: FinanceProfitRunView; rootFactId: string;
    };
    expect(await child.closed).toBe(0);
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(155);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); expect(await checkpoint.snapshot()).toEqual(before); await assertDatabaseMigrationsCurrent(database);
    const afterMigration = await readMigrationEvidence(database); expect(afterMigration.actualRows).toHaveLength(156);
    expect(afterMigration.actualRows.slice(0, 155)).toEqual(ledger);
    const audit = new AuditService(database), finance = new FinanceService(database, audit), allocations = new FinanceCostAllocationService(database, audit);
    const protectedTables = ["finance_statements", "finance_facts", "finance_fx_rates", "finance_profit_metrics", "finance_profit_metric_versions", "finance_profit_runs", "finance_profit_contributions"];
    const rows = (tables: string[]) => withTenant(database.db, seeded.context, async tx => {
      const result: Record<string, Array<Record<string, unknown>>> = {};
      for (const table of tables) result[table] = await tx.execute(sql`select * from ${sql.identifier(table)} order by id`);
      return result;
    });
    const originals = await rows(protectedTables), originalAudit = await rows(["audit_events"]);
    expect((await finance.recordStatement(seeded.context, seeded.statementInput)).id).toBe(seeded.statementId);
    expect(await finance.calculateProfit(seeded.context, seeded.runInput)).toEqual(seeded.base);
    expect(await rows(protectedTables)).toEqual(originals); expect(await rows(["audit_events"])).toEqual(originalAudit);
    const previewInput = { baseRunId: seeded.base.id, baseInputChecksum: seeded.base.inputChecksum, allocationId: null, expectedVersion: null,
      dimension: "period", method: "equal", sources: [{ rootFactId: seeded.rootFactId, targets: [{ key: "2026-07", weight: "1" }] }],
      reasonCode: "SYNTHETIC_UPGRADE", basisDescription: "Explicit original155 analysis month" };
    const preview = await allocations.preview(seeded.context, previewInput);
    const versionInput = { ...previewInput, previewChecksum: preview.previewChecksum, idempotencyKey: `upgrade-approved-${createEntityId()}` };
    const version = await allocations.approve(seeded.context, versionInput);
    const runInput = { baseRunId: seeded.base.id, baseInputChecksum: seeded.base.inputChecksum, dimension: "period", versionIds: [version.id], idempotencyKey: `upgrade-attributed-${createEntityId()}` };
    const run = await allocations.calculate(seeded.context, runInput);
    expect(run).toMatchObject({ status: "complete", baseRunId: seeded.base.id, revenueMinor: 1000, costMinor: 201, profitMinor: 799, basisProblems: [] });
    expect(run.id).not.toBe(seeded.base.id); expect(run.breakdowns[0]!.target).toMatchObject({ period: "2026-07", orderId: null,
      periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z" });
    expect(await allocations.approve(seeded.context, versionInput)).toEqual(version); expect(await allocations.calculate(seeded.context, runInput)).toEqual(run);
    expect(await rows(protectedTables)).toEqual(originals);
    for (const event of originalAudit.audit_events!) expect((await rows(["audit_events"])).audit_events!.find(row => row.id === event.id)).toEqual(event);
  }, 180_000);
});
