import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { ProcurementWorkspaceViewSchema } from "@yummyai/contracts/procurement";
import { IncomingWorkspaceViewSchema } from "@yummyai/contracts/procurement/incoming";
import { IncomingCommandViewSchema, type PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { PrepareProcurementCommandSchema, ProcurementCommandListSchema, ProcurementCommandViewSchema,
  type ProcurementCommandView } from "@yummyai/contracts/procurement/procurement-command";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { acknowledgeProcurementOriginal, procurementCommandDialog } from "./procurement-command-fixture";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_INVOICE_COMMAND_ISOLATED !== "1" ||
    !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Disposable invoice command browser fixture required");
const base = process.env.API_BASE_URL!.replace(/\/$/, "");
test.describe.configure({ mode: "serial" });

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}/v1/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`Synthetic invoice fixture API failed ${response.status}`);
  return response.json();
}
async function incoming(original: PrepareIncomingCommand) {
  const prepared = IncomingCommandViewSchema.parse(await api("procurement/incoming/commands", original));
  const completed = IncomingCommandViewSchema.parse(await api(`procurement/incoming/commands/${prepared.id}/execute`, {}));
  expect(completed.status).toBe("succeeded"); expect(completed.result?.kind).toBe(original.kind);
  const acknowledged = IncomingCommandViewSchema.parse(await api(`procurement/incoming/commands/${prepared.id}/acknowledge`, {}));
  expect(acknowledged.acknowledged).toBe(true); expect(acknowledged.original).toBeNull();
  return completed.result!.id;
}
async function seed() {
  const prefix = `INVCMD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const supplier = await api("sourcing/suppliers", { name: `Synthetic ${prefix} supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string };
  const warehouse = await api("inventory/warehouses", { code: `${prefix}-WH`, name: `Synthetic ${prefix} warehouse`, type: "owned", countryCode: "US", timeZone: "UTC" }) as { id: string };
  const location = await api("inventory/locations", { warehouseId: warehouse.id, code: `${prefix}-LOC`, name: `Synthetic ${prefix} hold` }) as { id: string };
  const stock = await api("inventory/stock-items", { skuId: null, code: `${prefix}-MAT`, name: `Synthetic ${prefix} measured material`, baseUnit: "gram", materialKind: "material" }) as { id: string };
  const order = await api("procurement/purchase-orders", { code: `${prefix}-PO`, supplierId: supplier.id, requisitionId: null, quoteId: null,
    currency: "USD", expectedAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), lines: [{ lineKey: "LINE-1", stockItemId: stock.id,
      destinationLocationId: location.id, quantity: "0.25", unit: "kilogram", unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: crypto.randomUUID() }) as { id: string; code: string };
  await api(`procurement/purchase-orders/${order.id}/reviews`, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: crypto.randomUUID() });
  const at = new Date().toISOString();
  const standard = await incoming({ kind: "publish_standard", targetId: stock.id, input: { code: `${prefix}-STD`, stockItemId: stock.id, expectedVersion: 0,
    title: "Synthetic invoice receipt observations", sourceReference: "Isolated actual receiving observations; no supplier contact",
    criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: crypto.randomUUID() } });
  const arrival = await incoming({ kind: "record_arrival", targetId: order.id, input: { code: `${prefix}-ARR`, expectedPurchaseOrderVersion: 1,
    arrivedAt: at, externalReference: "Synthetic actual 200 gram delivery", lines: [{ lineKey: "LINE-1", quantity: 200, unit: "gram",
      holdingLocationId: location.id, lotCode: `${prefix}-LOT`, expiresAt: null }], idempotencyKey: crypto.randomUUID() } });
  const receiving = IncomingWorkspaceViewSchema.parse(await api(`procurement/incoming/orders/${order.id}`));
  const line = receiving.arrivals.find(row => row.id === arrival)!.lines[0]!;
  const inspection = await incoming({ kind: "record_inspection", targetId: line.id, input: { expectedInspectionVersion: 0, standardVersionId: standard,
    acceptedQuantity: 200, rejectedQuantity: 0, sampleQuantity: 1, rejectionReason: null, measuredAt: at,
    readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: crypto.randomUUID() } });
  const approval = await incoming({ kind: "review_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, inspectionId: inspection,
    decision: "approved", reason: "Synthetic actual observations checked", idempotencyKey: crypto.randomUUID() } });
  await incoming({ kind: "post_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, approvalId: approval,
    acceptedQuantity: 200, rejectedQuantity: 0, rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: at, idempotencyKey: crypto.randomUUID() } });
  const workspace = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace"));
  expect(workspace.receipts.filter(row => row.purchaseOrderId === order.id)).toMatchObject([{ lines: [{ receivedQuantity: "0.2", unit: "kilogram", stockReceivedQuantity: 200 }] }]);
  return { prefix, order, stock };
}
type Basis = Awaited<ReturnType<typeof seed>>;
const command = async (id: string) => ProcurementCommandViewSchema.parse(await api(`procurement/commands/${id}`));
const invoices = async (basis: Basis) => ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.filter(row => row.purchaseOrderId === basis.order.id);
async function openInvoice(page: Page, basis: Basis, number: string, currency = "USD", price = "12.00") {
  await page.locator(`#purchase-${basis.order.id}`).getByRole("button", { name: "登记实际发票", exact: true }).click();
  const dialog = await procurementCommandDialog(page, "登记实际供应商发票");
  const form = dialog.getByRole("form", { name: "登记实际供应商发票", exact: true });
  await form.getByLabel("实际发票编号", { exact: true }).fill(number);
  await form.getByLabel("本张开票数量", { exact: true }).fill("0.1");
  await form.getByLabel("发票币种", { exact: true }).selectOption(currency);
  await form.getByLabel(`发票报价金额（${currency}）`, { exact: true }).fill(price);
  await expect(form.getByLabel("发票计价数量（千克）", { exact: true })).toHaveValue("1");
  return dialog;
}
async function prepareInvoice(dialog: Locator) {
  const saved = dialog.page().waitForResponse(response => new URL(response.url()).pathname === "/api/procurement-commands/commands" && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "保存原发票并核对", exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const actual = ProcurementCommandViewSchema.parse(await response.json());
  expect(actual.kind).toBe("invoice_record"); expect(actual.status).toBe("prepared"); expect(actual.invoiceResult).toBeNull();
  const review = dialog.getByRole("region", { name: "核对采购原提交", exact: true });
  await expect(review).toBeVisible(); await expect(review.getByRole("button", { name: "确认执行原提交", exact: true })).toBeDisabled();
  return actual;
}
async function executeInvoice(dialog: Locator, id: string) {
  const completed = dialog.page().waitForResponse(response => new URL(response.url()).pathname === `/api/procurement-commands/commands/${id}/execute` && response.request().method() === "POST");
  const review = dialog.getByRole("region", { name: "核对采购原提交", exact: true });
  await review.getByLabel("我已核对原填写与本次采购依据", { exact: true }).check();
  await review.getByRole("button", { name: "确认执行原提交", exact: true }).click();
  const response = await completed; expect(response.status()).toBe(200);
  const actual = ProcurementCommandViewSchema.parse(await response.json());
  expect(actual.status).toBe("succeeded"); expect(actual.result).toEqual({ kind: "invoice_record", id: actual.invoiceResult!.id, versionId: null, version: null });
  await expect(review.getByRole("status", { name: "实际发票登记结果", exact: true })).toBeVisible();
  return actual;
}
async function restoreInvoice(page: Page, basis: Basis) {
  const item = page.getByRole("region", { name: "待核对的采购提交", exact: true }).getByRole("listitem").filter({ hasText: basis.order.code });
  await expect(item).toHaveCount(1); await item.getByRole("button", { name: "恢复原提交", exact: true }).click();
  return procurementCommandDialog(page);
}
async function noOverflow(page: Page, dialog: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function personal(page: Page, path: string, body?: object) {
  return page.request.fetch(`/api/procurement-commands/${path}`, { method: body === undefined ? "GET" : "POST", data: body,
    headers: { origin: new URL(page.url()).origin } });
}
async function fixtureRights(account: "operator" | "readonly") {
  const actor = actors()[account], connection = connectDatabase();
  try {
    const [row] = await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic personal role missing");
    return [...row.permissions];
  } finally { await connection.client.end(); }
}

test("lost preparation and execution receipts recover the same invoice in fresh personal sessions", async ({ page }, info) => {
  const basis = await seed(), number = `${basis.prefix}-RECOVER`, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await loginErp(page, "operator", "/procurement");
  const dialog = await openInvoice(page, basis, number);
  const captured: { prepared?: ProcurementCommandView; executed?: ProcurementCommandView; request?: unknown } = {};
  const losePrepare = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    captured.request = PrepareProcurementCommandSchema.parse(route.request().postDataJSON());
    const response = await route.fetch(); expect(response.status()).toBe(201);
    captured.prepared = ProcurementCommandViewSchema.parse(await response.json());
    await route.abort("connectionreset");
  };
  await page.route("**/api/procurement-commands/commands", losePrepare);
  try {
    await dialog.getByRole("button", { name: "保存原发票并核对", exact: true }).click();
    await expect(dialog).toContainText("保存结果待核对 已固定原填写");
  } finally { await page.unroute("**/api/procurement-commands/commands", losePrepare); }
  const prepared = captured.prepared!; expect(prepared.original).toEqual(captured.request);
  expect(await invoices(basis)).toEqual([]);
  expect((await command(prepared.id)).original).toEqual(prepared.original);
  const browser = page.context().browser(); if (!browser) throw new Error("Personal invoice browser unavailable");
  const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } });
  const final = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } });
  try {
    const resumed = await fresh.newPage(); resumed.on("pageerror", error => errors.push(error.message));
    await loginErp(resumed, "operator", "/procurement"); const restored = await restoreInvoice(resumed, basis);
    await expect(restored).toContainText(number); await expect(restored).toContainText("USD 1.20");
    const read = await personal(resumed, `commands/${prepared.id}`); expect(read.status()).toBe(200);
    expect(ProcurementCommandViewSchema.parse(await read.json()).original).toEqual(prepared.original);
    const loseExecute = async (route: Route) => {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      captured.executed = ProcurementCommandViewSchema.parse(await response.json()); await route.abort("connectionreset");
    };
    await resumed.route(`**/api/procurement-commands/commands/${prepared.id}/execute`, loseExecute);
    try {
      const review = restored.getByRole("region", { name: "核对采购原提交", exact: true });
      await review.getByLabel("我已核对原填写与本次采购依据", { exact: true }).check();
      await review.getByRole("button", { name: "确认执行原提交", exact: true }).click();
      await expect(restored.getByRole("alert")).toBeVisible();
      await expect(review.getByRole("button", { name: "确认执行原提交", exact: true })).toBeDisabled();
    } finally { await resumed.unroute(`**/api/procurement-commands/commands/${prepared.id}/execute`, loseExecute); }
    const completed = captured.executed!; expect(completed.id).toBe(prepared.id); expect(completed.original).toEqual(prepared.original);
    expect(completed.invoiceResult).toMatchObject({ invoiceNumber: number, status: "matched", totalMinor: 120, varianceMinor: 0, allocationStatus: "complete" });
    const finalPage = await final.newPage(); finalPage.on("pageerror", error => errors.push(error.message));
    await loginErp(finalPage, "operator", "/procurement"); const finalDialog = await restoreInvoice(finalPage, basis);
    const result = finalDialog.getByRole("status", { name: "实际发票登记结果", exact: true });
    await expect(result).toContainText("实际发票已登记并匹配"); await expect(result).toContainText(completed.invoiceResult!.id);
    await expect(finalDialog.getByRole("button", { name: "确认执行原提交", exact: true })).toHaveCount(0);
    const replay = await personal(finalPage, `commands/${prepared.id}/execute`, {}); expect(replay.status()).toBe(200);
    const replayed = ProcurementCommandViewSchema.parse(await replay.json());
    expect(replayed.original).toEqual(prepared.original); expect(replayed.result).toEqual(completed.result); expect(replayed.invoiceResult).toEqual(completed.invoiceResult);
    expect(await invoices(basis)).toHaveLength(1);
    await noOverflow(finalPage, finalDialog); await finalPage.screenshot({ path: info.outputPath("invoice-command-desktop.png"), fullPage: true, animations: "disabled" });
    await finalPage.setViewportSize({ width: 390, height: 844 }); await noOverflow(finalPage, finalDialog);
    await finalPage.screenshot({ path: info.outputPath("invoice-command-mobile.png"), fullPage: true, animations: "disabled" });
    await acknowledgeProcurementOriginal(finalDialog);
    expect(await command(prepared.id)).toMatchObject({ acknowledged: true, original: null, result: completed.result, invoiceResult: completed.invoiceResult });
    const pending = ProcurementCommandListSchema.parse(await api(`procurement/commands?kind=invoice_record&targetId=${basis.order.id}`));
    expect(pending.items).toEqual([]); expect(await invoices(basis)).toHaveLength(1); expect(errors).toEqual([]);
  } finally { await Promise.all([fresh.close(), final.close()]); }
});

test("partial invoices preserve actual currency and separate unknown differences from exhausted received quantity", async ({ page }) => {
  const basis = await seed(); await loginErp(page, "operator", "/procurement");
  const actual: ProcurementCommandView[] = [];
  for (const [index, currency, price] of [[1, "USD", "12.00"], [2, "EUR", "13.00"], [3, "USD", "12.00"]] as const) {
    const dialog = await openInvoice(page, basis, `${basis.prefix}-PART-${index}`, currency, price);
    const prepared = await prepareInvoice(dialog);
    expect(prepared.original).toMatchObject({ kind: "invoice_record", targetId: basis.order.id, input: { expectedVersion: 1, currency,
      lines: [{ invoicedQuantity: "0.1", unitCostMinor: index === 2 ? 1300 : 1200, priceBasisQuantity: 1 }] } });
    expect(prepared.reviewBasis).toMatchObject({ currency, lines: [{ quantity: "0.1", unit: "kilogram", lineTotalMinor: index === 2 ? 130 : 120 }] });
    await expect(dialog.getByRole("region", { name: "核对采购原提交", exact: true })).toContainText(`${currency} ${index === 2 ? "1.30" : "1.20"}`);
    const completed = await executeInvoice(dialog, prepared.id), invoice = completed.invoiceResult!; actual.push(completed);
    expect(invoice).toMatchObject({ currency, totalMinor: index === 2 ? 130 : 120, comparisonCurrency: "USD",
      status: index === 1 ? "matched" : "reconciliation_required", allocationStatus: index < 3 ? "complete" : "reconciliation_required",
      varianceMinor: index === 1 ? 0 : index === 2 ? null : 120,
      lines: [{ invoicedQuantity: "0.1", allocatedQuantity: index < 3 ? "0.1" : 0, varianceMinor: index === 1 ? 0 : index === 2 ? null : 120 }] });
    const result = dialog.getByRole("status", { name: "实际发票登记结果", exact: true });
    await expect(result).toContainText(index === 1 ? "实际发票已登记并匹配" : "实际发票已登记 差异待核对");
    await expect(result).toContainText(index === 2 ? "金额差额待核对" : `金额差额 USD ${index === 1 ? "0.00" : "1.20"}`);
    if (index === 2) await expect(result).toContainText("本张开票数量已全部分配");
    await acknowledgeProcurementOriginal(dialog);
  }
  const rows = await invoices(basis); expect(rows).toHaveLength(3);
  expect(rows.map(row => row.id).sort()).toEqual(actual.map(row => row.invoiceResult!.id).sort());
  expect(sumStockQuantities(rows.flatMap(row => row.lines!.map(line => line.allocatedQuantity!)))).toBe("0.2");
});

test("write revocation clears private invoice input and another personal actor cannot restore it", async ({ page }) => {
  const basis = await seed(), number = `${basis.prefix}-PRIVATE`, operatorRights = await fixtureRights("operator"), readonlyRights = await fixtureRights("readonly");
  let id: string | undefined;
  try {
    await loginErp(page, "operator", "/procurement"); const dialog = await openInvoice(page, basis, number);
    id = (await prepareInvoice(dialog)).id;
    await changeErpRights("operator", operatorRights.filter(permission => permission !== Permission.ProcurementWrite));
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === `/api/procurement-commands/commands/${id}/execute` && response.request().method() === "POST");
    await dialog.getByLabel("我已核对原填写与本次采购依据", { exact: true }).check();
    await dialog.getByRole("button", { name: "确认执行原提交", exact: true }).click();
    expect((await denied).status()).toBe(403);
    await expect(dialog).toContainText("私有填写已清除"); await expect(dialog).not.toContainText(number);
    await expect(dialog.getByRole("region", { name: "核对采购原提交", exact: true })).toHaveCount(0);
    expect(await invoices(basis)).toEqual([]);
    await changeErpRights("operator", operatorRights);
    await dialog.getByRole("button", { name: "关闭采购原填写与执行", exact: true }).click();
    await changeErpRights("readonly", [Permission.ProcurementRead, Permission.InventoryRead]);
    await loginErp(page, "readonly", "/procurement");
    const response = await personal(page, "commands"); expect(response.status()).toBe(200);
    expect(ProcurementCommandListSchema.parse(await response.json()).items).toEqual([]);
    const hidden = await personal(page, `commands/${id}`); expect(hidden.status()).toBe(404); expect(await hidden.text()).not.toContain(number);
    await expect(page.getByRole("region", { name: "待核对的采购提交", exact: true })).not.toContainText(basis.order.code);
    await expect(page.locator(`#purchase-${basis.order.id}`).getByRole("button", { name: "登记实际发票", exact: true })).toBeDisabled();
    const owned = await command(id); expect(owned.status).toBe("prepared"); expect(owned.original).toMatchObject({ input: { invoiceNumber: number } });
    expect(await invoices(basis)).toEqual([]);
  } finally {
    await changeErpRights("operator", operatorRights); await changeErpRights("readonly", readonlyRights);
    if (id) { await api(`procurement/commands/${id}/cancel`, {}); await api(`procurement/commands/${id}/acknowledge`, {}); }
  }
});
