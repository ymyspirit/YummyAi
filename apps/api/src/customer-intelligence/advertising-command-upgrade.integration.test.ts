import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { connectDatabase } from "@yummyai/database";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

const parentUrl = new URL(requireDisposableIntegrationEnvironment());
const parentNonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(parentUrl.pathname)?.[1];
const localHosts = ["localhost", "127.0.0.1", "[::1]"];
const endpoint = new URL(process.env.S3_ENDPOINT ?? "http://invalid");
if (process.env.E2E_ADVERTISING_COMMAND_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current"
  || !parentNonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${parentNonce}`
  || !localHosts.includes(parentUrl.hostname) || parentUrl.search || parentUrl.hash
  || !["http:", "https:"].includes(endpoint.protocol) || !localHosts.includes(endpoint.hostname) || endpoint.search || endpoint.hash)
  throw new Error("Advertising upgrade requires its dedicated matching loopback disposable runner before connection");

const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const ownedRoot = resolve(workspace, "tmp/advertising-command-20261021-e3a58d70");
const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-advertising-command-e3a58d70");
const originalSha256 = "206d76c8e37c50898c2d52519772a3c41e7ae321fc266803d20dcbd6a0ee7e9f";
const storageRequire = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url));
const { S3Client, CreateBucketCommand, HeadBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = storageRequire("@aws-sdk/client-s3");

// A child-local environment keeps the parent runner's DATABASE_URL and bucket
// unchanged. Both original157 and current owners use the same exact child group.
// No business source is imported until that group has been checked in the child.
const upgradeSource = String.raw`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const originalRoot=process.env.E2E_ADVERTISING_COMMAND_LEGACY_SOURCE,currentRoot=process.env.E2E_ADVERTISING_COMMAND_CURRENT_SOURCE;
const url=new URL(process.env.DATABASE_URL??'postgres://invalid/invalid'),nonce=/^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if(!process.connected||process.env.E2E_ISOLATED_DAILY!=='1'||process.env.E2E_ADVERTISING_COMMAND_ISOLATED!=='1'
 ||!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)
 ||!nonce||process.env.S3_PRIVATE_BUCKET!=='order-daily-e2e-'+nonce||!originalRoot||!currentRoot)
 throw Error('Exact nested advertising upgrade IPC group required');
const old=path=>import(pathToFileURL(resolve(originalRoot,path)).href);
let currentLoader;
const current=async path=>{
 if(!currentLoader){
  const {register}=createRequire(pathToFileURL(resolve(currentRoot,'apps/api/package.json')))('tsx/esm/api');
  currentLoader=register({namespace:'synthetic158-'+nonce,tsconfig:resolve(currentRoot,'apps/api/tsconfig.json')});
 }
 return currentLoader.import(pathToFileURL(resolve(currentRoot,path)).href,pathToFileURL(resolve(currentRoot,'apps/api/package.json')).href);
};
createRequire(pathToFileURL(resolve(originalRoot,'apps/api/package.json')))('reflect-metadata');
const oldDatabase=await old('packages/database/src/index.ts');
let database=oldDatabase.connectDatabase(),phase='actual157-migration';
const oldTables=['ad_import_batches','ad_imports','ad_facts','ad_products','ad_goal_versions','ad_observations','ad_analysis_runs','ad_actions','ad_action_events','ad_import_events','ad_exports','audit_events'];
const newTables=['advertising_commands','advertising_original_write_proofs','advertising_owner_mutation_evidence','advertising_command_audit_receipts'];
const auditActions=['advertising.import','advertising.goal.version','advertising.observation','advertising.analyze','advertising.action.transition','advertising.import.archive','advertising.export.seal'];
try{
 await oldDatabase.migrateDatabase(database);
 const oldLedger=(await oldDatabase.readMigrationEvidence(database)).actualRows;assert.equal(oldLedger.length,157);
 for(const table of newTables)assert.equal((await database.client.unsafe('select to_regclass($1) as name',[table]))[0].name,null);
 const {createEntityId}=await old('packages/contracts/src/common/ids.ts');
 const {Permission}=await old('packages/authz/src/index.ts');
 const {AdGoalFieldsSchema,AdImportInputSchema,AdObservationInputSchema,AdActionEventInputSchema}=await old('packages/contracts/src/customer-intelligence/advertising-workbench.ts');
 const {createStorageFromEnvironment,ClamAvScanner}=await old('packages/storage/src/index.ts');
 const {AuditService:OldAudit}=await old('apps/api/src/audit/audit.service.ts');
 const {AdvertisingService:OldAdvertising}=await old('apps/api/src/customer-intelligence/advertising.service.ts');
 const {AdSourceGateway:OldGateway}=await old('apps/api/src/customer-intelligence/ad-source.gateway.ts');
 const permissions=[Permission.CustomerIntelligenceRead,Permission.CustomerIntelligenceWrite,Permission.CustomerIntelligenceReview];
 const context={tenantId:createEntityId(),userId:createEntityId(),permissions,dataScope:'tenant'};
 const foreign={...context,tenantId:createEntityId(),userId:createEntityId()};
 phase='original157-memberships';
 for(const actor of [context,foreign]){
  await database.client.unsafe('insert into organizations(id,name,slug) values($1,$2,$3)',[actor.tenantId,'Synthetic actual157 advertising upgrade '+actor.tenantId,'ad-upgrade157-'+actor.tenantId]);
  await database.client.unsafe('insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)',[actor.userId,'ad-upgrade157-'+actor.userId,actor.userId+'@yummyai.invalid','Synthetic original157 '+actor.userId]);
  const membershipId=createEntityId(),roleId=createEntityId();
  await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",[membershipId,actor.tenantId,actor.userId]);
  await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",[roleId,actor.tenantId,'Synthetic original157 '+roleId,JSON.stringify(permissions)]);
  await database.client.unsafe('insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)',[actor.tenantId,membershipId,roleId]);
 }
 const accountId=createEntityId();
 await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon',$3,'NA','amazon_private',$4)",[accountId,context.tenantId,'Synthetic original157 shop '+accountId,context.userId]);
 const storage=createStorageFromEnvironment();await storage.assertBucketReady();
 const advertising=new OldAdvertising(database,new OldAudit(database),new OldGateway(storage,new ClamAvScanner()));
 const key=()=> 'synthetic-original157-'+randomUUID(),scope={accountId,marketplace:'US',currency:'USD',asin:'B012345678'};
 const originals=[];
 async function raw(owner,original){
  switch(original.kind){
   case 'import_commit':return owner.commit(context,original.input);
   case 'goal_save':return owner.saveGoal(context,original.input);
   case 'observation_record':return owner.recordObservation(context,original.input);
   case 'analysis_run':return owner.analyze(context,original.input);
   case 'action_transition':return owner.transition(context,original.targetId,original.input);
   case 'import_archive':return owner.archive(context,original.targetId,original.input);
   case 'export_seal':return owner.sealExport(context,original.input);
  }
  throw Error('Unknown synthetic original kind');
 }
 async function save(kind,targetId,input){const original={kind,accountId,targetId,input};originals.push(original);return raw(advertising,original);}
 const header='Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Purchases,Spend,Sales';
 const row='2026-09-01 - 2026-09-15,synthetic-original157,SP,campaign,group,USD,1000,40,4,10.00,40.00';
 const files=[{fileName:'synthetic-original157-campaign.csv',content:header+'\n'+row},
  {fileName:'synthetic-original157-product.csv',content:header+',Advertised ASIN\n'+row+',B012345678'},
  {fileName:'synthetic-original157-target.csv',content:header+',Targeting ID,Targeting,Bid,State\n'+row+',target,custom pillow,1.00,ENABLED'}];
 const importInput=AdImportInputSchema.parse({accountId,files,marketplaceByCurrency:{USD:'US'},timezone:'America/Los_Angeles',attributionWindowDays:7,
  attributionBasis:'click',conversionDefinition:{model:'click',source:'Synthetic original157 report settings explicitly confirm click attribution'},
  observedAt:'2026-10-01T18:00:00.000Z',allowPartial:false,idempotencyKey:key()});
 phase='original157-real-scan-import';
 const preview=await advertising.preview(context,importInput);assert.equal(preview.canCommit,true);
 const imported=await save('import_commit',null,{...importInput,previewChecksum:preview.previewChecksum});
 assert.equal(imported.imports.length,3);
 phase='original157-goal';
 const goal=await save('goal_save',null,{scope,expectedRevision:0,fields:AdGoalFieldsSchema.parse({mode:'profit_defense',effectiveFrom:'2026-09-01',
  targetAcosBps:2100,unitPriceMinor:10000,unitCostMinor:7000,coreKeywords:[],protectedTerms:[],trialEndDate:null,trialSpendLimitMinor:null}),idempotencyKey:key()});
 assert.equal(goal.revision,1);
 phase='original157-observation';
 const observationInput=AdObservationInputSchema.parse({scope,kind:'commerce',periodStart:'2026-09-01',periodEnd:'2026-09-15',source:'Synthetic original157 commerce ledger',
  keyword:null,organicRank:null,totalSalesMinor:10000,totalPurchases:10,preAdContributionMinor:3000,observedAt:'2026-10-01T18:00:00.000Z',idempotencyKey:key()});
 await save('observation_record',null,observationInput);
 phase='original157-analysis';
 const [clock]=await database.client.unsafe('select clock_timestamp() as now');
 const run=await save('analysis_run',null,{accountId,periodStart:'2026-09-01',periodEnd:'2026-09-15',marketplace:null,currency:null,
  evidenceCutoffAt:new Date(Math.max(Date.now(),new Date(clock.now).getTime())).toISOString(),idempotencyKey:key()});
 const action=(await advertising.workspace(context,accountId)).actions.find(value=>value.runId===run.id&&value.recommendation.kind==='lower_bid');
 assert.ok(action,'Actual original157 lower-bid recommendation required');
 phase='original157-reviewed-execution';
 const adopted=await advertising.transition(context,action.id,AdActionEventInputSchema.parse({expectedRevision:action.revision,expectedStatus:action.status,
  status:'adopted',reason:'Synthetic actual review No external advertising operation',idempotencyKey:key()}));
 assert.ok(Number.isSafeInteger(action.recommendation.currentBidMinor)&&action.recommendation.currentBidMinor>0);
 assert.ok(Number.isSafeInteger(action.recommendation.proposedBidMinor)&&action.recommendation.proposedBidMinor>0);
 const executed=await save('action_transition',action.id,AdActionEventInputSchema.parse({expectedRevision:adopted.revision,expectedStatus:adopted.status,status:'executed',
  reason:'Synthetic recorded historical manual execution No external advertising call',executedAt:new Date().toISOString(),
  actualBeforeMinor:action.recommendation.currentBidMinor,actualAfterMinor:action.recommendation.proposedBidMinor,
  executionCampaignId:action.recommendation.campaignId,executionAdGroupId:action.recommendation.adGroupId,executionTargetId:action.recommendation.targetId,idempotencyKey:key()}));
 assert.equal(executed.status,'executed');
 phase='original157-export';
 const exported=await save('export_seal',run.id,{runId:run.id,actionIds:[executed.id],reviewReason:'Synthetic original157 immutable manual checklist No external API',idempotencyKey:key()});
 assert.equal(exported.payload.actions[0].status,'executed');
 phase='original157-archive';
 await save('import_archive',imported.imports[0].id,{reason:'Synthetic archived source preserves original bytes and prior sealed results',idempotencyKey:key()});
 assert.equal(originals.length,7);
 // Action/import replays intentionally return their current original parent view.
 // Capture the real old owner's post-archive replay instead of inventing one.
 const expected=[];for(const original of originals)expected.push(await raw(advertising,original));
 for(const file of imported.imports){const saved=files.find(value=>value.fileName===file.fileName);assert.ok(saved);
  assert.equal(Buffer.from((await advertising.readSource(context,file.id)).bytes).toString('utf8'),saved.content);}
 await database.client.end();
 phase='before158-original-checkpoint';
 const currentDatabase=await current('packages/database/src/index.ts');database=currentDatabase.connectDatabase();
 const {captureLegacyDataCheckpoint}=await current('tools/testing/legacy-data-checkpoint.mts');
 const {sql}=createRequire(pathToFileURL(resolve(currentRoot,'apps/api/package.json')))('drizzle-orm');
 const checkpoint=await captureLegacyDataCheckpoint(database),before=await checkpoint.snapshot();
 async function originalRows(){return currentDatabase.withTenant(database.db,context,async tx=>{
  const rows={};for(const table of oldTables){const result=await tx.execute(sql.raw('select id,to_jsonb(t)::text as body from '+table+' t order by id'));
   rows[table]=Array.from(result,row=>({id:String(row.id),body:String(row.body)}));}return rows;});}
 const originalsBefore=await originalRows();
 const originalAudits=originalsBefore.audit_events.map(value=>JSON.parse(value.body));
 for(const actionName of auditActions)assert.ok(originalAudits.some(value=>value.action===actionName));
 assert.ok(originalsBefore.ad_action_events.length>=3);assert.equal(originalsBefore.ad_import_events.length,1);
 await assert.rejects(currentDatabase.assertDatabaseMigrationsCurrent(database),error=>error.code==='DATABASE_MIGRATIONS_NOT_READY');
 phase='apply158-migration';
 await currentDatabase.migrateDatabase(database);
 phase='apply158-readiness';await currentDatabase.assertDatabaseMigrationsCurrent(database);
 phase='apply158-read-ledger';
 const afterEvidence=await currentDatabase.readMigrationEvidence(database),afterLedger=afterEvidence.actualRows;
 phase='ledger-count-'+afterLedger.length;assert.equal(afterLedger.length,158);
 phase='ledger-old-prefix-index-'+oldLedger.findIndex((row,index)=>!isDeepStrictEqual(afterLedger[index],row));
 assert.deepEqual(afterLedger.slice(0,157),oldLedger);
 phase='ledger-canonical-index-'+afterEvidence.canonicalRows.findIndex((row,index)=>!isDeepStrictEqual(afterLedger[index],row));
 assert.deepEqual(afterLedger,afterEvidence.canonicalRows);
 phase='apply158-read-checkpoint';const afterCheckpoint=await checkpoint.snapshot();
 const changedCheckpoint=before.find(row=>!isDeepStrictEqual(afterCheckpoint.find(value=>value.table===row.table),row));
 phase=('checkpoint-'+(changedCheckpoint?.table??'all-tables')).replaceAll('_','-').slice(0,63);
 assert.deepEqual(afterCheckpoint,before);
 phase='apply158-read-original-rows';const afterOriginalRows=await originalRows();
 const changedTable=oldTables.find(table=>!isDeepStrictEqual(afterOriginalRows[table],originalsBefore[table]));
 if(changedTable){
  const left=originalsBefore[changedTable],right=afterOriginalRows[changedTable];
  const sameValues=isDeepStrictEqual(Array.from(left),Array.from(right));
  const metadataKey=sameValues?Object.keys(left).find(key=>!/^\d+$/.test(key)&&!isDeepStrictEqual(left[key],right[key])):null;
  phase=('rows-'+changedTable+(sameValues?'-metadata-'+(metadataKey??'prototype'):'-values')).replaceAll('_','-').slice(0,63);
 }else phase='rows-all-tables';
 assert.deepEqual(afterOriginalRows,originalsBefore);
 phase='load158-audit';const {AuditService}=await current('apps/api/src/audit/audit.service.ts');
 phase='load158-owner';const {AdvertisingService}=await current('apps/api/src/customer-intelligence/advertising.service.ts');
 phase='load158-gateway';const {AdSourceGateway}=await current('apps/api/src/customer-intelligence/ad-source.gateway.ts');
 phase='load158-storage';const currentStorage=await current('packages/storage/src/index.ts');
 phase='load158-owner-adapter';const {AdvertisingCommandOwnerAdapter}=await current('apps/api/src/customer-intelligence/advertising-command-owner.ts');
 phase='load158-command';const {AdvertisingCommandService}=await current('apps/api/src/customer-intelligence/advertising-command.service.ts');
 phase='load158-vault';const {createAdvertisingCommandVault}=await current('apps/api/src/customer-intelligence/advertising-command-vault.ts');
 phase='load158-command-schema';const {PrepareAdCommandSchema}=await current('packages/contracts/src/customer-intelligence/advertising-command.ts');
 phase='construct158-audit';const audit=new AuditService(database);
 phase='construct158-storage';const currentPrivateStorage=currentStorage.createStorageFromEnvironment();
 phase='construct158-scanner';const currentScanner=new currentStorage.ClamAvScanner();
 phase='construct158-gateway';const gateway=new AdSourceGateway(currentPrivateStorage,currentScanner);
 phase='construct158-owner';const owner=new AdvertisingService(database,audit,gateway);
 phase='construct158-vault';const vault=createAdvertisingCommandVault();
 phase='construct158-owner-adapter';const adapter=new AdvertisingCommandOwnerAdapter(owner);
 phase='construct158-command';const commands=new AdvertisingCommandService(database,vault,adapter,audit);
 async function emptyNewTables(){return currentDatabase.withTenant(database.db,context,async tx=>{
  for(const table of newTables)assert.equal((await tx.execute(sql.raw('select count(*)::int as count from '+table)))[0].count,0);});}
 phase='all-seven-original-raw-replays';
 await emptyNewTables();
 for(let index=0;index<originals.length;index++){
  const original=originals[index];assert.deepEqual(await raw(owner,original),expected[index],original.kind+' original replay');
  await assert.rejects(commands.prepare(context,PrepareAdCommandSchema.parse(original)),error=>error.status===409);
  await emptyNewTables();
 }
 assert.deepEqual(await checkpoint.snapshot(),before);assert.deepEqual(await originalRows(),originalsBefore);
 for(const file of imported.imports){const saved=files.find(value=>value.fileName===file.fileName);
  assert.equal(Buffer.from((await owner.readSource(context,file.id)).bytes).toString('utf8'),saved.content);}
 phase='forced-rls-and-protected-proof-privileges';
 const shape=await currentDatabase.inspectDatabaseSchemaShape(database.client);assert.match(shape.sha256,/^[a-f0-9]{64}$/);
 const properties=await database.client.unsafe('select c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=any($2::text[])',['public',newTables]);
 assert.equal(properties.length,4);assert.ok(properties.every(row=>row.relrowsecurity&&row.relforcerowsecurity&&row.owner!=='yummyai_app'));
 await currentDatabase.withTenant(database.db,context,async tx=>{
  const [role]=await tx.execute(sql.raw("select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user"));
  assert.equal(role.name,'yummyai_app');assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  for(const table of newTables){const [privilege]=await tx.execute(sql.raw("select has_table_privilege(current_user,'"+table+"','SELECT') as readable,has_table_privilege(current_user,'"+table+"','INSERT') as insertable,has_table_privilege(current_user,'"+table+"','UPDATE') as updatable,has_table_privilege(current_user,'"+table+"','DELETE') as deletable"));
   assert.equal(privilege.readable,true);assert.equal(privilege.insertable,table==='advertising_commands');assert.equal(privilege.updatable,table==='advertising_commands');assert.equal(privilege.deletable,false);}
 });
 const code=error=>error?.cause?code(error.cause):error?.code;
 await assert.rejects(currentDatabase.withTenant(database.db,context,tx=>tx.execute(sql.raw('delete from advertising_original_write_proofs'))),error=>code(error)==='42501');
 phase='fresh158-parse';
 const fresh=PrepareAdCommandSchema.parse({kind:'observation_record',accountId,targetId:null,input:{...observationInput,source:'Synthetic fresh158 evidence after actual157 upgrade',idempotencyKey:key()}});
 phase='fresh158-prepare';const prepared=await commands.prepare(context,fresh);
 phase='fresh158-assert-prepared';assert.equal(prepared.status,'prepared');assert.equal(prepared.canExecute,true);
 phase='fresh158-foreign-zero-rows';
 await currentDatabase.withTenant(database.db,foreign,async tx=>assert.equal((await tx.execute(sql.raw('select id from advertising_commands'))).length,0));
 phase='fresh158-foreign-get';
 await assert.rejects(commands.get(foreign,prepared.id,accountId),error=>error.status===404);
 phase='fresh158-execute';const done=await commands.execute(context,prepared.id,accountId);
 phase='fresh158-assert-succeeded';assert.equal(done.status,'succeeded');assert.equal(done.result.kind,'observation_record');
 phase='fresh158-execute-replay';
 assert.deepEqual((await commands.execute(context,prepared.id,accountId)).result,done.result);
 phase='fresh158-acknowledge';
 await commands.acknowledge(context,prepared.id,accountId);
 phase='fresh158-original-cleared';
 assert.equal((await commands.original(context,prepared.id,accountId)).original,null);
 phase='fresh158-preserve-original-rows';
 const afterRows=await originalRows();
 for(const table of oldTables)for(const saved of originalsBefore[table])assert.deepEqual(afterRows[table].find(value=>value.id===saved.id),saved,table+' original row preserved');
 phase='fresh158-proofs';
 await currentDatabase.withTenant(database.db,context,async tx=>{
  assert.equal((await tx.execute(sql.raw('select count(*)::int as count from advertising_commands')))[0].count,1);
  const proofs=await tx.execute(sql.raw('select command_id,kind,result_id from advertising_original_write_proofs'));
  assert.equal(proofs.length,1);assert.equal(proofs[0].command_id,prepared.id);assert.equal(proofs[0].result_id,done.result.id);
 });
 const proof={oldMigrations:157,newMigrations:158,oldKinds:7,originalTables:before.length,oldAuditCount:originalAudits.length,
  oldSourceBytesVerified:files.length,noHistoricalBackfill:true,originalRowsPreserved:true,rawReplaysPreserved:7,
  historicalPreparationsRejected:7,forcedRlsTables:properties.length,newActualResults:1,schemaSha256:shape.sha256};
 await database.client.end();database=undefined;
 process.send({type:'advertising.command.upgrade.passed',proof},()=>process.exit(0));
}catch(error){
 if(database)await database.client.end().catch(()=>{});
 const safe=/^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/;
 const values=[error?.code,error?.cause?.code],code=values.find(value=>typeof value==='string'&&safe.test(value));
 const errorName=typeof error?.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,49}$/.test(error.name)?error.name:undefined;
 const errorMessage=typeof error?.message==='string'&&/^[A-Za-z0-9_. ]{1,120}$/.test(error.message)?error.message:undefined;
 process.send({type:'advertising.command.upgrade.failed',phase,...(code?{code}:{}),...(errorName?{errorName}:{}),...(errorMessage?{errorMessage}:{})},()=>process.exit(1));
}
`;

type UpgradeProof = { oldMigrations: number; newMigrations: number; oldKinds: number; originalTables: number; oldAuditCount: number;
  oldSourceBytesVerified: number; noHistoricalBackfill: boolean; originalRowsPreserved: boolean; rawReplaysPreserved: number;
  historicalPreparationsRejected: number; forcedRlsTables: number; newActualResults: number; schemaSha256: string };
type UpgradeFailure = { phase: string; code?: string; errorName?: string; errorMessage?: string };

function missing(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return value?.name === "NotFound" || value?.name === "NoSuchBucket" || value?.$metadata?.httpStatusCode === 404;
}

it("upgrades byte-verified actual157 advertising histories to158 without changing raw facts, bodies, hashes, events, audits or replays", async () => {
  const manifest = JSON.parse(await readFile(prefix + "-source-before.json", "utf8")) as { sha256: string; files: Array<{ path: string; sha256: string }> };
  const metadata = JSON.parse(await readFile(prefix + "-old157.json", "utf8")) as { snapshot: string; sourceSha256: string; sourceFiles: number; noEnvironmentCopied: boolean };
  const originalRoot = process.env.E2E_ADVERTISING_COMMAND_LEGACY_SOURCE ?? metadata.snapshot;
  expect(isAbsolute(originalRoot)).toBe(true); expect(resolve(originalRoot)).toBe(resolve(ownedRoot, "old157-source"));
  expect(resolve(metadata.snapshot)).toBe(resolve(originalRoot)); expect(metadata.noEnvironmentCopied).toBe(true);
  expect(metadata.sourceFiles).toBe(2803); expect(metadata.sourceSha256).toBe(originalSha256);
  expect(manifest.sha256).toBe(originalSha256); expect(manifest.files).toHaveLength(2803);
  for (const file of manifest.files) {
    const path = resolve(originalRoot, file.path), inside = relative(originalRoot, path);
    if (isAbsolute(file.path) || inside.startsWith("..") || isAbsolute(inside) || /(?:^|\/)\.env$/.test(file.path.replaceAll("\\", "/")))
      throw new Error("Original157 source path is outside the verified no-environment snapshot");
    expect(createHash("sha256").update(await readFile(path)).digest("hex"), file.path).toBe(file.sha256);
  }
  if (!process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) throw new Error("Disposable private storage configuration required");
  const nonce = randomUUID().replaceAll("-", ""), name = `order_daily_e2e_${nonce}`, bucket = `order-daily-e2e-${nonce}`;
  const targetUrl = new URL(parentUrl), adminUrl = new URL(parentUrl);
  targetUrl.pathname = `/${name}`; adminUrl.pathname = "/postgres";
  if (!/^order_daily_e2e_[a-f0-9]{32}$/.test(name) || bucket !== name.replaceAll("_", "-") || targetUrl.pathname === parentUrl.pathname || nonce === parentNonce)
    throw new Error("Unsafe nested advertising upgrade group");
  const resourcePath = resolve(ownedRoot, `upgrade-${nonce}-resources.json`);
  const resources = { operation: "e3a58d70", kind: "advertising-command-actual157-upgrade", database: name, bucket,
    parentDatabase: parentUrl.pathname.slice(1), sourceSha256: originalSha256, databaseCreateAttempted: false, databaseCreated: false,
    databaseDeleted: false, bucketCreateAttempted: false, bucketCreated: false, bucketDeleted: false, removedObjects: 0,
    childPid: null as number | null, childExited: false, passed: false, ordinaryDatabaseTouched: false,
    proof: null as UpgradeProof | null, failure: null as UpgradeFailure | null, cleanupErrors: [] as string[] };
  await mkdir(ownedRoot, { recursive: true });
  await writeFile(resourcePath, JSON.stringify(resources, null, 2) + "\n", { flag: "wx" });
  const saveResources = () => writeFile(resourcePath, JSON.stringify(resources, null, 2) + "\n");
  const admin = connectDatabase(adminUrl.href), storage = new S3Client({ endpoint: endpoint.href, forcePathStyle: true,
    region: process.env.S3_REGION ?? "us-east-1", credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
  let child: InvoiceProcess | undefined;
  const commandKey = randomBytes(32);
  let failed = false, failure: unknown;
  async function cleanupBucket() {
    if (!resources.bucketCreateAttempted) return;
    let exists = true;
    try { await storage.send(new HeadBucketCommand({ Bucket: bucket })); }
    catch (error) { if (!missing(error)) throw error; exists = false; }
    if (exists) {
      for (;;) {
        const page = await storage.send(new ListObjectsV2Command({ Bucket: bucket }));
        const keys = (page.Contents ?? []).map((object: { Key?: string }) => ({ Key: object.Key })).filter((object: { Key?: string }) => Boolean(object.Key));
        if (!keys.length) break;
        const removed = await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
        if (removed.Errors?.length) throw new Error("Nested advertising object cleanup failed");
        resources.removedObjects += keys.length;
      }
      await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    let absent = false;
    try { await storage.send(new HeadBucketCommand({ Bucket: bucket })); }
    catch (error) { if (!missing(error)) throw error; absent = true; }
    if (!absent) throw new Error("Nested advertising bucket deletion not verified");
    resources.bucketDeleted = true;
  }
  async function cleanupDatabase() {
    if (!resources.databaseCreateAttempted) return;
    if ((await admin.client.unsafe("select datname from pg_database where datname=$1", [name])).length)
      await admin.client.unsafe(`drop database ${name} with (force)`);
    resources.databaseDeleted = (await admin.client.unsafe("select datname from pg_database where datname=$1", [name])).length === 0;
    if (!resources.databaseDeleted) throw new Error("Nested advertising database deletion not verified");
  }
  try {
    expect((await admin.client.unsafe("select current_database() as name"))[0]!.name).toBe("postgres");
    expect(await admin.client.unsafe("select datname from pg_database where datname=$1", [name])).toEqual([]);
    resources.databaseCreateAttempted = true; await saveResources();
    await admin.client.unsafe(`create database ${name}`); resources.databaseCreated = true; await saveResources();
    let absent = false;
    try { await storage.send(new HeadBucketCommand({ Bucket: bucket })); }
    catch (error) { if (!missing(error)) throw error; absent = true; }
    if (!absent) throw new Error("Nested advertising bucket already exists");
    resources.bucketCreateAttempted = true; await saveResources();
    await storage.send(new CreateBucketCommand({ Bucket: bucket })); resources.bucketCreated = true; await saveResources();
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", upgradeSource], {
      cwd: resolve(originalRoot, "apps/api"), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        DATABASE_URL: targetUrl.href, S3_PRIVATE_BUCKET: bucket, E2E_ADVERTISING_COMMAND_LEGACY_SOURCE: originalRoot,
        E2E_ADVERTISING_COMMAND_CURRENT_SOURCE: workspace, ADVERTISING_COMMAND_ENCRYPTION_KEY: commandKey.toString("base64url"),
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(originalRoot, "apps/api/tsconfig.json") },
    }));
    resources.childPid = child.child.pid ?? null; await saveResources();
    const message = await child.wait("advertising.command.upgrade.passed", undefined, 180_000) as unknown as { proof: UpgradeProof };
    expect(await child.closed).toBe(0); resources.childExited = true;
    expect(message.proof).toMatchObject({ oldMigrations: 157, newMigrations: 158, oldKinds: 7, oldSourceBytesVerified: 3,
      noHistoricalBackfill: true, originalRowsPreserved: true, rawReplaysPreserved: 7, historicalPreparationsRejected: 7,
      forcedRlsTables: 4, newActualResults: 1 });
    expect(message.proof.oldAuditCount).toBeGreaterThanOrEqual(8); expect(message.proof.originalTables).toBeGreaterThan(100);
    expect(message.proof.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
    resources.proof = message.proof; resources.passed = true; await saveResources();
  } catch (error) {
    failed = true; failure = error;
    const event = child?.events.findLast(value => value.type === "advertising.command.upgrade.failed") as (UpgradeFailure & { type: string }) | undefined;
    if (event && /^[a-z][a-z0-9-]{0,63}$/.test(event.phase)) {
      resources.failure = { phase: event.phase,
        ...(event.code && /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/.test(event.code) ? { code: event.code } : {}),
        ...(event.errorName && /^[A-Za-z][A-Za-z0-9]{0,49}$/.test(event.errorName) ? { errorName: event.errorName } : {}),
        ...(event.errorMessage && /^[A-Za-z0-9_. ]{1,120}$/.test(event.errorMessage) ? { errorMessage: event.errorMessage } : {}) };
      failure = new Error("Advertising upgrade child failed " + JSON.stringify(resources.failure), { cause: error });
    }
  } finally {
    if (child) try { await child.stop(true); resources.childExited = true; }
    catch { resources.cleanupErrors.push("nested_child_shutdown_failed"); }
    try { await cleanupBucket(); }
    catch { resources.cleanupErrors.push("nested_bucket_cleanup_failed"); }
    try { await cleanupDatabase(); }
    catch { resources.cleanupErrors.push("nested_database_cleanup_failed"); }
    try { await admin.client.end(); }
    catch { resources.cleanupErrors.push("nested_admin_connection_close_failed"); }
    commandKey.fill(0);
    try { storage.destroy(); }
    catch { resources.cleanupErrors.push("nested_storage_client_close_failed"); }
    resources.passed = resources.passed && !resources.cleanupErrors.length;
    try { await saveResources(); }
    catch { resources.cleanupErrors.push("nested_cleanup_record_write_failed"); }
    process.stdout.write(JSON.stringify({ advertisingCommandUpgradeResources: resources, resourcePath }) + "\n");
  }
  if (failed && resources.cleanupErrors.length) throw new AggregateError([failure, new Error(resources.cleanupErrors.join(","))], "Advertising upgrade and owned-resource cleanup failed");
  if (failed) throw failure;
  expect(resources.cleanupErrors).toEqual([]);
  expect(!resources.databaseCreateAttempted || resources.databaseDeleted).toBe(true);
  expect(!resources.bucketCreateAttempted || resources.bucketDeleted).toBe(true);
}, 240_000);
