import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { verifyCanvasUpstream } from "./canvas-upstream.mjs";
const root = fileURLToPath(new URL("../../packages/canvas-runtime/", import.meta.url));
export async function buildCanvasRuntime() {
  await verifyCanvasUpstream();
  const hash = createHash("sha256");
  async function visit(dir) { for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { if (["node_modules", "dist", ".turbo"].includes(item.name)) continue; const name = resolve(dir, item.name); if (item.isDirectory()) await visit(name); else { hash.update(name.slice(root.length)); hash.update(await readFile(name)); } } }
  await visit(root); const stamp = hash.digest("hex"), target = resolve(root, "dist/.build-stamp");
  if (await readFile(target, "utf8").catch(() => "") === stamp) return;
  await new Promise((done, reject) => { const child = spawn(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build"], { cwd: root, stdio: "inherit", windowsHide: true }); child.once("error", reject); child.once("exit", code => code === 0 ? done() : reject(new Error(`Canvas runtime build failed (${code})`))); });
  await mkdir(resolve(root, "dist"), { recursive: true }); await writeFile(target, stamp);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildCanvasRuntime();
