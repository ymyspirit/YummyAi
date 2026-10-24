import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { QualityGroupsWorkspace } from "@yummyai/contracts/order/quality-groups";
import type { ShipmentProductionSource } from "@yummyai/contracts/order/shipment";
import type { WholeOrderFulfillmentView } from "@yummyai/contracts/order/whole-fulfillment";
import { centerApi } from "./order-centers-fixture";
import { completedPillows } from "./quality-production-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";
import { loginErp } from "./erp-identity-fixture";
import { fillProductionCapacity } from "./factory-capacity-fixture";

let worker: ChildProcess | undefined;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(async () => { await stopProductionEditorWorker(worker); });
const plan = (id: string) => centerApi<WholeOrderFulfillmentView>("order-centers/orders/" + id + "/fulfillment");
const groups = (id: string) => centerApi<QualityGroupsWorkspace>("order-centers/production/" + id + "/quality-groups");
const goodLabel = "Synthetic bin A " + "LONGSYNTHETICGROUP".repeat(6);

test("physical quality groups keep independent quantities and recover a lost remake receipt without a second task", async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const fixture = await setup(page), panel = fixture.panel;
  await recordRoot(panel, fixture.standardId);
  const saved = await groups(fixture.productionId);
  expect(saved.groups).toHaveLength(3);
  await expect(panel.getByText("已记录实物组 合格 2 件 · 待处理 3 件", { exact: true })).toBeVisible();
  const totals = panel.getByRole("definition");
  await expect(totals).toHaveText(["3 件", "1 件"]);
  expect((await plan(fixture.order.orderId)).items[0]!.readyQuantity).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  const longLabel = panel.getByText(goodLabel, { exact: true });
  await longLabel.scrollIntoViewIfNeeded();
  const labelBox = (await longLabel.boundingBox())!;
  expect(labelBox.x).toBeGreaterThanOrEqual(0); expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(390);
  expect(labelBox.height).toBeGreaterThan(30);
  await page.screenshot({ path: info.outputPath("group-long-label-390.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const held = saved.groups.find(group => group.label === "Synthetic bin B")!;
  await panel.locator(`[data-quality-group="${held.id}"]`).getByRole("button", { name: "按本组补做", exact: true }).click();
  const form = panel.getByRole("form", { name: "按组安排补做", exact: true });
  await expect(form.getByLabel("本次补做数量", { exact: true })).toHaveValue("");
  await form.getByLabel("关联原缺陷", { exact: true }).selectOption(held.defects[0]!.id);
  await form.getByLabel("本次补做数量", { exact: true }).fill("1");
  await form.getByLabel("补做原因", { exact: true }).fill("Synthetic operator selected one segregated piece");
  await form.getByLabel("补做工厂当地预计完成时间", { exact: true }).fill(fixture.order.capacity.dueLocal);
  const manufacturing = form.getByRole("group", { name: "本次制造依据", exact: true });
  await manufacturing.getByLabel("制造版本", { exact: true }).selectOption(fixture.order.manufacturing.versionId);
  await manufacturing.getByRole("checkbox").check();
  await form.getByRole("checkbox", { name: "已核对本次取用的原组实物和补做数量", exact: true }).check();
  await fillProductionCapacity(form, fixture.order.capacity);
  await inspectWidths(page, form, info, "group-remake");
  const payloads: unknown[] = []; let dropOnce = true;
  await page.route("**/api/order-centers/recoveries", async route => {
    if (route.request().method() !== "POST") return route.continue();
    payloads.push(route.request().postDataJSON());
    if (!dropOnce) return route.continue();
    dropOnce = false;
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.abort("failed");
  });
  await form.getByRole("button", { name: "创建本组补做任务", exact: true }).click();
  const recover = form.getByRole("button", { name: "恢复本次提交结果", exact: true });
  await expect(recover).toBeVisible();
  await panel.getByRole("button", { name: "重新读取实物组", exact: true }).click();
  await expect(form.getByRole("alert").filter({ hasText: "原生产依据或实物数量已变化" })).toBeVisible();
  await expect(form.getByLabel("本次补做数量", { exact: true })).toHaveValue("1");
  await expect(form.getByLabel("本次补做数量", { exact: true })).toBeDisabled();
  await expect(recover).toBeEnabled();
  await recover.click();
  await expect(form).toHaveCount(0);
  expect(payloads).toHaveLength(2); expect(payloads[1]).toEqual(payloads[0]);
  const current = await groups(fixture.productionId), after = current.groups.find(group => group.id === held.id)!;
  expect(after).toMatchObject({ remakeQuantity: 1, remainingRemakeQuantity: 1 });
  expect(after.replacements).toHaveLength(1);
  const row = panel.locator(`[data-quality-group="${held.id}"]`);
  await expect(row.getByRole("link", { name: /^补做单 / })).toHaveAttribute("href", "#production-" + after.replacements[0]!.productionOrderId);
  await row.getByRole("button", { name: "按本组补做", exact: true }).click();
  const invalid = panel.getByRole("form", { name: "按组安排补做", exact: true });
  await invalid.getByLabel("本次补做数量", { exact: true }).fill("2");
  await invalid.getByRole("checkbox", { name: "已核对本次取用的原组实物和补做数量", exact: true }).check();
  await expect(invalid.getByRole("alert").filter({ hasText: "不能超过原组剩余数量" })).toBeVisible();
  await expect(invalid.getByRole("button", { name: "创建本组补做任务", exact: true })).toBeDisabled();
  expect(payloads).toHaveLength(2); expect(errors).toEqual([]);
});

test("physical quality groups freeze the shipped group and let the operator reinspect the other held pieces", async ({ page }, info) => {
  test.setTimeout(300_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const fixture = await setup(page);
  await recordRoot(fixture.panel, fixture.standardId);
  const root = await groups(fixture.productionId), good = root.groups.find(group => group.label === goodLabel)!, held = root.groups.find(group => group.label === "Synthetic bin B")!;
  const source = (await centerApi<ShipmentProductionSource[]>(`orders/${fixture.order.orderId}/shipment-sources`)).find(item => item.qualityGroupId === good.id)!;
  const shipment = await centerApi<{ shipment: { id: string } }>(`orders/${fixture.order.orderId}/shipments`, {
    shipDate: new Date().toISOString(), shipFromCountryCode: "US", idempotencyKey: randomUUID(),
    packages: [{ packageReferenceId: "Synthetic partial group " + randomUUID(), trackingNumber: "SYNTHETIC-" + randomUUID(), carrierCode: "SYNTHETIC",
      carrierName: "Synthetic group carrier", carrierService: "Synthetic test only", lines: [{ orderLineId: fixture.order.lines[0], quantity: 2,
        productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
          qualityInspectionId: source.qualityInspectionId, qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity: 2 }] }] }],
  });
  await centerApi(`order-centers/shipments/${shipment.shipment.id}/review`, { expectedCurrentVersion: 1, decision: "approved", reasonCode: "SYNTHETIC_GROUP_CHECKED",
    reason: "Synthetic partial test group only; no external handover", idempotencyKey: randomUUID() });
  await centerApi(`order-centers/shipments/${shipment.shipment.id}/dispatch`, { expectedVersion: 1, occurredAt: new Date().toISOString(),
    reason: "Synthetic isolated handover fixture only", idempotencyKey: randomUUID() });
  await fixture.panel.getByRole("button", { name: "重新读取实物组", exact: true }).click();
  const goodRow = fixture.panel.locator(`[data-quality-group="${good.id}"]`), heldRow = fixture.panel.locator(`[data-quality-group="${held.id}"]`);
  await expect(goodRow.getByText("已交运 2 件", { exact: false })).toBeVisible();
  await expect(goodRow.getByRole("button", { name: "按本组复检", exact: true })).toBeDisabled();
  await expect(heldRow.getByRole("button", { name: "按本组复检", exact: true })).toBeEnabled();
  await heldRow.getByRole("button", { name: "按本组复检", exact: true }).click();
  const form = fixture.panel.getByRole("form", { name: "实物分组检验", exact: true });
  await expect(form.getByText("本次需完整覆盖 2 件", { exact: false })).toBeVisible();
  await form.getByLabel("检验标准", { exact: true }).selectOption(fixture.standardId);
  await fillGroup(form.getByRole("group", { name: "实物组 1", exact: true }), "Synthetic repaired B", 2, []);
  await form.getByLabel("实际检验时间", { exact: true }).fill(localTime(Date.now()));
  await form.getByRole("checkbox", { name: "已按实物隔离各组并逐项检查 组间没有重复 数量覆盖本次范围", exact: true }).check();
  await inspectWidths(page, form, info, "group-reinspection");
  await form.getByRole("button", { name: "保存实物分组检验", exact: true }).click();
  await expect(form).toHaveCount(0);
  const updated = await groups(fixture.productionId);
  expect(updated.groups.find(group => group.id === good.id)).toMatchObject({ active: true, inspectionId: good.inspectionId, shippedQuantity: 2 });
  expect(updated.groups.find(group => group.id === held.id)).toMatchObject({ active: false });
  expect(updated.groups.filter(group => group.parentGroupId === held.id)).toMatchObject([{ quantity: 2, result: "passed", active: true }]);
  expect((await plan(fixture.order.orderId)).items[0]!.readyQuantity).toBe(4);
  const next = await centerApi<ShipmentProductionSource[]>(`orders/${fixture.order.orderId}/shipment-sources`);
  expect(next.find(item => item.qualityGroupId === good.id)).toMatchObject({ qualityInspectionId: source.qualityInspectionId, availableQuantity: 0 });
  expect(errors).toEqual([]);
});

async function setup(page: Page) {
  const order = await completedPillows(1, 5), current = await plan(order.orderId), productionId = current.items[0]!.production!.id;
  const standard = await centerApi<{ id: string }>("order-centers/quality-standards", { name: "Synthetic grouped standard " + randomUUID().slice(0, 8), supplierId: order.supplierId,
    minimumScoreBps: 9000, criteria: [{ code: "COLOR", label: "色差", weightBps: 5000, blocking: true }, { code: "STITCH", label: "车缝", weightBps: 5000, blocking: true }] });
  await loginErp(page, "operator", "/production?q=" + order.externalId);
  await page.getByRole("button", { name: order.externalId, exact: true }).first().click();
  const overview = page.getByRole("region", { name: "整单详情", exact: true });
  await overview.getByText("查看本商品生产记录与异常处理", { exact: true }).click();
  const panel = overview.locator(`#production-${productionId} .oc-quality-groups-panel`);
  await panel.locator("summary").click();
  await expect(panel.getByRole("button", { name: "按整批实物建立分组检验", exact: true })).toBeEnabled();
  return { order, productionId, standardId: standard.id, panel };
}
async function recordRoot(panel: Locator, standardId: string) {
  await panel.getByRole("button", { name: "按整批实物建立分组检验", exact: true }).click();
  const form = panel.getByRole("form", { name: "实物分组检验", exact: true });
  await form.getByLabel("检验标准", { exact: true }).selectOption(standardId);
  await fillGroup(form.getByRole("group", { name: "实物组 1", exact: true }), goodLabel, 2, []);
  await form.getByRole("button", { name: "增加实物组", exact: true }).click();
  await fillGroup(form.getByRole("group", { name: "实物组 2", exact: true }), "Synthetic bin B", 2, ["COLOR"]);
  await form.getByRole("button", { name: "增加实物组", exact: true }).click();
  await fillGroup(form.getByRole("group", { name: "实物组 3", exact: true }), "Synthetic bin C", 1, ["COLOR", "STITCH"]);
  await expect(form.getByRole("status")).toHaveText("已分组 5 / 5 件 · 合格 2 件 · 待处理 3 件");
  await form.getByLabel("实际检验时间", { exact: true }).fill(localTime(Date.now() - 60_000));
  await form.getByRole("checkbox", { name: "已按实物隔离各组并逐项检查 组间没有重复 数量覆盖本次范围", exact: true }).check();
  await form.getByRole("button", { name: "保存实物分组检验", exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function fillGroup(group: Locator, label: string, quantity: number, defects: string[]) {
  await group.getByLabel("隔离位置标识", { exact: true }).fill(label);
  await group.getByLabel("本组实物数量", { exact: true }).fill(String(quantity));
  for (const [code, name] of [["COLOR", "色差"], ["STITCH", "车缝"]]) {
    await group.getByLabel(name + " 得分", { exact: true }).fill(defects.includes(code!) ? "90" : "100");
    await group.getByLabel(name + " 核验结果", { exact: true }).selectOption(defects.includes(code!) ? "failed" : "passed");
  }
  for (const [index, code] of defects.entries()) {
    await group.getByRole("button", { name: "增加缺陷", exact: true }).click();
    const defect = group.getByRole("group", { name: "缺陷 " + (index + 1), exact: true });
    await defect.getByLabel("缺陷项目", { exact: true }).selectOption(code);
    await defect.getByLabel("缺陷严重度", { exact: true }).selectOption("major");
    await defect.getByLabel("责任归属", { exact: true }).selectOption("supplier");
    await defect.getByLabel("处理方式", { exact: true }).selectOption("remake");
    await defect.getByLabel("缺陷说明", { exact: true }).fill("Synthetic operator checked the actual segregated defect");
  }
}
async function inspectWidths(page: Page, form: Locator, info: TestInfo, name: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await form.locator("input:not([type=hidden])").first().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 390) expect((await form.getByRole("button").last().boundingBox())!.height).toBeLessThan(85);
    await page.screenshot({ path: info.outputPath(name + "-" + width + ".png") });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}
function localTime(ms: number) {
  const value = new Date(ms); value.setSeconds(0, 0);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
