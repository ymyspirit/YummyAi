import { describe,expect,it,vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { LogisticsConnectionProfileSchema,LogisticsTaskSnapshotSchema,type LogisticsQuote } from "@yummyai/contracts/logistics";
import { HttpLogisticsGateway } from "./gateway.js";
import { recommendYunexpressChannel } from "./document-planning.js";
export const logisticsFixtureProfile=(provider:"shipos"|"yunexpress"="shipos")=>LogisticsConnectionProfileSchema.parse({name:"Synthetic connection",provider,factoryId:createEntityId(),originCountryCode:provider==="shipos"?"US":"CN",sender:{name:"Synthetic sender",address1:"1 Test Street",city:"Test City",region:"CA",postalCode:"00000",countryCode:provider==="shipos"?"US":"CN",phone:"1234567890",email:"fixture@example.invalid"},baseUrl:provider==="shipos"?"https://api.shipos.cn":"https://oms.example.invalid",currency:"USD",currencySource:"Synthetic account currency confirmation",labelHosts:["labels.example.invalid"],channels:[{code:"fixture",name:"Synthetic channel",countryCodes:["US"],transitDaysMin:3,transitDaysMax:5,transitSource:"Confirmed calendar-day maximum including weekends",conditionsVerified:true,conditionsEvidence:"Synthetic service conditions checked",maxWeightGrams:10000,maxDimensionMm:1000}],apiCompatibilityEvidence:"Synthetic compatibility evidence",purchasePermissionEvidence:"Synthetic account purchase permission",labelMode:provider==="shipos"?"factory_pull":"include"});
export const logisticsFixtureTask=()=>LogisticsTaskSnapshotSchema.parse({orderId:createEntityId(),productionOrderIds:[createEntityId()],connectionId:createEntityId(),packages:[{weightGrams:500,dimensionsMm:{length:300,width:200,height:100},evidence:"Measured synthetic package",containsBattery:false,declarations:[{sku:"FIXTURE",nameEn:"Synthetic pillow",nameCn:"测试抱枕",quantity:1,unitPriceMinor:1000,currency:"USD",unitWeightGrams:400,hsCode:"940490",originCountryCode:"CN"}]}],readyAt:new Date(Date.now()+86400000).toISOString(),latestShipAt:new Date(Date.now()+2*86400000).toISOString(),deliverBy:new Date(Date.now()+10*86400000).toISOString(),deadlineSource:"Synthetic platform requirement",expectedOrderSequence:1,factoryId:createEntityId(),factoryVersionId:createEntityId(),connectionVersionId:createEntityId(),ruleVersionId:createEntityId(),recipient:{name:"Synthetic buyer",address1:"2 Test Street",city:"Test City",region:"CA",postalCode:"00000",countryCode:"US",phone:"1234567890",email:"buyer@example.invalid"},productionPins:[{productionOrderId:createEntityId(),versionId:createEntityId(),lineId:createEntityId(),quantity:1}],addressEnvelopeVersion:1,retentionExpiresAt:new Date(Date.now()+20*86400000).toISOString()});
const environment={YUNEXPRESS_ALLOWED_ORIGINS:"https://oms.example.invalid",LOGISTICS_LABEL_ALLOWED_HOSTS:"labels.example.invalid"};
const credentials={provider:"yunexpress" as const,customerCode:"synthetic",apiSecret:"fixture-secret"};
const q:LogisticsQuote={channelCode:"fixture",channelName:"Synthetic channel",totalMinor:500,currency:"USD",currencySource:"Synthetic account confirmation",transitDaysMin:3,transitDaysMax:5,transitSource:"Synthetic SLA",conditionsVerified:true,priceSource:"fixture",quotedAt:new Date().toISOString(),diagnostic:null};
describe("supported carrier transports",()=>{
  it("reuses the confirmed Yun size strategy independently of the sales SKU",()=>{
    expect(recommendYunexpressChannel([{productKind:"shaped_pillow",sizeIn:20}])).toBe("THPHR");
    expect(recommendYunexpressChannel([{productKind:"shaped_pillow",sizeIn:20},{productKind:"shaped_pillow",sizeIn:22}])).toBe("ZBZXRPH");
    expect(recommendYunexpressChannel([{productKind:"custom_hanger",sizeIn:null}])).toBe("THPHR");
    expect(recommendYunexpressChannel([{productKind:"shaped_pillow",sizeIn:null}])).toBeNull();expect(recommendYunexpressChannel([undefined])).toBeNull();
  });
  it("sends the official Yun OMS batch envelope and reconciles the exact customer reference",async()=>{const seen:unknown[]=[];const fetcher=vi.fn(async(_u:string|URL|Request,init?:RequestInit)=>{seen.push(JSON.parse(String(init?.body)));expect((init?.headers as Record<string,string>).authorization).toMatch(/^Basic /);return Response.json({Code:"0000",Item:[{CustomerOrderNumber:"YMYfixture",Success:1,WayBillNumber:"WB1",TrackingNumber:"TRACK1"}]});});const g=new HttpLogisticsGateway(fetcher as typeof fetch,environment);expect(await g.create(logisticsFixtureProfile("yunexpress"),credentials,logisticsFixtureTask(),"YMYfixture",q)).toMatchObject({providerOrderId:"WB1",trackingNumbers:["TRACK1"]});expect(seen).toMatchObject([[{CustomerOrderNumber:"YMYfixture",Parcels:[{SKU:"FIXTURE",HSCode:"940490",UnitPrice:10,CurrencyCode:"USD"}]}]]);});
  it("preserves the verified calendar SLA when OMS DeliveryDays is missing",async()=>{const fetcher=vi.fn(async(u:string|URL|Request)=>Response.json(String(u).includes("GetShippingMethods")?{Code:"0000",Items:[{Code:"fixture",DisplayName:"Synthetic"}]}:{Code:"0000",Items:[{Code:"fixture",TotalFee:5.12,DeliveryDays:null}]}));const g=new HttpLogisticsGateway(fetcher as typeof fetch,environment);const quotes=await g.quote(logisticsFixtureProfile("yunexpress"),credentials,logisticsFixtureTask(),"YMYfixture");expect(quotes[0]).toMatchObject({totalMinor:512,currency:"USD",transitDaysMax:5,currencySource:"Synthetic account currency confirmation"});});
  it("never switches away from a pinned order-specific channel during repricing",async()=>{
    const profile=logisticsFixtureProfile("yunexpress");profile.channels.push({...profile.channels[0]!,code:"large"});
    const task=logisticsFixtureTask();task.channelCode="large";
    const fetcher=vi.fn(async(url:unknown)=>Response.json(String(url).includes("GetShippingMethods")?{Code:"0000",Items:[{Code:"fixture",DisplayName:"Cheapest"},{Code:"large",DisplayName:"Large parcel"}]}:{Code:"0000",Items:[{Code:"fixture",TotalFee:1},{Code:"large",TotalFee:5}]}));
    const gateway=new HttpLogisticsGateway(fetcher as typeof fetch,environment);
    expect((await gateway.quote(profile,credentials,task,"REF")).map(quote=>quote.channelCode)).toEqual(["large"]);
    await expect(gateway.create(profile,credentials,task,"REF",q)).rejects.toThrow("PACKAGE_EXCEEDS_CHANNEL_LIMITS");
  });
  it("reads ShipOS total fee without inferring currency or provider SLA",async()=>{const fetcher=vi.fn(async(u:string|URL|Request)=>Response.json(String(u).endsWith("getChannel.php")?{code:200,data:[{id:"fixture",qudao:"Synthetic"}]}:{code:200,data:{total_fee:"3.20"}}));const g=new HttpLogisticsGateway(fetcher as typeof fetch,environment);expect((await g.quote(logisticsFixtureProfile(),{provider:"shipos",appKey:"fixture",appSecret:"fixture"},logisticsFixtureTask(),"YMYfixture"))[0]).toMatchObject({totalMinor:320,currencySource:"Synthetic account currency confirmation",transitDaysMax:5});});
  it("rejects wrong identities, mixed batch results and unknown origins",async()=>{const fetcher=vi.fn(async()=>Response.json({Code:"0000",Item:[{CustomerOrderNumber:"OTHER",Success:1,WayBillNumber:"WB1"}]}));const g=new HttpLogisticsGateway(fetcher as typeof fetch,environment);await expect(g.create(logisticsFixtureProfile("yunexpress"),credentials,logisticsFixtureTask(),"YMYfixture",q)).rejects.toThrow();expect(()=>g.assertProfile({...logisticsFixtureProfile(),baseUrl:"https://unverified.example.invalid"})).toThrow();});
  it("rejects unsafe, oversized or non-PDF label downloads",async()=>{const fetcher=vi.fn(async()=>new Response("not pdf",{headers:{"content-type":"application/pdf"}}));const g=new HttpLogisticsGateway(fetcher as typeof fetch,environment);await expect(g.downloadLabel(logisticsFixtureProfile(),"https://labels.example.invalid/test.pdf")).rejects.toThrow();await expect(g.downloadLabel(logisticsFixtureProfile(),"http://labels.example.invalid/test.pdf")).rejects.toThrow();await expect(g.downloadLabel(logisticsFixtureProfile(),"https://evil.example.invalid/test.pdf")).rejects.toThrow();});
  it("fails deterministic package and contact problems before creating an order",async()=>{const fetcher=vi.fn();const g=new HttpLogisticsGateway(fetcher,environment),task=logisticsFixtureTask();task.recipient.email=null;await expect(g.quote(logisticsFixtureProfile(),{provider:"shipos",appKey:"fixture",appSecret:"fixture"},task,"YMYfixture")).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();});
  it("uses official ShipOS field names and normalized state without changing the reference",async()=>{
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));expect(body).toMatchObject({orderid:"SYN-ORDER",module:2,channel_id:"fixture",to_address:{state:"CA",postcode:"00000"},shenbao:[{origin:"CN"}]});expect(body.channelid).toBeUndefined();expect(body.to_address.postal).toBeUndefined();expect(body.shenbao[0].cz).toBeUndefined();return Response.json({code:200,data:{orderid:body.orderid}});});
    const task=logisticsFixtureTask();task.recipient.region="California";
    expect(await new HttpLogisticsGateway(fetcher as typeof fetch,environment).create(logisticsFixtureProfile(),{provider:"shipos",appKey:"synthetic",appSecret:"fixture"},task,"SYN-ORDER",q)).toMatchObject({providerOrderId:"SYN-ORDER",labelUrls:[]});
  });
  it("reads channels without requiring factory, sender or label settings",async()=>{
    const fetcher=vi.fn(async(url:unknown,init?:RequestInit)=>{expect(String(url)).toBe("https://api.shipos.cn/api/getChannel.php");expect(JSON.parse(String(init?.body))).toEqual({module:2});return Response.json({code:200,data:[{id:10,qudao:"Synthetic channel"}]});});
    const gateway=new HttpLogisticsGateway(fetcher as typeof fetch,environment);
    expect(await gateway.accountChannels({provider:"shipos",baseUrl:"https://api.shipos.cn"},{provider:"shipos",appKey:"fixture",appSecret:"fixture"})).toEqual([{code:"10",name:"Synthetic channel"}]);
    for(const baseUrl of [null,"http://api.shipos.cn","https://api.shipos.cn.evil.invalid","https://api.shipos.cn/?key=secret"]){await expect(gateway.accountChannels({provider:"shipos",baseUrl},{provider:"shipos",appKey:"fixture",appSecret:"fixture"})).rejects.toThrow();}
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("distinguishes official pending labels and extracts nested PDF and tracking fields",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({code:300,msg:"generating"})).mockResolvedValueOnce(Response.json({code:200,data:{orderid:"SYN-ORDER",source:{trackingNo:"TRACK1",lables:[{pdf:"https://labels.example.invalid/one.pdf"}]}}}));
    const gateway=new HttpLogisticsGateway(fetcher,environment),credentials={provider:"shipos" as const,appKey:"fixture",appSecret:"fixture"};
    await expect(gateway.labels(logisticsFixtureProfile(),credentials,"SYN-ORDER")).rejects.toMatchObject({code:"LABEL_PENDING"});
    expect(await gateway.labels(logisticsFixtureProfile(),credentials,"SYN-ORDER")).toMatchObject({trackingNumbers:["TRACK1"],labelUrls:["https://labels.example.invalid/one.pdf"]});
  });
  it("checks the sum of all three sides again before purchase and rounds converted units upward",async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({Code:"0000",Item:[{CustomerOrderNumber:"REF",Success:1,WayBillNumber:"W1"}]}));
    const gateway=new HttpLogisticsGateway(fetcher as typeof fetch,environment),profile=logisticsFixtureProfile("yunexpress"),task=logisticsFixtureTask();
    profile.channels[0]!.maxSumDimensionsMm=610;task.packages[0]!.dimensionsMm.length=300.2;task.packages[0]!.weightGrams=140.61;
    await gateway.create(profile,credentials,task,"REF",q);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))[0]).toMatchObject({Weight:"0.141",Length:"31",Receiver:{FirstName:"Synthetic",LastName:"buyer"}});
    profile.channels[0]!.maxSumDimensionsMm=609;
    await expect(gateway.create(profile,credentials,task,"REF",q)).rejects.toThrow("PACKAGE_EXCEEDS_CHANNEL_LIMITS");expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("caps GOFO and USPS using live channel identities even when configured limits are too large",async()=>{
    const profile=logisticsFixtureProfile();profile.channels=[{...profile.channels[0]!,code:"gofo"},{...profile.channels[0]!,code:"usps"}];
    const fetcher=vi.fn(async(url:unknown)=>Response.json(String(url).endsWith("getChannel.php")?{code:200,data:[{id:"gofo",qudao:"GOFO test"},{id:"usps",qudao:"usps_ground_advantage"}]}:{code:200,data:{total_fee:"5.00"}}));
    const gateway=new HttpLogisticsGateway(fetcher as typeof fetch,environment),task=logisticsFixtureTask(),credentials={provider:"shipos" as const,appKey:"fixture",appSecret:"fixture"};
    task.packages[0]!.dimensionsMm={length:609.6,width:457.2,height:457.2};
    expect((await gateway.quote(profile,credentials,task,"REF")).map(q=>q.channelCode)).toEqual(["gofo"]);
    task.packages[0]!.dimensionsMm.width=457.3;expect(await gateway.quote(profile,credentials,task,"REF")).toEqual([]);
    task.packages[0]!.dimensionsMm={length:558.8,width:100,height:100};
    expect((await gateway.quote(profile,credentials,task,"REF")).map(q=>q.channelCode)).toEqual(["gofo","usps"]);
    task.packages[0]!.dimensionsMm.length=558.9;expect((await gateway.quote(profile,credentials,task,"REF")).map(q=>q.channelCode)).toEqual(["gofo"]);
  });
  it("rejects incomplete Yun recipient identity before any credential-bearing request",async()=>{
    const fetcher=vi.fn(),task=logisticsFixtureTask();task.recipient.name="Fady";
    await expect(new HttpLogisticsGateway(fetcher,environment).quote(logisticsFixtureProfile("yunexpress"),credentials,task,"REF")).rejects.toThrow("YUN_RECIPIENT_FULL_NAME_REQUIRED");expect(fetcher).not.toHaveBeenCalled();
  });
});
