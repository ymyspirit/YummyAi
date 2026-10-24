import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { CreateProductionOrderInputSchema, CreateQualityStandardInputSchema } from "@yummyai/contracts";
import { QualityGroupsWorkspaceSchema, QualityGroupsMutationResultSchema } from "@yummyai/contracts/order/quality-groups";
import { ProductionQuantityWorkspaceSchema, ProductionQuantityReportResultSchema, ProductionQuantityReviewResultSchema } from "@yummyai/contracts/order/production-quantity";
import { AllocateQualityScrapInputSchema, QualityScrapWorkspaceSchema, QualityScrapResultSchema } from "@yummyai/contracts/order/quality-scrap";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { actors, identityControl, loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
import { prepareNativeProduction } from "./native-production-fixture";
import { fillProductionCapacity } from "./factory-capacity-fixture";

const disposable = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(disposable.pathname)?.[1];
if (process.env.E2E_QUALITY_SCRAP_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.WEB_AUTH_MODE !== "personal" ||
    !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`) throw new Error("Quality scrap needs its exact personal disposable runner");
const api = process.env.API_BASE_URL!.replace(/\/$/, "");
test.setTimeout(180_000);

async function personal(page: Page, path: string, body?: unknown, account: "operator" | "readonly" = "operator") {
  const { access_token: token } = await identityControl("token", { account });
  return fetch(`${api}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, origin: new URL(page.url()).origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
async function dbTime() {
  const actor = actors().operator, database = connectDatabase();
  try { const [clock] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
    tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`)); return new Date(clock!.now).toISOString(); }
  finally { await database.client.end(); }
}
async function localTime(page: Page) {
  return page.evaluate(iso => { const d = new Date(iso), p = (n: number, width = 2) => String(n).padStart(width, "0"), input = document.createElement("input");
    input.type = "datetime-local"; input.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    return input.value; }, await dbTime());
}
async function click(button: Locator) { await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport(); await expect(button).toBeEnabled(); await button.click(); }
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const node of await page.locator("dialog[open],.qs-workspace").all()) expect(await node.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
const group = (key: string, quantity: number, passed: boolean) => ({ key, label: `Synthetic scrap bin ${key}`, quantity,
  criterionResults: [{ code: "ACTUAL", scoreBps: passed ? 10000 : 0, passed, evidenceAssetIds: [] }],
  defects: passed ? [] : [{ code: "COLOR", severity: "major", responsibility: "supplier", disposition: "scrap", note: "Synthetic actual failed physical group", evidenceAssetIds: [] }] });
async function source(page: Page) {
  const value = await prepareNativeProduction();
  const input = CreateProductionOrderInputSchema.parse({ orderLineId: value.lineId, factoryId: value.factoryId, factoryVersionId: value.factoryVersionId,
    capabilityVersionId: value.capabilityVersionId, routingDecisionId: value.routingDecisionId, purchaseOrderVersionId: value.purchaseOrderVersionId,
    designVersionId: value.designVersionId, productionAssetIds: value.productionAssetIds, manufacturing: value.manufacturing, productConfirmation: value.productConfirmation,
    capacityPlan: value.capacityPlan, expectedCompletionAt: value.capacity.expectedCompletionAt, instructions: "Synthetic original three actual pieces No factory contacted", idempotencyKey: randomUUID() });
  const actual = await centerApi<{ productionOrderId: string }>(`order-centers/native/orders/${value.orderId}/production`, input), id = actual.productionOrderId;
  await loginErp(page, "operator", `/production?line=${value.lineId}`);
  for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
    const response = await personal(page, `production/orders/${id}`); expect(response.status).toBe(200);
    const current = await response.json() as { productionOrder: { projectionVersion: number } };
    expect((await personal(page, `production/orders/${id}/milestones`, { type, expectedProjectionVersion: current.productionOrder.projectionVersion,
      externalEventId: randomUUID(), occurredAt: await dbTime(), evidence: { code: "SYNTHETIC_SCRAP_ACTUAL_EVENT", note: null, assetIds: [] } })).status).toBe(201);
  }
  const standardResponse = await personal(page, "production/quality-standards", CreateQualityStandardInputSchema.parse({ name: `Synthetic scrap standard ${randomUUID()}`,
    minimumScoreBps: 9000, criteria: [{ code: "ACTUAL", label: "实际外观", weightBps: 10000, blocking: true }] })); expect(standardResponse.status).toBe(201);
  const standardId = (await standardResponse.json() as { id: string }).id;
  const initialResponse = await personal(page, `order-centers/production/${id}/quality-groups`); expect(initialResponse.status).toBe(200);
  const initial = QualityGroupsWorkspaceSchema.parse(await initialResponse.json());
  const rootResponse = await personal(page, `order-centers/production/${id}/quality-groups`, { formatVersion: 3, productionVersionId: initial.productionVersionId,
    expectedProductionProjectionVersion: initial.projectionVersion, expectedRootInspectionId: initial.rootInspectionId, parentGroupId: null,
    qualityStandardVersionId: standardId, inspectedAt: await dbTime(), evidenceAssetIds: [], segregationConfirmed: true,
    groups: [group("GOOD", 1, true), group("HELD", 2, false)], idempotencyKey: randomUUID() }); expect(rootResponse.status).toBe(201);
  const root = QualityGroupsMutationResultSchema.parse(await rootResponse.json()), held = root.workspace.groups.find(row => row.result === "failed")!;
  const physical = ProductionQuantityWorkspaceSchema.parse(await (await personal(page, `production/orders/${id}/quantity`)).json());
  const reportResponse = await personal(page, `production/orders/${id}/quantity/reports`, { idempotencyKey: randomUUID(), productionVersionId: physical.basis.productionVersionId,
    expectedProductionProjectionVersion: physical.basis.projectionVersion, expectedReviewId: physical.basis.reviewId, expectedBasisFingerprint: physical.basis.fingerprint,
    observedAt: await dbTime(), quantities: { unstartedQuantity: 0, inProcessQuantity: 0, completedQuantity: 2, scrappedQuantity: 1 }, evidenceCode: "SYNTHETIC_ACTUAL_SCRAP_COUNT", evidenceAssetIds: [] });
  expect(reportResponse.status).toBe(201); const report = ProductionQuantityReportResultSchema.parse(await reportResponse.json());
  const reviewResponse = await personal(page, `production/orders/${id}/quantity/reviews`, { idempotencyKey: randomUUID(), reportId: report.report.id,
    expectedProductionProjectionVersion: physical.basis.projectionVersion, expectedReviewId: physical.basis.reviewId, expectedBasisFingerprint: physical.basis.fingerprint,
    stoppedDelta: 0, unstartedAcrossAllPoolsConfirmed: false, occurredAt: await dbTime(), evidenceCode: "SYNTHETIC_APPROVED_SCRAP_COUNT" });
  expect(reviewResponse.status).toBe(201); const count = ProductionQuantityReviewResultSchema.parse(await reviewResponse.json());
  await page.reload(); return { ...value, id, standardId, root, held, count };
}
async function open(page: Page, id: string) {
  const history = page.locator("details.oc-production-history"); await expect(history.locator(":scope > summary")).toBeVisible();
  if (await history.getAttribute("open") === null) await click(history.locator(":scope > summary"));
  const panel = page.locator(`#production-${id} details.oc-quality-groups-panel`); await expect(panel).toHaveCount(1);
  if (await panel.getAttribute("open") === null) await click(panel.locator(":scope > summary"));
  const workspace = panel.getByRole("region", { name: "失败组报废归属", exact: true });
  await click(workspace.getByRole("button", { name: "读取报废归属依据", exact: true }));
  await expect(workspace).toHaveAttribute("aria-busy", "false");
  await expect(workspace.getByRole("region", { name: "本次读取的报废归属依据", exact: true })).toBeVisible();
  return { panel, workspace };
}
async function form(page: Page, workspace: Locator, value: Awaited<ReturnType<typeof source>>, evidence: string) {
  await click(workspace.getByRole("button", { name: "登记失败组报废归属", exact: true }));
  const form = page.getByRole("form", { name: "登记失败组报废归属", exact: true }), fields = form.locator(":scope > fieldset.qs-fields");
  await expect(fields).not.toHaveAttribute("inert"); await expect(fields).toHaveAttribute("aria-disabled", "false");
  const row = form.getByRole("group", { name: "报废归属明细 1", exact: true });
  await row.getByRole("combobox", { name: "原失败实物组", exact: true }).selectOption(value.held.id);
  await row.getByRole("combobox", { name: "新增报废批次", exact: true }).selectOption(value.count.review.id);
  await row.getByRole("spinbutton", { name: "本次归属数量", exact: true }).fill("1");
  await form.getByLabel("实际归属时间（本机当地时间）", { exact: true }).fill(await localTime(page));
  await form.getByLabel("报废归属凭证编号", { exact: true }).fill(evidence);
  await form.getByRole("checkbox", { name: /^已逐件核对原失败组与新增报废批次/ }).check();
  return form;
}
const amount = (workspace: Locator, name: string) => workspace.getByRole("region", { name: "本次读取的报废归属依据", exact: true }).getByText(name, { exact: true }).locator("..").locator("dd");

test("personal fixed scrap preserves the original group and capacity while its remaining physical piece is reinspected and the retired scrap is explicitly remade", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); const value = await source(page), { panel, workspace } = await open(page, value.id);
  await expect(amount(workspace, "已核准实际报废数量")).toHaveText("1"); await expect(amount(workspace, "尚未归属总数量")).toHaveText("1");
  const held = panel.locator(`[data-quality-group="${value.held.id}"]`); await expect(held.getByRole("button", { name: "按本组复检", exact: true })).toBeDisabled();
  const before = ProductionQuantityWorkspaceSchema.parse(await (await personal(page, `production/orders/${value.id}/quantity`)).json());
  const editor = await form(page, workspace, value, "SYNTHETIC_PERSONAL_FIXED_SCRAP");
  const submit = editor.getByRole("button", { name: "登记本次报废归属", exact: true }); await submit.scrollIntoViewIfNeeded(); await expect(submit).toBeEnabled();
  const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/quality-scrap/orders/${value.id}/quality-scrap/reviews`, { timeout: 15000 }), submit.click()]);
  expect(response.status()).toBe(201); const saved = QualityScrapResultSchema.parse(await response.json());
  const receipt = page.getByRole("region", { name: "本次报废归属回执", exact: true }); await expect(receipt).toContainText(saved.review.id);
  await expect(receipt.getByRole("heading", { name: "报废实物归属已登记", exact: true })).toBeInViewport(); await noOverflow(page);
  await page.screenshot({ path: info.outputPath("quality-scrap-original-desktop.png"), fullPage: false });
  await click(receipt.getByRole("button", { name: "确认报废归属凭证并返回", exact: true })); await expect(receipt).toHaveCount(0);
  await expect(amount(workspace, "已明确归属原组")).toHaveText("1"); await expect(amount(workspace, "尚未归属总数量")).toHaveText("0");
  await expect(held).toContainText("可复检实物 1");
  const after = ProductionQuantityWorkspaceSchema.parse(await (await personal(page, `production/orders/${value.id}/quantity`)).json());
  expect(after.basis.quantity).toBe(3); expect(after.basis.cumulativeStoppedQuantity).toBe(0); expect(after.basis.reservations).toEqual(before.basis.reservations);
  await click(held.getByRole("button", { name: "按本组复检", exact: true }));
  const inspection = panel.getByRole("form", { name: "实物分组检验", exact: true }); await expect(inspection).toContainText("本次需完整覆盖 1 件");
  await inspection.getByRole("combobox", { name: "检验标准", exact: true }).selectOption(value.standardId);
  const physical = inspection.getByRole("group", { name: "实物组 1", exact: true });
  await physical.getByLabel("隔离位置标识", { exact: true }).fill("Synthetic repaired remaining physical piece");
  await physical.getByLabel("本组实物数量", { exact: true }).fill("1");
  await physical.getByLabel("实际外观 得分", { exact: true }).fill("100");
  await physical.getByLabel("实际外观 核验结果", { exact: true }).selectOption("passed");
  await inspection.getByLabel("实际检验时间", { exact: true }).fill(await localTime(page));
  await inspection.getByRole("checkbox", { name: "已按实物隔离各组并逐项检查 组间没有重复 数量覆盖本次范围", exact: true }).check();
  await click(inspection.getByRole("button", { name: "保存实物分组检验", exact: true })); await expect(inspection).toHaveCount(0);
  await expect(held).toContainText("已复检替代"); await expect(held).toContainText("报废份额剩余可补做 1");
  await click(held.getByRole("button", { name: "按本组补做", exact: true }));
  const remake = panel.getByRole("form", { name: "按组安排补做", exact: true });
  await remake.getByRole("combobox", { name: "关联原缺陷", exact: true }).selectOption(value.held.defects[0]!.id);
  await remake.getByLabel("本次补做数量", { exact: true }).fill("1"); await remake.getByLabel("补做原因", { exact: true }).fill("Synthetic actual original fixed scrap only");
  await remake.getByLabel("补做工厂当地预计完成时间", { exact: true }).fill(value.capacity.dueLocal);
  const manufacturing = remake.getByRole("group", { name: "本次制造依据", exact: true });
  await manufacturing.getByLabel("制造版本", { exact: true }).selectOption(value.manufacturing.versionId); await manufacturing.getByRole("checkbox").check();
  await remake.getByRole("checkbox", { name: "已核对本次取用的原组实物和补做数量", exact: true }).check();
  await fillProductionCapacity(remake, value.capacity);
  await click(remake.getByRole("button", { name: "创建本组补做任务", exact: true })); await expect(remake).toHaveCount(0);
  const groupsResponse = await personal(page, `order-centers/production/${value.id}/quality-groups`); expect(groupsResponse.status).toBe(200);
  const actual = QualityGroupsWorkspaceSchema.parse(await groupsResponse.json());
  expect(actual.groups.find(row => row.id === value.held.id)).toMatchObject({ quantity: 2, active: false, scrappedQuantity: 1, remakeQuantity: 1, remainingScrapRemakeQuantity: 0 });
  expect(actual.groups.filter(row => row.parentGroupId === value.held.id && row.active)).toMatchObject([{ quantity: 1, result: "passed" }]);
  const persisted = QualityScrapWorkspaceSchema.parse(await (await personal(page, `production/orders/${value.id}/quality-scrap`)).json());
  expect(persisted.reviews).toHaveLength(1); expect(persisted.reviews[0]!.id).toBe(saved.review.id); expect(persisted.basis.actualScrappedQuantity).toBe(1);
});

async function role() {
  const actor = actors().readonly, database = connectDatabase();
  try { const [value] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx =>
    tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!value || !["self", "team", "tenant"].includes(value.dataScope)) throw new Error("Synthetic scrap readonly role missing");
    return { permissions: value.permissions, dataScope: value.dataScope as "self" | "team" | "tenant" }; }
  finally { await database.client.end(); }
}
async function setRole(value: Awaited<ReturnType<typeof role>>) {
  const actor = actors().readonly, database = connectDatabase();
  try { await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx => tx.update(roles).set(value).where(eq(roles.id, actor.roleId))); }
  finally { await database.client.end(); }
}

test("an unknown personal allocation retries the original body exactly once and a fresh readonly session clears its private scrap receipt after current Read is revoked", async ({ page, browser }, info) => {
  const value = await source(page), view = await open(page, value.id), originalRole = await role();
  const path = `/api/quality-scrap/orders/${value.id}/quality-scrap`, evidence = "SYNTHETIC_UNKNOWN_SCRAP_RECEIPT";
  const bodies: unknown[] = [], receipts: Array<ReturnType<typeof QualityScrapResultSchema.parse>> = [], handlers: Promise<void>[] = [];
  let handlerError: unknown, release: (() => void) | undefined;
  const fresh = await browser.newContext({ baseURL: String(info.project.use.baseURL), viewport: { width: 390, height: 844 } }); let reader: Page | undefined;
  const lose = (route: Route) => { const work = (async () => {
    if (route.request().method() !== "POST") return await route.continue();
    bodies.push(route.request().postDataJSON()); const response = await route.fetch({ timeout: 15000 }); expect(response.status()).toBe(201);
    receipts.push(QualityScrapResultSchema.parse(await response.json()));
    if (receipts.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic lost allocation response" }) });
    else await route.fulfill({ response });
  })().catch(error => { handlerError = error; }); handlers.push(work); return work; };
  const match = (url: URL) => url.pathname === path;
  await page.route(`**${path}/reviews`, lose);
  try {
    let editor = await form(page, view.workspace, value, evidence); await click(editor.getByRole("button", { name: "登记本次报废归属", exact: true }));
    await expect.poll(() => receipts.length, { timeout: 15000 }).toBe(1); await Promise.all(handlers); expect(handlerError).toBeUndefined();
    await expect(editor.getByRole("button", { name: "按原请求重试归属", exact: true })).toBeEnabled();
    await expect(editor.locator(":scope > fieldset.qs-fields")).toHaveAttribute("inert", "");
    page.once("dialog", dialog => void dialog.accept()); await click(editor.getByRole("button", { name: "返回报废归属记录", exact: true })); await expect(editor).toHaveCount(0);
    await click(view.workspace.getByRole("button", { name: "恢复本次报废归属原请求", exact: true }));
    editor = page.getByRole("form", { name: "登记失败组报废归属", exact: true }); await click(editor.getByRole("button", { name: "按原请求重试归属", exact: true }));
    const receipt = page.getByRole("region", { name: "本次报废归属回执", exact: true }); await expect(receipt).toContainText(receipts[0]!.review.id);
    expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect(receipts[1]).toMatchObject({ replayed: true, review: receipts[0]!.review });
    await click(receipt.getByRole("button", { name: "确认报废归属凭证并返回", exact: true })); await expect(receipt).toHaveCount(0);
    await page.unroute(`**${path}/reviews`, lose);
    const permissions = [...new Set([...originalRole.permissions.filter(item => item !== Permission.OrderWrite), Permission.OrderRead, Permission.OrderPiiRead])];
    await setRole({ permissions, dataScope: "tenant" }); reader = await fresh.newPage(); await loginErp(reader, "readonly", `/production?line=${value.lineId}`);
    const read = await open(reader, value.id); await expect(read.workspace.getByRole("button", { name: "登记失败组报废归属", exact: true })).toHaveCount(0);
    const history = read.workspace.getByRole("region", { name: "报废归属历史", exact: true });
    await click(history.locator("summary").filter({ hasText: receipts[0]!.review.id.slice(-8) }));
    await expect(history.getByText(receipts[0]!.review.id, { exact: true })).toBeVisible();
    const privateEvidence = history.locator("p").filter({ hasText: evidence }); await expect(privateEvidence).toHaveCount(1); await expect(privateEvidence).toBeVisible();
    await noOverflow(reader); await reader.screenshot({ path: info.outputPath("quality-scrap-original-readonly-mobile.png"), fullPage: false });
    const original = AllocateQualityScrapInputSchema.parse(bodies[0]);
    expect((await personal(reader, `production/orders/${value.id}/quality-scrap/reviews`, original, "readonly")).status).toBe(403);
    const actual = QualityScrapWorkspaceSchema.parse(await (await personal(reader, `production/orders/${value.id}/quality-scrap`, undefined, "readonly")).json());
    expect(actual.reviews).toHaveLength(1); expect(actual.reviews[0]!.id).toBe(receipts[0]!.review.id); expect(actual.basis.mappedScrappedQuantity).toBe(1);
    let started = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await reader.route(match, route => { started = true; const work = (async () => { await gate; const response = await route.fetch({ timeout: 15000 });
      if (response.status() === 409) expect(await response.json()).toMatchObject({ code: "authority_changed" }); else expect(response.status()).toBe(403);
      await route.fulfill({ response }); })().catch(error => { handlerError = error; }); handlers.push(work); return work; });
    await click(read.workspace.getByRole("button", { name: "重新读取报废归属依据", exact: true })); await expect.poll(() => started).toBe(true);
    await setRole({ permissions: permissions.filter(item => item !== Permission.OrderRead), dataScope: "tenant" });
    if (!release) throw new Error("Synthetic scrap read permission gate missing"); release(); await Promise.all(handlers); expect(handlerError).toBeUndefined();
    await expect(read.workspace.getByRole("region", { name: "本次读取的报废归属依据", exact: true })).toHaveCount(0);
    await expect(reader.getByText(receipts[0]!.review.id, { exact: true })).toHaveCount(0); await expect(privateEvidence).toHaveCount(0);
  } finally {
    release?.();
    try { await Promise.all(handlers); await page.unroute(`**${path}/reviews`, lose); if (reader) await reader.unroute(match); }
    finally { try { await setRole(originalRole); } finally { await fresh.close(); } }
  }
});
