import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { AdActionEventInputSchema, AdActionViewSchema, AdAnalysisRunSchema, AdCommitImportResultSchema,
  AdGoalFieldsSchema, AdGoalVersionSchema, AdImportInputSchema, AdImportPreviewSchema, AdvertisingWorkspaceSchema,
  type AdActionView, type AdAnalysisRun, type AdImportView } from "@yummyai/contracts/advertising";
import { AdHistoryPageSchema, AdHistoryRecordResultSchema, type AdHistoryKind } from "@yummyai/contracts/advertising/history";
import { connectDatabase, marketplaceAccounts, roles, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_HISTORY_ISOLATED !== "1" ||
  process.env.WEB_AUTH_MODE !== "personal" || !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce ||
  process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Advertising history browser requires its matching personal disposable runner before connection");

const endpoint = "/api/advertising/", apiBase = process.env.API_BASE_URL!.replace(/\/$/, "");
const key = () => `SYNTHETIC-HISTORY-${randomUUID().toUpperCase()}`;
const adRights: readonly string[] = [Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview];
const rights = (original: string[], ...granted: string[]) => [...new Set([...original.filter(value => !adRights.includes(value)), ...granted])];
const header = "Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Purchases,Spend,Sales";
const row = "2026-09-01 - 2026-09-15,synthetic-history,SP,campaign,group,USD,1000,40,4,10.00,40.00";
const files = (label: string) => [
  { fileName: `${label}-campaign.csv`, content: `${header}\n${row}` },
  { fileName: `${label}-product.csv`, content: `${header},Advertised ASIN\n${row},B012345678` },
  { fileName: `${label}-target.csv`, content: `${header},Targeting ID,Targeting,Bid,State\n${row},target,custom pillow,1.00,ENABLED` },
];
test.setTimeout(180_000);

async function api(path: string, body?: unknown) {
  const response = await fetch(`${apiBase}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof value?.code === "string" && /^[a-z_]{1,110}$/.test(value.code) ? value.code : "unavailable";
    throw new Error(`Synthetic advertising history ${response.status} ${path} ${code}`);
  }
  return response.json() as Promise<unknown>;
}
async function account() {
  const value = await api("marketplace-accounts", { platform: "amazon", displayName: key(), region: "NA", authorizationMode: "amazon_private",
    marketplaceIds: ["ATVPDKIKX0DER"], requestedScopes: [] }) as { id: string };
  return value.id;
}
async function commit(accountId: string, actualFiles = files(key())) {
  const input = AdImportInputSchema.parse({ accountId, files: actualFiles, marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
    attributionWindowDays: 7, attributionBasis: "click", conversionDefinition: { model: "click", source: "Synthetic original report confirms click attribution" },
    observedAt: "2026-10-01T18:00:00.000Z", allowPartial: false, idempotencyKey: key() });
  const preview = AdImportPreviewSchema.parse(await api("advertising/imports/preview", input)); expect(preview.canCommit).toBe(true);
  return AdCommitImportResultSchema.parse(await api("advertising/imports", { ...input, previewChecksum: preview.previewChecksum })).imports;
}
const analysis = (accountId: string) => ({ accountId, periodStart: "2026-09-01", periodEnd: "2026-09-15", marketplace: null,
  currency: null, evidenceCutoffAt: new Date().toISOString(), idempotencyKey: key() });
async function savedRights() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic advertising history role missing"); return [...row.permissions];
  } finally { await database.client.end(); }
}
async function roleScope(next?: "tenant" | "self" | "team"): Promise<"tenant" | "self" | "team"> {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => next ? tx.update(roles).set({ dataScope: next }).where(eq(roles.id, actor.roleId)).returning({ dataScope: roles.dataScope })
        : tx.select({ dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row || !["tenant", "self", "team"].includes(row.dataScope)) throw new Error("Synthetic history role scope missing");
    return row.dataScope as "tenant" | "self" | "team";
  } finally { await database.client.end(); }
}
async function assertAnotherAccountOwner(accountId: string) {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ createdBy: marketplaceAccounts.createdBy }).from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)));
    expect(row).toBeDefined(); expect(row!.createdBy).not.toBe(actor.userId);
  } finally { await database.client.end(); }
}
async function personal(page: Page, path: string, body?: unknown) {
  const response = body === undefined ? await page.request.get(`${endpoint}${path}`)
    : await page.request.post(`${endpoint}${path}`, { headers: { origin: new URL(page.url()).origin }, data: body });
  expect(response.status()).toBe(body === undefined ? 200 : 201); return response.json() as Promise<unknown>;
}
function observe(page: Page) {
  const writes: string[] = [], reads: string[] = [], errors: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname;
    if (path.startsWith(endpoint)) (request.method() === "POST" ? writes : reads).push(path); });
  page.on("pageerror", error => errors.push(error.message)); return { writes, reads, errors };
}
async function ready(page: Page, accountId: string) {
  await expect(page.getByRole("heading", { name: "广告与 VOC", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "广告店铺", exact: true })).toHaveValue(accountId);
  await expect(page.getByRole("button", { name: "重新读取广告工作区", exact: true })).toBeEnabled();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const region of await page.locator(".ad-workbench, .ad-history, .ad-history-detail").all())
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function clickGet(page: Page, button: Locator, accepts: (url: URL) => boolean) {
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await expect(button).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(value => value.request().method() === "GET" && accepts(new URL(value.url())), { timeout: 15_000 }), button.click()]);
  return response;
}
async function lookup(page: Page, kind: AdHistoryKind, recordId: string, parentId?: string) {
  const history = page.getByRole("region", { name: "广告完整历史", exact: true });
  await expect(history).toBeVisible();
  if (await history.getByRole("combobox", { name: "历史记录类型", exact: true }).inputValue() !== kind)
    await history.getByRole("combobox", { name: "历史记录类型", exact: true }).selectOption(kind);
  if (parentId) {
    await history.getByLabel("历史父记录 ID", { exact: true }).fill(parentId);
    await history.getByRole("button", { name: "应用父记录", exact: true }).click();
  }
  await history.getByLabel("广告原记录 ID", { exact: true }).fill(recordId);
  const response = await clickGet(page, history.getByRole("button", { name: "按原 ID 读取", exact: true }), url =>
    url.pathname === `${endpoint}records/${recordId}` && url.searchParams.get("kind") === kind);
  const value = response.status() === 200 ? AdHistoryRecordResultSchema.parse(await response.json()) : null;
  return { response, value, detail: history.getByRole("region", { name: "广告历史详情", exact: true }), history };
}
/** Delay exactly one genuine successful GET; all gates are released in finally. */
async function delayOne(page: Page, recordId: string) {
  const pattern = `**${endpoint}records/${recordId}?*`;
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  let captured: unknown, status: number | undefined, started = false, finished = false, failure = false, closed = false;
  const handler = async (route: Route) => {
    if (started) { await route.continue(); return; } started = true;
    try {
      const response = await route.fetch({ timeout: 15_000 }); status = response.status(); captured = await response.json();
      await released;
      try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; }
    } catch { failure = true; } finally { finished = true; }
  };
  await page.route(pattern, handler);
  return { captured: () => captured, status: () => status,
    async close() {
      if (closed) return; closed = true; release();
      try { if (started) await expect.poll(() => finished, { timeout: 15_000 }).toBe(true); }
      finally { await page.unroute(pattern, handler); }
      expect(failure).toBe(false);
    } };
}

test("a real Read-only person pages beyond 200 imports and ten analyses, opens original IDs, and rejects a late account or revoked history", async ({ page }, info) => {
  const originalRights = await savedRights(), originalScope = await roleScope(), gates: Awaited<ReturnType<typeof delayOne>>[] = [];
  const observed = observe(page);
  try {
    const a = await account(), b = await account(), imported: AdImportView[] = [], runs: AdAnalysisRun[] = [];
    expect(originalScope).toBe("tenant"); await assertAnotherAccountOwner(b);
    const allFiles = [...files(key()), ...Array.from({ length: 198 }, (_, index) => ({ fileName: `${key()}-${index}.csv`,
      content: `${header}\n${row.replace(",campaign,", `,campaign-${index},`)}` }))];
    for (let index = 0; index < allFiles.length; index += 20) imported.push(...await commit(a, allFiles.slice(index, index + 20)));
    expect(imported).toHaveLength(201);
    for (let index = 0; index < 11; index++) runs.push(AdAnalysisRunSchema.parse(await api("advertising/analyses", analysis(a))));
    const bSource = (await commit(b))[0]!, recent = AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${a}`));
    const oldImport = imported.find(value => !recent.imports.some(item => item.id === value.id));
    const oldRun = runs.find(value => !recent.analyses.some(item => item.id === value.id));
    expect(oldImport).toBeDefined(); expect(oldRun).toBeDefined();
    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceRead));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", `/customer-intelligence?account=${a}&tab=history&detail=history:imports:${oldImport!.id}`); await ready(page, a);
    const history = page.getByRole("region", { name: "广告完整历史", exact: true }), list = history.getByRole("region", { name: "广告历史记录", exact: true });
    const detail = history.getByRole("region", { name: "广告历史详情", exact: true });
    await expect(detail).toContainText(oldImport!.fileName); await expect(detail).toContainText(oldImport!.checksum);
    await expect(list).toContainText("本轮范围共 201 条");
    await expect(list.getByRole("button", { name: /^读取历史记录 / })).toHaveCount(25);
    expect(observed.reads).toContain(`${endpoint}records/${oldImport!.id}`);
    const firstIds = await list.getByRole("button", { name: /^读取历史记录 / }).evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")));
    const secondResponse = await clickGet(page, history.getByRole("button", { name: "读取下一页历史", exact: true }), url => url.pathname === `${endpoint}history` && url.searchParams.has("cursor"));
    const second = AdHistoryPageSchema.parse(await secondResponse.json()); expect(secondResponse.status()).toBe(200);
    expect(second.rows.some(item => firstIds.includes(`读取历史记录 ${item.id}`))).toBe(false);
    await expect(list).toContainText("第 2 个已读页");
    const original = await lookup(page, "analyses", oldRun!.id); expect(original.response.status()).toBe(200);
    expect(original.value?.record.value).toEqual(oldRun); await expect(original.detail).toContainText(oldRun!.inputChecksum);
    await original.detail.getByRole("button", { name: "载入此分析原结果", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "已读取的分析版本", exact: true })).toHaveValue(oldRun!.id);
    await expect(page).toHaveURL(url => url.searchParams.get("run") === oldRun!.id);
    await page.getByRole("button", { name: "完整历史", exact: true }).click();
    const restored = await lookup(page, "imports", oldImport!.id); expect(restored.response.status()).toBe(200);
    await restored.detail.scrollIntoViewIfNeeded(); await expect(restored.detail).toBeVisible(); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("advertising-history-reader-desktop.png"), fullPage: false });

    const delayed = await delayOne(page, oldImport!.id); gates.push(delayed);
    await restored.detail.getByRole("button", { name: "重新读取原记录", exact: true }).click();
    await expect.poll(delayed.status, { timeout: 15_000 }).toBe(200);
    expect(AdHistoryRecordResultSchema.parse(delayed.captured()).recordId).toBe(oldImport!.id);
    await page.getByRole("combobox", { name: "广告店铺", exact: true }).selectOption(b); await ready(page, b);
    await delayed.close();
    await expect(page.getByRole("region", { name: "广告历史详情", exact: true })).toHaveCount(0);
    const current = await lookup(page, "imports", bSource.id); expect(current.response.status()).toBe(200);
    await expect(current.detail).toContainText(bSource.fileName); await expect(current.detail).not.toContainText(oldImport!.fileName);
    await page.setViewportSize({ width: 390, height: 844 }); await current.detail.scrollIntoViewIfNeeded(); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("advertising-history-reader-mobile.png"), fullPage: false });

    // The real API-created account belongs to the fixture service actor, not
    // this person. Keep Read and narrow only its current scope: the same
    // previously successful path must now really return 404, not a fake 403.
    await roleScope("self");
    const narrowed = await clickGet(page, current.detail.getByRole("button", { name: "重新读取原记录", exact: true }), url =>
      url.pathname === `${endpoint}records/${bSource.id}` && url.searchParams.get("accountId") === b);
    expect(narrowed.status()).toBe(404);
    await expect(page.getByRole("region", { name: "广告历史详情", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "广告历史记录", exact: true }).getByRole("button", { name: /^读取历史记录 / })).toHaveCount(0);
    await expect(page.getByText(bSource.fileName, { exact: true })).toHaveCount(0);
    await expect(page.getByText(bSource.checksum, { exact: true })).toHaveCount(0);
    await roleScope(originalScope);
    await loginErp(page, "readonly", `/customer-intelligence?account=${b}&tab=history&detail=history:imports:${bSource.id}`); await ready(page, b);
    await expect(page.getByRole("region", { name: "广告历史详情", exact: true })).toContainText(bSource.fileName);
    await changeErpRights("readonly", rights(originalRights));
    await page.getByRole("button", { name: "重新读取广告工作区", exact: true }).click();
    await expect(page.getByRole("region", { name: "广告完整历史", exact: true })).toHaveCount(0);
    await expect(page.getByText(bSource.checksum, { exact: true })).toHaveCount(0);
    expect((await page.request.get(`${endpoint}records/${oldImport!.id}?accountId=${a}&kind=imports`)).status()).toBe(403);
    expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
  } finally {
    try { await Promise.all(gates.map(gate => gate.close())); }
    finally { try { await roleScope(originalScope); } finally { await changeErpRights("readonly", originalRights); } }
  }
});

test("a fresh Review-only person restores only an owned action, retries its lost event once, and retains the actual thirty-day rule and all parent events", async ({ page }, info) => {
  const originalRights = await savedRights(); let fresh: BrowserContext | undefined, routeFailure = false;
  let activeHandlers = 0, routeHandler: ((route: Route) => Promise<void>) | undefined;
  let reviewPage: Page | undefined, routePattern = "";
  const receipts: Array<{ body: string; status: number; value: unknown }> = [];
  try {
    const a = await account(); await commit(a);
    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceReview));
    await loginErp(page, "readonly", `/customer-intelligence?account=${a}&tab=history`); await ready(page, a);
    const goal = AdGoalVersionSchema.parse(await personal(page, "goals", { scope: { accountId: a, marketplace: "US", currency: "USD", asin: "B012345678" },
      expectedRevision: 0, fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100,
        unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null,
        trialSpendLimitMinor: null, cooldownDays: 30 }), idempotencyKey: key() }));
    const runs: AdAnalysisRun[] = [];
    for (let index = 0; index < 11; index++) runs.push(AdAnalysisRunSchema.parse(await personal(page, "analyses", analysis(a))));
    const actions = AdHistoryPageSchema.parse(await personal(page, `history?${new URLSearchParams({ accountId: a, kind: "actions", pageSize: "100" })}`));
    let action: AdActionView | undefined;
    for (const candidate of actions.rows) {
      const value = AdHistoryRecordResultSchema.parse(await personal(page, `records/${candidate.id}?${new URLSearchParams({ accountId: a, kind: "actions" })}`));
      if (value.record.kind === "actions" && value.record.value.recommendation.kind === "lower_bid") { action = value.record.value; break; }
    }
    if (!action) throw new Error("Synthetic personally owned bid action missing");
    for (let index = 0; index < 26; index++) action = AdActionViewSchema.parse(await personal(page, `actions/${action.id}/events`, AdActionEventInputSchema.parse({
      expectedRevision: action.revision, expectedStatus: action.status, status: index % 2 ? "pending" : "deferred",
      reason: `Synthetic own history event ${index}`, idempotencyKey: key() })));
    const foreignRun = AdAnalysisRunSchema.parse(await api("advertising/analyses", analysis(a)));
    const browser = page.context().browser(); if (!browser) throw new Error("Synthetic history browser missing");
    fresh = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3130", viewport: { width: 1440, height: 1000 } });
    reviewPage = await fresh.newPage(); const observed = observe(reviewPage);
    await loginErp(reviewPage, "readonly", `/customer-intelligence?account=${a}&tab=history&detail=history:actions:${action.id}`); await ready(reviewPage, a);
    const history = reviewPage.getByRole("region", { name: "广告完整历史", exact: true }), detail = history.getByRole("region", { name: "广告历史详情", exact: true });
    await expect(detail).toContainText("仅本人审核操作产生的记录");
    await expect(detail).toContainText("30 天 · 来自保存的原目标");
    await expect(detail).toContainText(goal.id); await expect(detail.locator(".ad-events li")).toHaveCount(action.events.length);
    await expect(detail.getByRole("button", { name: "下载原 CSV 来源", exact: true })).toHaveCount(0);
    expect((await reviewPage.request.get(`${endpoint}facts?accountId=${a}`)).status()).toBe(403);
    expect((await reviewPage.request.get(`${endpoint}records/${foreignRun.id}?accountId=${a}&kind=analyses`)).status()).toBe(404);
    const form = detail.locator("form.ad-form"), status = form.getByRole("combobox", { name: "记录处理结果", exact: true });
    await expect(detail.locator("fieldset.ad-history-record")).toBeEnabled();
    await expect(form.locator("fieldset")).not.toHaveAttribute("inert", "");
    await expect(form.getByRole("button", { name: "保存处理记录", exact: true })).toBeEnabled();
    await status.selectOption("deferred"); await form.getByLabel("处理原因", { exact: true }).fill("Synthetic UI same-key event after a fresh personal session");
    routePattern = `**${endpoint}actions/${action.id}/events`;
    routeHandler = async route => {
      activeHandlers++;
      try {
        const response = await route.fetch({ timeout: 15_000 }); receipts.push({ body: route.request().postData()!, status: response.status(), value: await response.json() });
        if (receipts.length === 1) await route.abort("failed"); else await route.fulfill({ response });
      } catch { routeFailure = true; } finally { activeHandlers--; }
    };
    await reviewPage.route(routePattern, routeHandler);
    await form.getByRole("button", { name: "保存处理记录", exact: true }).click();
    await expect.poll(() => receipts.length, { timeout: 15_000 }).toBe(1); expect(receipts[0]!.status).toBe(201);
    await expect.poll(() => activeHandlers, { timeout: 15_000 }).toBe(0);
    const retry = form.getByRole("button", { name: "重试同一笔处理记录", exact: true }); await expect(retry).toBeEnabled();
    await retry.click(); await expect.poll(() => receipts.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => activeHandlers, { timeout: 15_000 }).toBe(0);
    expect(receipts[1]!.status).toBe(201); expect(receipts[1]!.body).toBe(receipts[0]!.body);
    const committed = AdActionViewSchema.parse(receipts[0]!.value), replayed = AdActionViewSchema.parse(receipts[1]!.value);
    expect(replayed.events).toEqual(committed.events); expect(committed.events).toHaveLength(action.events.length + 1);
    action = committed;
    await expect(detail).toContainText(`V${action.revision}`); await expect(history).toContainText("下方是另一次受权读取的当前详情");
    await reviewPage.unroute(routePattern, routeHandler); routeHandler = undefined;
    const next = async (status: "pending" | "adopted" | "executed" | "observing") => {
      if (!action || !reviewPage) throw new Error("Synthetic own action missing");
      const executedAt = new Date(Math.max(Date.now(), Date.parse(action.createdAt) + 1)).toISOString();
      action = AdActionViewSchema.parse(await personal(reviewPage, `actions/${action.id}/events`, AdActionEventInputSchema.parse({
        expectedRevision: action.revision, expectedStatus: action.status, status, reason: `Synthetic actual ${status} evidence`, idempotencyKey: key(),
        ...(status === "executed" ? { executedAt, actualBeforeMinor: 100, actualAfterMinor: 85,
          executionCampaignId: action.recommendation.campaignId, executionAdGroupId: action.recommendation.adGroupId,
          executionTargetId: action.recommendation.targetId } : {}) })));
    };
    await next("pending"); await next("adopted"); await next("executed"); await next("observing");
    const current = await lookup(reviewPage, "actions", action.id); expect(current.response.status()).toBe(200);
    const due = new Date(Date.parse(action.executedAt!) + 30 * 86400000).toISOString();
    await expect(current.detail).toContainText(due); await expect(current.detail).toContainText("30 天 · 来自保存的原目标");
    await expect(current.detail.getByRole("button", { name: "保存处理记录", exact: true })).toBeDisabled();
    await expect(current.detail.locator(".ad-events li")).toHaveCount(action.events.length);
    await current.detail.getByRole("button", { name: "读取全部动作处理事件", exact: true }).click();
    const eventsList = history.getByRole("region", { name: "广告历史记录", exact: true });
    await expect(eventsList.getByRole("button", { name: /^读取历史记录 / })).toHaveCount(25);
    const first = await eventsList.getByRole("button", { name: /^读取历史记录 / }).evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")!.slice("读取历史记录 ".length)));
    const pageResponse = await clickGet(reviewPage, history.getByRole("button", { name: "读取下一页历史", exact: true }), url => url.pathname === `${endpoint}history` && url.searchParams.get("kind") === "action_events" && url.searchParams.has("cursor"));
    expect(pageResponse.status()).toBe(200); const last = AdHistoryPageSchema.parse(await pageResponse.json());
    expect(last.hasMore).toBe(false); expect([...first, ...last.rows.map(value => value.id)].sort()).toEqual(action.events.map(value => value.id).sort());
    await expect(eventsList.getByRole("button", { name: /^读取历史记录 / })).toHaveCount(action.events.length - 25);
    const earliest = action.events[0]!, event = await lookup(reviewPage, "action_events", earliest.id, action.id); expect(event.response.status()).toBe(200);
    await expect(event.detail).toContainText(earliest.reason);
    await reviewPage.setViewportSize({ width: 390, height: 844 }); await event.detail.scrollIntoViewIfNeeded(); await noOverflow(reviewPage);
    await reviewPage.screenshot({ path: info.outputPath("advertising-history-review-mobile.png"), fullPage: false });
    expect(observed.writes).toEqual([`${endpoint}actions/${action.id}/events`, `${endpoint}actions/${action.id}/events`]);
    expect(observed.errors).toEqual([]); expect(routeFailure).toBe(false);
    expect(runs.map(run => run.id)).toContain(action.runId);
  } finally {
    try {
      if (reviewPage && routeHandler) {
        try { await expect.poll(() => activeHandlers, { timeout: 15_000 }).toBe(0); }
        finally { await reviewPage.unroute(routePattern, routeHandler); }
      }
    } finally { try { await fresh?.close(); } finally { await changeErpRights("readonly", originalRights); } }
  }
});
