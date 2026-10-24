import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretVault } from "@yummyai/ai-core";
import { type TenantContext, type CreateProductionOrderInput } from "@yummyai/contracts";
import type { FactoryView, FactoryCapabilityView } from "@yummyai/contracts/suppliers/factory-directory";
import { assertDatabaseMigrationsCurrent, connectDatabase, migrateDatabase, readMigrationEvidence, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "../orders/order.service.js";
import { OrderProductionService } from "../orders/order-production.service.js";
import { ProductionCommandService } from "../orders/production-command.service.js";
import { FactoryDirectoryService } from "./factory-directory.service.js";
import { FactoryCapacityService } from "./factory-capacity.service.js";
import { createSyntheticFactoryCapacity } from "./factory-capacity.test-fixture.js";
import { observeInvoiceProcess, type InvoiceProcess } from "../procurement/invoice-command.fixtures.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (process.env.E2E_FACTORY_CAPACITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0159" || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Actual158 capacity upgrade requires its exact pre-0159 disposable runner before connecting");
requireDisposableIntegrationEnvironment();

// Every business owner and schema in this child is imported from the original158
// source after guards. No present-day capacity field/proof is fabricated as history.
const seed = String.raw`
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve,isAbsolute} from 'node:path';import {randomUUID} from 'node:crypto';
const root=process.env.E2E_FACTORY_CAPACITY_LEGACY_SOURCE;
if(!process.connected||!root||!isAbsolute(root)||process.env.E2E_ISOLATED_DAILY!=='1'||process.env.E2E_FACTORY_CAPACITY_ISOLATED!=='1'||process.env.E2E_LEGACY_SCHEMA_TARGET!=='pre-0159'
 ||!/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL).pathname))throw Error('Actual158 isolated IPC required');
const load=p=>import(pathToFileURL(resolve(root,p)).href);createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('reflect-metadata');
const d=await load('packages/database/src/index.ts'),{Permission}=await load('packages/authz/src/index.ts'),{SecretVault}=await load('packages/ai-core/src/index.ts');
const {createEntityId}=await load('packages/contracts/src/index.ts'),{sql,eq}=createRequire(pathToFileURL(resolve(root,'apps/api/package.json')))('drizzle-orm');
const {AuditService}=await load('apps/api/src/audit/audit.service.ts'),{OrderService}=await load('apps/api/src/orders/order.service.ts');
const {OrderProductionService}=await load('apps/api/src/orders/order-production.service.ts'),{ProductionCommandService}=await load('apps/api/src/orders/production-command.service.ts');
const {FactoryDirectoryService}=await load('apps/api/src/suppliers/factory-directory.service.ts'),{createSyntheticFactory}=await load('apps/api/src/suppliers/factory-directory.test-fixture.ts');
const {syntheticNativeManufacturingForLine}=await load('apps/api/src/orders/manufacturing-production.test-fixture.ts');
const {syntheticSupplierProfile}=await load('tools/testing/factory-fixtures.ts');
const db=d.connectDatabase();let phase='initial';
try{
 if((await d.readMigrationEvidence(db)).actualRows.length!==158)throw Error('Actual158 ledger required');
 const tenantId=createEntityId(),userId=createEntityId(),accountId=createEntityId(),supplierId=createEntityId(),member=createEntityId(),role=createEntityId();
 const seed={tenantId,userId,permissions:Object.values(Permission),dataScope:'tenant'};
 await db.client.unsafe('insert into organizations(id,name,slug) values($1,$2,$3)',[tenantId,'Synthetic actual158 capacity history',tenantId]);
 await db.client.unsafe('insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)',[userId,userId,userId+'@example.invalid','Synthetic original158 operator']);
 await db.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",[member,tenantId,userId]);
 await db.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",[role,tenantId,role,JSON.stringify(seed.permissions)]);
 await db.client.unsafe('insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)',[tenantId,member,role]);
 await db.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)",[accountId,tenantId,accountId,userId]);
 const context=await d.withTenant(db.db,seed,tx=>d.loadCurrentMembershipContext(tx,seed));
 await d.withTenant(db.db,context,tx=>tx.insert(d.fulfillmentSuppliers).values({id:supplierId,tenantId,name:'Synthetic original158 supplier '+supplierId,kind:'manual',status:'active',regionCode:'US',settlementCurrency:'USD',profile:syntheticSupplierProfile,createdBy:userId}));
 const vault=new SecretVault(Buffer.alloc(32,122)),audit=new AuditService(db),orders=new OrderService(db,vault,audit),factories=new FactoryDirectoryService(db,audit);
 const site=await createSyntheticFactory(factories,context,supplierId,'rectangular_print','Synthetic actual158 factory '+supplierId),production=new OrderProductionService(db,vault,orders,audit,undefined,factories),commands=new ProductionCommandService(db,vault,production);
 async function source(){
  const suffix=createEntityId(),order=await orders.ingestNormalized(context,{accountId,platform:'etsy',externalEventId:suffix,externalOrderId:suffix,providerStatus:'paid',placedAt:new Date().toISOString(),orderTotal:null,
   lines:[{externalLineId:suffix,externalListingId:null,skuCode:null,title:'Synthetic original158 rectangular source',quantity:1,unitPrice:null,customizationCount:0}],redactedSource:{synthetic:true},protectedDetails:null});
  const lineId=order.lines[0].id,basis=await syntheticNativeManufacturingForLine(db,context,lineId,{productType:'rectangular_print'}),policyId=createEntityId(),decisionId=createEntityId(),po=createEntityId(),pv=createEntityId();
  await d.withTenant(db.db,context,async tx=>{
   await tx.update(d.orders).set({workflowState:'in_production'}).where(eq(d.orders.id,order.id));
   await tx.insert(d.routingPolicyVersions).values({id:policyId,tenantId,name:policyId,versionNumber:1,weights:{capability:2000,region:1000,cost:2000,leadTime:2000,capacity:1000,quality:1500,priority:500},thresholds:{minimumQualityBps:8000,maximumLeadTimeDays:10,maximumUnitCostMinor:2000,manualApprovalCostMinor:2000,manualApprovalRiskBps:2000},tieBreaker:['total_score','unit_cost','lead_time','supplier_id'],active:true,createdBy:userId});
   await tx.insert(d.orderRoutingDecisions).values({id:decisionId,tenantId,orderId:order.id,orderLineId:lineId,routingPolicyVersionId:policyId,versionNumber:1,status:'approved',selectedSupplierId:supplierId,inputChecksum:'a'.repeat(64),requiresApproval:false,approvalReasons:[],idempotencyKey:randomUUID()});
   await tx.insert(d.purchaseOrders).values({id:po,tenantId,supplierId,orderId:order.id,status:'approved',createdBy:userId});
   await tx.insert(d.purchaseOrderVersions).values({id:pv,tenantId,purchaseOrderId:po,versionNumber:1,currency:'USD',totalMinor:1,lineSnapshot:[{orderLineId:lineId,quantity:1,unitCostMinor:1}],routingDecisionIds:[decisionId],checksum:'b'.repeat(64),createdBy:userId});
  });
  return{orderId:order.id,input:{...site.pins,orderLineId:lineId,routingDecisionId:decisionId,purchaseOrderVersionId:pv,designVersionId:basis.designVersionId,productionAssetIds:basis.productionAssetIds,manufacturing:basis.manufacturing,productConfirmation:basis.productConfirmation,
   expectedCompletionAt:new Date(Date.now()+3*86400000).toISOString(),instructions:'Synthetic original158 immutable instructions',idempotencyKey:randomUUID()}};
 }
 phase='raw';const raw=await source(),rawResult=await production.create(context,raw.orderId,raw.input);
 phase='command';const successful=await source(),command=await commands.prepare(context,{kind:'approved_design',targetId:successful.orderId,input:successful.input}),executed=await commands.execute(context,command.id);
 if(executed.status!=='succeeded')throw Error('Actual158 command did not succeed');
 phase='prepared';const prepared=await source(),pending=await commands.prepare(context,{kind:'approved_design',targetId:prepared.orderId,input:prepared.input});
 const fresh=await source();process.send({type:'capacity.seeded158',context,site,raw:{...raw,id:rawResult.productionOrder.id},successful:{...successful,id:command.id,productionId:executed.receipt.productionOrderIds[0]},prepared:{...prepared,id:pending.id},fresh});
}catch(error){process.send?.({type:'capacity.failed',phase,code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:undefined});throw Error('Synthetic actual158 seed failed');}
finally{await db.client.end();}
`;

describe.sequential("genuine158 to159 capacity adoption", () => {
  const database = connectDatabase(); let child: InvoiceProcess | undefined;
  afterAll(async () => { try { if (child?.child.exitCode === null) await child.stop(true); } finally { await database.client.end(); } });
  it("keeps original receipts, ciphertext, columns and 158 ledger while leaving old production unreserved and blocking unknown usage", async () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url)), root = process.env.E2E_FACTORY_CAPACITY_LEGACY_SOURCE;
    if (!root || !isAbsolute(root) || resolve(root) !== resolve(workspace, "tmp/factory-capacity-20261021-a64d29f1/old158-source")) throw new Error("Pinned original158 source required");
    const prefix = resolve(workspace, "docs/project-control/checkpoints/2026-10-21-factory-capacity-a64d29f1");
    const baseline = JSON.parse(await readFile(prefix + "-baseline.json", "utf8")), source = JSON.parse(await readFile(prefix + "-source-before.json", "utf8"));
    const materialization = JSON.parse(await readFile(prefix + "-legacy-materialization.json", "utf8"));
    expect(resolve(materialization.target)).toBe(resolve(root)); expect(materialization).toMatchObject({ verified: true, environmentFilesCopied: false, ordinaryChanged: false, sourceFiles: 2835,
      sourceSha256: "551076c27ad167922ffa58c41029677dde39100ac84f37c32011aeebd410f000" });
    expect(source.sha256).toBe(baseline.sourceSha256); expect(source.files.length).toBe(baseline.sourceFiles);
    for (const file of source.files) expect(createHash("sha256").update(await readFile(resolve(root, file.path))).digest("hex"), file.path).toBe(file.sha256);
    child = observeInvoiceProcess(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "--input-type=module", "--eval", seed], {
      cwd: resolve(root, "apps/api"), env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    }));
    type Source = { orderId: string; input: CreateProductionOrderInput };
    const old = await child.wait("capacity.seeded158", undefined, 120_000) as unknown as { context: TenantContext; site: { factory: FactoryView; capability: FactoryCapabilityView };
      raw: Source & { id: string }; successful: Source & { id: string; productionId: string }; prepared: Source & { id: string }; fresh: Source };
    expect(await child.closed).toBe(0); const ledger = (await readMigrationEvidence(database)).actualRows; expect(ledger).toHaveLength(158);
    const checkpoint = await captureLegacyDataCheckpoint(database), before = await checkpoint.snapshot();
    await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database); expect(await checkpoint.snapshot()).toEqual(before);
    const migrated = (await readMigrationEvidence(database)).actualRows; expect(migrated).toHaveLength(159); expect(migrated.slice(0, 158)).toEqual(ledger);
    const vault = new SecretVault(Buffer.alloc(32, 122)), audit = new AuditService(database), factories = new FactoryDirectoryService(database, audit), orders = new OrderService(database, vault, audit);
    const production = new OrderProductionService(database, vault, orders, audit, undefined, factories), commands = new ProductionCommandService(database, vault, production), capacity = new FactoryCapacityService(database, audit);
    for (const table of ["factory_capacity_pools", "factory_capacity_versions", "factory_capacity_reservations", "factory_capacity_events", "factory_capacity_owner_proofs"]) {
      const [count] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.identifier(table)}`)); expect(count?.count).toBe(0);
    }
    expect((await production.create(old.context, old.raw.orderId, old.raw.input)).productionOrder.id).toBe(old.raw.id);
    expect((await commands.execute(old.context, old.successful.id)).receipt?.productionOrderIds).toEqual([old.successful.productionId]);
    expect(await checkpoint.snapshot()).toEqual(before);
    for (const id of [old.raw.id, old.successful.productionId]) expect(await capacity.production(old.context, id)).toMatchObject({ status: "legacy_unreserved", reservations: [] });
    await expect(production.create(old.context, old.raw.orderId, { ...old.raw.input, instructions: "Synthetic changed old body" })).rejects.toThrow(/重试/);
    const failed = await commands.execute(old.context, old.prepared.id); expect(failed.status).toBe("rejected"); expect(failed.receipt).toBeNull();
    const pool = await createSyntheticFactoryCapacity(database, old.context, { factory: old.site.factory, bindings: [{ capabilityVersionId: old.site.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10 });
    const view = await capacity.workspace(old.context, old.site.factory.id, { from: pool.localDate, days: 2 });
    expect(view.calendar.every(day => day.capacityUnits === null && day.availableUnits === 0 && day.blockers.includes("factory_capacity_legacy_untracked"))).toBe(true);
    const input = { ...old.fresh.input, capacityPlan: pool.capacityPlan, expectedCompletionAt: pool.expectedCompletionAt, idempotencyKey: randomUUID() };
    await expect(production.create(old.context, old.fresh.orderId, input)).rejects.toMatchObject({ status: 409 });
    for (const id of [old.raw.id, old.successful.productionId]) expect((await capacity.production(old.context, id)).reservations).toEqual([]);
    expect((await production.list(old.context, old.fresh.orderId))).toEqual([]);
    // No old command or production receives a newly minted birth/allocation proof.
    const [count] = await withTenant(database.db, old.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from factory_capacity_owner_proofs`)); expect(count?.count).toBe(0);
  }, 180_000);
});
