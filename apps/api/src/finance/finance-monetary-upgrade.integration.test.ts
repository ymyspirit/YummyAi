import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TenantContext } from "@yummyai/contracts";
import { isFinanceProfitVerified, type CalculateFinanceProfitInput, type FinanceProfitRunView, type FinanceFxRateView } from "@yummyai/contracts/finance";
import { connectDatabase, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent, withTenant, financeProfitRuns, financeFxRates } from "@yummyai/database";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { FinanceService } from "./finance.service.js";
import { requireFinanceMonetaryFixture, monetaryKey, monetaryRate, monetaryTables } from "./finance-monetary.fixtures.js";

requireFinanceMonetaryFixture();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0152") throw new Error("Genuine disposable 151 schema required before connection");
type Seed = { context: TenantContext; cases: Array<{ kind: string; input: CalculateFinanceProfitInput; run: FinanceProfitRunView; rate: FinanceFxRateView | null }> };
const seedSource = String.raw`
import {createRequire} from 'node:module';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.E2E_FINANCE_MONETARY_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('reflect-metadata');
const {requireDisposableIntegrationEnvironment}=await load('tools/testing/require-disposable-integration.mjs');requireDisposableIntegrationEnvironment();
if(process.env.E2E_FINANCE_MONETARY_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0152'||!process.connected)throw new Error('Disposable actual151 monetary IPC required');
const {createEntityId}=await load('packages/contracts/src/common/ids.ts');
const {connectDatabase,readMigrationEvidence,withTenant,memberships,roles,membershipRoles}=await load('packages/database/src/index.ts');
const {AuditService}=await load('apps/api/src/audit/audit.service.ts'),{FinanceService}=await load('apps/api/src/finance/finance.service.ts');
const db=connectDatabase(),context={tenantId:createEntityId(),userId:createEntityId(),permissions:['finance:read','finance:write','finance:review'],dataScope:'tenant'};
let phase='ledger';
try{
 if((await readMigrationEvidence(db)).actualRows.length!==151)throw new Error('Actual151 required');
 phase='synthetic-member';
 await db.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic actual151 monetary',$2)",[context.tenantId,'old-money-'+context.tenantId]);
 await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic actual151 monetary')",[context.userId,'old-money-'+context.userId,context.userId+'@example.test']);
 await withTenant(db.db,context,async tx=>{const member=createEntityId(),role=createEntityId();await tx.insert(memberships).values({id:member,tenantId:context.tenantId,userId:context.userId,status:'active'});
 await tx.insert(roles).values({id:role,tenantId:context.tenantId,name:'Synthetic actual151 '+role,permissions:context.permissions,dataScope:'tenant'});await tx.insert(membershipRoles).values({tenantId:context.tenantId,membershipId:member,roleId:role});});
 const service=new FinanceService(db,new AuditService(db)),key=()=>createEntityId();
 const fact=(currency,amountMinor,revenue=false)=>({lineKey:key(),factType:revenue?'sale_revenue':'production_cost',direction:revenue?'credit':'debit',amountMinor,currency,
 occurredAt:'2026-07-15T00:00:00.000Z',externalReference:null,orderId:null,orderLineId:null,skuId:null,listingId:null,supplierId:null,correctionKind:'original',correctsFactId:null});
 const statement=async(currency,lines)=>service.recordStatement(context,{accountId:null,provider:'manual',statementKind:'operational_cost',externalStatementId:key(),periodStart:'2026-07-01T00:00:00.000Z',
 periodEnd:'2026-07-31T23:59:59.000Z',sourceCurrency:currency,observedAt:'2026-08-01T00:00:00.000Z',lines,idempotencyKey:key()});
 const cases=[];
 for(const c of [{kind:'mixed-digits',source:'EUR',target:'JPY',amount:2000,revenue:1000000,n:160,d:1},
 {kind:'same-two',source:'EUR',target:'USD',amount:2000,revenue:10000,n:11,d:10},
 {kind:'same-jpy',source:'JPY',target:'JPY',amount:0,revenue:1234},
 {kind:'unknown-currency',source:'ZZZ',target:'ZZZ',amount:0,revenue:1234}]){
  phase='actual-151-'+c.kind;
  const sale=await statement(c.target,[fact(c.target,c.revenue,true)]),cost=await statement(c.source,[fact(c.source,c.amount)]);
  const rate=c.n?await service.recordFxRate(context,{source:'SYNTHETIC.OLD151_'+c.kind.toUpperCase(),baseCurrency:c.source,quoteCurrency:c.target,rateNumerator:c.n,rateDenominator:c.d,
   effectiveAt:'2026-07-01T00:00:00.000Z',retrievedAt:'2026-07-02T00:00:00.000Z',idempotencyKey:key()}):null;
  const metric=await service.upsertProfitMetric(context,{metricId:null,name:'Synthetic original151 '+c.kind,reportingCurrency:c.target,revenueFactTypes:['sale_revenue'],costFactTypes:['production_cost'],
   requiredFactTypes:['sale_revenue','production_cost'],reasonCode:'SYNTHETIC',idempotencyKey:key()});
  const input={metricId:metric.id,expectedMetricVersion:1,statementIds:[sale.id,cost.id],fxRateIds:rate?[rate.id]:[],coverageDimension:'aggregate',idempotencyKey:key()};
  const run=await service.calculateProfit(context,input);if(run.status!=='complete')throw new Error('Original151 complete synthetic calculation required');cases.push({kind:c.kind,input,run,rate});
 }
 await db.client.end();process.send({type:'finance.monetary.legacy.seeded',seed:{context,cases}},()=>process.exit(0));
}catch(cause){await db.client.end();const code=[cause?.code,cause?.cause?.code].find(v=>typeof v==='string'&&/^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(v));
 process.send({type:'finance.monetary.legacy.failed',phase,...(code?{code}:{})},()=>process.exit(1));}
`;

describe("genuine 151 to 152 currency precision upgrade", () => {
  const database = connectDatabase(), service = new FinanceService(database, new AuditService(database)), children: InvoiceProcess[] = [];
  afterAll(async () => {
    try { const stopped = await Promise.allSettled(children.map(child => child.stop(true))); if (stopped.some(result => result.status === "rejected")) throw new Error("Monetary legacy child cleanup incomplete"); }
    finally { await database.client.end(); }
  }, 30_000);
  it("preserves actual old rows, checksums and wrong amounts while withdrawing unsafe verification and appending a correct v2 calculation", async () => {
    const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(151);
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const root = process.env.E2E_FINANCE_MONETARY_LEGACY_SOURCE; if (!root || !isAbsolute(root)) throw new Error("Verified original151 source required");
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const metadata = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-21-finance-monetary-a84d6e71-old151.json"), "utf8")) as {
      snapshot: string; sourceSha256: string; sourceFiles: number; noEnvironmentCopied: boolean; ordinaryServicesStarted: boolean; ordinaryDatabaseWrites: boolean };
    expect(resolve(root)).toBe(resolve(metadata.snapshot)); expect(metadata.sourceFiles).toBe(2638);
    expect(metadata.noEnvironmentCopied).toBe(true); expect(metadata.ordinaryServicesStarted).toBe(false); expect(metadata.ordinaryDatabaseWrites).toBe(false);
    const manifest = JSON.parse(await readFile(resolve(workspace, "docs/project-control/checkpoints/2026-10-21-finance-monetary-a84d6e71-source-before.json"), "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
    expect(manifest.sha256).toBe("4c2ff8680c9057e0c4b8ec81d6ca9572ffc0da5b33e173b10eafb021f089a839"); expect(metadata.sourceSha256).toBe(manifest.sha256);
    for (const file of manifest.files.filter(file => file.path.startsWith("packages/") || file.path.startsWith("apps/api/") || file.path.startsWith("tools/testing/") || file.path === "tsconfig.base.json"))
      expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    const child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seedSource], {
      cwd: resolve(root, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1" } })); children.push(child);
    const event = await child.wait("finance.monetary.legacy.seeded", undefined, 120_000), seed = event.seed as Seed; expect(await child.closed).toBe(0); expect(seed.cases).toHaveLength(4);
    const unsafe = seed.cases.find(saved => saved.kind === "mixed-digits")!, same = seed.cases.find(saved => saved.kind === "same-two")!;
    expect(unsafe.run).toMatchObject({ status: "complete", revenueMinor: 1000000, costMinor: 320000, profitMinor: 680000 });
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); expect(await checkpoint.snapshot()).toEqual(before);
    const migrated = (await readMigrationEvidence(database)); expect(migrated.actualRows).toHaveLength(152);
    expect(migrated.actualRows.slice(0, 151)).toEqual(ledger); expect(migrated.actualRows[151]).toEqual(migrated.canonicalRows[151]);
    const oldFacts = await financialState(seed.context);
    for (const saved of seed.cases) {
      const read = await service.getProfitRun(seed.context, saved.run.id);
      expect(read.monetaryBasis).toBeNull(); expect(read.inputChecksum).toBe(saved.run.inputChecksum); expect(read.contributions).toEqual(saved.run.contributions);
      if (saved.kind === "mixed-digits" || saved.kind === "unknown-currency") {
        expect(read).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null, marginBps: null, breakdowns: [] });
        expect(isFinanceProfitVerified(read)).toBe(false);
        if (saved.rate) expect(read.diagnostics.monetary!.ambiguousFxRateIds).toContain(saved.rate.id);
        else expect(read.diagnostics.monetary!.unknownCurrencies).toEqual(["ZZZ"]);
      } else { expect(read.status).toBe("complete"); expect(read.profitMinor).toBe(saved.run.profitMinor); expect(isFinanceProfitVerified(read)).toBe(true); }
      const replay = await service.calculateProfit(seed.context, saved.input); expect(replay).toEqual(read);
      const [stored] = await withTenant(database.db, seed.context, tx => tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, saved.run.id)));
      expect(stored).toMatchObject({ status: "complete", monetaryBasis: null, revenueMinor: saved.run.revenueMinor, costMinor: saved.run.costMinor,
        profitMinor: saved.run.profitMinor, inputChecksum: saved.run.inputChecksum });
      if (saved.rate) {
        const [rate] = await withTenant(database.db, seed.context, tx => tx.select().from(financeFxRates).where(eq(financeFxRates.id, saved.rate!.id)));
        expect(rate!.monetaryBasis).toBeNull(); expect(rate!.checksum).toBe(saved.rate.checksum);
      }
    }
    expect(await financialState(seed.context)).toEqual(oldFacts);
    const explicit = await service.recordFxRate(seed.context, monetaryRate("EUR", "JPY", 160, 1, { source: "SYNTHETIC.V2_EXPLICIT" }));
    const correct = await service.calculateProfit(seed.context, { ...unsafe.input, fxRateIds: [explicit.id], idempotencyKey: monetaryKey() });
    expect(correct).toMatchObject({ status: "complete", costMinor: 3200, profitMinor: 996800, monetaryBasis: { schemaVersion: 2 } });
    expect(correct.contributions.find(row => row.sourceCurrency === "EUR")!.reportingAmountMinor).toBe(3200);
    const compatible = await service.calculateProfit(seed.context, { ...same.input, idempotencyKey: monetaryKey() });
    expect(compatible).toMatchObject({ status: "complete", costMinor: 2200, profitMinor: 7800, monetaryBasis: { schemaVersion: 2 } });
    expect((await service.getProfitRun(seed.context, unsafe.run.id)).profitMinor).toBeNull();
    const [unchanged] = await withTenant(database.db, seed.context, tx => tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, unsafe.run.id)));
    expect(unchanged).toMatchObject({ costMinor: 320000, profitMinor: 680000, monetaryBasis: null });
    process.stdout.write(JSON.stringify({ type: "finance.monetary.upgrade", oldMigrations: 151, newMigrations: 152, originalTables: before.length,
      oldRuns: 4, oldRowsPreserved: true, oldIncorrectAmountPreserved: true, childPid: child.child.pid, childExited: true, oldSource: manifest.sha256 }) + "\n");
  }, 210_000);
  async function financialState(context: TenantContext) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, string> = {};
      for (const table of monetaryTables) result[table] = createHash("sha256").update(JSON.stringify(await tx.execute(sql`select * from ${sql.identifier(table)} order by id`))).digest("hex");
      return result;
    });
  }
});
