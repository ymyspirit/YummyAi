import {createHash,randomUUID} from "node:crypto";
import {SecretVault} from "@yummyai/ai-core";
import {Permission} from "@yummyai/authz";
import {createEntityId,type TenantContext} from "@yummyai/contracts";
import {LogisticsConnectionProfileSchema,type LogisticsQuote,type LogisticsConnectionProfile,type LogisticsTaskSnapshot} from "@yummyai/contracts/logistics";
import {connectDatabase,withTenant,marketplaceAccounts,fulfillmentSuppliers,productionOrders,productionOrderVersions,routingPolicyVersions,orderRoutingDecisions,purchaseOrders,purchaseOrderVersions,logisticsTasks,logisticsLabels,logisticsAccounts,logisticsAccountVersions,logisticsConnectionVersions,orders,roles,orderProtectedDetails,orderWorkItems,orderWorkRevisions} from "@yummyai/database";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { syntheticNativeManufacturingForLine } from "../orders/manufacturing-production.test-fixture.js";
import { sealProductionManufacturing } from "../orders/production-manufacturing.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { reserveFactoryCapacityInTransaction } from "../suppliers/factory-capacity.service.js";
import {HttpLogisticsGateway,LogisticsExecutor,LogisticsTransportError,purgeLogisticsTasks,type LogisticsProviderResult} from "@yummyai/logistics";
import {assertAssetAccess,type Storage,type StoredAsset,type PutPrivateInput,type AssetDomain} from "@yummyai/storage";
import {and,eq} from "drizzle-orm";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {AuditService} from "../audit/audit.service.js";
import {OrderService} from "../orders/order.service.js";
import {FactoryDirectoryService} from "../suppliers/factory-directory.service.js";
import {syntheticFactoryProfile,syntheticFactoryCapability,syntheticSupplierProfile} from "../../../../tools/testing/factory-fixtures.js";
import {LogisticsService} from "./logistics.service.js";
import { sealWork } from "@yummyai/order-core";
import { LogisticsDocumentsService } from "./logistics-documents.service.js";
import type { OrderProductionDeliveryService } from "../orders/order-production-delivery.service.js";
import {LogisticsAccountsService} from "./logistics-accounts.service.js";
import { FulfillmentAttentionService } from "../dashboard/fulfillment-attention.service.js";
if(process.env.E2E_ISOLATED_DAILY!=="1"||!/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))throw new Error("Use disposable logistics-integration acceptance");
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex"),future=(days:number)=>new Date(Date.now()+days*86400000).toISOString();
class Carrier extends HttpLogisticsGateway {
  creates=0;lookups=0;labelRequests=0;downloads=0;quoteRequests=0;loseCreateResponse=false;failSecondLabel=false;priceChange=false;price=500;actual=600;
  asyncLabels=false;pendingLabels=false;loseLabelResponse=false;accountReads=0;accountDelay?:()=>Promise<void>;
  existing=new Map<string,LogisticsProviderResult>();
  channelRows=[{code:"fixture",name:"Synthetic channel"}];
  override async channels(){return this.channelRows;}
  override async accountChannels(){this.accountReads++;await this.accountDelay?.();return this.channels();}
  override async quote(){this.quoteRequests++;return [{channelCode:"fixture",channelName:"Synthetic channel",totalMinor:this.priceChange&&this.quoteRequests%2===0?2000000:this.price,currency:"USD",currencySource:"Synthetic account currency",transitDaysMin:3,transitDaysMax:5,transitSource:"Synthetic calendar-day maximum",conditionsVerified:true,priceSource:"Isolated carrier price",quotedAt:new Date().toISOString(),diagnostic:null}] as LogisticsQuote[];}
  override async create(_p:LogisticsConnectionProfile,_c:unknown,_t:LogisticsTaskSnapshot,ref:string){this.creates++;const result={providerOrderId:ref,trackingNumbers:[`TRACK${this.creates}`],labelUrls:this.asyncLabels?[]:["https://labels.example.invalid/1.pdf","https://labels.example.invalid/2.pdf"],actualCostMinor:this.actual,actualCurrency:"USD"};this.existing.set(ref,result);if(this.loseCreateResponse){this.loseCreateResponse=false;throw new Error("Synthetic lost response after provider commit");}return result;}
  override async lookup(_p:LogisticsConnectionProfile,_c:unknown,ref:string){this.lookups++;return this.existing.get(ref)??null;}
  override async labels(_p:LogisticsConnectionProfile,_c:unknown,ref:string){this.labelRequests++;if(this.pendingLabels)throw new LogisticsTransportError("LABEL_PENDING");if(this.loseLabelResponse)throw new LogisticsTransportError("TRANSPORT_UNCERTAIN");return {...this.existing.get(ref)!,labelUrls:["https://labels.example.invalid/1.pdf","https://labels.example.invalid/2.pdf"]};}
  override async downloadLabel(_p:LogisticsConnectionProfile,url:string){this.downloads++;if(this.failSecondLabel&&url.endsWith("2.pdf")){this.failSecondLabel=false;throw new Error("Synthetic partial download failure");}return Buffer.from(`%PDF-1.4\nSynthetic disposable label ${url.slice(-5)}\n%%EOF`);}
}
describe.sequential("tenant-isolated logistics procurement and reconciliation",()=>{
  const database=connectDatabase(),context:TenantContext={tenantId:createEntityId(),userId:createEntityId(),permissions:Object.values(Permission),dataScope:"tenant"},other={...context,tenantId:createEntityId()},accountId=createEntityId(),supplierId=createEntityId(),roleId=createEntityId();
  const pii=new SecretVault(Buffer.alloc(32,41)),vault=new SecretVault(Buffer.alloc(32,42)),audit=new AuditService(database),orderService=new OrderService(database,pii,audit),factories=new FactoryDirectoryService(database,audit),objects=new Map<string,Uint8Array>();
  const storage={putPrivate:async(c:TenantContext,input:PutPrivateInput)=>{const checksumSha256=sha(input.body),objectKey=`tenants/${c.tenantId}/${input.domain}/${checksumSha256}/${input.fileName}`,deduplicated=objects.has(objectKey);objects.set(objectKey,input.body);return {objectKey,checksumSha256,deduplicated};},readPrivate:async(c:TenantContext,a:StoredAsset,o:{requiredDomain:AssetDomain})=>{assertAssetAccess(c,a,o.requiredDomain);if(!objects.has(a.objectKey))throw new Error("Missing fixture blob");return objects.get(a.objectKey)!;},discardLogisticsLabel:async(c:TenantContext,id:string,key:string)=>{assertAssetAccess(c,{id,tenantId:c.tenantId,assetDomain:"order",objectKey:key},"order");objects.delete(key);}} as unknown as Storage;
  let usFactory:Awaited<ReturnType<FactoryDirectoryService["create"]>>,cnFactory:typeof usFactory;
  const capabilities=new Map<string,string>();
  const capacities=new Map<string,Awaited<ReturnType<typeof createSyntheticFactoryCapacity>>>();
  beforeAll(async()=>{
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic logistics',$2),($3,'Synthetic isolation',$4)",[context.tenantId,`logistics-${context.tenantId}`,other.tenantId,`logistics-${other.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic operator')",[context.userId,`logistics-${context.userId}`,`${context.userId}@example.invalid`]);
    const member=createEntityId();await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",[member,context.tenantId,context.userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,'Synthetic operator',$3::jsonb,'tenant')",[roleId,context.tenantId,JSON.stringify(context.permissions)]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",[context.tenantId,member,roleId]);
    await withTenant(database.db,context,async tx=>{await tx.insert(marketplaceAccounts).values({id:accountId,tenantId:context.tenantId,platform:"amazon",displayName:"Synthetic Amazon store",region:"NA",authorizationMode:"amazon_private",createdBy:context.userId});await tx.insert(fulfillmentSuppliers).values({id:supplierId,tenantId:context.tenantId,name:"Synthetic supplier",kind:"manual",status:"active",regionCode:"US",settlementCurrency:"USD",profile:syntheticSupplierProfile,createdBy:context.userId});});
    for(const country of ["US","CN"]){const profile=syntheticFactoryProfile(`Synthetic ${country} factory`);profile.productionAddress={...profile.productionAddress!,countryCode:country,province:"CA",city:"Test City",street:"1 Test Street",postalCode:"00000",recipient:"Synthetic sender",phone:"1234567890"};const factory=await factories.create(context,{supplierId,code:`TEST-${country}-${randomUUID()}`,profile,idempotencyKey:randomUUID()});const capability=await factories.createCapability(context,factory.id,{profile:syntheticFactoryCapability("shaped_pillow"),idempotencyKey:randomUUID()});capabilities.set(factory.id,capability.versionId);if(country==="US")usFactory=factory;else cnFactory=factory;}
  });
  afterAll(async()=>{objects.clear();await database.client.end();});
  it("reads a tenant-isolated paginated attention queue without purchasing or duplicating tasks",async()=>{
    const s=await setup(),attention=new FulfillmentAttentionService(database),ids:string[]=[];
    for(let i=0;i<16;i++)ids.push((await s.service.createTask(context,taskInput(s,await production(s.factory)))).taskId);
    await withTenant(database.db,context,async tx=>{
      await tx.update(logisticsTasks).set({status:"reconciliation_required",diagnostic:"Synthetic upstream text never appears in the home page"}).where(eq(logisticsTasks.id,ids[15]!));
      await tx.update(logisticsTasks).set({status:"completed"}).where(eq(logisticsTasks.id,ids[14]!));
      await tx.update(logisticsTasks).set({status:"purchasing",leaseUntil:new Date(Date.now()+3600000)}).where(eq(logisticsTasks.id,ids[13]!));
    });
    const first=await attention.workspace(context,{source:"logistics"}),second=await attention.workspace(context,{source:"logistics",page:2});
    expect(first.total).toBe(14);expect(first.hasMore).toBe(true);expect(first.items).toHaveLength(12);expect(second.items).toHaveLength(2);
    expect(first.items[0]).toMatchObject({entityId:ids[15],priority:"blocked",href:`/logistics?task=${ids[15]}`});
    expect(new Set([...first.items,...second.items].map(item=>item.entityId)).size).toBe(14);
    expect(JSON.stringify(first)).not.toContain("Synthetic upstream text");expect(JSON.stringify(first)).not.toContain("1 Test Street");
    expect((await attention.workspace(other,{})).total).toBe(0);
    expect((await attention.workspace({...context,permissions:[Permission.DashboardRead]},{})).sources.every(source=>source.count===null)).toBe(true);
    await expect(attention.workspace({...context,permissions:[Permission.DashboardRead]},{source:"logistics"})).rejects.toThrow("Permission denied");
    expect((await attention.workspace(context,{source:"production"},new Date(future(4)))).items.some(item=>item.priority==="overdue")).toBe(true);
    expect(s.carrier.creates).toBe(0);expect(s.carrier.lookups).toBe(0);expect(s.carrier.quoteRequests).toBe(0);
  });
  async function setup(carrier=new Carrier(),country:"US"|"CN"="US",daily=1000000,ticket=1000,auto=true,labelMode?:"include"|"factory_pull",senderAddressId?:number){
    const factory=country==="US"?usFactory:cnFactory;
    const enqueued:unknown[]=[];const queue={enqueue:async(input:unknown)=>{enqueued.push(input);return undefined;}};const service=new LogisticsService(database,vault,pii,storage,carrier,orderService,queue,new LogisticsAccountsService(database,vault,carrier)),executor=new LogisticsExecutor(database,vault,pii,storage,carrier);
    const profile=LogisticsConnectionProfileSchema.parse({name:`Synthetic route ${randomUUID()}`,provider:country==="US"?"shipos":"yunexpress",factoryId:factory.id,originCountryCode:country,sender:{name:"Synthetic sender",address1:"1 Test Street",city:"Test City",region:"CA",postalCode:"00000",countryCode:country,phone:"1234567890",email:"sender@example.invalid"},baseUrl:country==="US"?"https://api.shipos.cn":"https://oms.example.invalid",currency:"USD",currencySource:"Synthetic account billing proof",labelHosts:["shipease.oss-cn-hangzhou.aliyuncs.com"],channels:carrier.channelRows.map(channel=>({...channel,countryCodes:["US"],transitDaysMin:3,transitDaysMax:5,transitSource:"Synthetic calendar-day SLA",conditionsVerified:true,conditionsEvidence:"Synthetic route conditions",maxWeightGrams:10000,maxDimensionMm:1000})),apiCompatibilityEvidence:"Synthetic account compatibility",purchasePermissionEvidence:"Synthetic purchase permissions",labelMode:labelMode??(country==="US"?"factory_pull":"include")});
    if(senderAddressId){profile.shiposSenderAddressId=senderAddressId;profile.sender.phone="";}
    const original=process.env.YUNEXPRESS_ALLOWED_ORIGINS;process.env.YUNEXPRESS_ALLOWED_ORIGINS="https://oms.example.invalid";
    let saved:Awaited<ReturnType<LogisticsService["saveConnection"]>>;try{saved=await service.saveConnection(context,{expectedVersion:0,profile,credentials:country==="US"?{provider:"shipos",appKey:"fixture",appSecret:"fixture"}:{provider:"yunexpress",customerCode:"fixture",apiSecret:"fixture"},idempotencyKey:randomUUID()});}finally{if(original===undefined)delete process.env.YUNEXPRESS_ALLOWED_ORIGINS;else process.env.YUNEXPRESS_ALLOWED_ORIGINS=original;}
    await service.verify(context,saved.connectionId,{expectedVersion:1,idempotencyKey:randomUUID()});await service.saveRule(context,{connectionId:saved.connectionId,expectedVersion:0,rule:{name:"Synthetic budget",currency:"USD",autoPurchase:auto,maxTicketMinor:ticket,maxDailyMinor:daily,quoteMaxAgeSeconds:120,allowedChannelCodes:carrier.channelRows.map(channel=>channel.code),evidence:"Synthetic budget authorization"},idempotencyKey:randomUUID()});
    return {service,executor,carrier,factory,profile,connectionId:saved.connectionId,enqueued};
  }
  it("pins a ShipOS saved sender address without requiring invented contact details or weakening factory and tenant checks",async()=>{
    const s=await setup(new Carrier(),"US",1000000,1000,false,undefined,123456);
    expect((await s.service.connections(context)).connections.find(row=>row.id===s.connectionId)?.profile).toMatchObject({shiposSenderAddressId:123456,sender:{phone:""}});
    expect((await s.service.connections(other)).connections).toHaveLength(0);
    await expect(s.service.saveConnection(context,{connectionId:s.connectionId,expectedVersion:1,profile:{...s.profile,sender:{...s.profile.sender,address1:"Different factory"}},idempotencyKey:randomUUID()})).rejects.toThrow("实际发货地址");
    const saved=await s.service.createTask(context,taskInput(s,await production(s.factory)),{mode:"quote"});
    await s.executor.run(context,saved.taskId,"quote");
    expect((await s.service.get(context,saved.taskId)).status).toBe("quoted");
    expect(s.carrier.creates).toBe(0);
  });
  it("honors explicit quote-only mode even on an automatic purchase connection",async()=>{
    const s=await setup(),input=taskInput(s,await production(s.factory));
    input.packages[0]!.declarations[0]!.hsCode="";
    const saved=await s.service.createTask(context,input,{mode:"quote"});
    expect(s.enqueued[0]).toMatchObject({mode:"quote"});
    expect(s.enqueued).not.toContainEqual(expect.objectContaining({mode:"purchase"}));
    await s.executor.run(context,saved.taskId,"quote");
    expect((await s.service.get(context,saved.taskId)).status).toBe("quoted");
    expect(s.carrier.creates).toBe(0);
    expect(await s.service.createTask(context,input,{mode:"quote"})).toMatchObject({taskId:saved.taskId,replayed:true});
    await expect(s.service.createTask(context,input)).rejects.toThrow();
    const yun=await setup(new Carrier(),"CN"),crossBorder=taskInput(yun,await production(yun.factory));
    crossBorder.packages[0]!.declarations[0]!.hsCode="";
    await expect(yun.service.createTask(context,crossBorder,{mode:"quote"})).rejects.toThrow();
    expect(yun.enqueued).toHaveLength(0);
  });
  async function production(factory:typeof usFactory,existingOrderId?:string,totalQuantity=1){
    if(!capacities.has(factory.id))capacities.set(factory.id,await createSyntheticFactoryCapacity(database,context,{factory,bindings:[{capabilityVersionId:capabilities.get(factory.id)!,unitsPerItem:1}],capacityUnits:10_000}));
    const capacity=capacities.get(factory.id)!;
    const key=`synthetic-${randomUUID()}`;const order=existingOrderId?await orderService.get(context,existingOrderId):await orderService.ingestNormalized(context,{accountId,platform:"amazon",externalEventId:key,externalOrderId:key,providerStatus:"paid",placedAt:new Date().toISOString(),orderTotal:{amountMinor:2000,currency:"USD"},lines:[{externalLineId:`${key}-line`,externalListingId:"SYNTHETIC",skuCode:"FIXTURE",title:"Synthetic pillow",quantity:totalQuantity,unitPrice:{amountMinor:1000,currency:"USD"},customizationCount:0}],redactedSource:{synthetic:true},protectedDetails:{buyer:{name:"Synthetic buyer",email:"buyer@example.invalid",phone:"1234567890"},shippingAddress:{recipient:"Synthetic buyer",lines:["2 Test Street"],city:"Test City",region:"CA",postalCode:"00000",countryCode:"US"},customizations:[]}});
    const sourceDocument=createDefaultProductionDocument("shaped_pillow");
    if(sourceDocument.productType!=="shaped_pillow")throw new Error("Synthetic pillow source required");
    sourceDocument.spec.declaredLongestMm=254;sourceDocument.spec.sizeBasis="artwork";sourceDocument.spec.minimumNeckBasis="cut_contour";
    // A measured synthetic product reference only; artwork and file approvals remain false.
    const basis=await syntheticNativeManufacturingForLine(database,context,order.lines[0]!.id,{productType:"shaped_pillow",document:sourceDocument});
    const id=createEntityId(),versionId=createEntityId(),completion=new Date(future(1));
    await withTenant(database.db,context,async tx=>{
      // Native production has approved routing and procurement; it is not an order-work release.
      const lineId=order.lines[0]!.id,policyId=createEntityId(),routingId=createEntityId(),purchaseVersionId=createEntityId();
      const previousRouting=await tx.select({id:orderRoutingDecisions.id}).from(orderRoutingDecisions).where(eq(orderRoutingDecisions.orderLineId,lineId));
      await tx.insert(routingPolicyVersions).values({id:policyId,tenantId:context.tenantId,name:`Synthetic logistics routing ${policyId}`,versionNumber:1,
        weights:{capability:2000,region:1000,cost:2000,leadTime:2000,capacity:1000,quality:1500,priority:500},
        thresholds:{minimumQualityBps:8000,maximumLeadTimeDays:10,maximumUnitCostMinor:2000,manualApprovalCostMinor:2000,manualApprovalRiskBps:2000},
        tieBreaker:["total_score","unit_cost","lead_time","supplier_id"],active:true,createdBy:context.userId});
      await tx.insert(orderRoutingDecisions).values({id:routingId,tenantId:context.tenantId,orderId:order.id,orderLineId:lineId,routingPolicyVersionId:policyId,
        versionNumber:previousRouting.length+1,status:"approved",selectedSupplierId:supplierId,inputChecksum:sha(key),requiresApproval:false,approvalReasons:[],idempotencyKey:key});
      const [previousPurchase]=await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.orderId,order.id),eq(purchaseOrders.supplierId,supplierId)));
      const purchaseId=previousPurchase?.id??createEntityId(),purchaseVersionNumber=(previousPurchase?.currentVersionNumber??0)+1;
      if(previousPurchase)await tx.update(purchaseOrders).set({currentVersionNumber:purchaseVersionNumber}).where(eq(purchaseOrders.id,purchaseId));
      else await tx.insert(purchaseOrders).values({id:purchaseId,tenantId:context.tenantId,supplierId,orderId:order.id,status:"approved",currentVersionNumber:purchaseVersionNumber,createdBy:context.userId});
      const lineSnapshot=[{orderLineId:lineId,quantity:1,unitCostMinor:800}];
      await tx.insert(purchaseOrderVersions).values({id:purchaseVersionId,tenantId:context.tenantId,purchaseOrderId:purchaseId,versionNumber:purchaseVersionNumber,currency:"USD",totalMinor:800,
        lineSnapshot,routingDecisionIds:[routingId],checksum:sha(JSON.stringify(lineSnapshot)),createdBy:context.userId});
      await tx.insert(productionOrders).values({id,tenantId:context.tenantId,orderId:order.id,orderLineId:lineId,supplierId,factoryId:factory.id,
        routingDecisionId:routingId,purchaseOrderVersionId:purchaseVersionId,status:"planned",expectedCompletionAt:completion,idempotencyKey:key,createdBy:context.userId});
      await tx.insert(productionOrderVersions).values({id:versionId,tenantId:context.tenantId,productionOrderId:id,versionNumber:1,quantity:1,designVersionId:basis.designVersionId,productionAssetIds:basis.productionAssetIds,factoryId:factory.id,factoryVersionId:factory.versionId,capabilityVersionId:capabilities.get(factory.id),encryptedInstructions:pii.encrypt("Synthetic manufacturing instructions"),instructionsChecksum:sha("Synthetic manufacturing instructions"),expectedCompletionAt:completion,createdBy:context.userId});
      await sealProductionManufacturing(tx,context,pii,versionId,basis.manufacturing,{kind:"approved_product_confirmation",confirmation:basis.productConfirmation});
      await reserveFactoryCapacityInTransaction(tx,context,audit,{productionOrderId:id,productionVersionId:versionId,capacityPlan:capacity.capacityPlan});
    });return {order,id,versionId,quantity:1,specificationVersionId:basis.specificationVersionId};
  }
  function taskInput(s:Awaited<ReturnType<typeof setup>>,p:Awaited<ReturnType<typeof production>>){return {orderId:p.order.id,productionOrderIds:[p.id],connectionId:s.connectionId,packages:[{weightGrams:500,dimensionsMm:{length:300,width:200,height:100},evidence:"Synthetic measured package version 1",containsBattery:false,declarations:[{sku:"FIXTURE",nameEn:"Synthetic pillow",nameCn:"测试抱枕",quantity:p.quantity,unitPriceMinor:1000,currency:"USD",unitWeightGrams:200,hsCode:"940490",originCountryCode:"CN"}]}],readyAt:future(1.1),latestShipAt:future(2),deliverBy:future(10),deadlineSource:"Synthetic platform shipping and delivery promise",expectedOrderSequence:p.order.latestEventSequence,idempotencyKey:randomUUID()};}
  it("creates before QC, reuses task pins, stores separate costs and never advances actual shipment",async()=>{const s=await setup(),p=await production(s.factory),input=taskInput(s,p),result=await s.service.createTask(context,input);expect(await s.service.createTask(context,input)).toMatchObject({taskId:result.taskId,replayed:true});expect(await s.service.createTask(context,{...input,idempotencyKey:randomUUID()})).toMatchObject({taskId:result.taskId,replayed:true});await s.executor.run(context,result.taskId,"purchase");await s.executor.run(context,result.taskId,"purchase");expect(s.carrier.creates).toBe(1);expect(await s.service.get(context,result.taskId)).toMatchObject({status:"completed",quotedCostMinor:500,actualCostMinor:600,labelMode:"factory_pull",labelCount:0});expect(await orderService.get(context,p.order.id)).toMatchObject({workflowState:p.order.workflowState});expect(await s.service.workspace(other)).toEqual({tasks:[]});await expect(s.service.get(other,result.taskId)).rejects.toThrow();});
  it("honors a tenant daily cap across distinct routes",async()=>{const rows=await withTenant(database.db,context,tx=>tx.select().from(logisticsTasks));const baseline=rows.reduce((n,t)=>n+Math.max(t.reservationMinor,t.actualCostMinor??0),0),carrier=new Carrier();carrier.actual=500;const s=await setup(carrier,"US",baseline+500,500);const a=await s.service.createTask(context,taskInput(s,await production(s.factory))),b=await s.service.createTask(context,taskInput(s,await production(s.factory)));await s.executor.run(context,a.taskId,"purchase");await s.executor.run(context,b.taskId,"purchase");expect(s.carrier.creates).toBe(1);expect(await s.service.get(context,b.taskId)).toMatchObject({status:"attention",diagnostic:"DAILY_BUDGET_EXCEEDED"});});
  it("reprices before purchase and sends changed or unqualified prices to manual review",async()=>{const carrier=new Carrier();carrier.priceChange=true;const s=await setup(carrier),r=await s.service.createTask(context,taskInput(s,await production(s.factory)));await s.executor.run(context,r.taskId,"purchase");expect(carrier.creates).toBe(0);expect(await s.service.get(context,r.taskId)).toMatchObject({diagnostic:"PRICE_OR_SERVICE_CHANGED"});});
  it("reconciles a committed order whose response was lost without a second purchase",async()=>{const carrier=new Carrier();carrier.loseCreateResponse=true;const s=await setup(carrier),r=await s.service.createTask(context,taskInput(s,await production(s.factory)));await s.executor.run(context,r.taskId,"purchase");expect(await s.service.get(context,r.taskId)).toMatchObject({status:"reconciliation_required"});await s.executor.run(context,r.taskId,"purchase");expect(carrier.creates).toBe(1);expect(carrier.lookups).toBe(2);expect(await s.service.get(context,r.taskId)).toMatchObject({status:"completed"});});
  it("never repurchases when an uncertain provider order cannot be found",async()=>{const carrier=new Carrier();carrier.loseCreateResponse=true;const s=await setup(carrier),r=await s.service.createTask(context,taskInput(s,await production(s.factory)));await s.executor.run(context,r.taskId,"purchase");carrier.existing.clear();await s.executor.run(context,r.taskId,"purchase");expect(carrier.creates).toBe(1);expect(await s.service.get(context,r.taskId)).toMatchObject({status:"reconciliation_required",diagnostic:"PROVIDER_ORDER_NOT_CONFIRMED"});});
  it("retains partial Yun labels, resumes retrieval, and erases expired private objects",async()=>{const carrier=new Carrier();carrier.failSecondLabel=true;const s=await setup(carrier,"CN"),p=await production(s.factory),r=await s.service.createTask(context,taskInput(s,p));await s.executor.run(context,r.taskId,"purchase");expect(await s.service.get(context,r.taskId)).toMatchObject({status:"reconciliation_required",labelCount:1});await s.executor.run(context,r.taskId,"reconcile");const view=await s.service.get(context,r.taskId);expect(view).toMatchObject({status:"completed",labelCount:2});expect(carrier.creates).toBe(1);expect(await s.service.deliveryForProduction(context,p.versionId)).toMatchObject({provider:"yunexpress",labelMode:"include"});await expect(s.service.label(other,r.taskId,view.labels[0]!.id)).rejects.toThrow();const [pin]=await withTenant(database.db,context,tx=>tx.select().from(logisticsTasks).where(eq(logisticsTasks.id,r.taskId)));await purgeLogisticsTasks(database,context,storage,new Date(pin!.expiresAt.getTime()+1),r.taskId);expect((await withTenant(database.db,context,tx=>tx.select().from(logisticsLabels).where(eq(logisticsLabels.taskId,r.taskId))))).toHaveLength(0);expect(objects.size).toBe(0);await expect(s.service.label(context,r.taskId,view.labels[0]!.id)).rejects.toThrow();});
  it("blocks cancelled production, stale addresses, revoked permissions and missing packaging",async()=>{const s=await setup(),p=await production(s.factory),input=taskInput(s,p);await expect(s.service.createTask(context,{...input,packages:[]})).rejects.toThrow();const r=await s.service.createTask(context,input);await withTenant(database.db,context,tx=>tx.update(productionOrders).set({status:"cancelled"}).where(eq(productionOrders.id,p.id)));await s.executor.run(context,r.taskId,"purchase");expect(s.carrier.creates).toBe(0);const p2=await production(s.factory),r2=await s.service.createTask(context,taskInput(s,p2));await withTenant(database.db,context,tx=>tx.update(orderProtectedDetails).set({envelopeVersion:2}).where(eq(orderProtectedDetails.orderId,p2.order.id)));await s.executor.run(context,r2.taskId,"purchase");expect(s.carrier.creates).toBe(0);const p3=await production(s.factory),r3=await s.service.createTask(context,taskInput(s,p3));try{await withTenant(database.db,context,tx=>tx.update(roles).set({permissions:[Permission.OrderRead]}).where(eq(roles.id,roleId)));await s.executor.run(context,r3.taskId,"purchase");expect(s.carrier.creates).toBe(0);}finally{await withTenant(database.db,context,tx=>tx.update(roles).set({permissions:Object.values(Permission)}).where(eq(roles.id,roleId)));}});
  it("splits one order by actual factory and rejects overlapping assignments",async()=>{const us=await setup(new Carrier(),"US",1000000,1000,true,"include"),cn=await setup(new Carrier(),"CN"),p=await production(us.factory,undefined,2),p2=await production(cn.factory,p.order.id);await expect(us.service.createTask(context,{...taskInput(us,p),productionOrderIds:[p.id,p2.id]})).rejects.toThrow();const a=await us.service.createTask(context,taskInput(us,p)),b=await cn.service.createTask(context,taskInput(cn,p2));expect(a.taskId).not.toBe(b.taskId);expect((await us.service.workspace(context,{orderId:p.order.id})).tasks.map(t=>t.factoryId).sort()).toEqual([usFactory.id,cnFactory.id].sort());const [t]=await withTenant(database.db,context,tx=>tx.select().from(logisticsTasks).where(eq(logisticsTasks.id,a.taskId)));await expect(withTenant(database.db,context,tx=>tx.update(logisticsTasks).set({snapshotHash:"0".repeat(64)}).where(eq(logisticsTasks.id,t!.id)))).rejects.toMatchObject({cause:{message:"Logistics task pins are immutable"}});});
  it("anonymized orders cannot expose labels or private task snapshots",async()=>{const s=await setup(),p=await production(s.factory),r=await s.service.createTask(context,taskInput(s,p));await withTenant(database.db,context,tx=>tx.update(orders).set({addressStatus:"anonymized"}).where(eq(orders.id,p.order.id)));await s.service.get(context,r.taskId);const [t]=await withTenant(database.db,context,tx=>tx.select().from(logisticsTasks).where(eq(logisticsTasks.id,r.taskId)));expect(t?.encryptedSnapshot).toBeNull();});
  it("rejects replacement packaging or deadlines disguised as a retry of pinned production",async()=>{
    const s=await setup(),p=await production(s.factory),input=taskInput(s,p),saved=await s.service.createTask(context,input);
    await expect(s.service.workspace({...context,dataScope:"self"})).rejects.toThrow("Permission denied");
    await expect(s.service.connections({...context,dataScope:"team"})).rejects.toThrow("Permission denied");
    await expect(s.service.createTask(context,{...input,idempotencyKey:randomUUID(),packages:input.packages.map(parcel=>({...parcel,weightGrams:700}))})).rejects.toThrow("不能用重试覆盖");
    await expect(s.service.createTask(context,{...input,idempotencyKey:randomUUID(),deliverBy:future(12)})).rejects.toThrow("不能用重试覆盖");
    expect(await s.service.createTask(context,{...input,idempotencyKey:randomUUID()})).toMatchObject({taskId:saved.taskId,replayed:true});
    expect(s.carrier.creates).toBe(0);
  });
  it("keeps actual over-budget purchases for reconciliation and never buys again",async()=>{const carrier=new Carrier();carrier.actual=1100;const s=await setup(carrier),r=await s.service.createTask(context,taskInput(s,await production(s.factory)));await s.executor.run(context,r.taskId,"purchase");expect(await s.service.get(context,r.taskId)).toMatchObject({status:"attention",diagnostic:"ACTUAL_COST_EXCEEDS_BUDGET",actualCostMinor:1100});await s.executor.run(context,r.taskId,"purchase");expect(carrier.creates).toBe(1);expect(carrier.lookups).toBe(2);});
  it("saves credentials before a factory is ready with tenant isolation and immutable versions",async()=>{
    const carrier=new Carrier(),service=new LogisticsAccountsService(database,vault,carrier);
    const input={expectedVersion:0,profile:{name:"Synthetic pending Yun account",provider:"yunexpress",baseUrl:null},credentials:{provider:"yunexpress",customerCode:"synthetic-customer",apiSecret:"synthetic-account-secret",appId:"synthetic-app"},idempotencyKey:randomUUID()};
    const saved=await service.save(context,input);expect(await service.save(context,input)).toEqual(saved);
    const list=await service.list(context),account=list.accounts.find(a=>a.id===saved.accountId)!;
    expect(account).toMatchObject({verifiedAt:null,channels:[]});expect(JSON.stringify(list)).not.toContain("synthetic-account-secret");expect(await service.list(other)).toEqual({accounts:[]});
    await expect(service.verify(context,saved.accountId,{expectedVersion:1})).rejects.toThrow("HTTPS");expect(carrier.accountReads).toBe(0);
    await expect(service.save({...context,permissions:[Permission.IntegrationRead]},input)).rejects.toThrow();
    const [raw]=await withTenant(database.db,context,tx=>tx.select().from(logisticsAccountVersions).where(eq(logisticsAccountVersions.id,account.versionId)));
    expect(raw!.encryptedCredentials).not.toContain("synthetic-account-secret");expect(vault.withSecret(raw!.encryptedCredentials,value=>JSON.parse(value).appId)).toBe("synthetic-app");
    await expect(withTenant(database.db,context,tx=>tx.update(logisticsAccountVersions).set({profile:{...account.profile,name:"changed"}}).where(eq(logisticsAccountVersions.id,account.versionId)))).rejects.toThrow();
    expect(await withTenant(database.db,other,tx=>tx.select().from(logisticsAccounts).where(eq(logisticsAccounts.id,saved.accountId)))).toEqual([]);
    const update={accountId:saved.accountId,expectedVersion:1,profile:{...account.profile,name:"Synthetic renamed account"},idempotencyKey:randomUUID()};
    expect(await service.save(context,update)).toMatchObject({version:2});await expect(service.save(context,{...update,idempotencyKey:randomUUID()})).rejects.toThrow("版本");
  });
  it("only pins the verified current API account and rejects verification after credential rotation",async()=>{
    const s=await setup(),accounts=new LogisticsAccountsService(database,vault,s.carrier);
    const input={expectedVersion:0,profile:{name:"Synthetic ShipOS account",provider:"shipos",baseUrl:"https://api.shipos.cn"},credentials:{provider:"shipos",appKey:"synthetic-key",appSecret:"synthetic-account-secret"},idempotencyKey:randomUUID()};
    const saved=await accounts.save(context,input),account=(await accounts.list(context)).accounts.find(a=>a.id===saved.accountId)!;
    const connection={expectedVersion:0,profile:s.profile,accountVersionId:account.versionId,idempotencyKey:randomUUID()};
    await expect(s.service.saveConnection(context,connection)).rejects.toThrow("已测试通过");
    await accounts.verify(context,saved.accountId,{expectedVersion:1});
    const route=await s.service.saveConnection(context,connection);
    const [version]=await withTenant(database.db,context,tx=>tx.select().from(logisticsConnectionVersions).where(eq(logisticsConnectionVersions.connectionId,route.connectionId)));
    expect(vault.withSecret(version!.encryptedCredentials,value=>JSON.parse(value).appKey)).toBe("synthetic-key");
    let release!:()=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;}),pause=new Promise<void>(resolve=>{release=resolve;});
    s.carrier.accountDelay=async()=>{started();await pause;};
    const verifying=accounts.verify(context,saved.accountId,{expectedVersion:1}).then(()=>null,error=>error);
    await began;await accounts.save(context,{...input,accountId:saved.accountId,expectedVersion:1,idempotencyKey:randomUUID(),credentials:{...input.credentials,appSecret:"synthetic-rotated-secret"}});release();
    expect((await verifying)?.message).toContain("账户已更新");expect((await accounts.list(context)).accounts.find(a=>a.id===saved.accountId)?.verifiedAt).toBeNull();
    await expect(s.service.saveConnection(context,{...connection,idempotencyKey:randomUUID()})).rejects.toThrow("已测试通过");expect(s.carrier.creates).toBe(0);expect(s.carrier.labelRequests).toBe(0);
  });
  it("pins OpenAPI authentication without exposing source identifiers or upgrading legacy versions",async()=>{
    const s=await setup(new Carrier(),"CN"),accounts=new LogisticsAccountsService(database,vault,s.carrier);
    const profile={name:"Synthetic OpenAPI account",provider:"yunexpress" as const,baseUrl:"https://openapi.yunexpress.cn",yunexpressProtocol:"openapi" as const};
    const credentials={provider:"yunexpress",appId:"synthetic-app",apiSecret:"synthetic-openapi-secret",sourceKey:"synthetic-private-source"};
    await expect(accounts.save(context,{expectedVersion:0,profile,credentials:{provider:"yunexpress",customerCode:"old",apiSecret:"old"},idempotencyKey:randomUUID()})).rejects.toThrow();
    const saved=await accounts.save(context,{expectedVersion:0,profile,credentials,idempotencyKey:randomUUID()});
    await accounts.verify(context,saved.accountId,{expectedVersion:1});
    const list=await accounts.list(context),account=list.accounts.find(a=>a.id===saved.accountId)!;
    expect(JSON.stringify(list)).not.toContain("synthetic-private-source");expect(JSON.stringify(list)).not.toContain("synthetic-openapi-secret");
    const routeProfile={...s.profile,baseUrl:profile.baseUrl,yunexpressProtocol:profile.yunexpressProtocol};
    await expect(withTenant(database.db,context,tx=>accounts.credentialsForRoute(tx,context,account.versionId,{...routeProfile,yunexpressProtocol:"oms"}))).rejects.toThrow("接口协议");
    const route=await s.service.saveConnection(context,{expectedVersion:0,profile:routeProfile,accountVersionId:account.versionId,idempotencyKey:randomUUID()});
    const [version]=await withTenant(database.db,context,tx=>tx.select().from(logisticsConnectionVersions).where(eq(logisticsConnectionVersions.connectionId,route.connectionId)));
    expect(version!.profile.yunexpressProtocol).toBe("openapi");expect(vault.withSecret(version!.encryptedCredentials,value=>JSON.parse(value).sourceKey)).toBe("synthetic-private-source");
    await expect(accounts.save(context,{accountId:saved.accountId,expectedVersion:1,profile:{...profile,baseUrl:null,yunexpressProtocol:"oms"},idempotencyKey:randomUUID()})).rejects.toThrow("切换接口协议");
    expect(s.profile.yunexpressProtocol).toBeUndefined();expect(s.carrier.creates).toBe(0);
  });
  it("keeps the original whole-order reference for factory pull and rejects partial quantities",async()=>{
    const s=await setup(),p=await production(s.factory,undefined,2),input=taskInput(s,p);
    await expect(s.service.createTask(context,input)).rejects.toThrow("整单合包");
    const second=await production(s.factory,p.order.id);input.productionOrderIds.push(second.id);input.packages[0]!.declarations[0]!.quantity=2;
    const task=await s.service.createTask(context,input);expect(await s.service.get(context,task.taskId)).toMatchObject({externalReference:p.order.externalOrderId});
    s.carrier.existing.set(p.order.externalOrderId,{providerOrderId:p.order.externalOrderId,trackingNumbers:["EXISTING"],labelUrls:[],actualCostMinor:null,actualCurrency:null});
    await s.executor.run(context,task.taskId,"purchase");await s.executor.run(context,task.taskId,"purchase");
    expect(await s.service.get(context,task.taskId)).toMatchObject({status:"attention",diagnostic:"PROVIDER_REFERENCE_CONFLICT"});expect(s.carrier.creates).toBe(0);expect(s.carrier.labelRequests).toBe(0);
  });
  async function advanceLabelPoll(taskId:string){await withTenant(database.db,context,tx=>tx.update(logisticsTasks).set({updatedAt:new Date(Date.now()-11_000)}).where(eq(logisticsTasks.id,taskId)));}
  it("waits for ShipOS asynchronous labels, bounds polling and only completes a real factory pull label",async()=>{
    const carrier=new Carrier();carrier.asyncLabels=true;carrier.pendingLabels=true;const s=await setup(carrier),task=await s.service.createTask(context,taskInput(s,await production(s.factory)));
    expect(await s.executor.run(context,task.taskId,"purchase")).toMatchObject({status:"created",retryAfterMs:30000});expect(carrier.labelRequests).toBe(0);
    await s.executor.run(context,task.taskId,"reconcile");expect(carrier.labelRequests).toBe(0);
    await advanceLabelPoll(task.taskId);expect(await s.executor.run(context,task.taskId,"reconcile")).toMatchObject({status:"label_requesting",retryAfterMs:30000});expect(carrier.labelRequests).toBe(1);
    await s.executor.run(context,task.taskId,"reconcile");expect(carrier.labelRequests).toBe(1);
    carrier.pendingLabels=false;await advanceLabelPoll(task.taskId);await s.executor.run(context,task.taskId,"reconcile");
    expect(await s.service.get(context,task.taskId)).toMatchObject({status:"completed",labelCount:0});expect(carrier.labelRequests).toBe(2);expect(carrier.creates).toBe(1);expect(carrier.downloads).toBe(0);
  });
  it("stops unresolved label issuance and never repeats an uncertain issuance",async()=>{
    const carrier=new Carrier();carrier.asyncLabels=true;carrier.pendingLabels=true;const s=await setup(carrier),task=await s.service.createTask(context,taskInput(s,await production(s.factory)));
    await s.executor.run(context,task.taskId,"purchase");await advanceLabelPoll(task.taskId);await s.executor.run(context,task.taskId,"reconcile");
    await withTenant(database.db,context,tx=>tx.update(logisticsTasks).set({labelRequestedAt:new Date(Date.now()-601_000)}).where(eq(logisticsTasks.id,task.taskId)));
    await s.executor.run(context,task.taskId,"reconcile");expect(await s.service.get(context,task.taskId)).toMatchObject({diagnostic:"LABEL_GENERATION_TIMEOUT"});expect(carrier.labelRequests).toBe(1);
    carrier.pendingLabels=false;carrier.loseLabelResponse=true;const second=await s.service.createTask(context,taskInput(s,await production(s.factory)));
    await s.executor.run(context,second.taskId,"purchase");await advanceLabelPoll(second.taskId);await s.executor.run(context,second.taskId,"reconcile");
    const requests=carrier.labelRequests;await s.executor.run(context,second.taskId,"reconcile");expect(carrier.labelRequests).toBe(requests);expect(await s.service.get(context,second.taskId)).toMatchObject({diagnostic:"LABEL_ISSUANCE_NOT_CONFIRMED"});
  });
  it("only quotes while automation is disabled and blocks a deadline with no eligible channel",async()=>{const s=await setup(new Carrier(),"US",1000000,1000,false),r=await s.service.createTask(context,taskInput(s,await production(s.factory)));await s.executor.run(context,r.taskId,"purchase");expect(await s.service.get(context,r.taskId)).toMatchObject({status:"quoted"});expect(s.carrier.creates).toBe(0);const enabled=await setup(),p=await production(enabled.factory),r2=await enabled.service.createTask(context,{...taskInput(enabled,p),deliverBy:future(3)});await enabled.executor.run(context,r2.taskId,"purchase");expect(await enabled.service.get(context,r2.taskId)).toMatchObject({status:"attention",diagnostic:"NO_ELIGIBLE_CHANNEL"});expect(enabled.carrier.creates).toBe(0);});
  it("pins the native pillow size channel, permits an operator override and blocks duplicate spreadsheet dispatch",async()=>{
    const carrier=new Carrier();carrier.channelRows=[{code:"THPHR",name:"Synthetic special"},{code:"ZBZXRPH",name:"Synthetic medium"}];
    const s=await setup(carrier,"CN"),p=await production(s.factory);
    const documents=new LogisticsDocumentsService(database,pii,audit,{} as OrderProductionDeliveryService);
    const key=Buffer.alloc(32,53),draft={printProfileVersionId:null,specificationVersionId:p.specificationVersionId,fields:[],images:[],instructions:"",customerApprovalRequired:false,dueAt:null};
    await withTenant(database.db,context,async tx=>{
      await tx.insert(orderWorkItems).values({id:p.order.lines[0]!.id,tenantId:context.tenantId,revision:1,encryptedDataKey:pii.encrypt(key.toString("base64")),expiresAt:new Date(future(1))});
      await tx.insert(orderWorkRevisions).values({id:createEntityId(),tenantId:context.tenantId,workItemId:p.order.lines[0]!.id,revision:1,encryptedDraft:sealWork(key,draft),checksum:sha(JSON.stringify(draft)),createdBy:context.userId});
    });key.fill(0);
    const packing=await documents.saveProfile(context,{factoryId:s.factory.id,expectedVersion:0,idempotencyKey:randomUUID(),profile:{
      name:"Synthetic measured packing",route:"yunexpress",productionAdapter:"yicai_folder",originCountryCode:"CN",destinationCountries:["US"],originCompany:"Synthetic",factoryCode:"TEST",carrierProvider:"yunexpress",carrierService:"",useAccountSender:true,evidence:"Synthetic confirmed package measurements",
      specifications:[{specificationVersionId:p.specificationVersionId,productKind:"shaped_pillow",sizeIn:22,supplierSku:"CP-22",weight:1.19,weightUnit:"lb",length:18,width:7,height:7,dimensionUnit:"in",declaredUnitValueMinor:800,nameEn:"Pillow",nameCn:"抱枕",hsCode:""}]
    }});
    const selection={profileVersionId:packing.id,adapter:"yunexpress" as const,orderIds:[p.order.id],overrides:[],deliveryPackageIds:[]},preview=await documents.preview(context,selection);
    expect(preview.ready).toBe(true);
    const exported=await documents.generate(context,{...selection,expectedFingerprint:preview.fingerprint,idempotencyKey:randomUUID()});
    const task=await s.service.createTask(context,taskInput(s,p));
    const [stored]=await withTenant(database.db,context,tx=>tx.select().from(logisticsTasks).where(eq(logisticsTasks.id,task.taskId)));
    expect(pii.withSecret(stored!.encryptedSnapshot!,secret=>JSON.parse(secret))).toMatchObject({channelCode:"ZBZXRPH",routingDocumentProfileVersionId:packing.id});
    const blocked=await documents.preview(context,selection);expect(blocked.ready).toBe(false);expect(blocked.orders[0]!.blockers).toContain("本单已有 API 物流任务 请核对原任务面单 避免再次导表下单");
    expect((await documents.preview(context,selection)).fingerprint).toBe(blocked.fingerprint);
    await expect(documents.download(context,exported.id)).rejects.toThrow();
    const next=await production(s.factory),manual=await s.service.createTask(context,{...taskInput(s,next),channelCode:"THPHR"});
    const [manualStored]=await withTenant(database.db,context,tx=>tx.select().from(logisticsTasks).where(eq(logisticsTasks.id,manual.taskId)));
    const snapshot=pii.withSecret(manualStored!.encryptedSnapshot!,secret=>JSON.parse(secret));expect(snapshot.channelCode).toBe("THPHR");expect(snapshot.routingDocumentProfileVersionId).toBeUndefined();
    expect(carrier.creates).toBe(0);
  });
});
