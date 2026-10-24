import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {isAbsolute,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll,describe,expect,it} from "vitest";
import type {TenantContext} from "@yummyai/contracts";
import {PrepareFinanceCommandSchema,type FinanceCommandResult,type PrepareFinanceCommand} from "@yummyai/contracts/finance/finance-command";
import {assertDatabaseMigrationsCurrent,connectDatabase,migrateDatabase,readMigrationEvidence,withTenant} from "@yummyai/database";
import {sql} from "drizzle-orm";
import {captureLegacyDataCheckpoint} from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import {observeInvoiceProcess,type InvoiceProcess} from "../procurement/invoice-command.fixtures.js";
import {financeCommandFixture} from "./finance-command.fixtures.js";

const url=new URL(process.env.DATABASE_URL??"postgres://invalid/invalid");
if(process.env.E2E_ISOLATED_DAILY!=="1"||process.env.E2E_FINANCE_COMMAND_ISOLATED!=="1"||process.env.E2E_LEGACY_SCHEMA_TARGET!=="pre-0157"
 ||!["postgres:","postgresql:"].includes(url.protocol)||!/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
 throw new Error("Actual156 finance-command upgrade requires its dedicated disposable database before connection");

// Only individually verified original156 modules run in this child. Inputs and
// immutable receipts are synthetic; no new command module is present in that source.
const seed=String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';
const root=process.env.E2E_FINANCE_COMMAND_LEGACY_SOURCE,load=p=>import(pathToFileURL(resolve(root,p)).href);
if(!process.connected||process.env.E2E_ISOLATED_DAILY!=='1'||process.env.E2E_FINANCE_COMMAND_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0157'
 ||!/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname))throw Error('Actual156 isolated IPC required');
createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('reflect-metadata');
const {connectDatabase,readMigrationEvidence}=await load('packages/database/src/index.ts');
const {financeCostAllocationFixture}=await load('apps/api/src/finance/finance-cost-allocation.fixtures.ts');
const {financePayablesAdjustmentsFixture}=await load('apps/api/src/finance/finance-payables-adjustments.fixtures.ts');
const {monetaryFact,monetaryRate,monetaryStatement}=await load('apps/api/src/finance/finance-monetary.fixtures.ts');
const db=connectDatabase(),key=()=> 'synthetic-original156-'+randomUUID(),rows=[];
try{
 if((await readMigrationEvidence(db)).actualRows.length!==156)throw Error('Actual156 schema required');
 const c=financeCostAllocationFixture(db),p=financePayablesAdjustmentsFixture(db);await c.initialize();await p.initialize();
 const save=async(kind,targetId,input,context,operation)=>{const value=await operation();const versioned=kind==='metric_upsert'||kind==='cost_version_approve';
  rows.push({original:{kind,targetId,input},context,result:{kind,id:kind==='metric_upsert'?value.version.id:value.id,
   parentId:versioned?(kind==='metric_upsert'?value.id:value.allocationId):null,version:versioned?(kind==='metric_upsert'?value.version.versionNumber:value.versionNumber):null}});return value;};
 const statementInput=monetaryStatement('USD',[monetaryFact('USD',29)]);
 await save('statement_record',null,statementInput,c.context,()=>c.finance.recordStatement(c.context,statementInput));
 const rateInput=monetaryRate('JPY','USD',1,150);await save('fx_rate_record',null,rateInput,c.context,()=>c.finance.recordFxRate(c.context,rateInput));
 const metricInput={metricId:null,name:'Synthetic actual156 '+randomUUID(),reportingCurrency:'USD',revenueFactTypes:['sale_revenue'],costFactTypes:['production_cost'],
  requiredFactTypes:['sale_revenue','production_cost'],reasonCode:'SYNTHETIC',idempotencyKey:key()};
 await save('metric_upsert',null,metricInput,c.context,()=>c.finance.upsertProfitMetric(c.context,metricInput));
 const basis=await c.basis(),profitInput={...basis.input,idempotencyKey:key()};
 await save('profit_calculate',basis.metric.id,profitInput,c.context,()=>c.finance.calculateProfit(c.context,profitInput));
 const billInput=p.billInput(100);await save('bill_record',null,billInput,p.context,()=>p.payables.recordBill(p.context,billInput));
 const paymentInput=p.paymentInput(100);await save('payment_record',null,paymentInput,p.context,()=>p.payables.recordPayment(p.context,paymentInput));
 const due=await p.bill(100),paid=await p.payment(100),allocationInput={paymentId:paid.id,allocations:[{billId:due.id,amountMinor:50}],idempotencyKey:key()};
 const batch=await save('payment_allocate',paid.id,allocationInput,p.context,()=>p.payables.allocate(p.context,allocationInput));
 const releaseInput={reasonCode:'SYNTHETIC',idempotencyKey:key()};
 await save('allocation_release',batch.allocations[0].id,releaseInput,p.context,()=>p.payables.release(p.context,batch.allocations[0].id,releaseInput));
 const creditRoot=await p.bill(100),creditInput={kind:'credit',expectedNetAmountMinor:100,amountMinor:20,externalDocumentId:'CREDIT-'+randomUUID(),
  evidenceReference:'Synthetic original156 actual credit',occurredAt:'2026-07-03T00:00:00.000Z',reasonCode:'SYNTHETIC',idempotencyKey:key()};
 await save('bill_adjustment_record',creditRoot.id,creditInput,p.context,()=>p.adjustments.recordBillAdjustment(p.context,creditRoot.id,creditInput));
 const refundRoot=await p.payment(100),refundInput={kind:'refund',expectedNetAmountMinor:100,amountMinor:20,externalDocumentId:'REFUND-'+randomUUID(),
  evidenceReference:'Synthetic original156 refund evidence',occurredAt:'2026-07-03T00:00:00.000Z',reasonCode:'SYNTHETIC',idempotencyKey:key()};
 await save('payment_adjustment_record',refundRoot.id,refundInput,p.context,()=>p.adjustments.recordPaymentAdjustment(p.context,refundRoot.id,refundInput));
 const previewInput=c.previewInput(basis),preview=await c.allocations.preview(c.context,previewInput),versionInput={...previewInput,previewChecksum:preview.previewChecksum,idempotencyKey:key()};
 const version=await save('cost_version_approve',null,versionInput,c.context,()=>c.allocations.approve(c.context,versionInput));
 const runInput={baseRunId:basis.base.id,baseInputChecksum:basis.base.inputChecksum,dimension:'order_line',versionIds:[version.id],idempotencyKey:key()};
 await save('allocated_profit_calculate',basis.base.id,runInput,c.context,()=>c.allocations.calculate(c.context,runInput));
 p.destroy();process.send({type:'seeded156',rows});
}finally{await db.client.end();}
`;

describe.sequential("actual156 to157 retains raw identities without adopting historical receipts",()=>{
 const database=connectDatabase();let child:InvoiceProcess|undefined;
 afterAll(async()=>{try{if(child&&child.child.exitCode===null)await child.stop(true);}finally{await database.client.end();}});
 it("keeps every original column, row, audit and twelve raw replays, while refusing historical command ownership",async()=>{
  const workspace=fileURLToPath(new URL("../../../../",import.meta.url)),root=process.env.E2E_FINANCE_COMMAND_LEGACY_SOURCE;
  if(!root||!isAbsolute(root))throw new Error("Original156 source required");
  const prefix=resolve(workspace,"docs/project-control/checkpoints/2026-10-21-finance-command-6c29d8f4");
  const metadata=JSON.parse(await readFile(prefix+"-old156.json","utf8")),source=JSON.parse(await readFile(prefix+"-source-before.json","utf8"));
  expect(resolve(root)).toBe(resolve(metadata.snapshot));expect(metadata.noEnvironmentCopied).toBe(true);
  expect(source.files).toHaveLength(2729);expect(source.sha256).toBe("5e23fb52762bbb1fe1b7e6427d5b0a6f97dd848edcedbc7fd5212500e4c491f1");
  for(const file of source.files)expect(createHash("sha256").update(await readFile(resolve(root,file.path))).digest("hex"),file.path).toBe(file.sha256);
  child=observeInvoiceProcess(spawn(process.execPath,["--import","./node_modules/tsx/dist/loader.mjs","--input-type=module","--eval",seed],{
   cwd:resolve(root,"apps/api"),env:{...process.env,TSX_DISABLE_CACHE:"1",TSX_TSCONFIG_PATH:resolve(root,"apps/api/tsconfig.json")},stdio:["ignore","pipe","pipe","ipc"],windowsHide:true}));
  const seeded=await child.wait("seeded156",undefined,120_000) as unknown as {rows:Array<{original:PrepareFinanceCommand;context:TenantContext;result:FinanceCommandResult}>};
  expect(await child.closed).toBe(0);expect(seeded.rows).toHaveLength(12);
  const ledger=(await readMigrationEvidence(database)).actualRows;expect(ledger).toHaveLength(156);
  const checkpoint=await captureLegacyDataCheckpoint(database),before=await checkpoint.snapshot();
  await migrateDatabase(database);await assertDatabaseMigrationsCurrent(database);expect(await checkpoint.snapshot()).toEqual(before);
  const after=(await readMigrationEvidence(database)).actualRows;expect(after).toHaveLength(157);expect(after.slice(0,156)).toEqual(ledger);
  const f=financeCommandFixture(database);
  try{
   for(const row of seeded.rows){const original=PrepareFinanceCommandSchema.parse(row.original);
    expect(await f.raw(original,row.context)).toEqual(row.result);
    await expect(f.commands.prepare(row.context,original)).rejects.toMatchObject({status:409});
    await withTenant(database.db,row.context,async tx=>{
     for(const table of ["finance_commands","finance_original_write_proofs","finance_statement_source_lines"]){
      const [count]=await tx.execute<{count:number}>(sql`select count(*)::int as count from ${sql.identifier(table)}`);expect(count!.count).toBe(0);
     }
    });
   }
   expect(await checkpoint.snapshot()).toEqual(before);
  }finally{f.destroy();}
 },180_000);
});
