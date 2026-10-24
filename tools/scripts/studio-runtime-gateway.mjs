/**
 * Read-only bridge to the sealed Studio runtime. Keep this factory self-contained:
 * production serializes this exact function into the pinned Node image's argv.
 */
export async function createStudioRuntimeGateway(options) {
  const { createServer, request, Agent } = await import("node:http");
  const { Buffer } = await import("node:buffer");
  const { setTimeout, clearTimeout } = await import("node:timers");
  const fail = () => { throw new Error("STUDIO_GATEWAY_CONFIG_INVALID"); };
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["upstreamHost", "upstreamPort", "host", "port", "bundleId"].includes(key))) fail();
  const { upstreamHost, upstreamPort, host = "127.0.0.1", port = 0, bundleId } = options;
  if (typeof bundleId !== "string" || !/^[a-f0-9]{64}$/.test(bundleId)
    || !["yummyai-studio-runtime", "127.0.0.1", "::1"].includes(upstreamHost)
    || !Number.isSafeInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535
    || (upstreamHost === "yummyai-studio-runtime" && upstreamPort !== 8080)
    || !["127.0.0.1", "::1", "0.0.0.0"].includes(host)
    || !Number.isSafeInteger(port) || port < 0 || port > 65535) fail();

  const timeoutMs = 5_000, maxResponseBytes = 64 * 1024 * 1024;
  const responseHeaders = new Set(["content-security-policy", "content-type", "cache-control", "etag",
    "last-modified", "x-content-type-options", "referrer-policy", "content-encoding", "vary", "accept-ranges", "content-range"]);
  const agent = new Agent({ keepAlive: false, maxSockets: 64, maxTotalSockets: 64 });
  const sockets = new Set(), upstreamSockets = new Set(), active = new Set();
  let closing = false, closePromise;
  const track = (socket, collection) => {
    if (collection.has(socket)) return;
    collection.add(socket); socket.once("close", () => collection.delete(socket));
  };
  const urlAllowed = raw => {
    if (typeof raw !== "string" || raw.length > 8192 || !raw.startsWith("/") || raw.startsWith("//")
      || /[\\#]/.test(raw) || [...raw].some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)) return false;
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return false; }
    return !decoded.startsWith("//") && !decoded.includes("\\")
      && ![...decoded].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
      && !decoded.split("?")[0].split("/").some(part => part === "." || part === "..");
  };
  const sendError = (incoming, outgoing, status, code) => {
    if (outgoing.destroyed || outgoing.writableEnded) return;
    if (outgoing.headersSent) { outgoing.destroy(); return; }
    const body = Buffer.from(JSON.stringify({ code }));
    outgoing.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'", connection: "close",
      ...(status === 405 ? { allow: "GET, HEAD" } : {}) });
    outgoing.end(incoming.method === "HEAD" ? undefined : body);
  };
  const reject = (incoming, outgoing, status = 400) => {
    incoming.resume();
    sendError(incoming, outgoing, status, "studio_gateway_request_rejected");
  };
  const handle = (incoming, outgoing) => {
    if (closing) { reject(incoming, outgoing, 503); return; }
    if (!["GET", "HEAD"].includes(incoming.method ?? "")) { reject(incoming, outgoing, 405); return; }
    if (!urlAllowed(incoming.url)) { reject(incoming, outgoing, (incoming.url?.length ?? 0) > 8192 ? 414 : 400); return; }
    if (incoming.headers["transfer-encoding"] !== undefined || incoming.headers.expect !== undefined
      || incoming.headers.trailer !== undefined
      || (incoming.headers["content-length"] !== undefined && incoming.headers["content-length"] !== "0")) {
      reject(incoming, outgoing); return;
    }

    let finished = false, upstreamRequest, upstreamResponse, timer;
    const finish = () => {
      if (finished) return false;
      finished = true; clearTimeout(timer); active.delete(cancel);
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      upstreamResponse?.destroy(); upstreamRequest?.destroy();
    };
    const upstreamFailure = (status = 502) => {
      if (!finish()) return;
      upstreamResponse?.destroy(); upstreamRequest?.destroy();
      sendError(incoming, outgoing, status, status === 504 ? "studio_gateway_upstream_timeout" : "studio_gateway_upstream_unavailable");
    };
    active.add(cancel);
    incoming.once("aborted", cancel);
    outgoing.once("error", cancel);
    outgoing.once("close", () => { if (!outgoing.writableFinished) cancel(); });
    // A correctly framed GET/HEAD has no body. Wait for end before any upstream
    // request, and reject unexpected bytes rather than forwarding them.
    incoming.once("data", () => { cancel(); reject(incoming, outgoing); });
    incoming.once("error", cancel);
    incoming.once("end", () => {
      if (finished || incoming.aborted || outgoing.destroyed) { cancel(); return; }
      const health = incoming.url.split("?")[0] === "/health";
      // HEAD health still obtains the real health body so its bundle is checked.
      const method = health ? "GET" : incoming.method;
      timer = setTimeout(() => upstreamFailure(504), timeoutMs);
      upstreamRequest = request({ hostname: upstreamHost, port: upstreamPort, path: incoming.url, method,
        headers: { accept: "*/*" }, agent, maxHeaderSize: 16 * 1024 }, upstream => {
        upstreamResponse = upstream;
        const status = upstream.statusCode;
        if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status !== 304 && status < 400)
          || status === 401 || status === 407) { upstreamFailure(); return; }
        const length = upstream.headers["content-length"];
        if (length !== undefined && (typeof length !== "string" || !/^\d+$/.test(length)
          || !Number.isSafeInteger(Number(length)) || Number(length) > maxResponseBytes)) { upstreamFailure(); return; }
        const chunks = [];
        let bytes = 0;
        upstream.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > (health ? 32 * 1024 : maxResponseBytes)) { upstreamFailure(); return; }
          chunks.push(chunk);
        });
        upstream.once("aborted", () => upstreamFailure());
        upstream.once("error", () => upstreamFailure());
        upstream.once("end", () => {
          if (finished) return;
          if (!upstream.complete || (method !== "HEAD" && status !== 304 && length !== undefined && Number(length) !== bytes)) {
            upstreamFailure(); return;
          }
          const body = Buffer.concat(chunks, bytes);
          if (health && status === 200) {
            let value;
            try { value = JSON.parse(body.toString("utf8")); } catch { upstreamFailure(); return; }
            if (!value || value.service !== "yummyai-studio-runtime" || value.bundleId !== bundleId) { upstreamFailure(); return; }
          }
          const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailer", "transfer-encoding", "upgrade", ...(upstream.headers.connection ?? "").split(",").map(value => value.trim().toLowerCase())]);
          const headers = {};
          for (const [key, value] of Object.entries(upstream.headers)) {
            if (responseHeaders.has(key) && !hopHeaders.has(key) && typeof value === "string") headers[key] = value;
          }
          headers["content-length"] = method === "HEAD" || status === 304 ? (length ?? "0") : String(body.length);
          if (!finish()) return;
          outgoing.writeHead(status, headers);
          outgoing.end(incoming.method === "HEAD" || status === 304 ? undefined : body);
        });
      });
      upstreamRequest.once("socket", socket => track(socket, upstreamSockets));
      upstreamRequest.once("error", () => upstreamFailure());
      upstreamRequest.once("upgrade", (_response, socket) => { socket.destroy(); upstreamFailure(); });
      upstreamRequest.end();
    });
    incoming.resume();
  };
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 5_000, requestTimeout: 5_000,
    keepAliveTimeout: 1_000 }, handle);
  server.maxConnections = 128;
  server.on("connection", socket => track(socket, sockets));
  server.on("checkContinue", (incoming, outgoing) => reject(incoming, outgoing));
  server.on("checkExpectation", (incoming, outgoing) => reject(incoming, outgoing));
  const rejectTunnel = (_incoming, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  };
  server.on("connect", rejectTunnel); server.on("upgrade", rejectTunnel);
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const cancel of [...active]) cancel();
      const waits = [...new Set([...sockets, ...upstreamSockets])].filter(socket => !socket.closed)
        .map(socket => new Promise(resolve => { socket.once("close", resolve); socket.destroy(); }));
      agent.destroy();
      const closed = new Promise((resolve, rejectClose) => {
        if (!server.listening) { resolve(); return; }
        server.close(error => error ? rejectClose(new Error("STUDIO_GATEWAY_CLOSE_FAILED")) : resolve());
        server.closeAllConnections();
      });
      await Promise.all([closed, ...waits]);
    })();
    return closePromise;
  };
  try {
    await new Promise((resolve, rejectListen) => {
      const failed = () => { server.removeListener("listening", ready); rejectListen(new Error("STUDIO_GATEWAY_START_FAILED")); };
      const ready = () => { server.removeListener("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", ready); server.listen(port, host);
    });
  } catch (error) { await close(); throw error; }
  return { server, address: () => { const value = server.address(); return typeof value === "object" ? value : null; }, close };
}

/** No environment or argv overrides: this is the complete production program. */
export function studioGatewayProgram(bundleId) {
  if (typeof bundleId !== "string" || !/^[a-f0-9]{64}$/.test(bundleId)) throw new Error("STUDIO_GATEWAY_CONFIG_INVALID");
  const options = { upstreamHost: "yummyai-studio-runtime", upstreamPort: 8080, host: "0.0.0.0", port: 8080, bundleId };
  return `(${createStudioRuntimeGateway.toString()})(${JSON.stringify(options)}).then(gateway=>{const stop=()=>gateway.close().catch(()=>{process.stderr.write("STUDIO_GATEWAY_CLOSE_FAILED\\n");process.exitCode=1;});process.once("SIGTERM",stop);process.once("SIGINT",stop);process.stdout.write("YUMMYAI_STUDIO_GATEWAY_READY\\n");}).catch(()=>{process.stderr.write("STUDIO_GATEWAY_START_FAILED\\n");process.exitCode=1;});`;
}
