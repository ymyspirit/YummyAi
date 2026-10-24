import { createHash, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { AdActionViewSchema, AdAnalysisRunSchema, AdCommitImportResultSchema, AdExportViewSchema, AdGoalVersionSchema, AdImportInputSchema,
  AdImportPreviewSchema, AdImportViewSchema, AdObservationSchema, AdvertisingWorkspaceSchema } from "@yummyai/contracts/advertising";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_AUTHORITY_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Advertising authority browser requires its dedicated personal disposable runner before connection");
const apiBase = process.env.API_BASE_URL!.replace(/\/$/, ""), endpoint = "/api/advertising/", at = "2026-09-16T18:00:00.000Z";
const key = () => `SYNTHETIC-AD-${randomUUID().toUpperCase()}`;
const adPermissions: readonly string[] = [Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview];
const rights = (original: string[], ...granted: string[]) => [...new Set([...original.filter(value => !adPermissions.includes(value)), ...granted])];
const headers = "日期范围,广告主账户 ID,广告产品,广告活动编号,广告组编号,预算货币,展示量,点击量,购买量,总成本,销售额";
const row = "2026年09月01日 - 2026年09月15日,synthetic,SP,campaign,group,USD,1000,40,4,10,40";
const files = (label: string) => [
  { fileName: `${label}-campaign.csv`, content: `${headers}\n${row}` },
  { fileName: `${label}-product.csv`, content: `${headers},推广的商品编号\n${row},B012345678` },
  { fileName: `${label}-target.csv`, content: `${headers},投放方案编号,投放方案,目标竞价,投放状态\n${row},target,custom pillow,1,ENABLED` },
];
test.setTimeout(180_000);
async function api(path: string, body?: unknown) {
  const response = await fetch(`${apiBase}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof value?.code === "string" && /^[a-z_]{1,110}$/.test(value.code) ? value.code : "unavailable";
    throw new Error(`Synthetic advertising fixture ${response.status} ${path} ${code}`);
  }
  return response.json() as Promise<unknown>;
}
async function account(label = key()) {
  const value = await api("marketplace-accounts", { platform: "amazon", displayName: label, region: "NA", authorizationMode: "amazon_private", marketplaceIds: ["ATVPDKIKX0DER"], requestedScopes: [] }) as { id: string };
  return value.id;
}
async function seedReports(label: string) {
  const id = await account(label), original = AdImportInputSchema.parse({ accountId: id, files: files(label), marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
    attributionWindowDays: 7, attributionBasis: "click", observedAt: at, idempotencyKey: key() });
  const preview = AdImportPreviewSchema.parse(await api("advertising/imports/preview", original)); expect(preview.canCommit).toBe(true);
  const saved = AdCommitImportResultSchema.parse(await api("advertising/imports", { ...original, previewChecksum: preview.previewChecksum }));
  return { id, original, saved };
}
async function savedRights(accountName: "readonly" | "outsider" = "readonly") {
  const actor = actors()[accountName], database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic advertising role missing"); return [...row.permissions];
  } finally { await database.client.end(); }
}
async function outsiderRights(granted: string[]) {
  const actor = actors().outsider, database = connectDatabase();
  try {
    const updated = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx => tx.update(roles).set({ permissions: granted }).where(eq(roles.id, actor.roleId)).returning({ id: roles.id }));
    if (updated.length !== 1) throw new Error("Synthetic foreign advertising role missing");
  } finally { await database.client.end(); }
}
async function clickResponse(page: Page, button: Locator, path: string, method = "POST") {
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await expect(button).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === `${endpoint}${path}` && value.request().method() === method, { timeout: 15_000 }), button.click()]);
  return response;
}
async function ready(page: Page, accountId: string) {
  await expect(page.getByRole("heading", { name: "广告与 VOC", exact: true })).toBeVisible();
  await expect(page.getByLabel("广告店铺", { exact: true })).toHaveValue(accountId);
  await expect(page.getByRole("button", { name: "重新读取广告工作区", exact: true })).toBeEnabled();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const region of await page.locator(".ad-workbench, .ad-drawer, .ad-independent").all())
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith(endpoint) && request.method() === "POST") writes.push(path); });
  page.on("pageerror", error => errors.push(error.message)); return { writes, errors };
}
/** Only real successful responses are delayed. Every gate is released in finally. */
async function delayOne(page: Page, path: string, method: "GET" | "POST", matches: (url: URL) => boolean) {
  const pattern = `${page.url().split("/").slice(0, 3).join("/")}${endpoint}${path}*`;
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  let started = false, finished = false, closed = false, phase: "fetch" | "fulfill" = "fetch", failure: unknown;
  let captured: { status: number; value: unknown } | undefined;
  const handler = async (route: Route) => {
    if (started || route.request().method() !== method || !matches(new URL(route.request().url()))) { await route.continue(); return; }
    started = true;
    try {
      const response = await route.fetch({ timeout: 15_000 }); captured = { status: response.status(), value: await response.json() };
      await released; phase = "fulfill";
      try { await route.fulfill({ response }); } catch (error) {
        // Switching account or revoking permission deliberately aborts this exact
        // old client request. A different fetch/fulfill failure remains a failure.
        if (!route.request().failure()) throw error;
      }
    } catch (error) { failure = error; } finally { finished = true; }
  };
  await page.route(pattern, handler);
  return { captured: () => captured, release,
    async close() {
      if (closed) return; closed = true; release();
      try { if (started) await expect.poll(() => finished, { timeout: 15_000 }).toBe(true); }
      finally { await page.unroute(pattern, handler); }
      if (failure) throw new Error(`Synthetic advertising delayed response failed during ${phase}`);
    } };
}
async function productScope(page: Page, accountId: string, reviewing: boolean) {
  await page.getByRole("button", { name: "产品目标", exact: true }).click(); await ready(page, accountId);
  const region = page.getByRole("region", { name: "按明确产品范围登记", exact: true }), form = region.getByRole("form", { name: "核对登记产品范围", exact: true });
  await form.getByLabel("产品 ASIN", { exact: true }).fill("B012345678"); await form.getByRole("combobox", { name: "产品站点", exact: true }).selectOption("US");
  await form.getByLabel("产品币种", { exact: true }).fill("USD"); if (reviewing) await form.getByLabel("当前目标版本 新产品填 0", { exact: true }).fill("0");
  await form.getByRole("button", { name: "核对产品范围", exact: true }).click(); return region;
}

test("a real personal reader inspects immutable CSV pins, rejects foreign tenancy, and never refills late account or revoked private data", async ({ page }, info) => {
  const original = await savedRights(), originalForeign = await savedRights("outsider"), a = await seedReports(key()), b = await seedReports(key());
  const gates: Awaited<ReturnType<typeof delayOne>>[] = []; let foreignContext: BrowserContext | undefined; const observed = observe(page);
  try {
    await changeErpRights("readonly", rights(original, Permission.CustomerIntelligenceRead)); await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", `/customer-intelligence?account=${a.id}&tab=imports`); await ready(page, a.id);
    const table = page.getByRole("table", { name: "广告导入历史", exact: true }); await expect(table).toContainText(a.original.files[0]!.fileName);
    await expect(table).toContainText("America/Los_Angeles"); await expect(table).toContainText("7 天 · click");
    await expect(page.getByRole("button", { name: "导入 CSV", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "运行分析", exact: true })).toHaveCount(0);
    const row = table.getByRole("row").filter({ hasText: a.original.files[0]!.fileName }); await expect(row).toHaveCount(1);
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), row.getByRole("link", { name: "原文件", exact: true }).click()]);
    expect(await download.failure()).toBeNull(); await download.saveAs(info.outputPath("synthetic-reader-original.csv"));
    const source = await page.request.get(`${endpoint}imports/${a.saved.imports[0]!.id}/source`); expect(source.status()).toBe(200);
    expect(createHash("sha256").update(await source.body()).digest("hex")).toBe(a.saved.imports[0]!.checksum);
    expect((await page.request.post(`${endpoint}imports/preview`, { headers: { origin: new URL(page.url()).origin }, data: AdImportInputSchema.parse(a.original) })).status()).toBe(403);
    await table.scrollIntoViewIfNeeded(); await expect(table).toBeVisible(); await noOverflow(page); await page.screenshot({ path: info.outputPath("advertising-reader-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce" }); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("advertising-reader-mobile.png"), fullPage: true });

    // Native same-path navigation keeps the mounted workbench. URL intent must
    // select and read the real account instead of retaining its old useState.
    const navigateAccount = async (accountId: string) => {
      const [response] = await Promise.all([
        page.waitForResponse(value => { const url = new URL(value.url()); return value.request().method() === "GET" && url.pathname === `${endpoint}workspace` && url.searchParams.get("accountId") === accountId; }, { timeout: 15_000 }),
        page.evaluate(target => { const url = new URL(window.location.href); url.searchParams.set("account", target); url.searchParams.set("tab", "imports"); window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`); }, accountId),
      ]);
      expect(response.status()).toBe(200); const value = AdvertisingWorkspaceSchema.parse(await response.json()); expect(value.accountId).toBe(accountId);
      await expect(page).toHaveURL(url => url.pathname === "/customer-intelligence" && url.searchParams.get("account") === accountId);
      await ready(page, accountId); return value;
    };
    const navigated = await navigateAccount(b.id);
    expect(navigated.imports.map(item => item.id).sort()).toEqual(b.saved.imports.map(item => item.id).sort());
    await expect(table).toContainText(b.original.files[0]!.fileName); await expect(table).not.toContainText(a.original.files[0]!.fileName);
    await navigateAccount(a.id); await expect(table).toContainText(a.original.files[0]!.fileName); await expect(table).not.toContainText(b.original.files[0]!.fileName);

    const accountDelay = await delayOne(page, "workspace", "GET", url => url.searchParams.get("accountId") === a.id); gates.push(accountDelay);
    await page.getByRole("button", { name: "重新读取广告工作区", exact: true }).click();
    await expect.poll(() => accountDelay.captured()?.status, { timeout: 15_000 }).toBe(200);
    expect(AdvertisingWorkspaceSchema.parse(accountDelay.captured()!.value).accountId).toBe(a.id);
    await page.getByLabel("广告店铺", { exact: true }).selectOption(b.id); await ready(page, b.id); await expect(table).toContainText(b.original.files[0]!.fileName);
    await accountDelay.close(); await expect(table).not.toContainText(a.original.files[0]!.fileName);

    await outsiderRights(rights(originalForeign, Permission.CustomerIntelligenceRead));
    const browser = page.context().browser(); if (!browser) throw new Error("Synthetic advertising browser missing");
    foreignContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3130" }); const foreignPage = await foreignContext.newPage();
    await loginErp(foreignPage, "outsider", "/products");
    expect((await foreignPage.request.get(`${endpoint}workspace?accountId=${a.id}`)).status()).toBe(404);
    expect((await foreignPage.request.get(`${endpoint}imports/${a.saved.imports[0]!.id}/source`)).status()).toBe(404);

    const revokedDelay = await delayOne(page, "workspace", "GET", url => url.searchParams.get("accountId") === b.id); gates.push(revokedDelay);
    await page.getByRole("button", { name: "重新读取广告工作区", exact: true }).click(); await expect.poll(() => revokedDelay.captured()?.status, { timeout: 15_000 }).toBe(200);
    await changeErpRights("readonly", rights(original)); expect((await page.request.get(`${endpoint}workspace?accountId=${b.id}`)).status()).toBe(403);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await revokedDelay.close();
    await expect(page.getByRole("table", { name: "广告导入历史", exact: true })).toHaveCount(0);
    await expect(page.getByText(b.original.files[0]!.fileName, { exact: true })).toHaveCount(0); await expect(page.getByText(a.original.files[0]!.fileName, { exact: true })).toHaveCount(0);
    // page.request is a separate APIRequestContext: its explicit 403 probe is
    // asserted above, while the actual Read-only page must issue zero mutations.
    expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
  } finally {
    try { for (const gate of gates) await gate.close(); }
    finally { try { await foreignContext?.close(); } finally { try { await outsiderRights(originalForeign); } finally { await changeErpRights("readonly", original); } } }
  }
});

test("a Write-only personal operator discards a late preview, retries the exact lost import, and keeps a successful archive separate from refresh failure", async ({ page }, info) => {
  const original = await savedRights(), a = await account(key()), b = await account(key()), label = key(), source = files(label)[0]!;
  const gates: Awaited<ReturnType<typeof delayOne>>[] = [], observed = observe(page);
  let commitRoute: ((route: Route) => Promise<void>) | undefined, refreshRoute: ((route: Route) => Promise<void>) | undefined, archiveRoute: ((route: Route) => Promise<void>) | undefined;
  let activeHandlers = 0, routeFailure = false, archivePattern = "";
  const commits: Array<{ body: string; status: number; value: unknown }> = [];
  try {
    await changeErpRights("readonly", rights(original, Permission.CustomerIntelligenceWrite));
    await loginErp(page, "readonly", `/customer-intelligence?account=${a}&tab=imports`); await ready(page, a);
    await expect(page.getByRole("table", { name: "广告导入历史", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "运行分析", exact: true })).toHaveCount(0);
    const panel = page.getByRole("region", { name: "导入广告 CSV", exact: true });
    const choose = async () => {
      await panel.getByLabel("选择 CSV 文件", { exact: true }).setInputFiles({ name: source.fileName, mimeType: "text/csv", buffer: Buffer.from(source.content) });
      await panel.getByLabel("报告时区", { exact: true }).fill("America/Los_Angeles"); await panel.getByLabel("归因天数（未知则留空）", { exact: true }).fill("7");
      await panel.getByLabel("归因方式", { exact: true }).selectOption("click"); await panel.getByLabel("缺失站点时的明确映射", { exact: true }).fill("USD=US");
      await expect(panel.getByRole("button", { name: "解析并预览", exact: true })).toBeEnabled();
    };
    await choose(); const previewDelay = await delayOne(page, "imports/preview", "POST", () => true); gates.push(previewDelay);
    await panel.getByRole("button", { name: "解析并预览", exact: true }).click(); await expect.poll(() => previewDelay.captured()?.status, { timeout: 15_000 }).toBe(201);
    page.once("dialog", dialog => dialog.accept()); await page.getByLabel("广告店铺", { exact: true }).selectOption(b); await ready(page, b); await previewDelay.close();
    await expect(page.getByRole("region", { name: "导入预览", exact: true })).toHaveCount(0);
    expect(await panel.getByLabel("选择 CSV 文件", { exact: true }).evaluate((node: HTMLInputElement) => node.files?.length ?? 0)).toBe(0);
    await expect(panel.getByLabel("报告时区", { exact: true })).toHaveValue("");
    await page.getByLabel("广告店铺", { exact: true }).selectOption(a); await ready(page, a); await choose();
    expect((await clickResponse(page, panel.getByRole("button", { name: "解析并预览", exact: true }), "imports/preview")).status()).toBe(201);
    await expect(page.getByRole("region", { name: "导入预览", exact: true })).toContainText(source.fileName);
    commitRoute = async route => {
      activeHandlers++;
      try { const response = await route.fetch({ timeout: 15_000 }); commits.push({ body: route.request().postData()!, status: response.status(), value: await response.json() });
        if (commits.length === 1) await route.abort("failed"); else await route.fulfill({ response });
      } catch { routeFailure = true; } finally { activeHandlers--; }
    };
    await page.route(`**${endpoint}imports`, commitRoute);
    await panel.getByRole("button", { name: "确认导入已预览报表", exact: true }).click();
    await expect.poll(() => commits.length, { timeout: 15_000 }).toBe(1); expect(commits[0]!.status).toBe(201);
    const first = AdCommitImportResultSchema.parse(commits[0]!.value); expect(first.replayed).toBe(false);
    const retry = panel.getByRole("button", { name: "重试导入同一批原报表", exact: true }); await expect(retry).toBeEnabled();
    await expect(panel.getByText("原正文与原键已固定", { exact: true })).toBeVisible(); expect((await clickResponse(page, retry, "imports")).status()).toBe(201);
    await expect.poll(() => activeHandlers, { timeout: 15_000 }).toBe(0); expect(commits).toHaveLength(2); expect(commits[1]!.body).toBe(commits[0]!.body);
    expect(AdCommitImportResultSchema.parse(commits[1]!.value)).toEqual({ ...first, replayed: true }); expect(routeFailure).toBe(false);
    await page.unroute(`**${endpoint}imports`, commitRoute); commitRoute = undefined;
    const receipt = page.getByRole("region", { name: "本次导入来源回执", exact: true }); await expect(receipt).toContainText(first.imports[0]!.id);
    await expect(receipt).toContainText(first.imports[0]!.checksum); await expect(page.getByRole("table", { name: "广告导入历史", exact: true })).toHaveCount(0);
    const actual = AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${a}`)); expect(actual.imports.map(item => item.id)).toEqual(first.imports.map(item => item.id));
    expect((await page.request.get(`${endpoint}imports/${first.imports[0]!.id}/source`)).status()).toBe(403);

    let failRefresh = false, archived: unknown;
    refreshRoute = async route => { if (failRefresh) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic refresh unavailable" }) }); else await route.continue(); };
    archiveRoute = async route => { activeHandlers++; try { const response = await route.fetch({ timeout: 15_000 }); archived = await response.json(); failRefresh = true; await route.fulfill({ response }); } catch { routeFailure = true; } finally { activeHandlers--; } };
    archivePattern = `**${endpoint}imports/${first.imports[0]!.id}/archive`;
    await page.route(`**${endpoint}workspace*`, refreshRoute); await page.route(archivePattern, archiveRoute);
    await receipt.getByText(`归档本次导入来源 ${source.fileName}`, { exact: true }).click();
    const archiveForm = receipt.getByRole("form", { name: `归档来源 ${first.imports[0]!.id}`, exact: true });
    await archiveForm.getByLabel("归档原因", { exact: true }).fill("Synthetic duplicate export superseded, retain original bytes");
    expect((await clickResponse(page, archiveForm.getByRole("button", { name: "归档这份来源", exact: true }), `imports/${first.imports[0]!.id}/archive`)).status()).toBe(201);
    await expect(archiveForm.getByRole("region", { name: "原来源已归档", exact: true })).toContainText(first.imports[0]!.id);
    await expect(archiveForm.getByText("原操作已成功 后续工作区读取未完成 请重新读取 不要重复登记", { exact: true })).toBeVisible();
    expect(AdImportViewSchema.parse(archived).archivedAt).not.toBeNull(); await expect(archiveForm.getByRole("button", { name: "归档这份来源", exact: true })).toBeDisabled();
    failRefresh = false; await page.unroute(`**${endpoint}workspace*`, refreshRoute); refreshRoute = undefined;
    expect((await clickResponse(page, page.getByRole("button", { name: "重新读取广告工作区", exact: true }), "workspace", "GET")).status()).toBe(200);
    expect(observed.writes.filter(path => path.endsWith(`/imports/${first.imports[0]!.id}/archive`))).toHaveLength(1);
    expect((AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${a}`))).imports[0]!.archivedAt).not.toBeNull();
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await receipt.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("advertising-writer-receipt-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const independent = await productScope(page, a, false); await independent.getByLabel("采集日期", { exact: true }).fill("2026-09-08");
    await independent.getByLabel("关键词", { exact: true }).fill("custom pillow"); await independent.getByLabel("自然名次", { exact: true }).fill("8");
    await independent.getByLabel("证据来源说明", { exact: true }).fill("Synthetic public rank check, no external marketplace access");
    const observedReply = await clickResponse(page, independent.getByRole("button", { name: "保存证据", exact: true }), "observations"); expect(observedReply.status()).toBe(201);
    const recorded = AdObservationSchema.parse(await observedReply.json()); await expect(independent.getByRole("region", { name: "观察证据已登记", exact: true })).toContainText(recorded.id);
    expect(recorded.organicRank).toBe(8); expect(observed.errors).toEqual([]); expect(routeFailure).toBe(false);
  } finally {
    try { for (const gate of gates) await gate.close(); await expect.poll(() => activeHandlers, { timeout: 15_000 }).toBe(0); }
    finally {
      try { if (commitRoute) await page.unroute(`**${endpoint}imports`, commitRoute); }
      finally { try { if (archiveRoute) await page.unroute(archivePattern, archiveRoute); }
        finally { try { if (refreshRoute) await page.unroute(`**${endpoint}workspace*`, refreshRoute); } finally { await changeErpRights("readonly", original); } } }
    }
  }
});

test("a Review-only personal operator records a real goal, analysis and reviewed checklist without gaining report Read or Write and loses replay on current revocation", async ({ page }, info) => {
  const original = await savedRights(), seeded = await seedReports(key()), observed = observe(page);
  try {
    await changeErpRights("readonly", rights(original, Permission.CustomerIntelligenceReview)); await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", `/customer-intelligence?account=${seeded.id}&tab=goals&from=2026-09-01&to=2026-09-15`); await ready(page, seeded.id);
    await expect(page.getByRole("button", { name: "导入 CSV", exact: true })).toHaveCount(0); await expect(page.getByRole("table", { name: "广告导入历史", exact: true })).toHaveCount(0);
    const independent = await productScope(page, seeded.id, true);
    await independent.getByLabel("生效日期", { exact: true }).fill("2026-09-01"); await independent.getByLabel("目标 ACoS (%)", { exact: true }).fill("21");
    await independent.getByLabel("单件售价 (USD)", { exact: true }).fill("100"); await independent.getByLabel("单件广告前总成本 (USD)", { exact: true }).fill("70");
    await independent.getByLabel("成本来源与目标说明", { exact: true }).fill("Synthetic confirmed product and fulfillment economics, no model or advertising API call");
    const goalReply = await clickResponse(page, independent.getByRole("button", { name: "保存目标版本", exact: true }), "goals"); expect(goalReply.status()).toBe(201);
    const saved = AdGoalVersionSchema.parse(await goalReply.json()); expect(saved.revision).toBe(1);
    await expect(independent.getByRole("region", { name: "目标版本已登记", exact: true })).toContainText(saved.id);
    const analysisReply = await clickResponse(page, page.getByRole("button", { name: "运行分析", exact: true }), "analyses"); expect(analysisReply.status()).toBe(201);
    const calculated = AdAnalysisRunSchema.parse(await analysisReply.json()); expect(calculated.result.goalVersionIds).toContain(saved.id); expect(calculated.result.selectedFactCount).toBe(3);
    await expect(page.getByRole("region", { name: "分析已封存", exact: true })).toContainText(calculated.id);
    const projected = AdvertisingWorkspaceSchema.parse(await (await page.request.get(`${endpoint}workspace?accountId=${seeded.id}`)).json());
    expect(projected.access).toEqual({ canRead: false, canWrite: false, canReview: true });
    for (const name of ["imports", "goals", "observations", "actions", "analyses"] as const) expect(projected[name]).toEqual([]);
    expect((await page.request.get(`${endpoint}facts?accountId=${seeded.id}`)).status()).toBe(403);
    expect((await page.request.post(`${endpoint}imports/preview`, { headers: { origin: new URL(page.url()).origin }, data: AdImportInputSchema.parse(seeded.original) })).status()).toBe(403);
    // Known IDs come from this synthetic fixture's true owner read, rather than
    // granting the Review-only person arbitrary report or action history reads.
    const current = AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${seeded.id}`));
    const action = current.actions.find(item => item.recommendation.kind === "lower_bid" && item.runId === calculated.id); expect(action?.recommendation.proposedBidMinor).toBe(85);
    if (!action) throw new Error("Synthetic personal review candidate missing");
    const adoptedReply = await page.request.post(`${endpoint}actions/${action.id}/events`, { headers: { origin: new URL(page.url()).origin }, data: { expectedRevision: action.revision, expectedStatus: action.status, status: "adopted",
      reason: "Synthetic authorized manual review, no live advertising execution", idempotencyKey: key() } }); expect(adoptedReply.status()).toBe(201);
    expect(AdActionViewSchema.parse(await adoptedReply.json()).status).toBe("adopted");
    const sealedReply = await page.request.post(`${endpoint}exports`, { headers: { origin: new URL(page.url()).origin }, data: { runId: calculated.id, actionIds: [action.id], reviewReason: "Synthetic reviewed checklist only", idempotencyKey: key() } }); expect(sealedReply.status()).toBe(201);
    const sealed = AdExportViewSchema.parse(await sealedReply.json()); expect(sealed.payload.marketplaceExecution).toBe("manual"); expect(sealed.payload.actions[0]!.status).toBe("adopted");
    expect((await page.request.get(`${endpoint}exports/${sealed.id}`)).status()).toBe(403);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await page.screenshot({ path: info.outputPath("advertising-reviewer-mobile.png"), fullPage: true });
    await changeErpRights("readonly", rights(original));
    const originalGoalBody = JSON.parse(goalReply.request().postData()!);
    expect((await page.request.post(`${endpoint}goals`, { headers: { origin: new URL(page.url()).origin }, data: originalGoalBody })).status()).toBe(403);
    const denied = await clickResponse(page, page.getByRole("button", { name: "重新读取广告工作区", exact: true }), "workspace", "GET"); expect(denied.status()).toBe(403);
    await expect(page.getByRole("region", { name: "目标版本已登记", exact: true })).toHaveCount(0); await expect(page.getByRole("region", { name: "分析已封存", exact: true })).toHaveCount(0);
    await expect(page.getByText(saved.id, { exact: true })).toHaveCount(0); expect(observed.errors).toEqual([]);
  } finally { await changeErpRights("readonly", original); }
});
