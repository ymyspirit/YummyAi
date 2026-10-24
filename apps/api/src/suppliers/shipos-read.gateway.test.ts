import { describe, expect, it, vi } from "vitest";
import { ShiposReadGateway, ShiposIdentityError, createShiposReadGateway, type ShiposCredentials } from "./shipos-read.gateway.js";

const credentials = { appKey: "synthetic-appkey", appSecret: "synthetic-secret" };
const label = "https://shipease.oss-cn-hangzhou.aliyuncs.com/pdfs/synthetic.pdf";
describe("ShipOS fixed query transport", () => {
  it("uses only the three confirmed query endpoints and discards raw buyer data", async () => {
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith("getChannel.php")) return Response.json({ code: 200, data: [{ id: "2", qudao: "Synthetic channel" }] });
      if (String(url).endsWith("queryOrder.php")) return Response.json({ code: 200, data: { orders: [{ orderid: "SYNTH-1", trackingno: "TEST123", label_pdf: label, status: 13, label_status: 2, cancel_status: 0, settlement_status: 1, to_address: { email: "private@example.test" } }] } });
      return Response.json({ code: 200, data: { orderid: "SYNTH-1", mkid: 2, trackingno: "TEST123", label_pdf: label, qudao: "Synthetic channel", fee_data: { currency: "CAD", total_fee: "0.00" }, to_address: { name: "Private buyer", address: "private address" } } });
    });
    const gateway = new ShiposReadGateway(fetcher);
    expect(await gateway.channels(credentials)).toEqual({ channelCount: 1 });
    const orders = await gateway.orders(credentials, ["SYNTH-1"]), detail = await gateway.detail(credentials, "SYNTH-1");
    expect(orders[0]).toMatchObject({ labelAvailable: true, statusCode: 13 });
    expect(detail).toMatchObject({ fee: "0.00", currency: "CAD" });
    expect(JSON.stringify({ orders, detail })).not.toMatch(/private@example|Private buyer|private address|to_address/);
    expect(fetcher.mock.calls.map(call => new URL(String(call[0])).pathname)).toEqual(["/api/getChannel.php", "/api/queryOrder.php", "/api/orderDetail.php"]);
    for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ method: "POST", redirect: "error", headers: { appkey: credentials.appKey, appsecret: credentials.appSecret } });
    const forward = gateway as unknown as { query(path: string, credentials: ShiposCredentials, body: object): Promise<unknown> };
    for (const path of ["/api/createOrder.php", "/api/getLabels.php", "/api/cancelOrder.php", "/api/orderList.php", "/api/uploadAccessorys.php", "https://other.test"]) await expect(forward.query(path, credentials, {})).rejects.toThrow("Only confirmed");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("rejects foreign, duplicate and mismatched identities instead of associating the wrong order", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: { orders: [{ orderid: "OTHER" }] } }));
    const gateway = new ShiposReadGateway(fetcher);
    await expect(gateway.orders(credentials, ["EXPECTED"])).rejects.toThrow("identity mismatch");
    fetcher.mockResolvedValue(Response.json({ code: 200, data: { orders: [{ orderid: "EXPECTED" }, { orderid: "EXPECTED" }] } }));
    await expect(gateway.orders(credentials, ["EXPECTED"])).rejects.toThrow("identity mismatch");
    for (const data of [{ orderid: "OTHER", mkid: 2 }, { orderid: "EXPECTED", mkid: 3 }, { orderid: "EXPECTED" }]) {
      fetcher.mockResolvedValue(Response.json({ code: 200, data })); await expect(gateway.detail(credentials, "EXPECTED")).rejects.toBeInstanceOf(ShiposIdentityError);
    }
  });
  it("does not fabricate a zero fee or currency and suppresses vendor errors containing secrets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: { orderid: "SYNTH", mkid: 2, fee_data: { total_fee: "4.50" } } }));
    const gateway = new ShiposReadGateway(fetcher);
    expect(await gateway.detail(credentials, "SYNTH")).toMatchObject({ fee: null, currency: null });
    fetcher.mockResolvedValue(Response.json({ code: 500, msg: "synthetic-secret private address", data: null }));
    await expect(gateway.channels(credentials)).rejects.toThrow(/^ShipOS query rejected$/);
  });
  it("downloads an existing PDF without sending credentials to the asset host or issuing a label", async () => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).startsWith("https://api.shipos.cn") ? Response.json({ code: 200, data: { orderid: "SYNTH", mkid: 2, label_pdf: label } }) : new Response("%PDF-1.7\nsynthetic", { headers: { "content-type": "application/pdf" } }));
    expect((await new ShiposReadGateway(fetcher).existingLabel(credentials, "SYNTH")).toString()).toContain("%PDF-");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET", headers: { accept: "application/pdf" }, redirect: "error" });
    expect(fetcher.mock.calls[1]?.[1]?.headers).not.toHaveProperty("appsecret");
  });
  it("refuses a label whose current tracking number no longer matches the saved observation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: { orderid: "SYNTH", mkid: 2, trackingno: "NEW-TRACK", label_pdf: label } }));
    await expect(new ShiposReadGateway(fetcher).existingLabel(credentials, "SYNTH", "OLD-TRACK")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["http://127.0.0.1/admin", "https://other.test/pdfs/a.pdf", "https://user:pass@shipease.oss-cn-hangzhou.aliyuncs.com/pdfs/a.pdf", "https://shipease.oss-cn-hangzhou.aliyuncs.com:443/pdfs/a.pdf#fragment", "https://shipease.oss-cn-hangzhou.aliyuncs.com/pdfs/a.html"])("blocks unsafe or unconfirmed label source %s", async label_pdf => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: { orderid: "SYNTH", mkid: 2, label_pdf } }));
    await expect(new ShiposReadGateway(fetcher).existingLabel(credentials, "SYNTH")).rejects.toThrow("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds response sizes and cannot enable a fixture host in a business or production environment", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "content-length": "2000000" } }));
    await expect(new ShiposReadGateway(fetcher).channels(credentials)).rejects.toThrow("too large");
    expect(() => new ShiposReadGateway(fetch, "https://other.test")).toThrow("host is fixed");
    expect(() => createShiposReadGateway({ SHIPOS_TEST_BASE_URL: "http://127.0.0.1:12345", DATABASE_URL: "postgres://localhost/business" })).toThrow("isolated");
    expect(() => createShiposReadGateway({ NODE_ENV: "production", E2E_ISOLATED_DAILY: "1", SHIPOS_TEST_BASE_URL: "http://127.0.0.1:12345", DATABASE_URL: `postgres://localhost/order_daily_e2e_${"a".repeat(32)}` })).toThrow("isolated");
  });
});
