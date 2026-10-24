import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Locator, type Page, type Request as BrowserRequest, type Route, type TestInfo } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolDefinitionRequestSchema, AgentToolDefinitionSchema, AgentToolResultSchema, AgentToolWorkspaceSchema, type AgentToolKey } from "@yummyai/contracts/ai/agent-tools";
import { connectDatabase, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { actors, loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), prefix = "/api/agent-tools/", sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function isolate() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  const redis = process.env.E2E_DISPOSABLE_REDIS_URL;
  const flags = ["E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED"];
  if (!nonce || flags.some(flag => process.env[flag] !== "1") || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !redis || process.env.REDIS_URL !== redis ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redis).hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" || !process.env.ERP_FIXTURE_ACTORS)
    throw new Error("Native Agent tool browser requires all opted-in exact compiled personal nonce resources before connection");
  return { url: url.href, nonce };
}
isolate();
test.setTimeout(240_000);
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, message: string, milliseconds = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Only the existing Node/tsx RPC imports decorated owners. This wrapper never
 * calls the old browser wrapper, which writes evidence to its historical batch. */
class OwnerRpc {
  private readonly child: ChildProcess;
  private sequence = 0;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly ready: Promise<void>;
  private readonly end: Promise<void>;
  readonly evidence = { acknowledged: false, exited: false, exitCode: null as number | null, signal: null as NodeJS.Signals | null, forcedKill: false };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "tools/testing/role-benchmark-browser-rpc.mts")], { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
    let accept!: () => void, reject!: (error: Error) => void;
    this.ready = new Promise((yes, no) => { accept = yes; reject = no; });
    const timer = setTimeout(() => reject(new Error("agent_tools_rpc_ready_timeout")), 30_000);
    this.end = new Promise(resolveEnd => this.child.once("exit", (exitCode, signal) => {
      clearTimeout(timer); Object.assign(this.evidence, { exited: true, exitCode, signal }); reject(new Error("agent_tools_rpc_exited_before_ready"));
      for (const row of this.waiting.values()) { clearTimeout(row.timer); row.reject(new Error("agent_tools_rpc_exited_with_pending_request")); }
      this.waiting.clear(); resolveEnd();
    }));
    this.child.once("error", () => { clearTimeout(timer); reject(new Error("agent_tools_rpc_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
      if (value.type === "ready") { if (value.nonce !== nonce) return; clearTimeout(timer); accept(); return; }
      if (value.nonce !== undefined && value.nonce !== nonce || value.type !== "result" && value.type !== "failure") return;
      if (typeof value.id !== "number") return; const row = this.waiting.get(value.id); if (!row) return;
      clearTimeout(row.timer); this.waiting.delete(value.id); if (value.type === "result") row.resolve(value.value); else row.reject(new Error("agent_tools_original_owner_rpc_failed"));
    });
  }
  async request(input: Record<string, unknown>): Promise<unknown> {
    await this.ready; if (!this.child.connected || this.evidence.exited) throw new Error("agent_tools_rpc_unavailable"); const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("agent_tools_rpc_request_timeout")); }, input.operation === "close" ? 20_000 : 120_000);
      this.waiting.set(id, { resolve: resolveRequest, reject, timer }); this.child.send({ ...input, id, nonce: this.nonce }, error => {
        if (error) { clearTimeout(timer); this.waiting.delete(id); reject(new Error("agent_tools_rpc_delivery_failed")); }
      });
    });
  }
  async close() {
    const failures: unknown[] = [];
    try { if (!this.evidence.exited) { const value = await this.request({ operation: "close" }); this.evidence.acknowledged = Boolean(value && typeof value === "object" && "closed" in value && value.closed); } }
    catch (error) { failures.push(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch (error) { failures.push(error); }
    try { await bounded(this.end, "agent_tools_rpc_exit_timeout", 20_000); }
    catch (error) { failures.push(error); this.evidence.forcedKill = true; this.child.kill("SIGKILL"); try { await bounded(this.end, "agent_tools_rpc_kill_exit_timeout", 2_000); } catch (failure) { failures.push(failure); } }
    if (!this.evidence.acknowledged || !this.evidence.exited || this.evidence.exitCode !== 0 || this.evidence.signal !== null) failures.push(new Error("agent_tools_rpc_unclean_close"));
    if (failures.length) throw new AggregateError(failures, "agent_tools_rpc_cleanup_failed");
  }
}
async function fixture(leaf: string) {
  const isolated = isolate(), journalPath = resolve(root, "packages/database/migrations/meta/_journal.json"), journal = await readFile(journalPath, "utf8");
  expect(JSON.parse(journal).entries).toHaveLength(174);
  let model: Awaited<ReturnType<typeof knowledgeGovernanceFixture>> | undefined, child: OwnerRpc | undefined, database: ReturnType<typeof connectDatabase> | undefined;
  try {
    model = await knowledgeGovernanceFixture("native-tools-" + leaf);
    const session = ErpSessionViewSchema.parse(await centerApi("identity/session")), actor = actors().operator;
    if (session.userId !== actor.userId || session.tenantId !== actor.tenantId) throw new Error("Native tool fixture requires the actual personal operator");
    const context = TenantContextSchema.parse(session); database = connectDatabase(isolated.url); child = new OwnerRpc(isolated.nonce);
    await child.request({ operation: "initialize", context });
    const source = await child.request({ operation: "source", role: "sku_package", complete: true });
    if (!source || typeof source !== "object" || !("ids" in source) || !source.ids || typeof source.ids !== "object" || !("inspectionId" in source.ids) || typeof source.ids.inspectionId !== "string") throw new Error("Actual compiled inspection ID missing");
    const inspectionId = source.ids.inspectionId;
    const query = "Synthetic native tools " + randomUUID().replace(/[0-9]/g, digit => String.fromCharCode(97 + Number(digit))).replaceAll("-", ""), published: string[] = [];
    let draftId = "";
    for (let index = 0; index < 8; index++) {
      const fields = { title: query + " " + String.fromCharCode(97 + index), summary: query, body: query + " Original synthetic source only no production or marketplace claim",
        topic: "operations", platform: "all", market: "ALL", spuId: null, sourceType: "team", sourceLabel: "Synthetic operator reviewed evidence", sourceUrl: "", owner: "Synthetic reader", verifiedOn: "2026-01-01", reviewDueOn: "2099-12-31", tags: [] };
      const saved = await centerApi<{ id: string }>("knowledge/create", { fields, expectedRevision: 0, reason: "Synthetic native reading source", requestId: randomUUID() });
      if (index === 7) { draftId = saved.id; continue; }
      await centerApi(`knowledge/${saved.id}/submit`, { version: 1, expectedRevision: 1, reason: "Synthetic source manually reviewed", requestId: randomUUID() });
      await centerApi(`knowledge/${saved.id}/publish`, { version: 1, expectedRevision: 2, reason: "Synthetic source manually published", requestId: randomUUID() }); published.push(saved.id);
    }
    const actualModel = model, actualChild = child, actualDatabase = database;
    const state = async () => ({ owners: await actualChild.request({ operation: "state" }), native: await withTenant(actualDatabase.db, context, async tx => {
      const values: Record<string, { count: number; hash: string }> = {};
      for (const table of ["ai_budget_ledger", "ai_assist_runs", "ai_assist_executions", "agent_command_requests", "agent_plan_runs", "agent_loop_runs", "creative_executions", "inventory_movements", "production_orders", "production_delivery_feedback", "factory_capacity_reservations", "finance_original_write_proofs", "audit_events"])
        values[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return values;
    }) });
    return { nonce: isolated.nonce, query, published, draftId, inspectionId, state, modelCalls: actualModel.modelCalls,
      revokeDesign: () => actualModel.setPermissions(Object.values(Permission).filter(bit => bit !== Permission.DesignRead)),
      async close() {
        const failures: unknown[] = [];
        try { await actualChild.close(); } catch (error) { failures.push(error); }
        try { await actualModel.close(); } catch (error) { failures.push(error); }
        try { await actualDatabase.client.end(); } catch (error) { failures.push(error); }
        try { expect(await readFile(journalPath, "utf8")).toBe(journal); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "agent_tools_fixture_cleanup_failed");
      }, childEvidence: actualChild.evidence,
    };
  } catch (error) {
    const failures: unknown[] = [error]; try { await child?.close(); } catch (failure) { failures.push(failure); }
    try { await model?.close(); } catch (failure) { failures.push(failure); } try { await database?.client.end(); } catch (failure) { failures.push(failure); }
    throw new AggregateError(failures, "agent_tools_fixture_initialization_failed");
  }
}

const panel = (page: Page) => page.getByRole("region", { name: "原生工具与命令目录", exact: true });
const result = (page: Page) => panel(page).getByRole("region", { name: "原生工具读取结果", exact: true });
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json()); }
async function ready(page: Page) { await expect(panel(page).getByRole("button", { name: "读取工具 5", exact: true })).toBeVisible(); await expect(panel(page).getByRole("region", { name: "所选严格工具定义", exact: true })).toBeVisible(); }
async function selectTool(page: Page, key: AgentToolKey) {
  await panel(page).getByRole("button", { name: "读取工具 5", exact: true }).click();
  const choice = panel(page).locator(".atb-catalog").getByRole("button").filter({ has: page.locator("code", { hasText: key }) });
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === prefix + "definition" && response.request().method() === "POST" && response.request().postDataJSON()?.selection?.tool === key);
  if (await choice.getAttribute("aria-pressed") === "true") await panel(page).getByRole("button", { name: "重新读取所选定义", exact: true }).click(); else await choice.click();
  const response = await waiting; expect(response.status()).toBe(200); const definition = AgentToolDefinitionSchema.parse(await response.json()); expect(definition.available).toBe(true); return definition;
}
async function executeRead(page: Page, key: AgentToolKey) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === prefix + "call" && response.request().method() === "POST" && response.request().postDataJSON()?.tool === key);
  await panel(page).locator("form").getByRole("button", { name: /^读取/ }).click(); const response = await waiting; expect(response.status()).toBe(200);
  const value = AgentToolResultSchema.parse(await response.json()); expect(value.tool).toBe(key); expect(value.inputChecksum).toBe(sha(canonicalJson(response.request().postDataJSON().input))); expect(value.dataChecksum).toBe(sha(canonicalJson(value.data))); return value;
}
async function creativeSource(page: Page, id: string) {
  await selectTool(page, "creative.history"); await panel(page).getByRole("combobox", { name: "创意执行范围", exact: true }).selectOption("inspection");
  const picker = panel(page).getByRole("combobox", { name: "选择已有创意对象", exact: true });
  await expect(picker.locator(`option[value="${id}"]`)).toHaveCount(1); await picker.selectOption(id);
}
function observe(page: Page) {
  const writes: string[] = [], pageErrors: string[] = [], errors: Array<{ path: string; hash: string; status: number | null; at: number; abort: boolean }> = [];
  const responses: Array<{ path: string; hash: string; status: number; at: number; authorityHash: string | null }> = [], failed = new Map<BrowserRequest, string>();
  page.on("request", request => { const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/ai-assists/runs" || /\/api\/agent-(loops|plans)\/runs$/.test(path) || /\/api\/.+\/(prepare|execute|confirm|adopt)$/.test(path))) writes.push(path);
  });
  page.on("requestfailed", request => failed.set(request, request.failure()?.errorText ?? "unknown"));
  page.on("response", response => { const path = new URL(response.url()).pathname; if (path.startsWith("/api/")) responses.push({ path, hash: sha(response.url()), status: response.status(), at: Date.now(), authorityHash: response.request().headers()["x-yummyai-context-authority"] ? sha(response.request().headers()["x-yummyai-context-authority"]!) : null }); });
  page.on("pageerror", () => pageErrors.push("unexpected_page_error"));
  page.on("console", message => { if (message.type() !== "error") return; let path = "", hash = ""; try { const url = new URL(message.location().url); path = url.pathname; hash = sha(url.href); } catch { /* Missing location cannot authorize an expected failure. */ }
    const match = /\b(4\d\d|5\d\d)\b/.exec(message.text()); errors.push({ path, hash, at: Date.now(), status: match ? Number(match[1]) : null, abort: /net::ERR_(ABORTED|FAILED)/.test(message.text()) }); });
  return { writes, responses, failed, pageErrors, errors };
}
async function shots(page: Page, info: TestInfo, name: string, target: Locator) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await target.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const path = info.outputPath(`${name}-${width}.png`); await page.screenshot({ path, fullPage: false }); await info.attach(`${name}-${width}`, { path, contentType: "image/png" });
  }
}
async function finish(page: Page, info: TestInfo, owner: Awaited<ReturnType<typeof fixture>>, seen: ReturnType<typeof observe>, proof: Record<string, unknown>, failure: unknown) {
  const cleanup: unknown[] = [];
  try { await page.unrouteAll({ behavior: "wait" }); } catch (error) { cleanup.push(error); }
  try { await page.close(); } catch (error) { cleanup.push(error); }
  try { await owner.close(); } catch (error) { cleanup.push(error); }
  Object.assign(proof, { nonce: owner.nonce, bodyCompleted: failure === undefined, cleanupFailureCount: cleanup.length, childClose: owner.childEvidence,
    nativeWriteRequests: seen.writes, pageErrors: seen.pageErrors, consoleErrors: seen.errors, responses: seen.responses, journal174Unchanged: !cleanup.length });
  const path = info.outputPath("agent-tools-proof.json"); await writeFile(path, JSON.stringify(proof, null, 2) + "\n"); await info.attach("agent-tools-proof", { path, contentType: "application/json" });
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "agent_tools_browser_body_or_cleanup_failed");
}

test("reads actual published knowledge and compiled creative history through personal tools and loads only one original command definition without paid or business writes", async ({ page }, info) => {
  const owner = await fixture("native-read"), seen = observe(page), proof: Record<string, unknown> = {}; let failure: unknown;
  try {
    const before = await owner.state(); await loginErp(page, "operator", "/ai-tasks"); await ready(page);
    await shots(page, info, "native-tools-panel", panel(page).locator(".atb-heading"));
    await selectTool(page, "knowledge.search"); await panel(page).getByRole("textbox", { name: "知识检索词", exact: true }).fill(owner.query);
    await panel(page).getByRole("combobox", { name: "知识主题", exact: true }).selectOption("operations");
    const knowledge = await executeRead(page, "knowledge.search"); if (knowledge.tool !== "knowledge.search") throw new Error("Wrong native family");
    expect(knowledge.data.references).toHaveLength(6); expect(knowledge.coverage).toMatchObject({ kind: "ranked_subset", complete: false, returned: 6 });
    for (const reference of knowledge.data.references) { expect(owner.published).toContain(reference.entryId); expect(reference.entryId).not.toBe(owner.draftId); await expect(result(page)).toContainText(reference.checksum); }
    await expect(result(page)).toContainText("不代表知识库全量"); await shots(page, info, "native-knowledge-source", result(page).getByRole("region", { name: "知识检索候选", exact: true }).locator("li").first());
    await creativeSource(page, owner.inspectionId); const history = await executeRead(page, "creative.history"); if (history.tool !== "creative.history") throw new Error("Wrong native family");
    expect(history.data.ownerId).toBe(owner.inspectionId); expect(history.data.entries.some(entry => entry.phase === "completed" && entry.artifacts.length > 0)).toBe(true);
    expect(history.coverage).toMatchObject({ kind: "bounded_history", complete: false }); await expect(result(page)).toContainText("技术处理完成");
    const entry = result(page).getByRole("listitem", { name: "模板编译原执行", exact: true }).first(); await entry.getByText("原请求 固定产物与已返回事件", { exact: true }).click();
    await expect(entry).toContainText(history.data.entries[0]!.fingerprint); await shots(page, info, "native-creative-history", entry);
    await panel(page).getByRole("button", { name: "原命令定义 37", exact: true }).click(); await panel(page).getByRole("textbox", { name: "搜索能力", exact: true }).fill("bill_record");
    const selected = page.waitForResponse(response => new URL(response.url()).pathname === prefix + "definition" && response.request().postDataJSON()?.selection?.command?.kind === "bill_record");
    await panel(page).locator(".atb-catalog").getByRole("button", { name: /bill_record/ }).click(); const definitionResponse = await selected; expect(definitionResponse.status()).toBe(200);
    const definition = AgentToolDefinitionSchema.parse(await definitionResponse.json()), wire = JSON.stringify(definition.inputSchema);
    expect(wire).toContain("bill_record"); for (const other of ["purchase_create", "payment_record", "reviewed_order"]) expect(wire.includes(other)).toBe(false);
    expect(await panel(page).locator("form").count()).toBe(0); expect(owner.modelCalls()).toBe(0); expect(seen.writes).toEqual([]); expect(await owner.state()).toEqual(before);
    expect(seen.pageErrors).toEqual([]); expect(seen.errors).toEqual([]);
    Object.assign(proof, { knowledgeEntryIds: knowledge.data.references.map(reference => reference.entryId), originalKnowledgeHashes: knowledge.data.references.map(reference => reference.checksum),
      creativeOwnerId: owner.inspectionId, creativeExecutionIds: history.data.entries.map(entry => entry.id), inputChecksums: [knowledge.inputChecksum, history.inputChecksum],
      selectedNativeKind: "bill_record", definitionChecksum: definition.definitionChecksum, paidRequests: 0, originalFactsUnchanged: true,
      limits: "Published top-six knowledge and bounded real compile history; no MCP, paid runtime, business preparation or production-release assertion" });
  } catch (error) { failure = error; }
  await finish(page, info, owner, seen, proof, failure);
});

test("discards a completed real creative read after current domain revocation and reenters the personal BFF with no stale history or new paid work", async ({ page }, info) => {
  const owner = await fixture("late-authority"), seen = observe(page), proof: Record<string, unknown> = {}, release = latch(), entered = latch(), settled = latch();
  let failure: unknown, routeFailure: unknown, heldRequest: BrowserRequest | undefined, upstreamStatus = 0, fulfilled = false;
  const pattern = "**" + prefix + "call", gate = async (route: Route) => {
    if (route.request().postDataJSON()?.tool !== "creative.history") { await route.continue(); return; }
    heldRequest = route.request();
    try { const response = await route.fetch(); upstreamStatus = response.status(); const bytes = await response.body(); expect(upstreamStatus).toBe(200); entered.resolve(); await release.promise; await route.fulfill({ response, body: bytes }); fulfilled = true; }
    catch (error) { routeFailure = error; entered.resolve(); } finally { settled.resolve(); }
  };
  try {
    const before = await owner.state(); await loginErp(page, "operator", "/ai-tasks"); await ready(page); await creativeSource(page, owner.inspectionId);
    const originalAuthority = erpSessionAuthority(await session(page)); await page.route(pattern, gate);
    await panel(page).locator("form").getByRole("button", { name: /^读取/ }).click(); await bounded(entered.promise, "Actual native creative response did not arrive"); expect(upstreamStatus).toBe(200);
    const changedAt = Date.now(); await owner.revokeDesign(); const current = await session(page), currentAuthority = erpSessionAuthority(current);
    expect(current.permissions.includes(Permission.WorkflowRead)).toBe(true); expect(current.permissions.includes(Permission.DesignRead)).toBe(false); expect(currentAuthority).not.toBe(originalAuthority);
    const navigated = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame() && new URL(frame.url()).pathname === "/ai-tasks" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigated; await ready(page);
    expect(erpSessionAuthority(await session(page))).toBe(currentAuthority);
    // A response header from the document being replaced is not a received
    // workspace body. Re-read through the real control in the current document.
    const reloaded = page.waitForResponse(response => new URL(response.url()).pathname === prefix + "workspace" && response.status() === 200 && response.request().headers()["x-yummyai-context-authority"] === currentAuthority);
    await panel(page).getByRole("button", { name: "重新读取工具目录", exact: true }).click();
    const response = await reloaded; expect(await response.finished()).toBeNull();
    const workspace = AgentToolWorkspaceSchema.parse(await response.json());
    expect(workspace.contextAuthority).toBe(currentAuthority); expect(response.headers()["x-yummyai-context-authority"]).toBe(currentAuthority);
    expect(workspace.tools.find(tool => tool.key === "creative.history")?.available).toBe(false); expect(workspace.tools.find(tool => tool.key === "knowledge.search")?.available).toBe(true);
    await ready(page);
    await expect(panel(page).locator(".atb-catalog").getByRole("button", { name: /creative\.history/ })).toContainText("当前不可读取");
    await expect(panel(page).locator(".atb-catalog").getByRole("button", { name: /knowledge\.search/ })).toContainText("当前可读取");
    Object.assign(proof, { currentDocumentReloadObserved: true, workspaceBodyReceived: true, workspaceAuthorityHash: sha(workspace.contextAuthority) });
    release.resolve(); await bounded(settled.promise, "Late original route did not settle"); await page.unroute(pattern, gate);
    if (routeFailure && (!heldRequest || !seen.failed.get(heldRequest)?.includes("ERR_ABORTED"))) throw routeFailure;
    await ready(page); expect(await result(page).count()).toBe(0); await expect(panel(page)).not.toContainText(owner.inspectionId); await expect(panel(page)).not.toContainText("技术处理完成");
    const currentOrigin = new URL(page.url()).origin; expect(currentOrigin).toBe("http://localhost:3130");
    const directHeaders = { origin: currentOrigin, "content-type": "application/json", "x-yummyai-context-authority": currentAuthority };
    const definitionInput = AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "creative.history" } });
    const denied = await page.request.post(prefix + "definition", { headers: directHeaders, data: definitionInput });
    const definitionBytes = await denied.body(), definitionDiagnostic = { status: denied.status(), contentType: denied.headers()["content-type"] ?? null, bytes: definitionBytes.length, bodyChecksum: sha(definitionBytes) };
    Object.assign(proof, { directDefinition: definitionDiagnostic });
    expect(denied.status(), JSON.stringify(definitionDiagnostic)).toBe(200); expect(AgentToolDefinitionSchema.parse(await denied.json()).available).toBe(false);
    const initialWorkspace = await page.request.get(prefix + "workspace", { headers: { "x-yummyai-context-authority": currentAuthority } }); expect(initialWorkspace.status()).toBe(200);
    const live = AgentToolWorkspaceSchema.parse(await initialWorkspace.json()), unavailable = AgentToolDefinitionSchema.parse(await denied.json());
    const deniedInput = AgentToolCallSchema.parse({ version: AGENT_TOOLS_VERSION, executionContract: live.executionContract,
      definitionChecksum: unavailable.definitionChecksum, tool: "creative.history", input: { scope: "inspection", ownerId: owner.inspectionId } });
    const deniedCall = await page.request.post(prefix + "call", { headers: directHeaders, data: deniedInput });
    const deniedBytes = await deniedCall.body(), deniedDiagnostic = { status: deniedCall.status(), contentType: deniedCall.headers()["content-type"] ?? null, bytes: deniedBytes.length, bodyChecksum: sha(deniedBytes) };
    Object.assign(proof, { directCall: deniedDiagnostic });
    expect(deniedCall.status(), JSON.stringify(deniedDiagnostic)).toBe(403); expect(await deniedCall.text()).not.toContain(owner.inspectionId);
    await selectTool(page, "knowledge.search"); await panel(page).getByRole("textbox", { name: "知识检索词", exact: true }).fill(owner.query);
    const knowledge = await executeRead(page, "knowledge.search"); expect(knowledge.tool).toBe("knowledge.search");
    expect(owner.modelCalls()).toBe(0); expect(seen.writes).toEqual([]); expect(await owner.state()).toEqual(before); expect(seen.pageErrors).toEqual([]);
    const unexpected = seen.errors.filter(error => !(error.at >= changedAt && error.path.startsWith(prefix) &&
      (error.status === 409 && seen.responses.some(row => row.hash === error.hash && row.status === 409 && Math.abs(row.at - error.at) < 5000) ||
        error.abort && heldRequest && sha(heldRequest.url()) === error.hash && seen.failed.has(heldRequest))));
    expect(unexpected).toEqual([]);
    Object.assign(proof, { originalAuthorityHash: sha(originalAuthority), currentAuthorityHash: sha(currentAuthority), upstreamStatus, fulfilled,
      routeReturned: true, lateReadAborted: Boolean(heldRequest && seen.failed.has(heldRequest)), directCurrentReadStatus: deniedCall.status(), currentKnowledgeReadable: true,
      privateHistoryHidden: true, paidRequests: 0, originalFactsUnchanged: true });
  } catch (error) { failure = error; }
  finally { release.resolve(); if (heldRequest) { try { await bounded(settled.promise, "Late route cleanup did not settle"); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; } } }
  await finish(page, info, owner, seen, proof, failure);
});
