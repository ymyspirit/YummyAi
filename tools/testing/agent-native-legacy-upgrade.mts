import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseConnection } from "../../packages/database/src/client.js";
import type * as OriginalDatabase from "../../packages/database/src/index.js";
import type * as OriginalFixture from "../../apps/api/src/ai/agent-plan.test-fixture.js";
import type * as OriginalService from "../../apps/api/src/ai/agent-plan.service.js";
import type * as OriginalDispatcher from "../../apps/api/src/ai/redis-agent-plan-dispatcher.js";
import type * as OriginalCore from "../../packages/ai-core/src/index.js";
import type * as OriginalJobs from "../../packages/jobs/src/index.js";
import type * as OriginalCommands from "../../packages/contracts/src/ai/agent-command.js";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const expectedRoot=fileURLToPath(new URL("../../tmp/agent-native-20261022-a72d5e31/old174-source",import.meta.url));
const flags=["E2E_AGENT_NATIVE_ISOLATED","E2E_AGENT_TOOLS_ISOLATED","E2E_AGENT_PLAN_ISOLATED","E2E_AGENT_LOOP_ISOLATED","E2E_AGENT_COMMAND_ISOLATED","E2E_AGENT_READ_ISOLATED",
 "E2E_ROLE_BENCHMARK_ISOLATED","E2E_BUSINESS_BENCHMARK_ISOLATED","E2E_KNOWLEDGE_BENCHMARK_ISOLATED","E2E_KNOWLEDGE_EVALUATION_ISOLATED","E2E_ISOLATED_DAILY"];
export function requireAgentNativeLegacyEnvironment(environment:NodeJS.ProcessEnv,target:"pre-0175"|"current"){
 const url=new URL(requireDisposableIntegrationEnvironment(environment)),root=environment.E2E_AGENT_NATIVE_LEGACY_SOURCE;
 const nonce=/^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1],redis=environment.E2E_DISPOSABLE_REDIS_URL,local=["localhost","127.0.0.1","[::1]"];
 if(!nonce||flags.some(key=>environment[key]!=="1")||environment.E2E_LEGACY_SCHEMA_TARGET!==target||!root||!isAbsolute(root)||resolve(root)!==resolve(expectedRoot)||
  !local.includes(url.hostname)||environment.S3_PRIVATE_BUCKET!==`order-daily-e2e-${nonce}`||!redis||environment.REDIS_URL!==redis||environment.E2E_DISPOSABLE_REDIS_CONTAINER!==`yummyai-daily-${nonce}`||
  !["redis:","rediss:"].includes(new URL(redis).protocol)||!local.includes(new URL(redis).hostname))throw new Error("Native upgrade requires exact original174 graph and every isolated nonce resource before connection");
 return{root:resolve(root),url:url.href,name:url.pathname.slice(1),nonce};
}
export async function assertAgentNativeOriginal174Graph(root:string){
 if(resolve(root)!==resolve(expectedRoot))throw new Error("Original174 graph identity mismatch");
 const require=createRequire(pathToFileURL(resolve(root,"apps/api/package.json")));
 for(const name of["contracts","database","ai-core","authz","jobs","storage","workflow-core","catalog-core","knowledge-core","pod-core","order-core"])
  if(await realpath(resolve(root,"apps/api/node_modules/@yummyai",name))!==await realpath(resolve(root,"packages",name)))throw new Error("Original174 workspace dependency escaped: "+name);
 let reachable=false;try{require.resolve("@yummyai/contracts/ai/agent-native");reachable=true;}catch(error){if(!error||typeof error!=="object"||!("code"in error)||!["ERR_PACKAGE_PATH_NOT_EXPORTED","MODULE_NOT_FOUND"].includes(String(error.code)))throw error;}
 if(reachable)throw new Error("New175 native export reached from original174 graph");
 const journal=JSON.parse(await readFile(resolve(root,"packages/database/migrations/meta/_journal.json"),"utf8")) as{entries:Array<{tag:string}>};
 if(journal.entries.length!==174||journal.entries.at(-1)?.tag!=="0174_agent_plan")throw new Error("Actual174 journal required");
}
export async function migrateAgentNativeLegacyDatabase(database:DatabaseConnection,name:string,environment:NodeJS.ProcessEnv){
 const target=requireAgentNativeLegacyEnvironment(environment,"pre-0175");if(target.name!==name)throw new Error("Original174 database identity mismatch");await assertAgentNativeOriginal174Graph(target.root);
 const[actual]=await database.client.unsafe("select current_database() as name,to_regclass('drizzle.__drizzle_migrations') as ledger,exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as populated");
 if(actual?.name!==name||actual.ledger!==null||actual.populated!==false)throw new Error("Original174 migration refuses populated or foreign database");
 const require=createRequire(pathToFileURL(resolve(target.root,"packages/database/package.json")));
 const{readMigrationFiles}=require("drizzle-orm/migrator") as{readMigrationFiles(input:{migrationsFolder:string}):Array<{folderMillis:number;sql:string[];hash:string}>};
 const migrations=readMigrationFiles({migrationsFolder:resolve(target.root,"packages/database/migrations")});if(migrations.length!==174)throw new Error("Real174 prefix required");
 await database.client.begin(async tx=>{
  await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('yummyai-schema-migrations',0))");await tx.unsafe("create schema drizzle");await tx.unsafe("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
  for(const migration of migrations){for(const statement of migration.sql)await tx.unsafe(statement);await tx.unsafe("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)",[migration.hash,migration.folderMillis]);}
 });
}

/** Real original174 runtime checkpoints. Only model HTTP decisions are synthetic.
 * The response-ready case deliberately exits its process after durable receipt,
 * exactly before decode/adoption; no direct SQL fabricates that state. */
async function seedOriginal174(){
 const target=requireAgentNativeLegacyEnvironment(process.env,"current");if(!process.connected||process.env.E2E_AGENT_NATIVE_LEGACY_CHILD!=="174")throw new Error("Original174 seed requires its exact IPC parent");
 const send=(value:object)=>new Promise<void>((done,reject)=>process.send!(value,error=>error?reject(error):done()));
 const cleanup:Array<()=>Promise<unknown>|void>=[];let phase="graph",failure:unknown,crashAfterCheckpoint=false;
 try{
  await assertAgentNativeOriginal174Graph(target.root);const require=createRequire(pathToFileURL(resolve(target.root,"apps/api/package.json")));require("reflect-metadata");
  const load=(p:string)=>import(pathToFileURL(resolve(target.root,p)).href);
  const d=await load("packages/database/src/index.ts") as typeof OriginalDatabase;
  const fixtures=await load("apps/api/src/ai/agent-plan.test-fixture.ts") as typeof OriginalFixture;
  const serviceModule=await load("apps/api/src/ai/agent-plan.service.ts") as typeof OriginalService;
  const dispatchModule=await load("apps/api/src/ai/redis-agent-plan-dispatcher.ts") as typeof OriginalDispatcher;
  const core=await load("packages/ai-core/src/index.ts") as typeof OriginalCore;
  const jobs=await load("packages/jobs/src/index.ts") as typeof OriginalJobs;
  const commands=await load("packages/contracts/src/ai/agent-command.ts") as typeof OriginalCommands;
  const database=d.connectDatabase(target.url);cleanup.unshift(()=>database.client.end());await d.assertDatabaseMigrationsCurrent(database);
  if((await d.readMigrationEvidence(database)).actualRows.length!==174)throw new Error("Genuine174 schema required");
  const vault=core.createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY","yummyai:ai-assist");
  const f=fixtures.agentPlanFixture(database,{contentVault:vault});cleanup.unshift(()=>f.close());
  phase="original174-identity-provider";await f.initialize();const context=f.base.a.context,source=await f.source();
  const dispatcher=new dispatchModule.RedisAgentPlanDispatcher();cleanup.unshift(()=>dispatcher.onModuleDestroy());
  const service=new serviceModule.AgentPlanService(database,vault,f.gateway,f.owners.service(),f.owners.adapter,dispatcher);
  const queue=jobs.createQueue(jobs.QueueName.AgentPlan,process.env.E2E_DISPOSABLE_REDIS_URL);cleanup.unshift(()=>queue.close());
  const executeJob=async(id:string)=>{const found=(await queue.getJobs(["wait","delayed","active","completed","failed","paused"],0,-1)).find(job=>job.data?.payload?.runId===id&&job.data?.payload?.operation==="execute");if(!found?.id)throw new Error("Original174 real Redis execute intent missing");return found.id;};
  f.controls.decision=packet=>packet.collections.length?fixtures.finishPlan(packet,[source.requisition]):{action:"read",label:"Read actual original174 inventory",read:{tool:"inventory.balances.page",query:{stockItemId:source.stockItemId,locationId:source.locations[0]}},result:null};
  const completedInput=await f.request(),completed=await service.start(context,completedInput);
  phase="original174-real-inventory-model-and-preparation";await f.runtime().process(context,completed.id);
  let completedView=await service.get(context,completed.id);const proposal=completedView.result?.proposals[0];if(completedView.status!=="completed"||!proposal?.draft.original)throw new Error("Original174 actual completed proposal required");
  const staged=await service.prepareItem(context,completed.id,proposal.id,f.prepareInput(completedView,proposal));if(staged.disposition!=="known"||!staged.agentCommandId||!staged.ownerCommandId)throw new Error("Original174 actual original child required");
  const preparedInput=commands.PrepareAgentCommandSchema.parse({version:commands.AGENT_COMMAND_VERSION,requestId:proposal.id,original:proposal.draft.original});
  const prepared=await f.owners.service().get(context,staged.agentCommandId),preparedReceipt=await f.owners.service().receipt(context,{requestId:proposal.id,requestChecksum:proposal.preparationRequestChecksum});
  completedView=await service.get(context,completed.id);
  f.controls.decision=packet=>fixtures.finishPlan(packet);const queuedInput=await f.request(),queued=await service.start(context,queuedInput);
  const unknownInput=await f.request(),unknown=await service.start(context,unknownInput);
  f.controls.beforeModel=async()=>{throw new DOMException("Synthetic original174 submitted response lost","TimeoutError");};
  phase="original174-real-submitted-unknown";try{await f.runtime().process(context,unknown.id);}finally{f.controls.beforeModel=undefined;}
  const unknownView=await service.get(context,unknown.id);if(unknownView.status!=="uncertain")throw new Error("Original174 uncertain phase missing");
  const receivedInput=await f.request(),received=await service.start(context,receivedInput);
  let notify!:()=>void;const checkpoint=new Promise<void>(done=>{notify=done;});
  f.controls.afterCheckpoint=async()=>{notify();await new Promise<void>(()=>{});};
  phase="original174-durable-response-before-adoption";const processing=f.runtime().process(context,received.id);
  await Promise.race([checkpoint,processing.then(()=>{throw new Error("Original174 response checkpoint unexpectedly adopted");})]);
  const receivedView=await service.get(context,received.id);if(receivedView.steps.at(-1)?.phase!=="response_ready"||receivedView.steps.at(-1)?.submissionState!=="received")throw new Error("Original174 durable response phase missing");
  await send({type:"agent.native.seeded174",context,plans:[
   {state:"completed",input:completedInput,view:completedView,queueJobId:await executeJob(completed.id)},
   {state:"queued",input:queuedInput,view:await service.get(context,queued.id),queueJobId:await executeJob(queued.id)},
   {state:"response_ready",input:receivedInput,view:receivedView,queueJobId:await executeJob(received.id)},
   {state:"uncertain",input:unknownInput,view:unknownView,queueJobId:await executeJob(unknown.id)},
  ],commandContext:context,preparedInput,prepared,preparedReceipt,originalModelCalls:f.modelCalls.length});
  crashAfterCheckpoint=true;
 }catch(error){failure=error;const codes:string[]=[];let cause:unknown=error;for(let i=0;i<6&&cause&&typeof cause==="object";i++){if("code"in cause&&typeof cause.code==="string"&&/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|ECONNREFUSED|ETIMEDOUT)$/.test(cause.code))codes.push(cause.code);cause="cause"in cause?cause.cause:null;}await send({type:"agent.native.failed",phase,codes,code:codes[0]??null,errorName:error instanceof Error?error.name:"Error"});}
 const errors:unknown[]=[];for(const close of cleanup)try{await close();}catch(error){errors.push(error);}
 if(errors.length)await send({type:"agent.native.failed",phase:"original174-cleanup",code:null,errorName:"AggregateError"});
 if(failure!==undefined||errors.length)throw new AggregateError([...(failure===undefined?[]:[failure]),...errors],"Original174 seed or cleanup failed");
 if(crashAfterCheckpoint)process.exit(0);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{await seedOriginal174();}catch{process.exitCode=1;}}
