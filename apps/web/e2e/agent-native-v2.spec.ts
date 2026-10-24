import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AgentCommandOriginalSchema, AgentCommandViewSchema } from "@yummyai/contracts/ai/agent-command";
import { agentResourceInputSchemas } from "@yummyai/contracts/ai/agent-resources";
import { AgentNativeV2BindingSchema, AgentNativeV2ViewSchema, AgentNativeV2WorkspaceSchema, AgentNativeV2ItemReceiptSchema, AgentNativeV2IntentSchema,
  AgentNativeV2PreparationIntentSchema, AGENT_NATIVE_V2_INTENT_PREFIX, AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX, type AgentNativeV2View } from "@yummyai/contracts/ai/agent-native-v2";
import { verifyAgentNativeV2Transport } from "@yummyai/contracts/ai/agent-native-v2-transport";
import { withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import { loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const panel = (page: Page) => page.getByRole("region", { name: "十一类原生工具模型任务", exact: true });
const evidence = (page: Page) => page.getByRole("region", { name: "十一类工具任务实际依据", exact: true });
const Seed = z.object({ bindings: z.array(AgentNativeV2BindingSchema), query: z.string(), originals: z.array(AgentCommandOriginalSchema), contextText: z.string(),
  inputs: z.object(agentResourceInputSchemas).strict(), inspectionId: z.uuidv7(), factoryId: z.uuidv7(), from: z.string() }).strict();
const Stats = z.object({ modelCalls: z.int().nonnegative(), definitions: z.int().nonnegative(), reads: z.int().nonnegative(), settled: z.boolean(), entered: z.boolean(), failure: z.string().nullable() }).strict();
type Source = z.infer<typeof Seed>;
test.describe.configure({ mode: "serial" }); test.setTimeout(300_000);
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
class NativeV2Child {
  private readonly child: ChildProcess; private readonly ready: Promise<void>; private readonly ended: Promise<void>; private sequence = 0;
  private readonly pending = new Map<number, { accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly evidence = { acknowledged: false, exited: false, exitCode: null as number | null, signal: null as NodeJS.Signals | null, forcedKill: false };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/ai/agent-native-v2.test-fixture.ts"), "--agent-native-v2-browser-child"], { cwd: root, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
    let accept!: () => void, reject!: (error: Error) => void; this.ready = new Promise((yes, no) => { accept = yes; reject = no; });
    const timer = setTimeout(() => reject(new Error("native_v2_child_ready_timeout")), 30_000);
    this.ended = new Promise(done => this.child.once("exit", (exitCode, signal) => {
      clearTimeout(timer); Object.assign(this.evidence, { exited: true, exitCode, signal }); reject(new Error("native_v2_child_exited_before_ready"));
      for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error("native_v2_child_exited_with_pending_request")); } this.pending.clear(); done();
    }));
    this.child.once("error", () => { clearTimeout(timer); reject(new Error("native_v2_child_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>; if (value.nonce !== nonce) return;
      if (value.type === "ready") { clearTimeout(timer); accept(); return; }
      if (typeof value.id !== "number" || value.type !== "result" && value.type !== "failure") return;
      const row = this.pending.get(value.id); if (!row) return; this.pending.delete(value.id); clearTimeout(row.timer);
      if (value.type === "result") row.accept(value.value);
      else row.reject(new Error("native_v2_child_failed_" + (typeof value.phase === "string" && /^[a-z0-9_]{1,60}$/.test(value.phase) ? value.phase : "unknown") +
        (typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code) ? "_" + value.code : "")));
    });
  }
  async request(input: Record<string, unknown>): Promise<unknown> {
    await this.ready; if (!this.child.connected || this.evidence.exited) throw new Error("native_v2_child_unavailable"); const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("native_v2_child_request_timeout")); }, input.operation === "close" ? 20_000 : 180_000);
      this.pending.set(id, { accept, reject, timer }); this.child.send({ ...input, nonce: this.nonce, id }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("native_v2_child_send_failed")); } });
    });
  }
  async close() {
    const errors: unknown[] = [];
    try { if (!this.evidence.exited) { const value = z.object({ closed: z.literal(true) }).strict().parse(await this.request({ operation: "close" })); this.evidence.acknowledged = value.closed; } } catch (error) { errors.push(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch (error) { errors.push(error); }
    try { await bounded(this.ended, "native_v2_child_exit_timeout", 20_000); }
    catch (error) { errors.push(error); this.evidence.forcedKill = true; this.child.kill("SIGKILL"); try { await bounded(this.ended, "native_v2_child_kill_exit_timeout", 2000); } catch (failure) { errors.push(failure); } }
    if (!this.evidence.acknowledged || !this.evidence.exited || this.evidence.exitCode !== 0 || this.evidence.signal !== null) errors.push(new Error("native_v2_child_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "NativeV2 child cleanup failed");
  }
}
async function fixture(leaf: string) {
  requireAgentReadBrowser(); const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  if (process.env.E2E_AGENT_NATIVE_V2_ISOLATED !== "1" || process.env.E2E_AGENT_RESOURCES_ISOLATED !== "1" || process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || api.port !== "8130")
    throw new Error("NativeV2 browser requires the exact compiled personal disposable boundary");
  const base = await agentReadBrowserFixture("native-v2-" + leaf); let child: NativeV2Child;
  try { child = new NativeV2Child(base.nonce); } catch (error) { try { await base.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "NativeV2 browser initialization and cleanup failed"); } throw error; }
  let closed = false;
  return { ...base, childClose: child.evidence,
    async seed() { return Seed.parse(await child.request({ operation: "seed", context: TenantContextSchema.parse(base.context) })); },
    execute: (runId: string, hold = false) => child.request({ operation: "execute", runId, hold }),
    async progress() { return Stats.parse(await child.request({ operation: "progress" })); },
    async wait() { return Stats.parse(await child.request({ operation: "wait" })); },
    release: () => child.request({ operation: "release" }),
    async business() { return z.record(z.string(), z.object({ count: z.number(), hash: z.string() }).strict()).parse(await child.request({ operation: "business" })); },
    async state(requestId: string) { return withTenant(base.database.db, base.context, async tx => ({
      runs: Array.from(await tx.execute(sql`select id,version,request_id,status,revision,model_turns,known_cost_usd::text,unknown_cost,input_checksum,result_checksum from agent_plan_runs where owner_id=${base.context.userId}::uuid and request_id=${requestId}::uuid order by id`)),
      steps: Array.from(await tx.execute(sql`select s.id,s.sequence,s.kind,s.phase,s.submission_state,s.input_checksum,s.output_checksum,s.response_checksum,s.cost_usd::text from agent_plan_steps s join agent_plan_runs r on r.id=s.run_id and r.tenant_id=s.tenant_id where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by s.sequence`)),
      budgets: Array.from(await tx.execute(sql`select b.id,b.state,b.amount_usd::text from ai_budget_ledger b join agent_plan_runs r on r.id=b.request_id and r.tenant_id=b.tenant_id where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by b.id`)),
    })); },
    async close() { if (closed) return; closed = true; const errors: unknown[] = [];
      try { await base.restore(); } catch (error) { errors.push(error); }
      try { await child.close(); } catch (error) { errors.push(error); }
      try { await base.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "NativeV2 personal browser cleanup failed");
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json()); }
async function readRun(page: Page, id: string) {
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-native-v2/runs/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
  const value = AgentNativeV2ViewSchema.parse(await response.json()); expect(value.id).toBe(id); expect(value.contextAuthority).toBe(authority); await verifyAgentNativeV2Transport(value); return value;
}
async function openRun(page: Page, run: AgentNativeV2View) {
  const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
  if (await review.isVisible()) { await review.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(review).not.toBeVisible(); }
  const input = panel(page).getByRole("textbox", { name: "十一类工具任务 ID", exact: true }); await input.fill(run.id);
  await panel(page).getByRole("button", { name: "按原 ID 读取任务", exact: true }).click(); await expect(evidence(page)).toBeVisible();
}
async function refresh(page: Page, id: string) {
  await expect.poll(() => new URL(page.url()).searchParams.get("agentNativeV2")).toBe(id);
  const button = panel(page).getByRole("button", { name: "只重新读取原任务", exact: true }); await expect(button).toBeEnabled(); await button.click(); await expect(button).toBeEnabled();
  return readRun(page, id);
}
async function markers(page: Page, preparation = false) {
  const prefix = preparation ? AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX : AGENT_NATIVE_V2_INTENT_PREFIX;
  const values = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!) as unknown), prefix);
  return preparation ? values.map(value => AgentNativeV2PreparationIntentSchema.parse(value)) : values.map(value => AgentNativeV2IntentSchema.parse(value));
}
async function fill(page: Page, f: Fixture, source: Source, complete: boolean) {
  await loginErp(page); await page.goto("/ai-tasks"); await expect(panel(page)).toBeVisible();
  const form = panel(page).getByRole("form", { name: "启动十一类原生工具模型任务", exact: true }); await expect(form).toBeVisible();
  await form.getByRole("textbox", { name: "本次任务目标", exact: true }).fill("Synthetic V2 eleven-owner source verification " + source.inputs["orders.order"].orderId);
  await form.getByRole("textbox", { name: "用户补充资料 未经事实核验", exact: true }).fill(source.contextText);
  await form.getByRole("combobox", { name: "本次原生任务模型", exact: true }).selectOption(f.model.modelId);
  await form.getByRole("textbox", { name: "美元费用上限", exact: true }).fill("1"); await form.getByRole("spinbutton", { name: "本次模型轮数上限", exact: true }).fill("32");
  const editor = form.getByRole("region", { name: "配置十一类原读取范围", exact: true });
  const selected = complete ? source.bindings : [source.bindings[1]!];
  for (const binding of selected) {
    await editor.getByRole("combobox", { name: "选择本次读取工具", exact: true }).selectOption(binding.tool);
    if (binding.tool === "orders.exceptions.page") { await editor.getByRole("combobox", { name: "原订单异常范围", exact: true }).selectOption("all"); await editor.getByRole("button", { name: "确定原订单异常范围", exact: true }).click(); }
    else if (binding.tool === "inventory.balances.page") await editor.getByRole("button", { name: "确定原库存读取范围", exact: true }).click();
    else if (binding.tool === "knowledge.search") { await editor.getByRole("combobox", { name: "知识主题", exact: true }).selectOption("operations"); await editor.getByRole("button", { name: "确定原知识范围", exact: true }).click(); }
    else if (binding.tool === "creative.history") { await editor.getByRole("combobox", { name: "创意执行范围", exact: true }).selectOption("inspection");
      const picker = editor.getByRole("combobox", { name: "选择已有创意对象", exact: true }); await expect(picker.locator(`option[value="${source.inspectionId}"]`)).toHaveCount(1); await picker.selectOption(source.inspectionId); }
    else if (binding.tool === "factory.capacity") { const picker = editor.getByRole("combobox", { name: "选择真实工厂", exact: true }); await expect(picker.locator(`option[value="${source.factoryId}"]`)).toHaveCount(1); await picker.selectOption(source.factoryId);
      await editor.getByLabel("工厂当地起始日期", { exact: true }).fill(source.from); await editor.getByRole("spinbutton", { name: "产能读取天数", exact: true }).fill("2"); await editor.getByRole("button", { name: "确定原工厂日期窗口", exact: true }).click(); }
    else { let id: string;
      if (binding.tool === "advertising.analysis") { const input = source.inputs[binding.tool], account = editor.getByRole("combobox", { name: "选择真实广告账户", exact: true });
        await expect(account.locator(`option[value="${input.accountId}"]`)).toHaveCount(1); await account.selectOption(input.accountId); id = input.analysisId; }
      else if (binding.tool === "research.evidence") id = source.inputs[binding.tool].researchItemId;
      else if (binding.tool === "catalog.sku") id = source.inputs[binding.tool].skuId;
      else if (binding.tool === "listing.version") id = source.inputs[binding.tool].listingId;
      else if (binding.tool === "orders.order") id = source.inputs[binding.tool].orderId;
      else id = source.inputs["finance.profit_run"].runId;
      const picker = editor.getByRole("combobox", { name: "选择原业务对象", exact: true }); await expect(picker.locator(`option[value="${id}"]`)).toHaveCount(1); await picker.selectOption(id);
    }
    const add = editor.getByRole("button", { name: "加入本次固定读取范围", exact: true }); await expect(add).toBeEnabled(); await add.click();
  }
  await expect(editor.getByRole("heading", { name: `固定读取范围 · ${selected.length} / 16`, exact: true })).toBeVisible();
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-native-v2/workspace", { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); const workspace = AgentNativeV2WorkspaceSchema.parse(await response.json()); expect(workspace.contextAuthority).toBe(authority);
  await form.locator("details.ap-command-picker > summary").click();
  for (const key of complete ? ["procurement/requisition_create", "finance/bill_record"] : ["procurement/requisition_create"]) {
    const capability = workspace.toolWorkspace.commands.find(row => row.domain + "/" + row.kind === key); if (!capability) throw new Error("Actual original command capability missing");
    expect(capability.available).toBe(true); await form.getByRole("checkbox", { name: capability.label, exact: true }).check();
  }
  return form;
}
function observe(page: Page) {
  const posts: Array<{ path: string; at: number }> = [], failures: Array<{ path: string; reason: string; at: number }> = [], errors: Array<{ path: string; status: number; code: string | null; authorityHash: string | null; at: number }> = [];
  const consoleErrors: Array<{ path: string; status: number | null; network: boolean; hash: string; at: number }> = [], pageErrors: string[] = [], pending: Promise<void>[] = [], lost = new Set<string>(); let transition = false;
  page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() === "POST" && /^\/api\/(agent|ai-assists)/.test(path)) posts.push({ path, at: Date.now() }); });
  page.on("requestfailed", request => failures.push({ path: new URL(request.url()).pathname, reason: request.failure()?.errorText ?? "unknown", at: Date.now() }));
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  page.on("response", response => { if (response.status() < 400) return; const path = new URL(response.url()).pathname, authority = response.request().headers()["x-yummyai-context-authority"];
    const row = { path, status: response.status(), code: null as string | null, authorityHash: authority ? sha(authority) : null, at: Date.now() }; errors.push(row);
    pending.push(response.json().then((value: unknown) => { if (value && typeof value === "object" && "code" in value && typeof value.code === "string") row.code = value.code; }).catch(() => {})); });
  page.on("console", message => { if (message.type() !== "error") return; let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* Unlocated errors remain errors. */ }
    const match = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(message.text());
    consoleErrors.push({ path, status: match ? Number(match[1]) : null, network: /^Failed to load resource: net::ERR_(FAILED|CONNECTION_RESET)/.test(message.text()), hash: sha(message.text()), at: Date.now() }); });
  return { posts, failures, errors, consoleErrors, pageErrors, lost, transition() { transition = true; }, async check() { await Promise.all(pending); expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter(error => !(error.network && lost.has(error.path) && failures.some(row => row.path === error.path && /^net::ERR_(FAILED|CONNECTION_RESET)$/.test(row.reason) && Math.abs(row.at - error.at) < 2000)) &&
      !(transition && error.status === 409 && errors.some(row => row.path === error.path && row.status === 409 && row.code === "authority_changed" && row.authorityHash !== null && Math.abs(row.at - error.at) < 2000)))).toEqual([]);
    expect(posts.filter(row => /^\/api\/(agent-native|agent-plans|agent-loops|ai-assists)\/runs$/.test(row.path))).toEqual([]);
  } };
}
async function leaf(page: Page, info: TestInfo, action: (f: Fixture, seen: ReturnType<typeof observe>, proof: Record<string, unknown>) => Promise<void>) {
  let f: Fixture | undefined, failure: unknown; const cleanup: unknown[] = [], proof: Record<string, unknown> = { operation: "5c82e6b4", title: info.title,
    externalModelTransport: "synthetic_http_only", actualOwners: true, modelBusinessSemantics: "not_proven_requires_original_operator_confirmation" };
  const seen = observe(page);
  try { f = await fixture(info.testId.replace(/[^a-z0-9]/gi, "").slice(-24)); proof.nonce = f.nonce; await action(f, seen, proof); await seen.check(); } catch (error) { failure = error; }
  try { await f?.close(); } catch (error) { cleanup.push(error); }
  const path = info.outputPath("agent-native-v2-proof.json"); await writeFile(path, JSON.stringify({ ...proof, completed: failure === undefined, cleanupFailureCount: cleanup.length,
    posts: seen.posts, errors: seen.errors, consoleErrors: seen.consoleErrors, pageErrors: seen.pageErrors, failedRequests: seen.failures, childClose: f?.childClose ?? null }, null, 2));
  await info.attach("agent-native-v2-proof", { path, contentType: "application/json" });
  if (failure !== undefined || cleanup.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanup], "NativeV2 personal browser acceptance or cleanup failed");
}

test("one personal native-v2 task actually reads all eleven original owners then prepares and confirms two individually reviewed original commands", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), before = await f.business(), form = await fill(page, f, source, true);
    const response = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === "/api/agent-native-v2/runs");
    await form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true }).click(); const createdResponse = await response; expect(createdResponse.status()).toBe(201);
    const created = AgentNativeV2ViewSchema.parse(await createdResponse.json()); proof.runId = created.id; proof.requestId = created.requestId;
    await f.execute(created.id); const worker = await f.wait(); expect(worker).toMatchObject({ modelCalls: 25, definitions: 121, reads: 117, settled: true, failure: null }); proof.worker = worker;
    const permissionProbes = { definitions: worker.definitions - 26, reads: worker.reads - 22 };
    expect(permissionProbes).toEqual({ definitions: 95, reads: 95 }); proof.permissionProbes = permissionProbes;
    proof.evidenceTransportCalls = { definitions: 26, reads: 22, toolCalls: 48 };
    const run = await refresh(page, created.id); expect(run).toMatchObject({ status: "completed", cost: { modelTurns: 25, knownCostUsd: "0.005250", reservedUsd: "0.000000" } });
    expect(run.steps).toHaveLength(49); expect(run.toolCalls).toBe(48); expect(run.observations.map(row => row.tool)).toEqual(source.bindings.map(row => row.tool));
    expect(run.items).toHaveLength(2); expect(run.items.every(row => row.preparationState === "not_requested")).toBe(true); expect(await f.business()).toEqual(before);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 900 : 1000 }); await panel(page).getByRole("heading", { name: "十一类原生工具模型任务", exact: true }).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath("native-v2-panel-" + width + ".png"), animations: "disabled" });
      await evidence(page).getByRole("combobox", { name: "查看十一类原读取步骤", exact: true }).selectOption("9"); await evidence(page).getByRole("region", { name: "十一类工具任务来源", exact: true }).scrollIntoViewIfNeeded();
      const financeSource = evidence(page).getByRole("region", { name: "利润原计算事实", exact: true });
      await expect(financeSource).toBeVisible(); await expect(financeSource.getByText("USD 53.00", { exact: true }).first()).toBeVisible();
      await expect.poll(() => evidence(page).locator(".anv2-resource").evaluate(shell => {
        const result = shell.querySelector(".ar-result");
        return { shellOpacity: getComputedStyle(shell).opacity, resultOpacity: result ? getComputedStyle(result).opacity : null,
          finiteAnimationsRunning: shell.getAnimations({ subtree: true }).filter(animation => {
            const timing = animation.effect?.getComputedTiming();
            return timing && Number.isFinite(Number(timing.endTime)) && (animation.playState === "running" || animation.pending);
          }).length };
      })).toEqual({ shellOpacity: "1", resultOpacity: "1", finiteAnimationsRunning: 0 });
      await page.screenshot({ path: info.outputPath("native-v2-finance-source-" + width + ".png"), animations: "allow" }); }
    await page.setViewportSize({ width: 1440, height: 1000 }); const effects: object[] = [];
    for (const [position, item] of run.items.entries()) { await openRun(page, run); const proposal = evidence(page).getByRole("listitem", { name: "十一类工具提案 " + (position + 1), exact: true }), prior = await f.business();
      const saved = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent-native-v2/runs/${run.id}/items/${item.id}/prepare`);
      const prepare = proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true }); await expect(prepare).toBeEnabled(); await prepare.click(); const preparedResponse = await saved; expect(preparedResponse.status()).toBe(201);
      const prepared = AgentNativeV2ItemReceiptSchema.parse(await preparedResponse.json()); expect(prepared.disposition).toBe("known"); expect(await f.business()).toEqual(prior);
      const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }); await expect(review).toBeVisible(); await review.getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
      const result = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent-commands/requests/${prepared.agentCommandId}/confirm`);
      await review.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click(); const resultResponse = await result; expect(resultResponse.status()).toBe(200); const actual = AgentCommandViewSchema.parse(await resultResponse.json());
      expect(actual).toMatchObject({ state: "succeeded", ownerCommandId: prepared.ownerCommandId, canConfirm: false }); const after = await f.business();
      if (position === 0) expect(after.inventory_procurement_requisitions!.count - prior.inventory_procurement_requisitions!.count).toBe(1);
      else expect(after.finance_payable_bills!.count - prior.finance_payable_bills!.count).toBe(1);
      effects.push({ itemId: item.id, agentCommandId: prepared.agentCommandId, ownerCommandId: prepared.ownerCommandId, state: actual.state });
    }
    expect((await f.progress()).modelCalls).toBe(25); expect(seen.posts.filter(row => row.path.endsWith("/prepare"))).toHaveLength(2); expect(seen.posts.filter(row => row.path.endsWith("/confirm"))).toHaveLength(2);
    proof.effects = effects; proof.onlyExplicitBusinessWrites = true;
  });
});

test("recovers lost original parent and child responses across refresh without paying twice then hides late private results after actual authority withdrawal", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), form = await fill(page, f, source, false), committed = latch(); let original: AgentNativeV2View | undefined;
    const parentPath = "/api/agent-native-v2/runs"; seen.lost.add(parentPath);
    await page.route("**" + parentPath, async route => { if (route.request().method() !== "POST") { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(201); original = AgentNativeV2ViewSchema.parse(await response.json()); committed.resolve(); await route.abort("connectionreset"); }, { times: 1 });
    await form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true }).click(); await bounded(committed.promise, "Actual V2 parent201 did not commit"); if (!original) throw new Error("Actual V2 parent missing");
    const run = original; proof.runId = run.id; proof.requestId = run.requestId;
    await expect.poll(() => markers(page)).toMatchObject([{ requestId: run.requestId, requestChecksum: run.requestChecksum, runId: null, state: "unknown" }]);
    const state = await f.state(run.requestId); await page.reload(); const marker = panel(page).getByRole("article", { name: "十一类工具原请求 " + run.requestId, exact: true });
    await marker.getByRole("button", { name: "只读取原请求回执", exact: true }).click(); await expect.poll(() => markers(page)).toMatchObject([{ requestId: run.requestId, runId: run.id, state: "known" }]);
    expect(await f.state(run.requestId)).toEqual(state); expect((await f.progress()).modelCalls).toBe(0); expect(seen.posts.filter(row => row.path === parentPath)).toHaveLength(1);
    await marker.getByRole("button", { name: "读取原任务详情", exact: true }).click(); await expect(evidence(page)).toBeVisible(); await f.execute(run.id); await f.wait(); const completed = await refresh(page, run.id);
    expect(completed.status).toBe("completed"); expect(completed.items).toHaveLength(1); const item = completed.items[0]!, preparedPath = `/api/agent-native-v2/runs/${run.id}/items/${item.id}/prepare`, born = latch();
    let prepared: z.infer<typeof AgentNativeV2ItemReceiptSchema> | undefined; seen.lost.add(preparedPath);
    await page.route("**" + preparedPath, async route => { const response = await route.fetch(); expect(response.status()).toBe(201); prepared = AgentNativeV2ItemReceiptSchema.parse(await response.json()); born.resolve(); await route.abort("connectionreset"); }, { times: 1 });
    const proposal = evidence(page).getByRole("listitem", { name: "十一类工具提案 1", exact: true }), prepare = proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true });
    await expect(prepare).toBeEnabled(); await prepare.click(); await bounded(born.promise, "Actual V2 child201 did not commit");
    await expect.poll(() => markers(page, true)).toMatchObject([{ runId: run.id, itemId: item.id, state: "unknown" }]); if (!prepared?.ownerCommandId) throw new Error("Actual original prepared owner ID missing");
    const frozen = await f.state(run.requestId), business = await f.business(); await page.reload(); await expect(evidence(page)).toBeVisible();
    const restored = evidence(page).getByRole("listitem", { name: "十一类工具提案 1", exact: true }); await restored.getByRole("button", { name: "读取这项原准备回执", exact: true }).click();
    await expect(restored.getByRole("link", { name: "核对这项原操作" })).toHaveAttribute("href", "/ai-tasks?agentCommand=" + prepared.agentCommandId);
    expect(await f.state(run.requestId)).toEqual(frozen); expect(await f.business()).toEqual(business); expect(seen.posts.filter(row => row.path === preparedPath)).toHaveLength(1);
    proof.recoveredItem = { itemId: item.id, agentCommandId: prepared.agentCommandId, ownerCommandId: prepared.ownerCommandId };
    const entered = latch(), release = latch(), settled = latch(), path = `/api/agent-native-v2/runs/${run.id}`; let returned = false, routeFailure: string | null = null;
    await page.route("**" + path, async route => { try { const response = await route.fetch(); expect(response.status()).toBe(200); const body = AgentNativeV2ViewSchema.parse(await response.json()); expect(body.privateAvailable).toBe(true);
      entered.resolve(); await release.promise; await route.fulfill({ response, body: JSON.stringify(body) }); returned = true;
    } catch (error) { routeFailure = sha(error instanceof Error ? error.name : "Error"); } finally { settled.resolve(); } }, { times: 1 });
    const refreshPromise = panel(page).getByRole("button", { name: "只重新读取原任务", exact: true }).click();
    try { await bounded(entered.promise, "Actual old-authority V2 BFF response was not captured"); await f.inventorySelf(); seen.transition();
      const navigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame() && new URL(frame.url()).pathname === "/ai-tasks"); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation;
      await expect(panel(page)).toBeVisible(); const authority = erpSessionAuthority(await session(page));
      release.resolve(); await bounded(settled.promise, "Held original V2 response did not settle"); await refreshPromise;
      const hidden = await readRun(page, run.id); expect(hidden).toMatchObject({ privateAvailable: false, goal: null, contextText: null, readContracts: null, steps: [], definitions: [], observations: [], result: null });
      expect(hidden.items[0]?.id).toBe(item.id); expect(hidden.items[0]?.agentCommandId).toBe(prepared.agentCommandId);
      await expect(panel(page).getByText(completed.goal!, { exact: true })).toHaveCount(0); await expect(panel(page).getByRole("region", { name: "十一类工具任务来源", exact: true })).toHaveCount(0);
      await expect(panel(page).getByRole("region", { name: "原生标量来源引用", exact: true })).toHaveCount(0); await expect(panel(page).getByRole("button", { name: "保存这项原准备并核对", exact: true })).toHaveCount(0);
      expect(await f.business()).toEqual(business); expect((await f.progress()).modelCalls).toBe(4); expect(seen.posts.filter(row => row.path.endsWith("/confirm"))).toHaveLength(0);
      proof.currentAuthorityHash = sha(authority); proof.lateResult = { returned, routeFailure, privateCleared: true }; proof.worker = await f.progress();
    } finally { release.resolve(); await bounded(settled.promise, "V2 held response cleanup did not settle"); await page.unroute("**" + path); }
  });
});
