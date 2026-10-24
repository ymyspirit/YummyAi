import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { Script } from "node:vm";
import { setTimeout, clearTimeout, setImmediate } from "node:timers";
import test from "node:test";
import { createStudioRuntimeGateway, studioGatewayProgram } from "../scripts/studio-runtime-gateway.mjs";

const bundleId = "a".repeat(64);
const config = upstreamPort => ({ upstreamHost: "127.0.0.1", upstreamPort, host: "127.0.0.1", port: 0, bundleId });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("GATEWAY_TEST_WAIT_TIMEOUT")), 8_000); })]); }
  finally { clearTimeout(timer); }
}
async function mockServer(t, handler) {
  const sockets = new Set(), disconnected = [], server = createServer(handler);
  server.on("connection", socket => {
    sockets.add(socket); disconnected.push(new Promise(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); })));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await Promise.all([closed, ...disconnected]); assert.equal(server.listening, false); assert.equal(sockets.size, 0);
  });
  return server;
}
async function gateway(t, handler) {
  const upstream = await mockServer(t, handler), bridge = await createStudioRuntimeGateway(config(upstream.address().port));
  t.after(async () => { await bridge.close(); assert.equal(bridge.server.listening, false); assert.equal(bridge.address(), null); });
  return { bridge, upstream, port: bridge.address().port };
}
function call(port, path = "/", options = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers,
      agent: false, timeout: 8_000 }, incoming => {
      const chunks = [];
      incoming.on("data", chunk => chunks.push(chunk)); incoming.once("error", reject);
      incoming.once("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.once("error", reject); outgoing.once("timeout", () => outgoing.destroy(new Error("GATEWAY_TEST_HTTP_TIMEOUT")));
    try { outgoing.end(options.body); } catch (error) { outgoing.destroy(); reject(error); }
  });
}

test("production program is self-contained with fixed endpoint and strict bundle/config", async () => {
  const program = studioGatewayProgram(bundleId);
  assert.doesNotThrow(() => new Script(program));
  assert.ok(program.startsWith(`(${createStudioRuntimeGateway.toString()})`));
  assert.ok(program.includes('"upstreamHost":"yummyai-studio-runtime","upstreamPort":8080,"host":"0.0.0.0","port":8080'));
  assert.equal(program.includes("process.env"), false); assert.equal(program.includes("process.argv"), false);
  for (const value of [null, "A".repeat(64), "a".repeat(63), `${bundleId}\n`, `${bundleId};process.exit()`])
    assert.throws(() => studioGatewayProgram(value), { message: "STUDIO_GATEWAY_CONFIG_INVALID" });
  for (const value of [null, [], { ...config(8080), upstreamHost: "outside.invalid" }, { ...config(8080), upstreamHost: "yummyai-studio-runtime", upstreamPort: 9000 },
    { ...config(8080), host: "outside.invalid" }, { ...config(8080), port: -1 }, { ...config(8080), upstreamPort: 0 }, { ...config(8080), timeout: 0 }])
    await assert.rejects(createStudioRuntimeGateway(value), { message: "STUDIO_GATEWAY_CONFIG_INVALID" });
});

test("forwards fixed GET path and static headers without caller credentials or upstream private headers", async t => {
  const seen = [];
  const { port } = await gateway(t, (incoming, outgoing) => {
    seen.push({ method: incoming.method, path: incoming.url, headers: incoming.headers });
    outgoing.writeHead(200, { "content-type": "application/javascript", "content-security-policy": "default-src 'self'; frame-ancestors http://127.0.0.1:3130",
      "cache-control": "private, no-cache", etag: '"synthetic-static"', "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
      "set-cookie": "synthetic=private", "www-authenticate": "synthetic-private", "proxy-authenticate": "synthetic-private",
      location: "http://outside.invalid/", "access-control-allow-origin": "*", connection: "close, x-private-hop", "x-private-hop": "private" });
    outgoing.end("export const sealed=true;");
  });
  const result = await call(port, "/assets/app.js?v=one", { headers: { cookie: "synthetic-private", authorization: "Bearer synthetic-private",
    origin: "http://outside.invalid", referer: "http://outside.invalid", "proxy-authorization": "synthetic-private", "x-forwarded-host": "outside.invalid",
    accept: "text/html", host: "outside.invalid" } });
  assert.equal(result.status, 200); assert.equal(result.body.toString(), "export const sealed=true;");
  assert.equal(seen.length, 1); assert.equal(seen[0].method, "GET"); assert.equal(seen[0].path, "/assets/app.js?v=one");
  assert.equal(seen[0].headers.accept, "*/*"); assert.match(seen[0].headers.host, /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(Object.keys(seen[0].headers).sort(), ["accept", "connection", "host"]);
  assert.match(result.headers["content-security-policy"], /frame-ancestors http:\/\/127\.0\.0\.1:3130/);
  assert.equal(result.headers.etag, '"synthetic-static"'); assert.equal(result.headers["content-type"], "application/javascript");
  assert.equal(result.headers["content-length"], String(result.body.length)); assert.equal(result.headers["transfer-encoding"], undefined);
  for (const key of ["set-cookie", "www-authenticate", "proxy-authenticate", "location", "access-control-allow-origin", "x-private-hop"])
    assert.equal(result.headers[key], undefined);
});

test("HEAD preserves static content length and returns no body", async t => {
  let method;
  const { port } = await gateway(t, (incoming, outgoing) => {
    method = incoming.method; outgoing.writeHead(200, { "content-type": "text/css", "content-length": "23" }); outgoing.end();
  });
  const result = await call(port, "/assets/app.css", { method: "HEAD" });
  assert.equal(method, "HEAD"); assert.equal(result.status, 200); assert.equal(result.body.length, 0); assert.equal(result.headers["content-length"], "23");
});

test("health requires a real upstream health response matching this sealed bundle for GET and HEAD", async t => {
  let mode = "good", hits = 0;
  const { port } = await gateway(t, (incoming, outgoing) => {
    hits++; assert.equal(incoming.method, "GET");
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(mode === "invalid" ? "not-json" : JSON.stringify({ service: "yummyai-studio-runtime", bundleId: mode === "good" ? bundleId : "b".repeat(64), sourceStamp: "c".repeat(64) }));
  });
  const good = await call(port, "/health"), head = await call(port, "/health", { method: "HEAD" });
  assert.equal(good.status, 200); assert.equal(JSON.parse(good.body).bundleId, bundleId); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  mode = "wrong"; assert.equal((await call(port, "/health")).status, 502);
  mode = "invalid"; assert.equal((await call(port, "/health")).status, 502); assert.equal(hits, 4);
});

test("rejects alternate targets, traversal, long URLs, POST and all framed GET bodies before upstream I/O", async t => {
  let hits = 0;
  const { port } = await gateway(t, (_incoming, outgoing) => { hits++; outgoing.end("not-reached"); });
  const cases = [
    ["http://outside.invalid/", {}, 400], ["//outside.invalid/", {}, 400], ["/\\outside.invalid/", {}, 400], ["/%5coutside.invalid", {}, 400],
    ["/%2foutside.invalid/", {}, 400], ["/../manifest.json", {}, 400], ["/%2e%2e/server.mjs", {}, 400], ["/%zz", {}, 400],
    ["/" + "a".repeat(8192), {}, 414], ["/", { method: "POST", body: "private" }, 405],
    ["/", { headers: { "content-length": "1" }, body: "x" }, 400], ["/", { headers: { "transfer-encoding": "chunked" }, body: "x" }, 400],
    ["/", { headers: { expect: "100-continue", "content-length": "0" } }, 400], ["/", { headers: { trailer: "x-body", "transfer-encoding": "chunked" } }, 400],
  ];
  for (const [path, options, status] of cases) assert.equal((await call(port, path, options)).status, status, path);
  assert.equal(hits, 0);
});

test("does not follow upstream redirects and drops connection-nominated static headers", async t => {
  let hits = 0;
  const trap = await mockServer(t, (_incoming, outgoing) => { hits++; outgoing.end("not-reached"); });
  const { port } = await gateway(t, (incoming, outgoing) => {
    if (incoming.url === "/redirect") { outgoing.writeHead(302, { location: `http://127.0.0.1:${trap.address().port}/` }); outgoing.end(); }
    else { outgoing.writeHead(200, { "content-type": "text/plain", etag: '"not-end-to-end"', connection: "close, etag" }); outgoing.end("safe"); }
  });
  const result = await call(port, "/redirect");
  assert.equal(result.status, 502); assert.equal(result.headers.location, undefined); assert.equal(hits, 0);
  assert.equal((await call(port, "/asset")).headers.etag, undefined);
});

test("rejects HTTP CONNECT and websocket upgrades without making an upstream connection", async t => {
  let hits = 0;
  const { port } = await gateway(t, (_incoming, outgoing) => { hits++; outgoing.end("not-reached"); });
  for (const text of ["CONNECT outside.invalid:443 HTTP/1.1\r\nHost: outside.invalid\r\n\r\n",
    "GET /socket HTTP/1.1\r\nHost: outside.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"]) {
    const socket = connect({ host: "127.0.0.1", port });
    t.after(() => socket.destroy());
    const chunks = []; socket.on("data", chunk => chunks.push(chunk));
    const ended = once(socket, "close"); socket.end(text); await bounded(ended);
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 400 /);
  }
  assert.equal(hits, 0);
});

test("upstream disconnect before or after headers returns a visible safe 502 instead of a partial success", async t => {
  const { port } = await gateway(t, (incoming, outgoing) => {
    if (incoming.url === "/before") { incoming.socket.destroy(); return; }
    outgoing.writeHead(200, { "content-length": "100" }); outgoing.flushHeaders(); outgoing.write("partial"); setImmediate(() => outgoing.destroy());
  });
  for (const path of ["/before", "/after"]) {
    const result = await call(port, path); assert.equal(result.status, 502);
    assert.deepEqual(JSON.parse(result.body), { code: "studio_gateway_upstream_unavailable" }); assert.equal(result.body.includes("partial"), false);
  }
});

test("bounded upstream deadline returns a safe 504 and cancels the upstream request", { timeout: 12_000 }, async t => {
  const cancelled = deferred();
  const { port } = await gateway(t, incoming => { incoming.socket.once("close", () => cancelled.resolve()); });
  const result = await call(port, "/slow");
  assert.equal(result.status, 504); assert.deepEqual(JSON.parse(result.body), { code: "studio_gateway_upstream_timeout" });
  await bounded(cancelled.promise);
});

test("client disconnect cancels fixed-upstream work and close is idempotent for pending sockets", async t => {
  const entered = deferred(), cancelled = deferred();
  const { bridge, port } = await gateway(t, incoming => {
    incoming.socket.once("close", () => cancelled.resolve()); entered.resolve();
  });
  const outgoing = request({ hostname: "127.0.0.1", port, path: "/pending", agent: false });
  outgoing.on("error", () => {}); outgoing.end();
  await bounded(entered.promise); outgoing.destroy(); await bounded(cancelled.promise);
  await Promise.all([bridge.close(), bridge.close()]); assert.equal(bridge.address(), null);
});

test("close cancels an active response and releases its own listener without touching another server", async t => {
  const entered = deferred(), cancelled = deferred();
  const { bridge, port, upstream } = await gateway(t, incoming => {
    incoming.socket.once("close", () => cancelled.resolve()); entered.resolve();
  });
  const result = call(port, "/pending").then(() => "response", () => "disconnected");
  await bounded(entered.promise); await bridge.close();
  assert.equal(await result, "disconnected"); await bounded(cancelled.promise); assert.equal(upstream.listening, true);
});
