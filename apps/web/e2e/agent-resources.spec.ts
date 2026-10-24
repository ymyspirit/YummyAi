import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema, AgentResourceDefinitionSchema, AgentResourceResultSchema, AgentResourceWorkspaceSchema,
  agentResourceInputSchemas, type AgentResourceKey } from "@yummyai/contracts/ai/agent-resources";
import { verifyAgentResourceResult } from "@yummyai/contracts/ai/agent-resource-transport";
import { AGENT_MCP_TOOL_NAMES as names, AgentMcpPacketSchema } from "@yummyai/contracts/ai/agent-mcp";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import { loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const panel = (page: Page) => page.getByRole("region", { name: "业务资源读取", exact: true });
const result = (page: Page) => page.getByRole("region", { name: "原业务资源读取结果", exact: true });
const sourceIndex = (page: Page) => page.getByRole("region", { name: "原业务来源索引", exact: true });
const Seed = z.object({ id: z.uuidv7(), inputs: z.object(agentResourceInputSchemas).strict(), labels: z.record(z.string(), z.string()),
  foreign: agentResourceInputSchemas["research.evidence"].extend({ label: z.string() }).strict(), contextAuthority: z.string() }).strict();
const State = z.object({ tables: z.record(z.string(), z.object({ count: z.number(), hash: z.string() }).strict()), paidDispatches: z.number(), providerRequests: z.number() }).strict();
type Source = z.infer<typeof Seed>;
test.describe.configure({ mode: "serial" }); test.setTimeout(240_000);
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30_000) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
class ResourceChild {
  private readonly child: ChildProcess; private readonly ready: Promise<void>; private readonly ended: Promise<void>; private sequence = 0;
  private readonly pending = new Map<number, { accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly evidence = { acknowledged: false, exited: false, exitCode: null as number | null, signal: null as NodeJS.Signals | null, forcedKill: false,
    restored: false, ownedCount: 0, clients: [] as Array<{ closed: boolean; processExited: boolean; credentialLeaked: boolean; environmentKeys: string[] }> };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/ai/agent-resources.test-fixture.ts"), "--agent-resources-browser-child"], { cwd: root, windowsHide: true,
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let accept!: () => void, reject!: (error: Error) => void;
    this.ready = new Promise((yes, no) => { accept = yes; reject = no; });
    const timeout = setTimeout(() => reject(new Error("resource_owner_ready_timeout")), 30_000);
    this.ended = new Promise(done => this.child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout); Object.assign(this.evidence, { exited: true, exitCode, signal }); reject(new Error("resource_owner_exited_before_ready"));
      for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error("resource_owner_exited_with_pending_request")); } this.pending.clear(); done();
    }));
    this.child.once("error", () => { clearTimeout(timeout); reject(new Error("resource_owner_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
      if (value.nonce !== nonce) return;
      if (value.type === "ready") { clearTimeout(timeout); accept(); return; }
      if (typeof value.id !== "number" || value.type !== "result" && value.type !== "failure") return;
      const row = this.pending.get(value.id); if (!row) return; this.pending.delete(value.id); clearTimeout(row.timer);
      if (value.type === "result") row.accept(value.value);
      else row.reject(new Error("resource_owner_failed_" + (typeof value.phase === "string" && /^[a-z_]{1,60}$/.test(value.phase) ? value.phase : "unknown") +
        (typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code) ? "_" + value.code : "")));
    });
  }
  async request(input: Record<string, unknown>) {
    await this.ready; if (!this.child.connected || this.evidence.exited) throw new Error("resource_owner_unavailable"); const id = ++this.sequence;
    return new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("resource_owner_request_timeout")); }, input.operation === "close" ? 20_000 : 120_000);
      this.pending.set(id, { accept, reject, timer }); this.child.send({ ...input, nonce: this.nonce, id }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("resource_owner_delivery_failed")); }
      });
    });
  }
  async close() {
    const errors: unknown[] = [];
    try { if (!this.evidence.exited) {
      const value = z.object({ closed: z.literal(true), restored: z.literal(true), ownedCount: z.number().int().nonnegative(),
        clients: z.array(z.object({ closed: z.boolean(), processExited: z.boolean(), credentialLeaked: z.boolean(), environmentKeys: z.array(z.string()) }).passthrough()) }).strict()
        .parse(await this.request({ operation: "close" }));
      Object.assign(this.evidence, { acknowledged: value.closed, restored: value.restored, ownedCount: value.ownedCount, clients: value.clients });
    } } catch (error) { errors.push(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch (error) { errors.push(error); }
    try { await bounded(this.ended, "resource_owner_exit_timeout", 20_000); }
    catch (error) { errors.push(error); this.evidence.forcedKill = true; this.child.kill("SIGKILL"); try { await bounded(this.ended, "resource_owner_kill_exit_timeout", 2_000); } catch (failure) { errors.push(failure); } }
    if (!this.evidence.acknowledged || !this.evidence.restored || !this.evidence.exited || this.evidence.exitCode !== 0 || this.evidence.signal !== null ||
      this.evidence.clients.some(value => !value.closed || !value.processExited || value.credentialLeaked)) errors.push(new Error("resource_owner_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "resource_owner_cleanup_failed");
  }
}
async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json());
}
async function fixture(leaf: string, page: Page) {
  requireAgentReadBrowser(); if (process.env.E2E_AGENT_RESOURCES_ISOLATED !== "1") throw new Error("Resources browser requires its own opt-in");
  const base = await agentReadBrowserFixture("resources-" + leaf); let child: ResourceChild;
  try { child = new ResourceChild(base.nonce); } catch (error) { try { await base.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Resource initialization and cleanup failed"); } throw error; }
  let closed = false;
  return { ...base, childClose: child.evidence,
    async seed() { const actual = await session(page); expect(actual.userId).toBe(base.context.userId); expect(actual.tenantId).toBe(base.context.tenantId);
      return Seed.parse(await child.request({ operation: "seed", context: TenantContextSchema.parse(actual) })); },
    async state() { return State.parse(await child.request({ operation: "state" })); },
    async narrow() { return child.request({ operation: "research_self" }); },
    async connect() {
      const issuer = new URL(process.env.FACTORY_IDENTITY_FIXTURE_URL ?? "https://invalid.invalid"), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid"), control = process.env.FACTORY_FIXTURE_CONTROL_TOKEN;
      if (!control || !["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname) || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130") throw new Error("Resource personal issuer missing");
      const minted = await fetch(new URL("/_fixture/token", issuer), { method: "POST", redirect: "error", cache: "no-store", headers: { "x-fixture-control": control,
        "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ account: "operator", client_id: "yummyai-web" }) });
      expect(minted.status).toBe(200); const token = z.object({ access_token: z.string().min(1).max(32768) }).strict().parse(await minted.json()).access_token;
      const original = await fetch(new URL("/v1/identity/session", api), { cache: "no-store", redirect: "error", headers: { authorization: `Bearer ${token}` } });
      expect(original.status).toBe(200); const actual = ErpSessionViewSchema.parse(await original.json()), current = await session(page);
      expect(actual.userId).toBe(current.userId); expect(actual.tenantId).toBe(current.tenantId); expect(erpSessionAuthority(actual)).toBe(erpSessionAuthority(current));
      return z.object({ clientId: z.int().nonnegative(), tools: z.array(z.string()) }).strict().parse(await child.request({ operation: "connect", token, flags: ["--allow-resource=research.evidence"] }));
    },
    async call(clientId: number, name: string, input: Record<string, unknown>) {
      return z.object({ packet: AgentMcpPacketSchema, isError: z.boolean() }).strict().parse(await child.request({ operation: "call", clientId, name, input }));
    },
    async close() { if (closed) return; closed = true; const errors: unknown[] = [];
      try { await child.close(); } catch (error) { errors.push(error); } try { await base.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Resource browser teardown failed");
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function observe(page: Page) {
  const posts: string[] = [], pageErrors: string[] = [], consoleErrors: Array<{ path: string; status: number | null; hash: string; at: number }> = [],
    responses: Array<{ path: string; status: number; code: string | null; authorityHash: string | null; at: number }> = [], pending: Promise<void>[] = [];
  let transition = false;
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  page.on("response", response => { if (response.status() < 400) return; const request = response.request();
    const row = { path: new URL(response.url()).pathname, status: response.status(), code: null as string | null, authorityHash: request.headers()["x-yummyai-context-authority"] ? sha(request.headers()["x-yummyai-context-authority"]!) : null, at: Date.now() }; responses.push(row);
    pending.push(response.json().then((raw: unknown) => { if (raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string") row.code = raw.code; }).catch(() => {}));
  });
  page.on("console", value => { if (value.type() !== "error") return; let path = ""; try { path = new URL(value.location().url).pathname; } catch { /* No broad missing-location exemption. */ }
    const match = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(value.text()); consoleErrors.push({ path, status: match ? Number(match[1]) : null, hash: sha(value.text()), at: Date.now() }); });
  return { posts, pageErrors, consoleErrors, responses, transition() { transition = true; }, async check() {
    await Promise.all(pending); expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter(error => !(transition && error.status === 409 && responses.some(row => row.path === error.path && row.status === 409 && row.code === "authority_changed" && row.authorityHash !== null && Math.abs(row.at - error.at) < 2000)))).toEqual([]);
    const readOnly = new Set(["/api/agent-resources/definition", "/api/agent-resources/candidates", "/api/agent-resources/call",
      "/api/agent-tools/definition", "/api/agent-tools/objects", "/fixture-login"]);
    expect(posts.filter(path => !readOnly.has(path) && !path.startsWith("/api/identity/") && !path.startsWith("/api/erp-auth/"))).toEqual([]);
  } };
}
async function leaf(page: Page, info: TestInfo, action: (f: Fixture, source: Source, seen: ReturnType<typeof observe>, proof: Record<string, unknown>) => Promise<void>) {
  let f: Fixture | undefined, failure: unknown; const cleanup: unknown[] = [], seen = observe(page);
  const proof: Record<string, unknown> = { operation: "8d6f2a19", title: info.title, sourceOwners: 6, paidModelRequests: 0, automaticBusinessExecution: false, privateBodyRetained: false };
  try { f = await fixture(info.title.includes("six") ? "six" : "late", page); await loginErp(page, "operator", "/ai-tasks");
    await expect(panel(page)).toBeVisible(); const source = await f.seed(); await action(f, source, seen, proof);
  } catch (error) { failure = error; }
  finally {
    try { await f?.close(); } catch (error) { cleanup.push(error); }
    try { await seen.check(); } catch (error) { cleanup.push(error); }
    Object.assign(proof, { childClose: f?.childClose ?? null, cleanupFailureCount: cleanup.length, posts: seen.posts, pageErrors: seen.pageErrors, consoleErrors: seen.consoleErrors, responses: seen.responses });
    const path = info.outputPath("agent-resources-proof.json"); await writeFile(path, JSON.stringify(proof)); await info.attach("agent-resources-proof", { path, contentType: "application/json" });
  }
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "Personal resource acceptance failed");
}
async function chooseTool(page: Page, tool: AgentResourceKey) {
  const button = panel(page).getByRole("button").filter({ hasText: tool }); await expect(button).toHaveCount(1);
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  await expect(panel(page).getByRole("region", { name: "所选业务资源定义", exact: true })).toBeVisible();
}
async function selectObject(page: Page, tool: AgentResourceKey, source: Source, foreign = false) {
  await chooseTool(page, tool);
  const input = panel(page).getByRole("region", { name: "所选资源严格输入", exact: true });
  if (["research.evidence", "catalog.sku", "listing.version"].includes(tool)) await input.getByRole("textbox", { name: "搜索原业务对象", exact: true }).fill(foreign ? source.foreign.label : source.id);
  if (tool === "advertising.analysis") {
    const account = input.getByRole("combobox", { name: "选择真实广告账户", exact: true });
    await expect(account.locator(`option[value="${source.inputs["advertising.analysis"].accountId}"]`)).toHaveCount(1);
    await account.selectOption(source.inputs["advertising.analysis"].accountId);
  }
  const id = foreign ? source.foreign.researchItemId : tool === "research.evidence" ? source.inputs[tool].researchItemId : tool === "catalog.sku" ? source.inputs[tool].skuId :
    tool === "listing.version" ? source.inputs[tool].listingId : tool === "orders.order" ? source.inputs[tool].orderId : tool === "finance.profit_run" ? source.inputs[tool].runId : source.inputs[tool].analysisId;
  const select = input.getByRole("combobox", { name: "选择原业务对象", exact: true });
  await expect(select.locator(`option[value="${id}"]`)).toHaveCount(1); await select.selectOption(id);
  await expect(panel(page).getByRole("button", { name: "读取所选原资料", exact: true })).toBeEnabled();
}
async function readSelected(page: Page, tool: AgentResourceKey) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/agent-resources/call" && value.request().method() === "POST" &&
    AgentResourceCallSchema.safeParse(value.request().postDataJSON()).data?.tool === tool);
  await panel(page).getByRole("button", { name: "读取所选原资料", exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200);
  const call = AgentResourceCallSchema.parse(actual.request().postDataJSON()), value = AgentResourceResultSchema.parse(await actual.json());
  expect(actual.headers()["x-yummyai-context-authority"]).toBe(value.contextAuthority); await verifyAgentResourceResult(value, call);
  await expect(result(page)).toBeVisible(); await expect(sourceIndex(page)).toBeVisible(); return value;
}
async function screenshot(page: Page, info: TestInfo, label: string) {
  await result(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`${label}-viewport.png`) });
  await sourceIndex(page).screenshot({ path: info.outputPath(`${label}-sources.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
}

test("reads six real business resources through personal candidate selection and original sources without any paid run preparation or execution", async ({ page }, info) => {
  await leaf(page, info, async (f, source, _seen, proof) => {
    const before = await f.state(), reads: Array<{ tool: AgentResourceKey; callId: string; inputChecksum: string; dataChecksum: string; sourceCount: number }> = [];
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const tool of ["research.evidence", "catalog.sku", "listing.version", "orders.order", "finance.profit_run", "advertising.analysis"] as const) {
      await selectObject(page, tool, source); const value = await readSelected(page, tool);
      expect(value.coverage.complete).toBe(false); reads.push({ tool, callId: value.callId, inputChecksum: value.inputChecksum, dataChecksum: value.dataChecksum, sourceCount: value.sources.length });
      if (value.tool === "research.evidence") { expect(value.data.source.content).toBeNull(); expect(value.data.snapshot.price).toMatchObject({ amount: 20, currency: "USD" }); await screenshot(page, info, "desktop-research"); }
      else if (value.tool === "catalog.sku") {
        expect(value.data.recipe?.status).toBe("pending_adaptation"); expect(value.data.recipe?.specification.facts.packageQuantity).toBe(1);
        await panel(page).getByRole("combobox", { name: "SKU 配方版本", exact: true }).selectOption(source.inputs["catalog.sku"].recipeId!);
        const pinned = await readSelected(page, tool); expect(pinned.input).toEqual(source.inputs["catalog.sku"]);
      } else if (value.tool === "listing.version") expect(value.data.version.status).toBe("draft");
      else if (value.tool === "orders.order") { expect(value.data.orderTotal).toEqual({ amountMinor: 12345, currency: "USD" }); await expect(result(page)).toContainText(source.id); }
      else if (value.tool === "finance.profit_run") { expect(value.data.profitMinor).toBe(5300); expect(value.data.reportingCurrency).toBe("USD"); }
      else { expect(value.data.result.totals[0]?.metrics.spendMinor).toBe(1000); await screenshot(page, info, "desktop-advertising"); }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot(page, info, "mobile-advertising");
    await selectObject(page, "research.evidence", source); await readSelected(page, "research.evidence"); await screenshot(page, info, "mobile-research");
    expect(await f.state()).toEqual(before); expect(before.providerRequests).toBe(0); expect(before.paidDispatches).toBe(0);
    await expect(panel(page).getByRole("button", { name: /确认执行|准备原操作|付款|发布/ })).toHaveCount(0);
    Object.assign(proof, { reads, immutableBusinessAndLedger: true, responsiveWidths: [1440, 390], coverage: "single_object_projection_complete_false" });
  });
});

test("discards a completed foreign research response after actual current-scope narrowing and keeps same-person MCP opt-in and original read denial", async ({ page }, info) => {
  await leaf(page, info, async (f, source, seen, proof) => {
    const before = await f.state(); await selectObject(page, "research.evidence", source, true);
    const first = await readSelected(page, "research.evidence"); expect(first.tool).toBe("research.evidence");
    await expect(result(page)).toContainText(source.foreign.label);
    const sdk = await f.connect(); expect(sdk.tools.sort()).toEqual(Object.values(names).sort());
    const schema = await f.call(sdk.clientId, names.schema, { key: "resource/research.evidence" }); expect(schema.isError).toBe(false);
    const definition = AgentResourceDefinitionSchema.parse(schema.packet.data.definition), pin = HarnessExecutionContractSchema.parse(schema.packet.data.executionContract);
    const foreignInput = { researchItemId: source.foreign.researchItemId, snapshotId: source.foreign.snapshotId, studyRevisionId: source.foreign.studyRevisionId };
    const call = AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", input: foreignInput,
      executionContract: pin, definitionChecksum: definition.definitionChecksum });
    const actual = await f.call(sdk.clientId, names.execute, { operation: "read", requestJson: JSON.stringify(call) }); expect(actual.isError).toBe(false);
    await verifyAgentResourceResult(AgentResourceResultSchema.parse(actual.packet.data), call);
    const entered = latch(), release = latch(), settled = latch(); let intercepted = false, returned = false, routeErrorHash: string | null = null, heldChecksum: string | null = null;
    await page.route("**/api/agent-resources/call", async route => {
      const original = AgentResourceCallSchema.safeParse(route.request().postDataJSON());
      if (!original.success || original.data.tool !== "research.evidence") { await route.continue(); return; }
      intercepted = true;
      try {
        const response = await route.fetch(); expect(response.status()).toBe(200); const body = await response.body();
        heldChecksum = sha(body.toString("utf8")); entered.resolve(); await release.promise;
        try { await route.fulfill({ response, body }); returned = true; } catch (error) { routeErrorHash = sha(error instanceof Error ? error.name + ":" + error.message : "route_release_failed"); }
      }
      finally { settled.resolve(); }
    });
    try {
      await panel(page).getByRole("button", { name: "读取所选原资料", exact: true }).click(); await bounded(entered.promise, "Actual resource BFF did not reach held completed response");
      await f.narrow(); const fresh = await session(page), authority = erpSessionAuthority(fresh);
      expect(fresh.permissionScopes?.["research:read"]).toBe("self"); expect(authority).not.toBe(first.contextAuthority); seen.transition();
      const navigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation;
      await expect(panel(page)).toBeVisible();
      const workspaceResponse = await page.request.get("/api/agent-resources/workspace", { headers: { "x-yummyai-context-authority": authority } });
      expect(workspaceResponse.status()).toBe(200); const workspace = AgentResourceWorkspaceSchema.parse(await workspaceResponse.json());
      expect(workspace.contextAuthority).toBe(authority); expect(workspace.tools.find(tool => tool.key === "research.evidence")?.available).toBe(true);
      release.resolve(); await bounded(settled.promise, "Original held resource response did not settle after identity navigation"); await page.unroute("**/api/agent-resources/call");
      await expect(result(page)).toHaveCount(0); await expect(panel(page).getByText(source.foreign.label, { exact: true })).toHaveCount(0);
      await chooseTool(page, "research.evidence"); await panel(page).getByRole("textbox", { name: "搜索原业务对象", exact: true }).fill(source.foreign.label);
      await expect(panel(page).getByRole("combobox", { name: "选择原业务对象", exact: true }).locator(`option[value="${source.foreign.researchItemId}"]`)).toHaveCount(0);
      await expect(panel(page).getByRole("button", { name: "读取所选原资料", exact: true })).toBeDisabled();
      const current = new URL(page.url()); expect(current.origin).toBe("http://localhost:3130");
      const headers = { origin: current.origin, "content-type": "application/json", "x-yummyai-context-authority": authority };
      const direct = await page.request.post("/api/agent-resources/call", { headers, data: AgentResourceCallSchema.parse(call) });
      expect(direct.status()).toBe(404); const denied = await direct.json() as Record<string, unknown>;
      expect(JSON.stringify(denied).includes(source.foreign.label)).toBe(false);
      const sdkDenied = await f.call(sdk.clientId, names.execute, { operation: "read", requestJson: JSON.stringify(call) });
      expect(sdkDenied.isError).toBe(true); expect(sdkDenied.packet.kind).toBe("error");
      await selectObject(page, "catalog.sku", source); await readSelected(page, "catalog.sku");
      expect(await f.state()).toEqual(before); expect(returned || routeErrorHash !== null).toBe(true);
      Object.assign(proof, { heldResponseChecksum: heldChecksum, returned, routeErrorHash, actualSelfScope: true, personalMcpIdentityVerified: true,
        directDenial: { status: direct.status(), code: typeof denied.code === "string" ? denied.code : null }, immutableBusinessAndLedger: true,
        staleForeignBodyHidden: true, unrelatedCatalogStillReadable: true });
    } finally { release.resolve(); if (intercepted) await bounded(settled.promise, "Original resource interceptor did not settle during teardown"); await page.unroute("**/api/agent-resources/call"); }
  });
});
