import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { ProcurementWorkspaceViewSchema, ProcurementInvoiceViewSchema } from "@yummyai/contracts/procurement";
import { ProcurementCommandListSchema } from "@yummyai/contracts/procurement/procurement-command";
import { InventoryWorkspaceViewSchema } from "@yummyai/contracts/inventory";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { loginErp } from "./erp-identity-fixture";
import { procurementCommandDialog, submitProcurementOriginal, acknowledgeProcurementOriginal } from "./procurement-command-fixture";
import { publishIncomingStandard, fillIncomingArrival, inspectIncoming, reviewIncoming,
  fillIncomingPosting, executePreparedIncoming } from "./incoming-workflow-fixture";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Disposable procurement precision browser fixture required");
const base = process.env.API_BASE_URL!.replace(/\/$/, "");
test.describe.configure({ mode: "serial" });

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}/v1/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Synthetic precision fixture API failed ${response.status}`);
  return response.json();
}
async function seed() {
  const prefix = `PREC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const supplier = await api("sourcing/suppliers", { name: `Synthetic ${prefix} supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string; name: string };
  const warehouse = await api("inventory/warehouses", { code: `${prefix}-WH`, name: `Synthetic ${prefix} warehouse`, type: "owned", countryCode: "US", timeZone: "UTC" }) as { id: string };
  const location = await api("inventory/locations", { warehouseId: warehouse.id, code: `${prefix}-LOC`, name: `Synthetic ${prefix} hold` }) as { id: string };
  const stock = await api("inventory/stock-items", { skuId: null, code: `${prefix}-MAT`, name: `Synthetic ${prefix} measured material`, baseUnit: "gram", materialKind: "material" }) as { id: string; name: string };
  return { prefix, supplier, location, stock };
}
const future = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
async function request(page: Page, b: Awaited<ReturnType<typeof seed>>, code: string, quantity = "0.25", unit = "kilogram") {
  await page.getByRole("button", { name: "新增采购申请", exact: true }).click();
  const dialog = await procurementCommandDialog(page, "新增采购申请");
  await dialog.getByLabel("采购申请号", { exact: true }).fill(code);
  const line = dialog.getByRole("region", { name: "采购明细 1", exact: true });
  await line.getByLabel("物料", { exact: true }).selectOption(b.stock.id);
  await line.getByLabel("收货库位", { exact: true }).selectOption(b.location.id);
  await line.getByLabel("采购单位", { exact: true }).selectOption(unit);
  await line.getByLabel("采购数量", { exact: true }).fill(quantity);
  return dialog;
}
async function noOverflow(page: Page, element: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}

test("personal fractional procurement converts actual grams, returns rejection and matches only two partial invoices", async ({ page }, info) => {
  test.setTimeout(300_000);
  const b = await seed(), code = `${b.prefix}-REQ`, orderCode = `${b.prefix}-PO`, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/procurement");
  let dialog = await request(page, b, code);
  await submitProcurementOriginal(dialog);
  const requisition = page.getByRole("article").filter({ hasText: code }).filter({ has: page.getByRole("button", { name: "创建询价", exact: true }) });
  await requisition.getByRole("button", { name: "创建询价", exact: true }).click();
  dialog = await procurementCommandDialog(page, "创建询价");
  await dialog.getByRole("group", { name: "询价供应商", exact: true }).getByRole("checkbox", { name: new RegExp(b.prefix) }).check();
  await dialog.getByLabel("询价截止时间", { exact: true }).fill(future()); await submitProcurementOriginal(dialog);
  const rfq = page.getByRole("article").filter({ hasText: code }).filter({ has: page.getByRole("button", { name: "录入供应商报价", exact: true }) });
  await rfq.getByRole("button", { name: "录入供应商报价", exact: true }).click();
  dialog = await procurementCommandDialog(page, "录入供应商报价");
  await dialog.getByLabel("报价供应商", { exact: true }).selectOption(b.supplier.id);
  await dialog.getByLabel("报价有效截止时间", { exact: true }).fill(future());
  const quoteLine = dialog.getByRole("region", { name: "报价明细 1", exact: true });
  await quoteLine.getByLabel("报价单价（USD）", { exact: true }).fill("12.00");
  await quoteLine.getByLabel("最低起订量", { exact: true }).fill("0.125");
  await quoteLine.getByLabel("计价数量（千克）", { exact: true }).fill("1");
  await quoteLine.getByLabel("交期天数", { exact: true }).fill("0"); await submitProcurementOriginal(dialog);
  await page.getByRole("article").filter({ hasText: b.supplier.name }).filter({ has: page.getByRole("button", { name: "按此报价建采购单", exact: true }) })
    .getByRole("button", { name: "按此报价建采购单", exact: true }).click();
  dialog = await procurementCommandDialog(page, "新增采购单");
  await dialog.getByLabel("采购单号", { exact: true }).fill(orderCode);
  await dialog.getByLabel("预计到货时间", { exact: true }).fill(future());
  await expect(dialog.getByLabel("采购数量", { exact: true })).toHaveValue("0.25");
  await expect(dialog.getByLabel("采购单位", { exact: true })).toHaveValue("kilogram");
  await expect(dialog).toContainText("USD 3.00"); await expect(dialog).toContainText("250");
  await submitProcurementOriginal(dialog);
  let workspace = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace"));
  const order = workspace.purchaseOrders.find(row => row.code === orderCode)!; expect(order).toBeDefined();
  const row = page.locator(`#purchase-${order.id}`);
  await row.getByRole("button", { name: "修订采购草稿", exact: true }).click();
  dialog = await procurementCommandDialog(page, "修订采购草稿");
  await dialog.getByLabel("采购数量", { exact: true }).fill("0.250000000"); await submitProcurementOriginal(dialog);
  await row.getByRole("button", { name: "审核采购单", exact: true }).click();
  dialog = await procurementCommandDialog(page, "审核采购单");
  await expect(dialog).toContainText("USD 3.00"); await submitProcurementOriginal(dialog);
  await row.getByRole("button", { name: "来料检验与入账", exact: true }).click();
  const incoming = page.getByRole("dialog", { name: "来料检验与入账", exact: true });
  await publishIncomingStandard(incoming, b.stock.id, `${b.prefix} actual measured standard`);
  const lot = `${b.prefix}-ACTUAL-LOT`;
  await fillIncomingArrival(incoming, b.location.id, "250", lot, "Synthetic actual 250 gram delivery");
  await incoming.getByLabel("实际到货单位", { exact: true }).selectOption("gram");
  await incoming.locator('input[name="quantity-0"]').fill("250");
  await executePreparedIncoming(incoming);
  await inspectIncoming(incoming, "200", "50", "1"); await reviewIncoming(incoming);
  await fillIncomingPosting(incoming, "200", "50", b.location.id); await executePreparedIncoming(incoming);
  const line = incoming.getByRole("article", { name: `来料批次 ${b.stock.name} ${lot}`, exact: true });
  await line.locator(".incoming-line-toggle").click();
  await line.getByRole("button", { name: /登记实际退回/ }).click();
  const returnForm = incoming.locator("form.incoming-form");
  await returnForm.getByLabel("实际退回数量 克", { exact: true }).fill("50");
  await returnForm.getByLabel("实际退回时间", { exact: true }).fill("2026-10-19T02:03");
  await returnForm.getByLabel("实际交接凭据", { exact: true }).fill("Synthetic actual 50 gram rejected handover");
  await returnForm.getByLabel("实际退回原因", { exact: true }).fill("Synthetic actual rejected 50 grams"); await executePreparedIncoming(incoming);
  await incoming.getByRole("button", { name: "关闭来料检验与入账", exact: true }).click();
  const bodies: unknown[] = [];
  const loseFirstInvoice = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    bodies.push(route.request().postDataJSON()); const response = await route.fetch();
    expect(response.status()).toBe(201); await route.abort("connectionreset");
  };
  for (let index = 0; index < 3; index++) {
    await row.getByRole("button", { name: "登记实际发票", exact: true }).click();
    const invoiceDialog = await procurementCommandDialog(page, "登记实际供应商发票");
    const form = invoiceDialog.getByRole("form", { name: "登记实际供应商发票", exact: true });
    await form.getByLabel("实际发票编号", { exact: true }).fill(`${b.prefix}-INV-${index + 1}`);
    await form.getByLabel("本张开票数量", { exact: true }).fill("0.1");
    await expect(form.getByLabel("发票报价金额（USD）", { exact: true })).toHaveValue("12.00");
    await expect(form).toContainText("USD 1.20");
    if (index === 0) await page.route("**/api/procurement-commands/commands", loseFirstInvoice);
    await form.getByRole("button", { name: "保存原发票并核对", exact: true }).click();
    if (index === 0) {
      await expect(form).toContainText("保存结果待核对 已固定原填写");
      expect(ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.filter(invoice => invoice.invoiceNumber === `${b.prefix}-INV-1`)).toHaveLength(0);
      const pending = ProcurementCommandListSchema.parse(await api(`procurement/commands?kind=invoice_record&targetId=${order.id}`)).items;
      expect(pending).toHaveLength(1); expect(pending[0]!.original).toEqual(bodies[0]);
      await page.unroute("**/api/procurement-commands/commands", loseFirstInvoice);
      const retry = page.waitForRequest(req => new URL(req.url()).pathname === "/api/procurement-commands/commands" && req.method() === "POST");
      await form.getByRole("button", { name: "重试保存原发票", exact: true }).click();
      bodies.push((await retry).postDataJSON()); expect(bodies[1]).toEqual(bodies[0]);
    }
    const review = invoiceDialog.getByRole("region", { name: "核对采购原提交", exact: true });
    await expect(review.getByRole("button", { name: "确认执行原提交", exact: true })).toBeDisabled();
    await review.getByLabel("我已核对原填写与本次采购依据", { exact: true }).check();
    await review.getByRole("button", { name: "确认执行原提交", exact: true }).click();
    const result = review.getByRole("status", { name: "实际发票登记结果", exact: true });
    await expect(result).toContainText(index < 2 ? "实际发票已登记并匹配" : "实际发票已登记 差异待核对");
    if (index === 0) expect(ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.filter(invoice => invoice.invoiceNumber === `${b.prefix}-INV-1`)).toHaveLength(1);
    if (index === 2) {
      await noOverflow(page, invoiceDialog); await page.screenshot({ path: info.outputPath("procurement-precision-desktop.png"), fullPage: true, animations: "disabled" });
      await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page, invoiceDialog);
      await page.screenshot({ path: info.outputPath("procurement-precision-mobile.png"), fullPage: true, animations: "disabled" });
    }
    await acknowledgeProcurementOriginal(invoiceDialog);
  }
  workspace = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace"));
  expect(workspace.purchaseOrders.find(item => item.id === order.id)).toMatchObject({ currentVersion: 2, totalMinor: 300,
    lines: [{ quantity: "0.25", unit: "kilogram", stockBasis: { stockUnit: "gram", stockQuantity: 250, priceBasisStockQuantity: 1000 } }] });
  const receipts = workspace.receipts.filter(receipt => receipt.purchaseOrderId === order.id);
  expect(receipts).toHaveLength(1); expect(receipts[0]!.lines[0]).toMatchObject({ receivedQuantity: "0.2", rejectedQuantity: "0.05",
    unit: "kilogram", stockUnit: "gram", stockReceivedQuantity: 200, stockRejectedQuantity: 50 });
  const invoices = workspace.invoices.filter(invoice => invoice.purchaseOrderId === order.id).map(invoice => ProcurementInvoiceViewSchema.parse(invoice));
  expect(invoices).toHaveLength(3); expect(invoices.filter(invoice => invoice.status === "matched")).toHaveLength(2);
  expect(invoices.every(invoice => invoice.totalMinor === 120)).toBe(true);
  expect(sumStockQuantities(invoices.flatMap(invoice => invoice.lines!.map(item => item.allocatedQuantity!)))).toBe("0.2");
  const inventory = InventoryWorkspaceViewSchema.parse(await api("inventory/workspace"));
  expect(sumStockQuantities(inventory.balances.filter(item => item.stockItemId === b.stock.id).map(item => item.physicalQuantity))).toBe(200);
  expect(errors).toEqual([]);
});

test("a lost nine-place preparation restores the exact original in a fresh personal session", async ({ page }) => {
  test.setTimeout(180_000);
  const b = await seed(), code = `${b.prefix}-NANO`, quantity = "2147483646.000000001";
  await loginErp(page, "operator", "/procurement"); const dialog = await request(page, b, code, quantity, "gram");
  const lose = async (route: Route) => { if (route.request().method() !== "POST") { await route.continue(); return; } await route.fetch(); await route.abort("connectionreset"); };
  await page.route("**/api/procurement-commands/commands", lose);
  await dialog.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
  await expect(dialog).toContainText("保存结果待核对 已固定本次原填写");
  const pending = ProcurementCommandListSchema.parse(await api("procurement/commands")).items.filter(item => item.original?.kind === "requisition_create" && item.original.input.code === code);
  expect(pending).toHaveLength(1); expect(pending[0]!.original!.input).toMatchObject({ lines: [{ quantity }] });
  await page.unroute("**/api/procurement-commands/commands", lose);
  const browser = page.context().browser(); if (!browser) throw new Error("Personal precision browser unavailable");
  const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 } });
  try {
    const resumed = await fresh.newPage(); await loginErp(resumed, "operator", "/procurement");
    await resumed.getByRole("region", { name: "待核对的采购提交", exact: true }).getByRole("listitem").filter({ hasText: code })
      .getByRole("button", { name: "恢复原提交", exact: true }).click();
    const restored = await procurementCommandDialog(resumed), original = restored.getByRole("region", { name: "核对采购原提交", exact: true });
    await expect(original).toContainText("2,147,483,646.000000001 克"); await noOverflow(resumed, restored);
    await original.getByLabel("我已核对原填写与本次采购依据", { exact: true }).check();
    await original.getByRole("button", { name: "确认执行原提交", exact: true }).click();
    await expect(original).toContainText("实际操作已完成"); await acknowledgeProcurementOriginal(restored);
    const actual = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).requisitions.filter(item => item.code === code);
    expect(actual).toHaveLength(1); expect(actual[0]!.lines[0]!.quantity).toBe(quantity);
  } finally { await fresh.close(); }
});

for (const [currency, price, minor] of [["USD", "90071992547409.90", 9007199254740990],
  ["JPY", "9007199254740991", Number.MAX_SAFE_INTEGER], ["KWD", "9007199254740.990", 9007199254740990]] as const) {
  test(`personal ${currency} quotation preserves its exact minor amount through review and reload`, async ({ page }) => {
    const b = await seed(), code = `${b.prefix}-${currency}`;
    await loginErp(page, "operator", "/procurement");
    await page.getByRole("button", { name: "新增采购单", exact: true }).click();
    const dialog = await procurementCommandDialog(page, "新增采购单");
    await dialog.getByLabel("采购单号", { exact: true }).fill(code);
    await dialog.getByLabel("供应商", { exact: true }).selectOption(b.supplier.id);
    await dialog.getByLabel("采购币种", { exact: true }).selectOption(currency);
    await dialog.getByLabel("预计到货时间", { exact: true }).fill(future());
    const line = dialog.getByRole("region", { name: "采购明细 1", exact: true });
    await line.getByLabel("物料", { exact: true }).selectOption(b.stock.id);
    await line.getByLabel("收货库位", { exact: true }).selectOption(b.location.id);
    await line.getByLabel("采购数量", { exact: true }).fill("1");
    await line.getByLabel(`单价（${currency}）`, { exact: true }).fill(price);
    await expect(dialog).toContainText(`${currency} ${price}`); await submitProcurementOriginal(dialog);
    await page.reload();
    const row = page.locator(".procurement-order-table tbody tr").filter({ hasText: code });
    await expect(row).toContainText(`${currency} ${price}`);
    const order = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).purchaseOrders.find(item => item.code === code)!;
    expect(order).toMatchObject({ currency, totalMinor: minor, lines: [{ unitCostMinor: minor }] });
    await row.getByRole("button", { name: "审核采购单", exact: true }).click();
    const review = await procurementCommandDialog(page, "审核采购单");
    await expect(review).toContainText(`${currency} ${price}`); await submitProcurementOriginal(review);
  });
}
