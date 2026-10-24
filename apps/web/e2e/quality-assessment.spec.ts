import { expect, test } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WholeOrderFulfillmentView } from "@yummyai/contracts/order/whole-fulfillment";
import type { OrderOperationsView } from "@yummyai/contracts/order/workspace";
import { centerApi } from "./order-centers-fixture";
import { completedPillows } from "./quality-production-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";
import { loginErp } from "./erp-identity-fixture";
import { fillQualityAssessment } from "./quality-assessment-form";

let worker: ChildProcess | undefined;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(async () => { await stopProductionEditorWorker(worker); });

test("whole criterion assessment blocks a high-score failed gate and records the exact accepted files", async ({ page }, info) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
  const order = await completedPillows(2);
  const standard = await weightedStandard(order.supplierId);
  await loginErp(page, "operator", "/production?q=" + order.externalId);
  await page.getByRole("button", { name: order.externalId, exact: true }).first().click();
  const region = page.getByRole("region", { name: "整单生产", exact: true });
  const form = region.getByRole("form", { name: "登记整单质检", exact: true });
  await fillQualityAssessment(form, standard.id, [
    { label: "尺寸与工艺", score: "90", outcome: "failed" }, { label: "外观", score: "95", outcome: "passed" },
  ]);
  await expect(form.getByRole("status")).toContainText("94.5 分 · 未通过");
  await expect(form.getByRole("button", { name: "登记整单质检通过", exact: true })).toBeDisabled();
  const blocked = await plan(order.orderId);
  expect(blocked.items.every(item => item.readyQuantity === 0)).toBe(true);
  const firstPin = blocked.items[0]!.production!;
  await centerApi("order-centers/production/" + firstPin.id + "/inspections", {
    qualityStandardVersionId: standard.id, expectedProductionProjectionVersion: firstPin.projectionVersion,
    assessment: { formatVersion: 2, criterionResults: [
      { code: "GEOMETRY", scoreBps: 9000, passed: true }, { code: "APPEARANCE", scoreBps: 9500, passed: true },
    ] }, result: "passed", scoreBps: 9450, inspectedAt: "2026-10-17T05:00:00.000Z", idempotencyKey: randomUUID(),
  });
  await region.getByRole("button", { name: "重新核对整单", exact: true }).click();
  await expect(form.getByRole("alert").filter({ hasText: "生产依据已更新" })).toBeVisible();
  await expect(form.getByLabel("尺寸与工艺 得分", { exact: true })).toHaveValue("90");
  await expect(form.getByRole("button", { name: "登记整单质检通过", exact: true })).toBeDisabled();
  await form.getByRole("button", { name: "核对新记录并重新逐项检查", exact: true }).click();
  await expect(form.getByLabel("尺寸与工艺 得分", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("尺寸与工艺 核验结果", { exact: true })).toHaveValue("");
  await fillQualityAssessment(form, standard.id, [
    { label: "尺寸与工艺", score: "90", outcome: "failed" }, { label: "外观", score: "95", outcome: "passed" },
  ]);
  await form.getByLabel("尺寸与工艺 核验结果", { exact: true }).selectOption("passed");
  await expect(form.getByRole("status")).toContainText("符合所选标准");
  await form.getByLabel("整单质检时间", { exact: true }).fill("2026-10-18T05:00");
  await form.getByRole("checkbox", { name: "已逐项核对本单全部商品 均符合所选标准", exact: true }).check();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await form.getByLabel("尺寸与工艺 核验结果", { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 390) {
      expect((await form.getByLabel("尺寸与工艺 得分", { exact: true }).boundingBox())!.width).toBeGreaterThan(220);
      expect((await form.getByRole("button", { name: "登记整单质检通过", exact: true }).boundingBox())!.height).toBeLessThan(72);
    }
    await page.screenshot({ path: info.outputPath("criterion-assessment-" + width + ".png") });
  }
  await form.getByRole("button", { name: "登记整单质检通过", exact: true }).click();
  await expect(region.getByText("全部商品已生产并通过质检。", { exact: false })).toBeVisible();
  const saved = await plan(order.orderId);
  expect(saved.items.every(item => item.readyQuantity === item.quantity)).toBe(true);
  for (const lineId of order.lines) {
    const operations = await centerApi<OrderOperationsView>("order-centers/lines/" + lineId + "/operations");
    expect(operations.production[0]!.deliveryReceipt?.status).toBe("accepted");
    expect(operations.production[0]!.inspections[0]).toMatchObject({ assessmentVersion: 2, result: "passed", scoreBps: 9450,
      criterionResults: expect.arrayContaining([expect.objectContaining({ code: "GEOMETRY", passed: true })]) });
  }
  expect(pageErrors).toEqual([]);
});

test("single inspection keeps a conflicted draft, rejects a forged pass and requires fresh explicit checks", async ({ page }, info) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
  const order = await completedPillows(1), standard = await weightedStandard(order.supplierId);
  const before = await plan(order.orderId), pin = before.items[0]!.production!;
  await loginErp(page, "operator", "/production?q=" + order.externalId);
  await page.getByRole("button", { name: order.externalId, exact: true }).first().click();
  const overview = page.getByRole("region", { name: "整单详情", exact: true });
  await overview.getByText("查看本商品生产记录与异常处理", { exact: true }).click();
  await overview.getByText("登记质检结果", { exact: true }).click();
  const form = overview.locator("form").filter({ has: page.getByRole("button", { name: "保存质检结果", exact: true }) });
  await fillQualityAssessment(form, standard.id, [{ label: "尺寸与工艺", score: "90", outcome: "passed" }, { label: "外观", score: "95", outcome: "passed" }]);
  await form.getByLabel("检验时间", { exact: true }).fill("2026-10-18T05:00");
  const previous = await centerApi<{ inspections: Array<{ id: string }> }>("order-centers/production/" + pin.id + "/inspections", {
    qualityStandardVersionId: standard.id, expectedProductionProjectionVersion: pin.projectionVersion,
    assessment: { formatVersion: 2, criterionResults: [
      { code: "GEOMETRY", scoreBps: 5000, passed: false }, { code: "APPEARANCE", scoreBps: 5000, passed: true },
    ] }, result: "failed", scoreBps: 5000, inspectedAt: "2026-10-17T05:00:00.000Z",
    defects: [{ code: "GEOMETRY", severity: "major", responsibility: "supplier", disposition: "rework", note: "Synthetic operator identified a repairable fault" }],
    idempotencyKey: randomUUID(),
  });
  await form.getByRole("button", { name: "保存质检结果", exact: true }).click();
  await expect(overview.getByRole("alert").filter({ hasText: "生产记录已变化" })).toBeVisible();
  await expect(form.getByLabel("尺寸与工艺 得分", { exact: true })).toHaveValue("90");
  await expect(form.getByLabel("外观 得分", { exact: true })).toHaveValue("95");
  const current = await plan(order.orderId), currentPin = current.items[0]!.production!;
  const forbidden = await page.request.post("/api/order-centers/production/" + pin.id + "/inspections", {
    headers: { origin: new URL(page.url()).origin },
    data: { qualityStandardVersionId: standard.id, expectedProductionProjectionVersion: currentPin.projectionVersion,
      assessment: { formatVersion: 2, criterionResults: [
        { code: "GEOMETRY", scoreBps: 9000, passed: false }, { code: "APPEARANCE", scoreBps: 9500, passed: true },
      ] }, result: "passed", scoreBps: 9450, inspectedAt: "2026-10-18T05:00:00.000Z", idempotencyKey: randomUUID() },
  });
  expect(forbidden.status()).toBe(422);
  expect((await centerApi<OrderOperationsView>("order-centers/lines/" + order.lines[0] + "/operations")).production[0]!.inspections).toHaveLength(previous.inspections.length);
  await overview.getByRole("button", { name: "重新核对业务记录", exact: true }).click();
  await expect(form.getByRole("alert").filter({ hasText: "生产依据已更新" })).toBeVisible();
  await expect(form.getByLabel("尺寸与工艺 得分", { exact: true })).toHaveValue("90");
  await form.getByRole("button", { name: "核对新记录并重新逐项检查", exact: true }).click();
  await expect(form.getByLabel("尺寸与工艺 核验结果", { exact: true })).toHaveValue("");
  await fillQualityAssessment(form, standard.id, [{ label: "尺寸与工艺", score: "90", outcome: "failed" }, { label: "外观", score: "95", outcome: "passed" }]);
  await expect(form.getByRole("button", { name: "保存质检结果", exact: true })).toBeDisabled();
  await expect(form.getByLabel("责任归属", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("处理方式", { exact: true })).toHaveValue("");
  await form.getByLabel("缺陷严重度", { exact: true }).selectOption("major");
  await form.getByLabel("责任归属", { exact: true }).selectOption("supplier");
  await form.getByLabel("处理方式", { exact: true }).selectOption("rework");
  await form.getByLabel("不合格说明", { exact: true }).fill("Synthetic operator explicitly selected repair of the geometry fault");
  await form.getByLabel("检验时间", { exact: true }).fill("2026-10-18T06:00");
  await expect(form.getByRole("status")).toContainText("94.5 分 · 未通过");
  await page.setViewportSize({ width: 390, height: 844 });
  await form.getByLabel("责任归属", { exact: true }).scrollIntoViewIfNeeded();
  expect((await form.getByLabel("责任归属", { exact: true }).boundingBox())!.width).toBeGreaterThan(220);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("quality-defect-390.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await form.getByRole("button", { name: "保存质检结果", exact: true }).click();
  await expect(overview.getByRole("status").filter({ hasText: "质检结果已保存" })).toBeVisible();
  const saved = (await centerApi<OrderOperationsView>("order-centers/lines/" + order.lines[0] + "/operations")).production[0]!;
  expect(saved.inspections).toHaveLength(previous.inspections.length + 1);
  expect(saved.inspections[0]).toMatchObject({ assessmentVersion: 2, result: "failed", scoreBps: 9450 });
  expect(saved.defects).toContainEqual(expect.objectContaining({ code: "GEOMETRY", severity: "major", responsibility: "supplier", disposition: "rework" }));
  await expect(overview.getByText("GEOMETRY · 重大 · 责任供应商 · 返工 · 影响数量未记录", { exact: true }).first()).toBeVisible();
  // Explicit transport-failure fixture; real current permissions are covered by the API tests.
  const readPath = "**/api/order-centers/lines/" + order.lines[0] + "/operations";
  await page.route(readPath, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Synthetic operations read unavailable" }) }));
  await overview.getByRole("button", { name: "重新核对业务记录", exact: true }).click();
  await expect(overview.getByRole("alert").filter({ hasText: "记录暂时无法读取" })).toBeVisible();
  await expect(overview.locator(".oc-production-history .oc-record")).toHaveCount(0);
  await page.unroute(readPath);
  expect(pageErrors).toEqual([]);
});

async function weightedStandard(supplierId: string) {
  return centerApi<{ id: string }>("order-centers/quality-standards", { name: "Synthetic criterion standard " + randomUUID().slice(0, 8),
    supplierId, minimumScoreBps: 8000, criteria: [
      { code: "GEOMETRY", label: "尺寸与工艺", weightBps: 1000, blocking: true },
      { code: "APPEARANCE", label: "外观", weightBps: 9000, blocking: false },
    ] });
}
const plan = (orderId: string) => centerApi<WholeOrderFulfillmentView>("order-centers/orders/" + orderId + "/fulfillment");
