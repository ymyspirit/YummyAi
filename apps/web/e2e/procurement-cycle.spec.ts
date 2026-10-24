import { expect, test, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { ProcurementWorkspaceViewSchema } from "@yummyai/contracts/procurement";
import { InventoryWorkspaceViewSchema } from "@yummyai/contracts/inventory";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { ProcurementCommandListSchema } from "@yummyai/contracts/procurement/procurement-command";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { procurementCommandDialog, prepareProcurementOriginal, acknowledgeProcurementOriginal, submitProcurementOriginal } from "./procurement-command-fixture";

const fixtureDatabase = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const token = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(fixtureDatabase.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || !token || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${token}`)
  throw new Error("Disposable procurement cycle browser fixture required");
const base = process.env.API_BASE_URL!.replace(/\/$/, "");
test.describe.configure({ mode: "serial" });

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(base + "/v1/" + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Synthetic procurement fixture API failed ${response.status}`);
  return response.json();
}
async function seed() {
  const prefix = `CYCLE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const supplier = await api("sourcing/suppliers", { name: `Synthetic ${prefix} supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string; name: string };
  const warehouse = await api("inventory/warehouses", { code: `${prefix}-WH`, name: `Synthetic ${prefix} warehouse`, type: "owned", countryCode: "US", timeZone: "UTC" }) as { id: string };
  const location = await api("inventory/locations", { warehouseId: warehouse.id, code: `${prefix}-LOC`, name: `Synthetic ${prefix} location` }) as { id: string };
  const stock = await api("inventory/stock-items", { skuId: null, code: `${prefix}-MAT`, name: `Synthetic ${prefix} material`, baseUnit: "each", materialKind: "material" }) as { id: string };
  return { prefix, supplier, location, stock };
}
type Basis = Awaited<ReturnType<typeof seed>>;
const future = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
async function fillRequest(page: Page, basis: Basis, code: string) {
  await page.getByRole("button", { name: "新增采购申请", exact: true }).click();
  const dialog = await procurementCommandDialog(page, "新增采购申请");
  await dialog.getByLabel("采购申请号", { exact: true }).fill(code);
  const line = dialog.getByRole("region", { name: "采购明细 1", exact: true });
  await line.getByLabel("物料", { exact: true }).selectOption(basis.stock.id);
  await line.getByLabel("收货库位", { exact: true }).selectOption(basis.location.id);
  await line.getByLabel("采购数量", { exact: true }).fill("20");
  return dialog;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const dialog = page.getByRole("dialog", { name: "采购原填写与执行", exact: true });
  if (await dialog.count()) expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function fixtureRights(account: "operator" | "readonly") {
  const actor = actors()[account], database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic personal role missing");
    return [...row.permissions];
  } finally { await database.client.end(); }
}

test("personal procurement binds request, RFQ, actual quotation, purchase revision and review without changing stock", async ({ page }, info) => {
  test.setTimeout(180_000);
  const b = await seed(), code = `${b.prefix}-REQ`, orderCode = `${b.prefix}-PO`, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginErp(page, "operator", "/procurement");
  let dialog = await fillRequest(page, b, code);
  await submitProcurementOriginal(dialog);
  const request = page.getByRole("article").filter({ hasText: code }).filter({ has: page.getByRole("button", { name: "创建询价", exact: true }) });
  await request.getByRole("button", { name: "创建询价", exact: true }).click();
  dialog = await procurementCommandDialog(page, "创建询价");
  await dialog.getByRole("group", { name: "询价供应商", exact: true }).getByRole("checkbox", { name: new RegExp(b.prefix) }).check();
  await dialog.getByLabel("询价截止时间", { exact: true }).fill(future());
  await submitProcurementOriginal(dialog);
  const rfq = page.getByRole("article").filter({ hasText: code }).filter({ has: page.getByRole("button", { name: "录入供应商报价", exact: true }) });
  await rfq.getByRole("button", { name: "录入供应商报价", exact: true }).click();
  dialog = await procurementCommandDialog(page, "录入供应商报价");
  await dialog.getByLabel("报价供应商", { exact: true }).selectOption(b.supplier.id);
  await dialog.getByLabel("报价有效截止时间", { exact: true }).fill(future());
  const quoteLine = dialog.getByRole("region", { name: "报价明细 1", exact: true });
  await quoteLine.getByLabel("报价单价（USD）", { exact: true }).fill("1.23");
  await quoteLine.getByLabel("最低起订量", { exact: true }).fill("25");
  await quoteLine.getByLabel("交期天数", { exact: true }).fill("3");
  await submitProcurementOriginal(dialog);
  const quoted = page.getByRole("article").filter({ hasText: b.supplier.name }).filter({ has: page.getByRole("button", { name: "按此报价建采购单", exact: true }) });
  await quoted.getByRole("button", { name: "按此报价建采购单", exact: true }).click();
  dialog = await procurementCommandDialog(page, "新增采购单");
  await dialog.getByLabel("采购单号", { exact: true }).fill(orderCode);
  await dialog.getByLabel("预计到货时间", { exact: true }).fill(future());
  await expect(dialog.getByLabel("采购数量", { exact: true })).toHaveValue("25");
  await expect(dialog.getByLabel("单价（USD）", { exact: true })).toHaveValue("1.23");
  await expect(dialog.getByLabel("单价（USD）", { exact: true })).toHaveJSProperty("readOnly", true);
  await expect(dialog).toContainText("USD 30.75");
  await submitProcurementOriginal(dialog);
  const row = page.locator(".procurement-order-table tbody tr").filter({ hasText: orderCode });
  await expect(row).toContainText("V1");
  await row.getByRole("button", { name: "修订采购草稿", exact: true }).click();
  dialog = await procurementCommandDialog(page, "修订采购草稿");
  await dialog.getByLabel("采购数量", { exact: true }).fill("30");
  await submitProcurementOriginal(dialog);
  await expect(row).toContainText("V2");
  await row.getByRole("button", { name: "审核采购单", exact: true }).click();
  dialog = await procurementCommandDialog(page, "审核采购单");
  await expect(dialog).toContainText("USD 36.90");
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("procurement-review-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
  await page.screenshot({ path: info.outputPath("procurement-review-mobile.png"), fullPage: true, animations: "disabled" });
  await submitProcurementOriginal(dialog);
  const workspace = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")), order = workspace.purchaseOrders.find(item => item.code === orderCode)!;
  expect(order).toMatchObject({ status: "approved", currentVersion: 2, currency: "USD", totalMinor: 3690 });
  expect(order.lines).toHaveLength(1); expect(order.lines[0]).toMatchObject({ quantity: 30, unitCostMinor: 123, stockItemId: b.stock.id, destinationLocationId: b.location.id });
  expect(workspace.requisitions.find(item => item.id === order.requisitionId)?.code).toBe(code);
  expect(workspace.quotes.find(item => item.id === order.quoteId)?.supplierId).toBe(b.supplier.id);
  const inventory = InventoryWorkspaceViewSchema.parse(await api("inventory/workspace"));
  expect(sumStockQuantities(inventory.balances.filter(item => item.stockItemId === b.stock.id).map(item => item.physicalQuantity))).toBe(0);
  expect(errors).toEqual([]);
});

test("lost preparation and execution responses recover through a new personal session with one actual result", async ({ page }) => {
  test.setTimeout(180_000);
  const b = await seed(), code = `${b.prefix}-PRIVATE-REQ`;
  await loginErp(page, "operator", "/procurement");
  const dialog = await fillRequest(page, b, code);
  const losePreparation = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    await route.fetch(); await route.abort("connectionreset");
  };
  await page.route("**/api/procurement-commands/commands", losePreparation);
  await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
  await expect(dialog).toContainText("保存结果待核对 已固定本次原填写");
  expect((ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace"))).requisitions.filter(item => item.code === code)).toHaveLength(0);
  const retained = ProcurementCommandListSchema.parse(await api("procurement/commands")).items.filter(item => item.original?.kind === "requisition_create" && item.original.input.code === code);
  expect(retained).toHaveLength(1);
  expect(await page.evaluate(text => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(text)), code)).toBe(false);
  await page.unroute("**/api/procurement-commands/commands", losePreparation);
  const browser = page.context().browser(); if (!browser) throw new Error("Synthetic recovery browser unavailable");
  const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } });
  try {
    const resumed = await fresh.newPage(); await loginErp(resumed, "operator", "/procurement");
    const recovery = resumed.getByRole("region", { name: "待核对的采购提交", exact: true });
    const item = recovery.getByRole("listitem").filter({ hasText: code });
    await item.getByRole("button", { name: "恢复原提交", exact: true }).click();
    const restored = await procurementCommandDialog(resumed), original = restored.getByRole("region", { name: "核对采购原提交", exact: true });
    await expect(original).toContainText(code);
    const loseExecution = async (route: Route) => { await route.fetch(); await route.abort("connectionreset"); };
    await resumed.route("**/api/procurement-commands/commands/*/execute", loseExecution);
    await original.getByLabel("我已核对原填写与本次采购依据", { exact: true }).check();
    await original.getByRole("button", { name: "确认执行原提交", exact: true }).click();
    await expect(restored.getByRole("alert")).toBeVisible();
    const actual = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).requisitions.filter(row => row.code === code);
    expect(actual).toHaveLength(1);
    await resumed.unroute("**/api/procurement-commands/commands/*/execute", loseExecution);
    await restored.getByRole("button", { name: "重新读取原提交", exact: true }).click();
    await expect(original.getByRole("status")).toContainText("实际操作已完成");
    const replay = await resumed.request.post(`/api/procurement-commands/commands/${retained[0]!.id}/execute`, { data: {}, headers: { origin: new URL(resumed.url()).origin } });
    expect(replay.ok()).toBe(true); expect((await replay.json()).result.id).toBe(actual[0]!.id);
    expect(ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).requisitions.filter(row => row.code === code)).toHaveLength(1);
    await acknowledgeProcurementOriginal(restored);
    await recovery.getByRole("button", { name: "重新读取原提交", exact: true }).click();
    await expect(item).toHaveCount(0);
  } finally { await fresh.close(); }
});

test("write loss removes private filling and a read-only personal session cannot recover another actor's original", async ({ page }) => {
  const b = await seed(), code = `${b.prefix}-PRIVATE`, operatorRights = await fixtureRights("operator"), readonlyRights = await fixtureRights("readonly");
  await loginErp(page, "operator", "/procurement");
  const dialog = await fillRequest(page, b, code);
  let retainedId: string | undefined;
  try {
    await changeErpRights("operator", operatorRights.filter(permission => permission !== Permission.ProcurementWrite));
    await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
    await expect(dialog).toContainText("已清除本页私有填写");
    await expect(dialog.getByLabel("采购申请号", { exact: true })).toHaveCount(0);
    await expect(dialog).not.toContainText(code);
    await changeErpRights("operator", operatorRights);
    await dialog.getByRole("button", { name: "关闭采购原填写与执行", exact: true }).click();
    const pending = await fillRequest(page, b, code);
    await prepareProcurementOriginal(pending);
    const retained = ProcurementCommandListSchema.parse(await api("procurement/commands")).items
      .filter(item => item.original?.kind === "requisition_create" && item.original.input.code === code);
    expect(retained).toHaveLength(1); retainedId = retained[0]!.id;
    await pending.getByRole("button", { name: "关闭采购原填写与执行", exact: true }).click();
    await changeErpRights("readonly", [Permission.ProcurementRead, Permission.InventoryRead]);
    await loginErp(page, "readonly", "/procurement");
    const recoveredRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/procurement-commands/commands" && response.request().method() === "GET");
    await page.getByRole("region", { name: "待核对的采购提交", exact: true }).getByRole("button", { name: "重新读取原提交", exact: true }).click();
    const actualRead = await recoveredRead;
    expect(actualRead.ok()).toBe(true);
    expect(ProcurementCommandListSchema.parse(await actualRead.json()).items).toEqual([]);
    await expect(page.getByRole("button", { name: "新增采购申请", exact: true })).toBeDisabled();
    await expect(page.getByRole("region", { name: "待核对的采购提交", exact: true })).not.toContainText(code);
    await expect(page).not.toHaveURL(/tenantId=/);
  } finally {
    await changeErpRights("operator", operatorRights);
    await changeErpRights("readonly", readonlyRights);
    if (retainedId) {
      await api(`procurement/commands/${retainedId}/cancel`, {});
      await api(`procurement/commands/${retainedId}/acknowledge`, {});
    }
  }
});
