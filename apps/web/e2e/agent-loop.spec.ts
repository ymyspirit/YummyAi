import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type Request as BrowserRequest, type TestInfo } from "@playwright/test";
import { AGENT_LOOP_INTENT_PREFIX, AgentLoopIntentSchema, AgentLoopReceiptSchema, AgentLoopRunViewSchema, AgentLoopWorkspaceSchema,
  CreateAgentLoopSchema, type AgentLoopRunView } from "@yummyai/contracts/ai/agent-loop";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { agentLoopBrowserFixture, requireAgentLoopBrowser } from "./agent-loop-fixture";
import { actors, loginErp } from "./erp-identity-fixture";

requireAgentLoopBrowser(); test.setTimeout(240_000);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const region = (page: Page) => page.getByRole("region", { name: "有界 Agent 任务", exact: true });
const detail = (page: Page) => page.getByRole("region", { name: "Agent 任务详情", exact: true });
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(value: Promise<T>, label: string, timeout = 30_000) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); const value = ErpSessionViewSchema.parse(await response.json());
  expect({ tenantId: value.tenantId, userId: value.userId }).toEqual({ tenantId: actors().operator.tenantId, userId: actors().operator.userId }); return value;
}
async function originalRun(page: Page, id: string) {
  const authority = erpSessionAuthority(await session(page));
  const response = await page.request.get("/api/agent-loops/runs/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); return AgentLoopRunViewSchema.parse(await response.json());
}
async function markers(page: Page) {
  const saved = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => sessionStorage.getItem(key)), AGENT_LOOP_INTENT_PREFIX);
  return saved.map(text => AgentLoopIntentSchema.parse(JSON.parse(text!)));
}
function observe(page: Page) {
  type Read = { path: string; urlHash: string; authorityHash: string | null; startedAt: number; settledAt: number | null; status: number | null;
    code: string | null; failed: string | null; done: ReturnType<typeof latch> };
  const reads: Read[] = [], byRequest = new Map<BrowserRequest, Read>(), errorBodies = new Set<Promise<void>>();
  const posts: Array<{ requestId: string; requestChecksum: string }> = [], lost: Array<{ urlHash: string; at: number; committed: 201 }> = [];
  const consoleErrors: Array<{ path: string; urlHash: string; at: number; status: number | null; abort: boolean }> = [], pageErrors: string[] = [];
  const transitions: Array<{ from: string; to: string; begin: number; end: number | null }> = [];
  page.on("request", request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith("/api/")) return;
    if (url.pathname === "/api/agent-loops/runs" && request.method() === "POST") {
      const input = CreateAgentLoopSchema.parse(request.postDataJSON()); posts.push({ requestId: input.requestId, requestChecksum: sha(canonicalJson(input)) });
    }
    const authority = request.headers()["x-yummyai-context-authority"], row: Read = { path: url.pathname, urlHash: sha(request.url()), authorityHash: authority ? sha(authority) : null,
      startedAt: Date.now(), settledAt: null, status: null, code: null, failed: null, done: latch() };
    reads.push(row); byRequest.set(request, row);
  });
  page.on("response", response => {
    const row = byRequest.get(response.request()); if (!row) return; row.status = response.status(); if (response.status() < 400) return;
    const pending = (async () => { try {
      const bytes = await response.body(); if (bytes.byteLength > 8192) return;
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value.code)) row.code = value.code;
    } catch { /* A missing body cannot authenticate a code-specific exception. */ } })();
    errorBodies.add(pending); void pending.then(() => errorBodies.delete(pending));
  });
  const settle = (request: BrowserRequest, failed: string | null) => { const row = byRequest.get(request); if (!row) return; row.failed = failed; row.settledAt = Date.now(); row.done.resolve(); };
  page.on("requestfinished", request => settle(request, null)); page.on("requestfailed", request => settle(request, request.failure()?.errorText ?? "unknown"));
  page.on("pageerror", () => pageErrors.push("unexpected_page_error"));
  page.on("console", message => {
    if (message.type() !== "error") return; let path = "", urlHash = "";
    try { const url = new URL(message.location().url); path = url.pathname; urlHash = sha(url.href); } catch { /* Unlocated errors are not waived. */ }
    const status = /\b(4\d\d|5\d\d)\b/.exec(message.text());
    consoleErrors.push({ path, urlHash, at: Date.now(), status: status ? Number(status[1]) : null, abort: /net::ERR_(FAILED|ABORTED)/.test(message.text()) });
  });
  async function drain() {
    const end = Date.now() + 20_000;
    for (;;) {
      const count = reads.length;
      await bounded(Promise.all(reads.filter(row => row.settledAt === null).map(row => row.done.promise)), "agent_loop_http_settlement_timeout", Math.max(1, end - Date.now()));
      await bounded(Promise.all([...errorBodies]), "agent_loop_error_body_timeout", Math.max(1, end - Date.now()));
      if (count === reads.length && reads.every(row => row.settledAt !== null)) return;
    }
  }
  return { posts, lost, transitions, recordLost(url: string) { lost.push({ urlHash: sha(url), at: Date.now(), committed: 201 }); },
    begin(from: string, to: string) { transitions.push({ from: sha(from), to: sha(to), begin: Date.now(), end: null }); },
    async end() { await drain(); const transition = transitions.at(-1); if (transition) transition.end = Date.now(); },
    async check() {
      await drain(); expect(pageErrors).toEqual([]);
      const unexpected = consoleErrors.filter(error => {
        const same = reads.filter(row => row.urlHash === error.urlHash && Math.abs((row.settledAt ?? Date.now()) - error.at) < 5000);
        if (error.path === "/api/agent-loops/runs" && error.abort && lost.some(row => row.urlHash === error.urlHash && Math.abs(row.at - error.at) < 5000) && posts.length === 1) return false;
        const transition = transitions.find(row => row.from !== row.to && error.at >= row.begin && (!row.end || error.at <= row.end));
        if (transition && ["/api/agent-loops/workspace", "/api/ai-assists/task-workspace", "/api/ai-assists/task-target-pages", "/api/agent-reads/workspace"].includes(error.path) &&
          same.some(row => row.authorityHash === transition.from && (error.status === 409 && row.status === 409 && row.code === "authority_changed" || error.abort && row.failed?.includes("ERR_ABORTED")))) return false;
        if (transition && /^\/api\/agent-loops\/runs\/[a-f0-9-]{36}$/.test(error.path) && same.some(row => row.authorityHash === transition.from || row.authorityHash === transition.to) &&
          same.some(row => error.status === 403 && row.status === 403 || error.status === 409 && row.status === 409 && row.code === "authority_changed")) return false;
        return true;
      });
      expect(unexpected).toEqual([]);
      return { posts, lost, transitions, console: consoleErrors, pageErrors, reads: reads.map(({ done: _done, ...row }) => { void _done; return row; }) };
    },
  };
}
async function screenshot(page: Page, info: TestInfo, name: string, target: Locator) {
  await target.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await target.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const file = info.outputPath(name + ".png"); await page.screenshot({ path: file, fullPage: false }); return file;
}
async function finish(page: Page, info: TestInfo, fixture: Awaited<ReturnType<typeof agentLoopBrowserFixture>>, seen: ReturnType<typeof observe>, proof: Record<string, unknown>, failure: unknown) {
  const failures: unknown[] = [];
  try { proof.browser = await seen.check(); } catch (error) { failures.push(error); }
  try { await page.unrouteAll({ behavior: "wait" }); } catch (error) { failures.push(error); }
  try { await page.close(); } catch (error) { failures.push(error); }
  try { await fixture.close(); } catch (error) { failures.push(error); }
  proof.testBodyCompleted = failure === undefined; proof.cleanupFailureCount = failures.length;
  try { const path = info.outputPath("agent-loop-proof.json"); await writeFile(path, JSON.stringify(proof, null, 2) + "\n"); await info.attach("agent-loop-proof", { path, contentType: "application/json" }); }
  catch (error) { failures.push(error); }
  if (failure !== undefined || failures.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...failures], "agent_loop_browser_or_cleanup_failed");
}
async function ready(page: Page, fixture: Awaited<ReturnType<typeof agentLoopBrowserFixture>>) {
  await loginErp(page, "operator", "/ai-tasks"); await session(page);
  await expect(region(page).getByRole("combobox", { name: /^Agent 执行模型/ }).locator('option[value="' + fixture.model.modelId + '"]')).toHaveCount(1);
}
async function fill(page: Page, fixture: Awaited<ReturnType<typeof agentLoopBrowserFixture>>, goal: string, both: boolean) {
  const form = region(page).getByRole("form", { name: "新建有界 Agent 任务", exact: true });
  await form.getByLabel("Agent 任务目标", { exact: true }).fill(goal);
  await form.getByRole("combobox", { name: /^Agent 执行模型/ }).selectOption(fixture.model.modelId);
  await form.getByLabel("费用上限 USD", { exact: true }).fill("1.000000");
  await form.getByRole("combobox", { name: /^原记录数上限/ }).selectOption("500");
  if (both) await form.getByRole("checkbox", { name: /^订单异常/ }).check();
  await form.getByRole("checkbox", { name: /^库存余额/ }).check(); return form;
}
async function refresh(page: Page, id: string) {
  const result = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/agent-loops/runs/" + id && response.status() === 200);
  await detail(page).getByRole("button", { name: "重新读取原 Agent 任务", exact: true }).click(); return AgentLoopRunViewSchema.parse(await (await result).json());
}

test("real personal bounded Agent reads both owners, completes all pages and presents original claims and costs at desktop and narrow widths", async ({ page }, info) => {
  const fixture = await agentLoopBrowserFixture("evidence"), seen = observe(page), proof: Record<string, unknown> = { operation: "68018aa3", flow: "two-original-owner-evidence" }; let failure: unknown;
  try {
    const source = await fixture.seed(105), before = await fixture.businessState(); proof.businessBefore = before;
    await ready(page, fixture); const form = await fill(page, fixture, "Synthetic bounded source verification for both original ERP tools", true);
    const created = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent-loops/runs");
    await form.getByRole("button", { name: "登记并启动有界 Agent 任务", exact: true }).click(); const response = await created; expect(response.status()).toBe(201);
    const original = AgentLoopRunViewSchema.parse(await response.json()); proof.runId = original.id; proof.requestId = original.requestId;
    expect(original.status).toBe("queued"); expect(seen.posts).toHaveLength(1); expect(original.allowedTools).toEqual(["orders.exceptions.page", "inventory.balances.page"]);
    proof.execution = await fixture.execute(original.id, { bothTools: true }); const worker = await fixture.wait(); expect(worker).toMatchObject({ modelCalls: 3, readCalls: 5, settled: true, failure: null }); proof.worker = worker;
    const current = await refresh(page, original.id);
    expect(current).toMatchObject({ status: "completed", observedRows: 106, toolCalls: 5, verification: "field_values_and_collection_versions",
      cost: { knownCostUsd: "0.000630", reservedUsd: "0.000000", coverage: "known", modelTurns: 3 } });
    expect(current.collections.map(row => [row.tool, row.readCount, row.total, row.complete])).toEqual([["orders.exceptions.page", 1, 1, true], ["inventory.balances.page", 105, 105, true]]);
    expect(current.collections[0]!.rows[0]!.sourceId).toBe(source.exceptionId); expect(new Set(current.collections[1]!.rows.map(row => row.sourceId)).size).toBe(105);
    expect(current.result?.claims.find(row => row.field === "physicalQuantity")?.value).toBe("1.000000001"); expect(current.result?.claims.find(row => row.field === "unit")?.value).toBe("meter");
    await expect(detail(page).getByRole("region", { name: "Agent 核对结果", exact: true })).toContainText("已核对所引字段值与原集合版本");
    const inventory = detail(page).getByRole("region", { name: /^库存余额原集合 / }); await expect(inventory).toContainText("已读取 105 / 105");
    await inventory.getByText("查看已保存的 105 条来源与校验值", { exact: true }).click(); await expect(inventory).toContainText("显示 1–25 / 已保存 105");
    await inventory.getByRole("button", { name: "下一段原记录", exact: true }).click(); await expect(inventory).toContainText("显示 26–50 / 已保存 105");
    expect((await fixture.progress()).readCalls).toBe(5);
    await page.setViewportSize({ width: 1440, height: 1000 }); proof.desktop = await screenshot(page, info, "agent-loop-desktop", detail(page));
    await page.setViewportSize({ width: 390, height: 900 }); proof.narrow = await screenshot(page, info, "agent-loop-narrow", detail(page));
    await page.reload(); await expect(detail(page).getByRole("region", { name: "Agent 核对结果", exact: true })).toContainText("已核对所引字段值与原集合版本");
    expect(await fixture.businessState()).toEqual(before); proof.businessAfter = await fixture.businessState(); proof.state = await fixture.loopState(original.requestId);
    expect((proof.state as Awaited<ReturnType<typeof fixture.loopState>>).budgets).toHaveLength(1);
    expect(seen.posts).toHaveLength(1); expect((await fixture.progress()).modelCalls).toBe(3);
  } catch (error) { failure = error; }
  await finish(page, info, fixture, seen, proof, failure);
});

test("lost original201 survives refresh without resubmission and original owner can stop an in-flight model after domain read revocation", async ({ page }, info) => {
  const fixture = await agentLoopBrowserFixture("recovery-stop"), seen = observe(page), proof: Record<string, unknown> = { operation: "68018aa3", flow: "lost-original201-pure-id-stop" }; let failure: unknown;
  const lost = latch(); let committed: AgentLoopRunView | undefined;
  try {
    await fixture.seed(1); const before = await fixture.businessState(); proof.businessBefore = before;
    await ready(page, fixture);
    await page.route("**/api/agent-loops/runs", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const actual = await route.fetch(); expect(actual.status()).toBe(201); committed = AgentLoopRunViewSchema.parse(await actual.json());
      seen.recordLost(route.request().url()); await route.abort("failed"); lost.resolve();
    });
    const form = await fill(page, fixture, "Synthetic original private Agent goal must not enter saved intent", false);
    await form.getByRole("button", { name: "登记并启动有界 Agent 任务", exact: true }).click(); await bounded(lost.promise, "Original201 was not committed before response loss");
    await expect.poll(async () => (await markers(page)).map(row => row.state)).toEqual(["unknown"]);
    if (!committed) throw new Error("Original committed Agent run unavailable"); const original = committed;
    const marker = (await markers(page))[0]!; expect(marker).toMatchObject({ requestId: original.requestId, requestChecksum: original.requestChecksum, runId: null, state: "unknown" });
    expect(Object.keys(marker).sort()).toEqual(["version", "ownerScope", "requestId", "requestChecksum", "runId", "state", "createdAt"].sort());
    expect(JSON.stringify(marker)).not.toContain(original.goal); proof.runId = original.id; proof.requestId = original.requestId;
    await page.unroute("**/api/agent-loops/runs"); await page.reload(); await expect(region(page).getByRole("article", { name: "原 Agent 请求 " + original.requestId, exact: true })).toBeVisible();
    const savedBefore = await fixture.loopState(original.requestId); expect(savedBefore.runs).toHaveLength(1); expect(savedBefore.budgets).toHaveLength(1); expect(seen.posts).toHaveLength(1);
    const recovered = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/agent-loops/receipts");
    await region(page).getByRole("article", { name: "原 Agent 请求 " + original.requestId, exact: true }).getByRole("button", { name: "只读取原请求回执", exact: true }).click();
    const actual = await recovered; expect(actual.status()).toBe(200); expect(AgentLoopReceiptSchema.parse(await actual.json())).toMatchObject({ disposition: "known", runId: original.id, requestChecksum: original.requestChecksum });
    await expect.poll(async () => (await markers(page)).map(({ state, runId, requestId }) => ({ state, runId, requestId }))).toEqual([{ state: "known", runId: original.id, requestId: original.requestId }]);
    expect(await fixture.loopState(original.requestId)).toEqual(savedBefore); expect(seen.posts).toHaveLength(1);
    proof.execution = await fixture.execute(original.id, { holdFirstModel: true });
    await expect.poll(() => fixture.progress()).toMatchObject({ modelCalls: 1, modelGateEntered: true, settled: false });
    const oldAuthority = erpSessionAuthority(await session(page)); await fixture.inventorySelf(); const narrowed = await session(page), authority = erpSessionAuthority(narrowed);
    expect(narrowed.permissionScopes?.["inventory:read"]).toBe("self"); expect(authority).not.toBe(oldAuthority); seen.begin(oldAuthority, authority);
    const currentWorkspace = page.waitForResponse(response => response.status() === 200 && new URL(response.url()).pathname === "/api/agent-loops/workspace" && response.request().headers()["x-yummyai-context-authority"] === authority);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); expect(AgentLoopWorkspaceSchema.parse(await (await currentWorkspace).json()).contextAuthority).toBe(authority);
    await expect(region(page).getByText("Synthetic original private Agent goal must not enter saved intent", { exact: true })).toHaveCount(0);
    const denied = await page.request.get("/api/agent-loops/runs/" + original.id, { headers: { "x-yummyai-context-authority": authority } }); expect(denied.status()).toBe(403);
    const stopResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent-loops/runs/" + original.id + "/stop");
    await region(page).getByRole("article", { name: "原 Agent 请求 " + original.requestId, exact: true }).getByRole("button", { name: "停止后续步骤", exact: true }).click();
    const stop = await stopResponse; expect(stop.status()).toBe(200); expect(AgentLoopReceiptSchema.parse(await stop.json())).toMatchObject({ runId: original.id, status: "stopping", privateAvailable: false });
    await fixture.release(); const finished = await fixture.wait(); expect(finished).toMatchObject({ modelCalls: 1, readCalls: 0, settled: true, failure: null }); proof.worker = finished;
    await seen.end(); await fixture.restore(); const restoredAuthority = erpSessionAuthority(await session(page)); seen.begin(authority, restoredAuthority);
    const restored = page.waitForResponse(response => response.status() === 200 && new URL(response.url()).pathname === "/api/agent-loops/workspace" && response.request().headers()["x-yummyai-context-authority"] === restoredAuthority);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await restored; await seen.end();
    const stopped = await originalRun(page, original.id); expect(stopped).toMatchObject({ status: "stopped", result: null, collections: [], verification: "not_adopted",
      cost: { modelTurns: 1, knownCostUsd: "0.000210", reservedUsd: "0.000000", coverage: "known" } });
    const state = await fixture.loopState(original.requestId); expect(state.runs).toHaveLength(1); expect(state.budgets).toMatchObject([{ state: "committed", amountUsd: "0.000210" }]);
    expect(state.audits).toEqual([{ action: "agent.loop.create", count: 1 }, { action: "agent.loop.stop", count: 1 }]);
    proof.originalState = state; await fixture.execute(original.id); await fixture.wait(); expect((await fixture.progress()).modelCalls).toBe(1);
    expect(await fixture.loopState(original.requestId)).toEqual(state); expect(seen.posts).toHaveLength(1);
    expect(await fixture.businessState()).toEqual(before); proof.businessAfter = await fixture.businessState();
  } catch (error) { failure = error; }
  await finish(page, info, fixture, seen, proof, failure);
});
