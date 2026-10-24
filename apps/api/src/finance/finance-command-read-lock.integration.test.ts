import {setTimeout as delay} from "node:timers/promises";
import {afterAll,afterEach,beforeAll,describe,expect,it} from "vitest";
import {PrepareFinanceCommandSchema,type FinanceCommandDetail,type FinanceCommandKind} from "@yummyai/contracts/finance/finance-command";
import {connectDatabase,financeCostAllocationVersions,financeFacts,migrateDatabase,withTenant} from "@yummyai/database";
import {sql} from "drizzle-orm";
import {financeCommandBusinessTables,financeCommandFixture,requireFinanceCommandFixture} from "./finance-command.fixtures.js";
requireFinanceCommandFixture();

describe.sequential("pure financial preparation does not acquire business locks",()=>{
 const database=connectDatabase(),f=financeCommandFixture(database);
 beforeAll(async()=>{await migrateDatabase(database);await f.initialize();},60_000);
 afterEach(async()=>{await f.restoreRights();await f.cleanupCommands();});
 afterAll(async()=>{f.destroy();await database.client.end();});
 it.each(["metric_upsert","profit_calculate","cost_version_approve","allocated_profit_calculate"] as const)(
  "reads %s while its basis is locked, and actual execution still waits for the original business lock",async(kind:FinanceCommandKind)=>{
   const s=await f.scenario(kind);
   if(kind==="metric_upsert"){
    if(s.original.kind!==kind)throw new Error("Metric control required");const base=await f.cost.basis();
    s.original=PrepareFinanceCommandSchema.parse({...s.original,targetId:base.metric.id,input:{...s.original.input,metricId:base.metric.id,expectedVersion:base.metric.currentVersion}});
   }
   const before=await f.state(s.context,financeCommandBusinessTables);
   let ready!:()=>void,release!:()=>void;const acquired=new Promise<void>(resolve=>{ready=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
   let holderPid=0;
   const holder=withTenant(database.db,s.context,async tx=>{
    const [pid]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);holderPid=pid!.pid;
    if(s.original.kind==="metric_upsert"||s.original.kind==="profit_calculate"){
     await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`finance-profit-metric-id:${s.context.tenantId}:${s.original.targetId}`},0))`);
     await tx.execute(sql`select id from finance_profit_metrics where id=${s.original.targetId}::uuid for update`);
    }else{
     for(const fact of await tx.select({id:financeFacts.id}).from(financeFacts))
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`finance-correction:${s.context.tenantId}:${fact.id}`},0))`);
     for(const version of await tx.select({id:financeCostAllocationVersions.allocationId}).from(financeCostAllocationVersions))
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`finance-cost-allocation:${s.context.tenantId}:${version.id}`},0))`);
     await tx.execute(sql`select id from order_lines for update`);
    }
    ready();await released;
   });
   const operations:Promise<unknown>[]=[];let execution:Promise<FinanceCommandDetail>|undefined;
   try{
    await Promise.race([acquired,holder]);
    const preparation=f.commands.prepare(s.context,s.original);operations.push(preparation);
    const prepared=await Promise.race([preparation,delay(2000).then(()=>null)]);
    expect(prepared,"A pure preparation must not wait for a business basis lock").not.toBeNull();
    if(!prepared)throw new Error("Preparation took a business lock");expect(prepared.canExecute).toBe(true);
    const reading=f.commands.get(s.context,prepared.id);operations.push(reading);
    const read=await Promise.race([reading,delay(2000).then(()=>null)]);
    expect(read,"Reading an original must not lock its business basis").not.toBeNull();expect(read?.canExecute).toBe(true);
    expect(await f.state(s.context,financeCommandBusinessTables)).toEqual(before);
    execution=f.commands.execute(s.context,prepared.id);operations.push(execution);
    let blocked=false;
    for(let attempt=0;attempt<40;attempt++){
     const [state]=await database.client.unsafe<{blocked:boolean}[]>("select exists(select 1 from pg_stat_activity where datname=current_database() and $1::int=any(pg_blocking_pids(pid))) as blocked",[holderPid]);
     if(state?.blocked){blocked=true;break;}await delay(50);
    }
    expect(blocked,"Actual execution must retain the owner's original business lock").toBe(true);
   }finally{release();await Promise.allSettled(operations);await holder;}
   expect((await execution)?.status).toBe("succeeded");
  },30_000);
});
