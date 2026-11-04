import { describe, expect, it } from "vitest";
import { FactoryDocumentProfileSchema, GenerateOrderDocumentsSchema, type DocumentOrderSource,
  type FactoryDocumentProfile } from "@yummyai/contracts/logistics/documents";
import { planOrderDocument } from "./document-planning.js";
import { balancedParcel, parcelCarrierChecks, unitWeight } from "./document-parcels.js";

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;
function profile(): FactoryDocumentProfile {
  return FactoryDocumentProfileSchema.parse({ name:"Synthetic Printeque", route:"printeque", productionAdapter:"printeque_factory",
    originCountryCode:"US", destinationCountries:["US"], originCompany:"Synthetic company", factoryCode:"CA",
    carrierProvider:"ShipOS", carrierService:"", useAccountSender:false, evidence:"Synthetic specification fixture",
    specifications:[{ specificationVersionId:id(1), productKind:"shaped_pillow", sizeIn:12, supplierSku:"CP-12", weight:0.31,
      weightUnit:"lb", length:10, width:5, height:5, dimensionUnit:"in", declaredUnitValueMinor:1000,
      nameEn:"Custom pillow", nameCn:"定制抱枕", hsCode:"" }] });
}
function order(): DocumentOrderSource {
  return { id:id(2), orderNumber:"111-0000000-0000000", address:{recipient:"Synthetic Buyer", countryCode:"US",
    address1:"1 Synthetic Street", address2:"",city:"Example",region:"New York",postalCode:"00100",phone:"0012345678",email:""},
    lines:[{id:id(3),externalLineId:"synthetic-line",quantity:1,skuCode:"NEW-SELLER-SKU",specificationVersionId:id(1),specificationName:"12in",productionFileSku:"111-0000000-0000000"}] };
}
describe("order document business rules", () => {
  it("uses the pinned specification instead of guessing from a changed selling SKU", () => {
    const result = planOrderDocument("printeque_shipping", order(), profile());
    expect(result.blockers).toEqual([]);
    expect(result.rows[0]).toMatchObject({ "订单号":"111-0000000-0000000", "州/省":"NY", "商品SKU":"CP-12", "申报单价":10,
      "包裹重量":0.31, "长":10, "宽":5, "高":5, "收件人邮编":"00100", "收件人电话":"0012345678" });
  });
  it("merges multiple order items into one label and retains separate production rows", () => {
    const source = order(); source.lines[0]!.quantity = 2;
    source.lines.push({...source.lines[0]!, id:id(4),externalLineId:"synthetic-second",quantity:1,productionFileSku:"second-file"});
    const shipping = planOrderDocument("printeque_shipping", source, profile());
    expect(shipping.rows).toHaveLength(1);
    expect(shipping.rows[0]).toMatchObject({ "数量":3, "箱数":1, "包裹重量":0.93, "长":10, "宽":10, "高":10 });
    const factory = planOrderDocument("printeque_factory", source, profile());
    expect(factory.rows).toHaveLength(2);
    expect(factory.rows[0]).toMatchObject({order_number:source.orderNumber,qty:2,weight:0.62,tracking_number:""});
    expect(factory.rows[1]).toMatchObject({order_number:source.orderNumber,qty:1,sku:"second-file"});
  });
  it("blocks a missing specification instead of exporting a default size", () => {
    const source = order(); source.lines[0]!.specificationVersionId = null;
    expect(planOrderDocument("printeque_shipping",source,profile()).blockers.join()).toContain("规格尚未关联");
  });
  it("preserves length and balances non-square cells without shrinking mixed-size units", () => {
    expect(balancedParcel([{length:20,width:8,height:6,quantity:3},{length:10,width:5,height:5,quantity:1}]))
      .toMatchObject({lengthIn:20,widthIn:16,heightIn:12,columns:2,rows:2});
    expect(() => balancedParcel([{length:10,width:5,height:5,quantity:1.5}])).toThrow();
  });
  it("checks both carriers at exact boundaries and refuses a partially eligible auto-price export", () => {
    expect(parcelCarrierChecks(22,20,18)).toMatchObject({gofo:true,usps:true});
    expect(parcelCarrierChecks(24,20,16)).toMatchObject({gofo:true,usps:false});
    expect(parcelCarrierChecks(22,20,18.001)).toMatchObject({gofo:false,usps:true});
    const p = profile(); p.specifications[0]!.length = 24;
    expect(planOrderDocument("printeque_shipping",order(),p).blockers.join()).toContain("USPS 尺寸超限");
  });
  it("requires explicit mixed-SKU and price decisions for a shared Printeque label", () => {
    const p = profile(); p.specifications.push({...p.specifications[0]!,specificationVersionId:id(5),supplierSku:"CP-14",declaredUnitValueMinor:1200});
    const o = order(); o.lines.push({...o.lines[0]!,id:id(6),externalLineId:"mixed",specificationVersionId:id(5)});
    const result = planOrderDocument("printeque_shipping",o,p);
    expect(result.blockers.join()).toContain("不同工厂 SKU");
    expect(result.blockers.join()).toContain("单价不同");
  });
  it("never creates a factory row without an approved delivery file association", () => {
    const o = order(); delete o.lines[0]!.productionFileSku;
    expect(planOrderDocument("printeque_factory",o,profile()).blockers.join()).toContain("正式生产交付文件");
  });
  it("converts each unit to kg before multiplying and chooses medium parcel only above 20 in", () => {
    const p = profile(); p.route="yunexpress";p.productionAdapter="yicai_folder";p.originCountryCode="CN";
    p.destinationCountries=["CA"];p.useAccountSender=true;p.specifications[0]!.declaredUnitValueMinor=800;p.specifications[0]!.sizeIn=20;
    const o = order();o.address.countryCode="CA";o.address.region="Ontario";o.lines[0]!.quantity=3;
    expect(unitWeight(p.specifications[0]!,"kg")).toBe(0.141);
    const result=planOrderDocument("yunexpress",o,p);
    expect(result.blockers).toEqual([]);
    expect(result.rows[0]).toMatchObject({"产品代码":"THPHR","包裹总重量":0.423,"申报FOB价1":8,"申报单重1":0.141,"申报数量1":3});
    p.specifications[0]!.sizeIn=22;
    expect(planOrderDocument("yunexpress",o,p).rows[0]!["产品代码"]).toBe("ZBZXRPH");
    expect(planOrderDocument("yunexpress",o,p,{orderId:o.id,channelCode:"THPHR",reason:"Operator verified channel"}).rows[0]!["产品代码"]).toBe("THPHR");
    expect(Object.keys(result.rows[0]!)).not.toEqual(expect.arrayContaining(["SKU1","配货信息1","规格1","申报品名2"]));
  });
  it("requires a real full name only for YunExpress and preserves invalid input", () => {
    const p=profile();p.route="yunexpress";p.productionAdapter="none";p.originCountryCode="CN";p.useAccountSender=true;
    const o=order();o.address.recipient="Fady";
    const result=planOrderDocument("yunexpress",o,p);
    expect(result.blockers.join()).toContain("真实完整姓名");
    expect(result.rows[0]!["收件人姓名"]).toBe("Fady");
    expect(planOrderDocument("printeque_shipping",o,profile()).blockers).toEqual([]);
  });
  it("rejects incompatible YunExpress declaration groups rather than dropping a second item", () => {
    const p=profile();p.route="yunexpress";p.productionAdapter="none";p.originCountryCode="CN";p.useAccountSender=true;
    p.specifications.push({...p.specifications[0]!,specificationVersionId:id(5),weight:0.53});
    const o=order();o.lines.push({...o.lines[0]!,id:id(6),externalLineId:"mixed",specificationVersionId:id(5)});
    expect(planOrderDocument("yunexpress",o,p).blockers.join()).toContain("申报品名、单价或单重不同");
  });
  it("rejects duplicated order selections in both preview and generate contracts", () => {
    expect(GenerateOrderDocumentsSchema.safeParse({profileVersionId:id(8),orderIds:[id(2),id(2)],adapter:"printeque_shipping",
      expectedFingerprint:"a".repeat(64),idempotencyKey:"00000000-0000-4000-8000-000000000000"}).success).toBe(false);
  });
});
