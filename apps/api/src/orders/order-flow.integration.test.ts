import {randomUUID} from "node:crypto";
import {SecretVault} from "@yummyai/ai-core";
import {Permission} from "@yummyai/authz";
import {createEntityId,type TenantContext} from "@yummyai/contracts";
import {FactoryDocumentProfileSchema,type DocumentOrderSource} from "@yummyai/contracts/logistics/documents";
import {ReleaseWholeOrderInputSchema} from "@yummyai/contracts/order/whole-fulfillment";
import type {OrderDocumentSourceReader} from "@yummyai/order-core";
import {connectDatabase,withTenant,fulfillmentRoutes,fulfillmentRouteVersions,orderFulfillmentFlows as flows,orderWorkItems,marketplaceAccounts,memberships} from "@yummyai/database";
import {eq} from "drizzle-orm";
import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {OrderService} from "./order.service.js";
import {AuditService} from "../audit/audit.service.js";
import {OrderFlowService} from "./order-flow.service.js";
import {scheduleOrderFlow} from "./order-flow-intent.js";
import type {FulfillmentRoutesService} from "./fulfillment-routes.service.js";
import type {OrderProductionService} from "./order-production.service.js";
import type {FactoryCapacityService} from "../suppliers/factory-capacity.service.js";
import type {LogisticsService} from "../logistics/logistics.service.js";
import type {OrderProductionDeliveryService} from "./order-production-delivery.service.js";
import type {LogisticsDocumentsService} from "../logistics/logistics-documents.service.js";
import type {OrderShipmentService} from "./order-shipment.service.js";
import type {OrderWorkspaceService} from "./order-workspace.service.js";
import {ServiceUnavailableException} from "@nestjs/common";

if(process.env.E2E_ISOLATED_DAILY!=="1"||!/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
  throw new Error("Use disposable logistics-integration acceptance");

describe.sequential("durable automatic fulfillment coordination",()=>{
  const database=connectDatabase(),vault=new SecretVault(Buffer.alloc(32,53));
  const context:TenantContext={tenantId:createEntityId(),userId:createEntityId(),permissions:Object.values(Permission),dataScope:"tenant"};
  const other={...context,tenantId:createEntityId()},member=createEntityId(),role=createEntityId(),accountId=createEntityId();
  const orders=new OrderService(database,vault,new AuditService(database));
  beforeAll(async()=>{
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic flow',$2),($3,'Synthetic isolation',$4)",[context.tenantId,`flow-${context.tenantId}`,other.tenantId,`flow-${other.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic operator')",[context.userId,`flow-${context.userId}`,`${context.userId}@example.invalid`]);
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",[member,context.tenantId,context.userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,'Synthetic flow',$3::jsonb,'tenant')",[role,context.tenantId,JSON.stringify(context.permissions)]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",[context.tenantId,member,role]);
    await withTenant(database.db,context,tx=>tx.insert(marketplaceAccounts).values({id:accountId,tenantId:context.tenantId,platform:"amazon",displayName:"Synthetic flow",region:"NA",authorizationMode:"amazon_private",createdBy:context.userId}));
  });
  afterAll(async()=>{await database.client.end();});

  async function fixture(approved=true,destination:"US"|"CA"="US"){
    const key=randomUUID(),order=await orders.ingestNormalized(context,{accountId,platform:"amazon",externalEventId:key,externalOrderId:key,providerStatus:"paid",placedAt:new Date().toISOString(),orderTotal:{amountMinor:1000,currency:"USD"},lines:[{externalLineId:"one",externalListingId:"SYNTHETIC",skuCode:"PILLOW",title:"Synthetic pillow",quantity:1,unitPrice:{amountMinor:1000,currency:"USD"},customizationCount:0}],redactedSource:{synthetic:true},protectedDetails:null});
    const lineId=order.lines[0]!.id,versionId=createEntityId(),specId=createEntityId(),factoryId=createEntityId();
    const profile={id:createEntityId(),factoryId,factoryVersionId:createEntityId(),version:1,profile:FactoryDocumentProfileSchema.parse({name:"Synthetic parcel",route:"printeque",productionAdapter:"printeque_factory",originCountryCode:"US",destinationCountries:["US"],originCompany:"Synthetic",factoryCode:"TEST",carrierProvider:"ShipOS",carrierService:"",useAccountSender:false,evidence:"Synthetic measured parcel",specifications:[{specificationVersionId:specId,productKind:"shaped_pillow",sizeIn:12,supplierSku:"CP-12",weight:0.31,weightUnit:"lb",length:10,width:5,height:5,dimensionUnit:"in",declaredUnitValueMinor:800,nameEn:"Custom pillow",nameCn:"抱枕",hsCode:""}]})};
    const route={id:createEntityId(),version:1,profile:{name:"Synthetic route",mode:"quote" as const,documentProfileVersionId:profile.id,connectionId:createEntityId(),productionDays:2,autoWriteback:false},factoryId,factoryName:"Synthetic",supplierName:"Synthetic",products:["Synthetic pillow"],countries:["US"],connectionName:"Synthetic",blockers:[] as string[]};
    const source:DocumentOrderSource={id:order.id,orderNumber:key,address:{recipient:"Synthetic Buyer",countryCode:"US",address1:"1 Test Street",address2:"",city:"Example",region:"CA",postalCode:"90640",phone:"1234567890",email:""},lines:[{id:lineId,externalLineId:"one",quantity:1,skuCode:"PILLOW",specificationVersionId:specId,specificationName:"12in"}]};
    if (destination==="CA") {
      profile.profile={...profile.profile,route:"yunexpress",productionAdapter:"yicai_folder",originCountryCode:"CN",destinationCountries:["CA"],carrierProvider:"YunExpress"};
      source.address.countryCode="CA";route.countries=["CA"];
    }
    await withTenant(database.db,context,async tx=>{
      await tx.insert(fulfillmentRoutes).values({id:route.id,tenantId:context.tenantId,version:1,profile:route.profile,requestKey:randomUUID(),requestHash:"a".repeat(64),createdBy:context.userId});
      await tx.insert(orderWorkItems).values({id:lineId,tenantId:context.tenantId,preparation:"pushed",artwork:approved?"approved":"in_review",approvedEditorVersionId:approved?versionId:null,encryptedDataKey:vault.encrypt(Buffer.alloc(32).toString("base64")),expiresAt:new Date(Date.now()+86400000)});
      await scheduleOrderFlow(tx,context,order.id);
      await tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.orderId,order.id));
    });
    const [flow]=await withTenant(database.db,context,tx=>tx.select().from(flows).where(eq(flows.orderId,order.id)));
    const production={wholeOrderFulfillment:vi.fn().mockResolvedValue({items:[{lineId,operationBlockers:[],productionBlockers:[],renderId:null,renderFailure:null,production:null}],factories:[],factoryDiagnostics:[]}),releaseWholeOrderReceipt:vi.fn(),manufacturingOptions:vi.fn()};
    const capacity={workspace:vi.fn()};
    const logistics={get:vi.fn(),dispatch:vi.fn(),createTask:vi.fn(),requestHandoverRead:vi.fn()};
    const delivery={get:vi.fn()}, shipments={get:vi.fn(),recordTrackingEvent:vi.fn(),requestWriteback:vi.fn()};
    const connection=destination==="CA"?{provider:"yunexpress",yunexpressProtocol:"openapi",originCountryCode:"CN"}:{provider:"shipos",originCountryCode:"US"};
    const routes={workspace:vi.fn().mockResolvedValue({view:{routes:[route],canConfigure:true},documents:{profiles:[profile]},connections:[{id:route.profile.connectionId,profile:connection}]})};
    const work={action:vi.fn()};
    const service=new OrderFlowService(database,vault,routes as unknown as FulfillmentRoutesService,production as unknown as OrderProductionService,capacity as unknown as FactoryCapacityService,logistics as unknown as LogisticsService,delivery as unknown as OrderProductionDeliveryService,{} as LogisticsDocumentsService,shipments as unknown as OrderShipmentService,work as unknown as OrderWorkspaceService);
    // Provider and domain-owner behavior is covered in their own integration suites.
    // This suite keeps real RLS, authority, leases, approval intents and command journals.
    vi.spyOn((service as unknown as {source:OrderDocumentSourceReader}).source,"read").mockResolvedValue({source,blockers:[],orderSequence:order.latestEventSequence,fingerprint:"a".repeat(64),expiresAt:new Date(Date.now()+86400000),production:[]});
    const read=async()=> (await withTenant(database.db,context,tx=>tx.select().from(flows).where(eq(flows.id,flow!.id))))[0]!;
    return {service,flow:flow!,read,production,capacity,logistics,delivery,shipments,route,routes,lineId,order,versionId,profile,work};
  }

  it("deduplicates approval intents, rolls back with approval, and isolates tenants",async()=>{
    const s=await fixture(false);
    await withTenant(database.db,context,async tx=>{await scheduleOrderFlow(tx,context,s.order.id);await scheduleOrderFlow(tx,context,s.order.id);});
    expect(await withTenant(database.db,context,tx=>tx.select().from(flows).where(eq(flows.orderId,s.order.id)))).toHaveLength(1);
    expect(await withTenant(database.db,other,tx=>tx.select().from(flows).where(eq(flows.id,s.flow.id)))).toEqual([]);
    await expect(withTenant(database.db,context,async tx=>{await tx.update(flows).set({stage:"completed"}).where(eq(flows.id,s.flow.id));throw new Error("synthetic rollback");})).rejects.toThrow();
    expect((await s.read()).stage).toBe("waiting_artwork");
    await s.service.advance(context,s.flow.id);
    expect((await s.read()).stage).toBe("waiting_artwork");expect(s.production.wholeOrderFulfillment).not.toHaveBeenCalled();
    const history={id:createEntityId(),tenantId:context.tenantId,routeId:s.route.id,version:1,profile:s.route.profile,requestKey:randomUUID(),requestHash:"a".repeat(64),createdBy:context.userId};
    await withTenant(database.db,context,tx=>tx.insert(fulfillmentRouteVersions).values(history));
    await expect(withTenant(database.db,context,tx=>tx.update(fulfillmentRouteVersions).set({version:2}).where(eq(fulfillmentRouteVersions.id,history.id)))).rejects.toThrow();
  });
  it("waits for current formal files and exposes failed rendering as an exception",async()=>{
    const s=await fixture();await s.service.advance(context,s.flow.id);
    expect((await s.read()).stage).toBe("waiting_render");
    s.production.wholeOrderFulfillment.mockResolvedValue({items:[{lineId:s.lineId,operationBlockers:[],productionBlockers:[],renderId:null,renderFailure:"Synthetic render failed",production:null}],factories:[],factoryDiagnostics:[]});
    await withTenant(database.db,context,tx=>tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id)));
    await s.service.advance(context,s.flow.id);
    expect(await s.read()).toMatchObject({stage:"exception",reasons:["Synthetic render failed"]});
    expect(s.logistics.createTask).not.toHaveBeenCalled();
  });
  it("recovers a persisted owner command once even with two coordinators",async()=>{
    const s=await fixture(),productionId=createEntityId();
    const input=ReleaseWholeOrderInputSchema.parse({supplierId:createEntityId(),factoryId:s.profile.factoryId,factoryVersionId:s.profile.factoryVersionId,items:[{lineId:s.lineId,quantity:1,expectedRevision:0,expectedProjectionVersion:1,renderId:createEntityId(),capabilityVersionId:createEntityId()}],expectedCompletionAt:new Date(Date.now()+86400000).toISOString(),idempotencyKey:randomUUID()});
    await withTenant(database.db,context,tx=>tx.update(flows).set({pendingCommand:{kind:"production",input},routeId:s.route.id,routeVersion:1,routeSnapshot:s.route.profile}).where(eq(flows.id,s.flow.id)));
    s.production.releaseWholeOrderReceipt.mockImplementation(async()=>{await new Promise(resolve=>setTimeout(resolve,70));return {productionOrderIds:[productionId]};});
    await Promise.all([s.service.advance(context,s.flow.id),s.service.advance(context,s.flow.id)]);
    expect(s.production.releaseWholeOrderReceipt).toHaveBeenCalledTimes(1);
    expect(await s.read()).toMatchObject({stage:"logistics",productionOrderIds:[productionId],pendingCommand:null,leaseToken:null});
  });
  it("starts the factory window after artwork readiness and keeps the original booking after a lost receipt",async()=>{
    const s=await fixture(),capabilityVersionId=createEntityId(),poolId=createEntityId(),poolVersionId=createEntityId(),productionId=createEntityId();
    const start=new Date(Date.now()+3600000),end=new Date(Date.now()+4*3600000),localDate=start.toISOString().slice(0,10);
    await withTenant(database.db,context,tx=>tx.update(flows).set({createdAt:new Date(Date.now()-7*86400000)}).where(eq(flows.id,s.flow.id)));
    s.production.wholeOrderFulfillment.mockResolvedValue({items:[{lineId:s.lineId,quantity:1,expectedRevision:0,expectedProjectionVersion:1,operationBlockers:[],productionBlockers:[],renderId:createEntityId(),renderFailure:null,production:null}],factories:[{factoryId:s.profile.factoryId,factoryVersionId:s.profile.factoryVersionId,supplierId:createEntityId(),items:[{lineId:s.lineId,capabilityVersionId}]}],factoryDiagnostics:[]});
    s.production.manufacturingOptions.mockResolvedValue({source:{packageQuantity:1},items:[{versionId:createEntityId(),outputQuantity:1,outputUnit:"each"}],nextCursor:null,diagnostics:[]});
    s.capacity.workspace.mockResolvedValue({pools:[{id:poolId,versionId:poolVersionId,profile:{status:"active",bindings:[{capabilityVersionId,unitsPerItem:1}]}}],calendar:[{poolId,poolVersionId,localDate,blockers:[],availableUnits:1,intervals:[{start:start.toISOString(),end:end.toISOString()}]}]});
    s.production.releaseWholeOrderReceipt.mockRejectedValueOnce(new ServiceUnavailableException("Synthetic receipt lost"))
      .mockResolvedValueOnce({productionOrderIds:[productionId]});
    await s.service.advance(context,s.flow.id);
    const retained=(await s.read()).pendingCommand;
    expect(retained).toMatchObject({kind:"production",input:{expectedCompletionAt:end.toISOString(),items:[{capacityPlan:{allocations:[{poolId,poolVersionId,localDate}]}}]}});
    await withTenant(database.db,context,tx=>tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id)));
    await s.service.advance(context,s.flow.id);
    expect(s.capacity.workspace).toHaveBeenCalledTimes(1);
    expect(s.production.releaseWholeOrderReceipt.mock.calls[1]).toEqual(s.production.releaseWholeOrderReceipt.mock.calls[0]);
    expect(await s.read()).toMatchObject({stage:"logistics",productionOrderIds:[productionId],pendingCommand:null});
  });
  it("assigns a reviewed finished-goods recipe to its factory for a fixed 48 hours without a calendar or a receipt",async()=>{
    const s=await fixture(), recipeId=createEntityId(), productionId=createEntityId(), capabilityVersionId=createEntityId();
    s.route.profile.productionDays=2;
    s.production.wholeOrderFulfillment.mockResolvedValue({items:[{lineId:s.lineId,quantity:1,expectedRevision:0,expectedProjectionVersion:1,operationBlockers:[],productionBlockers:[],renderId:createEntityId(),production:null}],factories:[{factoryId:s.profile.factoryId,factoryVersionId:s.profile.factoryVersionId,supplierId:createEntityId(),items:[{lineId:s.lineId,capabilityVersionId}]}]});
    s.production.manufacturingOptions.mockResolvedValue({source:{packageQuantity:1},items:[
      {versionId:createEntityId(),outputQuantity:1,outputUnit:"each"},
      {versionId:recipeId,outputQuantity:1,outputUnit:"each",outsourcedFactoryId:s.profile.factoryId}],nextCursor:null,diagnostics:[]});
    s.production.releaseWholeOrderReceipt.mockRejectedValueOnce(new ServiceUnavailableException("Synthetic receipt lost")).mockResolvedValue({productionOrderIds:[productionId]});
    const earliest=Date.now()+48*3600_000;
    await s.service.advance(context,s.flow.id);
    const pending=(await s.read())?.pendingCommand;
    const input=ReleaseWholeOrderInputSchema.parse(pending?.input);
    expect(input.items[0]?.manufacturing?.versionId).toBe(recipeId);
    expect(input.items[0]?.capacityPlan).toBeUndefined();
    expect(Date.parse(input.expectedCompletionAt)).toBeGreaterThanOrEqual(earliest);
    expect(Date.parse(input.expectedCompletionAt)).toBeLessThanOrEqual(Date.now()+48*3600_000);
    await withTenant(database.db,context,tx=>tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id)));
    await s.service.advance(context,s.flow.id);
    expect(s.capacity.workspace).not.toHaveBeenCalled();
    expect(s.production.releaseWholeOrderReceipt.mock.calls[1]).toEqual(s.production.releaseWholeOrderReceipt.mock.calls[0]);
    expect(await s.read()).toMatchObject({stage:"logistics",productionOrderIds:[productionId],deliveryPackageIds:[]});
  });
  it("shows the Printeque whole-order outbound receipt without inventing inspection, quantities or carrier pickup",async()=>{
    const s=await fixture(),productionId=createEntityId(),taskId=createEntityId(),packetId=createEntityId();
    await withTenant(database.db,context,tx=>tx.update(flows).set({productionOrderIds:[productionId],logisticsTaskId:taskId,
      deliveryPackageIds:[packetId],productionExportId:createEntityId()}).where(eq(flows.id,s.flow.id)));
    s.production.wholeOrderFulfillment.mockResolvedValue({items:[{lineId:s.lineId,quantity:1,shippedQuantity:0,operationBlockers:[],production:{id:productionId}}],shipmentIds:[]});
    s.logistics.get.mockResolvedValue({id:taskId,status:"completed",trackingNumbers:["SYN-TRACK"]});
    const observed={bindingId:createEntityId(),status:"shipped",trackingReference:"SYN-TRACK",shippedQuantity:null};
    s.delivery.get.mockResolvedValue({items:[{status:"submitted",factoryErp:observed}]});
    await s.service.advance(context,s.flow.id);
    expect(await s.read()).toMatchObject({stage:"waiting_dispatch",reasons:[expect.stringContaining("整单出库")]});
    expect(s.shipments.recordTrackingEvent).not.toHaveBeenCalled();expect(s.shipments.requestWriteback).not.toHaveBeenCalled();
    await withTenant(database.db,context,tx=>tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id)));
    s.delivery.get.mockResolvedValue({items:[{status:"submitted",factoryErp:{...observed,trackingReference:"DIFFERENT"}}]});
    await s.service.advance(context,s.flow.id);
    expect(await s.read()).toMatchObject({stage:"exception",reasons:[expect.stringContaining("运单与本单面单不一致")]});
  });
  it("tracks a Canadian parcel without a factory manifest and only links a physical scan to its approved package",async()=>{
    const s=await fixture(true,"CA"), productionId=createEntityId(), productionVersionId=createEntityId(),taskId=createEntityId(), packageId=createEntityId(),shipmentId=createEntityId(), versionId=createEntityId();
    const waybill="YT-SYNTHETIC", now=new Date().toISOString(), proof={node:"FIRST_MILE_ARRIVE",occurredAt:now};
    await withTenant(database.db,context,tx=>tx.update(flows).set({productionOrderIds:[productionId],logisticsTaskId:taskId,deliveryPackageIds:[createEntityId()]}).where(eq(flows.id,s.flow.id)));
    const items=[{lineId:s.lineId,quantity:1,shippedQuantity:0,operationBlockers:[],production:{id:productionId}}];
    s.production.wholeOrderFulfillment.mockResolvedValue({items,shipmentIds:[]});
    s.delivery.get.mockResolvedValue({items:[{status:"submitted",productionOrderId:productionId,snapshot:{productionVersionId,orderLineId:s.lineId}}]});
    const step=async(status:string) => {
      s.logistics.get.mockResolvedValue({id:taskId,status:"completed",carrierWaybill:waybill,trackingNumbers:[],
        carrierObservation:{status,verifiedAt:now,checkedAt:now,proof:status==="F"?null:proof,diagnostic:null}});
      await withTenant(database.db,context,tx=>tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id)));
      await s.service.advance(context,s.flow.id);
      return s.read();
    };
    expect(await step("F")).toMatchObject({stage:"waiting_dispatch",reasons:[expect.stringContaining("待云途收货")]});
    expect(await step("T")).toMatchObject({stage:"waiting_dispatch",reasons:expect.arrayContaining([expect.stringContaining("订单应发 1 件")])});
    expect(s.shipments.recordTrackingEvent).not.toHaveBeenCalled();
    s.production.wholeOrderFulfillment.mockResolvedValue({items,shipmentIds:[shipmentId]});
    s.shipments.get.mockResolvedValue({shipment:{id:shipmentId,status:"approved",currentVersionNumber:1,approvedVersionNumber:1},
      versions:[{id:versionId,versionNumber:1,shipFromCountryCode:"CN"}],packages:[{id:packageId,shipmentVersionId:versionId,trackingNumber:waybill}],
      packageLines:[{packageId,orderLineId:s.lineId,quantity:1}],productionAllocations:[{packageId,productionOrderId:productionId,productionVersionId,orderLineId:s.lineId}],tracking:[]});
    expect(await step("T")).toMatchObject({stage:"waiting_dispatch",reasons:[expect.stringContaining("已登记云途实物轨迹")]});
    expect(s.shipments.recordTrackingEvent).toHaveBeenCalledWith(expect.objectContaining({tenantId:context.tenantId,userId:context.userId}),shipmentId,expect.objectContaining({packageId,status:"in_transit",occurredAt:now}));
    expect(await step("R")).toMatchObject({stage:"exception",reasons:[expect.stringContaining("退回")]});
    expect(s.shipments.recordTrackingEvent).toHaveBeenCalledTimes(1);expect(s.shipments.requestWriteback).not.toHaveBeenCalled();
  });
  it("waits through AI and human revisions and only continues after the replacement version is approved",async()=>{
    const s=await fixture(false);
    for(const artwork of ["changes_requested","in_progress","in_review"] as const){
      await withTenant(database.db,context,async tx=>{
        await tx.update(orderWorkItems).set({artwork,approvedEditorVersionId:null}).where(eq(orderWorkItems.id,s.lineId));
        await tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id));
      });
      await s.service.advance(context,s.flow.id);
      expect((await s.read()).stage).toBe("waiting_artwork");
    }
    expect(s.production.wholeOrderFulfillment).not.toHaveBeenCalled();expect(s.logistics.createTask).not.toHaveBeenCalled();
    await withTenant(database.db,context,async tx=>{
      await tx.update(orderWorkItems).set({artwork:"approved",approvedEditorVersionId:createEntityId()}).where(eq(orderWorkItems.id,s.lineId));
      await scheduleOrderFlow(tx,context,s.order.id);
      await tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id));
    });
    await s.service.advance(context,s.flow.id);
    expect((await s.read()).stage).toBe("waiting_render");expect(s.production.wholeOrderFulfillment).toHaveBeenCalledTimes(1);
    expect(s.logistics.createTask).not.toHaveBeenCalled();
  });
  it.each([["quoted","paused"],["reconciliation_required","exception"]])("stops %s without purchasing again",async(status,stage)=>{
    const s=await fixture(),productionId=createEntityId();
    await withTenant(database.db,context,tx=>tx.update(flows).set({productionOrderIds:[productionId],logisticsTaskId:createEntityId()}).where(eq(flows.id,s.flow.id)));
    s.production.wholeOrderFulfillment.mockResolvedValue({items:[{lineId:s.lineId,operationBlockers:[],productionBlockers:[],renderId:createEntityId(),renderFailure:null,production:{id:productionId}}],factories:[],factoryDiagnostics:[]});
    s.logistics.get.mockResolvedValue({id:createEntityId(),status});
    await s.service.advance(context,s.flow.id);
    expect((await s.read()).stage).toBe(stage);expect(s.logistics.dispatch).not.toHaveBeenCalled();
  });
  it("stops when the original approving membership is revoked",async()=>{
    const s=await fixture();
    try{
      await withTenant(database.db,context,tx=>tx.update(memberships).set({status:"disabled"}).where(eq(memberships.id,member)));
      await s.service.advance(context,s.flow.id);
      expect((await s.read()).stage).toBe("exception");expect(s.production.wholeOrderFulfillment).not.toHaveBeenCalled();
    }finally{await withTenant(database.db,context,tx=>tx.update(memberships).set({status:"active"}).where(eq(memberships.id,member)));}
  });
  it("dispatches a saved review on the server even while shipping setup is incomplete",async()=>{
    const s=await fixture(false);
    s.route.blockers.push("物流渠道与费用上限尚未配置");
    await withTenant(database.db,context,tx=>tx.update(orderWorkItems).set({preparation:"ready_to_push",artwork:"not_pushed",revision:2}).where(eq(orderWorkItems.id,s.lineId)));
    await s.service.advance(context,s.flow.id);
    expect(s.work.action).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({tenantId:context.tenantId,userId:context.userId}),s.lineId,expect.objectContaining({action:"push",expectedRevision:2,expectedProjectionVersion:1}));
    expect(await s.read()).toMatchObject({stage:"waiting_artwork",pendingCommand:null});
    expect(s.production.wholeOrderFulfillment).not.toHaveBeenCalled();expect(s.logistics.createTask).not.toHaveBeenCalled();
  });
  it("replays the same design command after its owner committed and the response was lost",async()=>{
    const s=await fixture(false),seen=new Set<string>();
    await withTenant(database.db,context,tx=>tx.update(orderWorkItems).set({preparation:"ready_to_push",artwork:"not_pushed",revision:1}).where(eq(orderWorkItems.id,s.lineId)));
    s.work.action.mockImplementation(async(_context,_line,input)=>{
      if(seen.has(input.idempotencyKey))return;
      seen.add(input.idempotencyKey);
      await withTenant(database.db,context,tx=>tx.update(orderWorkItems).set({preparation:"pushed",artwork:"queued"}).where(eq(orderWorkItems.id,s.lineId)));
      throw new ServiceUnavailableException("Synthetic response lost after commit");
    });
    await s.service.advance(context,s.flow.id);
    const retained=(await s.read()).pendingCommand;expect(retained?.kind).toBe("design");
    await withTenant(database.db,context,tx=>tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.id,s.flow.id)));
    await Promise.all([s.service.advance(context,s.flow.id),s.service.advance(context,s.flow.id)]);
    expect(s.work.action).toHaveBeenCalledTimes(2);expect(seen.size).toBe(1);
    expect(s.work.action.mock.calls[0]![2]).toEqual(s.work.action.mock.calls[1]![2]);
    expect(await s.read()).toMatchObject({stage:"waiting_artwork",pendingCommand:null});expect(s.logistics.createTask).not.toHaveBeenCalled();
  });
  it("waits for review and hides expired or foreign orders from the operational queue",async()=>{
    const s=await fixture(false);
    await withTenant(database.db,context,tx=>tx.update(orderWorkItems).set({preparation:"needs_information"}).where(eq(orderWorkItems.id,s.lineId)));
    await s.service.advance(context,s.flow.id);
    expect(s.work.action).not.toHaveBeenCalled();expect((await s.read()).reasons[0]).toContain("等待整单审单");
    expect((await s.service.queue(context)).items.some(item=>item.orderId===s.order.id)).toBe(true);
    await expect(s.service.queue(other)).rejects.toThrow();
    await withTenant(database.db,context,tx=>tx.update(orderWorkItems).set({expiresAt:new Date(0)}).where(eq(orderWorkItems.id,s.lineId)));
    expect((await s.service.queue(context)).items.some(item=>item.orderId===s.order.id)).toBe(false);
  });
  it("wakes a configuration exception on a new approval but preserves live leases and uncertain paid commands",async()=>{
    const s=await fixture(false);
    await withTenant(database.db,context,tx=>tx.update(flows).set({stage:"exception",reasons:["尚未审核完整"],routeId:s.route.id,routeVersion:1,routeSnapshot:s.route.profile}).where(eq(flows.id,s.flow.id)));
    await withTenant(database.db,context,tx=>scheduleOrderFlow(tx,context,s.order.id));
    expect(await s.read()).toMatchObject({stage:"waiting_artwork",reasons:[],routeId:null,routeSnapshot:null});
    const pendingCommand={kind:"logistics",input:{idempotencyKey:randomUUID()}},logisticsTaskId=createEntityId();
    await withTenant(database.db,context,tx=>tx.update(flows).set({stage:"exception",pendingCommand,logisticsTaskId,reasons:["待核对原购单结果"]}).where(eq(flows.id,s.flow.id)));
    await withTenant(database.db,context,tx=>scheduleOrderFlow(tx,context,s.order.id));
    expect(await s.read()).toMatchObject({stage:"exception",pendingCommand,logisticsTaskId,reasons:["待核对原购单结果"]});
    const leaseToken=createEntityId(),leaseUntil=new Date(Date.now()+60_000);
    await withTenant(database.db,context,tx=>tx.update(flows).set({stage:"paused",pendingCommand:null,logisticsTaskId:null,leaseToken,leaseUntil}).where(eq(flows.id,s.flow.id)));
    await withTenant(database.db,context,tx=>scheduleOrderFlow(tx,context,s.order.id));
    expect(await s.read()).toMatchObject({stage:"paused",leaseToken,leaseUntil});
  });
});
