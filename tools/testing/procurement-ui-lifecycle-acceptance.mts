/**
 * Real procurement components against an in-memory synthetic transport only.
 * Run without an env file:
 * node --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/testing/procurement-ui-lifecycle-acceptance.mts --output-dir tmp/<fresh-run>
 * This complements the real API/process suite; it does not assert real database recovery.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type Page } from "@playwright/test";

const workspace = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output-dir" && args[1], "Pass one explicit fresh --output-dir under workspace tmp");
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const overlaps = (left: string, right: string) => left === right || within(left, right) || within(right, left);
async function withoutLinks(target: string) {
  assert(target === workspace || within(workspace, target), "Output must remain in this workspace");
  for (let cursor = target;; cursor = path.dirname(cursor)) {
    try { assert(!(await lstat(cursor)).isSymbolicLink(), "Linked output paths are forbidden"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cursor === workspace) return;
  }
}
const outputDirectory = path.resolve(workspace, args[1]!);
assert(within(path.join(workspace, "tmp"), outputDirectory), "Output must be a fresh leaf under workspace tmp");
await withoutLinks(outputDirectory);
try { await lstat(outputDirectory); assert.fail("Output already exists; choose a new directory"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
// Reuse the project control record's exact protected path boundary without
// importing any database, storage, credentials or ordinary runtime helpers.
const statePath = path.join(workspace, "docs/project-control/state.json");
await withoutLinks(statePath);
const state = JSON.parse(await readFile(statePath, "utf8"));
const rejection = state.cleanupPolicy?.latestPolicyRejection;
const rejectionPath = typeof rejection === "string" ? rejection : rejection?.record;
assert(typeof rejectionPath === "string", "Current protected-path record is required");
const recordPath = path.resolve(workspace, rejectionPath);
assert(within(path.join(workspace, "docs/project-control/checkpoints"), recordPath), "Invalid protected-path record");
await withoutLinks(recordPath);
const protectedPaths = JSON.parse(await readFile(recordPath, "utf8")).cumulativeRejectedPaths;
assert(Array.isArray(protectedPaths) && protectedPaths.every(value => typeof value === "string"), "Invalid protected paths");
const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
assert(!protectedPaths.some(value => overlaps(fold(path.resolve(workspace, value)), fold(outputDirectory))), "Output overlaps a frozen path");
await mkdir(path.dirname(outputDirectory), { recursive: true });
await withoutLinks(outputDirectory);
await mkdir(outputDirectory); // Existing directories are never reused, overwritten or deleted.

const source = (relative: string) => JSON.stringify(path.join(workspace, relative).replaceAll("\\", "/"));
const entryPath = path.join(outputDirectory, "entry.tsx"), bundlePath = path.join(outputDirectory, "bundle.js");
const nextPath = path.join(outputDirectory, "stub-next.tsx"), actionsPath = path.join(outputDirectory, "stub-actions.ts");
const entry = `
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProcurementCycleDialog } from ${source("apps/web/src/features/procurement/procurement-command-workbench")};
import { ProcurementSupplyPurchaseDialog } from ${source("apps/web/src/features/procurement/procurement-command-supply-dialog")};
import { ErpIdentityContext } from ${source("apps/web/src/features/identity/erp-access")};
import ${source("apps/web/src/app/globals.css")};
import ${source("apps/web/src/app/erp-theme.css")};
import ${source("apps/web/src/features/manual-operations/manual-operations.css")};
import { erpSessionAuthority } from '@yummyai/contracts/auth/session';
import { Permission } from '@yummyai/authz/permissions';

const id = (value) => '019a0101-0000-7000-8000-' + String(value).padStart(12, '0');
const session = { authenticated: true, canUseErp: true, tenantId: id(1), userId: id(2), displayName: 'Synthetic operator',
  organizationName: 'Synthetic tenant', dataScope: 'tenant', permissions: [Permission.ProcurementRead, Permission.ProcurementWrite,
  Permission.ProcurementApprove, Permission.ProductRead, Permission.InventoryRead, Permission.InventoryWrite] };
const now = new Date().toISOString(), expires = new Date(Date.now() + 86400000).toISOString();
const stock = { id: id(3), code: 'SYNTHETIC-MAT', name: 'Synthetic material', status: 'active', baseUnit: 'each', materialKind: 'material', skuId: null };
const location = { id: id(4), warehouseId: id(5), code: 'SYNTHETIC-LOC', name: 'Synthetic location', status: 'active' };
const supplier = { id: id(6), name: 'Synthetic supplier', kind: 'manual', regionCode: 'US', status: 'active', settlementCurrency: 'USD' };
const data = { suppliers: [supplier], stockItems: [stock], locations: [location], requisitions: [], rfqs: [], quotes: [], purchaseOrders: [], receipts: [], invoices: [], policies: [], suggestions: [] };
const terms = { fulfillmentModes: ['custom_order'], stockItemId: stock.id, unitCostMinor: 123, currency: 'USD', minimumOrderQuantity: 1,
  leadTimeDays: 1, validFrom: now, validUntil: expires, status: 'active', preference: 'primary', sampleStatus: 'passed', supplierCode: '', purchaseUrl: '', specifications: '', process: '', notes: '' };
const link = { id: id(7), productPlanId: id(8), productName: 'Synthetic product', supplierId: supplier.id, supplierName: supplier.name,
  supplierStatus: 'active', skuId: null, skuCode: null, currentVersion: 1, versionId: id(9), terms, updatedAt: now };
const source = { ...data, links: [link], products: [], warehouses: [{ id: id(5), code: 'SYNTHETIC-WH', name: 'Synthetic warehouse', status: 'active' }] };
const original = { kind: 'requisition_create', targetId: null, input: { code: 'OLDER-REQUEST', reasonCode: 'REPLENISHMENT',
  lines: [{ lineKey: 'L-ONE', stockItemId: stock.id, destinationLocationId: location.id, quantity: 1, unit: 'each' }], idempotencyKey: 'synthetic-older-request-key' } };
const authority = erpSessionAuthority(session), mode = new URL(window.location.href).searchParams.get('case');
function view(original, number = 10) { return { id: id(number), kind: original.kind, targetId: original.targetId, targetLabel: original.input.code ?? 'Synthetic target', targetDetail: null,
  status: 'prepared', createdAt: now, expiresAt: expires, completedAt: null, contextAuthority: authority, acknowledged: false,
  canExecute: true, canCancel: true, original, result: null, blockReason: null }; }
const records = [], violations = [];
let release;
window.audit = { requests: records, violations, waiting: false, responseConsumed: false, sourceRevision: 0, revoked: false, release: () => release?.() };
// Never delegate to the native fetch. Every unexpected API or origin fails here
// and is independently blocked by browser routing and the server's CSP.
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  const method = (options?.method ?? 'GET').toUpperCase();
  if (url.origin !== window.location.origin || url.pathname !== '/api/procurement-commands/commands' || !['GET', 'POST'].includes(method)) {
    violations.push('unexpected_transport'); throw new Error('Synthetic fixture forbids ordinary business requests');
  }
  const record = { method, path: url.pathname, query: url.search }; records.push(record);
  if (method === 'GET') {
    let items = [], nextCursor = null;
    if (mode === 'pagination') {
      if ((url.searchParams.get('kind') === 'requisition_create' && !url.searchParams.has('targetId')) || url.searchParams.has('before')) items = [view(original)];
      else { items = Array.from({ length: 50 }, (_, index) => ({ ...view({ ...original, kind: 'purchase_revise', targetId: id(100 + index) }, 200 + index), original: null, canExecute: false, blockReason: 'input_unavailable' })); nextCursor = id(200); }
    }
    return Response.json({ items, nextCursor, unavailableCount: 0, contextAuthority: authority });
  }
  const submitted = JSON.parse(String(options?.body));
  if (submitted.kind !== 'supply_purchase_create' || submitted.targetId !== link.id) {
    violations.push('unexpected_synthetic_operation'); throw new Error('Only synthetic supply prepare is allowed');
  }
  record.key = submitted.input.idempotencyKey;
  if (mode === 'legacy-unknown') return Response.json({ code: 'procurement_input_unavailable', message: '原输入未知 请先核对原业务记录' }, { status: 409 });
  return new Promise(resolve => { window.audit.waiting = true; release = () => {
    const response = Response.json(view(submitted, 500)), readJson = response.json.bind(response);
    response.json = async () => { const value = await readJson(); window.audit.responseConsumed = true; return value; };
    resolve(response); window.audit.waiting = false;
  }; });
};
function Harness() {
  const [currentSource, setSource] = useState(source), [currentSession, setSession] = useState(session);
  useLayoutEffect(() => { window.audit.sourceRevision = currentSource === source ? 0 : 1; window.audit.revoked = currentSession !== session; }, [currentSource, currentSession]);
  window.audit.replaceSources = () => setSource({ ...source, links: [...source.links] });
  window.audit.revoke = () => setSession({ ...session, permissions: [Permission.ProcurementRead] });
  return <ErpIdentityContext.Provider value={{ session: currentSession, localDevelopment: false, logout: () => undefined }}>
    {mode === 'pagination' ? <ProcurementCycleDialog data={data} initialDraft={{ id: 'stable-synthetic-draft', kind: 'requisition_create', targetId: null }} onClose={() => undefined} onChanged={() => undefined} />
      : <ProcurementSupplyPurchaseDialog data={currentSource} link={link} onClose={() => undefined} onSaved={() => undefined} />}
  </ErpIdentityContext.Provider>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;
const stubNext = `import React from 'react';
const router = { refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} };
export const useRouter = () => router;
export const usePathname = () => window.location.pathname;
export const useSearchParams = () => new URLSearchParams(window.location.search);
export default function Link(props) { return <a {...props} />; }
`;
const stubActions = `export const saveOperation = async () => { throw new Error('Synthetic fixture forbids raw business writes'); };
export const loadWarehouseChoices = async () => ({ warehouses: [] });
`;
type Mode = "busy" | "pagination" | "late-authority" | "legacy-unknown";
type SyntheticRequest = { method: string; path: string; query: string; key?: string };
type Audit = { requests: SyntheticRequest[]; violations: string[]; waiting: boolean; responseConsumed: boolean; sourceRevision: number; revoked: boolean;
  release(): void; replaceSources(): void; revoke(): void };
type FixtureWindow = Window & { audit: Audit };
type CaseResult = { mode: Mode; width: number; status: "pass" | "failed"; screenshot: string; requests: SyntheticRequest[];
  errors: string[]; consoleErrors: string[]; blockedRequests: number; metrics?: unknown; failure?: { name: string; message: string } };
const modes: Mode[] = ["busy", "pagination", "late-authority", "legacy-unknown"], results: CaseResult[] = [];
const cleanupErrors: string[] = [];
let browser: Browser | undefined, browserClosed = true, serverClosed = true, phase = "bundle", networkBusinessRequests = 0;
let fatal: { name: string; message: string } | undefined;
const failure = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message.slice(0, 2500) } : { name: "unknown", message: "Synthetic acceptance failed" };
const readAudit = (page: Page) => page.evaluate(() => { const value = (window as FixtureWindow).audit; return { requests: value.requests, violations: value.violations }; });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://synthetic.invalid").pathname;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'");
    if (request.method !== "GET" || !["/", "/bundle.js", "/bundle.css"].includes(pathname)) {
      networkBusinessRequests++; response.writeHead(403).end("Synthetic fixture forbids ordinary business requests"); return;
    }
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
    } else response.writeHead(200, { "content-type": pathname.endsWith(".css") ? "text/css" : "text/javascript" }).end(await readFile(path.join(outputDirectory, pathname.slice(1))));
  } catch { response.writeHead(500).end("Synthetic fixture resource unavailable"); }
});

try {
  await Promise.all([[entryPath, entry], [nextPath, stubNext], [actionsPath, stubActions]].map(([target, contents]) => writeFile(target!, contents!, { flag: "wx" })));
  const canvasRequire = createRequire(new URL("../../packages/canvas-runtime/package.json", import.meta.url));
  const viteRequire = createRequire(canvasRequire.resolve("vite/package.json"));
  const esbuild = viteRequire("esbuild");
  await esbuild.build({ entryPoints: [entryPath], outfile: bundlePath, bundle: true, platform: "browser", format: "esm", target: "es2022", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' }, nodePaths: [path.join(workspace, "apps/web/node_modules")],
    plugins: [{ name: "synthetic-boundaries", setup(api: { onResolve(options: { filter: RegExp }, callback: () => { path: string }): void }) {
      api.onResolve({ filter: /^next\/(link|navigation)$/ }, () => ({ path: nextPath }));
      api.onResolve({ filter: /operation-actions$/ }, () => ({ path: actionsPath }));
    } }] });
  phase = "browser";
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  serverClosed = false;
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true }); browserClosed = false;
  for (const width of [1440, 390]) for (const mode of modes) {
    phase = `${mode}-${width}`;
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage(), screenshot = `${mode}-${width}.png`;
    const result: CaseResult = { mode, width, status: "failed", screenshot, requests: [], errors: [], consoleErrors: [], blockedRequests: 0 };
    results.push(result); page.setDefaultTimeout(15_000);
    page.on("pageerror", error => result.errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") result.consoleErrors.push(message.text()); });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && ["/", "/bundle.js", "/bundle.css"].includes(url.pathname) && route.request().method() === "GET") return route.continue();
      result.blockedRequests++; return route.abort("blockedbyclient");
    });
    try {
      await page.goto(`${origin}/?case=${mode}`, { waitUntil: "domcontentloaded" });
      const dialog = page.getByRole("dialog", { name: "采购原填写与执行" }); await expect(dialog).toBeVisible();
      const review = page.getByRole("region", { name: "核对采购原提交" });
      if (mode === "pagination") {
        await expect(review).toBeVisible(); await expect(review.getByRole("definition").filter({ hasText: /^OLDER-REQUEST$/ })).toBeVisible();
        await expect(page.getByRole("form", { name: "新增采购申请" })).toHaveCount(0);
      } else {
        const form = page.getByRole("form", { name: "按商品供货建采购单" }); await expect(form).toBeVisible();
        await form.getByLabel("收货库位", { exact: true }).selectOption("019a0101-0000-7000-8000-000000000004");
        const save = form.getByRole("button", { name: "保存原填写并核对", exact: true }); await save.click();
        if (mode === "legacy-unknown") {
          await expect(form.getByRole("alert")).toHaveText("原输入未知 请先核对原业务记录");
          await expect(save).toBeEnabled(); await save.click();
          await page.waitForFunction(() => (window as FixtureWindow).audit.requests.filter(row => row.method === "POST").length === 2);
          await expect(save).toBeEnabled(); await expect(review).toHaveCount(0);
        } else {
          await page.waitForFunction(() => (window as FixtureWindow).audit.waiting);
          if (mode === "busy") {
            await page.evaluate(() => (window as FixtureWindow).audit.replaceSources());
            await page.waitForFunction(() => (window as FixtureWindow).audit.sourceRevision === 1);
          } else {
            await page.evaluate(() => (window as FixtureWindow).audit.revoke());
            await page.waitForFunction(() => (window as FixtureWindow).audit.revoked);
            await expect(form).toHaveCount(0);
          }
          await page.evaluate(() => (window as FixtureWindow).audit.release());
          await page.waitForFunction(() => (window as FixtureWindow).audit.responseConsumed);
          await expect(dialog.getByRole("button", { name: "重新读取原提交", exact: true })).toBeEnabled();
          await expect(form).toHaveCount(0);
          if (mode === "busy") await expect(review).toBeVisible();
          else {
            await expect(review).toHaveCount(0); await expect(dialog).not.toContainText("Synthetic product");
            await expect(dialog.getByText("私有填写已清除 请核对当前账号与权限", { exact: true })).toBeVisible();
          }
        }
      }
      const audit = await readAudit(page); result.requests = audit.requests;
      assert.deepEqual(audit.violations, [], "No raw, foreign or ordinary request may escape the synthetic transport");
      const reads = result.requests.filter(row => row.method === "GET"), writes = result.requests.filter(row => row.method === "POST");
      assert(reads.length >= 1);
      const scope = new URLSearchParams(reads[0]!.query);
      assert.equal(scope.get("kind"), mode === "pagination" ? "requisition_create" : "supply_purchase_create");
      assert.equal(scope.get("targetId"), mode === "pagination" ? null : "019a0101-0000-7000-8000-000000000007");
      assert.equal(scope.has("before"), false, "The original must be found without walking fifty unrelated global rows");
      assert.equal(writes.length, mode === "pagination" ? 0 : mode === "legacy-unknown" ? 2 : 1);
      if (writes.length) assert.equal(new Set(writes.map(row => row.key)).size, 1, "Retries must retain the exact original key");
      const metrics = await dialog.evaluate(element => { const box = element.getBoundingClientRect(); return {
        viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth,
        left: box.left, right: box.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      }; });
      result.metrics = metrics;
      assert(metrics.left >= -1 && metrics.right <= metrics.viewport + 1 && metrics.documentWidth <= metrics.viewport + 1 && metrics.scrollWidth <= metrics.clientWidth + 1, "Desktop and mobile dialogs must not overflow horizontally");
      assert.deepEqual(result.errors, []); assert.deepEqual(result.consoleErrors, []); assert.equal(result.blockedRequests, 0);
      await page.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: true }); result.status = "pass";
    } catch (error) {
      result.failure = failure(error);
      try { result.requests = (await readAudit(page)).requests; await page.screenshot({ path: path.join(outputDirectory, screenshot), fullPage: true }); }
      catch { /* Keep the original assertion failure if the page never initialized. */ }
    } finally { await context.close(); }
  }
  assert.equal(results.filter(result => result.status === "pass").length, modes.length * 2, "Every synthetic lifecycle case must pass");
  assert.equal(networkBusinessRequests, 0, "No business request may reach even the isolated static server");
} catch (error) { fatal = failure(error); process.exitCode = 1; }
finally {
  try { await browser?.close(); browserClosed = true; } catch { cleanupErrors.push("browser_close_failed"); }
  try {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    serverClosed = !server.listening;
  } catch { cleanupErrors.push("server_close_failed"); }
  if (cleanupErrors.length || !browserClosed || !serverClosed) process.exitCode = 1;
  const report = { recordedAt: new Date().toISOString(), status: process.exitCode ? "failed" : "pass", phase, fatal,
    boundary: "Real source UI and shared client; synthetic personal session and in-memory commands; no ordinary ERP/API/DB/provider",
    resourcesClosed: browserClosed && serverClosed, browserClosed, serverClosed, cleanupErrors,
    businessRequests: networkBusinessRequests, cases: results };
  await writeFile(path.join(outputDirectory, "result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: report.status, casesPassed: results.filter(result => result.status === "pass").length,
    casesTotal: modes.length * 2, resourcesClosed: report.resourcesClosed, businessRequests: report.businessRequests, outputDirectory }) + "\n");
}
