import { expect, test } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { Permission } from "@yummyai/authz";
import { ProductionMaterialsWorkspaceSchema } from "@yummyai/contracts/order/material-execution";
import { SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";
import { prepareDeliveryOrder } from "./production-delivery-fixture";
import { loginErp, changeErpRights } from "./erp-identity-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker } from "./production-editor-fixture";
import { centerApi } from "./order-centers-fixture";

let worker: ChildProcess | undefined;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(async () => { await stopProductionEditorWorker(worker); });

test("personal procurement and inventory pages remain readable with exact material contracts", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase(), stockName = `Synthetic precise material ${suffix}`;
  const stock = await centerApi<{ id: string }>("inventory/stock-items", { skuId: null, code: `PRECISE-${suffix}`, name: stockName, baseUnit: "meter" });
  const warehouse = await centerApi<{ id: string }>("inventory/warehouses", { code: `PRECISE-${suffix}`, name: `Synthetic precise warehouse ${suffix}`, type: "owned", countryCode: "US", timeZone: "America/New_York" });
  const location = await centerApi<{ id: string }>("inventory/locations", { warehouseId: warehouse.id, code: `PRECISE-${suffix}`, name: `Synthetic precise bin ${suffix}` });
  await centerApi("inventory/movements", { stockItemId: stock.id, locationId: location.id, lotId: null, quantityDelta: "0.123456789", unit: "meter", bucket: "physical", type: "opening", sourceType: "opening", sourceId: stock.id,
    reasonCode: "SYNTHETIC_PRECISE_OPENING", occurredAt: new Date().toISOString(), idempotencyKey: crypto.randomUUID() });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", "/procurement");
  await expect(page.getByRole("heading", { name: "采购与补货", exact: true })).toBeVisible();
  await expect(page.locator(".procurement-load-state")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增采购单", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("procurement-exact-contract-desktop.png"), fullPage: true, animations: "disabled" });
  const response = await page.goto("/inventory"); expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "库存台账", exact: true })).toBeVisible();
  await expect(page.locator(".inventory-load-state")).toHaveCount(0);
  const balance = page.locator(".inventory-balance-table tbody tr").filter({ hasText: stockName });
  await expect(balance.getByRole("cell", { name: "0.123456789", exact: true })).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("inventory-exact-contract-mobile.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("personal reviewed production reports factory material, corrects the original report and enforces current inventory rights", async ({ page }, info) => {
  test.setTimeout(240_000);
  // Disposable deterministic artwork follows the confirmed standard, not a customer production approval.
  const order = await prepareDeliveryOrder(1, false, { materialResponsibility: "factory" }), line = order.lines[0]!, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", `/production?line=${line}`);
  const response = await page.request.get(`/api/order-centers/lines/${line}/operations`);
  expect(response.status()).toBe(200);
  const operations = await response.json(), original = operations.production[0], production = original.productionOrder.id as string;
  const version = original.versions.find((item: { versionNumber: number }) => item.versionNumber === original.productionOrder.currentVersionNumber);
  const projectResponse = await page.request.get(`/api/production-editor/projects/${version.sourceEditorProjectId}`);
  expect(projectResponse.status()).toBe(200); const project = await projectResponse.json();
  expect(project.version.id).toBe(version.sourceEditorVersionId);
  expect(project.version.document.spec.factoryStandardId).toBe(SHAPED_PILLOW_FACTORY_STANDARD.id);
  const read = async () => { const response = await page.request.get(`/api/production-materials/${production}`); expect(response.status()).toBe(200); return ProductionMaterialsWorkspaceSchema.parse(await response.json()); };
  const before = await read(); expect(before.lines[0]).toMatchObject({ responsibility: "factory", actualSource: "manual_factory_report", actualNetQuantity: 0 });
  const history = page.locator("details.oc-production-history");
  await history.locator("summary").click();
  const panel = history.getByRole("region", { name: "原生产备料与实际耗用", exact: true });
  await panel.getByRole("button", { name: "备料与实际耗用", exact: true }).click();
  await expect(panel).toContainText("工厂自备 · 手工报告");
  await expect(panel.getByRole("button", { name: "备料预留", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "登记工厂报告", exact: true }).click();
  const form = panel.getByRole("form", { name: "登记工厂报告", exact: true });
  await expect(form.getByLabel("库位与批次", { exact: true })).toHaveCount(0);
  await form.getByLabel("本次数量", { exact: true }).fill("0.6");
  await form.getByLabel(/^工厂报告来源/).fill("SYNTHETIC-FACTORY-MATERIAL-REPORT-ONLY");
  const submit = form.getByRole("button", { name: "登记工厂报告", exact: true });
  await expect(submit).toBeDisabled();
  await form.getByRole("checkbox", { name: "已核对工厂原报告与实际发生数量", exact: true }).check();
  await expect(submit).toBeEnabled();
  await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("factory-material-report-desktop.png"), animations: "disabled", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("factory-material-report-mobile.png"), animations: "disabled", fullPage: true });
  await submit.click();
  const recovery = panel.getByRole("region", { name: "待确认物料提交", exact: true });
  await expect(recovery).toContainText("实际物料已记录"); await expect(recovery).toContainText("0.6");
  await recovery.getByRole("button", { name: "已核对本次结果", exact: true }).click(); await expect(recovery).toHaveCount(0);
  await panel.getByRole("button", { name: "更正原报告", exact: true }).click();
  const correction = panel.getByRole("form", { name: "更正原工厂报告", exact: true });
  await expect(correction).toContainText("可更正余量 0.6 米");
  await correction.getByLabel("原报告减少数量", { exact: true }).fill("0.1");
  await correction.getByLabel("原因或说明", { exact: true }).fill("Synthetic operator corrected the original factory report after checking the source");
  await correction.getByRole("button", { name: "更正原工厂报告", exact: true }).click();
  await expect(recovery).toContainText("实际物料已记录");
  await recovery.getByRole("button", { name: "已核对本次结果", exact: true }).click(); await expect(recovery).toHaveCount(0);
  const actual = await read(); expect(actual.lines[0]!.actualNetQuantity).toBe("0.5");
  expect(actual.entries.map(entry => entry.kind).sort()).toEqual(["factory_correction", "factory_report"]);
  expect(actual.entries.every(entry => entry.movementId === null && entry.reservationId === null && entry.locationId === null)).toBe(true);
  const report = actual.entries.find(entry => entry.kind === "factory_report")!, corrected = actual.entries.find(entry => entry.kind === "factory_correction")!;
  expect(corrected.originalEntryId).toBe(report.id); expect(report.correctableQuantity).toBe("0.5");
  await page.setViewportSize({ width: 1440, height: 1000 });
  try {
    await changeErpRights("operator", Object.values(Permission).filter(permission => permission !== Permission.InventoryWrite));
    const navigation = page.waitForEvent("framenavigated", { predicate: frame => frame === page.mainFrame(), timeout: 20_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation;
    await history.locator("summary").click(); await panel.getByRole("button", { name: "备料与实际耗用", exact: true }).click();
    await expect(panel).toContainText("报告净数量"); await expect(panel.getByRole("button", { name: "登记工厂报告", exact: true })).toHaveCount(0);
    const readonly = await read(); expect(readonly.canWrite).toBe(false);
    const rejected = await page.request.post(`/api/production-materials/${production}/commands`, { headers: { origin: new URL(page.url()).origin }, data: { kind: "factory_report", materialCode: "FABRIC", bindingId: readonly.bindingId,
      expectedProductionRevision: readonly.productionRevision, contextAuthority: readonly.contextAuthority, idempotencyKey: crypto.randomUUID(), occurredAt: new Date().toISOString(), reason: null, quantity: "0.1", reportReference: "SYNTHETIC-DENIED", actualConfirmed: true } });
    expect(rejected.status(), JSON.stringify(await rejected.json())).toBe(403); expect((await read()).entries).toHaveLength(2);
  } finally { await changeErpRights("operator", Object.values(Permission)); }
  expect(errors).toEqual([]);
});
