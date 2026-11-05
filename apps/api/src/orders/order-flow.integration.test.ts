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

  async function fixture(approved=true){
    const key=randomUUID(),order=await orders.ingestNormalized(context,{accountId,platform:"amazon",externalEventId:key,externalOrderId:key,providerStatus:"paid",placedAt:new Date().toISOString(),orderTotal:{amountMinor:1000,currency:"USD"},lines:[{externalLineId:"one",externalListingId:"SYNTHETIC",skuCode:"PILLOW",title:"Synthetic pillow",quantity:1,unitPrice:{amountMinor:1000,currency:"USD"},customizationCount:0}],redactedSource:{synthetic:true},protectedDetails:null});
    const lineId=order.lines[0]!.id,versionId=createEntityId(),specId=createEntityId(),factoryId=createEntityId();
    const profile={id:createEntityId(),factoryId,factoryVersionId:createEntityId(),version:1,profile:FactoryDocumentProfileSchema.parse({name:"Synthetic parcel",route:"printeque",productionAdapter:"printeque_factory",originCountryCode:"US",destinationCountries:["US"],originCompany:"Synthetic",factoryCode:"TEST",carrierProvider:"ShipOS",carrierService:"",useAccountSender:false,evidence:"Synthetic measured parcel",specifications:[{specificationVersionId:specId,productKind:"shaped_pillow",sizeIn:12,supplierSku:"CP-12",weight:0.31,weightUnit:"lb",length:10,width:5,height:5,dimensionUnit:"in",declaredUnitValueMinor:800,nameEn:"Custom pillow",nameCn:"抱枕",hsCode:""}]})};
    const route={id:createEntityId(),version:1,profile:{name:"Synthetic route",mode:"quote" as const,documentProfileVersionId:profile.id,connectionId:createEntityId(),productionDays:2,autoWriteback:false},factoryId,factoryName:"Synthetic",supplierName:"Synthetic",products:["Synthetic pillow"],countries:["US"],connectionName:"Synthetic",blockers:[]};
    const source:DocumentOrderSource={id:order.id,orderNumber:key,address:{recipient:"Synthetic Buyer",countryCode:"US",address1:"1 Test Street",address2:"",city:"Example",region:"CA",postalCode:"90640",phone:"1234567890",email:""},lines:[{id:lineId,externalLineId:"one",quantity:1,skuCode:"PILLOW",specificationVersionId:specId,specificationName:"12in"}]};
    await withTenant(database.db,context,async tx=>{
      await tx.insert(fulfillmentRoutes).values({id:route.id,tenantId:context.tenantId,version:1,profile:route.profile,requestKey:randomUUID(),requestHash:"a".repeat(64),createdBy:context.userId});
      await tx.insert(orderWorkItems).values({id:lineId,tenantId:context.tenantId,artwork:approved?"approved":"in_review",approvedEditorVersionId:approved?versionId:null,expiresAt:new Date(Date.now()+86400000)});
      await scheduleOrderFlow(tx,context,order.id);
      await tx.update(flows).set({nextRunAt:new Date(0)}).where(eq(flows.orderId,order.id));
    });
    const [flow]=await withTenant(database.db,context,tx=>tx.select().from(flows).where(eq(flows.orderId,order.id)));
    const production={wholeOrderFulfillment:vi.fn().mockResolvedValue({items:[{lineId,operationBlockers:[],productionBlockers:[],renderId:null,renderFailure:null,production:null}],factories:[],factoryDiagnostics:[]}),releaseWholeOrderReceipt:vi.fn()};
    const logistics={get:vi.fn(),dispatch:vi.fn(),createTask:vi.fn()};
    const routes={workspace:vi.fn().mockResolvedValue({view:{routes:[route]},documents:{profiles:[profile]},connections:[{id:route.profile.connectionId}]})};
    const service=new OrderFlowService(database,vault,routes as unknown as FulfillmentRoutesService,production as unknown as OrderProductionService,{} as FactoryCapacityService,logistics as unknown as LogisticsService,{} as OrderProductionDeliveryService,{} as LogisticsDocumentsService,{} as OrderShipmentService);
    // Provider and domain-owner behavior is covered in their own integration suites.
    // This suite keeps real RLS, authority, leases, approval intents and command journals.
    vi.spyOn((service as unknown as {source:OrderDocumentSourceReader}).source,"read").mockResolvedValue({source,blockers:[],orderSequence:order.latestEventSequence,fingerprint:"a".repeat(64),expiresAt:new Date(Date.now()+86400000),production:[]});
    const read=async()=> (await withTenant(database.db,context,tx=>tx.select().from(flows).where(eq(flows.id,flow!.id))))[0]!;
    return {service,flow:flow!,read,production,logistics,route,routes,lineId,order,versionId,profile};
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
});
