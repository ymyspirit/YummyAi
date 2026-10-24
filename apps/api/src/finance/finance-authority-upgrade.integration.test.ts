import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { isFinanceProfitVerified, type RecordFinanceStatementInput, type CalculateFinanceProfitInput,
  type UpsertFinanceProfitMetricInput, type FinanceProfitRunView } from "@yummyai/contracts/finance";
import { connectDatabase, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { FinanceService } from "./finance.service.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_AUTHORITY_ISOLATED !== "1"
  || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0154" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
  throw new Error("Real153 finance upgrade requires an isolated disposable database before connection");

// The child imports the verified, unmodified old owner/contracts/migrator graph.
const seedSource = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const root=process.env.E2E_FINANCE_AUTHORITY_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
if(!process.connected||process.env.E2E_FINANCE_AUTHORITY_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0154')throw Error('Original153 disposable IPC required');
createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('reflect-metadata');
const {connectDatabase,readMigrationEvidence}=await load('packages/database/src/index.ts');
const {financeMonetaryFixture,monetaryStatement,monetaryFact,monetaryKey}=await load('apps/api/src/finance/finance-monetary.fixtures.ts');
const db=connectDatabase();try{
 if((await readMigrationEvidence(db)).actualRows.length!==153)throw Error('Actual153 schema required');
 const f=financeMonetaryFixture(db);await f.initialize();
 const revenueInput=monetaryStatement('USD',[monetaryFact('USD',10000,{factType:'sale_revenue',direction:'credit'})]);
 const costInput=monetaryStatement('USD',[monetaryFact('USD',2000)]);
 const revenue=await f.service.recordStatement(f.context,revenueInput),cost=await f.service.recordStatement(f.context,costInput);
 const metricInput={metricId:null,name:'Synthetic actual153 original metric',reportingCurrency:'USD',revenueFactTypes:['sale_revenue'],costFactTypes:['production_cost'],requiredFactTypes:['sale_revenue','production_cost'],reasonCode:'SYNTHETIC',idempotencyKey:monetaryKey()};
 const metric=await f.service.upsertProfitMetric(f.context,metricInput);
 const runInput={metricId:metric.id,expectedMetricVersion:1,statementIds:[revenue.id,cost.id],fxRateIds:[],coverageDimension:'aggregate',idempotencyKey:monetaryKey()};
 const run=await f.service.calculateProfit(f.context,runInput);
 if(run.status!=='complete'||run.profitMinor!==8000)throw Error('Original153 complete result required');
 process.send({type:'seeded153',context:f.context,revenueInput,costInput,revenue,cost,metricInput,metric,runInput,run});
}finally{await db.client.end();}
`;

describe.sequential("actual153 to154 retains immutable evidence without inventing source identity", () => {
  const database = connectDatabase(); let processHandle: InvoiceProcess | undefined;
  afterAll(async () => {
    if (processHandle && processHandle.child.exitCode === null) await processHandle.stop(true);
    await database.client.end();
  });
  it("retains every old column, exact replay and contributions while withdrawing unverified totals", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const root = process.env.E2E_FINANCE_AUTHORITY_LEGACY_SOURCE;
    if (!root || !isAbsolute(root)) throw new Error("Original153 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-finance-authority-c42e8d19");
    const metadata = JSON.parse(await readFile(prefix + "-old153.json", "utf8"));
    const manifest = JSON.parse(await readFile(prefix + "-source-before.json", "utf8"));
    expect(resolve(root)).toBe(resolve(metadata.snapshot)); expect(metadata.noEnvironmentCopied).toBe(true);
    expect(metadata.ordinaryServicesStarted).toBe(false); expect(manifest.files).toHaveLength(2664);
    expect(manifest.sha256).toBe("6ac9fb0d93ad53f31cf9864f463bb5acab07a3dbc876f69e24345fafa3085b72");
    expect(metadata.sourceSha256).toBe(manifest.sha256);
    for (const file of manifest.files) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seedSource], {
      cwd: resolve(root, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    })); processHandle = child;
    const seeded = await child.wait("seeded153", undefined, 120_000) as unknown as {
      context: TenantContext; revenueInput: RecordFinanceStatementInput; costInput: RecordFinanceStatementInput;
      revenue: { id: string; checksum: string }; cost: { id: string; checksum: string };
      metricInput: UpsertFinanceProfitMetricInput; metric: { id: string };
      runInput: CalculateFinanceProfitInput; run: FinanceProfitRunView;
    };
    expect(await child.closed).toBe(0);
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(153);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); expect(await checkpoint.snapshot()).toEqual(before);
    await assertDatabaseMigrationsCurrent(database);
    expect((await readMigrationEvidence(database)).actualRows.slice(0, 153)).toEqual(ledger);
    const owner = new FinanceService(database, new AuditService(database));
    const view = await owner.getProfitRun(seeded.context, seeded.run.id);
    expect(view).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null,
      marginBps: null, breakdowns: [], inputChecksum: seeded.run.inputChecksum });
    expect(view.contributions).toEqual(seeded.run.contributions); expect(isFinanceProfitVerified(view)).toBe(false);
    expect(view.diagnostics.sourceIdentity?.unidentifiedFactIds).toEqual(seeded.run.contributions.map(row => row.factId).sort());
    const statement = await owner.recordStatement(seeded.context, seeded.revenueInput);
    expect(statement).toMatchObject({ id: seeded.revenue.id, checksum: seeded.revenue.checksum });
    expect(statement.sourceIdentity ?? null).toBeNull();
    expect((await owner.upsertProfitMetric(seeded.context, seeded.metricInput)).id).toBe(seeded.metric.id);
    expect((await owner.calculateProfit(seeded.context, seeded.runInput)).inputChecksum).toBe(seeded.run.inputChecksum);
    expect(await checkpoint.snapshot()).toEqual(before);
    await expect(owner.recordStatement(seeded.context, { ...seeded.costInput, externalStatementId: "SYNTHETIC-LEGACY-NEW", idempotencyKey: `synthetic-${createEntityId()}` }))
      .rejects.toMatchObject({ status: 409, response: { code: "finance_source_identity_required" } });
    expect(await checkpoint.snapshot()).toEqual(before);
    const recalculated = await owner.calculateProfit(seeded.context, { ...seeded.runInput, idempotencyKey: `synthetic-${createEntityId()}` });
    expect(recalculated).toMatchObject({ sourceIdentityVersion: 1, status: "incomplete", profitMinor: null, breakdowns: [] });
    expect(recalculated.diagnostics.sourceIdentity?.unidentifiedFactIds).toHaveLength(2);
    expect(isFinanceProfitVerified(recalculated)).toBe(false);
    await withTenant(database.db, seeded.context, async tx => {
      const [stored] = await tx.execute(sql`select status,profit_minor,source_identity_version,input_checksum from finance_profit_runs where id=${seeded.run.id}`);
      expect(stored.status).toBe("complete"); expect(String(stored.profit_minor)).toBe("8000");
      expect(stored.source_identity_version).toBeNull(); expect(stored.input_checksum).toBe(seeded.run.inputChecksum);
      const unknown = await tx.execute(sql`select source_identity from finance_statements where id in (${seeded.revenue.id},${seeded.cost.id})`);
      expect(unknown).toHaveLength(2); expect(unknown.every(row => row.source_identity === null)).toBe(true);
    });
  }, 180_000);
});
