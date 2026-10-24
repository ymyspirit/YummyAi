import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { AgentPlanIntentSchema, AgentPlanPreparationIntentSchema, AgentPlanViewSchema, AgentPlanItemReceiptSchema, AgentPlanWorkspaceSchema, type AgentPlanView } from "@yummyai/contracts/ai/agent-plan";
import { AgentCommandViewSchema } from "@yummyai/contracts/ai/agent-command";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { agentPlanBrowserFixture } from "./agent-plan-fixture";
import { loginErp } from "./erp-identity-fixture";

type Fixture = Awaited<ReturnType<typeof agentPlanBrowserFixture>>;
const region = (page: Page) => page.getByRole("region", { name: "模型业务计划", exact: true });
const detail = (page: Page) => page.getByRole("region", { name: "业务计划详情", exact: true });
const review = (page: Page) => page.getByRole("region", { name: "核对 Agent 原操作", exact: true });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const regex = (text: string) => new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
test.describe.configure({ mode: "serial" });

async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json());
}
async function readRun(page: Page, id: string) {
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-plans/runs/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); return AgentPlanViewSchema.parse(await response.json());
}
async function readOperation(page: Page, id: string) {
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-commands/requests/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); return AgentCommandViewSchema.parse(await response.json());
}
async function markers(page: Page) {
  const raw = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("yummyai.agent-plan.intent.v1:")).map(key => sessionStorage.getItem(key)));
  return raw.map(value => AgentPlanIntentSchema.parse(JSON.parse(value!)));
}
async function preparationMarkers(page: Page) {
  const raw = await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("yummyai.agent-plan-preparation.intent.v1:")).map(key => sessionStorage.getItem(key)));
  return raw.map(value => AgentPlanPreparationIntentSchema.parse(JSON.parse(value!)));
}
async function fill(page: Page, fixture: Fixture, source: Awaited<ReturnType<Fixture["seed"]>>) {
  await loginErp(page, "operator", "/ai-tasks");
  const authority = erpSessionAuthority(await session(page)), response = await page.request.get("/api/agent-plans/workspace", { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); const workspace = AgentPlanWorkspaceSchema.parse(await response.json());
  const form = region(page).getByRole("form", { name: "新建模型业务计划", exact: true });
  await expect(form.getByRole("combobox", { name: /^业务计划执行模型/ }).locator('option[value="' + fixture.model.modelId + '"]')).toHaveCount(1);
  await form.getByRole("textbox", { name: "业务计划目标", exact: true }).fill("Synthetic actual ERP source read and individually confirmed original command plan");
  await form.locator("details").filter({ has: page.getByText("补充资料 用户声明 尚未核验", { exact: true }) }).locator("summary").click();
  await form.getByRole("textbox", { name: "业务计划补充资料", exact: true }).fill(source.contextText);
  await form.getByRole("combobox", { name: /^业务计划执行模型/ }).selectOption(fixture.model.modelId);
  await form.getByLabel("费用上限 USD", { exact: true }).fill("1.000000");
  await form.getByRole("checkbox", { name: /^库存余额/ }).check();
  for (const key of [{ domain: "procurement", kind: "requisition_create" }, { domain: "finance", kind: "bill_record" }]) {
    const capability = workspace.commandCapabilities.find(item => item.domain === key.domain && item.kind === key.kind)!;
    expect(capability.available).toBe(true); await form.getByRole("checkbox", { name: regex(capability.label) }).check();
  }
  return form;
}
async function openPlan(page: Page, run: Pick<AgentPlanView, "id" | "requestId">) {
  const operation = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
  if (await operation.count()) {
    await operation.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(operation).toHaveCount(0);
  }
  if (await detail(page).count()) { await expect(detail(page)).toContainText(run.id); return; }
  const marker = region(page).getByRole("article", { name: "原业务计划请求 " + run.requestId, exact: true });
  await marker.getByRole("button", { name: "读取原任务详情", exact: true }).click(); await expect(detail(page)).toContainText(run.id);
}
async function refresh(page: Page, id: string) {
  const returned = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/agent-plans/runs/" + id && response.status() === 200);
  await detail(page).getByRole("button", { name: "重新读取原业务计划", exact: true }).click(); return AgentPlanViewSchema.parse(await (await returned).json());
}
function observe(page: Page) {
  const posts: Array<{ path: string; at: number }> = [], failed: Array<{ path: string; reason: string; at: number }> = [];
  const responses: Array<{ path: string; status: number; code: string | null; authorityHash: string | null; at: number }> = [];
  const errors: Array<{ path: string; status: number | null; network: boolean; digest: string; at: number }> = [], pageErrors: string[] = [], pending: Promise<void>[] = [];
  const intentionallyLost = new Set<string>(); let transition = false;
  page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() === "POST" && /^\/api\/(agent-plans|agent-commands|ai-assists|agent-loops)/.test(path)) posts.push({ path, at: Date.now() }); });
  page.on("requestfailed", request => failed.push({ path: new URL(request.url()).pathname, reason: request.failure()?.errorText ?? "unknown", at: Date.now() }));
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  page.on("response", response => {
    if (response.status() < 400) return; const path = new URL(response.url()).pathname;
    const row = { path, status: response.status(), code: null as string | null, authorityHash: response.request().headers()["x-yummyai-context-authority"] ? sha(response.request().headers()["x-yummyai-context-authority"]!) : null, at: Date.now() }; responses.push(row);
    pending.push(response.json().then((value: unknown) => { if (value && typeof value === "object" && "code" in value && typeof value.code === "string") row.code = value.code; }).catch(() => {}));
  });
  page.on("console", message => { if (message.type() !== "error") return; let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* Missing URL is never accepted as an expected request. */ }
    const match = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(message.text());
    errors.push({ path, status: match ? Number(match[1]) : null, network: /^Failed to load resource: net::ERR_(FAILED|CONNECTION_RESET)/.test(message.text()), digest: sha(message.text()), at: Date.now() }); });
  return { posts, failed, responses, errors, pageErrors, intentionallyLost,
    authorityTransition() { transition = true; },
    async check() { await Promise.all(pending); expect(pageErrors).toEqual([]);
      const unexplained = errors.filter(error => !(error.network && intentionallyLost.has(error.path) && failed.some(row => row.path === error.path && /^net::ERR_(FAILED|CONNECTION_RESET)$/.test(row.reason) && Math.abs(row.at - error.at) < 2000)) &&
        !(transition && error.status === 409 && responses.some(row => row.path === error.path && row.status === 409 && row.code === "authority_changed" && row.authorityHash !== null && Math.abs(row.at - error.at) < 2000)));
      expect(unexplained).toEqual([]); expect(posts.filter(row => /^\/api\/(agent-loops|ai-assists)\/runs$/.test(row.path))).toEqual([]);
    } };
}
async function leaf(page: Page, info: TestInfo, action: (fixture: Fixture, seen: ReturnType<typeof observe>, evidence: Record<string, unknown>) => Promise<void>) {
  let fixture: Fixture | undefined, failure: unknown; const cleanup: unknown[] = [], evidence: Record<string, unknown> = { operation: "b41e0c72", title: info.title, modelTransport: "synthetic_http_only", nativeOwnerEffects: "actual", semanticBusinessCorrectness: "requires_original_operator_review", externalMarketplaceActions: false };
  const seen = observe(page);
  try { fixture = await agentPlanBrowserFixture(info.testId.replace(/[^a-z0-9]/gi, "").slice(-24)); evidence.nonce = fixture.nonce; await action(fixture, seen, evidence); await seen.check(); }
  catch (error) { failure = error; }
  try { await fixture?.close(); } catch (error) { cleanup.push(error); }
  const path = info.outputPath("agent-plan-proof.json");
  await writeFile(path, JSON.stringify({ ...evidence, posts: seen.posts, failedRequests: seen.failed, responses: seen.responses, consoleErrors: seen.errors,
    pageErrors: seen.pageErrors, completed: failure === undefined, cleanupFailureCount: cleanup.length }, null, 2));
  await info.attach("agent-plan-proof", { path, contentType: "application/json" });
  if (failure !== undefined || cleanup.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanup], "Agent plan actual personal workflow or cleanup failed");
}

test("personal model reads actual inventory and offers two original drafts which require separate preparation and individual confirmation before real procurement and finance effects", async ({ page }, info) => {
  await leaf(page, info, async (fixture, seen, evidence) => {
    const source = await fixture.seed(), before = await fixture.businessState(), form = await fill(page, fixture, source);
    const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent-plans/runs");
    await form.getByRole("button", { name: "登记并生成业务计划", exact: true }).click(); const response = await created; expect(response.status()).toBe(201);
    const run = AgentPlanViewSchema.parse(await response.json()); evidence.runId = run.id; evidence.requestId = run.requestId;
    await fixture.execute(run.id); const stats = await fixture.wait(); expect(stats).toMatchObject({ modelCalls: 2, readCalls: 2, settled: true, failure: null }); evidence.worker = stats;
    const complete = await refresh(page, run.id); expect(complete).toMatchObject({ status: "completed", items: [{ preparationState: "not_requested" }, { preparationState: "not_requested" }], cost: { knownCostUsd: "0.000420", reservedUsd: "0.000000" } });
    expect(await fixture.businessState()).toEqual(before); await expect(detail(page)).toContainText("模型计划已生成");
    await expect(detail(page).getByRole("button", { name: "确认执行这笔原操作", exact: true })).toHaveCount(0);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 900 : 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath("agent-plan-" + width + ".png"), fullPage: true, animations: "disabled" }); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const actuals: Array<{ itemId: string; commandId: string; ownerCommandId: string; domain: string; resultId: string | null }> = [];
    for (const [index, item] of complete.items.entries()) {
      if (index) await openPlan(page, complete);
      const proposal = detail(page).getByRole("listitem", { name: "业务计划提案 " + (index + 1), exact: true }), pendingBusiness = await fixture.businessState();
      const returned = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent-plans/runs/${run.id}/items/${item.id}/prepare`);
      await proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true }).click(); const saved = await returned; expect(saved.status()).toBe(201);
      const receipt = AgentPlanItemReceiptSchema.parse(await saved.json()); expect(receipt).toMatchObject({ itemId: item.id, disposition: "known", proposalChecksum: item.proposalChecksum });
      expect(await fixture.businessState()).toEqual(pendingBusiness); await expect(review(page)).toContainText(receipt.ownerCommandId!);
      const original = await readOperation(page, receipt.agentCommandId!); expect(original.snapshot?.original).toEqual(complete.result!.proposals[index]!.draft.original);
      const dialog = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
      await expect(dialog.getByRole("button", { name: "确认执行这笔原操作", exact: true })).toBeDisabled();
      await review(page).getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
      const confirm = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent-commands/requests/${original.id}/confirm`);
      await dialog.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click(); const committed = await confirm; expect(committed.status()).toBe(200);
      const done = AgentCommandViewSchema.parse(await committed.json()); expect(done).toMatchObject({ state: "succeeded", ownerCommandId: receipt.ownerCommandId });
      const state = await fixture.businessState();
      expect(state[index === 0 ? "inventory_procurement_requisitions" : "finance_payable_bills"]!.count).toBe(pendingBusiness[index === 0 ? "inventory_procurement_requisitions" : "finance_payable_bills"]!.count + 1);
      const nativeView = done.snapshot?.native.view;
      actuals.push({ itemId: item.id, commandId: original.id, ownerCommandId: receipt.ownerCommandId!, domain: original.domain,
        resultId: nativeView && "result" in nativeView ? nativeView.result?.id ?? null : null });
      const acknowledged = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent-commands/requests/${original.id}/acknowledge`);
      await dialog.getByRole("button", { name: "确认结果并清除原填写副本", exact: true }).click(); expect((await acknowledged).status()).toBe(200);
    }
    expect((await fixture.progress()).modelCalls).toBe(2); expect(seen.posts.filter(row => row.path === "/api/agent-plans/runs")).toHaveLength(1);
    const after = await fixture.businessState(); expect(after.finance_original_write_proofs!.count).toBe(before.finance_original_write_proofs!.count + 1);
    for (const table of ["inventory_balances", "inventory_movements", "inventory_reservations", "orders", "production_orders"]) expect(after[table]).toEqual(before[table]);
    evidence.actuals = actuals; evidence.plan = await fixture.planState(run.requestId);
  });
});

test("lost planning and original preparation201 recover through pure-ID GETs across refresh without another paid turn or preparation and domain narrowing hides fixed private drafts", async ({ page }, info) => {
  await leaf(page, info, async (fixture, seen, evidence) => {
    const source = await fixture.seed(), before = await fixture.businessState(), form = await fill(page, fixture, source);
    let admitted!: AgentPlanView, admittedResolve!: () => void; const admittedDone = new Promise<void>(resolve => { admittedResolve = resolve; });
    seen.intentionallyLost.add("/api/agent-plans/runs");
    await page.route("**/api/agent-plans/runs", async route => { if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(201); admitted = AgentPlanViewSchema.parse(await response.json()); await route.abort("failed"); admittedResolve(); });
    await form.getByRole("button", { name: "登记并生成业务计划", exact: true }).click(); await admittedDone;
    evidence.runId = admitted.id; evidence.requestId = admitted.requestId;
    await expect.poll(async () => (await markers(page)).some(marker => marker.requestId === admitted.requestId && marker.state === "unknown" && marker.runId === null)).toBe(true);
    const stored = await markers(page); expect(JSON.stringify(stored)).not.toContain(source.contextText);
    await page.reload();
    const recovery = region(page).getByRole("article", { name: "原业务计划请求 " + admitted.requestId, exact: true });
    const recovered = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/agent-plans/receipts" && response.status() === 200);
    await recovery.getByRole("button", { name: "只读取原请求回执", exact: true }).click(); await recovered;
    await expect.poll(async () => (await markers(page)).some(marker => marker.requestId === admitted.requestId && marker.runId === admitted.id && marker.state === "known")).toBe(true);
    evidence.parentRecovered = { requestId: admitted.requestId, runId: admitted.id, state: "known" };
    await openPlan(page, admitted); await fixture.execute(admitted.id); expect(await fixture.wait()).toMatchObject({ modelCalls: 2, readCalls: 2, failure: null, settled: true });
    const run = await refresh(page, admitted.id), item = run.items[0]!, path = `/api/agent-plans/runs/${run.id}/items/${item.id}/prepare`;
    const privateGoal = run.goal, privateContext = run.contextText;
    if (!privateGoal || !privateContext) throw new Error("Actual original plan private fields were not available before authority narrowing");
    let savedResolve!: () => void; const savedDone = new Promise<void>(resolve => { savedResolve = resolve; }); seen.intentionallyLost.add(path);
    await page.route("**" + path, async route => { const response = await route.fetch(); expect(response.status()).toBe(201);
      const actual = AgentPlanItemReceiptSchema.parse(await response.json()); expect(actual.disposition).toBe("known"); await route.abort("failed"); savedResolve(); });
    await detail(page).getByRole("listitem", { name: "业务计划提案 1", exact: true }).getByRole("button", { name: "保存这项原准备并核对", exact: true }).click(); await savedDone;
    await expect.poll(async () => (await preparationMarkers(page)).some(marker => marker.itemId === item.id && marker.state === "unknown")).toBe(true);
    const receipt = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/agent-plans/runs/${run.id}/items/${item.id}/receipt` && response.status() === 200);
    await page.reload(); const actual = AgentPlanItemReceiptSchema.parse(await (await receipt).json()); expect(actual.disposition).toBe("known");
    await expect.poll(async () => (await preparationMarkers(page)).some(marker => marker.itemId === item.id && marker.state === "known")).toBe(true);
    const proposal = detail(page).getByRole("listitem", { name: "业务计划提案 1", exact: true }); await expect(proposal.getByRole("link", { name: /^核对这项原操作/ })).toBeVisible();
    expect((await readOperation(page, actual.agentCommandId!)).state).toBe("prepared"); expect(await fixture.businessState()).toEqual(before);
    expect(seen.posts.filter(row => row.path === path)).toHaveLength(1); expect(seen.posts.filter(row => row.path === "/api/agent-plans/runs")).toHaveLength(1);
    const state = await fixture.planState(run.requestId); expect(state.runs).toHaveLength(1); expect(state.budgets).toHaveLength(1); expect((await fixture.progress()).modelCalls).toBe(2);
    evidence.recoveredItem = { itemId: item.id, commandId: actual.agentCommandId, ownerCommandId: actual.ownerCommandId }; evidence.plan = state;
    seen.authorityTransition(); await fixture.inventorySelf(); const narrow = await session(page); expect(narrow.permissionScopes?.["inventory:read"]).toBe("self");
    const authority = erpSessionAuthority(narrow), workspace = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-plans/workspace" && response.status() === 200 && response.request().headers()["x-yummyai-context-authority"] === authority);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await workspace;
    const hidden = await readRun(page, run.id); expect(hidden).toMatchObject({ privateAvailable: false, goal: null, contextText: null, result: null, collections: [], steps: [] });
    expect(hidden.items.every(value => !value.canPrepare)).toBe(true);
    await expect(detail(page).getByText("原私文尚未读取或当前不可读取 请核对当前读取权限", { exact: true })).toBeVisible();
    await expect(region(page).getByText(privateGoal, { exact: true })).toHaveCount(0); await expect(region(page).getByText(privateContext, { exact: true })).toHaveCount(0);
    await expect(region(page).getByRole("textbox", { name: "业务计划目标", exact: true, includeHidden: true })).toHaveValue("");
    await expect(region(page).getByRole("textbox", { name: "业务计划补充资料", exact: true, includeHidden: true })).toHaveValue("");
    await expect(detail(page).locator('li[aria-label^="业务计划提案 "]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(保存这项原准备并核对|使用原键重试准备|确认执行这笔原操作)$/, includeHidden: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /^核对这项原操作/, includeHidden: true })).toHaveCount(0);
    evidence.privateCleared = { privateAvailable: hidden.privateAvailable, remainingSteps: hidden.steps.length, canPrepareCount: hidden.items.filter(value => value.canPrepare).length,
      oldGoalAndContextAbsent: true, proposalsAbsent: true, prepareAndConfirmAbsent: true };
    expect(await fixture.businessState()).toEqual(before); expect((await fixture.progress()).modelCalls).toBe(2);
    await fixture.restore(); const restored = erpSessionAuthority(await session(page));
    const ready = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-plans/workspace" && response.status() === 200 && response.request().headers()["x-yummyai-context-authority"] === restored);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await ready;
  });
});
