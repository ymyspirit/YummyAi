import { expect, test, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { InventoryWorkspaceViewSchema } from "@yummyai/contracts/inventory";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { loginErp, changeErpRights } from "./erp-identity-fixture";
import { publishIncomingStandard, fillIncomingArrival, executePreparedIncoming, inspectIncoming, reviewIncoming, fillIncomingPosting, acknowledgeIncoming } from "./incoming-workflow-fixture";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(database.pathname)) throw new Error("Disposable incoming browser fixture required");
const base = process.env.API_BASE_URL!.replace(/\/$/, "");
async function api(path: string, body?: unknown) {
  const response = await fetch(base + "/v1/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Synthetic incoming fixture API failed ${response.status}`);
  return response.json();
}
async function seed() {
  const prefix = `INC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const supplier = await api("sourcing/suppliers", { name: `Synthetic ${prefix} supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" });
  const warehouse = await api("inventory/warehouses", { code: `${prefix}-WH`, name: `Synthetic ${prefix} warehouse`, type: "owned", countryCode: "US", timeZone: "UTC" });
  const location = await api("inventory/locations", { warehouseId: warehouse.id, code: `${prefix}-LOC`, name: `Synthetic ${prefix} hold` });
  const stock = await api("inventory/stock-items", { skuId: null, code: `${prefix}-MAT`, name: `Synthetic ${prefix} measured fabric`, baseUnit: "meter", materialKind: "material" });
  const order = await api("procurement/purchase-orders", { code: `${prefix}-PO`, supplierId: supplier.id, requisitionId: null, quoteId: null, currency: "USD", expectedAt: "2026-10-21T00:00:00Z",
    lines: [{ lineKey: "L1", stockItemId: stock.id, destinationLocationId: location.id, quantity: 1, unit: "meter", unitCostMinor: 100 }], idempotencyKey: crypto.randomUUID() });
  await api(`procurement/purchase-orders/${order.id}/reviews`, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC_REVIEW", idempotencyKey: crypto.randomUUID() });
  return { prefix, order, stock, location };
}
async function open(page: Page, orderId: string) {
  const row = page.locator(`#purchase-${orderId}`);
  await row.getByRole("button", { name: "来料检验与入账", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "来料检验与入账", exact: true });
  await expect(dialog.getByRole("button", { name: "登记实际到货", exact: true })).toBeEnabled(); return dialog;
}
async function physical(stockId: string) {
  const workspace = InventoryWorkspaceViewSchema.parse(await api("inventory/workspace"));
  return sumStockQuantities(workspace.balances.filter(row => row.stockItemId === stockId).map(row => row.physicalQuantity));
}

test("personal incoming flow restores original input and unknown stock results, with exact fractions and actual returns", async ({ page }, info) => {
  test.setTimeout(240_000);
  const b = await seed(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/procurement");
  let dialog = await open(page, b.order.id);
  await publishIncomingStandard(dialog, b.stock.id, `${b.prefix} controlled actual observations`);
  const lot = `${b.prefix} 原批号 Ab/2026`, reference = "Synthetic actual receiving source ".repeat(16).trim();
  await fillIncomingArrival(dialog, b.location.id, "0.123456789", lot, reference);
  const lostPreparation = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    await route.fetch(); await route.abort("connectionreset");
  };
  await page.route("**/api/incoming/commands", lostPreparation);
  await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
  await expect(dialog).toContainText("保存结果待核对 已固定本次原填写");
  await expect(dialog.getByLabel("实际交接凭据", { exact: true })).toHaveValue(reference);
  expect(await physical(b.stock.id)).toBe(0);
  await page.unroute("**/api/incoming/commands", lostPreparation);
  await dialog.getByRole("button", { name: "重新读取记录", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "核对原提交" })).toContainText(lot);
  await page.reload();
  dialog = await open(page, b.order.id);
  await dialog.getByRole("button", { name: "恢复原提交", exact: true }).click();
  const original = dialog.getByRole("region", { name: "核对原提交" });
  await expect(original).toContainText(reference); await expect(original).toContainText(lot);
  await original.getByLabel("我已核对原填写与本次实际业务依据", { exact: true }).check();
  await original.getByRole("button", { name: "确认执行原提交", exact: true }).click();
  await expect(original).toContainText("实际业务结果已保存"); await acknowledgeIncoming(dialog);
  expect(await physical(b.stock.id)).toBe(0);
  await expect(dialog.locator(".incoming-arrival")).toHaveCount(1);
  await inspectIncoming(dialog, "0.1", "0.02", "0.001"); await reviewIncoming(dialog);
  expect(await physical(b.stock.id)).toBe(0);
  await fillIncomingPosting(dialog, "0.1", "0.02", b.location.id);
  await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
  await expect(original).toContainText("待核对执行");
  let originalId = "";
  const lostStockResult = async (route: Route) => {
    originalId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    await route.fetch(); await route.abort("connectionreset");
  };
  await page.route("**/api/incoming/commands/*/execute", lostStockResult);
  await original.getByLabel("我已核对原填写与本次实际业务依据", { exact: true }).check();
  await original.getByRole("button", { name: "确认执行原提交", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(await physical(b.stock.id)).toBe("0.1");
  await page.unroute("**/api/incoming/commands/*/execute", lostStockResult);
  await dialog.getByRole("button", { name: "重新读取记录", exact: true }).click();
  await expect(original).toContainText("实际业务结果已保存");
  const retry = await page.request.post(`/api/incoming/commands/${originalId}/execute`, { data: {}, headers: { origin: "http://localhost:3130" } });
  expect(retry.ok()).toBe(true); expect((await retry.json()).status).toBe("succeeded");
  expect(await physical(b.stock.id)).toBe("0.1"); await acknowledgeIncoming(dialog);
  const line = dialog.getByRole("article", { name: `来料批次 ${b.stock.name} ${lot}`, exact: true });
  await line.locator(".incoming-line-toggle").click();
  await line.getByRole("button", { name: /登记实际退回/ }).click();
  const returnForm = dialog.locator("form.incoming-form");
  await returnForm.getByLabel("实际退回数量 米", { exact: true }).fill("0.003");
  await returnForm.getByLabel("实际退回时间", { exact: true }).fill("2026-10-19T02:03");
  await returnForm.getByLabel("实际交接凭据", { exact: true }).fill("Synthetic actual supplier return handover");
  await returnForm.getByLabel("实际退回原因", { exact: true }).fill("Synthetic damaged portion actually returned");
  await executePreparedIncoming(dialog);
  await expect(line).toContainText("0.017"); expect(await physical(b.stock.id)).toBe("0.1");
  await inspectIncoming(dialog, "0.003456789", "0", "0.001", true); await reviewIncoming(dialog);
  await fillIncomingPosting(dialog, "0.003456789"); await executePreparedIncoming(dialog);
  expect(await physical(b.stock.id)).toBe("0.103456789");
  await expect(line.locator(".incoming-inspection")).toHaveCount(2);
  await page.screenshot({ path: info.outputPath("incoming-history-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("incoming-history-mobile.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("current incoming write loss clears private drafts and a read-only session retains only authorized history", async ({ page }) => {
  const b = await seed(), privateText = "Synthetic private actual handover awaiting preparation";
  await loginErp(page, "operator", "/procurement");
  let dialog = await open(page, b.order.id);
  await fillIncomingArrival(dialog, b.location.id, "0.1", "Synthetic original batch", privateText);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByLabel("实际交接凭据", { exact: true })).toHaveValue(privateText);
  try {
    await changeErpRights("operator", Object.values(Permission).filter(permission => permission !== Permission.ProcurementWrite));
    await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
    await expect(dialog).toContainText("已清除本页私有填写");
    await expect(dialog.getByLabel("实际交接凭据", { exact: true })).toHaveCount(0);
    await expect(dialog).not.toContainText(privateText);
    await expect(dialog.locator(".incoming-history")).toHaveCount(0);
  } finally { await changeErpRights("operator", Object.values(Permission)); }
  await dialog.getByRole("button", { name: "关闭来料检验与入账", exact: true }).click();
  await changeErpRights("readonly", [Permission.ProcurementRead, Permission.InventoryRead]);
  await loginErp(page, "readonly", "/procurement");
  await page.locator(`#purchase-${b.order.id}`).getByRole("button", { name: "来料检验与入账", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "来料检验与入账", exact: true });
  await expect(dialog).toContainText("当前只显示已保存的来料记录");
  await expect(dialog.getByRole("button", { name: "登记实际到货", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "发布检验标准", exact: true })).toHaveCount(0);
  expect(await physical(b.stock.id)).toBe(0);
});
