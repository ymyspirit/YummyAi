import { z } from "zod";
import { ShiposOrderNumberSchema, ShiposOrderEvidenceSchema, type ShiposOrderEvidence } from "@yummyai/contracts/suppliers/shipos";

export type ShiposCredentials = { appKey: string; appSecret: string };
type QueryPath = "/api/getChannel.php" | "/api/queryOrder.php" | "/api/orderDetail.php";
const QUERY_PATHS = new Set<QueryPath>(["/api/getChannel.php", "/api/queryOrder.php", "/api/orderDetail.php"]);
const envelope = z.object({ code: z.union([z.number(), z.string()]), data: z.unknown() });
const status = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : null;
const tracking = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) ? value : null;
const decimal = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e9 ? String(value) : typeof value === "string" && /^-?\d{1,9}(\.\d{1,6})?$/.test(value) ? value : null;

/** The transport has no order-creation, issuance, cancellation or generic forwarding method. */
export class ShiposReadGateway {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly base = "https://api.shipos.cn", private readonly isolated = false) {
    if (base !== "https://api.shipos.cn" && (!isolated || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))) throw new Error("ShipOS query host is fixed");
  }
  async channels(credentials: ShiposCredentials) {
    const data = await this.query("/api/getChannel.php", credentials, { module: 2 });
    const channels = z.array(z.object({ id: z.union([z.string(), z.number()]), qudao: z.string() })).max(1000).parse(data);
    return { channelCount: channels.length };
  }
  async orders(credentials: ShiposCredentials, numbers: string[]): Promise<ShiposOrderEvidence[]> {
    z.array(ShiposOrderNumberSchema).min(1).max(5).parse(numbers);
    const data = z.object({ orders: z.array(z.record(z.string(), z.unknown())).max(5) }).parse(await this.query("/api/queryOrder.php", credentials, { mkid: 2, orderid: numbers.join(",") }));
    const seen = new Set<string>();
    return data.orders.map(row => {
      const number = ShiposOrderNumberSchema.parse(row.orderid);
      if (!numbers.includes(number) || seen.has(number)) throw new Error("ShipOS response identity mismatch");
      seen.add(number);
      return ShiposOrderEvidenceSchema.parse({ orderNumber: number, trackingNumber: tracking(row.trackingno), labelAvailable: !!this.labelUrl(row.label_pdf),
        statusCode: status(row.status), cancelStatusCode: status(row.cancel_status), labelStatusCode: status(row.label_status), settlementStatusCode: status(row.settlement_status),
        channel: null, fee: null, currency: null, diagnostics: [] });
    });
  }
  async detail(credentials: ShiposCredentials, number: string) {
    ShiposOrderNumberSchema.parse(number);
    const row = z.record(z.string(), z.unknown()).parse(await this.query("/api/orderDetail.php", credentials, { orderid: number }));
    if (row.orderid !== number || status(row.mkid) !== 2) throw new ShiposIdentityError();
    const feeData = z.object({ currency: z.unknown().optional(), total_fee: z.unknown().optional() }).safeParse(row.fee_data);
    const currency = feeData.success && typeof feeData.data.currency === "string" && /^[A-Z]{3}$/.test(feeData.data.currency) ? feeData.data.currency : null;
    return { trackingNumber: tracking(row.trackingno), labelUrl: this.labelUrl(row.label_pdf),
      channel: typeof row.qudao === "string" && row.qudao.length > 0 && row.qudao.length <= 100 && [...row.qudao].every(character => character.charCodeAt(0) >= 32) && !/https?:|@/.test(row.qudao) ? row.qudao : null,
      fee: currency && feeData.success ? decimal(feeData.data.total_fee) : null, currency };
  }
  async existingLabel(credentials: ShiposCredentials, number: string, expectedTracking?: string | null) {
    const detail = await this.detail(credentials, number);
    if (expectedTracking !== undefined && detail.trackingNumber !== expectedTracking) throw new ShiposIdentityError();
    if (!detail.labelUrl) throw new Error("Existing label is unavailable");
    const response = await this.fetcher(detail.labelUrl, { method: "GET", redirect: "error", signal: AbortSignal.timeout(12_000), headers: { accept: "application/pdf" } });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/pdf")) throw new Error("Existing label download failed");
    const bytes = await boundedBody(response, 10 * 1024 * 1024);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Invalid existing PDF");
    return bytes;
  }
  private labelUrl(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length > 4096) return null;
    try {
      const url = new URL(raw);
      if (url.username || url.password || url.hash) return null;
      if (this.isolated && url.origin === this.base && /^\/fixtures\/labels\/[A-Za-z0-9_-]+\.pdf$/.test(url.pathname)) return url.href;
      if (url.protocol !== "https:" || url.port || url.hostname !== "shipease.oss-cn-hangzhou.aliyuncs.com" || !/^\/pdfs\/[A-Za-z0-9/_-]+\.pdf$/.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }
  private async query(path: QueryPath, credentials: ShiposCredentials, body: object) {
    if (!QUERY_PATHS.has(path)) throw new Error("Only confirmed ShipOS query endpoints are allowed");
    const response = await this.fetcher(`${this.base}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", appkey: credentials.appKey, appsecret: credentials.appSecret }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error("ShipOS query failed");
    const data = envelope.parse(JSON.parse((await boundedBody(response, 1024 * 1024)).toString("utf8")));
    if (String(data.code) !== "200") throw new Error("ShipOS query rejected");
    return data.data;
  }
}
export class ShiposIdentityError extends Error {}
async function boundedBody(response: Response, limit: number) {
  if (Number(response.headers.get("content-length") ?? 0) > limit) { await response.body?.cancel(); throw new Error("Response is too large"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error("Response is too large"); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}
export function createShiposReadGateway(env: NodeJS.ProcessEnv = process.env) {
  const fixture = env.SHIPOS_TEST_BASE_URL;
  if (!fixture) return new ShiposReadGateway();
  if (env.NODE_ENV === "production" || env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(env.DATABASE_URL!).pathname)) throw new Error("ShipOS fixture transport requires an isolated test database");
  return new ShiposReadGateway(fetch, fixture, true);
}
