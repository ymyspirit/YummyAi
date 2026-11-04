import { createServer } from "node:http";
import { createHmac } from "node:crypto";

/** Disposable OMS/OpenAPI transports. No credential, address or declaration is retained. */
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
    if(path==="/openapi/oauth2/token"||path.startsWith("/v1/")){
      let raw="";for await(const chunk of req){raw+=String(chunk);if(raw.length>65536){res.writeHead(413);res.end();return;}}
      let body:Record<string,unknown>={};try{if(raw)body=JSON.parse(raw);}catch{res.writeHead(400);res.end();return;}
      const send=(data:Record<string,unknown>)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(data));};
      if(path==="/openapi/oauth2/token"&&req.method==="POST"){
        if(body.grantType!=="client_credentials"||body.appId!=="synthetic-app"||body.appSecret!=="synthetic-logistics-secret"||body.sourceKey!=="synthetic-source"){forbiddenRequests++;res.writeHead(401);res.end();return;}
        send({accessToken:"synthetic-token",expiresIn:7200});return;
      }
      const canonical=`${raw?`body=${raw}&`:""}date=${req.headers.date}&method=${req.method}&uri=${path}`;
      const signature=createHmac("sha256","synthetic-logistics-secret").update(canonical).digest("base64");
      if(req.headers.token!=="synthetic-token"||req.headers.sign!==signature||Math.abs(Date.now()-Number(req.headers.date))>300000){forbiddenRequests++;res.writeHead(401);res.end();return;}
      if(path==="/v1/basic-data/products/getlist"&&req.method==="GET"){send({success:true,detail:[{product_code:"fixture",product_name:"Synthetic OpenAPI channel"}]});return;}
      if(path==="/v1/price-trial/get"&&req.method==="GET"){send({success:true,result:[{product_code:"fixture",fee_name:"freight",calculate_amount:3,currency:"USD",interval_day:"3-5"},{product_code:"fixture",fee_name:"handling",calculate_amount:2,currency:"USD",interval_day:"3-5"}]});return;}
      if(path==="/v1/order/package/create"&&req.method==="POST"){
        const reference=String(body.customer_order_number);
        if(!/^YMY[0-9a-f]{32}$/.test(reference)||body.product_code!=="fixture"||body.label_type!=="PDF"||!Array.isArray(body.packages)||body.packages.length!==1){forbiddenRequests++;res.writeHead(400);res.end();return;}
        if(orders.has(reference))duplicateCreates++;
        orders.add(reference);send({success:true,result:{customer_order_number:reference,waybill_number:`SYN-${reference}`,tracking_number:`TRACK-${reference}`}});return;
      }
      const reference=url.searchParams.get("order_number")??url.searchParams.get("waybill_number")?.replace(/^SYN-/,"")??"";
      if(!orders.has(reference)){send({success:false,code:"02039006"});return;}
      if(path==="/v1/order/info/get"&&req.method==="GET"){send({success:true,result:{customer_order_number:reference,waybill_number:`SYN-${reference}`,tracking_number:`TRACK-${reference}`}});return;}
      if(path==="/v1/order/label/get"&&req.method==="GET"){send({success:true,result:{order_number:`SYN-${reference}`,label_type:"PDF",url:`${baseUrl}/fixture/label.pdf`}});return;}
      if(path==="/v1/order/fee-details/get"&&req.method==="GET"){send({success:true,result:{customer_order_number:reference,waybill_number:`SYN-${reference}`,total_amount:5.75,currency:"USD"}});return;}
      forbiddenRequests++;res.writeHead(405);res.end();return;
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
