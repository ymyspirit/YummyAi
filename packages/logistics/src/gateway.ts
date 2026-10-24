import { z } from "zod";
import type { LogisticsAddress, LogisticsConnectionProfile, LogisticsCredentials, LogisticsQuote, LogisticsTaskSnapshot } from "@yummyai/contracts/logistics";
import { decimalMinor } from "./policy.js";
export interface LogisticsProviderResult { providerOrderId: string; trackingNumbers: string[]; labelUrls: string[]; actualCostMinor: number | null; actualCurrency: string | null }
export interface LogisticsGateway {
  channels(profile: LogisticsConnectionProfile, credentials: LogisticsCredentials): Promise<Array<{ code: string; name: string }>>;
  quote(profile: LogisticsConnectionProfile, credentials: LogisticsCredentials, task: LogisticsTaskSnapshot, externalReference: string): Promise<LogisticsQuote[]>;
  create(profile: LogisticsConnectionProfile, credentials: LogisticsCredentials, task: LogisticsTaskSnapshot, externalReference: string, quote: LogisticsQuote): Promise<LogisticsProviderResult>;
  lookup(profile: LogisticsConnectionProfile, credentials: LogisticsCredentials, externalReference: string): Promise<LogisticsProviderResult | null>;
  labels(profile: LogisticsConnectionProfile, credentials: LogisticsCredentials, externalReference: string): Promise<LogisticsProviderResult>;
  downloadLabel(profile: LogisticsConnectionProfile, url: string): Promise<Uint8Array>;
}
const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const text = (v: unknown) => typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const track = (v: unknown) => { const s = text(v); return s && /^[A-Za-z0-9_.-]{1,150}$/.test(s) ? s : null; };
export class LogisticsTransportError extends Error { constructor(public readonly code: "TRANSPORT_UNCERTAIN" | "PROVIDER_REJECTED" | "INVALID_RESPONSE" | "LABEL_UNAVAILABLE") { super(code); } }

/** Separate write adapter. The existing ShipOS read-only gateway remains unchanged. */
export class HttpLogisticsGateway implements LogisticsGateway {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly environment: NodeJS.ProcessEnv = process.env) {}
  assertProfile(profile: LogisticsConnectionProfile) {
    const url = new URL(profile.baseUrl);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("INVALID_LOGISTICS_ORIGIN");
    if (this.fixtureOrigin(url.origin)) return;
    if (url.protocol !== "https:" || url.port) throw new Error("INVALID_LOGISTICS_ORIGIN");
    if (profile.provider === "shipos" && url.origin !== "https://api.shipos.cn") throw new Error("INVALID_LOGISTICS_ORIGIN");
    if (profile.provider === "yunexpress" && !this.allowed("YUNEXPRESS_ALLOWED_ORIGINS").includes(url.origin)) throw new Error("YUNEXPRESS_ORIGIN_NOT_VERIFIED");
    const allowedLabels = ["shipease.oss-cn-hangzhou.aliyuncs.com", ...this.allowed("LOGISTICS_LABEL_ALLOWED_HOSTS")];
    if (profile.labelHosts.some(host => !allowedLabels.includes(host))) throw new Error("LABEL_HOST_NOT_VERIFIED");
  }
  private allowed(name: string) { return (this.environment[name] ?? "").split(",").map(s => s.trim()).filter(Boolean); }
  private fixtureOrigin(origin: string) {
    const expected = this.environment.LOGISTICS_TEST_BASE_URL;
    return this.environment.NODE_ENV !== "production" && this.environment.E2E_ISOLATED_DAILY === "1" && expected === origin
      && /^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(this.environment.DATABASE_URL ?? "http://invalid/").pathname)
      && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
  }
  async channels(p: LogisticsConnectionProfile, c: LogisticsCredentials) {
    const result = p.provider === "shipos" ? await this.request(p,c,"POST","/api/getChannel.php",{ module: 2 }) : await this.request(p,c,"GET","/api/Common/GetShippingMethods");
    const rows = p.provider === "shipos" ? result.data : result.Items;
    return z.array(z.unknown()).max(1000).parse(rows).map(raw => {
      const row = record(raw);
      const code = text(p.provider === "shipos" ? row.channel_id ?? row.channelid ?? row.id : row.Code), name = text(p.provider === "shipos" ? row.qudao ?? row.channel_name ?? row.name : row.DisplayName ?? row.CName);
      if (!code || code.length > 100 || !name || name.length > 200) throw new LogisticsTransportError("INVALID_RESPONSE");
      return { code, name };
    });
  }
  async quote(p: LogisticsConnectionProfile, c: LogisticsCredentials, t: LogisticsTaskSnapshot, reference: string) {
    this.assertPackages(p,t);
    const available = await this.channels(p,c), quotes: LogisticsQuote[] = [];
    for (const channel of p.channels.filter(channel => available.some(a => a.code === channel.code))) {
      if (!channel.countryCodes.includes(t.recipient.countryCode) || t.packages.some(pack => pack.weightGrams > channel.maxWeightGrams || Math.max(...Object.values(pack.dimensionsMm)) > channel.maxDimensionMm || pack.containsBattery && !channel.acceptsBattery)) continue;
      try {
        const raw = p.provider === "shipos"
          ? await this.request(p,c,"POST","/api/getPrice.php",{ ...shiposBody(p,t,reference), channel_id: channel.code })
          : await this.request(p,c,"GET","/api/Freight/GetPriceTrial",undefined,{ CountryCode: t.recipient.countryCode, Weight: kg(t.packages[0]!.weightGrams), Length: cm(t.packages[0]!.dimensionsMm.length,true), Width: cm(t.packages[0]!.dimensionsMm.width,true), Height: cm(t.packages[0]!.dimensionsMm.height,true), PackageType: t.packages[0]!.containsBattery ? "1" : "0", ...(p.billingDepot ? { Origin: p.billingDepot } : {}) });
        const row = p.provider === "shipos" ? record(raw.data) : z.array(z.unknown()).parse(raw.Items).map(record).find(r => text(r.ShippingMethodCode ?? r.Code) === channel.code);
        if (!row) continue;
        const liveCurrency = typeof row.Currency === "string" ? row.Currency : typeof row.currency === "string" ? row.currency : null;
        if (liveCurrency && liveCurrency !== p.currency) throw new Error("CURRENCY_MISMATCH");
        const transit = p.provider === "yunexpress" ? parseTransit(row.DeliveryDays) : null;
        quotes.push({ channelCode: channel.code, channelName: channel.name, totalMinor: decimalMinor(p.provider === "shipos" ? row.total_fee : row.TotalFee,p.minorUnitDigits),
          currency: liveCurrency ?? p.currency, currencySource: liveCurrency ? "provider.currency" : p.currencySource,
          transitDaysMin: channel.transitDaysMin, transitDaysMax: Math.max(channel.transitDaysMax,transit?.max??0),
          transitSource: transit ? `${channel.transitSource}; OMS DeliveryDays=${transit.min}-${transit.max}` : channel.transitSource,
          conditionsVerified: channel.conditionsVerified, priceSource: p.provider === "shipos" ? "ShipOS getPrice.php total_fee" : "YunExpress OMS GetPriceTrial TotalFee",
          quotedAt: new Date().toISOString(), diagnostic: null });
      } catch { quotes.push({ channelCode: channel.code, channelName: channel.name, totalMinor: 0, currency: null, currencySource: null, transitDaysMin: null, transitDaysMax: null, transitSource: null, conditionsVerified: false, priceSource: "provider quote failed", quotedAt: new Date().toISOString(), diagnostic: "QUOTE_UNAVAILABLE" }); }
    }
    return quotes;
  }
  async create(p: LogisticsConnectionProfile, c: LogisticsCredentials, t: LogisticsTaskSnapshot, reference: string, quote: LogisticsQuote) {
    this.assertPackages(p,t);
    if (p.provider === "shipos") {
      if (!t.recipient.email) throw new Error("SHIPOS_RECIPIENT_EMAIL_REQUIRED");
      const r = await this.request(p,c,"POST","/api/createOrder.php",{ ...shiposBody(p,t,reference), channelid: quote.channelCode });
      const row = record(r.data);
      if (text(row.orderid) !== reference) throw new LogisticsTransportError("INVALID_RESPONSE");
      return shiposResult(row,p,reference);
    }
    const pack = t.packages[0]!;
    const raw = await this.request(p,c,"POST","/api/WayBill/CreateOrder",[{
      CustomerOrderNumber: reference, ShippingMethodCode: quote.channelCode, PackageCount: 1, Weight: kg(pack.weightGrams), SizeUnits: "cm",
      Length: cm(pack.dimensionsMm.length,true), Width: cm(pack.dimensionsMm.width,true), Height: cm(pack.dimensionsMm.height,true),
      Receiver: yunAddress(t.recipient), Sender: yunAddress(p.sender), Parcels: pack.declarations.map(d => ({ SKU: d.sku, EName: d.nameEn, CName: d.nameCn, Quantity: d.quantity, UnitPrice: d.unitPriceMinor / 10**d.minorUnitDigits, UnitWeight: kg(d.unitWeightGrams), HSCode: d.hsCode, CurrencyCode: d.currency })),
    }]);
    const items = z.array(z.unknown()).length(1).parse(raw.Item), item=record(items[0]);
    if (text(item.CustomerOrderNumber) !== reference || text(item.Success)!=="1" || text(item.RequireSenderAddress)==="1") throw new LogisticsTransportError("INVALID_RESPONSE");
    return { providerOrderId: text(item.WayBillNumber) || reference, trackingNumbers: [track(item.TrackingNumber)].filter((s): s is string => !!s), labelUrls: [], actualCostMinor: null, actualCurrency: null };
  }
  async lookup(p: LogisticsConnectionProfile, c: LogisticsCredentials, reference: string) {
    if (p.provider === "shipos") {
      const raw = await this.request(p,c,"POST","/api/queryOrder.php",{ mkid: 2, orderid: reference }), data = record(raw.data);
      const rows = z.array(z.unknown()).max(5).parse(data.orders).map(record);
      if (!rows.length) return null;
      if (rows.length !== 1 || text(rows[0]!.orderid) !== reference) throw new LogisticsTransportError("INVALID_RESPONSE");
      // An existing order is enough to forbid a repeat purchase, even if detail is unavailable.
      try { const detail = record((await this.request(p,c,"POST","/api/orderDetail.php",{ orderid: reference })).data); if (text(detail.orderid) !== reference) throw new LogisticsTransportError("INVALID_RESPONSE"); return shiposResult(detail,p,reference); }
      catch { return shiposResult(rows[0]!,p,reference); }
    }
    const raw = await this.request(p,c,"GET","/api/WayBill/GetOrder",undefined,{ OrderNumber: reference });
    if (!raw.Item) return null;
    const item = record(raw.Item);
    if (text(item.OrderNumber) !== reference) throw new LogisticsTransportError("INVALID_RESPONSE");
    return { providerOrderId: text(item.WayBillNumber) || reference, trackingNumbers: [track(item.TrackingNumber)].filter((s): s is string => !!s), labelUrls: [], actualCostMinor: null, actualCurrency: null };
  }
  async labels(p: LogisticsConnectionProfile, c: LogisticsCredentials, reference: string) {
    if (p.provider === "shipos") {
      const row = record((await this.request(p,c,"POST","/api/getLabels.php",{ orderid: reference })).data);
      if (text(row.orderid) !== reference) throw new LogisticsTransportError("INVALID_RESPONSE");
      return shiposResult(row,p,reference);
    }
    const raw = await this.request(p,c,"POST","/api/Label/Print",[reference]);
    const rows = z.array(z.unknown()).min(1).max(50).parse(raw.Item).map(record);
    const urls: string[] = [];
    for (const row of rows) {
      const infos = z.array(z.unknown()).min(1).parse(row.OrderInfos).map(record);
      if (infos.some(i => text(i.CustomerOrderNumber) !== reference || text(i.Code) !== "100" || i.Error)) throw new LogisticsTransportError("LABEL_UNAVAILABLE");
      if (typeof row.Url !== "string") throw new LogisticsTransportError("LABEL_UNAVAILABLE");
      urls.push(row.Url);
    }
    return { providerOrderId: reference, trackingNumbers: [], labelUrls: [...new Set(urls)], actualCostMinor: null, actualCurrency: null };
  }
  async downloadLabel(p: LogisticsConnectionProfile, raw: string) {
    this.assertProfile(p);
    const url = new URL(raw), fixture = this.fixtureOrigin(url.origin);
    if (url.username || url.password || url.hash || raw.length > 4096 || (!fixture && (url.protocol !== "https:" || url.port || !p.labelHosts.includes(url.hostname)))) throw new LogisticsTransportError("LABEL_UNAVAILABLE");
    const response = await this.fetcher(url.href,{ method: "GET", redirect: "error", signal: AbortSignal.timeout(15000), headers: { accept: "application/pdf" } });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) throw new LogisticsTransportError("LABEL_UNAVAILABLE");
    const bytes = await boundedBody(response,10*1024*1024);
    if (bytes.subarray(0,5).toString("ascii") !== "%PDF-") throw new LogisticsTransportError("LABEL_UNAVAILABLE");
    return bytes;
  }
  private assertPackages(p: LogisticsConnectionProfile, t: LogisticsTaskSnapshot) {
    for(const pack of t.packages){kg(pack.weightGrams);for(const d of pack.declarations)kg(d.unitWeightGrams);}
    if(p.provider==="shipos"){if(!t.recipient.email)throw new Error("SHIPOS_RECIPIENT_EMAIL_REQUIRED");return;}
    if(t.packages.length!==1)throw new Error("YUN_MULTI_PACKAGE_REQUIRES_REVIEW");
    if(["BR","JO"].includes(t.recipient.countryCode))throw new Error("DESTINATION_TAX_OR_CERTIFICATE_REQUIRES_MANUAL_REVIEW");
    for(const address of [p.sender,t.recipient])if(address.name.length>50||address.address1.length>200||address.address2.length>200||address.city.length>100||address.region.length>100)throw new Error("YUN_ADDRESS_LENGTH_REQUIRES_REVIEW");
    if(p.sender.phone.length>20)throw new Error("YUN_SENDER_PHONE_REQUIRES_REVIEW");
    for(const pack of t.packages){for(const v of Object.values(pack.dimensionsMm))cm(v,true);for(const d of pack.declarations)if(d.minorUnitDigits>2&&d.unitPriceMinor%10!==0)throw new Error("YUN_DECLARATION_PRICE_PRECISION");}
  }
  private async request(p: LogisticsConnectionProfile, c: LogisticsCredentials, method: "GET"|"POST", path: string, body?: unknown, query?: Record<string,string>) {
    this.assertProfile(p);
    if (c.provider !== p.provider) throw new Error("CREDENTIAL_PROVIDER_MISMATCH");
    const url = new URL(path,p.baseUrl);
    for (const [key,value] of Object.entries(query ?? {})) url.searchParams.set(key,value);
    const headers: Record<string,string> = { "content-type": "application/json", accept: "application/json" };
    if (c.provider === "shipos") { headers.appkey = c.appKey; headers.appsecret = c.appSecret; }
    else headers.authorization = `Basic ${Buffer.from(`${c.customerCode}&${c.apiSecret}`,"utf8").toString("base64")}`;
    let response: Response;
    try { response = await this.fetcher(url.href,{ method, redirect: "error", signal: AbortSignal.timeout(12000), headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch { throw new LogisticsTransportError("TRANSPORT_UNCERTAIN"); }
    if (!response.ok) throw new LogisticsTransportError("TRANSPORT_UNCERTAIN");
    let data: Record<string,unknown>;
    try { data = record(JSON.parse((await boundedBody(response,1024*1024)).toString("utf8"))); } catch { throw new LogisticsTransportError("INVALID_RESPONSE"); }
    const code=text(p.provider === "shipos" ? data.code : data.Code);
    if (p.provider === "shipos" ? code!=="200" : !["0000","0"].includes(code)) throw new LogisticsTransportError("PROVIDER_REJECTED");
    return data;
  }
}
function kg(grams: number) { if (!Number.isInteger(grams)) throw new Error("PACKAGE_WEIGHT_REQUIRES_GRAM_PRECISION"); return (grams/1000).toFixed(3); }
function cm(mm: number, integer = false) { if (integer && mm%10 !== 0) throw new Error("YUN_DIMENSIONS_REQUIRE_WHOLE_CM"); return integer ? String(mm/10) : (mm/10).toFixed(2); }
function shiposAddress(a: LogisticsAddress) { return { name: a.name, company: a.company, addr1: a.address1, addr2: a.address2, city: a.city, state: a.region, country: a.countryCode, postal: a.postalCode, tel: a.phone, ...(a.email ? { email: a.email } : {}) }; }
function yunAddress(a: LogisticsAddress) { return { FirstName: a.name, LastName: "", Company: a.company, Street: a.address1, StreetAddress1: a.address1, StreetAddress2: a.address2, City: a.city, State: a.region, CountryCode: a.countryCode, Zip: a.postalCode, Phone: a.phone }; }
function shiposBody(p: LogisticsConnectionProfile,t: LogisticsTaskSnapshot,reference: string) {
  return { orderid: reference, module: 2, from_address: shiposAddress(p.sender), to_address: shiposAddress(t.recipient),
    packages: t.packages.map((pack,i) => ({ xh: i+1, weight: kg(pack.weightGrams), length: cm(pack.dimensionsMm.length), width: cm(pack.dimensionsMm.width), height: cm(pack.dimensionsMm.height) })),
    shenbao: t.packages.flatMap((pack,i) => pack.declarations.map(d => ({ xh: i+1, sku: d.sku, itemcn: d.nameCn, itemen: d.nameEn, price: d.unitPriceMinor/10**d.minorUnitDigits, num: d.quantity, cweight: kg(d.unitWeightGrams), hscode: d.hsCode, cz: d.originCountryCode, currency: d.currency }))) };
}
function shiposResult(row: Record<string,unknown>,p: LogisticsConnectionProfile,reference: string): LogisticsProviderResult {
  const source = row.source && typeof row.source === "object" ? record(row.source) : {};
  const labelRows = Array.isArray(row.labels) ? row.labels.map(record) : Array.isArray(source.lables) ? source.lables.map(record) : [];
  const urls = [row.labelPdf,row.label_pdf,...labelRows.map(r => r.label ?? r.url)].filter((u): u is string => typeof u === "string" && !!u);
  const numbers = [row.ztrackingno,row.trackingno,row.trackingNo,...labelRows.map(r => r.trackingNo ?? r.trackingno)].map(track).filter((t): t is string => !!t);
  const feeData = row.fee_data && typeof row.fee_data === "object" ? record(row.fee_data) : {};
  const value = row.totalFee ?? feeData.total_fee, currency = feeData.currency ?? p.currency;
  return { providerOrderId: reference, trackingNumbers: [...new Set(numbers)], labelUrls: [...new Set(urls)], actualCostMinor: value === undefined || value === null || currency !== p.currency ? null : decimalMinor(value,p.minorUnitDigits), actualCurrency: value === undefined || value === null || currency !== p.currency ? null : p.currency };
}
function parseTransit(raw: unknown) { if (typeof raw === "number" && raw > 0 && raw <= 365) return { min:raw,max:raw }; const m = typeof raw === "string" ? /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(raw.trim()) : null; if (!m) return null; const min=Number(m[1]),max=Number(m[2]??m[1]); return max>0 && min<=max && max<=365 ? { min,max } : null; }
async function boundedBody(response: Response,limit: number) {
  if (Number(response.headers.get("content-length") ?? 0)>limit) { await response.body?.cancel(); throw new LogisticsTransportError("INVALID_RESPONSE"); }
  const reader=response.body?.getReader(); if(!reader) throw new LogisticsTransportError("INVALID_RESPONSE");
  const parts: Uint8Array[]=[]; let size=0;
  while(true) { const next=await reader.read(); if(next.done) break; size+=next.value.length; if(size>limit) { await reader.cancel(); throw new LogisticsTransportError("INVALID_RESPONSE"); } parts.push(next.value); }
  return Buffer.concat(parts);
}
