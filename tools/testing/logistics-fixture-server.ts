import { createServer } from "node:http";

/** Disposable OMS transport. No credential, address or declaration is retained. */
export async function startLogisticsFixtureServer() {
  let baseUrl = "", duplicateCreates = 0, forbiddenRequests = 0;
  const requests: Record<string, number> = {}, orders = new Set<string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1"), path = url.pathname;
    requests[path] = (requests[path] ?? 0) + 1;
    const reply = (data: Record<string, unknown>) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ Code: "0000", ...data })); };
    if (path === "/fixture/label.pdf" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/pdf" }); res.end("%PDF-1.7\n% Synthetic logistics acceptance label\n%%EOF\n"); return;
    }
    if (req.headers.authorization !== `Basic ${Buffer.from("synthetic-customer&synthetic-logistics-secret").toString("base64")}`) { forbiddenRequests++; res.writeHead(403); res.end(); return; }
    if (path === "/api/Common/GetShippingMethods" && req.method === "GET") { reply({ Items: [{ Code: "fixture", DisplayName: "Synthetic OMS channel" }] }); return; }
    if (path === "/api/Freight/GetPriceTrial" && req.method === "GET") { reply({ Items: [{ Code: "fixture", TotalFee: "5.00", DeliveryDays: null }] }); return; }
    if (path === "/api/WayBill/GetOrder" && req.method === "GET") {
      const reference = url.searchParams.get("OrderNumber")!; reply({ Item: orders.has(reference) ? { OrderNumber: reference, WayBillNumber: `SYN-${reference}`, TrackingNumber: `TRACK-${reference}` } : null }); return;
    }
    let raw = "";
    for await (const chunk of req) { raw += String(chunk); if (raw.length > 65536) { res.writeHead(413); res.end(); return; } }
    let body: unknown; try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    if (path === "/api/WayBill/CreateOrder" && req.method === "POST" && Array.isArray(body) && body.length === 1) {
      const item = body[0] as Record<string, unknown>, reference = String(item.CustomerOrderNumber);
      if (!/^YMY[0-9a-f]{32}$/.test(reference) || item.ShippingMethodCode !== "fixture" || item.PackageCount !== 1) { forbiddenRequests++; res.writeHead(400); res.end(); return; }
      if (orders.has(reference)) duplicateCreates++;
      orders.add(reference); reply({ Item: [{ CustomerOrderNumber: reference, Success: 1, WayBillNumber: `SYN-${reference}`, TrackingNumber: `TRACK-${reference}` }] }); return;
    }
    if (path === "/api/Label/Print" && req.method === "POST" && Array.isArray(body) && body.length === 1 && orders.has(String(body[0]))) {
      reply({ Item: [{ Url: `${baseUrl}/fixture/label.pdf`, OrderInfos: [{ CustomerOrderNumber: body[0], Code: 100, Error: null }] }] }); return;
    }
    forbiddenRequests++; res.writeHead(405); res.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("Fixture origin unavailable");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  return { baseUrl, counts: () => ({ requests: { ...requests }, createdOrders: orders.size, duplicateCreates, forbiddenRequests }), close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
