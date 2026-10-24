import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { AgentCommandIntentSchema, AgentCommandReceiptSchema, AgentCommandViewSchema, type AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { FinanceCommandDetailSchema } from "@yummyai/contracts/finance/finance-command";
import { agentCommandBrowserFixture, type AgentCommandBrowserFixture } from "./agent-command-fixture";
import { loginErp } from "./erp-identity-fixture";
import { procurementCommandDialog } from "./procurement-command-fixture";
import { financeCommandReview, readFinanceCommandOriginal } from "./finance-command-fixture";

const prefix = "yummyai.agent-operation.intent.v1:", review = (page: Page) => page.getByRole("region", { name: "核对 Agent 原操作", exact: true });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
test.describe.configure({ mode: "serial" });
async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json());
}
async function readOperation(page: Page, id: string) {
  const authority = erpSessionAuthority(await session(page));
  const response = await page.request.get("/api/agent-commands/requests/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); return AgentCommandViewSchema.parse(await response.json());
}
async function markers(page: Page) {
  const saved = await page.evaluate(key => Object.keys(sessionStorage).filter(value => value.startsWith(key)).map(key => sessionStorage.getItem(key)), prefix);
  return saved.map(text => AgentCommandIntentSchema.parse(JSON.parse(text!)));
}
async function originalReview(page: Page, source: Awaited<ReturnType<AgentCommandBrowserFixture["source"]>>, loggedIn = false) {
  const path = source.domain === "procurement" ? "/procurement" : "/finance/originals";
  if (!loggedIn) await loginErp(page, "operator", path); else await page.goto(path);
  if (source.domain === "procurement") {
    const recovery = page.getByRole("region", { name: "待核对的采购提交", exact: true });
    await recovery.getByRole("listitem").filter({ hasText: source.marker }).getByRole("button", { name: "恢复原提交", exact: true }).click();
    const dialog = await procurementCommandDialog(page); await expect(dialog).toContainText(source.marker);
    await expect(dialog.getByRole("button", { name: "交给AI工作台核对", exact: true })).toBeEnabled(); return dialog;
  }
  const recovery = page.getByRole("region", { name: "本人财务原提交", exact: true });
  await recovery.getByRole("textbox", { name: "原提交 ID", exact: true }).fill(source.reference.commandId);
  await recovery.getByRole("button", { name: "按原提交 ID 读取", exact: true }).click();
  const detailResponse = await page.request.get("/api/finance/commands/" + source.reference.commandId); expect(detailResponse.status()).toBe(200);
  await readFinanceCommandOriginal(page, FinanceCommandDetailSchema.parse(await detailResponse.json()));
  const form = financeCommandReview(page); await expect(form).toContainText(source.marker);
  await expect(form.getByRole("button", { name: "交给AI工作台核对", exact: true })).toBeEnabled(); return form;
}
async function handoff(page: Page, scope: ReturnType<typeof review>) {
  const returned = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-commands/adopt" && response.request().method() === "POST");
  await scope.getByRole("button", { name: "交给AI工作台核对", exact: true }).click();
  const response = await returned; expect(response.status()).toBe(201); const value = AgentCommandViewSchema.parse(await response.json());
  await expect(page).toHaveURL(new RegExp("/ai-tasks\\?agentCommand=" + value.id));
  await expect(review(page)).toContainText(value.ownerCommandId!); await expect(review(page)).toContainText("原命令已准备 尚未执行业务"); return value;
}
async function explicitConfirm(page: Page, value: AgentCommandView) {
  const dialog = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
  await expect(dialog.getByRole("button", { name: "确认执行这笔原操作", exact: true })).toBeDisabled();
  await review(page).getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
  const returned = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-commands/requests/" + value.id + "/confirm" && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click();
  const response = await returned; expect(response.status()).toBe(200); const actual = AgentCommandViewSchema.parse(await response.json());
  expect(actual).toMatchObject({ id: value.id, requestId: value.requestId, ownerCommandId: value.ownerCommandId, state: "succeeded" });
  await expect(review(page)).toContainText("原业务结果已登记"); return actual;
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
const originalPhysical = (state: Awaited<ReturnType<AgentCommandBrowserFixture["state"]>>) => Object.fromEntries(Object.entries(state)
  .filter(([name]) => ["inventory_movements", "inventory_reservations", "orders", "production_orders", "ai_budget_ledger", "ai_assist_runs", "agent_loop_runs"].includes(name)));

async function runLeaf(page: Page, info: TestInfo, action: (fixture: AgentCommandBrowserFixture, evidence: Record<string, unknown>) => Promise<void>) {
  let fixture: AgentCommandBrowserFixture | undefined, failed: unknown;
  const cleanup: unknown[] = [], evidence: Record<string, unknown> = { operation: "6f2d9a84", title: info.title, paidModelUsed: false,
    externalBusinessTransactions: false, mcpConnected: false, autonomousModelWrites: false };
  const posts: Array<{ path: string; at: number }> = [], failures: Array<{ path: string; at: number; reason: string }> = [];
  const consoleErrors: Array<{ path: string; at: number; fingerprint: string; network: boolean; status: number | null }> = [], pageErrors: string[] = [];
  const deniedResponses: Array<{ path: string; at: number; status: number; code: string | null }> = [];
  page.on("request", request => { const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/(agent-commands|agent-loops|ai-assists)/.test(path)) posts.push({ path, at: Date.now() }); });
  page.on("requestfailed", request => failures.push({ path: new URL(request.url()).pathname, at: Date.now(), reason: request.failure()?.errorText ?? "unknown" }));
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (response.status() !== 409 || path !== "/api/agent-commands/adopt") return;
    const row = { path, at: Date.now(), status: response.status(), code: null as string | null }; deniedResponses.push(row);
    void response.json().then(body => { if (body?.code === "authority_changed") row.code = "authority_changed"; }).catch(() => {});
  });
  page.on("console", message => { if (message.type() !== "error") return;
    let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* No URL is never accepted as expected network evidence. */ }
    const status = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(message.text());
    consoleErrors.push({ path, at: Date.now(), fingerprint: sha(message.text()), network: /^Failed to load resource: net::ERR_(CONNECTION_RESET|FAILED)/.test(message.text()),
      status: status ? Number(status[1]) : null }); });
  try {
    fixture = await agentCommandBrowserFixture(); evidence.nonce = fixture.nonce;
    await action(fixture, evidence);
    expect(pageErrors).toEqual([]);
    const unexplained = consoleErrors.filter(row => !(row.network && failures.some(failure => failure.path === row.path &&
      /^\/api\/agent-commands\/(adopt|requests\/[a-f0-9-]+\/confirm)$/.test(failure.path) &&
      /^net::ERR_(CONNECTION_RESET|FAILED)$/.test(failure.reason) && Math.abs(failure.at - row.at) < 2000)) &&
      !(row.status === 409 && deniedResponses.some(response => response.path === row.path && response.status === row.status &&
        response.code === "authority_changed" && Math.abs(response.at - row.at) < 2000)));
    expect(unexplained).toEqual([]); expect(posts.filter(row => /\/api\/(agent-loops\/runs|ai-assists\/runs)$/.test(row.path))).toEqual([]);
  } catch (error) { failed = error; }
  try { await fixture?.close(); } catch (error) { cleanup.push(error); }
  const path = info.outputPath("agent-command-proof.json");
  await writeFile(path, JSON.stringify({ ...evidence, posts, failedRequests: failures, deniedResponses, consoleErrors, pageErrors,
    cleanupFailureCount: cleanup.length, completed: failed === undefined }, null, 2));
  await info.attach("agent-command-proof", { path, contentType: "application/json" });
  if (failed !== undefined || cleanup.length) throw new AggregateError([...(failed === undefined ? [] : [failed]), ...cleanup], "Agent command personal browser or cleanup failed");
}

test("personal original Reviews hand off procurement and finance for separate explicit confirmation with exact real owner results", async ({ page }, info) => {
  await runLeaf(page, info, async (fixture, evidence) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const baseline = await fixture.state(), results: Array<{ domain: string; id: string; ownerId: string; resultId: string }> = [];
    for (const domain of ["procurement", "finance"] as const) {
      const source = await fixture.source(domain), before = await fixture.state(), original = await originalReview(page, source, results.length > 0);
      const prepared = await handoff(page, original); expect(prepared.snapshot?.original).toEqual(source.original);
      expect((await fixture.native(domain, source.reference.commandId)).status).toBe("prepared");
      expect((await fixture.state())[domain === "procurement" ? "inventory_procurement_requisitions" : "finance_payable_bills"]).toEqual(before[domain === "procurement" ? "inventory_procurement_requisitions" : "finance_payable_bills"]);
      await expect(review(page).getByRole("region", { name: "完整原业务填写核对", exact: true })).toContainText(source.marker);
      if (domain === "finance") await expect(review(page)).toContainText("123.45");
      if (!results.length) {
        await noOverflow(page); await page.screenshot({ path: info.outputPath("agent-command-desktop.png"), fullPage: true, animations: "disabled" });
        await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
        await page.screenshot({ path: info.outputPath("agent-command-390.png"), fullPage: true, animations: "disabled" });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      const done = await explicitConfirm(page, prepared), native = await fixture.native(domain, source.reference.commandId);
      expect(native.status).toBe("succeeded"); expect(native.result?.id).toBeTruthy();
      expect((await readOperation(page, done.id)).snapshot?.native.view.id).toBe(native.id);
      results.push({ domain, id: done.id, ownerId: native.id, resultId: native.result!.id });
      const ack = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-commands/requests/" + done.id + "/acknowledge" && response.request().method() === "POST");
      await page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "确认结果并清除原填写副本", exact: true }).click();
      expect((await ack).status()).toBe(200);
      await expect.poll(async () => (await markers(page)).some(row => row.id === done.id)).toBe(false);
    }
    const after = await fixture.state(); expect(after.inventory_procurement_requisitions.count).toBe(baseline.inventory_procurement_requisitions.count + 1);
    expect(after.finance_payable_bills.count).toBe(baseline.finance_payable_bills.count + 1);
    expect(after.finance_original_write_proofs.count).toBe(baseline.finance_original_write_proofs.count + 1);
    expect(originalPhysical(after)).toEqual(originalPhysical(baseline)); evidence.results = results; evidence.originalPhysicalUnchanged = true;
  });
});

test("lost201 handoff and committed200 execution recover by pure IDs and GET across refresh without another business write then clear private data on authority loss", async ({ page }, info) => {
  await runLeaf(page, info, async (fixture, evidence) => {
    const source = await fixture.source("procurement"), initial = await fixture.state();
    const staleReview = await originalReview(page, source);
    await fixture.grant(fixture.originalPermissions.filter(bit => bit !== Permission.ProcurementRead));
    const deniedHandoff = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-commands/adopt" && response.request().method() === "POST");
    await staleReview.getByRole("button", { name: "交给AI工作台核对", exact: true }).click();
    const denial = await deniedHandoff; expect(denial.status()).toBe(409); expect(await denial.json()).toHaveProperty("code", "authority_changed");
    await expect(staleReview.getByRole("region", { name: "核对采购原提交", exact: true })).toHaveCount(0);
    await expect(staleReview.getByRole("button", { name: "确认执行原提交", exact: true })).toHaveCount(0);
    const deniedOriginal = await page.request.get("/api/procurement-commands/commands/" + source.reference.commandId);
    expect(deniedOriginal.status()).toBe(403); expect(await deniedOriginal.text()).not.toContain(source.marker);
    expect((await fixture.state()).inventory_procurement_requisitions).toEqual(initial.inventory_procurement_requisitions);
    // An explicitly ended personal session clears its local unknown marker.
    // No not_found response is treated as proof that an operation was unsubmitted.
    if (await staleReview.count()) await staleReview.getByRole("button", { name: "关闭采购原填写与执行", exact: true }).click();
    await expect(staleReview).toHaveCount(0);
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect.poll(async () => (await markers(page)).length).toBe(0);
    await fixture.grant(fixture.originalPermissions);
    const scope = await originalReview(page, source);
    evidence.staleHandoffDenied = { status: denial.status(), code: "authority_changed", sameOwnerCommandId: source.reference.commandId, priorReviewCleared: true };
    const lost: { prepared?: AgentCommandView; completed?: AgentCommandView; adoptSettled: boolean; confirmSettled: boolean } = { adoptSettled: false, confirmSettled: false };
    const loseAdopt = async (route: Route) => {
      try { const response = await route.fetch(); expect(response.status()).toBe(201); lost.prepared = AgentCommandViewSchema.parse(await response.json()); }
      finally { try { await route.abort("connectionreset"); } finally { lost.adoptSettled = true; } }
    };
    await page.route("**/api/agent-commands/adopt", loseAdopt);
    await scope.getByRole("button", { name: "交给AI工作台核对", exact: true }).click();
    await expect.poll(() => lost.adoptSettled).toBe(true); await expect(scope).toContainText("本人有原交接结果未知");
    await page.unroute("**/api/agent-commands/adopt", loseAdopt);
    const prepared = lost.prepared!; expect(prepared.ownerCommandId).toBe(source.reference.commandId);
    expect((await fixture.state()).inventory_procurement_requisitions).toEqual(initial.inventory_procurement_requisitions);
    const retained = await markers(page); expect(retained).toHaveLength(1); expect(retained[0]).toMatchObject({ state: "unknown", id: null, requestId: prepared.requestId });
    expect(Object.keys(retained[0]!)).toHaveLength(7);
    await page.goto("/ai-tasks"); await page.reload();
    const recover = page.getByRole("region", { name: "本人 Agent 操作原请求恢复", exact: true });
    const original = recover.getByRole("article", { name: "原 Agent 操作请求 " + prepared.requestId, exact: true });
    const receipt = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-commands/receipts" && response.request().method() === "GET");
    await original.getByRole("button", { name: "只读取原操作回执", exact: true }).click();
    expect((await receipt).status()).toBe(200); expect(AgentCommandReceiptSchema.parse(await (await receipt).json())).toMatchObject({ id: prepared.id, ownerCommandId: prepared.ownerCommandId });
    await expect.poll(async () => (await markers(page)).find(row => row.requestId === prepared.requestId)).toMatchObject({ state: "known", id: prepared.id });
    await recover.getByRole("region", { name: "已找回的原操作回执", exact: true }).getByRole("button", { name: "核对找回的原操作", exact: true }).click();
    await expect(review(page)).toContainText(source.marker);
    const loseConfirm = async (route: Route) => {
      try { const response = await route.fetch(); expect(response.status()).toBe(200); lost.completed = AgentCommandViewSchema.parse(await response.json()); }
      finally { try { await route.abort("connectionreset"); } finally { lost.confirmSettled = true; } }
    };
    const confirmPath = "**/api/agent-commands/requests/" + prepared.id + "/confirm";
    await page.route(confirmPath, loseConfirm);
    await review(page).getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
    await page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "确认执行这笔原操作", exact: true }).click();
    await expect.poll(() => lost.confirmSettled).toBe(true); expect(lost.completed?.state).toBe("succeeded");
    await expect(review(page)).toContainText("原执行结果未知"); await page.unroute(confirmPath, loseConfirm);
    const committed = await fixture.state(); expect(committed.inventory_procurement_requisitions.count).toBe(initial.inventory_procurement_requisitions.count + 1);
    await page.reload(); await expect(review(page)).toContainText("原业务结果已登记");
    expect(await fixture.state()).toEqual(committed);
    await expect(page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "确认执行这笔原操作", exact: true })).toHaveCount(0);
    await fixture.grant(fixture.originalPermissions.filter(bit => bit !== Permission.ProcurementRead));
    const authority = erpSessionAuthority(await session(page));
    const current = page.waitForResponse(response => response.status() === 200 && new URL(response.url()).pathname === "/api/agent-commands/workspace" &&
      response.request().headers()["x-yummyai-context-authority"] === authority);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await current;
    const unavailable = await readOperation(page, prepared.id); expect(unavailable).toMatchObject({ privateAvailable: false, snapshot: null, confirmationToken: null, canConfirm: false });
    const nativeDenied = await page.request.get("/api/procurement-commands/commands/" + source.reference.commandId); expect(nativeDenied.status()).toBe(403);
    await expect(page.getByRole("region", { name: "完整原业务填写核对", exact: true })).toHaveCount(0);
    expect((await fixture.state()).inventory_procurement_requisitions).toEqual(committed.inventory_procurement_requisitions);
    expect(originalPhysical(await fixture.state())).toEqual(originalPhysical(initial));
    await page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }).getByRole("button", { name: "关闭操作核对", exact: true }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect.poll(async () => (await markers(page)).length).toBe(0);
    evidence.ids = { id: prepared.id, requestId: prepared.requestId, ownerCommandId: prepared.ownerCommandId };
    evidence.receiptRecovered = true; evidence.adoptSettled = lost.adoptSettled; evidence.confirmSettled = lost.confirmSettled;
    evidence.singleOriginalBusinessResult = true; evidence.privateHiddenAfterAuthorityLoss = true;
  });
});
