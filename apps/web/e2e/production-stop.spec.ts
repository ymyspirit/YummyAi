import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { CreateProductionOrderInputSchema, CreateQualityStandardInputSchema, createEntityId } from "@yummyai/contracts";
import { ProductionQuantityReportResultSchema, ProductionQuantityReviewResultSchema, ProductionQuantityWorkspaceSchema,
  type ProductionPhysicalQuantities } from "@yummyai/contracts/order/production-quantity";
import { FactoryCapacityPoolViewSchema } from "@yummyai/contracts/suppliers/factory-capacity";
import { NativeProductionDetailSchema } from "@yummyai/contracts/order/native-production";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { syntheticFactoryCapacityProfile } from "../../../tools/testing/factory-capacity-fixtures";
import { actors, identityControl, loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
import { prepareNativeProduction } from "./native-production-fixture";

const disposable = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(disposable.pathname)?.[1];
if (process.env.E2E_PRODUCTION_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.WEB_AUTH_MODE !== "personal" ||
    !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`) throw new Error("Production stop requires its exact personal disposable runner");
const api = process.env.API_BASE_URL!.replace(/\/$/, "");
test.setTimeout(180_000);

async function personal(page: Page, path: string, body?: unknown, account: "operator" | "readonly" = "operator") {
  const { access_token: token } = await identityControl("token", { account });
  return fetch(`${api}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, origin: new URL(page.url()).origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function dbTime() {
  const actor = actors().operator, database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
      tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`));
    return new Date(row!.now).toISOString();
  } finally { await database.client.end(); }
}
async function localTime(page: Page) {
  return page.evaluate(iso => {
    const value = new Date(iso), pad = (part: number, width = 2) => String(part).padStart(width, "0");
    const input = document.createElement("input"); input.type = "datetime-local";
    input.value = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
    return input.value;
  }, await dbTime());
}
async function click(button: Locator) {
  await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await expect(button).toBeEnabled(); await button.click();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const panel of await page.locator("dialog[open],.ps-workspace").all())
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function source() {
  const value = await prepareNativeProduction();
  const secondPool = FactoryCapacityPoolViewSchema.parse(await centerApi(`sourcing/factories/${value.factoryId}/capacity-pools`, {
    factoryVersionId: value.factoryVersionId, code: `SYNTHETIC-STOP-${randomUUID()}`, timeZone: value.capacity.pool.timeZone, unit: "each",
    profile: { ...syntheticFactoryCapacityProfile([{ capabilityVersionId: value.capabilityVersionId, unitsPerItem: 2 }], 60),
      name: `Synthetic stop second pool ${createEntityId()}` }, idempotencyKey: randomUUID(),
  }));
  const input = CreateProductionOrderInputSchema.parse({ orderLineId: value.lineId, factoryId: value.factoryId, factoryVersionId: value.factoryVersionId,
    capabilityVersionId: value.capabilityVersionId, routingDecisionId: value.routingDecisionId, purchaseOrderVersionId: value.purchaseOrderVersionId,
    designVersionId: value.designVersionId, productionAssetIds: value.productionAssetIds, manufacturing: value.manufacturing,
    productConfirmation: value.productConfirmation, expectedCompletionAt: value.capacity.expectedCompletionAt,
    instructions: "Synthetic actual original three-piece stop basis No factory contact", idempotencyKey: randomUUID(),
    capacityPlan: { allocations: [...value.capacityPlan.allocations, { poolId: secondPool.id, poolVersionId: secondPool.versionId, localDate: value.capacity.localDate }] },
  });
  const created = await centerApi<{ productionOrderId: string }>(`order-centers/native/orders/${value.orderId}/production`, input);
  return { ...value, id: created.productionOrderId, input, secondPool };
}
async function milestone(page: Page, id: string, type: "submitted" | "acknowledged" | "started" | "cancel_requested") {
  const response = await personal(page, `production/orders/${id}`); expect(response.status).toBe(200);
  const current = await response.json() as { productionOrder: { projectionVersion: number } };
  const result = await personal(page, `production/orders/${id}/milestones`, { type, expectedProjectionVersion: current.productionOrder.projectionVersion,
    externalEventId: randomUUID(), occurredAt: await dbTime(), evidence: { code: "SYNTHETIC_STOP_ORIGINAL_EVENT", note: null, assetIds: [] } });
  expect(result.status).toBe(201);
}
async function openQuantity(page: Page, id: string) {
  const history = page.locator("details.oc-production-history"), summary = history.locator(":scope > summary");
  await expect(summary).toBeVisible(); if (await history.getAttribute("open") === null) await click(summary);
  const article = page.locator(`#production-${id}`), workspace = article.getByRole("region", { name: "实际停单数量凭证", exact: true });
  await click(workspace.getByRole("button", { name: "读取实物数量与停做凭据", exact: true }));
  await expect(workspace).toHaveAttribute("aria-busy", "false");
  await expect(workspace.getByRole("region", { name: "原生产数量依据", exact: true })).toBeVisible();
  return { article, workspace };
}
async function submitReport(page: Page, workspace: Locator, counts: ProductionPhysicalQuantities, evidence: string) {
  await click(workspace.getByRole("button", { name: "登记实际生产数量", exact: true }));
  const form = page.getByRole("form", { name: "登记实际生产数量", exact: true }), fields = form.locator(":scope > fieldset");
  await expect(fields).not.toHaveAttribute("inert"); await expect(fields).toHaveAttribute("aria-disabled", "false");
  for (const [label, value] of [["未开工数量", counts.unstartedQuantity], ["在制数量", counts.inProcessQuantity],
    ["已完工数量（含已交运）", counts.completedQuantity], ["实际报废数量", counts.scrappedQuantity]] as const)
    await form.getByRole("spinbutton", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).fill(value === null ? "" : String(value));
  await form.getByLabel("实际清点时间（本机当地时间）", { exact: true }).fill(await localTime(page));
  await form.getByLabel("数量凭证编号", { exact: true }).fill(evidence);
  await form.getByRole("checkbox", { name: "已按实际实物登记四项数量 未清点处保留未知 已完工没有重复加上已交运", exact: true }).check();
  const button = form.getByRole("button", { name: "保存本次数量报告", exact: true }); await button.scrollIntoViewIfNeeded(); await expect(button).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname.endsWith("/quantity/reports"), { timeout: 15_000 }), button.click()]);
  expect(response.status()).toBe(201); const saved = ProductionQuantityReportResultSchema.parse(await response.json());
  await expect(page.getByRole("region", { name: "本次数量操作回执", exact: true })).toContainText(saved.report.id);
  return saved;
}
async function acknowledge(page: Page) {
  const receipt = page.getByRole("region", { name: "本次数量操作回执", exact: true });
  await click(receipt.getByRole("button", { name: "确认数量凭据并返回", exact: true })); await expect(receipt).toHaveCount(0);
}
async function reviewForm(page: Page, workspace: Locator, reportId: string, delta: number) {
  const history = workspace.getByRole("region", { name: "人工数量报告历史", exact: true });
  const row = history.locator("li").filter({ hasText: reportId.slice(-8) }); await expect(row).toHaveCount(1);
  await click(row.getByRole("button", { name: "核对这份报告并核准停做", exact: true }));
  const form = page.getByRole("form", { name: "核准本次新增停做", exact: true }), fields = form.locator(":scope > fieldset");
  await expect(fields).not.toHaveAttribute("inert"); await expect(fields).toHaveAttribute("aria-disabled", "false");
  await form.getByRole("spinbutton", { name: /^本次新增停做数量/ }).fill(String(delta));
  await form.getByLabel("实际核准时间（本机当地时间）", { exact: true }).fill(await localTime(page));
  await form.getByLabel("数量凭证编号", { exact: true }).fill("SYNTHETIC_APPROVED_UNSTARTED_ALL_POOLS");
  if (delta > 0) await form.getByRole("checkbox", { name: "已逐件核对新增停做实物在全部绑定资源池和工序均未投入 不能只按单个工序比例释放", exact: true }).check();
  await form.getByRole("checkbox", { name: "已核对原报告 全部数量 原核准与本次新增停做依据", exact: true }).check();
  return form;
}
async function uiMilestone(page: Page, article: Locator, id: string, label: string) {
  const form = article.locator("form.oc-operation-form").filter({ has: page.locator('input[name="reference"]') }); await expect(form).toHaveCount(1);
  await form.getByLabel("凭证 / 工厂记录编号", { exact: true }).fill("SYNTHETIC_REMAINING_ACTUAL_EVENT");
  await form.getByLabel("发生时间", { exact: true }).fill(await localTime(page));
  const button = form.getByRole("button", { name: label, exact: true }); await button.scrollIntoViewIfNeeded(); await expect(button).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/order-centers/production/${id}/milestones`, { timeout: 15_000 }), button.click()]);
  expect(response.status()).toBe(201);
}

test("personal partial stop keeps original three pieces and both pool rates while the remaining pieces explicitly resume, finish and pass actual QC", async ({ page }, info) => {
  const value = await source(); await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", `/production?line=${value.lineId}`);
  for (const type of ["submitted", "acknowledged", "started", "cancel_requested"] as const) await milestone(page, value.id, type);
  await page.reload(); const { workspace, article } = await openQuantity(page, value.id);
  await expect(workspace).toContainText("未知 尚未清点");
  const report = await submitReport(page, workspace, { unstartedQuantity: 1, inProcessQuantity: 1, completedQuantity: 1, scrappedQuantity: 0 }, "SYNTHETIC_COUNT_ORIGINAL_THREE");
  await acknowledge(page); await expect(workspace.getByRole("region", { name: "人工数量报告历史", exact: true })).toContainText(report.report.id.slice(-8));
  const form = await reviewForm(page, workspace, report.report.id, 1), path = `/api/production-quantity/orders/${value.id}/quantity/reviews`;
  const bodies: unknown[] = [], receipts: Array<ReturnType<typeof ProductionQuantityReviewResultSchema.parse>> = [];
  const handlers: Promise<void>[] = []; let handlerError: unknown;
  const lose = (route: Route) => {
    const work = (async () => {
      if (route.request().method() !== "POST") return await route.continue();
      bodies.push(route.request().postDataJSON()); const response = await route.fetch({ timeout: 15_000 }); expect(response.status()).toBe(201);
      receipts.push(ProductionQuantityReviewResultSchema.parse(await response.json()));
      if (receipts.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic response unavailable" }) });
      else await route.fulfill({ response });
    })().catch(error => { handlerError = error; });
    handlers.push(work); return work;
  };
  await page.route(`**${path}`, lose);
  try {
    await click(form.getByRole("button", { name: "核准本次新增停做", exact: true }));
    await expect.poll(() => receipts.length, { timeout: 15_000 }).toBe(1); await Promise.all(handlers); expect(handlerError).toBeUndefined();
    const retry = form.getByRole("button", { name: "按原请求重试核对", exact: true }); await expect(retry).toBeEnabled();
    await expect(form.locator(":scope > fieldset")).toHaveAttribute("inert", "");
    const originalBody = bodies[0]; await click(retry);
    await expect(page.getByRole("region", { name: "本次数量操作回执", exact: true })).toContainText(receipts[0]!.review.id);
    expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(originalBody);
    expect(receipts[1]).toMatchObject({ replayed: true, review: receipts[0]!.review });
    const receipt = page.getByRole("region", { name: "本次数量操作回执", exact: true });
    await expect(receipt).toContainText("本次新增停做 1 件"); await expect(receipt.getByRole("heading", { name: "新增停做核准已登记", exact: true })).toBeInViewport();
    await noOverflow(page); await page.screenshot({ path: info.outputPath("production-stop-original-receipt-desktop.png"), fullPage: false });
  } finally { await Promise.all(handlers); await page.unroute(`**${path}`, lose); }
  await acknowledge(page);
  await expect(workspace.getByRole("region", { name: "原生产数量依据", exact: true }).getByText("此前已核准停做", { exact: true }).locator("..").locator("dd")).toHaveText("1 件");
  const actualResponse = await personal(page, `production/orders/${value.id}/quantity`); expect(actualResponse.status).toBe(200);
  let actual = ProductionQuantityWorkspaceSchema.parse(await actualResponse.json());
  expect(actual.reviews).toHaveLength(1); expect(actual.basis).toMatchObject({ quantity: 3, cumulativeStoppedQuantity: 1, status: "cancel_requested" });
  expect(actual.basis.reservations.map(row => row.totalUnits).sort((a, b) => a - b)).toEqual([3, 6]);
  expect(actual.basis.reservations.map(row => row.stopReleasedUnits).sort((a, b) => a - b)).toEqual([1, 2]);
  expect(actual.basis.reservations.map(row => row.stopCommitReductionUnits).sort((a, b) => a - b)).toEqual([1, 2]);
  await uiMilestone(page, article, value.id, "记录剩余生产继续");
  await expect(article.getByRole("button", { name: "记录生产完工", exact: true })).toBeVisible();
  const later = await submitReport(page, workspace, { unstartedQuantity: 0, inProcessQuantity: 0, completedQuantity: 2, scrappedQuantity: 0 }, "SYNTHETIC_REMAINING_TWO_FINISHED");
  await acknowledge(page); await expect(workspace.getByRole("region", { name: "人工数量报告历史", exact: true })).toContainText(later.report.id.slice(-8));
  const complete = await reviewForm(page, workspace, later.report.id, 0), button = complete.getByRole("button", { name: "核准本次新增停做", exact: true });
  await click(button); await expect(page.getByRole("region", { name: "本次数量操作回执", exact: true })).toContainText("此次核准后累计停做 1 件"); await acknowledge(page);
  await expect(workspace.getByRole("region", { name: "运营核准停做历史", exact: true })).toContainText("核准第 2 次");
  await uiMilestone(page, article, value.id, "记录生产完工");
  const standard = await personal(page, "production/quality-standards", CreateQualityStandardInputSchema.parse({ name: `Synthetic remaining QC ${createEntityId()}`,
    minimumScoreBps: 9000, criteria: [{ code: "ACTUAL", label: "Synthetic exact finished quantity", weightBps: 10000, blocking: true }] }));
  expect(standard.status).toBe(201); const standardId = (await standard.json() as { id: string }).id;
  actual = ProductionQuantityWorkspaceSchema.parse(await (await personal(page, `production/orders/${value.id}/quantity`)).json());
  expect(actual.basis).toMatchObject({ quantity: 3, status: "completed", currentQuantities: { unstartedQuantity: 0, inProcessQuantity: 0, completedQuantity: 2, scrappedQuantity: 0 }, cumulativeStoppedQuantity: 1 });
  const qc = await personal(page, `production/orders/${value.id}/inspections`, { qualityStandardVersionId: standardId, expectedProductionProjectionVersion: actual.basis.projectionVersion,
    result: "passed", scoreBps: 10000, assessment: { formatVersion: 2, criterionResults: [{ code: "ACTUAL", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] },
    inspectedAt: await dbTime(), evidenceAssetIds: [], defects: [], idempotencyKey: randomUUID() });
  expect(qc.status).toBe(201);
  const ready = await personal(page, `orders/${value.orderId}/shipment-sources`); expect(ready.status).toBe(200);
  const sources = await ready.json() as Array<{ productionOrderId: string; quantity: number; availableQuantity: number; blockers: string[] }>;
  expect(sources.find(row => row.productionOrderId === value.id)).toMatchObject({ quantity: 2, availableQuantity: 2, blockers: [] });
  const persisted = ProductionQuantityWorkspaceSchema.parse(await (await personal(page, `production/orders/${value.id}/quantity`)).json());
  expect(persisted.reports).toHaveLength(2); expect(persisted.reviews).toHaveLength(2); expect(persisted.basis.quantity).toBe(3);
  expect(persisted.basis.reservations.map(row => row.stopReleasedUnits).sort((a, b) => a - b)).toEqual([1, 2]);

  await page.goto(`/production?view=native&line=${value.lineId}`);
  const native = page.getByRole("form", { name: "建立直接生产安排", exact: true });
  await expect(native.getByLabel("本次下达数量", { exact: true })).toHaveValue("");
  await expect(native).toContainText("本次最多可下达 1 份");
  await native.getByLabel("完整产品规格", { exact: true }).selectOption(value.specificationVersionId);
  await native.getByLabel("已审核设计", { exact: true }).selectOption(value.designVersionId);
  await native.getByLabel("已批准采购来源", { exact: true }).selectOption(`${value.routingDecisionId}:${value.purchaseOrderVersionId}`);
  await native.getByLabel("制造版本", { exact: true }).selectOption(value.manufacturing.versionId);
  await native.getByRole("checkbox", { name: /已核对原规格/ }).check();
  await expect(native.getByRole("button", { name: "建立内部生产安排", exact: true })).toBeDisabled();
  await expect(native.getByRole("region", { name: "本次生产产能安排", exact: true })).toHaveCount(0);
  await native.getByLabel("本次下达数量", { exact: true }).fill("1");
  await native.getByLabel("生产工厂", { exact: true }).selectOption(value.capabilityVersionId);
  await native.getByLabel("工厂当地预计完成时间", { exact: true }).fill(value.capacity.dueLocal);
  await native.getByLabel("本次产品及设计确认依据", { exact: true }).fill("Synthetic explicit one piece from the actual approved stop");
  await native.getByLabel("本次生产说明", { exact: true }).fill("Synthetic explicit one-piece initial arrangement Preserve original three");
  await native.getByRole("checkbox", { name: /已核对完整产品规格/ }).check();
  const picker = native.getByRole("region", { name: "本次生产产能安排", exact: true });
  for (const pool of [value.capacity.pool, value.secondPool])
    await picker.getByLabel(`项目1 ${pool.profile.name}当地生产日期`, { exact: true }).fill(value.capacity.localDate);
  await click(picker.getByRole("button", { name: "核对本批产能与当地完工时间", exact: true }));
  await expect(picker.getByRole("region", { name: "本批产能核对结果", exact: true })).toContainText("本次预览可预约 尚未占用产能");
  await click(native.getByRole("button", { name: "建立内部生产安排", exact: true }));
  const recovery = page.getByRole("region", { name: "待确认生产提交", exact: true }); await expect(recovery).toContainText("生产安排已建立");
  await click(recovery.getByRole("button", { name: "已核对本次结果", exact: true }));
  const finalResponse = await personal(page, `order-centers/native/lines/${value.lineId}?specificationVersionId=${value.specificationVersionId}`); expect(finalResponse.status).toBe(200);
  const final = NativeProductionDetailSchema.parse(await finalResponse.json());
  expect(final.line).toMatchObject({ quantity: 3, allocatedQuantity: 3 }); expect(final.productions).toHaveLength(2);
  expect(final.productions.find(row => row.id === value.id)?.quantity).toBe(3);
  const additional = final.productions.find(row => row.id !== value.id); expect(additional?.quantity).toBe(1);
  if (!additional) throw new Error("Synthetic explicit replacement initial arrangement missing");
  const additionalQuantity = ProductionQuantityWorkspaceSchema.parse(await (await personal(page, `production/orders/${additional.id}/quantity`)).json());
  expect(additionalQuantity.basis.reservations.map(row => row.totalUnits).sort((a, b) => a - b)).toEqual([1, 2]);
  expect((await personal(page, `order-centers/native/orders/${value.orderId}/production`, { ...value.input, quantity: 1, idempotencyKey: randomUUID() })).status).toBe(409);
  const unchanged = NativeProductionDetailSchema.parse(await (await personal(page, `order-centers/native/lines/${value.lineId}`)).json());
  expect(unchanged.productions).toHaveLength(2); expect(unchanged.line.allocatedQuantity).toBe(3);
});

async function role() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [value] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
      tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!value || !["self", "team", "tenant"].includes(value.dataScope)) throw new Error("Synthetic quantity role missing");
    return { permissions: value.permissions, dataScope: value.dataScope as "self" | "team" | "tenant" };
  } finally { await database.client.end(); }
}
async function setRole(value: Awaited<ReturnType<typeof role>>) {
  const actor = actors().readonly, database = connectDatabase();
  try { await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx => tx.update(roles).set(value).where(eq(roles.id, actor.roleId))); }
  finally { await database.client.end(); }
}

test("unknown physical counts release nothing and a fresh personal reader loses private quantity history immediately when current Read is revoked", async ({ page, browser }, info) => {
  const value = await source(), originalRole = await role(), path = `/production?line=${value.lineId}`;
  let release: (() => void) | undefined; const handlers: Promise<void>[] = []; let handlerError: unknown;
  const fresh = await browser.newContext({ baseURL: String(info.project.use.baseURL), viewport: { width: 390, height: 844 } });
  let reader: Page | undefined;
  const quantityPath = `/api/production-quantity/orders/${value.id}/quantity`, match = (url: URL) => url.pathname === quantityPath;
  try {
    await loginErp(page, "operator", path); const view = await openQuantity(page, value.id);
    const writes: string[] = []; page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.startsWith(quantityPath)) writes.push(new URL(request.url()).pathname); });
    const unknown = await submitReport(page, view.workspace, { unstartedQuantity: null, inProcessQuantity: null, completedQuantity: null, scrappedQuantity: null }, "SYNTHETIC_UNKNOWN_PHYSICAL_COUNT");
    expect(unknown.report.input.quantities).toEqual({ unstartedQuantity: null, inProcessQuantity: null, completedQuantity: null, scrappedQuantity: null });
    await acknowledge(page); await expect(view.workspace.getByRole("region", { name: "人工数量报告历史", exact: true })).toContainText(unknown.report.id.slice(-8));
    await click(view.workspace.getByRole("button", { name: "核对这份报告并核准停做", exact: true }));
    const review = page.getByRole("form", { name: "核准本次新增停做", exact: true });
    await expect(review.getByRole("alert").filter({ hasText: "这份报告含未知数量" })).toBeVisible();
    await expect(review.getByRole("button", { name: "核准本次新增停做", exact: true })).toBeDisabled();
    expect(writes).toEqual([`${quantityPath}/reports`]);
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("production-stop-unknown-mobile.png"), fullPage: false });
    await click(review.getByRole("button", { name: "返回数量记录", exact: true })); await expect(review).toHaveCount(0);
    const permissions = [...new Set([...originalRole.permissions.filter(item => item !== Permission.OrderWrite), Permission.OrderRead, Permission.OrderPiiRead])];
    await setRole({ permissions, dataScope: "tenant" });
    reader = await fresh.newPage(); await loginErp(reader, "readonly", path);
    const read = await openQuantity(reader, value.id);
    await expect(read.workspace.getByRole("button", { name: "登记实际生产数量", exact: true })).toHaveCount(0);
    const history = read.workspace.getByRole("region", { name: "人工数量报告历史", exact: true });
    await click(history.getByText(`数量报告 ${unknown.report.id.slice(-8)}`, { exact: false }));
    await expect(history).toContainText(unknown.report.id); await expect(history).toContainText("SYNTHETIC_UNKNOWN_PHYSICAL_COUNT");
    const privateEvidence = history.locator("p").filter({ hasText: "SYNTHETIC_UNKNOWN_PHYSICAL_COUNT" });
    await expect(privateEvidence).toHaveCount(1); await expect(privateEvidence).toBeVisible();
    expect((await personal(reader, `production/orders/${value.id}/quantity/reports`, unknown.report.input, "readonly")).status).toBe(403);
    const actual = ProductionQuantityWorkspaceSchema.parse(await (await personal(reader, `production/orders/${value.id}/quantity`, undefined, "readonly")).json());
    expect(actual.reports).toHaveLength(1); expect(actual.reviews).toEqual([]);
    expect(actual.basis).toMatchObject({ cumulativeStoppedQuantity: 0, currentQuantities: null });
    expect(actual.basis.reservations.every(row => row.stopReleasedUnits === 0 && row.stopCommitReductionUnits === 0)).toBe(true);
    let started = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await reader.route(match, route => {
      started = true;
      const work = (async () => { await gate; const response = await route.fetch({ timeout: 15_000 });
        if (response.status() === 409) expect(await response.json()).toMatchObject({ code: "authority_changed" }); else expect(response.status()).toBe(403);
        await route.fulfill({ response });
      })().catch(error => { handlerError = error; });
      handlers.push(work); return work;
    });
    await click(read.workspace.getByRole("button", { name: "重新读取实物数量与停做凭据", exact: true }));
    await expect.poll(() => started).toBe(true);
    await setRole({ permissions: permissions.filter(item => item !== Permission.OrderRead), dataScope: "tenant" });
    if (!release) throw new Error("Synthetic quantity permission gate missing"); release(); await Promise.all(handlers); expect(handlerError).toBeUndefined();
    await expect(read.workspace.getByRole("region", { name: "原生产数量依据", exact: true })).toHaveCount(0);
    await expect(reader.getByText(unknown.report.id, { exact: true })).toHaveCount(0);
    await expect(privateEvidence).toHaveCount(0);
  } finally {
    release?.();
    try { await Promise.all(handlers); if (reader) await reader.unroute(match); }
    finally { try { await setRole(originalRole); } finally { await fresh.close(); } }
  }
});
