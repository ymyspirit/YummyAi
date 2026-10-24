import { expect, test } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { NativeProductionDetailSchema } from "@yummyai/contracts/order/native-production";
import { loginErp, changeErpRights } from "./erp-identity-fixture";
import { prepareNativeProduction } from "./native-production-fixture";
import { fillProductionCapacity } from "./factory-capacity-fixture";
import { apiFetch } from "../src/server-api";

test("personal native production recovers lost preparation after refresh and a lost commit in a new session", async ({ page, browser }, testInfo) => {
  test.setTimeout(180000); const data = await prepareNativeProduction(), pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", `/production?view=native&q=${data.externalId}&line=${data.lineId}`);
  // Login deliberately omits free-text queries. Exercise the real query and selection after personal login.
  await page.getByRole("textbox", { name: "查询直接生产订单", exact: true }).fill(data.externalId);
  await page.getByRole("button", { name: "查询订单", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`q=${data.externalId}`));
  await page.getByRole("button", { name: new RegExp(data.externalId) }).click();
  const form = page.getByRole("form", { name: "建立直接生产安排", exact: true });
  await form.getByLabel("完整产品规格", { exact: true }).selectOption(data.specificationVersionId);
  await form.getByLabel("已审核设计", { exact: true }).selectOption(data.designVersionId);
  await form.getByLabel("已批准采购来源", { exact: true }).selectOption(`${data.routingDecisionId}:${data.purchaseOrderVersionId}`);
  await form.getByLabel("本次下达数量", { exact: true }).fill("3");
  await form.getByLabel("制造版本", { exact: true }).selectOption(data.manufacturing.versionId);
  await form.getByRole("checkbox", { name: /已核对原规格/ }).check();
  await form.getByLabel("生产工厂", { exact: true }).selectOption(data.capabilityVersionId);
  await form.getByLabel("工厂当地预计完成时间", { exact: true }).fill(data.capacity.dueLocal);
  await form.getByLabel("本次产品及设计确认依据", { exact: true }).fill("Synthetic source confirmation retained after a read outage");
  await form.getByLabel("本次生产说明", { exact: true }).fill("Synthetic arrangement only No factory handover");
  await form.getByRole("checkbox", { name: /已核对完整产品规格/ }).check();
  await fillProductionCapacity(form, data.capacity);
  const create = form.getByRole("button", { name: "建立内部生产安排", exact: true }); await expect(create).toBeEnabled();
  const readPath = `**/api/order-centers/native/lines/${data.lineId}?specificationVersionId=*`;
  let failedReads = 0;
  await page.route(readPath, route => { failedReads++; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic native read outage" }) }); });
  await page.getByRole("button", { name: "核对当前生产来源", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "记录暂时无法读取" })).toBeVisible(); expect(failedReads).toBe(1); await expect(create).toBeDisabled();
  await expect(form.getByLabel("本次产品及设计确认依据", { exact: true })).toHaveValue("Synthetic source confirmation retained after a read outage");
  await expect(form.getByLabel("工厂当地预计完成时间", { exact: true })).toHaveValue(data.capacity.dueLocal);
  await page.unroute(readPath); await page.getByRole("button", { name: "核对当前生产来源", exact: true }).click();
  await expect(form.getByLabel("已审核设计", { exact: true })).toBeEnabled();
  await expect(form.getByLabel("已审核设计", { exact: true })).toHaveValue(data.designVersionId);
  await form.getByRole("checkbox", { name: /已核对完整产品规格/ }).check(); await fillProductionCapacity(form, data.capacity); await expect(create).toBeEnabled();
  await page.evaluate(() => window.scrollTo(0, 0)); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("native-production-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0)); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("native-production-mobile.png"), fullPage: true });
  const bodies: unknown[] = []; let intentId = "";
  await page.route("**/api/order-centers/production-commands", async route => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch(); expect(response.status()).toBe(201); intentId = (await response.json()).id;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic prepare response lost" }) });
  });
  await create.click();
  const recovery = page.getByRole("region", { name: "待确认生产提交", exact: true });
  await expect(recovery.getByRole("button", { name: "按原确认下达生产", exact: true })).toBeVisible();
  await expect(recovery).toContainText("Synthetic arrangement only No factory handover");
  await expect(create).toBeDisabled(); expect(bodies).toHaveLength(1);
  page.once("dialog", dialog => dialog.accept()); await page.reload();
  await expect(recovery.getByRole("button", { name: "按原确认下达生产", exact: true })).toBeVisible();
  await expect(recovery).toContainText("Synthetic arrangement only No factory handover");
  let executions = 0;
  await page.route(`**/api/order-centers/production-commands/${intentId}/execute`, async route => {
    executions++; expect(route.request().postDataJSON()).toEqual({});
    const response = await route.fetch(); expect(response.ok()).toBe(true); expect((await response.json()).status).toBe("succeeded");
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic commit response lost" }) });
  });
  await recovery.getByRole("button", { name: "按原确认下达生产", exact: true }).click();
  await expect(recovery).toContainText("生产安排已建立"); expect(executions).toBe(1);
  const independent = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), viewport: { width: 1440, height: 1000 } });
  try {
    const fresh = await independent.newPage(); fresh.on("pageerror", error => pageErrors.push(error.message));
    await loginErp(fresh, "operator", `/production?view=native&line=${data.lineId}`);
    const restored = fresh.getByRole("region", { name: "待确认生产提交", exact: true });
    await expect(restored).toContainText("生产安排已建立");
    await expect(restored).toContainText("Synthetic arrangement only No factory handover");
    await expect(restored.getByRole("button", { name: "按原确认下达生产", exact: true })).toHaveCount(0);
    await fresh.screenshot({ path: testInfo.outputPath("production-recovery-new-session-desktop.png"), fullPage: true });
    await fresh.setViewportSize({ width: 390, height: 844 });
    expect(await fresh.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await fresh.screenshot({ path: testInfo.outputPath("production-recovery-new-session-mobile.png"), fullPage: true });
    await restored.getByRole("button", { name: "已核对本次结果", exact: true }).click();
    await expect(restored).toContainText("当前没有待确认的生产提交");
    const intents = await fresh.request.get(`/api/order-centers/production-commands?orderId=${data.orderId}`);
    expect(intents.status()).toBe(200); expect((await intents.json()).items).toEqual([]);
  } finally { await independent.close(); }
  const response = await page.request.get(`/api/order-centers/native/lines/${data.lineId}?specificationVersionId=${data.specificationVersionId}`);
  expect(response.status()).toBe(200); const saved = NativeProductionDetailSchema.parse(await response.json());
  expect(saved.productions).toHaveLength(1); expect(saved.productions[0]).toMatchObject({ status: "planned", quantity: 3 }); expect(saved.line.allocatedQuantity).toBe(3);
  const invalidRead = await apiFetch(`${process.env.API_BASE_URL}/v1/order-centers/native?tenantId=caller`); expect(invalidRead.status).toBe(400);
  for (const path of [`order-centers/native/orders/${data.orderId}/production`, `orders/${data.orderId}/production`]) {
    const rejected = await apiFetch(`${process.env.API_BASE_URL}/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ synthetic_private_value: "synthetic-invalid-input" }) });
    expect(rejected.status).toBe(400); expect(await rejected.text()).not.toContain("synthetic_private_value");
  }
  expect(pageErrors).toEqual([]);
});

test("personal native production obeys current write and product-read revocation", async ({ page }) => {
  test.setTimeout(150000); const data = await prepareNativeProduction();
  await loginErp(page, "operator", `/production?view=native&q=${data.externalId}&line=${data.lineId}`);
  const form = page.getByRole("form", { name: "建立直接生产安排", exact: true });
  await expect(form.getByLabel("完整产品规格", { exact: true })).toBeEnabled();
  try {
    await changeErpRights("operator", Object.values(Permission).filter(value => value !== Permission.OrderWrite));
    const reload = page.waitForEvent("framenavigated", frame => frame === page.mainFrame()); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await reload;
    await expect(page.getByRole("status").filter({ hasText: "当前角色仅可读取生产来源" })).toBeVisible();
    await expect(form.getByLabel("完整产品规格", { exact: true })).toBeDisabled();
    const readonly = await page.request.get(`/api/order-centers/native/lines/${data.lineId}`); expect(readonly.status()).toBe(200); expect((await readonly.json()).canCreate).toBe(false);
    await changeErpRights("operator", Object.values(Permission).filter(value => value !== Permission.ProductRead));
    const deniedReload = page.waitForEvent("framenavigated", frame => frame === page.mainFrame()); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await deniedReload;
    await expect(form).toHaveCount(0); expect((await page.request.get(`/api/order-centers/native/lines/${data.lineId}`)).status()).toBe(403);
  } finally { await changeErpRights("operator", Object.values(Permission)); }
});
