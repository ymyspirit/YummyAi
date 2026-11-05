import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { FactoryDocumentProfileSchema, type DocumentOrderSource, type DocumentProfileView } from "@yummyai/contracts/logistics/documents";
import type { FulfillmentRouteView } from "@yummyai/contracts/order/fulfillment-flow";
import type { FactoryCapacityWorkspace } from "@yummyai/contracts/suppliers/factory-capacity";
import { matchFulfillmentRoute, planFlowCapacity, planFlowParcel } from "./fulfillment-flow-planning.js";

function fixture(country="US",size=12) {
  const specificationVersionId=createEntityId(),factoryId=createEntityId();
  const profile:DocumentProfileView={id:createEntityId(),factoryId,factoryVersionId:createEntityId(),version:1,
    profile:FactoryDocumentProfileSchema.parse({name:"Synthetic pillow parcel",route:country==="US"?"printeque":"yunexpress",
      productionAdapter:country==="US"?"printeque_factory":"yicai_folder",originCountryCode:country==="US"?"US":"CN",
      destinationCountries:[country],originCompany:"Synthetic supplier",factoryCode:"TEST",carrierProvider:"ShipOS",
      carrierService:"",useAccountSender:country!=="US",evidence:"Synthetic verified parcel source",
      specifications:[{specificationVersionId,productKind:"shaped_pillow",sizeIn:size,supplierSku:"CP-12",weight:0.31,weightUnit:"lb",
        length:10,width:5,height:5,dimensionUnit:"in",declaredUnitValueMinor:800,nameEn:"Custom pillow",nameCn:"抱枕",hsCode:country==="US"?"":"940490"}]})};
  const order:DocumentOrderSource={id:createEntityId(),orderNumber:"111-0000000-0000000",
    address:{recipient:"Synthetic Buyer",countryCode:country,address1:"1 Synthetic Street",address2:"",city:"Example",
      region:country==="US"?"California":"Ontario",postalCode:country==="US"?"90640":"K1A0B1",phone:"1234567890",email:""},
    lines:[{id:createEntityId(),externalLineId:"synthetic-one",quantity:1,skuCode:"changed-selling-sku",specificationVersionId,specificationName:"12in"}]};
  const route:FulfillmentRouteView={id:createEntityId(),version:1,profile:{name:"Synthetic route",documentProfileVersionId:profile.id,
    connectionId:createEntityId(),mode:"quote",productionDays:2,autoWriteback:false},factoryId,factoryName:"Synthetic factory",supplierName:"Synthetic supplier",
    countries:[country],products:["Synthetic pillow"],connectionName:"Synthetic account",blockers:[]};
  return {profile,order,route};
}
describe("whole-order fulfillment planning",()=>{
  it("matches reviewed specifications and destination independently of seller SKU",()=>{
    const {profile,order,route}=fixture();
    expect(matchFulfillmentRoute(order,[route],[profile]).route?.id).toBe(route.id);
    order.lines[0]!.skuCode="another-new-seller-sku";
    expect(matchFulfillmentRoute(order,[route],[profile]).route?.id).toBe(route.id);
    order.address.countryCode="CA";
    expect(matchFulfillmentRoute(order,[route],[profile]).route).toBeNull();
  });
  it("refuses ambiguous, missing and partially mapped whole orders",()=>{
    const {profile,order,route}=fixture();
    expect(matchFulfillmentRoute(order,[route,{...route,id:createEntityId()}],[profile]).route).toBeNull();
    order.lines.push({...order.lines[0]!,id:createEntityId(),specificationVersionId:createEntityId()});
    expect(matchFulfillmentRoute(order,[route],[profile]).route).toBeNull();
    expect(matchFulfillmentRoute(order,[{...route,profile:{...route.profile,mode:"disabled"}}],[profile]).route).toBeNull();
  });
  it("packs all items once, preserves length, sums weight and combines repeated SKU quantities",()=>{
    const {profile,order}=fixture();
    order.lines[0]!.quantity=2;
    order.lines.push({...order.lines[0]!,id:createEntityId(),externalLineId:"synthetic-two",quantity:1});
    const result=planFlowParcel(order,profile);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]!.declarations).toMatchObject([{sku:"changed-selling-sku",quantity:3,unitPriceMinor:800,hsCode:""}]);
    expect(result.packages[0]!.dimensionsMm).toEqual({length:254,width:254,height:254});
    expect(result.packages[0]!.weightGrams).toBeGreaterThanOrEqual(0.93*453.59237);
  });
  it.each([[20,"THPHR"],[22,"ZBZXRPH"]])("routes Canada pillow size %s to %s",(size,code)=>{
    const {profile,order}=fixture("CA",size as number);
    expect(planFlowParcel(order,profile).channelCode).toBe(code);
  });
  it("rejects invalid YunExpress names, missing customs data and oversized packages",()=>{
    const ca=fixture("CA");ca.order.address.recipient="Buyer";
    expect(()=>planFlowParcel(ca.order,ca.profile)).toThrow();
    ca.order.address.recipient="Synthetic Buyer";ca.profile.profile.specifications[0]!.hsCode="";
    expect(()=>planFlowParcel(ca.order,ca.profile)).toThrow("海关编码");
    const us=fixture();us.profile.profile.specifications[0]!.length=25;
    expect(()=>planFlowParcel(us.order,us.profile)).toThrow();
  });
  it("allocates shared capacity across the entire order without overbooking or invented capacity",()=>{
    const poolId=createEntityId(),versionId=createEntityId(),capabilityVersionId=createEntityId();
    const calendar={pools:[{id:poolId,versionId,profile:{status:"active",bindings:[{capabilityVersionId,unitsPerItem:1}]}}],
      calendar:[{poolId,poolVersionId:versionId,localDate:"2026-11-06",blockers:[],availableUnits:3,intervals:[{start:"2026-11-06T08:00:00.000Z",end:"2026-11-06T17:00:00.000Z"}]}]} as unknown as FactoryCapacityWorkspace;
    const items=[{lineId:createEntityId(),capabilityVersionId,quantity:2},{lineId:createEntityId(),capabilityVersionId,quantity:1}];
    expect(planFlowCapacity(calendar,items,new Date("2026-11-07T00:00:00.000Z")).plans.size).toBe(2);
    expect(()=>planFlowCapacity(calendar,[...items,{...items[0]!,lineId:createEntityId()}],new Date("2026-11-07T00:00:00.000Z"))).toThrow("没有足够");
    expect(()=>planFlowCapacity({...calendar,pools:[]},items,new Date("2026-11-07T00:00:00.000Z"))).toThrow("尚未配置");
  });
});
