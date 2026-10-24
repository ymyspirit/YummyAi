import { createHash, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { AdCommitImportResultSchema, AdGoalFieldsSchema, AdGoalVersionSchema, AdImportInputSchema, AdImportPreviewSchema,
  AdObservationSchema, AdExportViewSchema, AdvertisingWorkspaceSchema } from "@yummyai/contracts/advertising";
import { AdCommandDetailSchema, AdCommandListSchema, AdCommandOriginalSchema, PrepareAdCommandSchema,
  type AdCommandDetail, type PrepareAdCommand } from "@yummyai/contracts/advertising/command";
import { AdHistoryRecordResultSchema } from "@yummyai/contracts/advertising/history";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ADVERTISING_COMMAND_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Advertising command browser requires its matching personal disposable runner before connection");

const endpoint = "/api/advertising/", commandEndpoint = `${endpoint}commands`, apiBase = process.env.API_BASE_URL!.replace(/\/$/, "");
const key = () => `SYNTHETIC-COMMAND-${randomUUID().toUpperCase()}`;
const adRights: readonly string[] = [Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceWrite, Permission.CustomerIntelligenceReview];
const rights = (original: string[], ...granted: string[]) => [...new Set([...original.filter(value => !adRights.includes(value)), ...granted])];
const confirm = "我已核对原填写 真实来源 固定版本与观察期 明确执行此原提交";
const header = "Date range,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Purchases,Spend,Sales";
const row = "2026-09-01 - 2026-09-15,synthetic-command,SP,campaign,group,USD,1000,40,4,10.00,40.00";
const files = (label: string) => [
  { fileName: `${label}-campaign.csv`, content: `${header}\r\n${row}\r\n` },
  { fileName: `${label}-product.csv`, content: `${header},Advertised ASIN\r\n${row},B012345678\r\n` },
  { fileName: `${label}-target.csv`, content: `${header},Targeting ID,Targeting,Bid,State\r\n${row},target,custom pillow,1.00,ENABLED\r\n` },
];
test.setTimeout(180_000);

async function api(path: string, body?: unknown) {
  const response = await fetch(`${apiBase}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof value?.code === "string" && /^[a-z_]{1,110}$/.test(value.code) ? value.code : "unavailable";
    throw new Error(`Synthetic advertising command ${response.status} ${path} ${code}`);
  }
  return response.json() as Promise<unknown>;
}
async function account() {
  return (await api("marketplace-accounts", { platform: "amazon", displayName: key(), region: "NA", authorizationMode: "amazon_private",
    marketplaceIds: ["ATVPDKIKX0DER"], requestedScopes: [] }) as { id: string }).id;
}
async function seedReports(accountId: string) {
  const input = AdImportInputSchema.parse({ accountId, files: files(key()), marketplaceByCurrency: { USD: "US" }, timezone: "America/Los_Angeles",
    attributionWindowDays: 7, attributionBasis: "click", conversionDefinition: { model: "click", source: "Synthetic actual source setting confirms click attribution" },
    observedAt: "2026-10-01T18:00:00.000Z", allowPartial: false, idempotencyKey: key() });
  const preview = AdImportPreviewSchema.parse(await api("advertising/imports/preview", input)); expect(preview.canCommit).toBe(true);
  return AdCommitImportResultSchema.parse(await api("advertising/imports", { ...input, previewChecksum: preview.previewChecksum })).imports;
}
async function savedRights(actor: "operator" | "readonly" = "readonly") {
  const current = actors()[actor], database = connectDatabase();
  try {
    const [value] = await withTenant(database.db, { tenantId: current.tenantId, userId: current.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, current.roleId)));
    if (!value) throw new Error("Synthetic advertising command role missing"); return [...value.permissions];
  } finally { await database.client.end(); }
}
async function personal(page: Page, path: string, body?: unknown, status = body === undefined ? 200 : 201) {
  const response = body === undefined ? await page.request.get(`${endpoint}${path}`)
    : await page.request.post(`${endpoint}${path}`, { headers: { origin: new URL(page.url()).origin }, data: body });
  expect(response.status()).toBe(status); return response.json() as Promise<unknown>;
}
function commandPath(id: string, accountId: string, suffix = "") { return `commands/${id}${suffix ? `/${suffix}` : ""}?${new URLSearchParams({ accountId })}`; }
function originalRoute(accountId: string, id: string) { return `/advertising/originals?${new URLSearchParams({ account: accountId, detail: `command:${id}` })}`; }
function observe(page: Page) {
  const writes: Array<{ path: string; body: string | null }> = [], errors: string[] = [];
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith(endpoint) && request.method() === "POST")
    writes.push({ path: url.pathname, body: request.postData() }); });
  page.on("pageerror", error => errors.push(error.message)); return { writes, errors };
}
async function ready(page: Page, accountId: string) {
  await expect(page.getByRole("heading", { name: "广告与 VOC", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "广告店铺", exact: true })).toHaveValue(accountId);
  await expect(page.getByRole("button", { name: "重新读取广告工作区", exact: true })).toBeEnabled();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const item of await page.locator(".ad-command-review, .ad-command-workbench, .ad-workbench").all())
    expect(await item.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function unlocked(form: Locator, submit?: Locator) {
  const fields = form.locator(":scope > fieldset"); await expect(fields).toHaveCount(1);
  await expect(fields).not.toHaveAttribute("inert", ""); await expect(fields).toHaveAttribute("aria-disabled", "false");
  if (submit) await expect(submit).toBeEnabled();
}
async function clickResponse(page: Page, button: Locator, path: string, method: "GET" | "POST" = "POST") {
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await expect(button).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(value => value.request().method() === method && new URL(value.url()).pathname === path,
    { timeout: 15_000 }), button.click()]); return response;
}
async function prepare(page: Page, button: Locator, kind: PrepareAdCommand["kind"]) {
  const response = await clickResponse(page, button, commandEndpoint); expect(response.status()).toBe(201);
  const original = PrepareAdCommandSchema.parse(response.request().postDataJSON()), detail = AdCommandDetailSchema.parse(await response.json());
  expect(original.kind).toBe(kind); expect(detail).toMatchObject({ status: "prepared", result: null, kind, accountId: original.accountId,
    targetId: original.targetId, requestKey: original.input.idempotencyKey }); return { original, detail };
}
async function readOriginal(page: Page, expected: PrepareAdCommand, detail: AdCommandDetail) {
  const review = page.getByRole("region", { name: "核对广告原提交", exact: true }); await expect(review).toBeVisible();
  await expect(review).toContainText(detail.id); await expect(review).toContainText(detail.requestKey);
  const response = await clickResponse(page, review.getByRole("button", { name: "读取广告原文并核对", exact: true }), `${commandEndpoint}/${detail.id}/original`, "GET");
  expect(response.status()).toBe(200); expect(AdCommandOriginalSchema.parse(await response.json()).original).toEqual(expected);
  await expect(review.getByRole("region", { name: "广告原填写全文核对", exact: true })).toBeVisible(); return review;
}
async function execute(page: Page, expected: PrepareAdCommand, detail: AdCommandDetail) {
  const review = await readOriginal(page, expected, detail);
  await review.getByRole("checkbox", { name: confirm, exact: true }).check();
  const response = await clickResponse(page, review.getByRole("button", { name: "确认执行广告原提交", exact: true }), `${commandEndpoint}/${detail.id}/execute`);
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual({});
  const done = AdCommandDetailSchema.parse(await response.json()); expect(done).toMatchObject({ id: detail.id, status: "succeeded", kind: expected.kind });
  expect(done.result).not.toBeNull(); await expect(review.getByRole("region", { name: "广告实际登记凭据", exact: true })).toContainText(done.result!.id); return done;
}
async function acknowledge(page: Page, detail: AdCommandDetail) {
  const review = page.getByRole("region", { name: "核对广告原提交", exact: true });
  const response = await clickResponse(page, review.getByRole("button", { name: "确认结果并清除填写副本", exact: true }), `${commandEndpoint}/${detail.id}/acknowledge`);
  expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual({});
  expect(AdCommandDetailSchema.parse(await response.json())).toMatchObject({ id: detail.id, result: detail.result, acknowledged: true, originalRetained: false });
  await expect(review).toHaveCount(0);
  expect(AdCommandOriginalSchema.parse(await personal(page, commandPath(detail.id, detail.accountId, "original"))).original).toBeNull();
}
async function productScope(page: Page, accountId: string, reviewing: boolean) {
  await page.getByRole("button", { name: "产品目标", exact: true }).click(); await ready(page, accountId);
  const region = page.getByRole("region", { name: "按明确产品范围登记", exact: true }), form = region.getByRole("form", { name: "核对登记产品范围", exact: true });
  await form.getByLabel("产品 ASIN", { exact: true }).fill("B012345678"); await form.getByRole("combobox", { name: "产品站点", exact: true }).selectOption("US");
  await form.getByLabel("产品币种", { exact: true }).fill("USD"); if (reviewing) await form.getByLabel("当前目标版本 新产品填 0", { exact: true }).fill("0");
  await form.getByRole("button", { name: "核对产品范围", exact: true }).click(); return region;
}
async function localTime(page: Page, iso: string) {
  return page.evaluate(value => { const date = new Date(value), shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000), input = document.createElement("input");
    input.type = "datetime-local"; input.step = "0.001"; input.value = shifted.toISOString().slice(0, -1); return input.value; }, iso);
}
/** Capture a real server response and lose exactly its first browser receipt. */
async function loseOne(page: Page, path: string) {
  const pattern = `**${path}*`, responses: Array<{ status: number; value: unknown; body: string }> = [];
  let active = 0, failed = false, closed = false;
  const handler = async (route: Route) => {
    if (route.request().method() !== "POST" || new URL(route.request().url()).pathname !== path) { await route.continue(); return; }
    active++;
    try {
      const response = await route.fetch({ timeout: 15_000 }); responses.push({ status: response.status(), value: await response.json(), body: route.request().postData()! });
      if (responses.length === 1) await route.abort("failed"); else await route.fulfill({ response });
    } catch { failed = true; } finally { active--; }
  };
  await page.route(pattern, handler);
  return { responses, async settled() { await expect.poll(() => active, { timeout: 15_000 }).toBe(0); expect(failed).toBe(false); },
    async close() { if (closed) return; closed = true; try { await expect.poll(() => active, { timeout: 15_000 }).toBe(0); }
      finally { await page.unroute(pattern, handler); } expect(failed).toBe(false); } };
}
async function actualCommand(id: string) {
  const actor = actors().readonly, database = connectDatabase();
  try {
    return await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, async tx => {
      const [row] = await tx.execute<{ id: string; result_id: string; status: string; request_key: string; proof_count: number; actual_count: number }>(sql`
        select c.id,c.result_id,c.status,c.request_key,(select count(*)::int from advertising_original_write_proofs p where p.command_id=c.id) as proof_count,
          case when c.kind='import_commit' then (select count(*)::int from ad_import_batches b where b.id=c.result_id)
            else 1 end as actual_count from advertising_commands c where c.id=${id}::uuid`);
      if (!row) throw new Error("Synthetic original command not found"); return row;
    });
  } finally { await database.client.end(); }
}

test("a Write-only person restores a lost CSV preparation and execution in new sessions, then records original observations and source archive events", async ({ page, browser }, info) => {
  const originalRights = await savedRights(), accountId = await account(), source = files(key())[0]!, contexts: BrowserContext[] = [], losses: Awaited<ReturnType<typeof loseOne>>[] = [];
  const observed = observe(page);
  try {
    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceWrite)); await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", `/customer-intelligence?account=${accountId}&tab=imports`); await ready(page, accountId);
    const panel = page.getByRole("region", { name: "导入广告 CSV", exact: true }), form = panel.locator("form.ad-form");
    await unlocked(form);
    await panel.getByLabel("选择 CSV 文件", { exact: true }).setInputFiles({ name: source.fileName, mimeType: "text/csv", buffer: Buffer.from(source.content) });
    await form.getByLabel("报告时区", { exact: true }).fill("America/Los_Angeles");
    await form.getByLabel("下载／采集时间", { exact: true }).fill(await localTime(page, "2026-10-01T18:00:00.000Z"));
    await form.getByLabel("归因天数（未知则留空）", { exact: true }).fill("7"); await form.getByRole("combobox", { name: "归因方式", exact: true }).selectOption("click");
    await form.getByLabel("缺失站点时的明确映射", { exact: true }).fill("USD=US");
    await form.getByRole("combobox", { name: "转化指标定义", exact: true }).selectOption("click");
    await form.getByLabel("指标定义核对依据", { exact: true }).fill("Synthetic actual report explicitly confirms click attribution");
    const preview = await clickResponse(page, form.getByRole("button", { name: "解析并预览", exact: true }), `${endpoint}imports/preview`);
    expect(preview.status()).toBe(201); expect(AdImportPreviewSchema.parse(await preview.json()).canCommit).toBe(true);
    const lostPrepare = await loseOne(page, commandEndpoint); losses.push(lostPrepare);
    await panel.getByRole("button", { name: "保存已预览原报表并核对", exact: true }).click();
    await expect.poll(() => lostPrepare.responses.length, { timeout: 15_000 }).toBe(1); await lostPrepare.settled();
    expect(lostPrepare.responses[0]!.status).toBe(201); const pending = AdCommandDetailSchema.parse(lostPrepare.responses[0]!.value), savedOriginal = PrepareAdCommandSchema.parse(JSON.parse(lostPrepare.responses[0]!.body));
    expect(savedOriginal.kind).toBe("import_commit"); if (savedOriginal.kind !== "import_commit") throw new Error("Synthetic original CSV missing");
    expect(savedOriginal.input.files[0]!.content).toBe(source.content); expect(savedOriginal.input.observedAt).toBe("2026-10-01T18:00:00.000Z");
    const retry = panel.getByRole("button", { name: "重试保存同一批原报表", exact: true }); await expect(retry).toBeEnabled(); await retry.click();
    await expect.poll(() => lostPrepare.responses.length, { timeout: 15_000 }).toBe(2); await lostPrepare.settled();
    expect(lostPrepare.responses[1]!.body).toBe(lostPrepare.responses[0]!.body); expect(AdCommandDetailSchema.parse(lostPrepare.responses[1]!.value).id).toBe(pending.id);
    expect(AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${accountId}`)).imports).toEqual([]); await lostPrepare.close();

    const resumedContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } }); contexts.push(resumedContext);
    const resumed = await resumedContext.newPage(), resumedObserved = observe(resumed);
    await loginErp(resumed, "readonly", originalRoute(accountId, pending.id));
    await expect(resumed.getByRole("combobox", { name: "原提交广告账户", exact: true })).toHaveValue(accountId);
    const review = await readOriginal(resumed, savedOriginal, pending);
    await review.locator("summary").filter({ hasText: `${source.fileName} 原 CSV 文本` }).click();
    await expect(review.getByLabel(`${source.fileName} 原 CSV 文本`, { exact: true })).toHaveText(source.content.replace(/\r/g, ""));
    expect(resumedObserved.writes).toEqual([]);
    const lostExecute = await loseOne(resumed, `${commandEndpoint}/${pending.id}/execute`); losses.push(lostExecute);
    await review.getByRole("checkbox", { name: confirm, exact: true }).check(); await review.getByRole("button", { name: "确认执行广告原提交", exact: true }).click();
    await expect.poll(() => lostExecute.responses.length, { timeout: 15_000 }).toBe(1); await lostExecute.settled();
    expect(lostExecute.responses[0]!.status).toBe(200); expect(JSON.parse(lostExecute.responses[0]!.body)).toEqual({});
    const done = AdCommandDetailSchema.parse(lostExecute.responses[0]!.value); expect(done.status).toBe("succeeded");
    await expect(review).toContainText("处理结果未知 只按原命令 ID 读取"); await expect(review.getByRole("button", { name: "重新读取原命令", exact: true })).toBeEnabled();
    expect(resumedObserved.writes.filter(value => value.path.endsWith("/execute"))).toHaveLength(1); await lostExecute.close();

    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceRead));
    const readerContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } }); contexts.push(readerContext);
    const reader = await readerContext.newPage(), readerObserved = observe(reader); await loginErp(reader, "readonly", originalRoute(accountId, pending.id));
    const receipt = reader.getByRole("region", { name: "广告实际登记凭据", exact: true }); await expect(receipt).toContainText(done.result!.id);
    await expect(reader.getByRole("button", { name: "确认执行广告原提交", exact: true })).toHaveCount(0); expect(readerObserved.writes).toEqual([]);
    expect(await actualCommand(pending.id)).toMatchObject({ result_id: done.result!.id, proof_count: 1, actual_count: 1 });
    await expect(reader.getByRole("dialog", { name: "广告原填写与执行", exact: true }).getByRole("heading", { name: "广告报表导入", exact: true })).toBeInViewport();
    await noOverflow(reader); await reader.screenshot({ path: info.outputPath("advertising-original-import-desktop.png"), fullPage: false });
    await reader.setViewportSize({ width: 390, height: 844 }); await expect(receipt).toBeVisible(); await noOverflow(reader);
    await reader.screenshot({ path: info.outputPath("advertising-original-import-mobile.png"), fullPage: false }); await acknowledge(reader, done);
    expect(readerObserved.writes.map(value => value.path)).toEqual([`${commandEndpoint}/${pending.id}/acknowledge`]);
    const actual = AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${accountId}`)).imports;
    expect(actual).toHaveLength(1); expect(actual[0]!.checksum).toBe(createHash("sha256").update(source.content).digest("hex"));

    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceWrite));
    await loginErp(page, "readonly", `/customer-intelligence?account=${accountId}&tab=goals`); await ready(page, accountId);
    const independent = await productScope(page, accountId, false), observationForm = independent.locator("form.ad-form"), saveObservation = observationForm.getByRole("button", { name: "保存观察原填写并核对", exact: true });
    await unlocked(observationForm, saveObservation);
    await observationForm.getByLabel("采集日期", { exact: true }).fill("2026-09-15"); await observationForm.getByLabel("关键词", { exact: true }).fill("custom pillow");
    await observationForm.getByLabel("自然名次", { exact: true }).fill("8"); await observationForm.getByLabel("证据来源说明", { exact: true }).fill("Synthetic actual rank evidence no external API");
    const observation = await prepare(page, saveObservation, "observation_record"), recordedObservation = await execute(page, observation.original, observation.detail); await acknowledge(page, recordedObservation);
    const observationRecord = AdHistoryRecordResultSchema.parse(await personal(page, `records/${recordedObservation.result!.id}?accountId=${accountId}&kind=observations`));
    expect(AdObservationSchema.parse(observationRecord.record.value).organicRank).toBe(8);
    await page.goto(`/customer-intelligence?${new URLSearchParams({ account: accountId, tab: "history", detail: `history:imports:${actual[0]!.id}` })}`); await ready(page, accountId);
    const history = page.getByRole("region", { name: "广告历史详情", exact: true }), archiveForm = history.getByRole("form", { name: `归档来源 ${actual[0]!.id}`, exact: true }), saveArchive = archiveForm.getByRole("button", { name: "保存归档原填写并核对", exact: true });
    await unlocked(archiveForm, saveArchive); await archiveForm.getByLabel("归档原因", { exact: true }).fill("Synthetic actual source archived without deleting immutable CSV");
    const archive = await prepare(page, saveArchive, "import_archive"), archived = await execute(page, archive.original, archive.detail);
    expect(archived.result!.parentId).toBe(actual[0]!.id); expect(archived.result!.id).not.toBe(actual[0]!.id); await acknowledge(page, archived);
    expect((AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${accountId}`))).imports[0]!.archivedAt).not.toBeNull();
    expect(observed.writes.filter(value => value.path.startsWith(endpoint) && value.path !== `${endpoint}imports/preview` && !value.path.startsWith(commandEndpoint))).toEqual([]);
    expect(observed.errors).toEqual([]); expect(readerObserved.errors).toEqual([]); expect(resumedObserved.errors).toEqual([]);
  } finally {
    try { for (const loss of losses) await loss.close(); }
    finally { try { await Promise.allSettled(contexts.map(context => context.close())); } finally { await changeErpRights("readonly", originalRights); } }
  }
});

test("a real reviewer explicitly prepares and executes original goal, fixed analysis, action event and immutable export from all four existing UI entries", async ({ page }, info) => {
  const originalRights = await savedRights(), accountId = await account(), imports = await seedReports(accountId), observed = observe(page);
  try {
    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceRead, Permission.CustomerIntelligenceReview));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", `/customer-intelligence?account=${accountId}&tab=goals&from=2026-09-01&to=2026-09-15`); await ready(page, accountId);
    const independent = await productScope(page, accountId, true), form = independent.locator("form.ad-form"), saveGoal = form.getByRole("button", { name: "保存目标原填写并核对", exact: true });
    await unlocked(form, saveGoal);
    await form.getByLabel("生效日期", { exact: true }).fill("2026-09-01"); await form.getByLabel("目标 ACoS (%)", { exact: true }).fill("21");
    await form.getByLabel("单件售价 (USD)", { exact: true }).fill("100"); await form.getByLabel("单件广告前总成本 (USD)", { exact: true }).fill("70");
    await form.getByText("样本门槛与调整限制", { exact: true }).click(); await form.getByLabel("最少花费 (USD)", { exact: true }).fill("10");
    await form.getByLabel("执行后观察天数", { exact: true }).fill("30"); await form.getByLabel("成本来源与目标说明", { exact: true }).fill("Synthetic approved original economics no bank or marketplace action");
    const goal = await prepare(page, saveGoal, "goal_save"), goalDone = await execute(page, goal.original, goal.detail);
    if (goal.original.kind !== "goal_save") throw new Error("Synthetic original goal missing");
    expect(goal.original.input.expectedRevision).toBe(0); expect(goal.original.input.fields.cooldownDays).toBe(30); expect(goalDone.result!.version).toBe(1);
    await acknowledge(page, goalDone); await expect(page.getByRole("region", { name: "目标版本核对已完成", exact: true })).toBeVisible();
    const saved = AdHistoryRecordResultSchema.parse(await personal(page, `records/${goalDone.result!.id}?accountId=${accountId}&kind=goals`));
    expect(AdGoalVersionSchema.parse(saved.record.value).fields.cooldownDays).toBe(30);

    const analysis = await prepare(page, page.getByRole("button", { name: "准备分析并核对", exact: true }), "analysis_run"), analysisDone = await execute(page, analysis.original, analysis.detail);
    if (analysis.original.kind !== "analysis_run") throw new Error("Synthetic original analysis missing");
    const cutoff = analysis.original.input.evidenceCutoffAt; await acknowledge(page, analysisDone);
    const runRecord = AdHistoryRecordResultSchema.parse(await personal(page, `records/${analysisDone.result!.id}?accountId=${accountId}&kind=analyses`));
    expect(runRecord.record.kind).toBe("analyses"); if (runRecord.record.kind !== "analyses") throw new Error("Synthetic actual analysis missing");
    expect(runRecord.record.value.evidenceCutoffAt).toBe(cutoff); expect(runRecord.record.value.result.evidenceImportIds.sort()).toEqual(imports.map(value => value.id).sort());
    expect(runRecord.record.value.result.goalVersionIds).toContain(goalDone.result!.id);
    const workspace = AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${accountId}`)), action = workspace.actions.find(value => value.runId === analysisDone.result!.id && value.recommendation.kind === "lower_bid");
    expect(action?.recommendation.proposedBidMinor).toBe(85); if (!action) throw new Error("Synthetic actual original bid recommendation missing");
    await page.goto(`/customer-intelligence?${new URLSearchParams({ account: accountId, tab: "history", detail: `history:actions:${action.id}` })}`); await ready(page, accountId);
    const history = page.getByRole("region", { name: "广告历史详情", exact: true }), actionForm = history.locator("form.ad-form"), saveAction = actionForm.getByRole("button", { name: "保存处理原填写并核对", exact: true });
    await unlocked(actionForm, saveAction); await expect(history).toContainText("30 天");
    await actionForm.getByRole("combobox", { name: "记录处理结果", exact: true }).selectOption("adopted");
    await actionForm.getByLabel("处理原因", { exact: true }).fill("Synthetic real review of fixed 1.00 to 0.85 bid candidate, no external execution");
    const transition = await prepare(page, saveAction, "action_transition"), transitionDone = await execute(page, transition.original, transition.detail);
    expect(transitionDone.result!.id).not.toBe(action.id); expect(transitionDone.result!.parentId).toBe(action.id); expect(transitionDone.result!.version).toBe(action.revision + 1); await acknowledge(page, transitionDone);

    await page.goto(`/customer-intelligence?${new URLSearchParams({ account: accountId, tab: "actions", run: analysisDone.result!.id,
      from: "2026-09-01", to: "2026-09-15" })}`); await ready(page, accountId);
    await expect(page.getByRole("combobox", { name: "已读取的分析版本", exact: true })).toHaveValue(analysisDone.result!.id);
    const seal = await prepare(page, page.getByRole("button", { name: "保存审阅封存原填写并核对", exact: true }), "export_seal"), sealed = await execute(page, seal.original, seal.detail);
    if (seal.original.kind !== "export_seal") throw new Error("Synthetic original reviewed export missing");
    expect(seal.original.input.runId).toBe(analysisDone.result!.id); expect(seal.original.input.actionIds).toContain(action.id);
    await acknowledge(page, sealed);
    const exportedRecord = AdHistoryRecordResultSchema.parse(await personal(page, `records/${sealed.result!.id}?accountId=${accountId}&kind=exports`)), exported = AdExportViewSchema.parse(exportedRecord.record.value);
    expect(exported.payload.marketplaceExecution).toBe("manual"); expect(exported.payload.actions.find(value => value.id === action.id)?.status).toBe("adopted");
    expect(exported.payload.run.evidenceCutoffAt).toBe(cutoff); expect(exported.payload.run.result.goalVersionIds).toContain(goalDone.result!.id);
    await expect(page.getByRole("region", { name: "广告历史详情", exact: true })).toContainText(exported.checksum);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("advertising-original-reviewed-export-mobile.png"), fullPage: false });
    const kinds = observed.writes.filter(value => value.path === commandEndpoint).map(value => PrepareAdCommandSchema.parse(JSON.parse(value.body!)).kind);
    expect(kinds).toEqual(["goal_save", "analysis_run", "action_transition", "export_seal"]);
    expect(observed.writes.filter(value => !value.path.startsWith(commandEndpoint))).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await changeErpRights("readonly", originalRights); }
});

test("a Review-only person restores only their original command while Read-only cannot execute and current revocation discards a delayed private original", async ({ page, browser }) => {
  const originalRights = await savedRights(), operatorRights = await savedRights("operator"), accountId = await account(), wrongAccount = await account(), contexts: BrowserContext[] = [];
  let release: (() => void) | undefined, routeHandler: ((route: Route) => Promise<void>) | undefined, active = 0, failed = false, pattern = "";
  const observed = observe(page);
  try {
    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceReview));
    await loginErp(page, "readonly", `/advertising/originals?account=${accountId}`);
    const original = PrepareAdCommandSchema.parse({ kind: "goal_save", accountId, targetId: null, input: { scope: { accountId, marketplace: "US", currency: "USD", asin: "B012345678" },
      expectedRevision: 0, fields: AdGoalFieldsSchema.parse({ mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2100,
        unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [], trialEndDate: null, trialSpendLimitMinor: null,
        cooldownDays: 30, notes: "Synthetic private original review evidence remains owned by this person" }), idempotencyKey: key() } });
    const pending = AdCommandDetailSchema.parse(await personal(page, "commands", original)); expect(pending.status).toBe("prepared");
    await page.goto(originalRoute(accountId, pending.id)); await readOriginal(page, original, pending);
    expect((await personal(page, `facts?accountId=${accountId}`, undefined, 403)) as unknown).toBeDefined();
    const workspace = AdvertisingWorkspaceSchema.parse(await personal(page, `workspace?accountId=${accountId}`));
    expect(workspace.access).toEqual({ canRead: false, canWrite: false, canReview: true });
    for (const collection of ["imports", "goals", "observations", "actions", "analyses"] as const) expect(workspace[collection]).toEqual([]);

    await changeErpRights("readonly", rights(originalRights, Permission.CustomerIntelligenceRead));
    const readerContext = await browser.newContext({ baseURL: new URL(page.url()).origin }); contexts.push(readerContext); const reader = await readerContext.newPage();
    await loginErp(reader, "readonly", originalRoute(accountId, pending.id)); const readerReview = await readOriginal(reader, original, pending);
    await expect(readerReview.getByRole("button", { name: "确认执行广告原提交", exact: true })).toHaveCount(0);
    await personal(reader, commandPath(pending.id, accountId, "execute"), {}, 403);
    await personal(reader, commandPath(pending.id, wrongAccount), undefined, 404);
    const before = AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${accountId}`)); expect(before.goals).toEqual([]);

    await changeErpRights("operator", rights(operatorRights, Permission.CustomerIntelligenceRead));
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin }); contexts.push(otherContext); const other = await otherContext.newPage();
    await loginErp(other, "operator", originalRoute(accountId, pending.id));
    await personal(other, commandPath(pending.id, accountId), undefined, 404); await personal(other, commandPath(pending.id, accountId, "original"), undefined, 404);
    await expect(other.getByRole("region", { name: "广告原填写全文核对", exact: true })).toHaveCount(0);

    // Close the already-read dialog before testing a delayed re-read. The real
    // dialog cannot refresh its disabled controls while its original GET waits.
    await reader.getByRole("button", { name: "关闭广告原填写与执行", exact: true }).click();
    await expect(reader.getByRole("dialog", { name: "广告原填写与执行", exact: true })).toHaveCount(0);
    await reader.getByLabel("广告原提交 ID", { exact: true }).fill(pending.id); await reader.getByRole("button", { name: "按原提交 ID 读取", exact: true }).click();
    const gate = new Promise<void>(resolve => { release = resolve; }); let captured: unknown;
    pattern = `**${commandEndpoint}/${pending.id}/original?*`;
    routeHandler = async route => {
      active++;
      try { const response = await route.fetch({ timeout: 15_000 }); expect(response.status()).toBe(200); captured = await response.json(); await gate;
        try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; }
      } catch { failed = true; } finally { active--; }
    };
    await reader.route(pattern, routeHandler);
    await reader.getByRole("region", { name: "核对广告原提交", exact: true }).getByRole("button", { name: "读取广告原文并核对", exact: true }).click();
    await expect.poll(() => captured !== undefined, { timeout: 15_000 }).toBe(true); expect(AdCommandOriginalSchema.parse(captured).original).toEqual(original);
    await reader.getByRole("button", { name: "关闭广告原填写与执行", exact: true }).click();
    await expect(reader.getByRole("dialog", { name: "广告原填写与执行", exact: true })).toHaveCount(0);
    await changeErpRights("readonly", rights(originalRights));
    const refresh = await clickResponse(reader, reader.getByRole("button", { name: "重新读取本人原提交", exact: true }), commandEndpoint, "GET");
    if (refresh.status() === 409) expect(await refresh.json()).toMatchObject({ code: "authority_changed" }); else expect(refresh.status()).toBe(403);
    if (!release) throw new Error("Synthetic delayed original gate missing");
    release(); await expect.poll(() => active, { timeout: 15_000 }).toBe(0); expect(failed).toBe(false); await reader.unroute(pattern, routeHandler); routeHandler = undefined;
    await expect(reader.getByRole("region", { name: "广告原填写全文核对", exact: true })).toHaveCount(0);
    await expect(reader.getByText("Synthetic private original review evidence remains owned by this person", { exact: true })).toHaveCount(0);
    await expect(reader.getByRole("button", { name: "恢复并核对原提交", exact: true })).toHaveCount(0);
    expect(AdCommandListSchema.parse(await personal(other, `commands?accountId=${accountId}`)).items).toEqual([]);
    expect(AdvertisingWorkspaceSchema.parse(await api(`advertising/workspace?accountId=${accountId}`)).goals).toEqual([]);
    // The 201 prepare above uses APIRequestContext, outside page request events.
    // The actual page must never auto-submit while restoring or losing access.
    expect(await actualCommand(pending.id)).toMatchObject({ id: pending.id, status: "prepared", result_id: null, proof_count: 0 });
    expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
  } finally {
    release?.();
    try { await expect.poll(() => active, { timeout: 15_000 }).toBe(0); if (routeHandler) for (const context of contexts) for (const current of context.pages()) await current.unroute(pattern, routeHandler); }
    finally {
      try { await Promise.allSettled(contexts.map(context => context.close())); }
      finally { try { await changeErpRights("readonly", originalRights); } finally { await changeErpRights("operator", operatorRights); } }
    }
  }
});
