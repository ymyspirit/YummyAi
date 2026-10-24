import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { AdAnalysisRunSchema, AdCommitImportResultSchema, AdFactPageSchema, AdGoalFieldsSchema,
  AdImportPreviewSchema, AdvertisingWorkspaceSchema } from "@yummyai/contracts/advertising";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_MEASUREMENT_ISOLATED !== "1" ||
  process.env.WEB_AUTH_MODE !== "personal" || !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce ||
  process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Advertising measurement browser requires its matching personal disposable runner before connection");
const endpoint = "/api/advertising/", apiBase = process.env.API_BASE_URL!.replace(/\/$/, "");
const key = () => `SYNTHETIC-MEASURE-${randomUUID().toUpperCase()}`;
const header = "Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Spend";
const row = "2026-09-01 - 2026-09-15,synthetic-measurement,SP,campaign,group,USD,1000,40,10.00";
type Csv = { name: string; content: string };
test.setTimeout(180_000);

async function api(path: string, body: unknown) {
  const response = await fetch(`${apiBase}/v1/${path}`, { method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof value?.code === "string" && /^[a-z_]{1,110}$/.test(value.code) ? value.code : "unavailable";
    throw new Error(`Synthetic advertising measurement ${response.status} ${path} ${code}`);
  }
  return response.json() as Promise<unknown>;
}
async function account() {
  const value = await api("marketplace-accounts", { platform: "amazon", displayName: key(), region: "NA",
    authorizationMode: "amazon_private", marketplaceIds: ["ATVPDKIKX0DER"], requestedScopes: [] }) as { id: string };
  await api("advertising/goals", { scope: { accountId: value.id, marketplace: "US", currency: "USD", asin: "B012345678" },
    expectedRevision: 0, fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2000,
      unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null,
      trialSpendLimitMinor: null, minimumPurchases: 2 }), idempotencyKey: key() });
  return value.id;
}
async function savedRights() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic advertising measurement role missing");
    return [...row.permissions];
  } finally { await database.client.end(); }
}
async function ready(page: Page, accountId: string) {
  await expect(page.getByRole("heading", { name: "广告与 VOC", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "广告店铺", exact: true })).toHaveValue(accountId);
  await expect(page.getByRole("button", { name: "重新读取广告工作区", exact: true })).toBeEnabled();
}
async function localTime(page: Page, at: string) {
  return page.evaluate(value => {
    const time = new Date(value), input = document.createElement("input"); input.type = "datetime-local";
    input.value = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return input.value;
  }, at);
}
async function importPanel(page: Page, files: Csv[], options: { at: string; window?: string; model?: "click" | "unknown"; partial?: boolean }) {
  const panel = page.getByRole("region", { name: "导入广告 CSV", exact: true });
  if (!(await panel.count())) await page.getByRole("button", { name: "导入 CSV", exact: true }).click();
  await expect(panel).toBeVisible();
  const reset = panel.getByRole("button", { name: "准备导入另一批报表", exact: true });
  if (await reset.count()) await reset.click();
  await panel.getByLabel("选择 CSV 文件", { exact: true }).setInputFiles(files.map(file => ({ name: file.name, mimeType: "text/csv", buffer: Buffer.from(file.content) })));
  await expect(panel.getByRole("button", { name: "解析并预览", exact: true })).toBeEnabled();
  await panel.getByLabel("报告时区", { exact: true }).fill("America/Los_Angeles");
  await panel.getByLabel("下载／采集时间", { exact: true }).fill(await localTime(page, options.at));
  await panel.getByLabel("归因天数（未知则留空）", { exact: true }).fill(options.window ?? "");
  await panel.getByRole("combobox", { name: "归因方式", exact: true }).selectOption(options.model === "click" ? "click" : "unknown");
  await panel.getByRole("combobox", { name: "转化指标定义", exact: true }).selectOption(options.model ?? "unknown");
  await panel.getByLabel("指标定义核对依据", { exact: true }).fill(options.model === "click" ? "Synthetic original report settings explicitly confirm click attribution" : "");
  await panel.getByLabel("缺失站点时的明确映射", { exact: true }).fill("USD=US\nCAD=CA");
  await panel.getByRole("checkbox", { name: "保留可用行并隔离错误行（先核对预览诊断）", exact: true }).setChecked(options.partial ?? false);
  return panel;
}
async function responseTo(page: Page, button: Locator, path: string) {
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await expect(button).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === `${endpoint}${path}` && value.request().method() === "POST", { timeout: 15_000 }), button.click()]);
  expect(response.status()).toBe(201); return response;
}
async function preview(page: Page, panel: Locator) {
  const response = await responseTo(page, panel.getByRole("button", { name: "解析并预览", exact: true }), "imports/preview");
  await expect(panel.getByRole("region", { name: "导入预览", exact: true })).toBeVisible();
  return AdImportPreviewSchema.parse(await response.json());
}
async function commit(page: Page, panel: Locator) {
  const response = await responseTo(page, panel.getByRole("button", { name: "确认导入已预览报表", exact: true }), "imports");
  const value = AdCommitImportResultSchema.parse(await response.json());
  await expect(panel.getByRole("region", { name: "报表导入已登记", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新读取广告工作区", exact: true })).toBeEnabled();
  return { value, original: JSON.parse(response.request().postData()!) as { files: Array<{ metricColumns?: Record<string, string | null> }>; observedAt: string } };
}
async function analyze(page: Page) {
  return AdAnalysisRunSchema.parse(await (await responseTo(page, page.getByRole("button", { name: "运行分析", exact: true }), "analyses")).json());
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const region of await page.locator(".ad-workbench, .ad-drawer").all())
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
function observe(page: Page) {
  const writes: string[] = [], errors: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith(endpoint) && request.method() === "POST") writes.push(path); });
  page.on("pageerror", error => errors.push(error.message)); return { writes, errors };
}
const singleWindowBundle = (): Csv[] => [
  { name: `${key()}-campaign.csv`, content: `${header},7 Day Total Orders (#),7 Day Total Sales ($)\n${row},2,100.00` },
  { name: `${key()}-product.csv`, content: `${header},Advertised ASIN,7 Day Total Orders (#),7 Day Total Sales ($)\n${row},B012345678,2,100.00` },
  { name: `${key()}-search.csv`, content: `${header},Customer Search Term,7 Day Total Orders (#),7 Day Total Sales ($)\n${row},unrelated synthetic term,0,0.00` },
];

test("personal measurement selection fixes fourteen-day columns in each real source and preserves two search terms and original analysis pins", async ({ page }, info) => {
  const originalRights = await savedRights(), id = await account(), observed = observe(page);
  const windows = "7 Day Total Orders (#),14 Day Total Orders (#),7 Day Total Sales ($),14 Day Total Sales ($)";
  const files: Csv[] = [
    { name: `${key()}-campaign.csv`, content: `${header},${windows}\n${row},1,2,20.00,50.00` },
    { name: `${key()}-product.csv`, content: `${header},Advertised ASIN,${windows}\n${row},B012345678,1,2,20.00,50.00` },
    { name: `${key()}-search.csv`, content: `${header},Targeting,Customer Search Term,${windows}\n${row},custom pillow,custom dog pillow,1,2,20.00,50.00\n${row},custom pillow,custom cat pillow,0,0,0.00,0.00` },
  ];
  try {
    await changeErpRights("readonly", [...new Set([...originalRights, Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview])]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", `/customer-intelligence?account=${id}&from=2026-09-01&to=2026-09-15&tab=imports`); await ready(page, id);
    const panel = await importPanel(page, files, { at: "2026-10-01T18:00:00.000Z", window: "14", model: "click" });
    const ambiguous = await preview(page, panel);
    expect(ambiguous.files.every(file => file.measurement?.conversion.state === "unresolved")).toBe(true);
    expect(ambiguous.files[2]!.reportType).toBe("search_term"); expect(ambiguous.files[2]!.acceptedRowCount).toBe(2);
    for (const file of files) {
      await panel.locator("summary").filter({ hasText: `${file.name} · 选择采用的指标列` }).click();
      await panel.getByRole("combobox", { name: `${file.name} 购买量采用列`, exact: true }).selectOption("column:14 Day Total Orders (#)");
      await expect(panel.getByRole("region", { name: "导入预览", exact: true })).toHaveCount(0);
      await panel.getByRole("combobox", { name: `${file.name} 归因销售额采用列`, exact: true }).selectOption("column:14 Day Total Sales ($)");
    }
    const resolved = await preview(page, panel);
    expect(resolved.canCommit).toBe(true);
    expect(resolved.files.every(file => file.measurement?.conversion.state === "resolved" && file.measurement.conversion.windowDays === 14)).toBe(true);
    const imported = await commit(page, panel);
    expect(imported.value.imports).toHaveLength(3);
    expect(imported.original.files.every(file => file.metricColumns?.purchases === "14 Day Total Orders (#)" && file.metricColumns.salesMinor === "14 Day Total Sales ($)")).toBe(true);
    expect(imported.original.observedAt).toBe("2026-10-01T18:00:00.000Z");
    const response = await page.request.get(`${endpoint}facts?accountId=${id}&page=1&pageSize=50`); expect(response.status()).toBe(200);
    const facts = AdFactPageSchema.parse(await response.json()); expect(facts.count).toBe(4);
    expect(facts.rows.filter(value => value.fact.reportType === "search_term").map(value => value.fact.term).sort()).toEqual(["custom cat pillow", "custom dog pillow"]);
    expect(facts.rows.find(value => value.fact.reportType === "advertised_product")!.fact.metrics).toMatchObject({ purchases: 2, salesMinor: 5000 });
    const run = await analyze(page);
    expect(run.result.measurementVersion).toBe(1); expect(run.result.selectedFactCount).toBe(4);
    expect(run.result.totals[0]!.metrics).toMatchObject({ purchases: 2, salesMinor: 5000, spendMinor: 1000 });
    expect(run.result.recommendations.some(value => value.kind === "negate_term" && value.term === "custom cat pillow")).toBe(true);
    await page.getByRole("button", { name: "每日复盘", exact: true }).click();
    await page.locator("summary").filter({ hasText: "本次封存的版本与来源依据" }).click();
    const pins = page.getByRole("region", { name: "本次封存测量依据", exact: true });
    await expect(pins).toContainText("14 Day Total Orders (#)"); await expect(pins).toContainText("14 Day Total Sales ($)");
    await expect(pins).toContainText("iso4217-2026-09-17-v1"); await expect(pins).toContainText("2026-10-01T18:00:00.000Z");
    for (const source of imported.value.imports) await expect(pins).toContainText(source.id);
    await pins.scrollIntoViewIfNeeded(); await expect(pins).toBeInViewport();
    await noOverflow(page); await page.screenshot({ path: info.outputPath("advertising-measurement-fixed-desktop.png"), fullPage: false, animations: "disabled" });
    const mutationCount = observed.writes.length;
    const source = imported.value.imports.find(value => value.fileName === files[2]!.name)!;
    const download = await page.request.get(`${endpoint}imports/${source.id}/source`); expect(download.status()).toBe(200);
    expect(createHash("sha256").update(await download.body()).digest("hex")).toBe(createHash("sha256").update(files[2]!.content).digest("hex"));
    const workspace = AdvertisingWorkspaceSchema.parse(await (await page.request.get(`${endpoint}workspace?accountId=${id}`)).json());
    expect(workspace.analyses.find(value => value.id === run.id)?.result).toEqual(run.result);
    expect(observed.writes.length).toBe(mutationCount); expect(observed.errors).toEqual([]);
  } finally { await changeErpRights("readonly", originalRights); }
});

test("personal measurement diagnostics preserve unknown source cells block conflicting windows and require actual mature recollection", async ({ page }, info) => {
  const originalRights = await savedRights(), id = await account(), observed = observe(page);
  try {
    await changeErpRights("readonly", [...new Set([...originalRights, Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview])]);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginErp(page, "readonly", `/customer-intelligence?account=${id}&from=2026-09-01&to=2026-09-15&tab=imports`); await ready(page, id);
    const unknownFile = { name: `${key()}-unknown.csv`, content: `${header},Purchases,Sales\n${row.replace(",USD,", ",ZZZ,")},2,123.456` };
    let panel = await importPanel(page, [unknownFile], { at: "2026-10-01T18:00:00.000Z", model: "unknown" });
    const unknown = await preview(page, panel);
    expect(unknown.canCommit).toBe(true); expect(unknown.files[0]!.sample[0]).toMatchObject({ currency: "ZZZ", metrics: { clicks: 40, spendMinor: null, salesMinor: null }, sourceFields: { Spend: "10.00", Sales: "123.456" } });
    await panel.locator("summary").filter({ hasText: `${unknownFile.name} · 字段与诊断` }).click();
    const previewRegion = panel.getByRole("region", { name: "导入预览", exact: true });
    await expect(previewRegion).toContainText("ZZZ"); await expect(previewRegion).toContainText("未");
    await previewRegion.scrollIntoViewIfNeeded(); await expect(previewRegion).toBeInViewport(); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("advertising-measurement-unknown-mobile.png"), fullPage: false, animations: "disabled" });
    await commit(page, panel);
    const conflictFile = { name: `${key()}-conflict.csv`, content: `${header},7 Day Total Orders (#),14 Day Total Sales ($)\n${row},1,50.00` };
    panel = await importPanel(page, [conflictFile], { at: "2026-10-01T18:00:00.000Z", window: "7", model: "click", partial: true });
    const conflict = await preview(page, panel);
    expect(conflict.canCommit).toBe(false); expect(conflict.files[0]!.measurement?.conversion.state).toBe("conflict");
    expect(conflict.files[0]!.diagnostics.map(value => value.code)).toContain("CONVERSION_WINDOW_CONFLICT");
    await expect(panel.getByRole("button", { name: "确认导入已预览报表", exact: true })).toBeDisabled();
    expect(observed.writes.filter(path => path === `${endpoint}imports`)).toHaveLength(1);
    const files = singleWindowBundle();
    panel = await importPanel(page, files, { at: "2026-09-16T18:00:00.000Z", window: "7", model: "click" });
    expect((await preview(page, panel)).canCommit).toBe(true);
    const immature = await commit(page, panel); expect(immature.original.observedAt).toBe("2026-09-16T18:00:00.000Z");
    const first = await analyze(page);
    expect(first.result.recommendations.some(value => value.kind === "negate_term")).toBe(false);
    expect(first.result.recommendations.some(value => value.ruleId === "AD_ATTRIBUTION_PENDING")).toBe(true);
    panel = await importPanel(page, files, { at: "2026-09-24T18:00:00.000Z", window: "7", model: "click" });
    expect((await preview(page, panel)).canCommit).toBe(true);
    const recollected = await commit(page, panel);
    expect(recollected.value.imports.map(value => value.checksum)).toEqual(immature.value.imports.map(value => value.checksum));
    expect(recollected.value.imports.map(value => value.id)).not.toEqual(immature.value.imports.map(value => value.id));
    const mature = await analyze(page);
    expect(mature.result.recommendations.some(value => value.kind === "negate_term")).toBe(true);
    const workspaceReply = await page.request.get(`${endpoint}workspace?accountId=${id}`); expect(workspaceReply.status()).toBe(200);
    const workspace = AdvertisingWorkspaceSchema.parse(await workspaceReply.json());
    expect(workspace.analyses.find(value => value.id === first.id)?.result).toEqual(first.result);
    expect(workspace.imports).toHaveLength(7);
    await noOverflow(page); expect(observed.errors).toEqual([]);
  } finally { await changeErpRights("readonly", originalRights); }
});
