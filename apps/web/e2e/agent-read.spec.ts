import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type Request as BrowserRequest, type Route, type TestInfo } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { erpSessionAuthority, ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { AgentReadCallSchema, AgentReadPageViewSchema, AgentReadWorkspaceSchema, type AgentReadPageView, type AgentReadToolKey } from "@yummyai/contracts/ai/agent-read";
import { AssistViewSchema, CreateAssistSchema, type AssistView } from "@yummyai/contracts/ai/assist";
import { ASSIST_INTENT_PREFIX, AssistIntentSchema, AssistReceiptViewSchema, assistRequestRecoveryText, type AssistIntent } from "@yummyai/contracts/ai/assist-recovery";
import { KnowledgeWorkspaceSchema } from "@yummyai/contracts/knowledge";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import { actors, loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";

requireAgentReadBrowser();
test.setTimeout(240_000);
const tools = (page: Page) => page.getByRole("region", { name: "Agent 只读工具", exact: true });
const toolResult = (page: Page, name: "订单异常" | "库存余额") => tools(page).getByRole("region", { name: name + "读取结果", exact: true });
const recovery = (page: Page) => page.getByRole("region", { name: "本人 AI 原请求恢复", exact: true }).first();
const requestRow = (page: Page, requestId: string) => recovery(page).getByRole("article", { name: "原 AI 请求 " + requestId, exact: true });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, code: string, milliseconds = 30_000) {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function observe(page: Page, options: { authorityChangeWorkspaces?: boolean } = {}) {
  const posts: string[] = [], pageErrors: string[] = [], consoleErrors: { path: string; at: number; requestKey?: string;
    kind: "abort" | "collection_conflict" | "late_cancelled" | "expected_denial" | "authority_candidate" | "expected_authority_changed" |
      "restore_candidate" | "expected_restore_authority_changed" | "unexpected" }[] = [];
  const denials: { path: string; status: number; at: number }[] = []; let denialPath: string | null = null, denialStartedAt = 0;
  const authorityResponses: { requestId: number | null; path: string; requestKey: string; method: string; status: number; code: string | null;
    at: number; requestAuthorityHash: string | null; responseHeadersHash: string; verified: boolean }[] = [];
  type WorkspaceRequest = { id: number; path: string; requestKey: string; startedAt: number; requestAuthorityHash: string | null; headersHash: string;
    responseAt: number | null; status: number | null; code: string | null; responseHeadersHash: string | null;
    settlement: "pending" | "finished" | "failed"; settledAt: number | null; barrier: boolean; restoreBarrier: boolean };
  const authorityRequests: WorkspaceRequest[] = [], tracked = new Map<BrowserRequest, { row: WorkspaceRequest; done: ReturnType<typeof latch> }>();
  const authorityWindow = { startedAt: 0, endedAt: 0, originalAuthorityHash: null as string | null, currentAuthorityHash: null as string | null,
    barrierStartedAt: 0, barrierCompletedAt: 0, consoleDrainedAt: 0, failureCode: null as string | null };
  const restorationWindow = { startedAt: 0, endedAt: 0, restoredAuthorityHash: null as string | null, failureCode: null as string | null };
  const restorationResponses: typeof authorityResponses = [];
  const pendingResponses = new Set<Promise<void>>();
  const workspaceKey = (url: URL) => url.pathname === "/api/agent-reads/workspace" && !url.search ? url.pathname :
    url.pathname === "/api/ai-assists/task-workspace" && url.searchParams.size === 1 && url.searchParams.get("page") === "1" ? url.pathname + "?page=1" : null;
  const inAuthorityWindow = (at: number) => options.authorityChangeWorkspaces === true && authorityWindow.startedAt > 0 &&
    at >= authorityWindow.startedAt && (!authorityWindow.endedAt || at <= authorityWindow.endedAt);
  const inRestorationWindow = (at: number) => options.authorityChangeWorkspaces === true && restorationWindow.startedAt > 0 &&
    at >= restorationWindow.startedAt && (!restorationWindow.endedAt || at <= restorationWindow.endedAt);
  const observedKey = (url: URL) => workspaceKey(url) ?? (denialPath === url.pathname && !url.search ? url.pathname : null);
  const remaining = (deadline: number) => Math.max(1, deadline - Date.now());
  async function drainResponses(deadline = Date.now() + 10_000) {
    while (pendingResponses.size) {
      if (Date.now() >= deadline) throw new Error("authority_response_body_check_timeout");
      await bounded(Promise.all([...pendingResponses]), "authority_response_body_check_timeout", remaining(deadline));
    }
  }
  async function settleRequests(select: (row: WorkspaceRequest) => boolean, deadline: number) {
    for (;;) {
      if (Date.now() >= deadline) throw new Error("authority_workspace_settlement_timeout");
      const count = authorityRequests.filter(select).length;
      await bounded(Promise.all([...tracked.values()].filter(entry => select(entry.row)).map(entry => entry.done.promise)),
        "authority_workspace_settlement_timeout", remaining(deadline));
      await drainResponses(deadline);
      try { await bounded(page.evaluate(() => new Promise<void>(resolve => queueMicrotask(resolve))), "authority_console_drain_timeout", remaining(deadline)); }
      catch (error) {
        if (!(error instanceof Error) || !/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
        await page.waitForLoadState("domcontentloaded", { timeout: remaining(deadline) }); continue;
      }
      await drainResponses(deadline);
      if (count === authorityRequests.filter(select).length && !authorityRequests.some(row => select(row) && row.settlement === "pending")) return;
    }
  }
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/ai-assists/runs") posts.push(request.method());
    const requestKey = observedKey(url);
    if (!options.authorityChangeWorkspaces || request.method() !== "GET" || !requestKey) return;
    const headers = request.headers(), incoming = headers["x-yummyai-context-authority"], startedAt = Date.now();
    const row: WorkspaceRequest = { id: authorityRequests.length + 1, path: url.pathname, requestKey, startedAt,
      requestAuthorityHash: incoming ? sha(incoming) : null, headersHash: sha(JSON.stringify({ authority: incoming ?? null, accept: headers.accept ?? null })),
      responseAt: null, status: null, code: null, responseHeadersHash: null, settlement: "pending", settledAt: null,
      barrier: workspaceKey(url) !== null && inAuthorityWindow(startedAt), restoreBarrier: inRestorationWindow(startedAt) };
    authorityRequests.push(row); tracked.set(request, { row, done: latch() });
  });
  function settled(request: BrowserRequest, settlement: "finished" | "failed") {
    const entry = tracked.get(request); if (!entry) return;
    entry.row.settlement = settlement; entry.row.settledAt = Date.now(); entry.done.resolve();
  }
  page.on("requestfinished", request => settled(request, "finished"));
  page.on("requestfailed", request => settled(request, "failed"));
  page.on("response", response => {
    const url = new URL(response.url()), path = url.pathname, at = Date.now();
    if (denialPath === path && response.status() === 403 && at >= denialStartedAt) denials.push({ path, status: 403, at });
    const requestKey = observedKey(url);
    if (!options.authorityChangeWorkspaces || !requestKey || response.request().method() !== "GET") return;
    const entry = tracked.get(response.request()), headers = response.headers();
    const responseHeadersHash = sha(JSON.stringify({ contentType: headers["content-type"] ?? null, cacheControl: headers["cache-control"] ?? null,
      authority: headers["x-yummyai-context-authority"] ?? null }));
    if (entry) { entry.row.responseAt = at; entry.row.status = response.status(); entry.row.responseHeadersHash = responseHeadersHash; }
    const observed = { requestId: entry?.row.id ?? null, path, requestKey, method: response.request().method(), status: response.status(), code: null as string | null,
      at, requestAuthorityHash: entry?.row.requestAuthorityHash ?? null, responseHeadersHash, verified: false };
    if (response.status() < 400) return;
    if (workspaceKey(url) && inAuthorityWindow(at)) authorityResponses.push(observed);
    if (inRestorationWindow(at)) restorationResponses.push(observed);
    const check = (async () => {
      try {
        const body = await response.body(); if (body.byteLength > 8192) return;
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        if (parsed && typeof parsed === "object" && "code" in parsed && typeof parsed.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(parsed.code)) {
          observed.code = parsed.code; if (entry) entry.row.code = parsed.code;
        }
      } catch { /* An unavailable or invalid body never authenticates an expected authority error. */ }
    })();
    pendingResponses.add(check); void check.then(() => { pendingResponses.delete(check); });
  });
  page.on("pageerror", () => pageErrors.push("unexpected_page_error"));
  page.on("console", message => {
    if (message.type() !== "error") return;
    let path = "", requestKey: string | null = null;
    try { const url = new URL(message.location().url); path = url.pathname; requestKey = observedKey(url); } catch { /* Unknown console locations are failures. */ }
    const at = Date.now(), text = message.text(), kind = path === "/api/ai-assists/runs" && /net::ERR_FAILED/.test(text) ? "abort" :
      path === "/api/agent-reads/call" && /\b409\b/.test(text) ? "collection_conflict" :
        path === "/api/agent-reads/call" && /net::ERR_ABORTED/.test(text) ? "late_cancelled" :
          path === denialPath && at >= denialStartedAt && (!restorationWindow.startedAt || at < restorationWindow.startedAt) && /\b403\b/.test(text) ? "expected_denial" :
            requestKey && inRestorationWindow(at) && /\b409\b/.test(text) ? "restore_candidate" :
              requestKey && inAuthorityWindow(at) && /\b409\b/.test(text) ? "authority_candidate" : "unexpected";
    consoleErrors.push({ path, at, kind, ...(options.authorityChangeWorkspaces && requestKey ? { requestKey } : {}) });
  });
  return { posts, pageErrors, consoleErrors, denials, authorityRequests, authorityResponses, authorityWindow, restorationResponses, restorationWindow, drainResponses,
    prepareAuthorityChange(value: string) { authorityWindow.originalAuthorityHash = sha(value); },
    beginDenial(path: string) {
      denialPath = path; denialStartedAt = Date.now();
      if (options.authorityChangeWorkspaces) {
        authorityWindow.startedAt = denialStartedAt;
        for (const row of authorityRequests) if (row.settlement === "pending" && row.path !== denialPath) row.barrier = true;
      }
      return denialStartedAt;
    },
    currentAuthority(value: string) { authorityWindow.currentAuthorityHash = sha(value); },
    async endAuthorityWindow() {
      if (!authorityWindow.startedAt || authorityWindow.endedAt) return;
      authorityWindow.barrierStartedAt = Date.now(); const deadline = authorityWindow.barrierStartedAt + 10_000;
      try {
        await settleRequests(row => row.barrier, deadline);
        authorityWindow.consoleDrainedAt = Date.now(); authorityWindow.barrierCompletedAt = Date.now();
      } catch (error) { authorityWindow.failureCode = "authority_workspace_settlement_failed"; throw error; }
      finally { authorityWindow.endedAt = Date.now(); }
      for (const response of authorityResponses) response.verified = response.method === "GET" && response.status === 409 && response.code === "authority_changed" &&
        response.at >= authorityWindow.startedAt && response.at <= authorityWindow.endedAt && response.requestAuthorityHash !== null &&
        response.requestAuthorityHash === authorityWindow.originalAuthorityHash && authorityWindow.currentAuthorityHash !== null &&
        response.requestAuthorityHash !== authorityWindow.currentAuthorityHash &&
        authorityRequests.some(row => row.id === response.requestId && row.barrier && row.settlement === "finished" && row.settledAt !== null && row.settledAt <= authorityWindow.endedAt);
      for (const entry of consoleErrors) if (entry.kind === "authority_candidate" && entry.at >= authorityWindow.startedAt && entry.at <= authorityWindow.endedAt &&
        authorityResponses.some(response => response.verified && response.path === entry.path && response.requestKey === entry.requestKey && Math.abs(response.at - entry.at) <= 2000))
        entry.kind = "expected_authority_changed";
    },
    beginRestoration() {
      restorationWindow.startedAt = Date.now();
      for (const row of authorityRequests) if (row.settlement === "pending") row.restoreBarrier = true;
      return restorationWindow.startedAt;
    },
    restoredAuthority(value: string) { restorationWindow.restoredAuthorityHash = sha(value); },
    async endRestorationWindow() {
      if (!restorationWindow.startedAt || restorationWindow.endedAt) return;
      try { await settleRequests(row => row.restoreBarrier, Date.now() + 10_000); }
      catch (error) { restorationWindow.failureCode = "authority_restoration_settlement_failed"; throw error; }
      finally { restorationWindow.endedAt = Date.now(); }
      for (const response of restorationResponses) response.verified = response.method === "GET" && response.status === 409 && response.code === "authority_changed" &&
        response.at >= restorationWindow.startedAt && response.at <= restorationWindow.endedAt && response.requestAuthorityHash !== null &&
        response.requestAuthorityHash === authorityWindow.currentAuthorityHash && restorationWindow.restoredAuthorityHash === authorityWindow.originalAuthorityHash &&
        authorityRequests.some(row => row.id === response.requestId && row.restoreBarrier && row.settlement === "finished" && row.settledAt !== null && row.settledAt <= restorationWindow.endedAt);
      for (const entry of consoleErrors) if (entry.kind === "restore_candidate" && entry.at >= restorationWindow.startedAt && entry.at <= restorationWindow.endedAt &&
        restorationResponses.some(response => response.verified && response.path === entry.path && response.requestKey === entry.requestKey && Math.abs(response.at - entry.at) <= 2000))
        entry.kind = "expected_restore_authority_changed";
    },
  };
}
async function current(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  return ErpSessionViewSchema.parse(await response.json());
}
async function assertOperator(page: Page) {
  const session = await current(page), actor = actors().operator;
  expect({ tenantId: session.tenantId, userId: session.userId }).toEqual({ tenantId: actor.tenantId, userId: actor.userId }); return session;
}
async function readToolPage(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === "/api/agent-reads/call");
  await action(); const actual = await response; expect(actual.status()).toBe(200);
  const parsed = AgentReadPageViewSchema.safeParse(await actual.json());
  if (!parsed.success) throw new Error("Synthetic Agent read response failed its exact contract");
  expect(actual.headers()["cache-control"]).toContain("no-store"); return parsed.data;
}
async function completeCollection(page: Page, tool: AgentReadToolKey, name: "订单异常" | "库存余额") {
  const pages: AgentReadPageView[] = [];
  let next = await readToolPage(page, () => tools(page).getByRole("button", { name: "读取" + name, exact: true }).click());
  for (let pageNumber = 0; ; pageNumber++) {
    expect(next.tool).toBe(tool); expect(next.items.length).toBeLessThanOrEqual(25); pages.push(next);
    expect(next.readCount).toBe(pages.reduce((count, row) => count + row.items.length, 0));
    expect(next.collectionFingerprint).toBe(pages[0]!.collectionFingerprint);
    await expect(toolResult(page, name)).toContainText(`已读取 ${next.readCount} / ${next.total}`);
    if (next.complete) { expect(next.readCount).toBe(next.total); expect(next.nextCursor).toBeNull(); break; }
    expect(next.nextCursor).not.toBeNull(); expect(pageNumber).toBeLessThan(99);
    await expect(toolResult(page, name)).toContainText("尚未完整读取");
    next = await readToolPage(page, () => toolResult(page, name).getByRole("button", { name: "下一页", exact: true }).click());
  }
  await expect(toolResult(page, name)).toContainText("已完整读取该集合");
  const ids = pages.flatMap(row => row.items.map(item => item.id)); expect(new Set(ids).size).toBe(ids.length);
  return pages;
}
async function noOverflow(page: Page, region: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  for (const element of await region.locator("form, dl, li").all())
    if (await element.isVisible()) expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
async function screenshot(page: Page, info: TestInfo, name: string, region: Locator) {
  await region.scrollIntoViewIfNeeded(); await noOverflow(page, region);
  const path = info.outputPath(name + ".png"); await page.screenshot({ path, fullPage: false }); return path;
}
async function cleanup(steps: (() => Promise<unknown>)[]) {
  const failures: unknown[] = [];
  for (const step of steps) { try { await step(); } catch (error) { failures.push(error); } }
  return failures;
}
function finish(failure: unknown, failures: unknown[]) {
  if (failure !== undefined || failures.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...failures], "agent_browser_test_or_cleanup_failed");
}

test("personal Agent tools read every real owner page, reject changed collections and hide a late inventory reply after scope narrows", async ({ page }, info) => {
  const seen = observe(page), fixture = await agentReadBrowserFixture("tools");
  const evidence: Record<string, unknown> = { nonce: fixture.nonce, syntheticOwnerSources: true, modelInvoked: false,
    cleanupOwner: "Fixture restores original roles and drains its owner child/database. Outer disposable runner removes all tracked nonce facts and resources." };
  const screenshots: string[] = [];
  let failure: unknown; const failures: unknown[] = [];
  let releaseLate: (() => void) | undefined, lateDone: Promise<void> | undefined, lateHandler: ((route: Route) => Promise<void>) | undefined;
  try {
    const seed = await fixture.seed(); evidence.fixtureIds = { orderId: seed.orderId, exceptionIds: seed.exceptionIds,
      stockItemId: seed.stockItemId, warehouseId: seed.warehouseId, locationIds: seed.locationIds };
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/ai-tasks"); await assertOperator(page);
    await expect(page.getByRole("heading", { name: "AI 任务工作台", exact: true })).toBeVisible();
    await expect(tools(page)).toBeVisible(); await expect(tools(page)).toContainText("MCP 尚未连接");
    const workspaceResponse = await page.request.get("/api/agent-reads/workspace", { headers: { "x-yummyai-context-authority": erpSessionAuthority(await current(page)) } });
    expect(workspaceResponse.status()).toBe(200); const workspace = AgentReadWorkspaceSchema.parse(await workspaceResponse.json());
    expect(workspace.tools.map(tool => tool.key).sort()).toEqual(["inventory.balances.page", "orders.exceptions.page"]);
    expect(workspace.tools.every(tool => tool.available && tool.minimumScope === "tenant")).toBe(true); expect(workspace.mcpState).toBe("not_connected");
    evidence.toolKeys = workspace.tools.map(tool => tool.key); evidence.executionContractChecksum = workspace.executionContract.checksum;

    await tools(page).getByRole("navigation", { name: "选择只读工具", exact: true }).getByRole("button", { name: "订单异常", exact: true }).click();
    await tools(page).getByLabel("原订单 ID 可留空", { exact: true }).fill(seed.orderId);
    await expect(tools(page).getByRole("button", { name: "读取订单异常", exact: true })).toBeEnabled();
    const exceptionPages = await completeCollection(page, "orders.exceptions.page", "订单异常");
    const exceptions = exceptionPages.flatMap(row => row.tool === "orders.exceptions.page" ? row.items : []);
    expect(exceptionPages.length).toBeGreaterThan(1); expect(exceptions.map(row => row.id)).toEqual(expect.arrayContaining(seed.exceptionIds));
    expect(exceptions.every(row => row.orderId === seed.orderId)).toBe(true);
    expect(JSON.stringify(exceptions)).not.toContain("SYNTHETIC_AGENT_PRIVATE_CODE");
    expect(JSON.stringify(exceptions)).not.toContain("Synthetic private exception text");
    evidence.exceptionTotal = exceptions.length; evidence.exceptionPageCount = exceptionPages.length;

    await tools(page).getByRole("navigation", { name: "选择只读工具", exact: true }).getByRole("button", { name: "库存余额", exact: true }).click();
    await tools(page).getByLabel("原库存货品 ID 可留空", { exact: true }).fill(seed.stockItemId);
    const balancePages = await completeCollection(page, "inventory.balances.page", "库存余额");
    const balances = balancePages.flatMap(row => row.tool === "inventory.balances.page" ? row.items : []);
    expect(balances).toHaveLength(27); expect(balancePages).toHaveLength(2);
    expect(balances.map(row => row.dimensionKey)).toEqual([...balances.map(row => row.dimensionKey)].sort());
    expect(balances.map(row => ({ locationId: row.locationId, physicalQuantity: row.physicalQuantity, reservedQuantity: row.reservedQuantity,
      availableQuantity: row.availableQuantity })).sort((a, b) => a.locationId.localeCompare(b.locationId)))
      .toEqual([...seed.balances].sort((a, b) => a.locationId.localeCompare(b.locationId)));
    expect(balances.some(row => row.physicalQuantity === 0)).toBe(true);
    expect(balances.some(row => row.reservedQuantity === "0.000000001" && row.availableQuantity === 1)).toBe(true);
    evidence.balanceTotal = balances.length; evidence.balancePageCount = balancePages.length;
    screenshots.push(await screenshot(page, info, "agent-read-complete-desktop", toolResult(page, "库存余额")));

    const first = await readToolPage(page, () => tools(page).getByRole("button", { name: "读取库存余额", exact: true }).click());
    expect(first.complete).toBe(false); await fixture.append();
    const changedResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent-reads/call");
    await toolResult(page, "库存余额").getByRole("button", { name: "下一页", exact: true }).click();
    const changed = await changedResponse; expect(changed.status()).toBe(409);
    const changedBody = await changed.json() as { code?: unknown }; expect(changedBody.code).toBe("agent_collection_changed");
    await expect(toolResult(page, "库存余额")).toHaveCount(0);
    await expect(tools(page).getByRole("alert")).toHaveText("读取期间原集合已变化 已清除旧页 请从第一页重新读取");
    evidence.changedCollectionStatus = 409;
    await page.setViewportSize({ width: 390, height: 844 });
    const refreshed = await completeCollection(page, "inventory.balances.page", "库存余额");
    expect(refreshed[0]!.collectionFingerprint).not.toBe(first.collectionFingerprint);
    screenshots.push(await screenshot(page, info, "agent-read-complete-390", tools(page)));

    const ready = latch(), release = latch(), returned = latch(); releaseLate = release.resolve; lateDone = returned.promise;
    let lateFailure: unknown, heldFingerprint = "";
    lateHandler = async route => {
      try {
        const call = AgentReadCallSchema.parse(route.request().postDataJSON());
        if (call.tool !== "inventory.balances.page") { await route.continue(); return; }
        const response = await route.fetch(); expect(response.status()).toBe(200);
        const held = AgentReadPageViewSchema.parse(await response.json()); heldFingerprint = held.collectionFingerprint; ready.resolve();
        await release.promise;
        try { await route.fulfill({ response }); } catch (error) {
          if (!page.isClosed() && !/Target closed|Request.*(canceled|cancelled|aborted)|Invalid InterceptionId|already handled/i.test(String(error))) throw error;
        }
      } catch (error) { lateFailure = error; ready.resolve(); }
      finally { returned.resolve(); }
    };
    await page.route("**/api/agent-reads/call", lateHandler);
    await tools(page).getByRole("button", { name: "读取库存余额", exact: true }).click(); await bounded(ready.promise, "agent_late_response_not_ready");
    if (lateFailure) throw lateFailure;
    await fixture.inventorySelf();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(async () => (await current(page)).permissionScopes?.[Permission.InventoryRead]).toBe("self");
    await expect(page.getByRole("heading", { name: "AI 任务工作台", exact: true })).toBeVisible();
    await tools(page).getByRole("navigation", { name: "选择只读工具", exact: true }).getByRole("button", { name: "库存余额", exact: true }).click();
    await expect(tools(page).getByRole("button", { name: "读取库存余额", exact: true })).toBeDisabled();
    await expect(tools(page)).toContainText("该工具需要当前租户范围的库存读取权限 当前不读取业务资料");
    release.resolve(); await bounded(returned.promise, "agent_late_response_not_returned"); if (lateFailure) throw lateFailure;
    await expect(toolResult(page, "库存余额")).toHaveCount(0); await expect(page.getByText(heldFingerprint, { exact: true })).toHaveCount(0);
    expect((await current(page)).permissionScopes?.[Permission.OrderRead]).toBe("tenant");
    evidence.inventoryScopeNarrowed = "self"; evidence.latePrivateReplyHidden = true;
    expect(seen.posts).toEqual([]); expect(fixture.model.modelCalls()).toBe(0); expect(seen.pageErrors).toEqual([]);
    expect(seen.consoleErrors.filter(error => error.kind === "unexpected" || error.kind === "abort")).toEqual([]);
    expect(seen.consoleErrors.filter(error => error.kind === "collection_conflict").length).toBeLessThanOrEqual(1);
    expect(seen.consoleErrors.filter(error => error.kind === "late_cancelled").length).toBeLessThanOrEqual(1);
    evidence.console = seen.consoleErrors;
  } catch (error) { failure = error; }
  finally {
    releaseLate?.();
    failures.push(...await cleanup([
      async () => { if (lateDone) await bounded(lateDone, "agent_late_response_cleanup_timeout", 10_000); },
      async () => { if (lateHandler) await page.unroute("**/api/agent-reads/call", lateHandler); },
      async () => { await fixture.close(); evidence.originalRolesRestored = true; evidence.childAndDatabaseClosed = true; },
    ]));
    evidence.screenshots = screenshots; evidence.cleanupFailureCount = failures.length;
    failures.push(...await cleanup([() => writeFile(info.outputPath("agent-read-tools-proof.json"), JSON.stringify(evidence, null, 2) + "\n")]));
  }
  finish(failure, failures);
});

async function intents(page: Page) {
  const values = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!)), ASSIST_INTENT_PREFIX);
  return values.map(value => AssistIntentSchema.parse(value));
}
async function publishKnowledge(label: string) {
  const created = await centerApi<{ id: string }>("knowledge/create", { fields: { title: label, summary: "Synthetic original Assist recovery source",
    body: "先核对资料并保留复核记录。", topic: "operations", platform: "all", market: "ALL", spuId: null,
    sourceType: "team", sourceLabel: "Synthetic recovery SOP", sourceUrl: "", owner: "Synthetic operator", verifiedOn: "2020-01-01",
    reviewDueOn: "2099-12-31", tags: ["资料核对"] }, expectedRevision: 0, reason: "Synthetic recovery source", requestId: randomUUID() });
  const read = async () => KnowledgeWorkspaceSchema.parse(await centerApi("knowledge/workspace")).entries.find(row => row.id === created.id);
  let entry = await read(); if (!entry) throw new Error("Synthetic original knowledge missing");
  await centerApi(`knowledge/${created.id}/submit`, { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic explicit review", requestId: randomUUID() });
  entry = await read(); if (!entry) throw new Error("Synthetic submitted knowledge missing");
  await centerApi(`knowledge/${created.id}/publish`, { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic explicit publication", requestId: randomUUID() });
  return created.id;
}

test("a committed personal Assist request survives a lost response and refresh using only its original ID receipt with no second paid submission", async ({ page }, info) => {
  const seen = observe(page, { authorityChangeWorkspaces: true }), fixture = await agentReadBrowserFixture("recovery");
  const evidence: Record<string, unknown> = { nonce: fixture.nonce, admission: "Personal OIDC and BFF, actual Assist admission/budget/queue/Worker; only external model transport is synthetic",
    expiryBoundary: "Expired receipt behavior is covered by isolated API/unit checks; this browser does not alter immutable run expiry or global time." };
  let lostHandler: ((route: Route) => Promise<void>) | undefined;
  let failure: unknown; const failures: unknown[] = [];
  try {
    const label = "Synthetic original Agent recovery " + randomUUID(), knowledgeId = await publishKnowledge(label); evidence.knowledgeId = knowledgeId;
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/ai-tasks"); await assertOperator(page);
    await expect(page.getByRole("heading", { name: "AI 任务工作台", exact: true })).toBeVisible();
    await page.getByLabel("要完成的任务", { exact: true }).selectOption("knowledge_answer");
    const question = label + " 资料核对应如何保留复核记录？";
    await page.getByLabel("需要查证的问题", { exact: true }).fill(question);
    await page.getByRole("button", { name: "读取本次依据", exact: true }).click();
    await expect(page.getByRole("region", { name: "本次任务依据", exact: true })).toContainText(label);
    await page.getByRole("combobox", { name: "图文模型", exact: true }).selectOption(fixture.model.modelId);
    let committed: AssistView | undefined, requestChecksum = "", requestId = "", routeFailure: unknown;
    const returned = latch();
    lostHandler = async route => {
      try {
        const input = CreateAssistSchema.parse(route.request().postDataJSON()); requestId = input.requestId; requestChecksum = sha(assistRequestRecoveryText(input));
        const response = await route.fetch(); expect(response.status()).toBe(201); committed = AssistViewSchema.parse(await response.json());
        expect(committed.status).toBe("queued"); await route.abort("failed");
      } catch (error) { routeFailure = error; } finally { returned.resolve(); }
    };
    await page.route("**/api/ai-assists/runs", lostHandler, { times: 1 });
    await page.getByRole("button", { name: "开始分析", exact: true }).click(); await bounded(returned.promise, "assist_original_commit_response_timeout");
    if (routeFailure) throw routeFailure; if (!committed) throw new Error("Original Assist did not commit before response loss");
    const originalRun = committed;
    evidence.requestId = requestId; evidence.requestChecksum = requestChecksum; evidence.runId = originalRun.id;
    await expect.poll(async () => (await intents(page)).some(value => value.requestId === requestId)).toBe(true);
    const marker = (await intents(page)).find(value => value.requestId === requestId)!;
    expect(marker).toMatchObject({ requestId, requestChecksum, kind: "knowledge_answer", runId: null });
    expect(Object.keys(marker).sort()).toEqual(["version", "ownerScope", "taskScope", "kind", "requestId", "requestChecksum", "runId"].sort());
    expect(JSON.stringify(marker)).not.toContain(question); expect(JSON.stringify(marker)).not.toContain(label);
    expect(new URL(page.url()).searchParams.has("run")).toBe(false);
    const queuedState = await fixture.state(requestId), queuedJobs = await fixture.queuedJobs(originalRun.id);
    expect(queuedState.runs).toHaveLength(1); expect(queuedState.runs[0]).toMatchObject({ id: originalRun.id, ownerId: actors().operator.userId, requestChecksum, status: "queued" });
    expect(queuedState.executions).toHaveLength(1); expect(queuedState.executions[0]).toMatchObject({ dispatchCount: 1, attemptCount: 0, submissionState: "not_submitted" });
    expect(queuedState.budgets).toHaveLength(1); expect(queuedState.budgets[0]!.state).toBe("reserved");
    expect(queuedJobs.map(job => job.name).sort()).toEqual(["assist.analyze", "assist.expire"]);
    expect(queuedJobs.every(job => job.original)).toBe(true);
    await page.reload(); expect(new URL(page.url()).searchParams.has("run")).toBe(false);
    const row = requestRow(page, requestId); await expect(row).toBeVisible();
    const receiptResponse = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/ai-assists/receipts");
    await row.getByRole("button", { name: "只读取原请求回执", exact: true }).click();
    const receipt = await receiptResponse; expect(receipt.status()).toBe(200);
    expect(AssistReceiptViewSchema.parse(await receipt.json())).toMatchObject({ state: "found", requestId, requestChecksum, run: { id: originalRun.id, status: "queued" } });
    await expect(row.getByRole("region", { name: "已找回的原 AI 回执", exact: true })).toContainText(originalRun.id);
    expect(await fixture.state(requestId)).toEqual(queuedState); expect(await fixture.queuedJobs(originalRun.id)).toEqual(queuedJobs);
    expect(seen.posts).toHaveLength(1); expect(fixture.model.modelCalls()).toBe(0);

    await fixture.model.answer(originalRun.id); expect(fixture.model.modelCalls()).toBe(1);
    // Refresh to the root route again. The only recovery action is a real GET.
    await page.goto("/ai-tasks?tools=1");
    const completedResponse = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/ai-assists/receipts");
    await requestRow(page, requestId).getByRole("button", { name: "只读取原请求回执", exact: true }).click();
    expect(AssistReceiptViewSchema.parse(await (await completedResponse).json())).toMatchObject({ state: "found", run: { id: originalRun.id, status: "completed", result: { summary: "先核对资料并保留复核记录。" } } });
    await requestRow(page, requestId).getByRole("link", { name: "读取原任务详情", exact: true }).click();
    await expect(page.locator(".ai-assist-report > p", { hasText: "先核对资料并保留复核记录。" }).first()).toBeVisible();
    const completedState = await fixture.state(requestId), completedJobs = await fixture.queuedJobs(originalRun.id);
    expect(completedState.runs).toHaveLength(1); expect(completedState.runs[0]!.status).toBe("completed");
    expect(completedState.executions[0]).toMatchObject({ dispatchCount: 1, attemptCount: 1, submissionState: "received" });
    expect(completedState.budgets.map(value => value.id)).toEqual(queuedState.budgets.map(value => value.id));
    evidence.screenshot = await screenshot(page, info, "assist-original-receipt-completed", requestRow(page, requestId));

    const unknown: AssistIntent = { ...marker, requestId: randomUUID(), requestChecksum: "f".repeat(64), runId: null };
    await page.evaluate(({ prefix, value }) => sessionStorage.setItem(prefix + value.ownerScope + ":" + value.requestId, JSON.stringify(value)), { prefix: ASSIST_INTENT_PREFIX, value: unknown });
    await page.goto("/ai-tasks?tools=1");
    const unknownResponse = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/ai-assists/receipts");
    await requestRow(page, unknown.requestId).getByRole("button", { name: "只读取原请求回执", exact: true }).click();
    expect(AssistReceiptViewSchema.parse(await (await unknownResponse).json())).toMatchObject({ state: "not_found", run: null, requestId: unknown.requestId });
    await expect(requestRow(page, unknown.requestId)).toContainText("原回执尚未找到 不等于未提交");
    expect(seen.posts).toHaveLength(1); expect(await fixture.state(requestId)).toEqual(completedState);
    expect(await fixture.queuedJobs(originalRun.id)).toEqual(completedJobs); expect(fixture.model.modelCalls()).toBe(1);

    await requestRow(page, requestId).getByRole("button", { name: "只读取原请求回执", exact: true }).click();
    await requestRow(page, requestId).getByRole("link", { name: "读取原任务详情", exact: true }).click();
    await expect(page.locator(".ai-assist-report > p", { hasText: "先核对资料并保留复核记录。" }).first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get("run")).toBe(originalRun.id);
    const beforeDowngrade = (await intents(page)).sort((a, b) => a.requestId.localeCompare(b.requestId));
    seen.prepareAuthorityChange(erpSessionAuthority(await current(page)));
    await fixture.removeWorkflowRead();
    const denialStartedAt = seen.beginDenial("/api/ai-assists/runs/" + originalRun.id); evidence.roleDowngradeCommittedAt = denialStartedAt;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    let narrowedSession: Awaited<ReturnType<typeof current>> | undefined;
    await expect.poll(async () => { const session = await current(page); if (!session.permissions.includes(Permission.WorkflowRead)) narrowedSession = session;
      return session.permissions.includes(Permission.WorkflowRead); }).toBe(false);
    if (!narrowedSession) throw new Error("Actual narrowed personal session was not observed");
    seen.currentAuthority(erpSessionAuthority(narrowedSession));
    await expect(page.locator(".ai-assist-report")).toHaveCount(0);
    expect((await intents(page)).sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual(beforeDowngrade);
    await seen.endAuthorityWindow(); evidence.roleDowngradeWindowClosedAt = seen.authorityWindow.endedAt;
    evidence.roleRestoreStartedAt = seen.beginRestoration();
    await fixture.restore(); evidence.roleRestoredAt = Date.now();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    let restoredSession: Awaited<ReturnType<typeof current>> | undefined;
    await expect.poll(async () => { const session = await current(page);
      if (sha(erpSessionAuthority(session)) === seen.authorityWindow.originalAuthorityHash) restoredSession = session;
      return sha(erpSessionAuthority(session)); }).toBe(seen.authorityWindow.originalAuthorityHash);
    if (!restoredSession) throw new Error("Actual restored personal session was not observed");
    seen.restoredAuthority(erpSessionAuthority(restoredSession));
    await expect(page.locator(".ai-assist-report > p", { hasText: "先核对资料并保留复核记录。" }).first()).toBeVisible();
    expect(new URL(page.url()).searchParams.get("run")).toBe(originalRun.id);
    expect((await intents(page)).sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual(beforeDowngrade);
    await expect(requestRow(page, requestId)).toBeVisible(); await seen.endRestorationWindow();
    evidence.sameRunBodyRestoredWithoutForcedNavigation = true;
    expect(seen.posts).toHaveLength(1); expect(await fixture.state(requestId)).toEqual(completedState);
    expect(await fixture.queuedJobs(originalRun.id)).toEqual(completedJobs); expect(fixture.model.modelCalls()).toBe(1);
    await page.getByRole("button", { name: "退出登录", exact: true }).click(); await expect(page).toHaveURL(/\/login(?:\?|$)/);
    expect(await intents(page)).toEqual([]);
    await loginErp(page, "readonly", "/ai-tasks"); expect((await current(page)).userId).toBe(actors().readonly.userId);
    expect(await intents(page)).toEqual([]); await expect(requestRow(page, requestId)).toHaveCount(0);
    expect(seen.posts).toHaveLength(1); expect(fixture.model.modelCalls()).toBe(1); expect(seen.pageErrors).toEqual([]);
    await seen.drainResponses();
    expect(seen.authorityWindow.failureCode).toBeNull(); expect(seen.authorityWindow.barrierCompletedAt).toBeGreaterThan(0);
    expect(seen.restorationWindow.failureCode).toBeNull(); expect(seen.restorationWindow.endedAt).toBeGreaterThan(0);
    expect(seen.authorityRequests.filter(value => value.barrier && (value.settlement === "pending" || value.settledAt === null || value.settledAt > seen.authorityWindow.endedAt))).toEqual([]);
    expect(seen.authorityRequests.filter(value => value.restoreBarrier && (value.settlement === "pending" || value.settledAt === null || value.settledAt > seen.restorationWindow.endedAt))).toEqual([]);
    expect(seen.consoleErrors.filter(value => value.kind !== "abort" && value.kind !== "expected_denial" && value.kind !== "expected_authority_changed" && value.kind !== "expected_restore_authority_changed")).toEqual([]);
    expect(seen.consoleErrors.filter(value => value.kind === "abort")).toHaveLength(1);
    expect(seen.denials.length).toBeLessThanOrEqual(1);
    const denialConsole = seen.consoleErrors.filter(value => value.kind === "expected_denial"); expect(denialConsole.length).toBeLessThanOrEqual(1);
    for (const entry of denialConsole) expect(seen.denials.some(value => value.path === entry.path && value.status === 403 && value.at >= denialStartedAt)).toBe(true);
    for (const path of ["/api/agent-reads/workspace", "/api/ai-assists/task-workspace"]) {
      const responses = seen.authorityResponses.filter(value => value.path === path), errors = seen.consoleErrors.filter(value => value.kind === "expected_authority_changed" && value.path === path);
      expect(responses.length).toBeLessThanOrEqual(1); expect(errors.length).toBeLessThanOrEqual(1);
      for (const response of responses) expect(response).toMatchObject({ method: "GET", status: 409, code: "authority_changed", verified: true });
      for (const error of errors) expect(responses.some(response => response.verified && response.requestKey === error.requestKey &&
        error.at >= seen.authorityWindow.startedAt && error.at <= seen.authorityWindow.endedAt && Math.abs(response.at - error.at) <= 2000)).toBe(true);
    }
    for (const path of ["/api/agent-reads/workspace", "/api/ai-assists/task-workspace", "/api/ai-assists/runs/" + originalRun.id]) {
      const responses = seen.restorationResponses.filter(value => value.path === path), errors = seen.consoleErrors.filter(value => value.kind === "expected_restore_authority_changed" && value.path === path);
      expect(responses.length).toBeLessThanOrEqual(1); expect(errors.length).toBeLessThanOrEqual(1);
      for (const response of responses) expect(response).toMatchObject({ method: "GET", status: 409, code: "authority_changed", verified: true });
      for (const error of errors) expect(responses.some(response => response.verified && response.requestKey === error.requestKey &&
        error.at >= seen.restorationWindow.startedAt && error.at <= seen.restorationWindow.endedAt && Math.abs(response.at - error.at) <= 2000)).toBe(true);
    }
    evidence.requestId = requestId; evidence.requestChecksum = requestChecksum; evidence.runId = originalRun.id; evidence.totalPaidPosts = seen.posts.length;
    evidence.modelCalls = fixture.model.modelCalls(); evidence.originalQueueJobIds = queuedJobs.map(value => value.id);
    evidence.originalBudgetIds = queuedState.budgets.map(value => value.id); evidence.sameActorMarkersRetained = true; evidence.logoutAndActorChangeClearedMarkers = true;
    evidence.unknownReceiptNotResubmitted = true;
  } catch (error) { failure = error; }
  finally {
    failures.push(...await cleanup([
      async () => { await seen.endAuthorityWindow(); },
      async () => { await seen.endRestorationWindow(); },
      async () => { await seen.drainResponses(); },
      async () => { if (lostHandler) await page.unroute("**/api/ai-assists/runs", lostHandler); },
      async () => { await fixture.close(); evidence.originalRolesRestored = true; evidence.databaseClosed = true; },
    ]));
    evidence.console = seen.consoleErrors; evidence.pageErrors = seen.pageErrors; evidence.boundCurrentRoleDenials = seen.denials;
    evidence.authorityWindow = seen.authorityWindow; evidence.workspaceRequests = seen.authorityRequests;
    evidence.restorationWindow = seen.restorationWindow; evidence.boundRestorationResponses = seen.restorationResponses;
    evidence.boundAuthorityChangeResponses = seen.authorityResponses; evidence.totalPaidPosts = seen.posts.length;
    evidence.cleanupFailureCount = failures.length;
    failures.push(...await cleanup([() => writeFile(info.outputPath("assist-original-recovery-proof.json"), JSON.stringify(evidence, null, 2) + "\n")]));
  }
  finish(failure, failures);
});
