import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { buildCanvasRuntime } from "./build-canvas-runtime.mjs";
const root = fileURLToPath(new URL("../../packages/canvas-runtime/dist/", import.meta.url));
const workspace = createHash("sha256").update(root).digest("hex");
export async function startCanvasRuntime() {
  await buildCanvasRuntime();
  const configured = new URL(process.env.CANVAS_STUDIO_URL || "http://127.0.0.1:4176");
  if (configured.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(configured.hostname) || configured.username || configured.password || configured.search || configured.hash) throw new Error("CANVAS_STUDIO_URL must be a loopback HTTP origin");
  const port = Number(configured.port || 80), health = `${configured.origin}/health`;
  async function existing() { try { const result = await (await globalThis.fetch(health, { signal: globalThis.AbortSignal.timeout(1500) })).json(); return result.service === "yummyai-canvas-runtime" && result.workspace === workspace; } catch { return false; } }
  if (await existing()) return null;
  const server = createServer(async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405); response.end(); return; }
    const url = new URL(request.url ?? "/", configured.origin);
    if (url.pathname === "/health") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ service: "yummyai-canvas-runtime", version: "1.0.0", workspace })); return; }
    try {
      const path = await realpath(resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`));
      if (!path.startsWith(root.replace(/[\\/]$/, "") + sep) || path.endsWith(".build-stamp")) throw new Error("outside_dist");
      const body = await readFile(path), types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
      response.writeHead(200, {
        "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob: data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://localhost:* http://127.0.0.1:*",
      }); response.end(request.method === "HEAD" ? undefined : body);
    } catch { response.writeHead(404); response.end("Not found"); }
  });
  try { await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); }); }
  catch (cause) { if (cause.code === "EADDRINUSE" && await existing()) return null; throw cause; }
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const server = await startCanvasRuntime(); if (server) { process.stdout.write("YummyAI canvas runtime ready\n"); for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close()); } }
