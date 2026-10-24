import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type Request as BrowserRequest, type Route, type TestInfo } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AssistViewSchema, CreateAssistSchema, type AssistView, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { ASSIST_INTENT_PREFIX, AssistIntentSchema, AssistReceiptViewSchema, assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { AssistTargetPageViewSchema, type AssistTargetPageView } from "@yummyai/contracts/ai/task-target-page";
import { KnowledgeWorkspaceSchema } from "@yummyai/contracts/knowledge";
import { agentEntryBrowserFixture, requireAgentEntryBrowser, type AgentEntrySeed } from "./agent-entry-fixture";
import { actors, loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";

requireAgentEntryBrowser();
test.setTimeout(240_000);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const alphabeticId = () => randomUUID().replace(/[0-9]/g, value => String.fromCharCode(97 + Number(value)));
const chat = (page: Page) => page.getByRole("region", { name: "知识对话", exact: true });
const bulk = (page: Page) => page.getByRole("region", { name: "批量 AI 预审", exact: true });
const requestRow = (page: Page, requestId: string) => page.getByRole("article", { name: "原 AI 请求 " + requestId, exact: true });
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Only exact observed HTTP failures authorize an expected console classification. */
function observe(page: Page) {
  type Read = { path: string; urlHash: string; authorityHash: string | null; startedAt: number; settledAt: number | null;
    status: number | null; code: string | null; failed: string | null; done: ReturnType<typeof latch> };
  const reads: Read[] = [], byRequest = new Map<BrowserRequest, Read>(), bodies = new Set<Promise<void>>();
  const posts: { requestId: string; kind: string }[] = [], errors: { path: string; urlHash: string; at: number; status: number | null; abort: boolean }[] = [], pageErrors: string[] = [];
  const lost: { urlHash: string; requestId: string; at: number; committedStatus: 201 }[] = [], historyFaults: { urlHash: string; at: number; status: 503 }[] = [];
  const transition = { start: 0, end: 0, originalHash: "", currentHash: "" };
  page.on("request", request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith("/api/")) return;
    if (request.method() === "POST" && url.pathname === "/api/ai-assists/runs") {
      const input = CreateAssistSchema.parse(request.postDataJSON()); posts.push({ requestId: input.requestId, kind: input.kind });
    }
    if (request.method() !== "GET" && request.method() !== "POST") return;
    const authority = request.headers()["x-yummyai-context-authority"];
    const row: Read = { path: url.pathname, urlHash: sha(request.url()), authorityHash: authority ? sha(authority) : null,
      startedAt: Date.now(), settledAt: null, status: null, code: null, failed: null, done: latch() };
    reads.push(row); byRequest.set(request, row);
  });
  const settle = (request: BrowserRequest, failure: string | null) => {
    const row = byRequest.get(request); if (!row) return; row.failed = failure; row.settledAt = Date.now(); row.done.resolve();
  };
  page.on("requestfinished", request => settle(request, null));
  page.on("requestfailed", request => settle(request, request.failure()?.errorText ?? "unknown"));
  page.on("response", response => {
    const row = byRequest.get(response.request()); if (!row) return; row.status = response.status();
    if (response.status() < 400) return;
    const body = (async () => {
      try {
        const bytes = await response.body(); if (bytes.byteLength > 8192) return;
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value.code)) row.code = value.code;
      } catch { /* An unreadable error body cannot authenticate an authority or collection exception. */ }
    })();
    bodies.add(body); void body.then(() => bodies.delete(body));
  });
  page.on("pageerror", () => pageErrors.push("unexpected_page_error"));
  page.on("console", message => {
    if (message.type() !== "error") return;
    let path = "", urlHash = ""; try { const url = new URL(message.location().url); path = url.pathname; urlHash = sha(url.href); } catch { /* No location is not an expected transport failure. */ }
    const match = /\b(4\d\d|5\d\d)\b/.exec(message.text());
    errors.push({ path, urlHash, at: Date.now(), status: match ? Number(match[1]) : null, abort: /net::ERR_(FAILED|ABORTED)/.test(message.text()) });
  });
  async function drain() {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const size = reads.length;
      await bounded(Promise.all(reads.filter(row => row.settledAt === null).map(row => row.done.promise)), "agent_entry_request_settlement_timeout", Math.max(1, deadline - Date.now()));
      await bounded(Promise.all([...bodies]), "agent_entry_error_body_settlement_timeout", Math.max(1, deadline - Date.now()));
      if (size === reads.length && reads.every(row => row.settledAt !== null)) return;
      if (Date.now() >= deadline) throw new Error("agent_entry_request_settlement_timeout");
    }
  }
  return { posts, lost, historyFaults, transition, reads,
    lostResponse(url: string, requestId: string) { lost.push({ urlHash: sha(url), requestId, at: Date.now(), committedStatus: 201 }); },
    history503(url: string) { historyFaults.push({ urlHash: sha(url), at: Date.now(), status: 503 }); },
    beginAuthority(stamp: string) { transition.start = Date.now(); transition.originalHash = sha(stamp); },
    async endAuthority(stamp: string) { transition.currentHash = sha(stamp); await drain(); transition.end = Date.now(); },
    drain,
    async check() {
      await drain(); expect(pageErrors).toEqual([]);
      const unexpected = errors.filter(error => {
        const rows = reads.filter(row => row.urlHash === error.urlHash && Math.abs((row.settledAt ?? Date.now()) - error.at) < 5000);
        if (error.path === "/api/ai-assists/runs" && error.abort && lost.some(value => value.urlHash === error.urlHash && Math.abs(value.at - error.at) < 5000 && posts.some(post => post.requestId === value.requestId))) return false;
        if (error.status === 409 && error.path === "/api/ai-assists/task-target-pages" && rows.some(row => row.status === 409 && row.code === "assist_target_collection_changed")) return false;
        if (error.status === 503 && error.path === "/api/ai-assists/runs" && rows.some(row => row.status === 503) && historyFaults.some(row => row.urlHash === error.urlHash && Math.abs(row.at - error.at) < 5000)) return false;
        const inTransition = transition.start > 0 && error.at >= transition.start && (!transition.end || error.at <= transition.end) && transition.originalHash !== transition.currentHash;
        const workspace = ["/api/ai-assists/task-target-pages", "/api/ai-assists/task-workspace", "/api/agent-reads/workspace"].includes(error.path);
        if (inTransition && workspace && rows.some(row => row.authorityHash === transition.originalHash &&
          (error.status === 409 && row.status === 409 && row.code === "authority_changed" || error.abort && row.failed?.includes("ERR_ABORTED")))) return false;
        return true;
      });
      expect(unexpected).toEqual([]);
      return { posts, pageErrors, console: errors, transport: reads.map(row => ({ path: row.path, urlHash: row.urlHash, authorityHash: row.authorityHash,
        startedAt: row.startedAt, settledAt: row.settledAt, status: row.status, code: row.code, failed: row.failed })), lost, historyFaults, authorityTransition: transition };
    },
  };
}

async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json());
}
async function operator(page: Page) {
  const actual = await session(page), expected = actors().operator;
  expect({ tenantId: actual.tenantId, userId: actual.userId }).toEqual({ tenantId: expected.tenantId, userId: expected.userId }); return actual;
}
async function intents(page: Page) {
  const values = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!)), ASSIST_INTENT_PREFIX);
  return values.map(value => AssistIntentSchema.parse(value));
}
async function receipt(page: Page, id: string) {
  const response = page.waitForResponse(value => value.request().method() === "GET" && new URL(value.url()).pathname === "/api/ai-assists/receipts" && new URL(value.url()).searchParams.get("requestId") === id);
  await requestRow(page, id).getByRole("button", { name: "只读取原请求回执", exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200); return AssistReceiptViewSchema.parse(await actual.json());
}
async function screen(page: Page, info: TestInfo, name: string, region: Locator) {
  await region.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const file = info.outputPath(name + ".png"); await page.screenshot({ path: file, fullPage: false }); return file;
}
async function finish(page: Page, info: TestInfo, fixture: Awaited<ReturnType<typeof agentEntryBrowserFixture>>, seen: ReturnType<typeof observe>, evidence: Record<string, unknown>, failure: unknown) {
  const cleanupFailures: unknown[] = [];
  try { evidence.browser = await seen.check(); } catch (error) { cleanupFailures.push(error); }
  try { await page.unrouteAll({ behavior: "wait" }); } catch (error) { cleanupFailures.push(error); }
  try { await page.close(); } catch (error) { cleanupFailures.push(error); }
  try { await fixture.close(); } catch (error) { cleanupFailures.push(error); }
  evidence.cleanupFailureCount = cleanupFailures.length; evidence.testBodyCompleted = failure === undefined;
  try {
    const file = info.outputPath("agent-entry-proof.json"); await writeFile(file, JSON.stringify(evidence, null, 2) + "\n");
    await info.attach("agent-entry-proof", { path: file, contentType: "application/json" });
  } catch (error) { cleanupFailures.push(error); }
  if (failure !== undefined || cleanupFailures.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures], "agent_entry_test_or_teardown_failed");
}
async function targetPage(page: Page, query: string, action: () => Promise<unknown>, cursor: boolean): Promise<AssistTargetPageView> {
  const waiting = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === "/api/ai-assists/task-target-pages" && url.searchParams.get("q") === query && url.searchParams.has("cursor") === cursor;
  });
  await action(); const response = await waiting; expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toContain("no-store");
  return AssistTargetPageViewSchema.parse(await response.json());
}
async function failedSelectionDiagnostic(page: Page) {
  return bounded(page.locator("select").evaluateAll(nodes => nodes.slice(0, 12).map(node => {
    if (!(node instanceof HTMLSelectElement)) throw new Error("Expected a real select element for bounded diagnostics");
    return {
    ariaLabel: node.getAttribute("aria-label"),
    label: [...(node.labels ?? [])].map(label => [...label.childNodes].filter(child => child.nodeType === Node.TEXT_NODE)
      .map(child => child.textContent).join(" ").replace(/\s+/g, " ").trim().slice(0, 100)),
    disabled: node.disabled, selectedValue: node.value, optionCount: node.options.length,
    nonemptyOptionCount: [...node.options].filter(option => option.value !== "").length,
    firstOptionValues: [...node.options].slice(0, 3).map(option => option.value),
    };
  })), "agent_entry_failed_selection_diagnostic_timeout", 2000);
}

test("personal task selection reads complete owner pages, clears a changed collection and keeps permitted kinds usable after one domain narrows", async ({ page }, info) => {
  const fixture = await agentEntryBrowserFixture("targets"), seen = observe(page), evidence: Record<string, unknown> = { nonce: fixture.nonce, admission: "Real normalized orders; full 501-object collection is separately covered by isolated API. Browser uses 55 objects and the actual 40-item UI page." };
  let failure: unknown;
  try {
    const seed = await fixture.seed(55), state = await fixture.state(randomUUID()), facts = await fixture.businessState(); evidence.orderId = seed.orderId;
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/ai-tasks"); await operator(page);
    await page.getByRole("combobox", { name: /^要完成的任务/ }).selectOption("order_review");
    const first = await targetPage(page, seed.label, () => page.getByLabel("查找业务对象", { exact: true }).fill(seed.label), false);
    expect(first).toMatchObject({ total: 55, readCount: 40, complete: false }); expect(first.items).toHaveLength(40);
    const pagination = page.locator('[aria-label="业务对象分页"]'), selection = page.getByRole("combobox", { name: /^本次业务对象/ });
    await expect(pagination).toContainText("已读取 40 / 55 项 尚未读取完整集合");
    const second = await targetPage(page, seed.label, () => pagination.getByRole("button", { name: "加载下一页", exact: true }).click(), true);
    expect(second).toMatchObject({ total: 55, readCount: 55, complete: true, nextCursor: null, collectionFingerprint: first.collectionFingerprint });
    const ids = [...first.items, ...second.items].map(row => row.id); expect(new Set(ids).size).toBe(55); expect(ids).toEqual([...seed.lineIds].sort().reverse());
    await expect(selection.locator('option:not([value=""])')).toHaveCount(55); await expect(pagination).toContainText("本次集合已读完");
    await selection.selectOption(ids[0]!);
    const fresh = await targetPage(page, seed.label, () => pagination.getByRole("button", { name: "重新读取对象", exact: true }).click(), false);
    expect(fresh.complete).toBe(false); const appended = await fixture.append(); evidence.appendedOrderId = appended.orderId;
    const changed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ai-assists/task-target-pages" && response.status() === 409);
    await pagination.getByRole("button", { name: "加载下一页", exact: true }).click(); const rejected = await changed;
    expect(await rejected.json()).toMatchObject({ code: "assist_target_collection_changed" });
    await expect(selection.locator('option:not([value=""])')).toHaveCount(0); await expect(selection).toHaveValue("");
    await expect(page.getByRole("region", { name: "本次任务依据", exact: true })).toHaveCount(0);
    const restarted = await targetPage(page, seed.label, () => pagination.getByRole("button", { name: "重新读取对象", exact: true }).click(), false);
    expect(restarted).toMatchObject({ total: 56, readCount: 40, complete: false }); expect(restarted.collectionFingerprint).not.toBe(first.collectionFingerprint);
    evidence.desktop = await screen(page, info, "target-pages-desktop", pagination);
    await page.setViewportSize({ width: 390, height: 844 }); evidence.mobile = await screen(page, info, "target-pages-mobile", pagination);
    const original = erpSessionAuthority(await session(page)); seen.beginAuthority(original); await fixture.narrow(Permission.ProcurementRead);
    await expect.poll(async () => (await session(page)).permissionScopes?.[Permission.ProcurementRead]).toBe("self");
    const current = await session(page), currentAuthority = erpSessionAuthority(current); expect(currentAuthority).not.toBe(original);
    const workspaceReady = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ai-assists/task-workspace" &&
      response.status() === 200 && response.request().headers()["x-yummyai-context-authority"] === currentAuthority);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const refreshedWorkspace = await workspaceReady; expect(refreshedWorkspace.headers()["x-yummyai-context-authority"]).toBe(currentAuthority);
    const kind = page.getByRole("combobox", { name: /^要完成的任务/ });
    await expect(kind).toBeVisible(); await expect(kind).toBeEnabled(); await expect(kind.locator("option")).toHaveCount(9);
    const procurement = kind.locator('option[value="procurement_review"]');
    await expect(procurement).toHaveAttribute("disabled", ""); await expect(procurement).toHaveJSProperty("disabled", true);
    await seen.endAuthority(currentAuthority);
    await expect(kind.locator('option[value="knowledge_answer"]')).toHaveJSProperty("disabled", false); await kind.selectOption("knowledge_answer"); await expect(page.getByLabel("需要查证的问题", { exact: true })).toBeVisible();
    await expect(kind.locator('option[value="creative"]')).toHaveJSProperty("disabled", false); await kind.selectOption("creative"); await expect(page.getByRole("combobox", { name: /^本次业务对象/ })).toBeVisible();
    const denied = await page.request.get("/api/ai-assists/task-target-pages?kind=procurement_review", { headers: { "x-yummyai-context-authority": erpSessionAuthority(current) } }); expect(denied.status()).toBe(403);
    expect(seen.posts).toHaveLength(0); expect(fixture.model.modelCalls()).toBe(0); expect(await fixture.state("00000000-0000-4000-8000-000000000001")).toEqual(state);
    const finalFacts = await fixture.businessState(); expect(finalFacts.orders.count).toBe(facts.orders.count + 1); expect(finalFacts.order_lines.count).toBe(facts.order_lines.count + 1);
    for (const table of ["order_work_items", "order_work_revisions", "order_work_events"]) expect(finalFacts[table]).toEqual(facts[table]);
    evidence.pageIds = ids; evidence.scope = { procurement: current.permissionScopes?.[Permission.ProcurementRead], knowledgeAndCatalogRemainAvailable: true };
  } catch (error) { failure = error; try { evidence.failedDom = await failedSelectionDiagnostic(page); } catch { evidence.failedDomUnavailable = true; } }
  await finish(page, info, fixture, seen, evidence, failure);
});

async function publishKnowledge(label: string) {
  const created = await centerApi<{ id: string }>("knowledge/create", { fields: { title: label, summary: "Synthetic entry recovery SOP", body: "先核对资料并保留复核记录。", topic: "operations", platform: "all", market: "ALL", spuId: null,
    sourceType: "team", sourceLabel: "Synthetic entry source", sourceUrl: "", owner: "Synthetic operator", verifiedOn: "2020-01-01", reviewDueOn: "2099-12-31", tags: ["资料核对"] }, expectedRevision: 0, reason: "Synthetic entry source", requestId: randomUUID() });
  const read = async () => KnowledgeWorkspaceSchema.parse(await centerApi("knowledge/workspace")).entries.find(row => row.id === created.id);
  let entry = await read(); if (!entry) throw new Error("Synthetic knowledge entry missing");
  await centerApi(`knowledge/${created.id}/submit`, { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic explicit review", requestId: randomUUID() });
  entry = await read(); if (!entry) throw new Error("Synthetic submitted knowledge missing");
  await centerApi(`knowledge/${created.id}/publish`, { expectedRevision: entry.revision, version: entry.latestVersion, reason: "Synthetic explicit publication", requestId: randomUUID() }); return created.id;
}
function loseOneResponse(page: Page, seen: ReturnType<typeof observe>) {
  const done = latch(); let failure: unknown, view: AssistView | undefined, input: CreateAssist | undefined;
  const handler = async (route: Route) => {
    try {
      input = CreateAssistSchema.parse(route.request().postDataJSON()); const response = await route.fetch(); expect(response.status()).toBe(201);
      view = AssistViewSchema.parse(await response.json()); expect(view.request?.requestId).toBe(input.requestId); expect(view.status).toBe("queued");
      seen.lostResponse(route.request().url(), input.requestId); await route.abort("failed");
    } catch (error) { failure = error; } finally { done.resolve(); }
  };
  return { handler, async result() { await bounded(done.promise, "agent_entry_committed_response_loss_timeout"); if (failure) throw failure; if (!view || !input) throw new Error("No committed original response"); return { view, input }; } };
}

test("KnowledgeChat restores its original paid request after response loss and refresh, and a failed history switch cannot borrow the previous conversation", async ({ page }, info) => {
  const fixture = await agentEntryBrowserFixture("chat"), seen = observe(page), evidence: Record<string, unknown> = { nonce: fixture.nonce, admission: "Three original native runs: two explicit prior conversations plus one real UI followup. Only synthetic external model HTTP; all completion receipts are actual Worker transactions." };
  let failure: unknown;
  try {
    const label = "Synthetic entry knowledge " + alphabeticId(); evidence.knowledgeId = await publishKnowledge(label);
    const start = async (question: string) => {
      const input = CreateAssistSchema.parse({ kind: "knowledge_answer", scopeId: randomUUID(), requestId: randomUUID(), modelId: fixture.model.modelId, purpose: "dialogue", evidenceStoreId: null, previousRunId: null,
        search: { query: question, topic: "operations", platform: "all", market: "ALL", spuIds: [] } });
      const value = AssistViewSchema.parse(await centerApi("ai-assists/runs", input)); await fixture.model.answer(value.id); return AssistViewSchema.parse(await centerApi("ai-assists/runs/" + value.id));
    };
    const previous = await start(label + " first source"), other = await start(label + " other scope");
    if (previous.request?.kind !== "knowledge_answer" || other.request?.kind !== "knowledge_answer") throw new Error("Real prior conversation request missing");
    const previousRequest = previous.request, otherRequest = other.request;
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/knowledge?tab=chat"); await operator(page);
    await expect(chat(page).getByLabel("最近对话", { exact: true }).locator(`option[value="${previousRequest.scopeId}"]`)).toHaveCount(1);
    const priorRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ai-assists/runs/" + previous.id && response.status() === 200);
    await chat(page).getByLabel("最近对话", { exact: true }).selectOption(previousRequest.scopeId); await priorRead;
    await expect(chat(page).getByLabel("已配置模型", { exact: true })).toHaveValue(fixture.model.modelId);
    const lost = loseOneResponse(page, seen); await page.route("**/api/ai-assists/runs", lost.handler, { times: 1 });
    const question = label + " followup evidence"; await chat(page).getByLabel("问题或追问", { exact: true }).fill(question);
    await chat(page).getByRole("button", { name: "发送并检索知识", exact: true }).click(); const committed = await lost.result();
    if (committed.input.kind !== "knowledge_answer") throw new Error("Knowledge UI created a different task kind");
    expect(committed.input).toMatchObject({ scopeId: previousRequest.scopeId, previousRunId: previous.id, modelId: fixture.model.modelId, evidenceStoreId: previousRequest.evidenceStoreId });
    const requestId = committed.input.requestId, checksum = sha(assistRequestRecoveryText(committed.input)); evidence.requestId = requestId; evidence.runId = committed.view.id; evidence.previousRunId = previous.id;
    const marker = (await intents(page)).find(value => value.requestId === requestId); expect(marker).toMatchObject({ runId: null, requestChecksum: checksum, kind: "knowledge_answer" });
    expect(Object.keys(marker!).sort()).toEqual(["version", "ownerScope", "taskScope", "kind", "requestId", "requestChecksum", "runId"].sort());
    expect(JSON.stringify(marker)).not.toContain(question); expect(JSON.stringify(marker)).not.toContain(label);
    const queued = await fixture.state(requestId), jobs = await fixture.queuedJobs(committed.view.id); expect(queued.runs).toHaveLength(1); expect(queued.executions).toHaveLength(1); expect(queued.budgets).toHaveLength(1);
    page.once("dialog", dialog => dialog.accept()); await page.reload(); await expect(requestRow(page, requestId)).toBeVisible();
    await expect(chat(page).getByRole("button", { name: "发送并检索知识", exact: true })).toBeDisabled();
    expect(await receipt(page, requestId)).toMatchObject({ state: "found", requestId, requestChecksum: checksum, run: { id: committed.view.id, status: "queued", request: { scopeId: previousRequest.scopeId, previousRunId: previous.id } } });
    await expect(chat(page)).toContainText("已恢复实际原对话范围与前次任务依据");
    const historyRefresh = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/ai-assists/runs" && url.searchParams.get("scope") === "knowledge:" + previousRequest.scopeId; });
    await chat(page).getByRole("button", { name: "刷新回答", exact: true }).click(); expect((await historyRefresh).status()).toBe(200);
    expect(await fixture.state(requestId)).toEqual(queued); expect(await fixture.queuedJobs(committed.view.id)).toEqual(jobs); expect(seen.posts).toHaveLength(1); expect(fixture.model.modelCalls()).toBe(2);
    await fixture.model.answer(committed.view.id); expect(fixture.model.modelCalls()).toBe(3);
    expect(await receipt(page, requestId)).toMatchObject({ state: "found", run: { id: committed.view.id, status: "completed" } });
    await expect(chat(page).getByLabel("问题或追问", { exact: true })).toBeEnabled();
    const completed = await fixture.state(requestId), completedJobs = await fixture.queuedJobs(committed.view.id);
    await page.route(url => url.pathname === "/api/ai-assists/runs" && url.searchParams.get("scope") === "knowledge:" + otherRequest.scopeId, async route => {
      const url = new URL(route.request().url());
      seen.history503(url.href); await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic controlled history outage" }) });
    }, { times: 1 });
    const failedHistory = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/ai-assists/runs" && url.searchParams.get("scope") === "knowledge:" + otherRequest.scopeId && response.status() === 503; });
    await chat(page).getByLabel("最近对话", { exact: true }).selectOption(otherRequest.scopeId); await failedHistory;
    await expect(chat(page)).toContainText("原对话依据尚未读取成功"); await expect(chat(page).locator(".kb-chat-history .kb-answer")).toHaveCount(0);
    await chat(page).getByLabel("已配置模型", { exact: true }).selectOption(fixture.model.modelId); await chat(page).getByLabel("问题或追问", { exact: true }).fill("Synthetic followup after failed history");
    await expect(chat(page).getByRole("button", { name: "发送并检索知识", exact: true })).toBeDisabled(); expect(seen.posts).toHaveLength(1);
    expect(await fixture.state(requestId)).toEqual(completed); expect(await fixture.queuedJobs(committed.view.id)).toEqual(completedJobs);
    const retriedHistory = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/ai-assists/runs" && url.searchParams.get("scope") === "knowledge:" + otherRequest.scopeId && response.status() === 200; });
    await chat(page).getByRole("button", { name: "重新读取原对话", exact: true }).click(); await retriedHistory;
    await expect(chat(page).getByRole("button", { name: "重新读取原对话", exact: true })).toHaveCount(0); await expect(chat(page).getByLabel("最近对话", { exact: true })).toHaveValue(otherRequest.scopeId);
    await expect(chat(page).getByLabel("问题或追问", { exact: true })).toHaveValue("");
    await expect(chat(page).getByLabel("已配置模型", { exact: true })).toHaveValue(otherRequest.modelId);
    await chat(page).getByLabel("问题或追问", { exact: true }).fill("Synthetic new question after reading the actual other conversation");
    await expect(chat(page).getByRole("button", { name: "发送并检索知识", exact: true })).toBeEnabled(); expect(seen.posts).toHaveLength(1); expect(fixture.model.modelCalls()).toBe(3);
    evidence.desktop = await screen(page, info, "knowledge-original-recovery-desktop", chat(page)); await page.setViewportSize({ width: 390, height: 844 }); evidence.mobile = await screen(page, info, "knowledge-original-recovery-mobile", chat(page));
    evidence.queued = queued; evidence.completed = completed; evidence.originalJobs = jobs; evidence.completedJobs = completedJobs;
  } catch (error) { failure = error; }
  await finish(page, info, fixture, seen, evidence, failure);
});

async function selectLine(page: Page, seed: AgentEntrySeed, index: number) {
  await page.getByRole("checkbox", { name: "选择商品 " + seed.externalOrderId + " / " + seed.externalLineIds[index], exact: true }).check();
}
async function openBulk(page: Page, modelId: string) {
  await page.getByRole("button", { name: "AI 预审", exact: true }).click(); await expect(bulk(page)).toBeVisible(); await bulk(page).getByRole("combobox", { name: /^分析模型/ }).selectOption(modelId);
}
test("bulk order review stops after an unknown original response and prechecks every selected row before a reopened or refreshed batch can submit", async ({ page }, info) => {
  const fixture = await agentEntryBrowserFixture("bulk"), seen = observe(page), evidence: Record<string, unknown> = { nonce: fixture.nonce, admission: "Actual normalized orders and pending private work owner; no review, artwork approval, release or adoption is manufactured." };
  let failure: unknown;
  try {
    const seed = await fixture.seed(3, true), before = await fixture.businessState(); evidence.orderId = seed.orderId; evidence.lineIds = seed.lineIds;
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/orders?" + new URLSearchParams({ q: seed.label, grouping: "items" })); await operator(page);
    await selectLine(page, seed, 2); await openBulk(page, fixture.model.modelId);
    const lost = loseOneResponse(page, seen); await page.route("**/api/ai-assists/runs", lost.handler, { times: 1 });
    await bulk(page).getByRole("button", { name: "开始本批 AI 预审", exact: true }).click(); const committed = await lost.result();
    expect(committed.input).toMatchObject({ kind: "order_review", orderLineId: seed.lineIds[2] }); const requestId = committed.input.requestId;
    const queued = await fixture.state(requestId), jobs = await fixture.queuedJobs(committed.view.id); expect(queued.runs).toHaveLength(1); expect(queued.executions).toHaveLength(1); expect(queued.budgets).toHaveLength(1);
    await expect(bulk(page).getByRole("button", { name: "关闭批量面板", exact: true })).toBeEnabled(); await bulk(page).getByRole("button", { name: "关闭批量面板", exact: true }).click();
    await selectLine(page, seed, 0); await openBulk(page, fixture.model.modelId);
    await bulk(page).getByRole("button", { name: "开始本批 AI 预审", exact: true }).click(); await expect(bulk(page)).toContainText("本批尚未提交任何新任务");
    expect(seen.posts).toHaveLength(1); expect(await fixture.state(requestId)).toEqual(queued); expect(await fixture.queuedJobs(committed.view.id)).toEqual(jobs);
    expect(await receipt(page, requestId)).toMatchObject({ state: "found", run: { id: committed.view.id, request: { kind: "order_review", orderLineId: seed.lineIds[2] } } });
    expect((await intents(page)).find(row => row.requestId === requestId)?.runId).toBe(committed.view.id);
    await bulk(page).getByRole("button", { name: "关闭批量面板", exact: true }).click();
    page.once("dialog", dialog => dialog.accept()); await page.reload(); await selectLine(page, seed, 0); await selectLine(page, seed, 2); await openBulk(page, fixture.model.modelId);
    await bulk(page).getByRole("button", { name: "开始本批 AI 预审", exact: true }).click(); await expect(bulk(page)).toContainText("本批尚未提交任何新任务");
    expect(seen.posts).toHaveLength(1); expect(await fixture.state(requestId)).toEqual(queued); expect(await fixture.queuedJobs(committed.view.id)).toEqual(jobs); expect(fixture.model.modelCalls()).toBe(0);
    await fixture.model.analyze(committed.view.id, { summary: "Synthetic native order review remains advice only", findings: [], directions: [], matches: [], missingInformation: ["Operator must review the original private requirements"] });
    expect(await receipt(page, requestId)).toMatchObject({ state: "found", run: { id: committed.view.id, status: "completed" } });
    await expect(bulk(page)).toContainText("未自动采纳订单"); expect(fixture.model.modelCalls()).toBe(1); expect(seen.posts).toHaveLength(1);
    expect(await fixture.businessState()).toEqual(before); const completed = await fixture.state(requestId); expect(completed.runs).toHaveLength(1); expect(completed.executions[0]).toMatchObject({ dispatchCount: 1, attemptCount: 1, submissionState: "received" });
    expect(completed.budgets.map(row => row.id)).toEqual(queued.budgets.map(row => row.id));
    evidence.desktop = await screen(page, info, "bulk-original-preflight-desktop", bulk(page)); await page.setViewportSize({ width: 390, height: 844 }); evidence.mobile = await screen(page, info, "bulk-original-preflight-mobile", bulk(page));
    evidence.requestId = requestId; evidence.runId = committed.view.id; evidence.queued = queued; evidence.completed = completed; evidence.businessFacts = before;
  } catch (error) { failure = error; try { evidence.failedDom = await failedSelectionDiagnostic(page); } catch { evidence.failedDomUnavailable = true; } }
  await finish(page, info, fixture, seen, evidence, failure);
});
