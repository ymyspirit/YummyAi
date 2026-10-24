import { createServer } from "node:http";

/** A query-only synthetic vendor, created solely by the disposable acceptance runner. */
export async function startShiposFixtureServer() {
  const requests: Record<string, number> = {}; let forbiddenRequests = 0, baseUrl = "";
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests[path] = (requests[path] ?? 0) + 1;
    const reply = (code: number, data: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ code, data })); };
    if (request.method === "GET" && path === "/fixtures/labels/synthetic.pdf") { response.writeHead(200, { "content-type": "application/pdf" }); response.end("%PDF-1.7\n%Synthetic existing label\n%%EOF\n"); return; }
    if (request.method !== "POST" || !["/api/getChannel.php", "/api/queryOrder.php", "/api/orderDetail.php"].includes(path)) { forbiddenRequests++; response.writeHead(405); response.end(); return; }
    if (request.headers.appkey !== "synthetic-appkey" || request.headers.appsecret !== "synthetic-secret") { reply(401, null); return; }
    let body = "";
    for await (const chunk of request) { body += String(chunk); if (body.length > 16384) { response.writeHead(413); response.end(); return; } }
    let input: Record<string, unknown>;
    try { input = JSON.parse(body); } catch { reply(400, null); return; }
    if (path === "/api/getChannel.php") { reply(200, [{ id: "2", qudao: "Synthetic ShipOS channel" }]); return; }
    if (path === "/api/queryOrder.php") {
      if (input.mkid !== 2 || typeof input.orderid !== "string") { reply(400, null); return; }
      reply(200, { orders: input.orderid.split(",").filter(orderid => orderid !== "SYNTH-FAILED").map(orderid => ({ orderid, trackingno: `TRACK-${orderid}`, label_pdf: `${baseUrl}/fixtures/labels/synthetic.pdf`, status: 13, label_status: 2, cancel_status: 0, settlement_status: 1 })) }); return;
    }
    if (input.orderid === "SYNTH-DEVELOPMENT") { reply(500, null); return; }
    reply(200, { orderid: input.orderid, mkid: 2, trackingno: `TRACK-${input.orderid}`, label_pdf: `${baseUrl}/fixtures/labels/synthetic.pdf`, qudao: "Synthetic ShipOS channel",
      ...(input.orderid === "SYNTH-MATCHED" ? { fee_data: { currency: "CAD", total_fee: "0.00" } } : {}),
      to_address: { name: "Synthetic private recipient", email: "private@example.test", address: "Synthetic private address" } });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, counts: () => ({ requests: { ...requests }, forbiddenRequests }), close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
