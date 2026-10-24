import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SecretVault,harnessChecksum } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, CustomizationSchema, type ProductionEditorDocument, type TenantContext } from "@yummyai/contracts";
import { ArtworkLayoutSchema } from "@yummyai/contracts/catalog/artwork";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import type { OrderDesignRestoreResponse } from "@yummyai/contracts/order/design-agent";
import type { DesignAutomationRecipe, DesignQualityReport } from "@yummyai/contracts/pod/design-automation";
import { createPillowPipeline, PILLOW_CONTOUR_GRAPH_VERSION,DesignAutomationPlanSchema } from "@yummyai/contracts/pod/design-automation";
import {
  aiBudgetLedger, aiBudgetPolicies, connectDatabase, marketplaceAccounts, memberships, membershipRoles,
  migrateDatabase, modelProviderConfigs, modelRoutes, orderDesignAgentRuns as runs, orderDesignAgentSteps as steps, orderDesignAgentOutbox as outbox, orderDesignDispatchTenants,
  orderDesignAgentCommands, orderLines, orders, orderSourceSnapshots, orderWorkAssets, orderWorkItems, orderWorkRevisions,
  productionEditorImages as images, productionEditorProjects as projects, productionEditorRenders as renders,
  productionEditorVersions as versions, productionOrders, roles, withTenant,knowledgeVersions,orderDesignModelCalls as modelCalls,purgeExpiredAmazonOrderReports,
} from "@yummyai/database";
import {
  dispatchOrderDesignOutbox, executionPermissions, OrderDesignProcessor, OrderDesignRepository, OrderDesignSubmissionNotSentError,
  registerOrderDesignRun, type OrderDesignImageGateway, type OrderDesignSnapshot,
  PILLOW_REALESRGAN_POLICY, OrderDesignError, orderPillowPhotoPlan, type OrderDesignSuperResolutionGateway,
  OrderDesignResponseRecovery,recordOrderModelResponse,type OrderDesignResponseReceipt,
} from "@yummyai/order-design";
import { decryptProductionBytes, encryptProductionBytes } from "@yummyai/production-editor";
import { buildDesignAutomationPlan } from "@yummyai/production-editor/design-automation";
import * as pillowGeometry from "@yummyai/production-editor/pillow-automation-geometry";
import { assertAssetAccess, type AssetDomain, type PutPrivateInput, type Storage, type StoredAsset } from "@yummyai/storage";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OrderDesignStudioGateway } from "../../../worker/src/processors/order-design.processor.js";
import type { StudioGateway } from "../../../worker/src/processors/studio-generation.gateway.js";
import { AuditService } from "../audit/audit.service.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";
import { RuleCenterService, resolveOrderRules } from "../rules/rule-center.service.js";
import { MethodGovernanceService } from "../knowledge/method-governance.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { ModelConfigurationService } from "../ai/model-configuration.service.js";
import { ModelConfigController } from "../ai/model-config.controller.js";
import type { ConfigurationSnapshot } from "@yummyai/contracts/ai/model-configuration";

// Immutable fixture history belongs to the disposable database. The acceptance
// runner drops that database in finally; this suite never writes a regular DB.
const databaseName = (() => { try { return new URL(process.env.DATABASE_URL ?? "").pathname; } catch { return ""; } })();
const disposable = /^\/order_daily_(?:e2e|test)_[a-f0-9]{32}$/.test(databaseName);
const checksum = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const jsonChecksum = (value: unknown) => checksum(JSON.stringify(value));
const seal = (key: Uint8Array, value: unknown) => encryptProductionBytes(key, Buffer.from(JSON.stringify(value))).toString("base64");
const open = <T>(key: Uint8Array, value: string): T => JSON.parse(decryptProductionBytes(key, Buffer.from(value, "base64")).toString("utf8")) as T;

describe.skipIf(!disposable)("isolated order design agent execution and recovery", () => {
  let database: ReturnType<typeof connectDatabase>;
  const vault = new SecretVault(Buffer.alloc(32, 93));
  const objects = new Map<string, Uint8Array>();
  const workKeys: Buffer[] = [];
  const storage = {
    discardOrderDesignResponse: async (context: TenantContext, requestId: string, objectKey: string) => {
      assertAssetAccess(context, { id: requestId, tenantId: context.tenantId, assetDomain: "order", objectKey }, "order");
      objects.delete(objectKey);
    },
    putPrivate: async (context: TenantContext, input: PutPrivateInput) => {
      const checksumSha256 = checksum(input.body);
      const objectKey = `tenants/${context.tenantId}/${input.domain}/${checksumSha256}/${input.fileName}`;
      objects.set(objectKey, Uint8Array.from(input.body));
      return { objectKey, checksumSha256, deduplicated: false };
    },
    readPrivate: async (context: TenantContext, asset: StoredAsset, options: { requiredDomain: AssetDomain }) => {
      assertAssetAccess(context, asset, options.requiredDomain);
      const bytes = objects.get(asset.objectKey);
      if (!bytes) throw new Error("Synthetic fixture blob missing");
      return bytes;
    },
  } as unknown as Storage;
  const scanner = { scan: async () => ({ result: "clean" as const, engine: "synthetic", signatureVersion: "fixture-v1", scannedAt: new Date().toISOString() }) };
  const image = () => sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 30, g: 110, b: 190, alpha: 1 } } }).png().toBuffer();
  const preserve: DesignAutomationRecipe = { schemaVersion: 1, workflow: "template", imagePolicy: "preserve", modelRouteId: null,
    allowOrderImageTransfer: false, modelCallLimit: 0, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null };

  beforeAll(async () => { database = connectDatabase(); await migrateDatabase(database); }, 60_000);
  afterAll(async () => { objects.clear(); for (const key of workKeys) key.fill(0); await database?.client.end(); });

  async function methodRow(context:TenantContext,key:string){return (await new MethodGovernanceService(database,new AuditService(database)).workspace(context)).methods.find(row=>row.methodKey===key)!;}
  async function publishMethod(context:TenantContext,key:string,notes="Synthetic reviewed procedure",knowledgeVersionIds:string[]=[]){
    const service=new MethodGovernanceService(database,new AuditService(database)),previous=await methodRow(context,key);
    await service.save(context,{methodKey:key,expectedRevision:previous?.revision??0,notes,knowledgeVersionIds,reason:"Synthetic method review",requestId:randomUUID()});
    for(const action of ["submit","publish"] as const){const current=await methodRow(context,key);await service.transition(context,current.id,action,{expectedRevision:current.revision,version:current.latestVersion,reason:"Synthetic explicit publication",requestId:randomUUID(),...(action==="publish"?{reviewedChecksum:current.latest.checksum}:{})});}
    return methodRow(context,key);
  }
  async function disableMethod(context:TenantContext,key:string){const current=await methodRow(context,key);return new MethodGovernanceService(database,new AuditService(database)).transition(context,current.id,"disable",{expectedRevision:current.revision,version:current.activeVersion!,reason:"Synthetic withdrawal",requestId:randomUUID()});}
  async function redispatch(fixture:Fixture){
    const nextId=createEntityId(),assets=fixture.snapshot.assets.map(asset=>({...asset,key:createEntityId()}));
    const snapshot={...fixture.snapshot,workRevisionId:nextId,assets,plan:buildDesignAutomationPlan({recipe:fixture.snapshot.recipe,imageIds:assets.map(asset=>asset.key)})};
    const runId=await withTenant(database.db,fixture.context,async tx=>{
      const [old]=await tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.id,fixture.snapshot.workRevisionId));
      await tx.insert(orderWorkRevisions).values({...old!,id:nextId,revision:old!.revision+1,createdAt:new Date()});
      await tx.update(orderWorkItems).set({pushedRevisionId:nextId,artwork:"queued"}).where(eq(orderWorkItems.id,fixture.lineId));
      return registerOrderDesignRun(tx,fixture.context,snapshot,fixture.workKey);
    });return {...fixture,snapshot,runId};
  }

  it("keeps an original published order method through a new publication and adopts it only on a new dispatch",async()=>{
    const key="order.design.template",f=await seed({beforeRegister:context=>publishMethod(context,key,"Original reviewed v1").then(()=>{})}),original=(await state(f)).run.methodSnapshot;
    expect(original?.methodSelection).toMatchObject({mode:"published",version:1});
    await publishMethod(f.context,key,"Reviewed v2 notes cannot change manufacturing or customer text");
    const generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>{throw new Error("Preserve must not call a model");});
    await process(worker(generate),f);const first=await state(f);
    expect(first.run).toMatchObject({status:"awaiting_review",methodSnapshot:original});
    const view=await new OrderDesignRepository(database,vault).view(f.context,f.lineId);
    expect(view.run?.completion?.evidence).toMatchObject({inputChecksum:first.run.inputChecksum,methodContractChecksum:original!.executionContract.checksum,requiresBusinessReview:true,automaticProductionApproval:false});
    expect(view.run?.completion?.checksum).toBe(harnessChecksum(view.run!.completion!.evidence));
    const file=view.run!.completion!.evidence.proofs[0]!.files[0]!;
    const keyBytes=vault.withSecret(first.project!.encryptedDataKey!,value=>Buffer.from(value,"base64"));
    try{
      const manifest=open<{files:Array<{objectKey:string}>}>(keyBytes,first.renders[0]!.encryptedManifest!),objectKey=manifest.files[0]!.objectKey,originalBytes=objects.get(objectKey)!;
      expect(checksum(decryptProductionBytes(keyBytes,originalBytes))).toBe(file.checksumSha256);
      const audit=new AuditService(database),reports=new AmazonOrderReportService(database,vault,new OrderService(database,vault,audit),audit,{download:async()=>{throw new Error("No external fixture download");},scan:scanner.scan},{schedule:async()=>undefined},{schedule:async()=>undefined});
      const editor=new ProductionEditorService(database,vault,storage,reports,audit,{enqueue:async()=>undefined},scanner);
      expect(checksum((await editor.renderFile(f.context,first.project!.id,first.renders[0]!.id,file.key)).body)).toBe(file.checksumSha256);
      objects.set(objectKey,encryptProductionBytes(keyBytes,Buffer.from("Synthetic replaced proof bytes")));
      try{await expect(editor.renderFile(f.context,first.project!.id,first.renders[0]!.id,file.key)).rejects.toThrow("待审稿文件与原始制作交接不一致");}finally{objects.set(objectKey,originalBytes);}
    }finally{keyBytes.fill(0);}
    const next=await redispatch(f);expect((await state(next)).run.methodSnapshot?.methodSelection).toMatchObject({mode:"published",version:2});
    await process(worker(generate),next);const nextResult=await state(next);expect({status:nextResult.run.status,error:nextResult.run.errorCode,failedSteps:nextResult.steps.filter(step=>step.status==="failed").map(step=>({key:step.key,error:step.errorCode}))}).toEqual({status:"awaiting_review",error:null,failedSteps:[]});expect((await state(f)).run.methodSnapshot).toEqual(original);expect(generate).not.toHaveBeenCalled();
  });
  it("stops a queued published order method before purchasing and never substitutes a re-enabled generation",async()=>{
    const key="order.design.template",f=await seed({paid:true,beforeRegister:context=>publishMethod(context,key).then(()=>{})}),before=await state(f);
    await disableMethod(f.context,key);await publishMethod(f.context,key,"Explicit re-enable is a new generation");
    const generate=vi.fn<OrderDesignImageGateway["generate"]>();await process(worker(generate),f);
    const final=await state(f);expect(final.run).toMatchObject({status:"needs_attention",errorCode:"agent_method_unavailable",inputChecksum:before.run.inputChecksum,methodSnapshot:before.run.methodSnapshot});expect(final.ledger).toHaveLength(0);expect(generate).not.toHaveBeenCalled();
  });
  it("preserves a received original response and reported fee when its published method is withdrawn in flight",async()=>{
    const key="order.design.template",f=await seed({paid:true,beforeRegister:context=>publishMethod(context,key).then(()=>{})}),bytes=await image();
    const generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>{await disableMethod(f.context,key);return {bytes,actualCostUsd:0.04};});await process(worker(generate),f);
    const final=await state(f),paid=final.steps.find(step=>step.key.startsWith("enhance"))!;
    expect(final.run).toMatchObject({status:"needs_attention",errorCode:"agent_method_unavailable",costStatus:"reported",actualCostUsd:"0.04000000"});
    const checkpoint=open<{responseCheckpoint:{checksum:string}}>(f.workKey,paid.encryptedOutput!);expect(checkpoint.responseCheckpoint.checksum).toBe(checksum(bytes));expect(paid.outputAssetId).toBeNull();expect(final.ledger[0]).toMatchObject({state:"committed",amountUsd:"0.040000"});expect(generate).toHaveBeenCalledOnce();
  });
  it("rechecks current method-read permission and safely resumes an unsubmitted original plan after access is restored",async()=>{
    const key="order.design.template",f=await seed({beforeRegister:context=>publishMethod(context,key).then(()=>{})}),original=(await state(f)).run;
    await withTenant(database.db,f.context,tx=>tx.update(roles).set({permissions:f.context.permissions.filter(permission=>permission!==Permission.WorkflowRead)}).where(eq(roles.id,f.roleId)));
    const generate=vi.fn<OrderDesignImageGateway["generate"]>();await process(worker(generate),f);expect((await state(f)).run.errorCode).toBe("agent_method_unavailable");
    await expect(new OrderDesignRepository(database,vault).view({...f.context,permissions:f.context.permissions.filter(permission=>permission!==Permission.WorkflowRead)},f.lineId)).rejects.toThrow();
    await withTenant(database.db,f.context,tx=>tx.update(roles).set({permissions:[...f.context.permissions]}).where(eq(roles.id,f.roleId)));
    await command(f,"resume");await process(worker(generate),f);const final=await state(f);expect(final.run).toMatchObject({status:"awaiting_review",inputChecksum:original.inputChecksum,methodSnapshot:original.methodSnapshot});expect(generate).not.toHaveBeenCalled();
  });
  it("retains genuine legacy method absence and protects native input and completion history from replacement",async()=>{
    const generate=vi.fn<OrderDesignImageGateway["generate"]>(),old=await seed({legacy:true});await process(worker(generate),old);
    expect((await new OrderDesignRepository(database,vault).view(old.context,old.lineId)).run).toMatchObject({status:"awaiting_review",methodSnapshot:null,completion:null});
    const blocked=await seed({legacy:true});await publishMethod(blocked.context,"order.design.template");await process(worker(generate),blocked);expect((await state(blocked)).run).toMatchObject({methodSnapshot:null,errorCode:"agent_method_unavailable"});
    const f=await seed();await process(worker(generate),f);const row=await state(f);
    for(const patch of [{methodSnapshot:null},{encryptedSnapshot:"synthetic replacement"},{completionEvidence:null,completionChecksum:null}])await expect(withTenant(database.db,f.context,tx=>tx.update(runs).set(patch).where(eq(runs.id,f.runId)))).rejects.toThrow();
    await expect(withTenant(database.db,f.context,tx=>tx.update(steps).set({inputChecksum:"0".repeat(64)}).where(eq(steps.id,row.steps[0]!.id)))).rejects.toThrow();expect(generate).not.toHaveBeenCalled();
    await expect(withTenant(database.db,f.context,tx=>tx.update(steps).set({encryptedOutput:"synthetic replacement"}).where(eq(steps.id,row.steps[0]!.id)))).rejects.toThrow();
    await expect(withTenant(database.db,f.context,tx=>tx.update(renders).set({encryptedManifest:"synthetic replacement"}).where(eq(renders.id,row.renders[0]!.id)))).rejects.toThrow();
  });
  it("uses the existing knowledge owner and excludes a withdrawn method source before order execution",async()=>{
    let sourceId="";
    const f=await seed({paid:true,beforeRegister:async context=>{
      const knowledge=new KnowledgeService(database,new AuditService(database));
      const source=await knowledge.save(context,null,{fields:{title:"Synthetic order guidance",summary:"Reviewed procedure",body:"Keep the pinned customer requirements and manufacturing parameters.",topic:"operations",platform:"all",market:"ALL",spuId:null,sourceType:"team",sourceLabel:"Synthetic team",sourceUrl:"",owner:"Synthetic reviewer",verifiedOn:"2026-01-01",reviewDueOn:"2099-12-31",tags:[]},expectedRevision:0,reason:"Synthetic source",requestId:randomUUID()});sourceId=source.id;
      for(const action of ["submit","publish"] as const){const row=(await knowledge.workspace(context)).entries.find(entry=>entry.id===source.id)!;await knowledge.change(context,source.id,action,{expectedRevision:row.revision,version:row.latestVersion,reason:"Synthetic reviewed source",requestId:randomUUID()});}
      const [version]=await withTenant(database.db,context,tx=>tx.select().from(knowledgeVersions).where(eq(knowledgeVersions.entryId,source.id)));
      await publishMethod(context,"order.design.template","Procedure provenance only",[version!.id]);
    }});
    const knowledge=new KnowledgeService(database,new AuditService(database)),source=(await knowledge.workspace(f.context)).entries.find(entry=>entry.id===sourceId)!;
    await knowledge.change(f.context,sourceId,"archive",{expectedRevision:source.revision,version:source.latestVersion,reason:"Synthetic withdrawn source",requestId:randomUUID()});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>();await process(worker(generate),f);expect((await state(f)).run).toMatchObject({status:"needs_attention",errorCode:"agent_method_unavailable"});expect(generate).not.toHaveBeenCalled();
  });
  it("retains a received response and reported fee after member revocation and reuses it when membership is restored",async()=>{
    const f=await seed({paid:true}),bytes=await image();
    const generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>{await withTenant(database.db,f.context,tx=>tx.update(memberships).set({status:"disabled"}).where(eq(memberships.id,f.membershipId)));return {bytes,actualCostUsd:0.04};});
    await process(worker(generate),f);const blocked=await state(f),paid=blocked.steps.find(step=>step.key==="enhance_image_1")!;
    expect(blocked.run).toMatchObject({status:"needs_attention",errorCode:"agent_membership_unavailable",costStatus:"reported",actualCostUsd:"0.04000000"});
    expect(open<{responseCheckpoint:{checksum:string}}>(f.workKey,paid.encryptedOutput!).responseCheckpoint.checksum).toBe(checksum(bytes));expect(paid.outputAssetId).toBeNull();
    await withTenant(database.db,f.context,tx=>tx.update(memberships).set({status:"active"}).where(eq(memberships.id,f.membershipId)));
    await command(f,"resume");const forbidden=vi.fn<OrderDesignImageGateway["generate"]>();await process(worker(forbidden),f);
    const final=await state(f);expect(final.run).toMatchObject({status:"awaiting_review",inputChecksum:blocked.run.inputChecksum,actualCostUsd:"0.04000000"});expect(final.ledger).toHaveLength(1);expect(generate).toHaveBeenCalledOnce();expect(forbidden).not.toHaveBeenCalled();
  });

  it.each([undefined,0,0.04000001,1e-8])("retains minimal original fees after real private-key erasure without storing or adopting the late image (cost %s)",async actualCostUsd=>{
    const f=await seed({paid:true}),bytes=await image(),rawChecksum=checksum(bytes);
    const generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>{
      await withTenant(database.db,f.context,tx=>tx.update(orderWorkItems).set({expiresAt:new Date(0)}).where(eq(orderWorkItems.id,f.lineId)));
      await purgeExpiredAmazonOrderReports(database,f.context);
      return {bytes,actualCostUsd};
    });
    await process(worker(generate),f);const result=await state(f),paid=result.steps.find(step=>step.key==="enhance_image_1")!;
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_source_expired",costStatus:actualCostUsd===undefined?"unknown":"reported",actualCostUsd:actualCostUsd===undefined?null:actualCostUsd.toFixed(8)});
    expect(result.work.encryptedDataKey).toBeNull();expect(result.project).toMatchObject({status:"expired",encryptedDataKey:null});expect(paid.outputAssetId).toBeNull();expect(result.renders).toHaveLength(0);
    const [call]=await withTenant(database.db,f.context,tx=>tx.select().from(modelCalls).where(eq(modelCalls.runId,f.runId)));
    expect(call).toMatchObject({requestId:paid.requestId,attempt:1,costReportState:actualCostUsd===undefined?"unknown":"reported",reportedCostUsd:actualCostUsd===undefined?null:actualCostUsd.toFixed(8)});expect(call!.receivedAt).toBeInstanceOf(Date);
    expect(result.ledger[0]).toMatchObject({state:actualCostUsd===undefined?"reserved":"committed",amountUsd:actualCostUsd===undefined?"0.100000":actualCostUsd===0?"0.000000":actualCostUsd===1e-8?"0.000001":"0.040001"});
    expect([...objects.keys()].some(key=>key.endsWith(`${paid.requestId}-response-quarantine.pe`))).toBe(false);expect(bytes.every(value=>value===0)).toBe(true);expect(rawChecksum).not.toBe(checksum(bytes));
    const view=(await new OrderDesignRepository(database,vault).view(f.context,f.lineId)).run!;
    expect(view).toMatchObject({privateEvidenceState:"expired",methodSnapshot:null,completion:null,canResume:false,canTakeOver:false});expect(view.modelCalls).toHaveLength(1);
    expect(JSON.stringify(view.modelCalls)).not.toMatch(/claimToken|encrypted|objectKey|prompt|checksum|Synthetic buyer/);
    await expect(command(f,"resume")).rejects.toMatchObject({code:"agent_source_expired"});await process(worker(generate),f);expect(generate).toHaveBeenCalledOnce();
  });
  it("uses database time for model configuration even when the application clock is ahead of template authority",async()=>{
    const f=await seed(),context={...f.context,permissions:Object.values(Permission)},configuration=new ModelConfigurationService(database,vault);
    const [before]=await database.client.unsafe<{ms:string}[]>("select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms");
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.now()+86_400_000);
    try{
      let snapshot=await configuration.invoke(context,{operation:"channel.save",name:`Synthetic clock ${f.lineId}`,baseUrl:"https://synthetic.invalid/v1",apiKey:"synthetic-clock-key",models:[{name:"synthetic-clock-model",capability:"image"}]}) as ConfigurationSnapshot;
      const channel=snapshot.channels.find(item=>item.name===`Synthetic clock ${f.lineId}`)!;
      snapshot=await configuration.invoke(context,{operation:"channel.save",id:channel.id,revision:channel.revision,name:channel.name,baseUrl:channel.baseUrl,models:channel.models}) as ConfigurationSnapshot;
      await new ModelConfigController(database,vault).update({headers:{},tenantContext:context},channel.id,{label:channel.name});
      const [provider]=await withTenant(database.db,context,tx=>tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id,channel.id))),[route]=await withTenant(database.db,context,tx=>tx.select().from(modelRoutes).where(eq(modelRoutes.id,channel.models[0]!.id)));
      const [after]=await database.client.unsafe<{ms:string}[]>("select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms");
      for(const stamp of [provider!.updatedAt,route!.updatedAt]){expect(stamp.getTime()).toBeGreaterThanOrEqual(Number(before!.ms));expect(stamp.getTime()).toBeLessThanOrEqual(Number(after!.ms));}
      expect(snapshot.channels.find(item=>item.id===channel.id)!.revision).not.toBe(channel.revision);
    }finally{vi.useRealTimers();}
  });
  it("reads financial evidence without decrypting private snapshots or requiring method-library access, while preserving order permissions and tenant isolation",async()=>{
    const f=await seed({paid:true,beforeRegister:context=>publishMethod(context,"order.design.template").then(()=>{})});
    await process(worker(vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({bytes:await image(),actualCostUsd:0.04})),f);
    const unreadableVault=new SecretVault(Buffer.alloc(32,94)),decrypt=vi.spyOn(unreadableVault,"withSecret").mockImplementation(()=>{throw new Error("Financial reads must not decrypt private order data");});
    const repository=new OrderDesignRepository(database,unreadableVault),reader={...f.context,permissions:f.context.permissions.filter(permission=>permission!==Permission.WorkflowRead)};
    const view=(await repository.view(reader,f.lineId,{includePrivate:false})).run!;
    expect(view).toMatchObject({status:"awaiting_review",privateEvidenceState:"available",privateEvidenceOmitted:true,actualCostUsd:0.04,costStatus:"reported",methodSnapshot:null,completion:null,ruleSnapshot:null,responseRecoveryTarget:null,qualityDiagnostics:[],steps:[],canResume:false,canTakeOver:false});
    expect(view.modelCalls).toHaveLength(1);expect(view.modelCalls![0]).toMatchObject({reportedCostUsd:"0.04000000",budgetState:"committed",budgetAmountUsd:"0.040000"});expect(decrypt).not.toHaveBeenCalled();
    await expect(repository.view(reader,f.lineId)).rejects.toThrow();
    await expect(repository.view(f.context,f.lineId)).rejects.toThrow("Financial reads must not decrypt private order data");
    for(const permission of [Permission.OrderRead,Permission.OrderPiiRead])await expect(repository.view({...reader,permissions:reader.permissions.filter(value=>value!==permission)},f.lineId,{includePrivate:false})).rejects.toThrow();
    const other=await seed();await expect(repository.view(other.context,f.lineId,{includePrivate:false})).rejects.toMatchObject({code:"agent_work_not_found"});
    expect(JSON.stringify(view)).not.toMatch(/encrypted|objectKey|claimToken|Synthetic buyer/);
  });
  it.each(["expired","anonymized"] as const)("withholds private history before key purging when the current order is %s and retains exact original fees",async condition=>{
    const f=await seed({paid:true});await process(worker(vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({bytes:await image(),actualCostUsd:1e-8})),f);
    await withTenant(database.db,f.context,async tx=>{if(condition==="expired")await tx.update(orderWorkItems).set({expiresAt:new Date(0)}).where(eq(orderWorkItems.id,f.lineId));else await tx.update(orders).set({addressStatus:"anonymized"}).where(eq(orders.id,f.orderId));});
    expect((await state(f)).work.encryptedDataKey).not.toBeNull();
    const view=(await new OrderDesignRepository(database,vault).view(f.context,f.lineId)).run!;
    expect(view).toMatchObject({privateEvidenceState:"expired",privateEvidenceOmitted:true,actualCostUsd:1e-8,methodSnapshot:null,completion:null,ruleSnapshot:null,responseRecoveryTarget:null,qualityDiagnostics:[],steps:[],canResume:false,canTakeOver:false});
    expect(view.modelCalls![0]).toMatchObject({reportedCostUsd:"0.00000001",budgetAmountUsd:"0.000001"});
  });
  it("captures a received original fee after takeover without reviving the task or adopting late artwork",async()=>{
    const f=await seed({paid:true}),bytes=await image();
    const generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>{await command(f,"takeover");return {bytes,actualCostUsd:0.04};});
    await process(worker(generate),f);const result=await state(f);
    expect(result.run).toMatchObject({status:"cancelled",costStatus:"reported",actualCostUsd:"0.04000000",processingToken:null});expect(result.ledger[0]).toMatchObject({state:"committed",amountUsd:"0.040000"});
    expect(result.steps.find(step=>step.key==="enhance_image_1")!.outputAssetId).toBeNull();expect(result.renders).toHaveLength(0);expect(bytes.every(value=>value===0)).toBe(true);expect(generate).toHaveBeenCalledOnce();
  });
  it("keeps incurred known fees separate from unsubmitted future plan steps",async()=>{
    const key="order.design.pillow_photo",f=await seed({paid:true,pillow:true,beforeRegister:context=>publishMethod(context,key).then(()=>{})});
    expect(f.snapshot.plan.plannedModelCalls).toBe(2);
    const generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>{await disableMethod(f.context,key);return {bytes:await image(),actualCostUsd:0.04};});
    await process(worker(generate),f);const result=await state(f);
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_method_unavailable",costStatus:"reported",actualCostUsd:"0.04000000"});expect(result.ledger).toHaveLength(1);expect(generate).toHaveBeenCalledOnce();
  });
  it("retains an actual over-budget fee and stops the next paid step against the original order cap",async()=>{
    const f=await seed({paid:true,pillow:true}),generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>({bytes:await image(),actualCostUsd:0.5}));
    await process(worker(generate),f);const result=await state(f);
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_model_original_budget_exceeded",costStatus:"reported",actualCostUsd:"0.50000000"});expect(result.ledger).toHaveLength(1);expect(result.ledger[0]).toMatchObject({state:"committed",amountUsd:"0.500000"});expect(generate).toHaveBeenCalledOnce();
    expect((await new OrderDesignRepository(database,vault).view(f.context,f.lineId)).run!.canResume).toBe(false);await expect(command(f,"resume")).rejects.toMatchObject({code:"agent_resume_not_safe"});
  });
  it("keeps submitted cost uncertainty after private-key erasure when no provider response arrives",async()=>{
    const f=await seed({paid:true});const generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>{
      await withTenant(database.db,f.context,tx=>tx.update(orderWorkItems).set({expiresAt:new Date(0)}).where(eq(orderWorkItems.id,f.lineId)));await purgeExpiredAmazonOrderReports(database,f.context);throw new Error("Synthetic unavailable provider response");
    });await process(worker(generate),f);const result=await state(f);
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_model_submission_unknown",costStatus:"unknown",actualCostUsd:null});expect(result.ledger[0]).toMatchObject({state:"reserved",amountUsd:"0.100000"});
    expect((await withTenant(database.db,f.context,tx=>tx.select().from(modelCalls).where(eq(modelCalls.runId,f.runId))))[0]).toMatchObject({costReportState:"pending",receivedAt:null,reportedCostUsd:null});expect(generate).toHaveBeenCalledOnce();
  });
  it("idempotently retains an original fee and rejects conflicting, forged or cross-tenant financial evidence",async()=>{
    const f=await seed({paid:true});await process(worker(async()=>({bytes:await image(),actualCostUsd:0.04})),f);const before=await state(f),paid=before.steps.find(step=>step.key==="enhance_image_1")!;
    const [call]=await withTenant(database.db,f.context,tx=>tx.select().from(modelCalls).where(eq(modelCalls.runId,f.runId)));
    const receipt=open<{responseReceipt:OrderDesignResponseReceipt}>(f.workKey,paid.encryptedOutput!).responseReceipt;
    await recordOrderModelResponse(database,f.context,before.run,paid,call!.claimToken,receipt);
    expect(await withTenant(database.db,f.context,tx=>tx.select().from(modelCalls).where(eq(modelCalls.id,call!.id)))).toEqual([call]);
    await expect(recordOrderModelResponse(database,f.context,before.run,paid,call!.claimToken,{...receipt,actualCostUsd:0.05})).rejects.toMatchObject({code:"agent_model_cost_conflict"});
    await expect(recordOrderModelResponse(database,f.context,before.run,paid,randomUUID(),receipt)).rejects.toMatchObject({code:"agent_model_call_identity_invalid"});
    for(const patch of [{reportedCostUsd:"0.05"},{claimToken:randomUUID()},{receivedAt:new Date(0)}])await expect(withTenant(database.db,f.context,tx=>tx.update(modelCalls).set(patch).where(eq(modelCalls.id,call!.id)))).rejects.toThrow();
    const other=await seed();expect(await withTenant(database.db,other.context,tx=>tx.select().from(modelCalls).where(eq(modelCalls.id,call!.id)))).toEqual([]);
    const final=await state(f);expect(final.ledger).toEqual(before.ledger);expect(final.run.actualCostUsd).toBe("0.04000000");
  });
  it("settles an original released reservation only through its immutable late receipt and preserves the original budget time",async()=>{
    const f=await seed({paid:true});let reserved:Awaited<ReturnType<typeof state>>["ledger"][number]|undefined;
    await process(worker(async()=>{
      reserved=(await state(f)).ledger[0]!;await withTenant(database.db,f.context,tx=>tx.update(aiBudgetLedger).set({state:"released"}).where(eq(aiBudgetLedger.id,reserved!.id)));
      await expect(withTenant(database.db,f.context,tx=>tx.update(aiBudgetLedger).set({state:"committed",amountUsd:"0.04"}).where(eq(aiBudgetLedger.id,reserved!.id)))).rejects.toThrow();
      return {bytes:await image(),actualCostUsd:0.04};
    }),f);
    const final=await state(f);expect(final.run).toMatchObject({status:"awaiting_review",actualCostUsd:"0.04000000"});expect(final.ledger[0]).toMatchObject({id:reserved!.id,state:"committed",amountUsd:"0.040000",createdAt:reserved!.createdAt});
    await expect(withTenant(database.db,f.context,tx=>tx.update(aiBudgetLedger).set({amountUsd:"0.05"}).where(eq(aiBudgetLedger.id,reserved!.id)))).rejects.toThrow();
  });
  it.each([NaN,-1,1e-9])("retains invalid fee evidence without zeroing, settling or repeating the original model request (cost %s)",async actualCostUsd=>{
    const f=await seed({paid:true}),bytes=await image(),generate=vi.fn<OrderDesignImageGateway["generate"]>(async()=>({bytes,actualCostUsd}));
    await process(worker(generate),f);const final=await state(f);
    expect(final.run).toMatchObject({status:"needs_attention",errorCode:"agent_model_cost_report_invalid",costStatus:"unknown",actualCostUsd:null});expect(final.ledger[0]).toMatchObject({state:"reserved",amountUsd:"0.100000"});
    expect((await withTenant(database.db,f.context,tx=>tx.select().from(modelCalls).where(eq(modelCalls.runId,f.runId))))[0]).toMatchObject({costReportState:"invalid",reportedCostUsd:null});
    expect((await new OrderDesignRepository(database,vault).view(f.context,f.lineId)).run!.canResume).toBe(false);expect(bytes.every(value=>value===0)).toBe(true);await process(worker(generate),f);expect(generate).toHaveBeenCalledOnce();
  });

  it("executes a preserve recipe once under concurrent deliveries and creates a real unapproved PNG proof", async () => {
    const fixture = await seed();
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => { throw new Error("Preserve must not invoke a model"); });
    const processor = worker(generate);
    await Promise.all([process(processor, fixture), process(processor, fixture)]);
    const before = await state(fixture);
    expect({status:before.run.status,error:before.run.errorCode,failedSteps:before.steps.filter(step=>step.status==="failed").map(step=>step.errorCode)}).toEqual({status:"awaiting_review",error:null,failedSteps:[]});
    expect(before.steps.every(step => step.status === "completed")).toBe(true);
    expect(before.project).toMatchObject({ reviewedVersionId: null, reviewedBy: null, sourceWorkItemId: fixture.lineId });
    expect(before.work).toMatchObject({ artwork: "in_progress", approvedEditorVersionId: null, proofEditorVersionId: null });
    expect(before.document?.confirmations.visualReview).toBe(false);
    expect(before.document?.layers.find(layer => layer.id === "custom_name")).toMatchObject({ text: "  Mira  " });
    const quality = qualityReport(before, fixture);
    expect(quality.checks).toContainEqual(expect.objectContaining({ code: "text_exact", fieldId: "name", status: "passed" }));
    expect(quality.automaticProductionApproval).toBe(false);
    expect(before.renders).toHaveLength(1);
    const proof = before.renders[0]!;
    const projectKey = vault.withSecret(before.project!.encryptedDataKey!, value => Buffer.from(value, "base64"));
    try {
      expect(open<{ purpose: string }>(projectKey, proof.encryptedOptions).purpose).toBe("preview");
      const manifest = open<{ files: Array<{ objectKey: string }>; preflight: { productionReady: boolean } }>(projectKey, proof.encryptedManifest!);
      expect(manifest.preflight.productionReady).toBe(false);
      const bytes = decryptProductionBytes(projectKey, objects.get(manifest.files[0]!.objectKey)!);
      expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 236, height: 236 });
    } finally { projectKey.fill(0); }
    await process(processor, fixture);
    const after = await state(fixture);
    expect(after.versions.map(version => version.id)).toEqual(before.versions.map(version => version.id));
    expect(after.renders.map(render => render.id)).toEqual(before.renders.map(render => render.id));
    expect(after.ledger).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  }, 30_000);

  it("checkpoints the first paid image and cannot resend the second image after an unknown provider result", async () => {
    const fixture = await seed({ paid: true, imageCount: 2 });
    const generate = vi.fn<OrderDesignImageGateway["generate"]>();
    generate.mockResolvedValueOnce({ bytes: await image(), actualCostUsd: 0.1 });
    generate.mockRejectedValueOnce(new Error("Synthetic transport outcome unknown"));
    const processor = worker(generate);
    await process(processor, fixture);
    const before = await state(fixture);
    const first = before.steps.find(step => step.key === "enhance_image_1")!;
    const second = before.steps.find(step => step.key === "enhance_image_2")!;
    expect(first).toMatchObject({ status: "completed", attempt: 1 });
    expect(first.outputAssetId).not.toBeNull();
    expect(before.assets.some(asset => asset.id === first.outputAssetId)).toBe(true);
    expect(second).toMatchObject({ status: "uncertain", attempt: 1, outputAssetId: null });
    expect(before.run).toMatchObject({ status: "needs_attention", costStatus: "unknown", actualCostUsd: null });
    expect(before.ledger).toHaveLength(2);
    expect(before.ledger.find(row => row.requestId === first.requestId)?.state).toBe("committed");
    expect(before.ledger.find(row => row.requestId === second.requestId)?.state).toBe("reserved");
    await expect(command(fixture, "resume")).rejects.toMatchObject({ code: "agent_resume_not_safe" });
    await Promise.all([process(processor, fixture), process(processor, fixture)]);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(new Set(generate.mock.calls.map(([input]) => input.requestId)).size).toBe(2);
    expect((await state(fixture)).versions.map(version => version.id)).toEqual(before.versions.map(version => version.id));
  }, 30_000);

  it("restores an uncertain pillow result once, retains enhancement and unknown billing, and completes a real full-size JPG awaiting review", async () => {
    const fixture = await seed({ pillow: true, paid: true, pipeline: true, contourGraph: true, cropScope: "Half Body" });
    const generate = vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({ bytes: await image(), actualCostUsd: 0.1 })
      .mockRejectedValueOnce(new Error("Synthetic result lost after provider submission"));
    const upscale = vi.fn<OrderDesignSuperResolutionGateway["upscale"]>(async ({ bytes }) => ({
      bytes: await sharp(bytes).resize(2048, 2048).png().toBuffer(), evidence: { engine: "synthetic-integration" },
    }));
    const processor = worker(generate, { validatePolicy: async () => {}, upscale });
    await process(processor, fixture);
    const paused = await state(fixture), repository = new OrderDesignRepository(database, vault);
    const target = (await repository.view(fixture.context, fixture.lineId)).run!.responseRecoveryTarget!;
    expect(target).toMatchObject({ model: "gpt-image-2.5", stepLabel: "主体抠图", sourceAssetId: paused.steps.find(step => step.key === "enhance_image_1")!.outputAssetId });
    const bytes = await pillowImage(512), input = await restoreInput(fixture, bytes);
    const recovery = new OrderDesignResponseRecovery(database, vault, storage);
    await Promise.all([recovery.restore(fixture.context, fixture.lineId, input), recovery.restore(fixture.context, fixture.lineId, input)]);
    expect((await state(fixture)).run.revision).toBe(input.expectedRevision + 1);
    expect(await withTenant(database.db, fixture.context, tx => tx.select().from(orderDesignAgentCommands).where(eq(orderDesignAgentCommands.runId, fixture.runId)))).toHaveLength(1);
    await Promise.all([process(processor, fixture), process(processor, fixture)]);
    const complete = await state(fixture);
    expect(complete.run).toMatchObject({ status: "awaiting_review", errorCode: null, costStatus: "unknown", actualCostUsd: null, encryptedSnapshot: paused.run.encryptedSnapshot });
    expect(complete.steps.every(step => step.status === "completed")).toBe(true);
    for (const step of paused.steps.filter(step => step.status === "completed")) expect(complete.steps.find(row => row.id === step.id)).toEqual(step);
    expect(generate).toHaveBeenCalledTimes(2); expect(upscale).toHaveBeenCalledTimes(1);
    const restored = complete.steps.find(step => step.key === "cutout_subject")!;
    expect(restored.requestId).toBe(input.requestId);
    expect(complete.ledger).toHaveLength(2);
    expect(complete.ledger.find(row => row.requestId === input.requestId)).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
    expect(complete.project?.reviewedVersionId).toBeNull(); expect(complete.work.approvedEditorVersionId).toBeNull();
    expect(await withTenant(database.db, fixture.context, tx => tx.select().from(productionOrders).where(eq(productionOrders.sourceWorkItemId, fixture.lineId)))).toHaveLength(0);
    expect(complete.document?.confirmations.visualReview).toBe(false);
    const projectKey = vault.withSecret(complete.project!.encryptedDataKey!, value => Buffer.from(value, "base64"));
    try {
      const asset = complete.assets.find(asset => asset.id === restored.outputAssetId)!;
      expect(decryptProductionBytes(projectKey, objects.get(asset.originalObjectKey)!)).toEqual(bytes);
      expect(open<Record<string, unknown>>(projectKey, asset.encryptedMetadata)).toMatchObject({ operatorRecovery: {
        kind: "operator_verified_provider_result", providerReference: input.providerReference, checksum: checksum(bytes), verifiedBy: fixture.context.userId,
      } });
      const manifest = open<{ files: Array<{ objectKey: string; name: string }>; preflight: { productionReady: boolean } }>(projectKey, complete.renders[0]!.encryptedManifest!);
      expect(manifest.files[0]!.name).toMatch(/\.jpg$/); expect(manifest.preflight.productionReady).toBe(false);
      const proof = decryptProductionBytes(projectKey, objects.get(manifest.files[0]!.objectKey)!);
      const metadata = await sharp(proof).metadata();
      expect(metadata).toMatchObject({ format: "jpeg", density: 150, channels: 3, hasAlpha: false });
      expect(metadata.width).toBeGreaterThan(3000); expect(metadata.height).toBeGreaterThan(1500); expect(metadata.icc?.length).toBeGreaterThan(0);
    } finally { projectKey.fill(0); }
    const view = await repository.view(fixture.context, fixture.lineId);
    expect(view.run!.responseRecoveryTarget).toBeNull();
    expect(view.run!.steps.find(step => step.id === restored.id)!.responseRecovery).toMatchObject({ providerReference: input.providerReference });
    expect(JSON.stringify(view)).not.toContain("response-quarantine.pe"); expect(JSON.stringify(view)).not.toContain(input.contentBase64);
    await recovery.restore(fixture.context, fixture.lineId, input);
    await expect(recovery.restore(fixture.context, fixture.lineId, { ...input, verificationNote: "Different operator evidence for the same request" })).rejects.toMatchObject({ code: "agent_command_conflict" });
    expect(generate).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("restores only the exact known response when its private checkpoint write failed, preserving the reported cost", async () => {
    const fixture = await seed({ paid: true }), bytes = await image();
    const generate = vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({ bytes, actualCostUsd: 0.14 });
    const failingStorage = { ...storage, putPrivate: async (context: TenantContext, input: PutPrivateInput) => {
      if (input.fileName.endsWith("-response-quarantine.pe")) throw new Error("Synthetic storage outage");
      return storage.putPrivate(context, input);
    } } as Storage;
    await process(new OrderDesignProcessor(database, failingStorage, vault, { generate }, scanner), fixture);
    const input = await restoreInput(fixture, bytes), recovery = new OrderDesignResponseRecovery(database, vault, storage);
    const different = await pillowImage(512);
    await expect(recovery.restore(fixture.context, fixture.lineId, { ...input, contentBase64: different.toString("base64") }))
      .rejects.toMatchObject({ code: "agent_response_checksum_mismatch" });
    await recovery.restore(fixture.context, fixture.lineId, input);
    await process(worker(generate), fixture);
    const result = await state(fixture);
    expect(result.run).toMatchObject({ status: "awaiting_review", costStatus: "reported", actualCostUsd: "0.14000000" });
    expect(result.ledger).toHaveLength(1); expect(result.ledger[0]).toMatchObject({ state: "committed", amountUsd: "0.140000" });
    expect(generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("blocks forged request identities, non-image bytes, cross-tenant and revoked recovery before creating a private checkpoint", async () => {
    const fixture = await seed({ paid: true });
    await process(worker(async () => { throw new Error("Synthetic unknown provider result"); }), fixture);
    const input = await restoreInput(fixture, await image()), recovery = new OrderDesignResponseRecovery(database, vault, storage), count = objects.size;
    await expect(recovery.restore(fixture.context, fixture.lineId, { ...input, requestId: createEntityId() })).rejects.toMatchObject({ code: "agent_response_identity_mismatch" });
    await expect(recovery.restore(fixture.context, fixture.lineId, { ...input, stepId: createEntityId() })).rejects.toMatchObject({ code: "agent_response_identity_mismatch" });
    await expect(recovery.restore(fixture.context, fixture.lineId, { ...input, contentBase64: Buffer.from("Synthetic non-image").toString("base64") })).rejects.toMatchObject({ code: "agent_asset_invalid" });
    await expect(recovery.restore({ ...fixture.context, tenantId: createEntityId() }, fixture.lineId, input)).rejects.toMatchObject({ code: "agent_run_not_found" });
    await withTenant(database.db, fixture.context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, fixture.membershipId)));
    expect((await new OrderDesignRepository(database, vault).view(fixture.context, fixture.lineId)).run).toMatchObject({ responseRecoveryTarget: null, responseRecoveryBlockedCode: "agent_membership_unavailable" });
    await expect(recovery.restore(fixture.context, fixture.lineId, input)).rejects.toMatchObject({ code: "agent_membership_unavailable" });
    expect(objects.size).toBe(count); expect((await state(fixture)).run.status).toBe("needs_attention");
  }, 30_000);

  it.each(["held", "expired", "cancelled", "editor_changed"] as const)("refuses recovery for %s without rewriting a source or production version", async condition => {
    const fixture = await seed({ paid: true });
    await process(worker(async () => { throw new Error("Synthetic unknown provider result"); }), fixture);
    const input = await restoreInput(fixture, await image()), before = await state(fixture), count = objects.size;
    await withTenant(database.db, fixture.context, async tx => {
      if (condition === "held") await tx.update(orderWorkItems).set({ held: true }).where(eq(orderWorkItems.id, fixture.lineId));
      if (condition === "expired") await tx.update(orderWorkItems).set({ expiresAt: new Date(0) }).where(eq(orderWorkItems.id, fixture.lineId));
      if (condition === "cancelled") await tx.update(orders).set({ sideState: "cancelled" }).where(eq(orders.id, fixture.orderId));
      if (condition === "editor_changed") await tx.update(projects).set({ currentVersionId: null }).where(eq(projects.id, before.project!.id));
    });
    await expect(new OrderDesignResponseRecovery(database, vault, storage).restore(fixture.context, fixture.lineId, input)).rejects.toMatchObject({
      code: condition === "expired" ? "agent_source_expired" : condition === "editor_changed" ? "agent_editor_changed" : "agent_order_unavailable",
    });
    expect((await state(fixture)).versions).toEqual(before.versions); expect(objects.size).toBe(count);
    expect((await new OrderDesignRepository(database, vault).view(fixture.context, fixture.lineId)).run?.responseRecoveryTarget).toBeNull();
  }, 30_000);

  it("cleans an uncommitted response when takeover wins during upload and leaves the paid reservation unknown", async () => {
    const fixture = await seed({ paid: true });
    await process(worker(async () => { throw new Error("Synthetic unknown provider result"); }), fixture);
    const input = await restoreInput(fixture, await image()), count = objects.size;
    const racedStorage = { ...storage, putPrivate: async (context: TenantContext, body: PutPrivateInput) => {
      const result = await storage.putPrivate(context, body);
      await command(fixture, "takeover");
      return result;
    } } as Storage;
    await expect(new OrderDesignResponseRecovery(database, vault, racedStorage).restore(fixture.context, fixture.lineId, input)).rejects.toMatchObject({ code: "agent_revision_changed" });
    expect(objects.size).toBe(count);
    const result = await state(fixture);
    expect(result.run).toMatchObject({ status: "cancelled", costStatus: "unknown", actualCostUsd: null });
    expect(result.ledger[0]!.state).toBe("reserved");
    expect(result.steps.some(step => step.outputAssetId && step.key === "enhance_image_1")).toBe(false);
  }, 30_000);

  it("preserves the live checkpoint after a lost commit acknowledgement and an explicit replay", async () => {
    const fixture = await seed({ paid: true });
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => { throw new Error("Synthetic unknown provider result"); });
    await process(worker(generate), fixture);
    const input = await restoreInput(fixture, await image());
    let acknowledgements = 0;
    const connection = { ...database, db: new Proxy(database.db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof target.transaction>) => {
          const result = await target.transaction(...args);
          if (++acknowledgements === 2) throw new Error("Synthetic lost commit acknowledgement");
          return result;
        };
      },
    }) };
    await expect(new OrderDesignResponseRecovery(connection, vault, storage).restore(fixture.context, fixture.lineId, input))
      .rejects.toThrow("Synthetic lost commit acknowledgement");
    const restored = await state(fixture), step = restored.steps.find(step => step.id === input.stepId)!;
    const checkpoint = open<{ responseCheckpoint: { objectKey: string } }>(fixture.workKey, step.encryptedOutput!).responseCheckpoint;
    expect(objects.has(checkpoint.objectKey)).toBe(true); expect(restored.run.status).toBe("queued");
    await new OrderDesignResponseRecovery(database, vault, storage).restore(fixture.context, fixture.lineId, input);
    await process(worker(generate), fixture);
    expect((await state(fixture)).run.status).toBe("awaiting_review"); expect(generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("discards an upload whose storage acknowledgement was lost without changing the run or budget", async () => {
    const fixture = await seed({ paid: true });
    await process(worker(async () => { throw new Error("Synthetic unknown provider result"); }), fixture);
    const input = await restoreInput(fixture, await image()), before = await state(fixture), count = objects.size;
    const lostStorage = { ...storage, putPrivate: async (context: TenantContext, body: PutPrivateInput) => {
      await storage.putPrivate(context, body); throw new Error("Synthetic lost storage acknowledgement");
    } } as unknown as Storage;
    await expect(new OrderDesignResponseRecovery(database, vault, lostStorage).restore(fixture.context, fixture.lineId, input))
      .rejects.toMatchObject({ code: "agent_asset_storage_unavailable" });
    expect(objects.size).toBe(count);
    const after = await state(fixture); expect(after.run).toEqual(before.run); expect(after.ledger).toEqual(before.ledger);
  }, 30_000);

  it("imports an opaque pillow response as evidence but stops on the existing alpha gate without another model call", async () => {
    const fixture = await seed({ pillow: true, paid: true, pipeline: true });
    const generate = vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({ bytes: await image(), actualCostUsd: 0.1 })
      .mockRejectedValueOnce(new Error("Synthetic unknown cutout"));
    const processor = worker(generate, { validatePolicy: async () => {}, upscale: async () => { throw new Error("Opaque cutout must not upscale"); } });
    await process(processor, fixture);
    await new OrderDesignResponseRecovery(database, vault, storage).restore(fixture.context, fixture.lineId, await restoreInput(fixture, await image()));
    await process(processor, fixture);
    const result = await state(fixture);
    expect(result.run.status).toBe("needs_attention"); expect(result.run.qualityDiagnostics).toContainEqual(expect.objectContaining({ code: "agent_alpha_missing", severity: "error" }));
    expect(result.steps.find(step => step.key === "measure_subject")!.status).toBe("pending");
    expect(result.renders).toHaveLength(0); expect(generate).toHaveBeenCalledTimes(2);
    expect(result.project!.reviewedVersionId).toBeNull();
    expect(await withTenant(database.db, fixture.context, tx => tx.select().from(productionOrders).where(eq(productionOrders.sourceWorkItemId, fixture.lineId)))).toHaveLength(0);
    expect((await new OrderDesignRepository(database, vault).view(fixture.context, fixture.lineId)).run!.responseRecoveryTarget).toBeNull();
  }, 30_000);

  it("recovers a known budget block without replaying preparation or double-reserving a paid step", async () => {
    const fixture = await seed({ paid: true, monthlyBudget: 0 });
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => ({ bytes: await image(), actualCostUsd: 0.12 }));
    const processor = worker(generate);
    await process(processor, fixture);
    const blocked = await state(fixture);
    expect(blocked.run).toMatchObject({ status: "needs_attention", errorCode: "agent_model_monthly_budget_exceeded" });
    expect(blocked.steps.find(step => step.key === "enhance_image_1")).toMatchObject({ status: "failed", attempt: 0 });
    expect(blocked.ledger).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
    const preparedVersion = blocked.steps.find(step => step.key === "compose_template")!.outputVersionId;
    await withTenant(database.db, fixture.context, tx => tx.update(aiBudgetPolicies).set({ monthlyCapUsd: "10" }).where(eq(aiBudgetPolicies.tenantId, fixture.context.tenantId)));
    await command(fixture, "resume");
    await process(processor, fixture);
    const complete = await state(fixture);
    expect(complete.run).toMatchObject({ status: "awaiting_review", costStatus: "reported" });
    expect(Number(complete.run.actualCostUsd)).toBe(0.12);
    expect(complete.steps.find(step => step.key === "compose_template")!.outputVersionId).toBe(preparedVersion);
    expect(complete.steps.find(step => step.key === "compose_template")!.attempt).toBe(1);
    expect(complete.ledger).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("releases a proven unsubmitted reservation and safely resumes the same step", async () => {
    const fixture = await seed({ paid: true });
    const generate = vi.fn<OrderDesignImageGateway["generate"]>();
    generate.mockRejectedValueOnce(new OrderDesignSubmissionNotSentError("agent_model_changed"));
    generate.mockResolvedValueOnce({ bytes: await image(), actualCostUsd: 0.1 });
    const processor = worker(generate);
    await process(processor, fixture);
    const before = await state(fixture);
    expect(before.steps.find(step => step.key === "enhance_image_1")).toMatchObject({ status: "failed", errorCode: "agent_model_changed" });
    expect(before.ledger).toHaveLength(1);
    expect(before.ledger[0]!.state).toBe("released");
    await command(fixture, "resume");
    await process(processor, fixture);
    const after = await state(fixture);
    expect(after.run.status).toBe("awaiting_review");
    expect(after.ledger).toHaveLength(2);
    expect(after.ledger.map(row => row.state).sort()).toEqual(["committed", "released"]);
    expect(after.ledger.filter(row => row.state === "committed").reduce((total, row) => total + Number(row.amountUsd), 0)).toBe(0.1);
    expect(after.run.costStatus).toBe("reported");
    expect(Number(after.run.actualCostUsd)).toBe(0.1);
    expect(generate.mock.calls[0]![0].requestId).toBe(generate.mock.calls[1]![0].requestId);
  }, 30_000);

  it("takes over queued work before a project exists and prevents stale deliveries from starting it", async () => {
    const fixture = await seed();
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => { throw new Error("Cancelled fixture must not invoke a model"); });
    await command(fixture, "takeover");
    await process(worker(generate), fixture);
    const cancelled = await state(fixture);
    expect(cancelled.run).toMatchObject({ status: "cancelled", projectId: null });
    expect(cancelled.work.editorProjectId).toBeNull();
    expect(cancelled.versions).toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps in-flight paid work uncertain after takeover and rejects its late result", async () => {
    const fixture = await seed({ paid: true });
    const entered = deferred<void>(), release = deferred<void>();
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => { entered.resolve(); await release.promise; return { bytes: await image() }; });
    const processor = worker(generate), running = process(processor, fixture);
    let before: Awaited<ReturnType<typeof state>> | undefined;
    try {
      await within(entered.promise);
      before = await state(fixture);
      expect(before.project).not.toBeNull();
      expect(await process(processor, fixture)).toMatchObject({ disposition: "not_runnable" });
      expect(generate).toHaveBeenCalledTimes(1);
      await command(fixture, "takeover");
    } finally { release.resolve(); await running; }
    const cancelled = await state(fixture);
    expect(cancelled.run).toMatchObject({ status: "cancelled", costStatus: "unknown", actualCostUsd: null });
    expect(cancelled.steps.find(step => step.key === "enhance_image_1")).toMatchObject({ status: "uncertain", outputAssetId: null });
    expect(cancelled.ledger[0]!.state).toBe("reserved");
    expect(cancelled.versions.map(version => version.id)).toEqual(before!.versions.map(version => version.id));
    expect(cancelled.assets.map(asset => asset.id)).toEqual(before!.assets.map(asset => asset.id));
    await process(processor, fixture);
    expect(generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each([0.13, undefined])("retains durable response and billing evidence when takeover happens after receipt (cost %s)", async (actualCostUsd) => {
    const fixture = await seed({ paid: true });
    const bytes = await image();
    const generate = vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({ bytes, actualCostUsd });
    let takenOver = false;
    const processor = new OrderDesignProcessor(database, storage, vault, { generate }, { scan: async () => {
      if (generate.mock.calls.length && !takenOver) {
        takenOver = true;
        const before = await state(fixture);
        const step = before.steps.find(row => row.key === "enhance_image_1")!;
        expect(open<{ responseCheckpoint?: unknown }>(fixture.workKey, step.encryptedOutput!).responseCheckpoint).toBeDefined();
        await command(fixture, "takeover");
      }
      return scanner.scan();
    } });
    await process(processor, fixture);
    const cancelled = await state(fixture);
    expect(takenOver).toBe(true);
    expect(cancelled.run).toMatchObject({ status: "cancelled", costStatus: actualCostUsd === undefined ? "unknown" : "reported" });
    expect(cancelled.run.actualCostUsd === null ? null : Number(cancelled.run.actualCostUsd)).toBe(actualCostUsd ?? null);
    expect(cancelled.steps.find(step => step.key === "enhance_image_1")).toMatchObject({ status: "skipped", errorCode: "agent_manual_takeover", outputAssetId: null });
    expect(cancelled.ledger).toHaveLength(1);
    expect(cancelled.ledger[0]!.state).toBe(actualCostUsd === undefined ? "reserved" : "committed");
    await process(processor, fixture);
    expect(generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each([0.11, undefined])("retains a received charge when takeover precedes the durable response checkpoint (cost %s)", async (actualCostUsd) => {
    const fixture = await seed({ paid: true });
    const bytes = await image();
    const generate = vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({ bytes, actualCostUsd });
    const racedStorage = { ...storage, putPrivate: async (context: TenantContext, input: PutPrivateInput) => {
      const stored = await storage.putPrivate(context, input);
      if (input.fileName.endsWith("-response-quarantine.pe")) await command(fixture, "takeover");
      return stored;
    } } as Storage;
    const processor = new OrderDesignProcessor(database, racedStorage, vault, { generate }, scanner);
    await process(processor, fixture);
    const cancelled = await state(fixture);
    const step = cancelled.steps.find(row => row.key === "enhance_image_1")!;
    expect(cancelled.run).toMatchObject({ status: "cancelled", costStatus: actualCostUsd === undefined ? "unknown" : "reported" });
    expect(cancelled.run.actualCostUsd === null ? null : Number(cancelled.run.actualCostUsd)).toBe(actualCostUsd ?? null);
    expect(step).toMatchObject({ status: "uncertain", errorCode: "agent_model_response_uncheckpointed", outputAssetId: null });
    const output = open<{ responseReceipt?: unknown; responseCheckpoint?: unknown }>(fixture.workKey, step.encryptedOutput!);
    expect(output.responseReceipt).toBeDefined();
    expect(output.responseCheckpoint).toBeUndefined();
    expect(cancelled.ledger).toHaveLength(1);
    expect(cancelled.ledger[0]!.state).toBe(actualCostUsd === undefined ? "reserved" : "committed");
    await process(processor, fixture);
    expect(generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("rejects cross-tenant reads and queued execution after permission revocation", async () => {
    const fixture = await seed(), other = await seed();
    const repository = new OrderDesignRepository(database, vault);
    await expect(repository.view(other.context, fixture.lineId)).rejects.toMatchObject({ code: "agent_work_not_found" });
    await expect(repository.command(other.context, fixture.lineId, "takeover", { runId: fixture.runId, expectedRevision: 1, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "agent_run_not_found" });
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => { throw new Error("Unauthorized fixture must not invoke a model"); });
    const processor = worker(generate);
    expect(await processor.process({ tenantId: other.context.tenantId, requestedBy: other.context.userId, runId: fixture.runId })).toMatchObject({ disposition: "not_runnable" });
    expect((await state(fixture)).run.status).toBe("queued");
    await withTenant(database.db, fixture.context, tx => tx.update(roles).set({ permissions: executionPermissions.filter(permission => permission !== "order:pii:read") }).where(eq(roles.id, fixture.roleId)));
    await process(processor, fixture);
    expect((await state(fixture)).run).toMatchObject({ status: "needs_attention", errorCode: "agent_membership_unavailable", projectId: null });
    expect(generate).not.toHaveBeenCalled();
  }, 30_000);

  it("checks membership again before publishing a result returned after access was revoked", async () => {
    const fixture = await seed({ paid: true });
    const entered = deferred<void>(), release = deferred<void>();
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => { entered.resolve(); await release.promise; return { bytes: await image() }; });
    const processor = worker(generate), running = process(processor, fixture);
    let before: Awaited<ReturnType<typeof state>> | undefined;
    try {
      await within(entered.promise);
      before = await state(fixture);
      await withTenant(database.db, fixture.context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, fixture.membershipId)));
    } finally { release.resolve(); await running; }
    const blocked = await state(fixture);
    expect(blocked.run).toMatchObject({ status: "needs_attention", costStatus: "unknown" });
    const paid=blocked.steps.find(step=>step.key==="enhance_image_1")!;
    expect(paid.status).toBe("failed");expect(paid.errorCode).toBe("agent_membership_unavailable");
    expect(open<{responseCheckpoint:unknown}>(fixture.workKey,paid.encryptedOutput!).responseCheckpoint).toBeTruthy();
    expect(blocked.versions.map(version => version.id)).toEqual(before!.versions.map(version => version.id));
    expect(blocked.assets.map(asset => asset.id)).toEqual(before!.assets.map(asset => asset.id));
    expect(blocked.project!.reviewedVersionId).toBeNull();
  }, 30_000);

  it("runs preserve pillow cutout through contour and white proof without inventing text or source PPI", async () => {
    const fixture = await seed({ pillow: true });
    const cutout = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><ellipse cx="512" cy="512" rx="310" ry="390" fill="#347abc"/></svg>')).png().toBuffer();
    expect((await sharp(cutout).ensureAlpha().stats()).channels[3]!.min).toBe(0);
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => ({ bytes: cutout, actualCostUsd: 0.1 }));
    await process(worker(generate), fixture);
    const complete = await state(fixture);
    expect(complete.run.status, JSON.stringify({ error: complete.run.errorCode, diagnostics: complete.run.qualityDiagnostics })).toBe("awaiting_review");
    expect(complete.steps.map(step => step.key)).toEqual(["validate_inputs", "compose_template", "cutout_subject", "optimize_contour", "preflight", "render_proof", "review_required"]);
    expect(complete.steps.every(step => step.status === "completed")).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ transparent: true });
    expect(generate.mock.calls[0]![0].prompt).toContain("只抠出");
    expect(generate.mock.calls[0]![0].prompt).toContain("完整头部");
    expect(generate.mock.calls[0]![0].prompt).not.toContain("所有订单的顾客图片均进行保真美化");
    expect(complete.document?.productType).toBe("shaped_pillow");
    expect(complete.document?.layers).toHaveLength(1);
    expect(complete.document?.layers[0]?.kind).toBe("image");
    expect(complete.document?.contour.length).toBeGreaterThan(4);
    expect(complete.document?.exportBackground).toBe("white");
    expect(complete.document?.confirmations.visualReview).toBe(false);
    if (complete.document?.productType === "shaped_pillow") expect(complete.document.spec.sideMode).toBe("double");
    const quality = qualityReport(complete, fixture);
    expect(quality.checks.filter(check => check.code === "text_exact")).toHaveLength(0);
    expect(quality.checks).toContainEqual(expect.objectContaining({ code: "source_resolution", sourcePpi: null, status: "needs_review" }));
    expect(quality.checks).toContainEqual(expect.objectContaining({ code: "output_resolution", status: "passed", outputPpi: expect.any(Number) }));
    expect(quality.checks).toContainEqual(expect.objectContaining({ code: "identity_and_content", status: "needs_review" }));
    expect(quality.automaticProductionApproval).toBe(false);
    expect(complete.renders).toHaveLength(1);
    const projectKey = vault.withSecret(complete.project!.encryptedDataKey!, value => Buffer.from(value, "base64"));
    try {
      const proof = complete.renders[0]!;
      expect(open<{ purpose: string; background: string }>(projectKey, proof.encryptedOptions)).toMatchObject({ purpose: "preview", background: "white" });
      const manifest = open<{ files: Array<{ objectKey: string }>; preflight: { productionReady: boolean } }>(projectKey, proof.encryptedManifest!);
      const bytes = decryptProductionBytes(projectKey, objects.get(manifest.files[0]!.objectKey)!);
      expect((await sharp(bytes).metadata()).hasAlpha).toBe(false);
      expect([...await sharp(bytes).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()]).toEqual([255, 255, 255, 255]);
      expect(manifest.preflight.productionReady).toBe(false);
    } finally { projectKey.fill(0); }
  }, 45_000);

  it("normalizes adapter references and blocks changed or disabled destinations before sending private images", async () => {
    const fixture = await seed({ paid: true });
    const generated = await image();
    const generate = vi.fn<StudioGateway["generate"]>(async () => ({ bytes: generated, mediaType: "image/png" }));
    const adapter = new OrderDesignStudioGateway(database, vault, { generate });
    const controller = new AbortController();
    const input: Parameters<OrderDesignImageGateway["generate"]>[0] = {
      context: fixture.context, requestId: createEntityId(), model: fixture.snapshot.model!, prompt: "Synthetic faithful image edit",
      bytes: await sharp(await image()).jpeg().toBuffer(), size: "1024x1024", transparent: false, signal: controller.signal,
    };
    const result = await adapter.generate(input);
    expect(result.bytes).toEqual(generated);
    expect(result).not.toHaveProperty("actualCostUsd");
    expect(generate).toHaveBeenCalledTimes(1);
    const sent = generate.mock.calls[0]![0];
    expect(sent).toMatchObject({ capability: "image", model: "synthetic-image", endpoint: "https://synthetic.invalid/v1", apiKey: "synthetic-never-used" });
    expect(sent.signal).toBe(controller.signal);
    expect(sent.references).toHaveLength(1);
    expect(sent.references[0]!.mediaType).toBe("image/png");
    expect(await sharp(sent.references[0]!.bytes).metadata()).toMatchObject({ format: "png", width: 512, height: 512 });
    generate.mockClear();
    await expect(adapter.generate({ ...input, model: { ...input.model, endpoint: "https://different.invalid/v1" } })).rejects.toBeInstanceOf(OrderDesignSubmissionNotSentError);
    await expect(adapter.generate({ ...input, model: { ...input.model, model: "different-model" } })).rejects.toMatchObject({ code: "agent_model_configuration_changed" });
    await withTenant(database.db, fixture.context, tx => tx.update(modelProviderConfigs).set({ status: "disabled" }).where(eq(modelProviderConfigs.id, input.model.providerConfigId)));
    await expect(adapter.generate(input)).rejects.toBeInstanceOf(OrderDesignSubmissionNotSentError);
    await withTenant(database.db, fixture.context, async tx => {
      await tx.update(modelProviderConfigs).set({ status: "enabled" }).where(eq(modelProviderConfigs.id, input.model.providerConfigId));
      await tx.update(modelRoutes).set({ status: "disabled" }).where(eq(modelRoutes.id, input.model.routeId));
    });
    await expect(adapter.generate(input)).rejects.toBeInstanceOf(OrderDesignSubmissionNotSentError);
    controller.abort();
    await expect(adapter.generate(input)).rejects.toMatchObject({ code: "agent_model_cancelled_before_submission" });
    expect(generate).not.toHaveBeenCalled();
  }, 30_000);

  it("actually dispatches tenant outboxes, retries only due events, and keeps business data under RLS", async () => {
    const success = await seed(), retry = await seed();
    // This scenario tests due-event delivery, not immediate scheduling at a
    // moving host/container clock boundary. Establish due fixtures using the
    // same database clock as the production dispatcher and assert the premise.
    for(const fixture of [success,retry])await withTenant(database.db,fixture.context,async tx=>{
      const events=await tx.update(outbox).set({nextAttemptAt:sql`now() - interval '1 minute'`}).where(eq(outbox.runId,fixture.runId))
        .returning({id:outbox.id,due:sql<boolean>`${outbox.nextAttemptAt} <= now()`});
      expect(events).toHaveLength(1);expect(events[0]!.due).toBe(true);
    });
    type Delivery = { tenantId: string; requestedBy: string; runId: string; dispatchId: string };
    const calls: Delivery[] = [];
    let rejectRetry = true;
    const dispatcher = { enqueue: async (input: Delivery) => {
      calls.push(input);
      if (input.runId === retry.runId && rejectRetry) throw new Error("Synthetic queue unavailable");
    } };
    await dispatchOrderDesignOutbox(database, dispatcher);
    expect(calls.filter(call => call.runId === success.runId)).toHaveLength(1);
    expect(calls.filter(call => call.runId === retry.runId)).toHaveLength(1);
    expect(calls.find(call => call.runId === success.runId)).toMatchObject({ tenantId: success.context.tenantId, requestedBy: success.context.userId });
    const firstRetry = calls.find(call => call.runId === retry.runId)!;
    const successEvents = await withTenant(database.db, success.context, tx => tx.select().from(outbox).where(eq(outbox.runId, success.runId)));
    expect(successEvents).toHaveLength(1);
    expect(successEvents[0]!.dispatchedAt).not.toBeNull();
    await dispatchOrderDesignOutbox(database, dispatcher);
    expect(calls.filter(call => call.runId === success.runId)).toHaveLength(1);
    expect(calls.filter(call => call.runId === retry.runId)).toHaveLength(1);
    rejectRetry = false;
    await withTenant(database.db, retry.context, tx => tx.update(outbox).set({ nextAttemptAt: sql`now() - interval '1 minute'` }).where(eq(outbox.id, firstRetry.dispatchId)));
    await dispatchOrderDesignOutbox(database, dispatcher);
    const retried = calls.filter(call => call.runId === retry.runId);
    expect(retried).toHaveLength(2);
    expect(retried[1]!.dispatchId).toBe(firstRetry.dispatchId);
    await dispatchOrderDesignOutbox(database, dispatcher);
    expect(calls.filter(call => call.runId === retry.runId)).toHaveLength(2);
    expect(await database.db.transaction(async tx => {
      await tx.execute(sql.raw("set local role yummyai_app"));
      return tx.select({ id: runs.id }).from(runs);
    })).toEqual([]);
    const unregisteredTenant = createEntityId();
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic unregistered routing tenant',$2)", [unregisteredTenant, `routing-${unregisteredTenant}`]);
    await expect(withTenant(database.db, success.context, tx => tx.insert(orderDesignDispatchTenants).values({ tenantId: unregisteredTenant }))).rejects.toThrow();
    expect(await withTenant(database.db, success.context, tx => tx.select().from(orderDesignDispatchTenants).where(eq(orderDesignDispatchTenants.tenantId, unregisteredTenant)))).toEqual([]);
    expect((await state(success)).run.status).toBe("queued");
    expect((await state(retry)).run.status).toBe("queued");
  }, 30_000);

  it("keeps dispatch-time rules in the encrypted run after a new rule is published", async () => {
    const fixture = await seed({ rules: "manual" });
    const repository = new OrderDesignRepository(database, vault);
    const before = (await repository.view(fixture.context, fixture.lineId)).run!;
    expect(before.ruleSnapshot?.rules[0]?.instructions).toBe("Original rule at dispatch");
    const pinned = before.ruleSnapshot!.rules[0]!;
    const center = new RuleCenterService(database, new AuditService(database)), admin = { ...fixture.context, permissions: Object.values(Permission) };
    await center.save(admin, pinned.ruleId, { fields: { name: pinned.name, category: pinned.category, instructions: "New requirement after dispatch", source: pinned.source, appliesTo: "order_design", scopeKind: "all", productType: null, spuId: null }, expectedRevision: 2, changeReason: "Synthetic revise", idempotencyKey: randomUUID() });
    await center.changeState(admin, pinned.ruleId, "publish", { expectedRevision: 3, version: 2, changeReason: "Synthetic publish V2" });
    const gateway: OrderDesignImageGateway = { generate: vi.fn(async () => { throw new Error("No model call expected"); }) };
    await process(new OrderDesignProcessor(database, storage, vault, gateway, scanner), fixture);
    const after = (await repository.view(fixture.context, fixture.lineId)).run!;
    expect(after.status).toBe("awaiting_review");
    expect(after.ruleSnapshot).toEqual(before.ruleSnapshot);
    expect(after.qualityDiagnostics.some(issue => issue.code === "rule_manual" && issue.message.includes("V1"))).toBe(true);
    expect(gateway.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("does not enqueue a model task when published rules conflict with its fixed recipe", async () => {
    const fixture = await seed({ rules: "baseline", pillow: true });
    const run = (await new OrderDesignRepository(database, vault).view(fixture.context, fixture.lineId)).run!;
    expect(run.status).toBe("needs_attention"); expect(run.errorCode).toBe("agent_rule_conflict");
    expect(run.qualityDiagnostics.filter(issue => issue.severity === "error").map(issue => issue.code)).toEqual(expect.arrayContaining(["rule_enhancement_conflict", "rule_factory_conflict"]));
    expect(await withTenant(database.db, fixture.context, tx => tx.select().from(outbox).where(eq(outbox.runId, run.id)))).toEqual([]);
  });

  it("opens a real manual project after a blocked agent takeover without automatic layout or image enhancement", async () => {
    const fixture = await seed({ paid: true, missingRoute: true });
    const context = fixture.context;
    const catalogContext = { ...context, permissions: [...context.permissions, "product:read", "product:write", "design:review"] };
    const audit = new AuditService(database);
    const reports = new AmazonOrderReportService(database, vault, new OrderService(database, vault, audit), audit,
      { download: async () => { throw new Error("No network in synthetic takeover fixture"); }, scan: scanner.scan },
      { schedule: async () => undefined }, { schedule: async () => undefined });
    const enqueue = vi.fn(async () => undefined);
    const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue }, scanner);
    const workspace = new OrderWorkspaceService(database, vault, storage, reports, editor, scanner);
    const catalog = new ProductDevelopmentService(database, storage);
    const profile = (await workspace.saveProfile(catalogContext, {
      code: "TAKEOVER", name: "Synthetic manual takeover process", projectId: fixture.snapshot.templateProjectId,
      versionId: fixture.snapshot.templateVersionId, instructions: "Preserve the approved physical specification",
      expectedVersion: 0, idempotencyKey: randomUUID(),
    }))[0]!;
    const { artwork } = await catalog.registerArtwork(catalogContext, {
      code: "TAKEOVER-ART", name: "Synthetic buyer photo and exact text", mode: "customer_image",
      customization: fixture.snapshot.customization, layout: fixture.snapshot.layout,
      instructions: "Use the supplied buyer image and buyer name", expectedVersion: 0, idempotencyKey: randomUUID(),
    });
    const { spu } = await catalog.createSpu(catalogContext, { code: "TAKEOVER-SPU", name: "Synthetic rectangular product", idempotencyKey: randomUUID() });
    const { specification } = await catalog.saveSpecification(catalogContext, {
      spuId: spu.id, code: "40MM", name: "40 mm square", attributes: { size: "40 mm" },
      facts: syntheticSpecificationFacts({ material: "Synthetic fabric", dimensions: "40 x 40 mm", packageContents: "One item", packageQuantity: 1, factsConfirmed: true }),
      processProfileVersionId: profile.versionId, expectedVersion: 0, idempotencyKey: randomUUID(),
    });
    let detail = await workspace.detail(context, fixture.lineId);
    detail = await workspace.action(context, fixture.lineId, {
      action: "recall", expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Bind the synthetic approved sales basis", idempotencyKey: randomUUID(),
    });
    detail = await workspace.save(context, fixture.lineId, {
      expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, expectedSourceVersionId: null,
      draft: { ...detail.draft, printProfileVersionId: profile.versionId, artworkVersionId: artwork.versionId, specificationVersionId: specification.versionId },
      status: "ready_to_push", reason: "Synthetic operator review", idempotencyKey: randomUUID(),
    });
    const approvedDraft = structuredClone(detail.draft);
    const original = await workspace.image(context, fixture.lineId, approvedDraft.images[0]!.key, true);
    detail = await workspace.action(context, fixture.lineId, {
      action: "push", expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Create the agent run using the ordinary order action", idempotencyKey: randomUUID(),
    });
    const repository = new OrderDesignRepository(database, vault);
    const blocked = await repository.view(context, fixture.lineId);
    expect(blocked.run).toMatchObject({ status: "needs_attention", projectId: null });
    expect(blocked.run!.id).not.toBe(fixture.runId);
    const generate = vi.fn<OrderDesignImageGateway["generate"]>(async () => { throw new Error("A blocked or taken-over run must not invoke a model"); });
    const processor = worker(generate);
    await processor.process({ tenantId: context.tenantId, requestedBy: context.userId, runId: blocked.run!.id });
    await repository.command(context, fixture.lineId, "takeover", {
      runId: blocked.run!.id, expectedRevision: blocked.run!.revision, idempotencyKey: randomUUID(),
    });
    expect((await repository.view(context, fixture.lineId)).run?.status).toBe("cancelled");
    detail = await workspace.detail(context, fixture.lineId);
    detail = await workspace.action(context, fixture.lineId, {
      action: "start_artwork", expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Human designer takes responsibility for the blocked run", idempotencyKey: randomUUID(),
    });
    expect(detail.line.artwork).toBe("in_progress");
    expect(detail.line.editorProjectId).not.toBeNull();
    expect(detail.draft).toEqual(approvedDraft);
    const manual = await editor.get(context, detail.line.editorProjectId!);
    expect(manual.version.reviewed).toBe(false);
    expect(manual.version.document.productType).toBe(fixture.snapshot.document.productType);
    expect(manual.version.document.spec).toEqual(fixture.snapshot.document.spec);
    expect(manual.version.document.confirmations.visualReview).toBe(false);
    // Removing the manualTakeover guard creates custom_name/custom_photo_1 here.
    expect(manual.version.document.layers.some(layer => layer.id.startsWith("custom_"))).toBe(false);
    expect(manual.images).toHaveLength(1);
    const copied = await editor.image(context, manual.project.id, manual.images[0]!.id, "original");
    expect(Buffer.from(copied.body)).toEqual(Buffer.from(original.body));
    expect(checksum(copied.body)).toBe(fixture.snapshot.assets[0]!.checksum);
    expect(manual.renders).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    await processor.process({ tenantId: context.tenantId, requestedBy: context.userId, runId: blocked.run!.id });
    expect(generate).not.toHaveBeenCalled();
    expect(await withTenant(database.db, context, tx => tx.select().from(outbox).where(eq(outbox.runId, blocked.run!.id)))).toEqual([]);
    expect((await repository.view(context, fixture.lineId)).run?.status).toBe("cancelled");
  }, 30_000);

  it.each(["head", "Half Body"])("completes the versioned pillow chain for %s with actual subject sizing, an auditable upscale checkpoint and a full factory JPG awaiting review", async (cropScope) => {
    const fixture=await seed({pillow:true,paid:true,pipeline:true,cropScope});
    const cutout=await pillowImage(512);
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({bytes:await image(),actualCostUsd:0.1}).mockResolvedValueOnce({bytes:cutout,actualCostUsd:0.1});
    // This verifies the orchestrator contract. The worker's real binary is tested separately.
    const upscale=vi.fn<OrderDesignSuperResolutionGateway["upscale"]>(async ({bytes})=>({bytes:await sharp(bytes).resize(2048,2048).png().toBuffer(),evidence:{engine:"synthetic-integration"}}));
    await process(worker(generate,{validatePolicy:async()=>{},upscale}),fixture);
    const result=await state(fixture);
    expect(result.run,JSON.stringify(result.run.qualityDiagnostics)).toMatchObject({status:"awaiting_review",errorCode:null});
    expect(result.steps.every(step=>step.status==="completed")).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);expect(upscale).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[1]![0].prompt).toContain("细长胡须");
    const cutoutStep=result.steps.find(step=>step.key==="cutout_subject")!;
    const pinnedCutout=open<Record<string,unknown>>(fixture.workKey,cutoutStep.encryptedInput);
    const subject=cropScope==="Half Body"?"half_body":"head";
    expect(pinnedCutout).toMatchObject({subject});
    expect(open<OrderDesignSnapshot>(fixture.workKey,result.run.encryptedSnapshot).draft.fields.find(field=>field.key==="crop_scope")?.value).toBe(cropScope);
    if(subject==="half_body") {
      expect(pinnedCutout).toMatchObject({subjectPromptVersion:"pillow-half-body-v1"});
      expect(generate.mock.calls[1]![0].prompt).toContain("躯干上半部");
      expect(generate.mock.calls[1]![0].prompt).toContain("不补画被遮挡或原图之外");
      expect(generate.mock.calls[1]![0].prompt).not.toContain("完整主体全身，保留所有手脚");
    } else expect(pinnedCutout).not.toHaveProperty("subjectPromptVersion");
    const resolution=result.steps.find(step=>step.key==="ensure_resolution")!;
    expect(open<Record<string,unknown>>(fixture.workKey,resolution.encryptedOutput!)).toMatchObject({nativeDetailVerified:false,policy:PILLOW_REALESRGAN_POLICY});
    expect(open<OrderDesignSnapshot>(fixture.workKey,result.run.encryptedSnapshot).recipe.pillowPipeline?.contour.workflow).toBeUndefined();
    expect(open<Record<string,unknown>>(fixture.workKey,result.steps.find(step=>step.key==="optimize_contour")!.encryptedOutput!)).not.toHaveProperty("contourEvidence");
    expect((await new OrderDesignRepository(database,vault).view(fixture.context,fixture.lineId)).run?.steps.find(step=>step.key==="optimize_contour")?.contourEvidence??null).toBeNull();
    expect(result.document?.layers[0]).toMatchObject({locked:true,assetId:resolution.outputAssetId});
    expect(result.document?.confirmations.visualReview).toBe(false);
    expect(result.project?.reviewedVersionId).toBeNull();expect(result.work.approvedEditorVersionId).toBeNull();
    const projectKey=vault.withSecret(result.project!.encryptedDataKey!,value=>Buffer.from(value,"base64"));
    try {
      const cutoutAsset=result.assets.find(asset=>asset.id===cutoutStep.outputAssetId)!;
      const cutoutMetadata=open<{modelEdit:Record<string,unknown>}>(projectKey,cutoutAsset.encryptedMetadata);
      expect(cutoutMetadata.modelEdit.promptVersion).toBe("pillow-cutout-whiskers-v1");
      if(subject==="half_body")expect(cutoutMetadata.modelEdit.subjectPromptVersion).toBe("pillow-half-body-v1");
      else expect(cutoutMetadata.modelEdit).not.toHaveProperty("subjectPromptVersion");
      const manifest=open<{files:Array<{objectKey:string;name:string}>;preflight:{productionReady:boolean}}>(projectKey,result.renders[0]!.encryptedManifest!);
      const bytes=decryptProductionBytes(projectKey,objects.get(manifest.files[0]!.objectKey)!);
      const metadata=await sharp(bytes).metadata();
      expect(manifest.files[0]!.name).toMatch(/\.jpg$/);expect(manifest.preflight.productionReady).toBe(false);
      expect(metadata).toMatchObject({format:"jpeg",density:150,channels:3,hasAlpha:false});expect(metadata.icc?.length).toBeGreaterThan(0);
      expect(metadata.width).toBeGreaterThan(3000);expect(metadata.height).toBeGreaterThan(1500);
    } finally {projectKey.fill(0);}
  },60_000);

  it("pins contour graph evidence to unchanged artwork, deduplicates delivery and hides expired or cross-tenant evidence",async()=>{
    const fixture=await seed({pillow:true,paid:true,pipeline:true,contourGraph:true});
    const cutout=await pillowImage(512);
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({bytes:await image(),actualCostUsd:0.1}).mockResolvedValueOnce({bytes:cutout,actualCostUsd:0.1});
    const upscale=vi.fn<OrderDesignSuperResolutionGateway["upscale"]>(async({bytes})=>({bytes:await sharp(bytes).resize(2048,2048).png().toBuffer(),evidence:{engine:"synthetic-integration"}}));
    const processor=worker(generate,{validatePolicy:async()=>{},upscale});
    await Promise.all([process(processor,fixture),process(processor,fixture)]);
    const result=await state(fixture),contour=result.steps.find(step=>step.key==="optimize_contour")!;
    expect(result.run,JSON.stringify(result.run.qualityDiagnostics)).toMatchObject({status:"awaiting_review",errorCode:null});
    expect(open<OrderDesignSnapshot>(fixture.workKey,result.run.encryptedSnapshot).recipe.pillowPipeline?.contour.workflow).toBe(PILLOW_CONTOUR_GRAPH_VERSION);
    const resolution=result.steps.find(step=>step.key==="ensure_resolution")!;
    const source=result.assets.find(asset=>asset.id===resolution.outputAssetId)!;
    expect(contour).toMatchObject({status:"completed",attempt:1,outputAssetId:source.id});
    expect(result.document?.layers[0]).toMatchObject({assetId:source.id,locked:true});
    expect(result.document?.confirmations.visualReview).toBe(false);
    expect(result.project?.reviewedVersionId).toBeNull();
    const repository=new OrderDesignRepository(database,vault);
    const view=await repository.view(fixture.context,fixture.lineId);
    const evidence=view.run!.steps.find(step=>step.key==="optimize_contour")!.contourEvidence;
    expect(evidence).toMatchObject({workflowVersion:PILLOW_CONTOUR_GRAPH_VERSION,engine:"langgraph",status:"passed",
      sourceAssetId:source.id,sourceChecksum:source.checksum,outputChecksum:source.checksum,artworkUnchanged:true,manualReviewRequired:true});
    expect(evidence?.attempts.length).toBeGreaterThan(0);expect(evidence?.attempts.length).toBeLessThanOrEqual(3);
    expect(evidence?.attempts.map(attempt=>attempt.roundingPx)).toEqual([20,25,30].slice(0,evidence!.attempts.length));
    expect(evidence?.attempts.at(-1)?.technicalPassed).toBe(true);
    expect(open<{contourEvidence:unknown}>(fixture.workKey,contour.encryptedOutput!).contourEvidence).toEqual(evidence);
    const projectKey=vault.withSecret(result.project!.encryptedDataKey!,value=>Buffer.from(value,"base64"));
    try {expect(checksum(decryptProductionBytes(projectKey,objects.get(source.originalObjectKey)!))).toBe(evidence?.sourceChecksum);}
    finally {projectKey.fill(0);}
    const serialized=JSON.stringify(view);
    for(const privateValue of [source.originalObjectKey,contour.encryptedOutput!,result.run.encryptedSnapshot,"encryptedOutput","objectKey"])expect(serialized).not.toContain(privateValue);
    await process(processor,fixture);
    const redelivered=await state(fixture);
    expect(redelivered.versions.map(version=>version.id)).toEqual(result.versions.map(version=>version.id));
    expect(redelivered.steps.find(step=>step.key==="optimize_contour")?.encryptedOutput).toBe(contour.encryptedOutput);
    expect(generate).toHaveBeenCalledTimes(2);expect(upscale).toHaveBeenCalledTimes(1);expect(redelivered.ledger).toHaveLength(2);
    const other=await seed();
    await expect(repository.view(other.context,fixture.lineId)).rejects.toMatchObject({code:"agent_work_not_found"});
    await withTenant(database.db,fixture.context,tx=>tx.update(orderWorkItems).set({expiresAt:new Date(Date.now()-1_000)}).where(eq(orderWorkItems.id,fixture.lineId)));
    const expired=await repository.view(fixture.context,fixture.lineId);
    expect(expired.run).toMatchObject({privateEvidenceState:"expired",privateEvidenceOmitted:true,steps:[],qualityDiagnostics:[],canResume:false,canTakeOver:false});
    expect(JSON.stringify(expired)).not.toContain(source.checksum);
  },60_000);

  it.each(["resume","takeover"] as const)("preserves a committed contour graph after proof storage fails and %s never repeats paid work",async(action)=>{
    const fixture=await seed({pillow:true,paid:true,pipeline:true,contourGraph:true});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({bytes:await image(),actualCostUsd:0.1}).mockResolvedValueOnce({bytes:await pillowImage(512),actualCostUsd:0.1});
    const upscale=vi.fn<OrderDesignSuperResolutionGateway["upscale"]>(async({bytes})=>({bytes:await sharp(bytes).resize(2048,2048).png().toBuffer(),evidence:{engine:"synthetic-integration"}}));
    let failProof=true;
    const proofStorage={...storage,putPrivate:async(context:TenantContext,input:PutPrivateInput)=>{
      if(failProof && input.fileName.endsWith("-proof.pe")){failProof=false;throw new Error("Synthetic proof storage unavailable");}
      return storage.putPrivate(context,input);
    }} as Storage;
    const processor=new OrderDesignProcessor(database,proofStorage,vault,{generate},scanner,{validatePolicy:async()=>{},upscale});
    await process(processor,fixture);
    const before=await state(fixture),contour=before.steps.find(step=>step.key==="optimize_contour")!;
    expect(before.run.status).toBe("needs_attention");
    expect(contour).toMatchObject({status:"completed",attempt:1});
    expect(before.steps.find(step=>step.key==="render_proof")).toMatchObject({status:"failed",attempt:1});
    const repository=new OrderDesignRepository(database,vault),beforeView=await repository.view(fixture.context,fixture.lineId);
    expect(beforeView.run?.canResume).toBe(true);
    expect(beforeView.run!.steps.find(step=>step.key==="optimize_contour")!.contourEvidence?.status).toBe("passed");
    await command(fixture,action);
    await Promise.all([process(processor,fixture),process(processor,fixture)]);
    const after=await state(fixture),afterContour=after.steps.find(step=>step.key==="optimize_contour")!;
    expect(after.run.status).toBe(action==="resume"?"awaiting_review":"cancelled");
    expect(afterContour).toMatchObject({status:"completed",attempt:1,encryptedOutput:contour.encryptedOutput,outputVersionId:contour.outputVersionId});
    expect(after.versions.map(version=>version.id)).toEqual(before.versions.map(version=>version.id));
    expect((await repository.view(fixture.context,fixture.lineId)).run!.steps.find(step=>step.key==="optimize_contour")!.contourEvidence)
      .toEqual(beforeView.run!.steps.find(step=>step.key==="optimize_contour")!.contourEvidence);
    expect(after.renders).toHaveLength(action==="resume"?1:0);
    expect(after.project?.reviewedVersionId).toBeNull();expect(after.work.approvedEditorVersionId).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);expect(upscale).toHaveBeenCalledTimes(1);expect(after.ledger).toHaveLength(2);
  },60_000);

  it("persists synthetic forced contour QA exhaustion, stops downstream work and never grants production approval",async()=>{
    const fixture=await seed({pillow:true,paid:true,pipeline:true,contourGraph:true});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({bytes:await image(),actualCostUsd:0.1}).mockResolvedValueOnce({bytes:await pillowImage(512),actualCostUsd:0.1});
    const upscale=vi.fn<OrderDesignSuperResolutionGateway["upscale"]>(async({bytes})=>({bytes:await sharp(bytes).resize(2048,2048).png().toBuffer(),evidence:{engine:"synthetic-integration"}}));
    // Keep actual geometry and manufacturing checks. Add a fixture-only failure
    // to exercise the real graph, encrypted commit and public evidence boundary.
    const createGeometry=pillowGeometry.createPillowAutomationGeometry,recomputeGeometry=pillowGeometry.recomputePillowAutomationGeometry;
    const forceFailure=(result:pillowGeometry.PillowAutomationGeometryResult):pillowGeometry.PillowAutomationGeometryResult=>({
      ...result,qa:{...result.qa,technicalPassed:false,checks:[...result.qa.checks,{code:"synthetic_forced_contour_failure",status:"failed"}]},
      diagnostics:[...result.diagnostics,"synthetic_forced_contour_failure"],
    });
    const create=vi.spyOn(pillowGeometry,"createPillowAutomationGeometry").mockImplementation((...args)=>forceFailure(createGeometry(...args)));
    const recompute=vi.spyOn(pillowGeometry,"recomputePillowAutomationGeometry").mockImplementation((...args)=>forceFailure(recomputeGeometry(...args)));
    try {
      const processor=worker(generate,{validatePolicy:async()=>{},upscale});
      await process(processor,fixture);
      const result=await state(fixture),contour=result.steps.find(step=>step.key==="optimize_contour")!;
      expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_quality_failed"});
      expect(result.run.qualityDiagnostics).toContainEqual(expect.objectContaining({code:"agent_pillow_geometry_invalid",severity:"error"}));
      expect(contour).toMatchObject({status:"completed",attempt:1});
      expect(create).toHaveBeenCalledTimes(1);expect(recompute).toHaveBeenCalledTimes(2);
      for(const key of ["preflight","render_proof","review_required"])expect(result.steps.find(step=>step.key===key)).toMatchObject({status:"pending",attempt:0});
      expect(result.renders).toHaveLength(0);
      expect(result.document?.confirmations.visualReview).toBe(false);
      expect(result.project).toMatchObject({reviewedVersionId:null,reviewedBy:null});
      expect(result.work).toMatchObject({artwork:"in_progress",approvedEditorVersionId:null,proofEditorVersionId:null});
      const view=await new OrderDesignRepository(database,vault).view(fixture.context,fixture.lineId);
      expect(view.run).toMatchObject({status:"needs_attention",canResume:false,canTakeOver:true});
      const evidence=view.run!.steps.find(step=>step.key==="optimize_contour")!.contourEvidence;
      expect(evidence).toMatchObject({workflowVersion:PILLOW_CONTOUR_GRAPH_VERSION,status:"needs_attention",artworkUnchanged:true,manualReviewRequired:true});
      expect(evidence?.attempts.map(attempt=>attempt.roundingPx)).toEqual([20,25,30]);
      expect(evidence?.attempts.every(attempt=>!attempt.technicalPassed && attempt.checks.some(check=>check.code==="synthetic_forced_contour_failure" && check.status==="failed"))).toBe(true);
      expect(open<{contourEvidence:unknown}>(fixture.workKey,contour.encryptedOutput!).contourEvidence).toEqual(evidence);
      expect(evidence?.sourceChecksum).toBe(result.assets.find(asset=>asset.id===contour.outputAssetId)?.checksum);
      expect(evidence?.outputChecksum).toBe(evidence?.sourceChecksum);
      await expect(command(fixture,"resume")).rejects.toMatchObject({code:"agent_resume_not_safe"});
      await process(processor,fixture);
      expect((await state(fixture)).steps.find(step=>step.key==="optimize_contour")?.encryptedOutput).toBe(contour.encryptedOutput);
      expect(create).toHaveBeenCalledTimes(1);expect(recompute).toHaveBeenCalledTimes(2);
      expect(generate).toHaveBeenCalledTimes(2);expect(upscale).toHaveBeenCalledTimes(1);expect(result.ledger).toHaveLength(2);
    } finally {create.mockRestore();recompute.mockRestore();}
  },60_000);

  it("automatically recovers a transient local upscale failure from the cutout checkpoint without another paid call", async()=>{
    const fixture=await seed({pillow:true,paid:true,pipeline:true});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({bytes:await image(),actualCostUsd:0.1}).mockResolvedValueOnce({bytes:await pillowImage(512),actualCostUsd:0.1});
    const upscale=vi.fn<OrderDesignSuperResolutionGateway["upscale"]>().mockRejectedValueOnce(new OrderDesignError("agent_upscale_timeout")).mockImplementation(async({bytes})=>({bytes:await sharp(bytes).resize(2048,2048).png().toBuffer(),evidence:{engine:"synthetic-integration"}}));
    const processor=worker(generate,{validatePolicy:async()=>{},upscale});
    await process(processor,fixture);
    const complete=await state(fixture);expect(complete.run.status).toBe("awaiting_review");
    expect(complete.steps.find(step=>step.key==="cutout_subject")).toMatchObject({status:"completed",attempt:1});
    const resolution=complete.steps.find(step=>step.key==="ensure_resolution")!;
    expect(resolution.attempt).toBe(2);
    expect(open<{localRecovery:unknown}>(fixture.workKey,resolution.encryptedOutput!).localRecovery).toEqual([{attempt:1,code:"agent_upscale_timeout"}]);
    expect(generate).toHaveBeenCalledTimes(2);expect(upscale).toHaveBeenCalledTimes(2);expect(complete.ledger).toHaveLength(2);
  },60_000);

  it("fails closed on an unavailable pinned pillow runtime before spending on a model",async()=>{
    const fixture=await seed({pillow:true,paid:true,pipeline:true});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>();
    await process(worker(generate,{validatePolicy:async()=>{throw new OrderDesignError("agent_upscale_runtime_integrity_failed");},upscale:vi.fn()}),fixture);
    const result=await state(fixture);expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_upscale_runtime_integrity_failed"});
    expect(generate).not.toHaveBeenCalled();expect(result.ledger).toHaveLength(0);expect(result.renders).toHaveLength(0);
  });

  it("durably quarantines a paid response before scanning and automatically recovers with one charge and unchanged grayscale alpha bytes",async()=>{
    const fixture=await seed({paid:true});
    const responseBytes=await sharp({create:{width:512,height:512,channels:4,background:{r:73,g:73,b:73,alpha:0.5}}}).toColourspace("b-w").png().toBuffer();
    expect(await sharp(responseBytes).metadata()).toMatchObject({channels:2,hasAlpha:true});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({bytes:responseBytes,actualCostUsd:0.12});
    let failures=0,beforeProcessing:Awaited<ReturnType<typeof state>>|undefined;
    const scan=async(input:{body:Uint8Array})=>{
      if(checksum(input.body)===checksum(responseBytes) && failures++===0) {
        beforeProcessing=await state(fixture);
        throw new Error("Synthetic scanner offline; never expose this host path or secret");
      }
      return scanner.scan();
    };
    const processor=new OrderDesignProcessor(database,storage,vault,{generate},{scan});
    await process(processor,fixture);
    const result=await state(fixture),step=result.steps.find(row=>row.key==="enhance_image_1")!;
    expect(result.run.status).toBe("awaiting_review");expect(generate).toHaveBeenCalledTimes(1);
    expect(step).toMatchObject({status:"completed",attempt:2});
    const checkpoint=open<{responseCheckpoint:{objectKey:string;checksum:string;quarantined:boolean};responseProcessingAttempts:number;localRecovery:unknown}>(fixture.workKey,step.encryptedOutput!);
    expect(checkpoint.responseCheckpoint).toMatchObject({checksum:checksum(responseBytes),quarantined:true});
    expect(checkpoint.responseProcessingAttempts).toBe(2);
    expect(checkpoint.localRecovery).toEqual([{attempt:1,code:"agent_scan_unavailable"}]);
    expect(beforeProcessing!.assets.some(asset=>asset.checksum===checksum(responseBytes))).toBe(false);
    expect(beforeProcessing!.steps.find(row=>row.key==="enhance_image_1")?.outputAssetId).toBeNull();
    expect(beforeProcessing!.ledger).toHaveLength(1);expect(beforeProcessing!.ledger[0]).toMatchObject({state:"committed"});
    expect(result.ledger).toHaveLength(1);expect(Number(result.ledger[0]!.amountUsd)).toBe(0.12);
    const asset=result.assets.find(row=>row.id===step.outputAssetId)!;
    expect(asset.originalObjectKey).toBe(checkpoint.responseCheckpoint.objectKey);
    const projectKey=vault.withSecret(result.project!.encryptedDataKey!,value=>Buffer.from(value,"base64"));
    try {
      expect(open<{actualAlpha:boolean}>(projectKey,asset.encryptedMetadata).actualAlpha).toBe(true);
      expect(decryptProductionBytes(projectKey,objects.get(asset.originalObjectKey)!)).toEqual(responseBytes);
      const original=result.assets.find(row=>row.id===fixture.snapshot.assets[0]!.key)!;
      expect(checksum(decryptProductionBytes(projectKey,objects.get(original.originalObjectKey)!))).toBe(fixture.snapshot.assets[0]!.checksum);
    } finally {projectKey.fill(0);}
    const view=JSON.stringify(await new OrderDesignRepository(database,vault).view(fixture.context,fixture.lineId));
    expect(view).not.toContain(checkpoint.responseCheckpoint.objectKey);expect(view).not.toContain("encryptedOutput");
    expect(view).not.toContain("host path or secret");
    await process(processor,fixture);expect(generate).toHaveBeenCalledTimes(1);
  },30_000);

  it("limits local processing of a received model response to three attempts without charging again",async()=>{
    const fixture=await seed({paid:true}),bytes=await image();
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({bytes,actualCostUsd:0.17});
    let responseScans=0;
    const processor=new OrderDesignProcessor(database,storage,vault,{generate},{scan:async()=>{
      if(generate.mock.calls.length){responseScans++;throw new Error("Synthetic scanner unavailable");}
      return scanner.scan();
    }});
    await process(processor,fixture);
    const result=await state(fixture),step=result.steps.find(row=>row.key==="enhance_image_1")!;
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_retry_exhausted"});
    expect(step).toMatchObject({status:"failed",attempt:3,errorCode:"agent_retry_exhausted",outputAssetId:null});
    expect(open<{responseProcessingAttempts:number;localRecovery:unknown[]}>(fixture.workKey,step.encryptedOutput!)).toMatchObject({responseProcessingAttempts:3,localRecovery:[
      {attempt:1,code:"agent_scan_unavailable"},{attempt:2,code:"agent_scan_unavailable"},{attempt:3,code:"agent_scan_unavailable"},
    ]});
    expect(responseScans).toBe(3);expect(generate).toHaveBeenCalledTimes(1);expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]!.state).toBe("committed");expect(Number(result.ledger[0]!.amountUsd)).toBe(0.17);
    expect((await new OrderDesignRepository(database,vault).view(fixture.context,fixture.lineId)).run?.canResume).toBe(false);
    await expect(command(fixture,"resume")).rejects.toMatchObject({code:"agent_resume_not_safe"});
    await process(processor,fixture);expect(generate).toHaveBeenCalledTimes(1);
  },30_000);

  it("distinguishes a received response whose private checkpoint write failed from unknown provider submission",async()=>{
    const fixture=await seed({paid:true}),bytes=await image();
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({bytes,actualCostUsd:0.14});
    const failingStorage={...storage,putPrivate:async(context:TenantContext,input:PutPrivateInput)=>{
      if(input.fileName.endsWith("-response-quarantine.pe"))throw new Error("Synthetic private raw write failed");
      return storage.putPrivate(context,input);
    }} as Storage;
    const processor=new OrderDesignProcessor(database,failingStorage,vault,{generate},scanner);
    await process(processor,fixture);
    const result=await state(fixture),step=result.steps.find(row=>row.key==="enhance_image_1")!;
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_model_response_uncheckpointed"});
    expect(step).toMatchObject({status:"uncertain",outputAssetId:null});
    const output=open<{submissionState:string;responseReceipt:unknown;responseCheckpoint?:unknown}>(fixture.workKey,step.encryptedOutput!);
    expect(output).toMatchObject({submissionState:"received",responseReceipt:{checksum:checksum(bytes),byteSize:bytes.length,actualCostUsd:0.14,quarantined:true}});
    expect(output.responseCheckpoint).toBeUndefined();expect(result.ledger).toHaveLength(1);expect(result.ledger[0]!.state).toBe("committed");
    await expect(command(fixture,"resume")).rejects.toMatchObject({code:"agent_resume_not_safe"});
    await process(processor,fixture);expect(generate).toHaveBeenCalledTimes(1);
  },30_000);

  it("keeps an infected paid response quarantined without retrying or exposing an image asset",async()=>{
    const fixture=await seed({paid:true});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValue({bytes:await image(),actualCostUsd:0.11});
    let infectedScans=0;
    const processor=new OrderDesignProcessor(database,storage,vault,{generate},{scan:async()=>{
      if(generate.mock.calls.length){infectedScans++;return {...await scanner.scan(),result:"infected" as const};}
      return scanner.scan();
    }});
    await process(processor,fixture);
    const result=await state(fixture),step=result.steps.find(row=>row.key==="enhance_image_1")!;
    expect(step).toMatchObject({status:"failed",attempt:1,errorCode:"agent_scan_rejected",outputAssetId:null});
    expect(result.assets).toHaveLength(fixture.snapshot.assets.length);
    expect(infectedScans).toBe(1);expect(generate).toHaveBeenCalledTimes(1);expect(result.ledger).toHaveLength(1);
    expect((await new OrderDesignRepository(database,vault).view(fixture.context,fixture.lineId)).run?.canResume).toBe(false);
    await expect(command(fixture,"resume")).rejects.toMatchObject({code:"agent_resume_not_safe"});
  },30_000);

  it("stops local upscale after three failed attempts and refuses a misleading resume without repeating paid calls",async()=>{
    const fixture=await seed({pillow:true,paid:true,pipeline:true});
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({bytes:await image(),actualCostUsd:0.1}).mockResolvedValueOnce({bytes:await pillowImage(512),actualCostUsd:0.1});
    const upscale=vi.fn<OrderDesignSuperResolutionGateway["upscale"]>().mockRejectedValue(new OrderDesignError("agent_upscale_timeout"));
    const processor=worker(generate,{validatePolicy:async()=>{},upscale});
    await process(processor,fixture);
    const result=await state(fixture),step=result.steps.find(row=>row.key==="ensure_resolution")!;
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_retry_exhausted"});
    expect(step).toMatchObject({status:"failed",attempt:3,errorCode:"agent_retry_exhausted"});
    expect(upscale).toHaveBeenCalledTimes(3);expect(generate).toHaveBeenCalledTimes(2);expect(result.ledger).toHaveLength(2);
    expect((await new OrderDesignRepository(database,vault).view(fixture.context,fixture.lineId)).run?.canResume).toBe(false);
    await expect(command(fixture,"resume")).rejects.toMatchObject({code:"agent_resume_not_safe"});
    await process(processor,fixture);expect(upscale).toHaveBeenCalledTimes(3);expect(generate).toHaveBeenCalledTimes(2);
  },30_000);

  it("retains a returned opaque cutout as a paid checkpoint without applying it or sending the model again",async()=>{
    const fixture=await seed({pillow:true,paid:true,pipeline:true});
    const returned=await sharp({create:{width:512,height:512,channels:3,background:"white"}}).png().toBuffer();
    const generate=vi.fn<OrderDesignImageGateway["generate"]>().mockResolvedValueOnce({bytes:await image(),actualCostUsd:0.1}).mockResolvedValueOnce({bytes:returned,actualCostUsd:0.1});
    const upscale=vi.fn<OrderDesignSuperResolutionGateway["upscale"]>();
    const processor=worker(generate,{validatePolicy:async()=>{},upscale});
    await process(processor,fixture);
    const result=await state(fixture),step=result.steps.find(row=>row.key==="cutout_subject")!;
    expect(result.run).toMatchObject({status:"needs_attention",errorCode:"agent_quality_failed"});
    expect(result.run.qualityDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:"agent_alpha_missing"})]));
    expect(step).toMatchObject({status:"completed",attempt:1,outputAssetId:expect.any(String)});
    expect(result.assets.find(row=>row.id===step.outputAssetId)?.checksum).toBe(checksum(returned));
    expect(result.document!.layers.some(layer=>layer.kind==="image" && layer.assetId===step.outputAssetId)).toBe(false);
    expect(open<Record<string,unknown>>(fixture.workKey,step.encryptedOutput!)).toMatchObject({providerReturnedImage:true,applied:false,responseCheckpoint:{checksum:checksum(returned)}});
    expect(generate).toHaveBeenCalledTimes(2);expect(upscale).not.toHaveBeenCalled();
    await process(processor,fixture);expect(generate).toHaveBeenCalledTimes(2);
  },30_000);

  async function pillowImage(size:number) {return sharp(Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><ellipse cx="${size/2}" cy="${size/2}" rx="${size*0.43}" ry="${size*0.44}" fill="#795630"/></svg>`)).png().toBuffer();}
  function worker(generate: OrderDesignImageGateway["generate"],upscale?:OrderDesignSuperResolutionGateway) { return new OrderDesignProcessor(database, storage, vault, { generate }, scanner,upscale); }
  function process(processor: OrderDesignProcessor, fixture: Fixture) { return processor.process({ tenantId: fixture.context.tenantId, requestedBy: fixture.context.userId, runId: fixture.runId }); }
  async function command(fixture: Fixture, action: "resume" | "takeover") {
    const repository = new OrderDesignRepository(database, vault);
    const view = await repository.view(fixture.context, fixture.lineId);
    return repository.command(fixture.context, fixture.lineId, action, { runId: fixture.runId, expectedRevision: view.run!.revision, idempotencyKey: randomUUID() });
  }
  async function restoreInput(fixture: Fixture, bytes: Buffer): Promise<OrderDesignRestoreResponse> {
    const run = (await new OrderDesignRepository(database, vault).view(fixture.context, fixture.lineId)).run!;
    const target = run.responseRecoveryTarget!;
    expect(target).toBeTruthy();
    return { runId: run.id, expectedRevision: run.revision, idempotencyKey: randomUUID(), stepId: target.stepId, requestId: target.requestId,
      contentBase64: bytes.toString("base64"), providerReference: "synthetic-provider-record-001",
      verificationNote: "Synthetic operator verified original request, reference image and returned bytes", verifiedOriginalResult: true };
  }
  function qualityReport(result: Awaited<ReturnType<typeof state>>, fixture: Fixture) {
    const step = result.steps.find(step => step.key === "preflight")!;
    return open<{ quality: DesignQualityReport }>(fixture.workKey, step.encryptedOutput!).quality;
  }
  async function state(fixture: Fixture) {
    return withTenant(database.db, fixture.context, async tx => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, fixture.runId));
      const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, fixture.lineId));
      const stepRows = await tx.select().from(steps).where(eq(steps.runId, fixture.runId)).orderBy(steps.position);
      const project = run!.projectId ? (await tx.select().from(projects).where(eq(projects.id, run!.projectId)))[0] ?? null : null;
      const versionRows = project ? await tx.select().from(versions).where(eq(versions.projectId, project.id)).orderBy(versions.versionNumber) : [];
      const assetRows = project ? await tx.select().from(images).where(eq(images.projectId, project.id)).orderBy(images.id) : [];
      const renderRows = project ? await tx.select().from(renders).where(eq(renders.projectId, project.id)).orderBy(renders.id) : [];
      const ledger = stepRows.length ? await tx.select().from(aiBudgetLedger).where(inArray(aiBudgetLedger.requestId, stepRows.map(step => step.requestId))).orderBy(aiBudgetLedger.id) : [];
      const current = versionRows.find(version => version.id === project?.currentVersionId);
      const document = project?.encryptedDataKey && current ? vault.withSecret(project.encryptedDataKey, value => {
        const key = Buffer.from(value, "base64"); try { return open<ProductionEditorDocument>(key, current.encryptedDocument); } finally { key.fill(0); }
      }) : null;
      return { run: run!, work: work!, steps: stepRows, project, versions: versionRows, assets: assetRows, renders: renderRows, ledger, document };
    });
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function seed(options: { paid?: boolean; imageCount?: number; monthlyBudget?: number; pillow?: boolean; pipeline?:boolean; contourGraph?:boolean; cropScope?:string; missingRoute?: boolean; rules?: "manual" | "baseline"; legacy?:boolean; beforeRegister?:(context:TenantContext)=>Promise<void> } = {}) {
    const tenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: [...executionPermissions,...(options.beforeRegister||options.legacy?[Permission.WorkflowRead,Permission.WorkflowManage,Permission.WorkflowApprove]:[])], dataScope: "tenant" };
    const lineId = createEntityId(), workRevisionId = createEntityId(), orderId = createEntityId(), sourceSnapshotId = createEntityId();
    const templateProjectId = createEntityId(), templateVersionId = createEntityId(), routeId = createEntityId(), providerId = createEntityId();
    const workKey = randomBytes(32); workKeys.push(workKey);
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic design agent',$2)", [tenantId, `design-agent-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic designer')", [userId, `design-agent-${userId}`, `${userId}@example.test`]);
    const usesModel = options.paid || options.pillow;
    const recipe: DesignAutomationRecipe = usesModel ? { ...preserve, workflow: options.pillow ? "pillow_photo" : "template", imagePolicy: options.paid ? "faithful_enhancement" : "preserve", modelRouteId: options.missingRoute ? null : routeId, allowOrderImageTransfer: true, modelCallLimit: 4, estimatedCostPerCallUsd: 0.1, maxEstimatedCostUsd: 0.4 } : { ...preserve };
    if(options.pipeline)recipe.pillowPipeline=createPillowPipeline({...PILLOW_REALESRGAN_POLICY});
    if(options.contourGraph && recipe.pillowPipeline)recipe.pillowPipeline.contour.workflow=PILLOW_CONTOUR_GRAPH_VERSION;
    const imageCount = options.imageCount ?? 1;
    const originals = await Promise.all(Array.from({ length: imageCount }, async (_, index) => ({ id: createEntityId(), pinId: createEntityId(), usage: options.pillow ? "buyer_photo" : `photo_${index + 1}`, bytes: await image() })));
    const customization = CustomizationSchema.parse({ version: 1, fields: options.pillow ? [
      { key: "buyer_photo", label: "Buyer photo", type: "image", required: true, validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } },
      { key: "crop_scope", label: "Crop scope", type: "short_text", required: true },
      { key: "print_sides", label: "Print sides", type: "single_choice", required: true, options: [{ label: "Single sided", value: "single_sided" }, { label: "Double sided", value: "double_sided" }] },
      { key: "customer_notes", label: "Special instructions", type: "long_text", required: false },
    ] : [
      { key: "name", label: "Buyer name", type: "short_text", required: true },
      ...originals.map(original => ({ key: original.usage, label: original.usage, type: "image", required: true, validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } })),
    ] });
    const layout = ArtworkLayoutSchema.parse(options.pillow ? [] : [
      { fieldKey: "name", xPercent: 10, yPercent: 80, widthPercent: 80, heightPercent: 15 },
      ...originals.map((original, index) => ({ fieldKey: original.usage, xPercent: 10 + index * (80 / imageCount), yPercent: 10, widthPercent: 80 / imageCount, heightPercent: 60 })),
    ]);
    // Imported label matching is valid; this deliberately differs from the field key.
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: null, fields: options.pillow ? [
      { key: "crop_scope", label: "Crop scope", kind: "text", value: options.cropScope ?? "head" },
      { key: "print_sides", label: "Print sides", kind: "choice", value: "double_sided" },
    ] : [{ key: "marketplace_name", label: "Buyer name", kind: "text", value: "  Mira  " }],
      images: originals.map(original => ({ origin: "upload", key: original.id, usage: original.usage })), instructions: "", customerApprovalRequired: false, dueAt: null, designExecutor: "agent" });
    let document: ProductionEditorDocument = { schemaVersion: 1, name: "Synthetic approved template", productType: "rectangular_print", automation: recipe,
      spec: { widthMm: 40, heightMm: 40, dpi: 150, safeInsetMm: 2 }, contour: [], layers: [],
      confirmations: { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true } };
    if (options.pillow) document = { ...document, productType: "shaped_pillow", exportBackground: "white",
      spec: { widthMm: 110, heightMm: 110, dpi: 150, sideMode: "single", declaredLongestMm: 100, sizeBasis: "artwork", whiteBorderMm: 5,
        cutLineMm: 1.016, minimumNeckMm: 50, minimumNeckBasis: "cut_contour", panelGapMm: 10, barcodeTab: { widthMm: 20, heightMm: 10, centerXMm: 55 } },
      contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 110, yMm: 0, smooth: false }, { xMm: 110, yMm: 110, smooth: false }, { xMm: 0, yMm: 110, smooth: false }] };
    if(options.pipeline && document.productType==="shaped_pillow")document.spec={...document.spec,factoryStandardId:"ps-pillow-2026-09-17",declaredLongestMm:254,whiteBorderMm:200*25.4/150,panelGapMm:100*25.4/150,sheetMarginMm:50*25.4/150,barcodeTab:{widthMm:600*25.4/150,heightMm:200*25.4/150,centerXMm:55}};
    const assets = originals.map(original => ({ key: original.pinId, origin: "work" as const, kind: "image" as const, assetId: original.id,
      name: "Synthetic buyer original", usage: original.usage, checksum: checksum(original.bytes), buyerOriginal: true }));
    const plan = buildDesignAutomationPlan({ recipe, imageIds: assets.map(asset => asset.key), ...(options.pillow ? { pillowSubject: orderPillowPhotoPlan("shaped_pillow",customization,layout,draft)!.subject } : {}),...(options.pipeline?{configuredModel:"gpt-image-2.5",pillowRuntime:{...PILLOW_REALESRGAN_POLICY}}:{}) });
    const snapshot: OrderDesignSnapshot = { schemaVersion: 1, workItemId: lineId, workRevisionId, sourceVersionId: null,
      templateProjectId, templateVersionId, templateChecksum: jsonChecksum(document), document, assets, templateAssetKeys: {}, masterAssetKey: null,
      layout, customization, draft, photoOnlyPillow: options.pillow ?? false, recipe, plan,
      model: usesModel && !options.missingRoute ? { routeId, providerConfigId: providerId, model: options.pipeline?"gpt-image-2.5":"synthetic-image", endpoint: "https://synthetic.invalid/v1" } : null };
    if (options.rules) {
      const admin = { ...context, permissions: Object.values(Permission) }, center = new RuleCenterService(database, new AuditService(database));
      if (options.rules === "baseline") await center.initialize(admin);
      else {
        const rule = await center.save(admin, null, { fields: { name: "Synthetic pinned manual rule", category: "acceptance", instructions: "Original rule at dispatch", source: "Synthetic fixture", appliesTo: "order_design", scopeKind: "all", productType: null, spuId: null }, expectedRevision: 0, changeReason: "Synthetic create", idempotencyKey: randomUUID() });
        await center.changeState(admin, rule.id, "publish", { expectedRevision: 1, version: 1, changeReason: "Synthetic publish" });
      }
      snapshot.ruleSnapshot = await withTenant(database.db, context, tx => resolveOrderRules(tx, document.productType, null));
    }
    await withTenant(database.db, context, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic design executor", permissions: [...context.permissions], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId, platform: "amazon", displayName: "Synthetic design fixture", region: "NA", authorizationMode: "amazon_private", createdBy: userId });
      await tx.insert(orderSourceSnapshots).values({ id: sourceSnapshotId, tenantId, accountId, platform: "amazon", externalEventId: randomUUID(), externalOrderId: `SYNTHETIC-${orderId}`, normalizedOrderId: orderId, redactedPayload: { synthetic: true }, payloadChecksum: "a".repeat(64) });
      await tx.insert(orders).values({ id: orderId, tenantId, accountId, sourceSnapshotId, platform: "amazon", externalOrderId: `SYNTHETIC-${orderId}`, providerStatus: "paid", workflowState: "awaiting_shipment", orderTotalMinor: 2000, orderCurrency: "USD", lineCount: 1, addressStatus: "protected", addressCountryCode: "US", latestEventSequence: 1, placedAt: new Date() });
      await tx.insert(orderLines).values({ id: lineId, tenantId, orderId, externalLineId: `LINE-${lineId}`, title: "Synthetic design item", quantity: 1, unitPriceMinor: 2000, unitPriceCurrency: "USD" });
      await tx.insert(orderWorkItems).values({ id: lineId, tenantId, encryptedDataKey: vault.encrypt(workKey.toString("base64")), revision: 1, preparation: "pushed", artwork: "queued", expiresAt: new Date(Date.now() + 86_400_000) });
      await tx.insert(orderWorkRevisions).values({ id: workRevisionId, tenantId, workItemId: lineId, revision: 1, encryptedDraft: seal(workKey, draft), checksum: jsonChecksum(draft), createdBy: userId });
      await tx.update(orderWorkItems).set({ pushedRevisionId: workRevisionId }).where(eq(orderWorkItems.id, lineId));
      await tx.insert(projects).values({ id: templateProjectId, tenantId, name: "Synthetic approved template", encryptedDataKey: vault.encrypt(workKey.toString("base64")), createdBy: userId });
      await tx.insert(versions).values({ id: templateVersionId, tenantId, projectId: templateProjectId, versionNumber: 1, encryptedDocument: seal(workKey, document), checksum: jsonChecksum(document), createdBy: userId });
      await tx.update(projects).set({ currentVersionId: templateVersionId, reviewedVersionId: templateVersionId, reviewedBy: userId, reviewedAt: new Date() }).where(eq(projects.id, templateProjectId));
      for (const original of originals) {
        const blob = await storage.putPrivate(context, { body: encryptProductionBytes(workKey, original.bytes), domain: "order", fileName: `${original.id}-source.pe`, mediaType: "application/octet-stream" });
        await tx.insert(orderWorkAssets).values({ id: original.id, tenantId, workItemId: lineId, objectKey: blob.objectKey, previewObjectKey: blob.objectKey, checksum: checksum(original.bytes), encryptedMetadata: seal(workKey, { name: "Synthetic buyer original", kind: "image", mediaType: "image/png", width: 512, height: 512 }) });
      }
      if (usesModel) {
        await tx.insert(modelProviderConfigs).values({ id: providerId, tenantId, provider: "openai-compatible", label: "Synthetic provider", endpoint: "https://synthetic.invalid/v1", encryptedApiKey: vault.encrypt("synthetic-never-used"), createdBy: userId });
        await tx.insert(modelRoutes).values({ id: routeId, tenantId, taskType: "studio_image", modelKey: "Synthetic image", targets: [{ providerConfigId: providerId, providerModel: "synthetic-image", timeoutMs: 1000 }] });
      }
      if (options.monthlyBudget !== undefined) await tx.insert(aiBudgetPolicies).values({ tenantId, monthlyCapUsd: String(options.monthlyBudget), defaultTaskCapUsd: "1" });
    });
    await options.beforeRegister?.(context);
    const runId=await withTenant(database.db,context,async tx=>{
      if(options.legacy){
        // Exact former input checksum and absent method metadata, created as a historical fixture.
        if(options.paid||options.pillow)throw new Error("Legacy fixture is the original preserve template");
        const id=createEntityId();await tx.insert(orderDesignDispatchTenants).values({tenantId}).onConflictDoNothing();
        await tx.insert(runs).values({id,tenantId,workItemId:lineId,workRevisionId,executorKey:"strict-template",recipeVersion:"1",policyVersion:"order-design-v1",encryptedSnapshot:seal(workKey,snapshot),inputChecksum:jsonChecksum(snapshot),requestedBy:userId,actualCostUsd:"0",costStatus:"not_required"});
        for(const [position,input] of DesignAutomationPlanSchema.parse(snapshot.plan).steps.entries())await tx.insert(steps).values({id:createEntityId(),tenantId,runId:id,key:input.id,label:input.tool,position,requestId:createEntityId(),encryptedInput:seal(workKey,input),inputChecksum:jsonChecksum(input)});
        await tx.insert(outbox).values({id:createEntityId(),tenantId,runId:id,requestedBy:userId});return id;
      }
      const id=await registerOrderDesignRun(tx,context,snapshot,workKey);expect(await registerOrderDesignRun(tx,context,snapshot,workKey)).toBe(id);return id;
    });
    return { context, lineId, orderId, runId, membershipId, roleId, snapshot, workKey };
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic execution did not reach its checkpoint")), 15_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
