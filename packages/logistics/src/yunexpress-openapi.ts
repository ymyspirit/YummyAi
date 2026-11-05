import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { LogisticsAccountProfile, LogisticsAddress, LogisticsConnectionProfile, LogisticsCredentials, LogisticsQuote, LogisticsTaskSnapshot } from "@yummyai/contracts/logistics";
import { normalizeDocumentRegion } from "./document-address.js";
import type { LogisticsProviderResult } from "./gateway.js";
import { decimalMinor } from "./policy.js";
import { boundedBody, LogisticsTransportError } from "./transport.js";

type Account = Pick<LogisticsAccountProfile, "provider" | "baseUrl" | "yunexpressProtocol">;
type Credentials = Extract<LogisticsCredentials, {provider:"yunexpress"}>;
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const string = (value: unknown) => typeof value === "string" ? value : "";
const identifier = (value: unknown) => z.string().regex(/^[A-Za-z0-9_.-]{1,150}$/).parse(value);
const currency = (value: unknown) => value === "RMB" ? "CNY" : z.string().regex(/^[A-Z]{3}$/).parse(value);
// Preserve the carrier's three-decimal units without understating measurements.
const kg = (grams: number) => Math.ceil(grams) / 1000;
const cm = (mm: number) => Math.ceil(Math.round(mm * 100 * 1e9) / 1e9) / 1000;
type Token = {value: string; expiresAt: number};

/** Official OpenAPI protocol. Never falls back to OMS or retries an uncertain write. */
export class YunexpressOpenApi {
  private readonly tokens = new Map<string, Token>();
  private readonly pendingTokens = new Map<string, Promise<Token>>();
  constructor(private readonly fetcher: typeof fetch) {}
  private credentials(c: LogisticsCredentials): Credentials {
    if (c.provider !== "yunexpress" || !c.appId || !c.sourceKey) throw new Error("YUN_OPENAPI_CREDENTIALS_REQUIRED");
    return c;
  }
  private tokenKey(p: Account, c: Credentials) {
    return createHash("sha256").update(JSON.stringify([p.baseUrl,c.appId,c.apiSecret,c.sourceKey])).digest("hex");
  }
  private async exchange(url: URL, init: RequestInit) {
    let response: Response;
    try { response = await this.fetcher(url.href, {...init, redirect:"error", signal:AbortSignal.timeout(12000)}); }
    catch { throw new LogisticsTransportError("TRANSPORT_UNCERTAIN"); }
    let data: Record<string, unknown>;
    try { data = object(JSON.parse((await boundedBody(response,1024*1024)).toString("utf8"))); }
    catch { throw new LogisticsTransportError(response.ok ? "INVALID_RESPONSE" : "TRANSPORT_UNCERTAIN"); }
    const providerCode = /^\d{8,12}$/.test(string(data.code)) ? string(data.code) : undefined;
    if (!response.ok || data.success === false) throw new LogisticsTransportError(response.status >= 500 || response.status === 408 ? "TRANSPORT_UNCERTAIN" : "PROVIDER_REJECTED", providerCode);
    return data;
  }
  private async token(p: Account, c: Credentials): Promise<Token> {
    const key = this.tokenKey(p,c), cached = this.tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const pending = this.pendingTokens.get(key); if (pending) return pending;
    const request = (async () => {
      const data = await this.exchange(new URL("/openapi/oauth2/token",p.baseUrl!), {method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({grantType:"client_credentials",appId:c.appId,appSecret:c.apiSecret,sourceKey:c.sourceKey})});
      const value = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/).parse(data.accessToken), seconds = z.number().int().positive().max(86400).parse(data.expiresIn);
      const token = {value,expiresAt:Date.now()+Math.max(0,seconds-30)*1000};
      for (const [oldKey,old] of this.tokens) if (old.expiresAt<=Date.now()) this.tokens.delete(oldKey);
      if (this.tokens.size>=64) this.tokens.delete(this.tokens.keys().next().value!);
      this.tokens.set(key,token); return token;
    })();
    this.pendingTokens.set(key,request);
    try { return await request; } finally { this.pendingTokens.delete(key); }
  }
  async request(p: Account, credentials: LogisticsCredentials, method:"GET"|"POST", path:string, body?:unknown, query?:Record<string,string>) {
    const c=this.credentials(credentials), serialized=body===undefined?undefined:JSON.stringify(body);
    const url=new URL(path,p.baseUrl!);for(const [key,value] of Object.entries(query??{}))url.searchParams.set(key,value);
    for(let attempt=0;attempt<2;attempt++) {
      const token=await this.token(p,c), date=String(Date.now());
      // Sign the documented URI pathname; verified against a live GET with query parameters.
      const canonical=`${serialized===undefined?"":`body=${serialized}&`}date=${date}&method=${method}&uri=${url.pathname}`;
      const sign=createHmac("sha256",c.apiSecret).update(canonical,"utf8").digest("base64");
      try {
        const data=await this.exchange(url,{method,headers:{"content-type":"application/json;charset=utf-8",accept:"application/json","accept-language":"zh-CN",token:token.value,date,sign},...(serialized===undefined?{}:{body:serialized})});
        if(data.success!==true)throw new LogisticsTransportError("INVALID_RESPONSE");
        return data;
      } catch(error) {
        if(error instanceof LogisticsTransportError && error.providerCode==="0200401002") {
          if(this.tokens.get(this.tokenKey(p,c))===token)this.tokens.delete(this.tokenKey(p,c));
          if(method==="GET"&&attempt===0)continue;
        }
        throw error;
      }
    }
    throw new LogisticsTransportError("PROVIDER_REJECTED");
  }
  async channels(p:Account,c:LogisticsCredentials) {
    const raw=await this.request(p,c,"GET","/v1/basic-data/products/getlist");
    const rows=z.array(z.object({product_code:z.string().min(1).max(100),product_name:z.string().min(1).max(200)})).max(1000).parse(raw.detail);
    if(new Set(rows.map(row=>row.product_code)).size!==rows.length)throw new LogisticsTransportError("INVALID_RESPONSE");
    return rows.map(row=>({code:row.product_code,name:row.product_name}));
  }
  async prices(p:LogisticsConnectionProfile,c:LogisticsCredentials,t:LogisticsTaskSnapshot) {
    const pack=t.packages[0]!;
    const raw=await this.request(p,c,"GET","/v1/price-trial/get",undefined,{country_code:t.recipient.countryCode,postal_code:t.recipient.postalCode,weight:String(kg(pack.weightGrams)),weight_unit:"KG",size_unit:"CM",package_type:"C",pieces:"1",length:String(cm(pack.dimensionsMm.length)),width:String(cm(pack.dimensionsMm.width)),height:String(cm(pack.dimensionsMm.height)),...(p.billingDepot?{origin:p.billingDepot}:{})});
    return z.array(z.unknown()).max(10000).parse(raw.result).map(object);
  }
  price(p:LogisticsConnectionProfile,channel:LogisticsConnectionProfile["channels"][number],rows:Record<string,unknown>[]):LogisticsQuote|null {
    const fees=rows.filter(row=>row.product_code===channel.code);if(!fees.length)return null;
    const bases=new Set(fees.map(row=>JSON.stringify([row.price_name,row.price_type,row.currency,row.convert_currency,row.rate])));
    if(bases.size!==1||new Set(fees.map(row=>string(row.fee_name))).size!==fees.length||fees.some(row=>!string(row.fee_name)))throw new LogisticsTransportError("INVALID_RESPONSE");
    const billingCurrency=currency(fees[0]!.currency);
    if(billingCurrency!==p.currency)throw new Error("CURRENCY_MISMATCH");
    const totalMinor=fees.reduce((sum,row)=>sum+decimalMinor(row.calculate_amount,p.minorUnitDigits),0);
    if(!Number.isSafeInteger(totalMinor))throw new LogisticsTransportError("INVALID_RESPONSE");
    const days=fees.map(row=>/^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(string(row.interval_day).trim())).filter(match=>match&&Number(match[2]??match[1])<=365&&Number(match[2]??match[1])>=Number(match[1]));
    const upper=Math.max(channel.transitDaysMax,...days.map(match=>Number(match![2]??match![1])));
    return {channelCode:channel.code,channelName:channel.name,totalMinor,currency:billingCurrency,currencySource:"YunExpress OpenAPI currency (RMB=CNY)",transitDaysMin:channel.transitDaysMin,transitDaysMax:upper,transitSource:`${channel.transitSource}; OpenAPI interval_day upper=${upper}`,conditionsVerified:channel.conditionsVerified,priceSource:"YunExpress OpenAPI price-trial sum(calculate_amount)",quotedAt:new Date().toISOString(),diagnostic:null};
  }
  assertTask(p:LogisticsConnectionProfile,t:LogisticsTaskSnapshot) {
    if(t.packages.some(pack=>pack.containsBattery))throw new Error("YUN_DANGEROUS_GOODS_REQUIRES_REVIEW");
    if(t.recipient.countryCode==="SA")throw new Error("YUN_SHORT_ADDRESS_REQUIRES_REVIEW");
    for(const a of [p.sender,t.recipient])if(a.name.length>50||a.city.length>50||a.region.length>50||a.postalCode.length>20||a.phone.length>50||a.company.length>50||(a.email?.length??0)>100)throw new Error("YUN_ADDRESS_LENGTH_REQUIRES_REVIEW");
    if(p.billingDepot.length>20)throw new Error("YUN_BILLING_DEPOT_REQUIRES_REVIEW");
    for(const pack of t.packages)for(const d of pack.declarations)if(d.sku.length>50||d.nameEn.length>50||d.nameCn.length>50||d.quantity>10000||d.unitPriceMinor/10**d.minorUnitDigits>1000000)throw new Error("YUN_DECLARATION_REQUIRES_REVIEW");
  }
  async create(p:LogisticsConnectionProfile,c:LogisticsCredentials,t:LogisticsTaskSnapshot,reference:string,q:LogisticsQuote) {
    if(!/^[A-Za-z0-9_.-]{6,50}$/.test(reference))throw new Error("YUN_ORDER_REFERENCE_REQUIRES_REVIEW");
    const raw=await this.request(p,c,"POST","/v1/order/package/create",{product_code:q.channelCode,customer_order_number:reference,receiver:address(t.recipient),...(p.yunexpressSenderMode==="platform_default"?{}:{sender:address(p.sender)}),weight_unit:"KG",size_unit:"CM",sensitive_type:"W",label_type:"PDF",packages:t.packages.map(pack=>({weight:kg(pack.weightGrams),length:cm(pack.dimensionsMm.length),width:cm(pack.dimensionsMm.width),height:cm(pack.dimensionsMm.height)})),declaration_info:t.packages.flatMap(pack=>pack.declarations.map(d=>({quantity:d.quantity,unit_price:d.unitPriceMinor/10**d.minorUnitDigits,unit_weight:kg(d.unitWeightGrams),name_en:d.nameEn,name_local:d.nameCn,sku_code:d.sku,hs_code:d.hsCode,currency:d.currency,origin_country:d.originCountryCode})))});
    return result(object(raw.result),reference);
  }
  async lookup(p:LogisticsConnectionProfile,c:LogisticsCredentials,reference:string):Promise<LogisticsProviderResult|null> {
    try{return result(object((await this.request(p,c,"GET","/v1/order/info/get",undefined,{order_number:reference})).result),reference);}
    catch(error){if(error instanceof LogisticsTransportError&&error.providerCode==="02039006")return null;throw error;}
  }
  async labels(p:LogisticsConnectionProfile,c:LogisticsCredentials,reference:string) {
    const found=await this.lookup(p,c,reference);if(!found)throw new LogisticsTransportError("LABEL_UNAVAILABLE");
    const row=object((await this.request(p,c,"GET","/v1/order/label/get",undefined,{order_number:reference})).result);
    if(![reference,found.providerOrderId,...found.trackingNumbers].includes(string(row.order_number)))throw new LogisticsTransportError("INVALID_RESPONSE");
    if(!row.url)throw new LogisticsTransportError("LABEL_PENDING");
    if(row.label_type!=="PDF"||typeof row.url!=="string")throw new LogisticsTransportError("LABEL_UNAVAILABLE");
    // Billing can post after issuance. Missing fees remain unknown, never replaced by the quote.
    let actualCostMinor:number|null=null,actualCurrency:string|null=null;
    let fee:Record<string,unknown>|undefined;
    try {fee=object((await this.request(p,c,"GET","/v1/order/fee-details/get",undefined,{waybill_number:found.providerOrderId})).result);} catch { /* optional read-only accounting */ }
    if(fee){
      if(fee.waybill_number!==found.providerOrderId||fee.customer_order_number!==reference)throw new LogisticsTransportError("INVALID_RESPONSE");
      actualCurrency=currency(fee.currency);actualCostMinor=decimalMinor(fee.total_amount,p.minorUnitDigits);
    }
    return {...found,labelUrls:[row.url],actualCostMinor,actualCurrency};
  }
}
function address(a:LogisticsAddress) {
  const parts=a.name.trim().split(/\s+/u),region=normalizeDocumentRegion(a.region,a.countryCode);
  if(!region.valid)throw new Error("RECIPIENT_REGION_REQUIRES_REVIEW");
  return {first_name:parts.shift()!,last_name:parts.join(" "),country_code:a.countryCode,province:region.value,city:a.city,address_lines:[a.address1,...(a.address2?[a.address2]:[])],postal_code:a.postalCode,phone_number:a.phone,...(a.company?{company:a.company}:{}),...(a.email?{email:a.email}:{})};
}
function result(row:Record<string,unknown>,reference:string):LogisticsProviderResult {
  if(row.customer_order_number!==reference)throw new LogisticsTransportError("INVALID_RESPONSE");
  return {providerOrderId:identifier(row.waybill_number),trackingNumbers:row.tracking_number?[identifier(row.tracking_number)]:[],labelUrls:[],actualCostMinor:null,actualCurrency:null};
}
