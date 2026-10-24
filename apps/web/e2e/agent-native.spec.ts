import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts";
import { AgentCommandOriginalSchema, AgentCommandViewSchema } from "@yummyai/contracts/ai/agent-command";
import { AgentNativeIntentSchema, AgentNativePreparationIntentSchema, AgentNativeWorkspaceSchema, AgentNativeViewSchema, AgentNativeItemReceiptSchema,
  type AgentNativeView } from "@yummyai/contracts/ai/agent-native";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { sql } from "drizzle-orm";
import { withTenant } from "@yummyai/database";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import { loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const region = (page: Page) => page.getByRole("region", { name: "原生工具模型任务", exact: true });
const evidence = (page: Page) => page.getByRole("region", { name: "原生工具任务实际依据", exact: true });
const Seed = z.object({ stockItemId: z.uuidv7(), supplierId: z.uuidv7(), inspectionId: z.uuidv7(), factoryId: z.uuidv7(), from: z.iso.date(), query: z.string(), originals: z.array(AgentCommandOriginalSchema).length(2), contextText: z.string() }).strict();
const Stats = z.object({ modelCalls: z.int().nonnegative(), readCalls: z.int().nonnegative(), definitionCalls: z.int().nonnegative(), modelGateEntered: z.boolean(),
  settled: z.boolean(), failure: z.string().nullable(), originalQueueJobId: z.string().nullable() }).strict();
test.describe.configure({ mode: "serial" }); test.setTimeout(240_000);
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
class NativeChild {
  private readonly child: ChildProcess; private readonly ready: Promise<void>; private readonly ended: Promise<void>; private sequence = 0;
  private readonly pending = new Map<number, { accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly closeEvidence = { acknowledged: false, exited: false, exitCode: null as number | null, signal: null as NodeJS.Signals | null, forcedKill: false };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/ai/agent-native.test-fixture.ts"), "--agent-native-browser-child"], { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
    let accept!: () => void, reject!: (error: Error) => void;
    this.ready = new Promise((yes, no) => { accept = yes; reject = no; });
    const timer = setTimeout(() => reject(new Error("native_child_ready_timeout")), 30_000);
    this.ended = new Promise(done => this.child.once("exit", (exitCode, signal) => {
      clearTimeout(timer); Object.assign(this.closeEvidence, { exited: true, exitCode, signal }); reject(new Error("native_child_exited_before_ready"));
      for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error("native_child_exited_with_pending_request")); } this.pending.clear(); done();
    }));
    this.child.once("error", () => { clearTimeout(timer); reject(new Error("native_child_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
      if (value.nonce !== nonce) return;
      if (value.type === "ready") { clearTimeout(timer); accept(); return; }
      if (typeof value.id !== "number" || value.type !== "result" && value.type !== "failure") return;
      const row = this.pending.get(value.id); if (!row) return; this.pending.delete(value.id); clearTimeout(row.timer);
      if (value.type === "result") row.accept(value.value);
      else row.reject(new Error("native_child_failed_" + (typeof value.phase === "string" && /^[a-z_]{1,60}$/.test(value.phase) ? value.phase : "unknown") +
        (typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code) ? "_" + value.code : "")));
    });
  }
  async request(input: Record<string, unknown>): Promise<unknown> {
    await this.ready; if (!this.child.connected || this.closeEvidence.exited) throw new Error("native_child_unavailable"); const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("native_child_request_timeout")); }, input.operation === "close" ? 20_000 : 120_000);
      this.pending.set(id, { accept, reject, timer }); this.child.send({ ...input, nonce: this.nonce, id }, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("native_child_delivery_failed")); }
      });
    });
  }
  async close() {
    const errors: unknown[] = [];
    try { if (!this.closeEvidence.exited) { const result = z.object({ closed: z.literal(true) }).strict().parse(await this.request({ operation: "close" })); this.closeEvidence.acknowledged = result.closed; } }
    catch (error) { errors.push(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch (error) { errors.push(error); }
    try { await bounded(this.ended, "native_child_exit_timeout", 20_000); }
    catch (error) { errors.push(error); this.closeEvidence.forcedKill = true; this.child.kill("SIGKILL"); try { await bounded(this.ended, "native_child_kill_exit_timeout", 2_000); } catch (failure) { errors.push(failure); } }
    if (!this.closeEvidence.acknowledged || this.closeEvidence.exitCode !== 0 || this.closeEvidence.signal !== null || !this.closeEvidence.exited) errors.push(new Error("native_child_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "native_child_cleanup_failed");
  }
}
async function fixture(leaf: string) {
  requireAgentReadBrowser();
  const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  if (process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || api.port !== "8130" || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname))
    throw new Error("Native browser requires the actual compiled personal8130 boundary");
  for (const flag of ["E2E_AGENT_NATIVE_ISOLATED", "E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED",
    "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED"]) if (process.env[flag] !== "1") throw new Error("Native browser isolation flag missing");
  const base = await agentReadBrowserFixture("native-" + leaf); let child: NativeChild;
  try { child = new NativeChild(base.nonce); }
  catch (error) { const failures = [error]; try { await base.close(); } catch (failure) { failures.push(failure); } throw new AggregateError(failures, "native_browser_initialization_failed"); }
  let closed = false;
  return { ...base, childClose: child.closeEvidence,
    async seed() { return Seed.parse(await child.request({ operation: "seed", context: TenantContextSchema.parse(base.context) })); },
    async execute(runId: string, holdFirstModel = false) { return child.request({ operation: "execute", runId, holdFirstModel }); },
    async progress() { return Stats.parse(await child.request({ operation: "progress" })); },
    async wait() { return Stats.parse(await child.request({ operation: "wait" })); },
    async release() { return child.request({ operation: "release" }); },
    async business() { return z.record(z.string(), z.object({ count: z.number(), hash: z.string() }).strict()).parse(await child.request({ operation: "business" })); },
    async nativeState(requestId: string) {
      return withTenant(base.database.db, base.context, async tx => ({
        runs: Array.from(await tx.execute(sql`select id,request_id,status,revision,model_turns,known_cost_usd::text,unknown_cost,input_checksum,result_checksum from agent_plan_runs where owner_id=${base.context.userId}::uuid and request_id=${requestId}::uuid order by id`)),
        steps: Array.from(await tx.execute(sql`select s.id,s.sequence,s.kind,s.phase,s.submission_state,s.input_checksum,s.output_checksum,s.response_checksum,s.cost_usd::text from agent_plan_steps s join agent_plan_runs r on r.id=s.run_id and r.tenant_id=s.tenant_id where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by s.sequence`)),
        items: Array.from(await tx.execute(sql`select i.id,i.proposal_checksum,i.agent_command_id,c.owner_command_id from agent_plan_items i join agent_plan_runs r on r.id=i.run_id and r.tenant_id=i.tenant_id left join agent_command_requests c on c.id=i.agent_command_id and c.tenant_id=i.tenant_id where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by i.position`)),
        budgets: Array.from(await tx.execute(sql`select b.id,b.state,b.amount_usd::text from ai_budget_ledger b join agent_plan_runs r on r.id=b.request_id and r.tenant_id=b.tenant_id where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by b.id`)),
      }));
    },
    async close() { if (closed) return; closed = true; const errors: unknown[] = [];
      try { await child.close(); } catch (error) { errors.push(error); }
      try { await base.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "native_browser_fixture_cleanup_failed");
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json()); }
async function readRun(page: Page, id: string) {
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-native/runs/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
  const value = AgentNativeViewSchema.parse(await response.json()); expect(value.id).toBe(id); expect(value.contextAuthority).toBe(authority); return value;
}
async function markers(page: Page) { return (await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("yummyai.agent-native.intent.v1:")).map(key => sessionStorage.getItem(key))))
  .map(value => AgentNativeIntentSchema.parse(JSON.parse(value!))); }
async function preparationMarkers(page: Page) { return (await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("yummyai.agent-native-preparation.intent.v1:")).map(key => sessionStorage.getItem(key))))
  .map(value => AgentNativePreparationIntentSchema.parse(JSON.parse(value!))); }
async function fill(page: Page, f: Fixture, source: z.infer<typeof Seed>, allFive: boolean) {
  await loginErp(page, "operator", "/ai-tasks"); const authority = erpSessionAuthority(await session(page));
  const response = await page.request.get("/api/agent-native/workspace", { headers: { "x-yummyai-context-authority": authority } }); expect(response.status()).toBe(200);
  const workspace = AgentNativeWorkspaceSchema.parse(await response.json()), form = region(page).getByRole("form", { name: "启动原生工具模型任务", exact: true });
  await expect(form.getByRole("combobox", { name: "本次原生任务模型", exact: true }).locator('option[value="' + f.model.modelId + '"]')).toHaveCount(1);
  await form.getByRole("textbox", { name: "本次任务目标", exact: true }).fill("Synthetic native source reads and separately confirmed original business drafts");
  await form.getByRole("textbox", { name: "用户补充资料 未经事实核验", exact: true }).fill(source.contextText);
  await form.getByRole("combobox", { name: "本次原生任务模型", exact: true }).selectOption(f.model.modelId);
  await form.getByRole("textbox", { name: "美元费用上限", exact: true }).fill("1.000000");
  await form.getByRole("spinbutton", { name: "本次模型轮数上限", exact: true }).fill("16");
  const keys = allFive ? workspace.toolWorkspace.tools.map(tool => tool.key) : ["inventory.balances.page", "knowledge.search"];
  for (const key of keys) { const tool = workspace.toolWorkspace.tools.find(tool => tool.key === key)!; expect(tool.available).toBe(true); await form.getByRole("checkbox", { name: tool.label, exact: true }).check(); }
  if (allFive) {
    await form.getByRole("combobox", { name: "创意执行范围", exact: true }).selectOption("inspection");
    const creative = form.getByRole("combobox", { name: "选择已有创意对象", exact: true }); await expect(creative.locator('option[value="' + source.inspectionId + '"]')).toHaveCount(1); await creative.selectOption(source.inspectionId);
    const factory = form.getByRole("combobox", { name: "选择真实工厂", exact: true }); await expect(factory.locator('option[value="' + source.factoryId + '"]')).toHaveCount(1); await factory.selectOption(source.factoryId);
    await form.getByLabel("工厂当地起始日期", { exact: true }).fill(source.from); await form.getByRole("spinbutton", { name: "产能读取天数", exact: true }).fill("2");
  }
  await form.locator("details.ap-command-picker > summary").click();
  for (const original of source.originals.filter(value => allFive || value.domain === "finance")) {
    const capability = workspace.toolWorkspace.commands.find(value => value.domain === original.domain && value.kind === original.command.kind)!;
    expect(capability.available).toBe(true); await form.getByRole("checkbox", { name: capability.label, exact: true }).check();
  }
  return form;
}
async function openRun(page: Page, run: Pick<AgentNativeView, "id" | "requestId">) {
  const operation = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
  if (await operation.count()) { await operation.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(operation).toHaveCount(0); }
  if (await evidence(page).count()) { await expect(evidence(page)).toContainText(run.id); return; }
  await region(page).getByRole("article", { name: "原生工具原请求 " + run.requestId, exact: true }).getByRole("button", { name: "读取原任务详情", exact: true }).click();
  await expect(evidence(page)).toContainText(run.id);
}
async function refresh(page: Page, id: string) {
  await expect(page).toHaveURL(url => url.pathname === "/ai-tasks" && url.searchParams.get("agentNative") === id);
  const button = region(page).getByRole("button", { name: "只重新读取原任务", exact: true });
  await expect(button).toBeEnabled(); await button.click();
  await expect(evidence(page)).toContainText(id); await expect(evidence(page)).toContainText("原生工具模型阶段已完成");
  await expect(button).toBeEnabled();
  // Selected-run adoption and polling can cancel an older document request.
  // Read the same personal BFF after the actual UI refresh, without CDP bodies.
  return readRun(page, id);
}
function observe(page: Page) {
  const posts: Array<{ path: string; at: number }> = [], failures: Array<{ path: string; reason: string; at: number }> = [], responses: Array<{ path: string; status: number; code: string | null; authorityHash: string | null; at: number }> = [];
  const consoleErrors: Array<{ path: string; status: number | null; network: boolean; hash: string; at: number }> = [], pageErrors: string[] = [], pending: Promise<void>[] = [], lost = new Set<string>(); let transition = false;
  page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() === "POST" && /^\/api\/(agent-native|agent-commands|agent-plans|agent-loops|ai-assists)/.test(path)) posts.push({ path, at: Date.now() }); });
  page.on("requestfailed", request => failures.push({ path: new URL(request.url()).pathname, reason: request.failure()?.errorText ?? "unknown", at: Date.now() }));
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  page.on("response", response => { if (response.status() < 400) return; const request = response.request(), path = new URL(response.url()).pathname;
    const row = { path, status: response.status(), code: null as string | null, authorityHash: request.headers()["x-yummyai-context-authority"] ? sha(request.headers()["x-yummyai-context-authority"]!) : null, at: Date.now() }; responses.push(row);
    pending.push(response.json().then((raw: unknown) => { if (raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string") row.code = raw.code; }).catch(() => {})); });
  page.on("console", value => { if (value.type() !== "error") return; let path = ""; try { path = new URL(value.location().url).pathname; } catch { /* A missing location is never blanket-exempted. */ }
    const match = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(value.text());
    consoleErrors.push({ path, status: match ? Number(match[1]) : null, network: /^Failed to load resource: net::ERR_(FAILED|CONNECTION_RESET)/.test(value.text()), hash: sha(value.text()), at: Date.now() }); });
  return { posts, failures, responses, consoleErrors, pageErrors, lost, authorityTransition() { transition = true; },
    async check() { await Promise.all(pending); expect(pageErrors).toEqual([]);
      expect(consoleErrors.filter(error => !(error.network && lost.has(error.path) && failures.some(row => row.path === error.path && /^net::ERR_(FAILED|CONNECTION_RESET)$/.test(row.reason) && Math.abs(row.at - error.at) < 2000)) &&
        !(transition && error.status === 409 && responses.some(row => row.path === error.path && row.status === 409 && row.code === "authority_changed" && row.authorityHash !== null && Math.abs(row.at - error.at) < 2000)))).toEqual([]);
      expect(posts.filter(row => /^\/api\/(agent-plans|agent-loops|ai-assists)\/runs$/.test(row.path))).toEqual([]);
    } };
}
async function leaf(page: Page, info: TestInfo, action: (f: Fixture, seen: ReturnType<typeof observe>, proof: Record<string, unknown>) => Promise<void>) {
  let f: Fixture | undefined, failure: unknown; const cleanup: unknown[] = [], proof: Record<string, unknown> = { operation: "a72d5e31", title: info.title,
    externalModelTransport: "synthetic_http_only", actualOwners: true, semanticBusinessCorrectness: "requires_each_original_operator_review", automaticBusinessExecution: false, mcpConnected: false };
  const seen = observe(page);
  try { f = await fixture(info.testId.replace(/[^a-z0-9]/gi, "").slice(-24)); proof.nonce = f.nonce; await action(f, seen, proof); await seen.check(); }
  catch (error) { failure = error; }
  try { await f?.close(); } catch (error) { cleanup.push(error); }
  const path = info.outputPath("agent-native-proof.json");
  await writeFile(path, JSON.stringify({ ...proof, posts: seen.posts, failedRequests: seen.failures, responses: seen.responses, consoleErrors: seen.consoleErrors,
    pageErrors: seen.pageErrors, childClose: f?.childClose ?? null, completed: failure === undefined, cleanupFailureCount: cleanup.length }, null, 2));
  await info.attach("agent-native-proof", { path, contentType: "application/json" });
  if (failure !== undefined || cleanup.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanup], "Native Agent actual personal workflow or cleanup failed");
}

test("personal native model loads five actual owners on demand and proposes two separately confirmed original operations without automatic business adoption", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), before = await f.business(), form = await fill(page, f, source, true);
    const returned = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent-native/runs");
    await form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true }).click(); const response = await returned; expect(response.status()).toBe(201);
    const created = AgentNativeViewSchema.parse(await response.json()); proof.runId = created.id; proof.requestId = created.requestId;
    await f.execute(created.id); const worker = await f.wait(); expect(worker).toMatchObject({ modelCalls: 13, readCalls: 10, definitionCalls: 14, settled: true, failure: null }); proof.worker = worker;
    const run = await refresh(page, created.id); expect(run).toMatchObject({ status: "completed", cost: { knownCostUsd: "0.002730", reservedUsd: "0.000000" } });
    expect(run.observations).toHaveLength(5); expect(run.items).toHaveLength(2); expect(run.items.every(item => item.preparationState === "not_requested")).toBe(true);
    expect(JSON.stringify(run.observations).includes("SYNTHETIC_PRIVATE_CODE")).toBe(false); expect(await f.business()).toEqual(before);
    await expect(evidence(page)).toContainText("原生工具模型阶段已完成"); await expect(evidence(page)).toContainText("不自动准备或执行业务");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 900 : 1000 }); await region(page).getByRole("heading", { name: "原生工具模型任务", exact: true }).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath("native-panel-" + width + ".png"), animations: "disabled" });
      await evidence(page).getByRole("combobox", { name: "查看原读取步骤", exact: true }).selectOption("2"); await evidence(page).getByRole("region", { name: "原生工具任务来源", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("native-source-" + width + ".png"), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); const effects = [];
    for (const [position, item] of run.items.entries()) {
      await openRun(page, run); const proposal = evidence(page).getByRole("listitem", { name: "原生工具提案 " + (position + 1), exact: true }), prior = await f.business();
      const saved = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent-native/runs/${run.id}/items/${item.id}/prepare`);
      await expect(proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true })).toBeEnabled(); await proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true }).click();
      const preparedResponse = await saved; expect(preparedResponse.status()).toBe(201); const prepared = AgentNativeItemReceiptSchema.parse(await preparedResponse.json()); expect(prepared.disposition).toBe("known");
      expect(await f.business()).toEqual(prior); const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }); await expect(review).toBeVisible();
      await review.getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check(); const done = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent-commands/requests/${prepared.agentCommandId}/confirm`);
      await review.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click(); const confirmed = await done; expect(confirmed.status()).toBe(200); const actual = AgentCommandViewSchema.parse(await confirmed.json());
      expect(actual).toMatchObject({ state: "succeeded", ownerCommandId: prepared.ownerCommandId, canConfirm: false });
      const after = await f.business();
      if (position === 0) expect(after.inventory_procurement_requisitions!.count).toBe(prior.inventory_procurement_requisitions!.count + 1);
      else { expect(after.finance_payable_bills!.count).toBe(prior.finance_payable_bills!.count + 1); expect(after.finance_original_write_proofs!.count).toBe(prior.finance_original_write_proofs!.count + 1); }
      effects.push({ itemId: item.id, commandId: prepared.agentCommandId, ownerCommandId: prepared.ownerCommandId, state: actual.state });
    }
    proof.effects = effects; proof.onlyExplicitBusinessWrites = true; proof.finalWorker = await f.progress(); expect((await f.progress()).modelCalls).toBe(13);
    expect(seen.posts.filter(row => row.path.endsWith("/prepare"))).toHaveLength(2); expect(seen.posts.filter(row => row.path.endsWith("/confirm"))).toHaveLength(2);
  });
});

test("recovers lost committed parent and original preparation responses only by original receipts and discards a late private source after actual current scope loss", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), form = await fill(page, f, source, false), born = latch(); let original: AgentNativeView | undefined;
    const parentPath = "/api/agent-native/runs"; seen.lost.add(parentPath);
    await page.route("**/api/agent-native/runs", async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(201); original = AgentNativeViewSchema.parse(await response.json()); born.resolve(); await route.abort("connectionreset");
    }, { times: 1 });
    await form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true }).click(); await bounded(born.promise, "Actual native parent201 was not committed"); if (!original) throw new Error("Actual committed native run missing");
    const run = original; proof.runId = run.id; proof.requestId = run.requestId;
    await expect.poll(() => markers(page)).toMatchObject([{ requestId: run.requestId, requestChecksum: run.requestChecksum, runId: null, state: "unknown" }]);
    const baseline = await f.nativeState(run.requestId); await page.reload();
    const marker = region(page).getByRole("article", { name: "原生工具原请求 " + run.requestId, exact: true }); await marker.getByRole("button", { name: "只读取原请求回执", exact: true }).click();
    await expect.poll(() => markers(page)).toMatchObject([{ requestId: run.requestId, runId: run.id, state: "known" }]);
    expect(await f.nativeState(run.requestId)).toEqual(baseline); expect((await f.progress()).modelCalls).toBe(0); expect(seen.posts.filter(row => row.path === parentPath)).toHaveLength(1);
    await marker.getByRole("button", { name: "读取原任务详情", exact: true }).click(); await expect(evidence(page)).toContainText(run.id);
    await f.execute(run.id); await f.wait(); const completed = await refresh(page, run.id); expect(completed).toMatchObject({ status: "completed", items: [{ preparationState: "not_requested" }] });
    const item = completed.items[0]!, preparedPath = `/api/agent-native/runs/${run.id}/items/${item.id}/prepare`, committed = latch(); let prepared: z.infer<typeof AgentNativeItemReceiptSchema> | undefined;
    seen.lost.add(preparedPath); await page.route("**" + preparedPath, async route => { const response = await route.fetch(); expect(response.status()).toBe(201); prepared = AgentNativeItemReceiptSchema.parse(await response.json()); committed.resolve(); await route.abort("connectionreset"); }, { times: 1 });
    const proposal = evidence(page).getByRole("listitem", { name: "原生工具提案 1", exact: true });
    await expect(proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true })).toBeEnabled(); await proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true }).click();
    await bounded(committed.promise, "Actual original preparation201 was not committed"); await expect.poll(() => preparationMarkers(page)).toMatchObject([{ runId: run.id, itemId: item.id, proposalChecksum: item.proposalChecksum, state: "unknown" }]);
    const known = prepared; if (!known?.ownerCommandId) throw new Error("Committed original preparation missing its actual owner result");
    proof.recoveredItem = { itemId: item.id, commandId: known.agentCommandId, ownerCommandId: known.ownerCommandId, proposalChecksum: known.proposalChecksum };
    const beforeRecovery = await f.nativeState(run.requestId), business = await f.business(); await page.reload(); await openRun(page, run);
    const recovered = evidence(page).getByRole("listitem", { name: "原生工具提案 1", exact: true }); await recovered.getByRole("button", { name: "读取这项原准备回执", exact: true }).click();
    await expect(recovered.getByRole("link", { name: "核对这项原操作", exact: true })).toHaveAttribute("href", "/ai-tasks?agentCommand=" + known.agentCommandId);
    await expect.poll(() => preparationMarkers(page)).toMatchObject([{ runId: run.id, itemId: item.id, state: "known" }]); expect(await f.nativeState(run.requestId)).toEqual(beforeRecovery);
    expect(await f.business()).toEqual(business); expect(seen.posts.filter(row => row.path === preparedPath)).toHaveLength(1); expect(seen.posts.filter(row => row.path.endsWith("/confirm"))).toEqual([]);
    const entered = latch(), release = latch(); let held = false, lateReturned = false, lateFailure: string | null = null;
    await page.route("**/api/agent-native/runs/" + run.id, async route => {
      if (held) { await route.continue(); return; } held = true; const response = await route.fetch(); expect(response.status()).toBe(200);
      const actual = AgentNativeViewSchema.parse(await response.json()); expect(actual.privateAvailable).toBe(true); entered.resolve(); await release.promise;
      try { await route.fulfill({ response }); lateReturned = true; } catch (error) { lateFailure = error instanceof Error && /closed|cancel|abort|intercept/i.test(error.message) ? "old_document_cancelled" : "unexpected_route_failure"; }
    });
    await region(page).getByRole("button", { name: "只重新读取原任务", exact: true }).click(); await bounded(entered.promise, "Actual full native private response did not reach its late gate");
    try {
      await f.inventorySelf(); const fresh = erpSessionAuthority(await session(page)); seen.authorityTransition();
      const navigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame() && new URL(frame.url()).pathname === "/ai-tasks");
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation; await page.waitForLoadState("domcontentloaded");
      await expect(region(page)).toBeVisible(); const reload = region(page).getByRole("button", { name: "重新读取原生模型契约", exact: true }); await expect(reload).toBeEnabled();
      const current = page.waitForResponse(response => response.status() === 200 && new URL(response.url()).pathname === "/api/agent-native/workspace" && response.request().headers()["x-yummyai-context-authority"] === fresh);
      await reload.click(); const workspace = AgentNativeWorkspaceSchema.parse(await (await current).json());
      expect(workspace.contextAuthority).toBe(fresh); expect(workspace.toolWorkspace.tools.find(tool => tool.key === "inventory.balances.page")!.available).toBe(false);
      release.resolve(); await expect.poll(() => lateReturned || lateFailure !== null).toBe(true); expect(lateFailure).not.toBe("unexpected_route_failure");
      const hidden = await readRun(page, run.id); expect(hidden).toMatchObject({ privateAvailable: false, steps: [], definitions: [], observations: [], result: null });
      expect(hidden.items).toMatchObject([{ id: item.id, proposalChecksum: item.proposalChecksum, originalChecksum: item.originalChecksum,
        agentCommandId: known.agentCommandId, ownerCommandId: known.ownerCommandId, preparationState: "known", canPrepare: false }]);
      const originalProposal = completed.result?.proposals.find(value => value.id === item.id);
      if (!completed.goal || !completed.contextText || !completed.result || !originalProposal?.draft.original) throw new Error("Actual completed private evidence and original draft missing");
      for (const privateText of [source.query, completed.goal, completed.contextText, completed.result.summary, originalProposal.draft.label, originalProposal.draft.reason])
        await expect(region(page)).not.toContainText(privateText);
      for (const name of ["原任务固定读取范围", "原生工具任务步骤", "原生工具任务来源", "原生工具模型结论", "原生标量来源引用"])
        await expect(region(page).getByRole("region", { name, exact: true, includeHidden: true })).toHaveCount(0);
      await expect(region(page).getByText("原用户补充资料 未经事实核验", { exact: true })).toHaveCount(0);
      await expect(region(page).locator("details.ap-draft")).toHaveCount(0);
      const retained = evidence(page).getByRole("listitem", { name: "原生工具提案 1", exact: true });
      await expect(retained).toHaveCount(1); await expect(retained.getByRole("heading", { name: "1 · 原提案正文当前不可读", exact: true })).toBeVisible();
      await expect(retained.locator("code")).toHaveText([item.id, item.proposalChecksum]);
      await expect(retained.getByRole("link", { name: "核对这项原操作", exact: true })).toHaveAttribute("href", "/ai-tasks?agentCommand=" + known.agentCommandId);
      await expect(retained.getByRole("button", { name: "读取这项原准备回执", exact: true })).toBeEnabled();
      await expect(region(page).getByRole("button", { name: "保存这项原准备并核对", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "确认执行这笔原操作", exact: true })).toHaveCount(0);
      expect(await f.nativeState(run.requestId)).toEqual(beforeRecovery); expect(await f.business()).toEqual(business);
      proof.currentAuthorityHash = sha(fresh); proof.lateResponse = { returned: lateReturned, failure: lateFailure, privateCleared: true }; proof.worker = await f.progress();
      proof.retainedItemMetadata = { itemId: item.id, proposalChecksum: item.proposalChecksum, agentCommandId: known.agentCommandId, ownerCommandId: known.ownerCommandId,
        privateAreasAbsent: true, originalKnownReceiptLinkPreserved: true };
      expect(seen.posts.filter(row => row.path === parentPath)).toHaveLength(1); expect(seen.posts.filter(row => row.path === preparedPath)).toHaveLength(1);
    } finally { release.resolve(); }
  });
});
