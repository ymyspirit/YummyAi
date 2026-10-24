import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts";
import { AGENT_MCP_TOOL_NAMES as names, AgentMcpPacketSchema } from "@yummyai/contracts/ai/agent-mcp";
import { AGENT_NATIVE_VERSION, AgentNativeItemReceiptSchema, AgentNativeReceiptSchema, AgentNativeViewSchema, AgentNativeWorkspaceSchema,
  CreateAgentNativeSchema, defaultAgentNativeLimits, type AgentNativeView } from "@yummyai/contracts/ai/agent-native";
import { AgentCommandOriginalSchema, AgentCommandViewSchema } from "@yummyai/contracts/ai/agent-command";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import { loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), sha = (value: string) => createHash("sha256").update(value).digest("hex");
const nativeRegion = (page: Page) => page.getByRole("region", { name: "原生工具模型任务", exact: true });
const nativeEvidence = (page: Page) => page.getByRole("region", { name: "原生工具任务实际依据", exact: true });
const Seed = z.object({ stockItemId: z.uuidv7(), supplierId: z.uuidv7(), inspectionId: z.uuidv7(), factoryId: z.uuidv7(), from: z.iso.date(), query: z.string(),
  originals: z.array(AgentCommandOriginalSchema).length(2), contextText: z.string() }).strict();
const Progress = z.object({ modelCalls: z.int().nonnegative(), readCalls: z.int().nonnegative(), definitionCalls: z.int().nonnegative(),
  settled: z.boolean(), failure: z.string().nullable(), originalQueueJobId: z.string().nullable() }).strict();
const CommandCleanup = z.object({ runId: z.uuidv7(), itemId: z.uuidv7(), agentCommandId: z.uuidv7(), ownerCommandId: z.uuidv7(), initialState: z.string().max(30), finalState: z.string().max(30),
  actions: z.array(z.object({ action: z.enum(["cancel", "acknowledge"]), state: z.string().max(30), acknowledged: z.boolean() }).strict()), businessPreserved: z.literal(true) }).strict();
test.describe.configure({ mode: "serial" }); test.setTimeout(240_000);
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30_000) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
class McpChild {
  private readonly child: ChildProcess; private readonly ready: Promise<void>; private readonly ended: Promise<void>; private sequence = 0;
  private readonly pending = new Map<number, { accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly closeEvidence = { acknowledged: false, exited: false, exitCode: null as number | null, signal: null as NodeJS.Signals | null, forcedKill: false,
    clients: [] as Array<{ closed: boolean; processExited: boolean; credentialLeaked: boolean; injectedEnvironmentKeys: string[] }>, commandCleanup: [] as Array<z.infer<typeof CommandCleanup>> };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/ai/agent-mcp.test-fixture.ts"), "--agent-mcp-browser-child"], { cwd: root, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
    let accept!: () => void, reject!: (error: Error) => void;
    this.ready = new Promise((yes, no) => { accept = yes; reject = no; });
    const timeout = setTimeout(() => reject(new Error("mcp_owner_ready_timeout")), 30_000);
    this.ended = new Promise(done => this.child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout); Object.assign(this.closeEvidence, { exited: true, exitCode, signal }); reject(new Error("mcp_owner_exited_before_ready"));
      for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error("mcp_owner_exited_with_pending_request")); } this.pending.clear(); done();
    }));
    this.child.once("error", () => { clearTimeout(timeout); reject(new Error("mcp_owner_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
      if (value.nonce !== nonce) return;
      if (value.type === "ready") { clearTimeout(timeout); accept(); return; }
      if (typeof value.id !== "number" || value.type !== "result" && value.type !== "failure") return;
      const row = this.pending.get(value.id); if (!row) return; this.pending.delete(value.id); clearTimeout(row.timer);
      if (value.type === "result") row.accept(value.value);
      else row.reject(new Error("mcp_owner_failed_" + (typeof value.phase === "string" && /^[a-z_]{1,60}$/.test(value.phase) ? value.phase : "unknown") +
        (typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code) ? "_" + value.code : "")));
    });
  }
  async request(input: Record<string, unknown>) {
    await this.ready; if (!this.child.connected || this.closeEvidence.exited) throw new Error("mcp_owner_unavailable"); const id = ++this.sequence;
    return new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("mcp_owner_request_timeout")); }, input.operation === "close" ? 20_000 : 120_000);
      this.pending.set(id, { accept, reject, timer }); this.child.send({ ...input, nonce: this.nonce, id }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("mcp_owner_delivery_failed")); }
      });
    });
  }
  async close() {
    const errors: unknown[] = [];
    try { if (!this.closeEvidence.exited) {
      const result = z.object({ closed: z.literal(true), clients: z.array(z.object({ closed: z.boolean(), processExited: z.boolean(), credentialLeaked: z.boolean(), injectedEnvironmentKeys: z.array(z.string()) }).passthrough()), commandCleanup: z.array(CommandCleanup) }).strict()
        .parse(await this.request({ operation: "close" })); this.closeEvidence.acknowledged = result.closed; this.closeEvidence.clients = result.clients; this.closeEvidence.commandCleanup = result.commandCleanup;
    } } catch (error) { errors.push(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch (error) { errors.push(error); }
    try { await bounded(this.ended, "mcp_owner_exit_timeout", 20_000); }
    catch (error) { errors.push(error); this.closeEvidence.forcedKill = true; this.child.kill("SIGKILL"); try { await bounded(this.ended, "mcp_owner_kill_exit_timeout", 2_000); } catch (failure) { errors.push(failure); } }
    if (!this.closeEvidence.acknowledged || !this.closeEvidence.exited || this.closeEvidence.exitCode !== 0 || this.closeEvidence.signal !== null ||
      this.closeEvidence.clients.some(value => !value.closed || !value.processExited || value.credentialLeaked)) errors.push(new Error("mcp_owner_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "mcp_owner_cleanup_failed");
  }
}
async function fixture(leaf: string, page: Page) {
  requireAgentReadBrowser(); if (process.env.E2E_AGENT_MCP_ISOLATED !== "1" || process.env.E2E_AGENT_NATIVE_ISOLATED !== "1") throw new Error("MCP browser requires its exact isolated native family");
  const base = await agentReadBrowserFixture("mcp-" + leaf); let child: McpChild;
  try { child = new McpChild(base.nonce); } catch (error) { const errors = [error]; try { await base.close(); } catch (failure) { errors.push(failure); } throw new AggregateError(errors, "MCP browser initialization failed"); }
  let closed = false;
  return { ...base, childClose: child.closeEvidence,
    async seed() { return Seed.parse(await child.request({ operation: "seed", context: TenantContextSchema.parse(base.context) })); },
    async connect(flags: readonly string[] = []) {
      const issuer = new URL(process.env.FACTORY_IDENTITY_FIXTURE_URL ?? "https://invalid.invalid"), api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
      const control = process.env.FACTORY_FIXTURE_CONTROL_TOKEN;
      if (!control || !["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname) || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130")
        throw new Error("Actual personal fixture issuer boundary missing");
      const minted = await fetch(new URL("/_fixture/token", issuer), { method: "POST", redirect: "error", cache: "no-store",
        headers: { "x-fixture-control": control, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ account: "operator", client_id: "yummyai-web" }) });
      expect(minted.status).toBe(200); const token = z.object({ access_token: z.string().min(1).max(32_768) }).strict().parse(await minted.json()).access_token;
      const original = await fetch(new URL("/v1/identity/session", api), { redirect: "error", cache: "no-store", headers: { authorization: "Bearer " + token } });
      expect(original.status).toBe(200); const actual = ErpSessionViewSchema.parse(await original.json()), current = await session(page);
      expect(actual.userId).toBe(current.userId); expect(actual.tenantId).toBe(current.tenantId); expect(erpSessionAuthority(actual)).toBe(erpSessionAuthority(current));
      expect(actual.userId).toBe(base.context.userId); expect(actual.tenantId).toBe(base.context.tenantId);
      return z.object({ tools: z.array(z.string()), clientId: z.number().int().nonnegative() }).strict().parse(await child.request({ operation: "connect", token, flags }));
    },
    async call(clientId: number, name: string, input: Record<string, unknown>) { const value = await child.request({ operation: "call", clientId, name, input });
      return z.object({ packet: AgentMcpPacketSchema, isError: z.boolean() }).strict().parse(value); },
    async execute(runId: string, holdFirstModel = false) { return child.request({ operation: "execute", runId, holdFirstModel }); },
    async release() { return child.request({ operation: "release" }); },
    async progress() { return Progress.parse(await child.request({ operation: "progress" })); },
    async wait() { return Progress.parse(await child.request({ operation: "wait" })); },
    async business() { return z.record(z.string(), z.object({ count: z.number(), hash: z.string() }).strict()).parse(await child.request({ operation: "business" })); },
    async state(requestId: string) { return child.request({ operation: "state", requestId }); },
    async close() { if (closed) return; closed = true; const errors: unknown[] = [];
      try { await child.close(); } catch (error) { errors.push(error); } try { await base.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "MCP browser fixture cleanup failed");
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json()); }
async function readRun(page: Page, id: string) {
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-native/runs/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
  const run = AgentNativeViewSchema.parse(await response.json()); expect(run.id).toBe(id); expect(run.contextAuthority).toBe(authority); return run;
}
async function freshWorkspace(page: Page) {
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-native/workspace", { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); const workspace = AgentNativeWorkspaceSchema.parse(await response.json()); expect(workspace.contextAuthority).toBe(authority); return workspace;
}
function observe(page: Page) {
  const posts: string[] = [], pageErrors: string[] = [], consoleErrors: Array<{ path: string; status: number | null; hash: string; at: number }> = [];
  const responses: Array<{ path: string; status: number; code: string | null; authorityHash: string | null; at: number }> = [], pending: Promise<void>[] = []; let transition = false;
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  page.on("response", response => { if (response.status() < 400) return;
    const request = response.request(), row = { path: new URL(response.url()).pathname, status: response.status(), code: null as string | null,
      authorityHash: request.headers()["x-yummyai-context-authority"] ? sha(request.headers()["x-yummyai-context-authority"]!) : null, at: Date.now() }; responses.push(row);
    pending.push(response.json().then((raw: unknown) => { if (raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string") row.code = raw.code; }).catch(() => {}));
  });
  page.on("console", value => { if (value.type() !== "error") return; let path = ""; try { path = new URL(value.location().url).pathname; } catch { /* No missing location exemption. */ }
    const match = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(value.text()); consoleErrors.push({ path, status: match ? Number(match[1]) : null, hash: sha(value.text()), at: Date.now() }); });
  return { posts, pageErrors, consoleErrors, responses, authorityTransition() { transition = true; }, async check() {
    await Promise.all(pending); expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter(error => !(transition && error.status === 409 && responses.some(row => row.path === error.path && row.status === 409 && row.code === "authority_changed" && row.authorityHash !== null && Math.abs(row.at - error.at) < 2000)))).toEqual([]);
    expect(posts.filter(path => /^\/api\/(agent-native|agent-plans|agent-loops|ai-assists)\/runs$/.test(path))).toEqual([]);
  } };
}
async function leaf(page: Page, info: TestInfo, action: (f: Fixture, seen: ReturnType<typeof observe>, proof: Record<string, unknown>) => Promise<void>) {
  let f: Fixture | undefined, failure: unknown; const cleanup: unknown[] = [], seen = observe(page);
  const proof: Record<string, unknown> = { operation: "c83e4a72", title: info.title, officialSdk: "2.3.1_stdio", externalModelTransport: "synthetic_http_only",
    actualOwners: true, automaticBusinessExecution: false, tokenLogoutRevocation: "short_JWT_expiry_and_current_membership_only" };
  try { f = await fixture(info.title.includes("five") ? "five" : "restore", page); await loginErp(page, "operator", "/ai-tasks"); await expect(nativeRegion(page)).toBeVisible(); await action(f, seen, proof); }
  catch (error) { failure = error; }
  finally {
    try { await f?.release(); } catch (error) { cleanup.push(error); }
    try { await f?.close(); } catch (error) { cleanup.push(error); }
    try { await seen.check(); } catch (error) { cleanup.push(error); }
    Object.assign(proof, { childClose: f?.childClose ?? null, cleanupFailureCount: cleanup.length, pageErrors: seen.pageErrors, consoleErrors: seen.consoleErrors, responses: seen.responses, posts: seen.posts });
    const path = info.outputPath("agent-mcp-proof.json"); await writeFile(path, JSON.stringify(proof)); await info.attach("agent-mcp-proof", { path, contentType: "application/json" });
  }
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "MCP personal browser acceptance failed");
}
const flags = ["--allow-model-run", "--max-cost-usd=1", "--allow-prepare", "--allow-command=procurement/requisition_create", "--allow-command=finance/bill_record"];
async function input(page: Page, f: Fixture, source: z.infer<typeof Seed>, all = true) {
  const workspace = await freshWorkspace(page);
  return CreateAgentNativeSchema.parse({ version: AGENT_NATIVE_VERSION, requestId: crypto.randomUUID(), modelId: f.model.modelId,
    goal: "Synthetic MCP native evidence and separately reviewed original operations", contextText: source.contextText,
    bindings: all ? [{ tool: "orders.exceptions.page", scope: {} }, { tool: "inventory.balances.page", scope: { stockItemId: source.stockItemId } },
      { tool: "knowledge.search", scope: { topic: "operations", platform: "all", market: "ALL", spuIds: [] } }, { tool: "creative.history", scope: { scope: "inspection", ownerId: source.inspectionId } },
      { tool: "factory.capacity", scope: { factoryId: source.factoryId, query: { from: source.from, days: 2 } } }] : [{ tool: "inventory.balances.page", scope: { stockItemId: source.stockItemId } }],
    allowedCommands: all ? [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }] : [{ domain: "finance", kind: "bill_record" }],
    limits: { ...defaultAgentNativeLimits(), maxModelTurns: 16 }, maxCostUsd: 1, executionContract: workspace.executionContract });
}
async function runView(f: Fixture, clientId: number, id: string) {
  const response = await f.call(clientId, names.savedResult, { kind: "run", id }); expect(response.isError).toBe(false); return AgentNativeViewSchema.parse(response.packet.data);
}
async function openRun(page: Page, run: Pick<AgentNativeView, "id">) {
  const operation = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
  if (await operation.count()) { await operation.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(operation).toHaveCount(0); }
  await page.goto("/ai-tasks?agentNative=" + run.id); await expect(nativeEvidence(page)).toContainText(run.id);
}

test("connects five official MCP entrances to genuine personal sources and requires separate human confirmation for each original business write", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), defaults = await f.connect(); expect(defaults.tools.sort()).toEqual(Object.values(names).sort());
    const description = page.getByRole("region", { name: "MCP 本机接入", exact: true });
    await expect(description.locator("details")).not.toHaveAttribute("open", ""); await description.locator("summary").click();
    await expect(description).toContainText("当前客户端连接状态未知");
    await expect(description.getByRole("region", { name: "MCP 五个协议入口", exact: true }).locator("dt > code")).toHaveText(Object.values(names));
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]); await description.getByRole("button", { name: "复制启动命令", exact: true }).click();
    await expect(description.getByRole("status")).toHaveText("已复制启动命令 连接仍需实际验证"); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("pnpm --filter @yummyai/agent-mcp start");
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 }); await description.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath("mcp-local-instructions-" + width + ".png"), animations: "disabled" }); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const catalog = await f.call(defaults.clientId, names.search, {}); expect(catalog.isError).toBe(false); expect(catalog.packet.contextAuthority).toBe(erpSessionAuthority(await session(page)));
    expect(catalog.packet.data.registrySize).toBe(49); const body = await input(page, f, source), before = await f.business();
    const blocked = await f.call(defaults.clientId, names.execute, { operation: "start", requestJson: JSON.stringify(body) }); expect(blocked.packet.data.code).toBe("mcp_policy_denied");
    const sdk = await f.connect(flags), created = await f.call(sdk.clientId, names.execute, { operation: "start", requestJson: JSON.stringify(body) }); expect(created.isError).toBe(false);
    const born = AgentNativeViewSchema.parse(created.packet.data); await f.execute(born.id); await f.wait(); const run = await runView(f, sdk.clientId, born.id);
    expect(run.status).toBe("completed"); expect(run.observations).toHaveLength(5); expect(run.cost).toMatchObject({ modelTurns: 13, knownCostUsd: "0.002730", coverage: "known" });
    expect(await f.business()).toEqual(before); await openRun(page, run);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await nativeEvidence(page).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath("mcp-native-" + width + ".png"), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); const effects: unknown[] = [];
    for (const [position, item] of run.items.entries()) {
      const beforePrepare = await f.business(), prepared = await f.call(sdk.clientId, names.execute, { operation: "prepare", id: run.id, itemId: item.id,
        requestJson: JSON.stringify({ version: AGENT_NATIVE_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum }) });
      expect(prepared.isError).toBe(false); const receipt = AgentNativeItemReceiptSchema.parse(prepared.packet.data); expect(receipt.disposition).toBe("known"); expect(await f.business()).toEqual(beforePrepare);
      const safe = await f.call(sdk.clientId, names.savedResult, { kind: "command", id: receipt.agentCommandId!, originalChecksum: item.originalChecksum });
      expect(safe.isError).toBe(false); expect(Object.hasOwn(safe.packet.data, "confirmationToken")).toBe(false); expect(Object.hasOwn(safe.packet.data, "snapshot")).toBe(false);
      await page.goto("/ai-tasks?agentCommand=" + receipt.agentCommandId); const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }); await expect(review).toBeVisible();
      await review.getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
      const done = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent-commands/requests/${receipt.agentCommandId}/confirm`);
      await review.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click(); const result = await done; expect(result.status()).toBe(200);
      const actual = AgentCommandViewSchema.parse(await result.json()); expect(actual).toMatchObject({ state: "succeeded", ownerCommandId: receipt.ownerCommandId, canConfirm: false });
      const after = await f.business(); if (position === 0) expect(after.inventory_procurement_requisitions!.count).toBe(beforePrepare.inventory_procurement_requisitions!.count + 1);
      else { expect(after.finance_payable_bills!.count).toBe(beforePrepare.finance_payable_bills!.count + 1); expect(after.finance_original_write_proofs!.count).toBe(beforePrepare.finance_original_write_proofs!.count + 1); }
      effects.push({ itemId: item.id, commandId: receipt.agentCommandId, ownerCommandId: receipt.ownerCommandId, state: actual.state });
    }
    const stable = await f.state(run.requestId), usage = await f.call(sdk.clientId, names.usage, { id: run.id }); expect(usage.packet.data.scope).toBe("run"); expect(usage.packet.data.cost).toEqual(run.cost);
    expect(await f.state(run.requestId)).toEqual(stable); expect((await f.progress()).modelCalls).toBe(13); expect(seen.posts.filter(path => path.endsWith("/confirm"))).toHaveLength(2);
    Object.assign(proof, { runId: run.id, requestId: run.requestId, sourceTools: run.observations.map(value => value.tool), cost: run.cost, effects,
      originalQueue: await f.progress(), noMcpBusinessExecution: true, metadataPageDoesNotClaimConnection: true });
  });
});

test("restores an original MCP task with a new SDK client after refresh and hides a late private result after real personal authority narrows", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), sdk = await f.connect(flags), body = await input(page, f, source, false), response = await f.call(sdk.clientId, names.execute, { operation: "start", requestJson: JSON.stringify(body) });
    expect(response.isError).toBe(false); const born = AgentNativeViewSchema.parse(response.packet.data); await f.execute(born.id); await f.wait(); const completed = await runView(f, sdk.clientId, born.id);
    expect(completed.status).toBe("completed"); const item = completed.items[0]!, prepare = await f.call(sdk.clientId, names.execute, { operation: "prepare", id: born.id, itemId: item.id,
      requestJson: JSON.stringify({ version: AGENT_NATIVE_VERSION, requestId: born.requestId, proposalChecksum: item.proposalChecksum }) });
    const prepareDiagnostic = { isError: prepare.isError, kind: prepare.packet.kind,
      code: typeof prepare.packet.data.code === "string" && /^mcp_[a-z_]+$/.test(prepare.packet.data.code) ? prepare.packet.data.code : null,
      status: typeof prepare.packet.data.status === "number" ? prepare.packet.data.status : null };
    Object.assign(proof, { runId: born.id, requestId: born.requestId, itemId: item.id, prepareDiagnostic });
    expect(prepare.isError, "Original MCP preparation: " + JSON.stringify(prepareDiagnostic)).toBe(false);
    const known = AgentNativeItemReceiptSchema.parse(prepare.packet.data); expect(known.disposition).toBe("known"); const state = await f.state(born.requestId), business = await f.business(), models = (await f.progress()).modelCalls;
    await openRun(page, completed); await page.reload(); await expect(nativeEvidence(page)).toContainText(born.id);
    const replacement = await f.connect(flags), receipt = await f.call(replacement.clientId, names.savedResult, { kind: "request_receipt", requestId: born.requestId, requestChecksum: born.requestChecksum });
    expect(AgentNativeReceiptSchema.parse(receipt.packet.data).runId).toBe(born.id);
    const child = await f.call(replacement.clientId, names.savedResult, { kind: "item_receipt", id: born.id, itemId: item.id, requestId: born.requestId, proposalChecksum: item.proposalChecksum });
    expect(AgentNativeItemReceiptSchema.parse(child.packet.data)).toMatchObject({ disposition: "known", agentCommandId: known.agentCommandId, ownerCommandId: known.ownerCommandId });
    expect(await f.state(born.requestId)).toEqual(state); expect(await f.business()).toEqual(business); expect((await f.progress()).modelCalls).toBe(models);
    const entered = latch(), release = latch(); let held = false, returned = false, routeFailure: string | null = null;
    await page.route("**/api/agent-native/runs/" + born.id, async route => {
      if (held) { await route.continue(); return; } held = true;
      const actual = await route.fetch(); expect(actual.status()).toBe(200); expect(AgentNativeViewSchema.parse(await actual.json()).privateAvailable).toBe(true);
      entered.resolve(); await release.promise; try { await route.fulfill({ response: actual }); returned = true; }
      catch (error) { routeFailure = error instanceof Error && /closed|cancel|abort|intercept/i.test(error.message) ? "old_document_cancelled" : "unexpected_route_failure"; }
    });
    await nativeRegion(page).getByRole("button", { name: "只重新读取原任务", exact: true }).click(); await bounded(entered.promise, "Real native private BFF response did not reach late gate");
    try {
      await f.inventorySelf(); seen.authorityTransition();
      const navigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame() && new URL(frame.url()).pathname === "/ai-tasks");
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation; await page.waitForLoadState("domcontentloaded"); await expect(nativeRegion(page)).toBeVisible();
      const workspace = await freshWorkspace(page); expect(workspace.toolWorkspace.tools.find(value => value.key === "inventory.balances.page")?.available).toBe(false);
      release.resolve(); await expect.poll(() => returned || routeFailure !== null).toBe(true); expect(routeFailure).not.toBe("unexpected_route_failure");
      const hidden = await readRun(page, born.id); expect(hidden).toMatchObject({ privateAvailable: false, goal: null, contextText: null, result: null, steps: [], definitions: [], observations: [] });
      const mcpHidden = await runView(f, replacement.clientId, born.id); expect(mcpHidden.privateAvailable).toBe(false); expect(mcpHidden.items[0]).toMatchObject({ id: item.id, agentCommandId: known.agentCommandId, ownerCommandId: known.ownerCommandId });
      for (const text of [completed.goal!, completed.contextText!, completed.result!.summary, completed.result!.proposals[0]!.draft.label, completed.result!.proposals[0]!.draft.reason])
        await expect(nativeRegion(page)).not.toContainText(text);
      for (const name of ["原任务固定读取范围", "原生工具任务步骤", "原生工具任务来源", "原生工具模型结论", "原生标量来源引用"])
        await expect(nativeRegion(page).getByRole("region", { name, exact: true, includeHidden: true })).toHaveCount(0);
      await expect(nativeRegion(page).locator("details.ap-draft")).toHaveCount(0); await expect(nativeRegion(page).getByRole("button", { name: "保存这项原准备并核对", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "确认执行这笔原操作", exact: true })).toHaveCount(0);
      expect(await f.state(born.requestId)).toEqual(state); expect(await f.business()).toEqual(business); expect((await f.progress()).modelCalls).toBe(models);
      Object.assign(proof, { runId: born.id, requestId: born.requestId, itemId: item.id, commandId: known.agentCommandId, ownerCommandId: known.ownerCommandId,
        refreshRecoveryOnlyReads: true, late: { returned, routeFailure, bodyCleared: true }, currentAuthorityHash: sha(workspace.contextAuthority), originalWorker: await f.progress() });
    } finally { release.resolve(); }
  });
});
