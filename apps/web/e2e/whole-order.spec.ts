import { loginErp } from "./erp-identity-fixture";
import { fillProductionCapacity } from "./factory-capacity-fixture";
import { fillQualityAssessment } from "./quality-assessment-form";
import { expect, test } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { OrderWorkDetail, OrderOperationsView } from "@yummyai/contracts/order/workspace";
import type { ShiposWorkspace } from "@yummyai/contracts/suppliers/shipos";
import type { FactoryDirectory, FactoryCapabilityView } from "@yummyai/contracts/suppliers/factory-directory";
import type { WholeOrderFulfillmentView } from "@yummyai/contracts/order/whole-fulfillment";
import { centerApi } from "./order-centers-fixture";
import { prepareWholePillows } from "./whole-order-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";

let worker: ChildProcess | undefined;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(async () => { await stopProductionEditorWorker(worker); });
test.beforeEach(async ({ page }) => { if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page); });
test("whole order makes and dispatches all three pillows in one package through real pages", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !process.env.SHIPOS_TEST_BASE_URL) throw new Error("ShipOS acceptance must use the disposable query-only fixture");
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const currentLocalMinute = () => page.evaluate(() => {
    const now = new Date(), pad = (value: number) => String(value).padStart(2, "0");
    return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-")
      + "T" + [pad(now.getHours()), pad(now.getMinutes())].join(":");
  });
  const order = await prepareWholePillows();
  await page.goto(`/suppliers/${order.supplierId}`);
  const config = page.getByRole("region", { name: "ShipOS 连接配置" });
  await config.getByLabel("AppKey", { exact: false }).fill("synthetic-appkey");
  await config.getByLabel("AppSecret", { exact: false }).fill("synthetic-secret");
  await config.getByLabel("连接状态", { exact: true }).selectOption("active");
  await config.getByRole("button", { name: "添加渠道对应关系", exact: true }).click();
  await config.getByLabel("ShipOS 渠道名称", { exact: true }).fill("Synthetic ShipOS channel");
  await config.getByLabel("承运商代码", { exact: true }).fill("UPS");
  await config.getByLabel("承运商名称", { exact: true }).fill("Synthetic UPS");
  await config.getByLabel("物流服务", { exact: true }).fill("Synthetic ground");
  await config.getByLabel("发货国家代码", { exact: true }).fill("CN");
  await config.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(config.getByText("连接配置已保存。", { exact: true })).toBeVisible();
  await expect(config.getByLabel("AppSecret", { exact: false })).toHaveValue("");
  const connection = (await centerApi<ShiposWorkspace>(`sourcing/suppliers/${order.supplierId}/shipos`)).connection!;
  await centerApi(`sourcing/suppliers/${order.supplierId}/shipos/sync`, { expectedVersion: connection.version, orderNumbers: [order.externalId], idempotencyKey: randomUUID() });
  const standard = await centerApi<{ id: string }>("order-centers/quality-standards", { name: `Synthetic whole quality ${order.externalId}`, minimumScoreBps: 9000,
    criteria: [{ code: "WHOLE", label: "Inspect every pillow", weightBps: 10000, blocking: true }] });
  const last = await centerApi<OrderWorkDetail>(`order-centers/lines/${order.lines[2]}`);
  const paused = await centerApi<OrderWorkDetail>(`order-centers/lines/${last.line.id}/actions`, { action: "hold", expectedRevision: last.line.revision,
    expectedProjectionVersion: last.line.projectionVersion, reason: "Synthetic one item pending verification", idempotencyKey: randomUUID() });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // A matching pillow brings one order row with every sibling, including a held item.
  await page.goto(`/production?q=${order.externalLines[0]}`);
  const list = page.getByRole("table", { name: "整单生产列表", exact: true });
  await expect(list.locator("tbody > tr")).toHaveCount(1);
  await list.getByRole("button", { name: "展开本单商品", exact: true }).click();
  await expect(list.locator(".oc-expanded-items li")).toHaveCount(3);
  await expect(list.locator('[data-label="整单数量"]')).toContainText("共 3 件");
  await page.getByRole("button", { name: order.externalId, exact: true }).first().click();
  const overview = page.getByRole("region", { name: "整单详情", exact: true });
  const allItems = overview.getByRole("region", { name: "本单全部商品与审核稿", exact: true });
  await expect(allItems.locator("article")).toHaveCount(3);
  await expect(allItems.getByRole("link", { name: "下载已审核正式文件", exact: true })).toHaveCount(3);
  await expect(overview.getByText("3 个商品 · 共 3 件", { exact: false })).toBeVisible();
  await allItems.getByRole("button", { name: /^商品 2 ·/ }).click();
  await expect(allItems.getByRole("button", { name: /^商品 2 ·/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("dialog", { name: "整单详情", exact: true }).getByRole("button", { name: "下一单", exact: true })).toBeDisabled();
  await allItems.getByRole("button", { name: /^商品 1 ·/ }).click();
  await expect(overview.locator(".oc-review-detail")).toHaveAttribute("aria-busy", "false");
  await overview.evaluate(element => { element.scrollTop = 0; });
  await page.getByRole("dialog", { name: "整单详情", exact: true }).screenshot({ path: testInfo.outputPath("unified-order-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole("dialog", { name: "整单详情", exact: true }).screenshot({ path: testInfo.outputPath("unified-order-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const production = page.getByRole("region", { name: "整单生产", exact: true });
  await expect(production.locator("tbody tr")).toHaveCount(3);
  await expect(production.getByRole("button", { name: "安排整单生产（3 件）" })).toBeDisabled();
  await expect(production.getByText("已暂停或作废", { exact: true })).toBeVisible();
  await centerApi(`order-centers/lines/${last.line.id}/actions`, { action: "resume", expectedRevision: paused.line.revision,
    expectedProjectionVersion: paused.line.projectionVersion, reason: "Synthetic verification complete", idempotencyKey: randomUUID() });
  await production.getByRole("button", { name: "重新核对整单" }).click();
  await expect(production.getByRole("status").filter({ hasText: "正在核对" })).toHaveCount(0);
  const directory = await centerApi<FactoryDirectory>(`sourcing/factories?supplier=${order.supplierId}`);
  const originalCapability = directory.capabilities.find(capability => capability.factoryId === order.factoryId)!;
  const pausedCapability = await centerApi<FactoryCapabilityView>(`sourcing/factory-capabilities/${originalCapability.id}/revisions`, { expectedVersion: originalCapability.versionNumber,
    profile: { ...originalCapability.profile, maximumLongestMm: 100, minimumLongestMm: 50 }, idempotencyKey: randomUUID() });
  await production.getByRole("button", { name: "重新核对整单" }).click();
  await expect(production.getByLabel("承接工厂").locator(`option[value="${order.factoryId}"]`)).toHaveCount(0);
  const alternatives = await centerApi<WholeOrderFulfillmentView>(`order-centers/orders/${order.orderId}/fulfillment`);
  expect(alternatives.factories.some(factory => factory.factoryId === order.factoryId)).toBe(false);
  if (!alternatives.factories.length) {
    await expect(production.getByLabel("工厂承接条件").getByText(/尺寸超出/)).toHaveCount(3);
    await expect(production.locator(`a[href="/suppliers/${order.supplierId}/factories/${order.factoryId}#factory-capabilities"]`)).toHaveText("配置此工厂承接能力");
  }
  const restoredCapability = await centerApi<FactoryCapabilityView>(`sourcing/factory-capabilities/${originalCapability.id}/revisions`, { expectedVersion: pausedCapability.versionNumber, profile: originalCapability.profile, idempotencyKey: randomUUID() });
  await centerApi(`sourcing/factories/${order.factoryId}/capacity-pools/${order.capacity.pool.id}/revisions`, { expectedVersion: order.capacity.pool.versionNumber,
    profile: { ...order.capacity.pool.profile, bindings: [{ capabilityVersionId: restoredCapability.versionId, unitsPerItem: 1 }] }, idempotencyKey: randomUUID() });
  await production.getByRole("button", { name: "重新核对整单" }).click();
  await production.getByLabel("承接工厂").selectOption(order.factoryId);
  await production.getByLabel("整单工厂当地计划完工").fill(order.capacity.dueLocal);
  await production.getByLabel("整单补充说明（选填）").fill("Synthetic all three pillows packed together");
  await production.getByRole("button", { name: "重新核对整单" }).click();
  await expect(production.getByLabel("整单补充说明（选填）")).toHaveValue("Synthetic all three pillows packed together");
  await expect(production.getByLabel("整单工厂当地计划完工")).toHaveValue(order.capacity.dueLocal);
  const manufacturingChoices = production.getByRole("group", { name: "本次制造依据", exact: true });
  await expect(manufacturingChoices).toHaveCount(3);
  for (const choice of await manufacturingChoices.all()) {
    await choice.getByLabel("制造版本", { exact: true }).selectOption(order.manufacturing.versionId);
    await choice.getByRole("checkbox").check();
  }
  await fillProductionCapacity(production, order.capacity, 3);
  await expect(production.getByLabel("下达数量")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("whole-production-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("whole-production-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await production.getByRole("button", { name: "安排整单生产（3 件）" }).click();
  await expect(page.getByRole("status").filter({ hasText: "整单生产已安排" })).toBeVisible();
  const productionReceipt = overview.getByRole("region", { name: "待确认生产提交", exact: true });
  await expect(productionReceipt).toContainText("已建立 3 个生产安排");
  await productionReceipt.getByRole("button", { name: "已核对本次结果", exact: true }).click();
  await expect(productionReceipt.locator("article:not([hidden])")).toHaveCount(0);
  await overview.getByLabel("整单下一步").getByRole("button", { name: "准备整单文件", exact: true }).click();
  const delivery = overview.getByRole("region", { name: "抱枕交付与工厂回执", exact: true });
  await expect(delivery.getByRole("checkbox", { name: /^选择交付 / })).toHaveCount(3);
  await delivery.getByRole("button", { name: "生成本单完整交付包（3）", exact: true }).click();
  await expect(delivery.locator(".oc-delivery-package")).toHaveCount(1);
  await expect(delivery.locator(".oc-delivery-item")).toHaveCount(3);
  const archive = page.waitForEvent("download"); await delivery.getByRole("button", { name: "下载正式交付包", exact: true }).click();
  expect(await (await archive).failure()).toBeNull();
  for (const kind of ["received", "accepted"]) for (let index = 0; index < 3; index++) {
    const receipt = delivery.locator("form.oc-delivery-form").nth(index);
    await receipt.getByLabel("回执类型").selectOption(kind);
    await receipt.getByLabel("回复依据").fill(`SYNTHETIC_${kind}_${index}`);
    await receipt.getByLabel("工厂回复与处理说明").fill(`Synthetic factory ${kind} file ${index}, actual isolated fixture evidence`);
    await receipt.getByRole("checkbox", { name: "我已核对工厂实际回复、文件及制造清单校验值", exact: true }).check();
    await receipt.getByRole("button", { name: "登记回执", exact: true }).click();
    await expect(receipt.getByLabel("回复依据")).toHaveValue("");
  }
  await expect(delivery.locator(".oc-delivery-item-heading").getByText("工厂接受文件", { exact: true })).toHaveCount(3);
  await expect(overview.getByLabel("整单下一步").getByText("跟进整单开始生产", { exact: true })).toBeVisible();
  await expect(production.getByRole("button", { name: "记录整单开始生产", exact: true })).toBeEnabled();
  await expect(overview.getByText("有未保存的回执或返工内容，请先登记或清空表单，再更换工厂及交期筛选。", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("unified-receipts-desktop.png"), fullPage: true });
  await overview.getByLabel("整单下一步").getByRole("button", { name: "打开开工登记", exact: true }).click();
  await expect(production.getByLabel("整单工厂凭证")).toBeFocused();
  for (const [index, action] of ["记录整单开始生产", "记录整单生产完工"].entries()) {
    await production.getByLabel("整单工厂凭证").fill(`SYNTHETIC_WHOLE_${index}`);
    await production.getByLabel("整单进度发生时间").fill(await currentLocalMinute());
    await production.getByRole("button", { name: action, exact: true }).click();
    await expect(production.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }
  await fillQualityAssessment(production, standard.id, [{ label: "Inspect every pillow", score: "100", outcome: "passed" }]);
  await production.getByLabel("整单质检时间").fill(await currentLocalMinute());
  await production.getByRole("checkbox", { name: "已逐项核对本单全部商品 均符合所选标准" }).check();
  await production.getByRole("button", { name: "登记整单质检通过" }).click();
  await expect(production.getByText("全部商品已生产并通过质检。", { exact: false })).toBeVisible();
  const plan = await centerApi<WholeOrderFulfillmentView>(`order-centers/orders/${order.orderId}/fulfillment`);
  expect(plan.orderStatus).toBe("produced"); expect(plan.items.every(item => item.readyQuantity === 1)).toBe(true);
  await production.getByRole("button", { name: "去整单发货" }).click();
  await expect(page).toHaveURL(new RegExp(`/production\\?q=${order.externalLines[0]}`));
  const shipping = page.getByRole("region", { name: "整单发货", exact: true });
  await expect(shipping.locator("tbody tr")).toHaveCount(3);
  await expect(shipping.getByLabel("物流单号")).toBeFocused();
  await expect(overview.locator("details.oc-whole-records[open]")).toHaveCount(0);
  const picker = shipping.getByLabel("带入已有 ShipOS 运单", { exact: true });
  await picker.getByRole("button", { name: "带入整单包裹", exact: true }).click();
  await expect(shipping.getByLabel("物流单号", { exact: true })).toHaveValue(`TRACK-${order.externalId}`);
  await expect(shipping.getByLabel("承运商代码", { exact: true })).toHaveValue("UPS");
  await expect(shipping.getByLabel("承运商名称", { exact: true })).toHaveValue("Synthetic UPS");
  await expect(shipping.getByLabel("物流服务", { exact: true })).toHaveValue("Synthetic ground");
  await expect(shipping.getByRole("combobox", { name: "发货国家", exact: true })).toHaveValue("CN");
  await shipping.getByRole("checkbox", { name: "已核对该已有运单、承运信息和本单全部商品", exact: true }).check();
  const labelDownload = page.waitForEvent("download"); await picker.getByRole("link", { name: "下载现有面单", exact: true }).click();
  expect(await (await labelDownload).failure()).toBeNull();
  const filledShipDate = await currentLocalMinute();
  await shipping.getByLabel("计划发货时间").fill(filledShipDate);
  await expect(shipping.getByRole("group", { name: "装箱生产来源", exact: true })).toBeVisible();
  await expect(shipping.locator(".oc-shipment-source-row")).toHaveCount(3);
  await shipping.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true }).check();
  const firstProduction = plan.items[0]!.production!;
  await centerApi(`order-centers/production/${firstProduction.id}/inspections`, {
    qualityStandardVersionId: standard.id, expectedProductionProjectionVersion: firstProduction.projectionVersion,
    assessment: { formatVersion: 2, criterionResults: [{ code: "WHOLE", scoreBps: 10000, passed: true }] },
    result: "passed", scoreBps: 10000, inspectedAt: await page.evaluate(() => new Date().toISOString()), idempotencyKey: randomUUID(),
  });
  await shipping.getByRole("button", { name: "重新核对整单", exact: true }).click();
  await expect(shipping.getByText("生产来源、质检或占用数量已变化 当前填写已保留 请核对实物后重新分配", { exact: true })).toBeVisible();
  await expect(shipping.getByLabel("物流单号", { exact: true })).toHaveValue(`TRACK-${order.externalId}`);
  await expect(shipping.getByLabel("计划发货时间", { exact: true })).toHaveValue(filledShipDate);
  await expect(shipping.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true })).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await picker.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("shipment-waybill-mobile.png") });
  await shipping.locator(".oc-shipment-source-row").first().scrollIntoViewIfNeeded();
  await expect(shipping.locator(".oc-shipment-source-row input").first()).toBeInViewport();
  for (const input of await shipping.locator(".oc-shipment-source-row input").all()) expect((await input.boundingBox())!.width).toBeGreaterThan(220);
  await page.screenshot({ path: testInfo.outputPath("shipment-sources-stale-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shipping.getByRole("button", { name: "核对生产来源并重新分配", exact: true }).click();
  await expect(shipping.getByText("生产来源、质检或占用数量已变化 当前填写已保留 请核对实物后重新分配", { exact: true })).toHaveCount(0);
  await shipping.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true }).check();
  await expect(shipping.getByLabel("本商品装入数量")).toHaveCount(0);
  await shipping.getByRole("button", { name: "保存整单包裹（3 件）" }).click();
  await expect(page.getByRole("status").filter({ hasText: "整单包裹已保存" })).toBeVisible();
  expect((await centerApi<WholeOrderFulfillmentView>(`order-centers/orders/${order.orderId}/fulfillment`)).orderStatus).toBe("produced");
  const beforeReview = await centerApi<WholeOrderFulfillmentView>(`order-centers/orders/${order.orderId}/fulfillment`);
  await centerApi(`order-centers/production/${beforeReview.items[0]!.production!.id}/inspections`, {
    qualityStandardVersionId: standard.id, expectedProductionProjectionVersion: beforeReview.items[0]!.production!.projectionVersion,
    assessment: { formatVersion: 2, criterionResults: [{ code: "WHOLE", scoreBps: 10000, passed: true }] },
    result: "passed", scoreBps: 10000, inspectedAt: await page.evaluate(() => new Date().toISOString()), idempotencyKey: randomUUID(),
  });
  await page.getByLabel("核对说明").fill("Synthetic original pinned package before newer inspection");
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await expect(overview.getByText("生产来源或质检已变化 请保留填写并重新核对原批次", { exact: true })).toBeVisible();
  await expect(page.getByLabel("核对说明")).toHaveValue("Synthetic original pinned package before newer inspection");
  const sourceEditor = overview.locator(".oc-shipment-source-editor");
  await sourceEditor.getByText("核对生产来源并建立新版本", { exact: true }).click();
  await expect(sourceEditor.getByRole("form", { name: "修订包裹生产来源", exact: true })).toBeVisible();
  await sourceEditor.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true }).check();
  await sourceEditor.getByRole("button", { name: "保存新的发货版本", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("shipment-source-revision-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await sourceEditor.locator(".oc-shipment-source-row").first().scrollIntoViewIfNeeded();
  await expect(sourceEditor.locator(".oc-shipment-source-row input").first()).toBeInViewport();
  for (const input of await sourceEditor.locator(".oc-shipment-source-row input").all()) expect((await input.boundingBox())!.width).toBeGreaterThan(220);
  await page.screenshot({ path: testInfo.outputPath("shipment-source-revision-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await sourceEditor.getByRole("button", { name: "保存新的发货版本", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "新的发货版本已保存" })).toBeVisible();
  await expect(page.getByLabel("核对说明")).toHaveValue("");
  await page.getByLabel("核对说明").fill("Synthetic all three pillows and tracking verified");
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await expect(page.getByLabel("实际交运时间")).toBeEditable();
  const filledHandoverAt = await currentLocalMinute();
  await page.getByLabel("实际交运时间").fill(filledHandoverAt); await page.getByLabel("交运凭证 / 说明").fill("Synthetic factory picked up entire parcel");
  const rereadOperations = overview.getByRole("button", { name: "重新核对业务记录", exact: true });
  await rereadOperations.click();
  await expect(rereadOperations).toBeEnabled();
  await expect(page.getByLabel("实际交运时间")).toHaveValue(filledHandoverAt);
  await expect(page.getByLabel("交运凭证 / 说明")).toHaveValue("Synthetic factory picked up entire parcel");
  await page.getByRole("button", { name: "确认整单已出库", exact: true }).click();
  await expect.poll(async () => (await centerApi<WholeOrderFulfillmentView>(`order-centers/orders/${order.orderId}/fulfillment`)).orderStatus).toBe("shipped");
  await expect(shipping.getByText("整单已出库。下一步核对平台发货确认，并在下方登记依据。", { exact: true })).toBeVisible();
  await expect(shipping.locator(".oc-error")).toHaveCount(0);
  const orderRows = page.locator(".oc-page > .oc-table-wrap tbody tr")
    .filter({ has: page.getByRole("button", { name: order.externalId, exact: true }) });
  await expect(orderRows.locator('[data-order-status="shipped"]')).toHaveCount(1);
  const operations = await centerApi<OrderOperationsView>(`order-centers/lines/${order.lines[0]}/operations`);
  const dispatchedRecord = operations.production[0]!;
  const dispatchedProduction = dispatchedRecord.productionOrder;
  const postHandover = await page.request.post(`/api/order-centers/production/${dispatchedProduction.id}/inspections`, {
    headers: { origin: new URL(page.url()).origin },
    data: { qualityStandardVersionId: standard.id, expectedProductionProjectionVersion: dispatchedProduction.projectionVersion,
      assessment: { formatVersion: 2, criterionResults: [{ code: "WHOLE", scoreBps: 10000, passed: true }] },
      result: "passed", scoreBps: 10000, inspectedAt: await page.evaluate(() => new Date().toISOString()), idempotencyKey: randomUUID() },
  });
  expect(postHandover.status()).toBe(409);
  expect(await postHandover.text()).toContain("实际交运");
  expect((await centerApi<OrderOperationsView>(`order-centers/lines/${order.lines[0]}/operations`)).production[0]!.inspections).toHaveLength(dispatchedRecord.inspections.length);
  expect(operations.shipments).toHaveLength(1); expect(operations.shipments[0]!.packages).toHaveLength(2);
  expect(operations.shipments[0]!.physicalHandover).toMatchObject({ packageCount: 1, dispatchedPackageCount: 1, allDispatched: true });
  expect(operations.shipments[0]!.versions[0]!.shiposSource).toMatchObject({ supplierId: order.supplierId, labelAvailable: true, carrierMapping: { carrierCode: "UPS" } });
  expect(operations.shipments[0]!.packageLines).toHaveLength(6); expect(operations.shipments[0]!.writebacks).toHaveLength(0);
  expect(operations.shipments[0]!.productionAllocations).toHaveLength(6);
  expect(operations.shipments[0]!.versions).toHaveLength(2);
  expect(operations.shipments[0]!.versions[1]!.shiposSource?.recordId).toBe(operations.shipments[0]!.versions[0]!.shiposSource?.recordId);
  await expect(overview.getByRole("region", { name: "本单运单", exact: true }).getByText(`TRACK-${order.externalId}`, { exact: false }).first()).toBeVisible();
  await page.getByRole("dialog", { name: "整单详情", exact: true }).screenshot({ path: testInfo.outputPath("whole-shipment-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("dialog", { name: "整单详情", exact: true }).screenshot({ path: testInfo.outputPath("whole-shipment-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await overview.getByRole("button", { name: "登记本单售后问题", exact: true }).click();
  const caseForm = overview.locator('[data-order-action="after-sales-create"]');
  await expect(caseForm.getByRole("combobox", { name: "问题类型", exact: true })).toBeFocused();
  await caseForm.getByLabel("原因分类", { exact: true }).fill("SYNTHETIC_QUALITY");
  await caseForm.getByLabel("问题说明", { exact: true }).fill("Synthetic isolated whole order quality question");
  await caseForm.getByRole("button", { name: "登记售后", exact: true }).click();
  await expect(overview.getByText("Synthetic isolated whole order quality question", { exact: true })).toBeVisible();
  await expect(overview.getByRole("region", { name: "本单售后问题", exact: true })).toContainText("1 个未结案问题");
  expect(errors).toEqual([]);
});


test("fulfillment configuration keeps quality maintenance outside the daily production page", async ({ page }, testInfo) => {
  const name = `Synthetic config quality ${randomUUID().slice(0, 8)}`;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/settings/fulfillment");
  await expect(page.getByRole("heading", { name: "履约配置", exact: true })).toBeVisible();
  const form = page.getByRole("form", { name: "维护质检标准", exact: true });
  await form.getByLabel("标准名称", { exact: true }).fill(name);
  await form.getByLabel("检验内容", { exact: true }).fill("Synthetic verify every pillow size, contour and stitching");
  await form.getByLabel("合格分数", { exact: true }).fill("90");
  await form.getByRole("button", { name: "保存新标准版本", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "新质检标准版本已保存" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: name })).toContainText("V1");
  for (const [width, height, suffix] of [[1440, 1000, "desktop"], [390, 844, "mobile"]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`fulfillment-config-${suffix}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "返回生产列表", exact: true }).click();
  await expect(page.getByRole("heading", { name: "生产中心", exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "维护质检标准", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
