import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { ProcurementWorkspaceViewSchema } from "@yummyai/contracts/procurement";
import { IncomingWorkspaceViewSchema } from "@yummyai/contracts/procurement/incoming";
import { IncomingCommandViewSchema, type PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { InvoiceReconciliationDetailSchema, type InvoiceReconciliationDetail } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { PrepareProcurementCommandSchema, ProcurementCommandViewSchema, type ProcurementCommandView } from "@yummyai/contracts/procurement/procurement-command";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { acknowledgeProcurementOriginal, procurementCommandDialog } from "./procurement-command-fixture";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_INVOICE_RECONCILIATION_ISOLATED !== "1" || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Disposable invoice reconciliation browser fixture required");
const base = process.env.API_BASE_URL!.replace(/\/$/, "");
test.describe.configure({ mode: "serial" });
async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}/v1/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof failure?.code === "string" && /^[a-z_]{1,100}$/.test(failure.code) ? failure.code : "unavailable";
    throw new Error(`Synthetic reconciliation fixture API failed ${response.status} ${path} ${code}`);
  }
  return response.json();
}
async function incoming(original: PrepareIncomingCommand) {
  const prepared = IncomingCommandViewSchema.parse(await api("procurement/incoming/commands", original));
  const result = IncomingCommandViewSchema.parse(await api(`procurement/incoming/commands/${prepared.id}/execute`, {})); expect(result.status).toBe("succeeded");
  const confirmed = IncomingCommandViewSchema.parse(await api(`procurement/incoming/commands/${prepared.id}/acknowledge`, {})); expect(confirmed.acknowledged).toBe(true);
  return result.result!.id;
}
async function receive(basis: { prefix: string; order: { id: string }; stock: { id: string }; location: { id: string }; standardId: string }, quantity: number) {
  const observed = IncomingWorkspaceViewSchema.parse(await api(`procurement/incoming/orders/${basis.order.id}`));
  const at = observed.recordingTime, suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  const arrivalId = await incoming({ kind: "record_arrival", targetId: basis.order.id, input: { code: `${basis.prefix}-ARR-${suffix}`, expectedPurchaseOrderVersion: 1,
    arrivedAt: at, externalReference: "Synthetic actual receiving for invoice reconciliation", lines: [{ lineKey: "LINE-1", quantity, unit: "gram", holdingLocationId: basis.location.id,
      lotCode: `${basis.prefix}-LOT-${suffix}`, expiresAt: null }], idempotencyKey: crypto.randomUUID() } });
  const workspace = IncomingWorkspaceViewSchema.parse(await api(`procurement/incoming/orders/${basis.order.id}`));
  const line = workspace.arrivals.find(row => row.id === arrivalId)!.lines[0]!;
  const inspection = await incoming({ kind: "record_inspection", targetId: line.id, input: { expectedInspectionVersion: 0, standardVersionId: basis.standardId,
    acceptedQuantity: quantity, rejectedQuantity: 0, sampleQuantity: 1, rejectionReason: null, measuredAt: at,
    readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: crypto.randomUUID() } });
  const review = await incoming({ kind: "review_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, inspectionId: inspection, decision: "approved",
    reason: "Synthetic original accepted measurement checked", idempotencyKey: crypto.randomUUID() } });
  await incoming({ kind: "post_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, approvalId: review,
    acceptedQuantity: quantity, rejectedQuantity: 0, rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: at, idempotencyKey: crypto.randomUUID() } });
}
async function seed(options: { invoiced?: string; price?: number; currency?: string } = {}) {
  const prefix = `RECON-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const supplier = await api("sourcing/suppliers", { name: `Synthetic ${prefix} supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string };
  const warehouse = await api("inventory/warehouses", { code: `${prefix}-WH`, name: `Synthetic ${prefix} warehouse`, type: "owned", countryCode: "US", timeZone: "UTC" }) as { id: string };
  const location = await api("inventory/locations", { warehouseId: warehouse.id, code: `${prefix}-HOLD`, name: `Synthetic ${prefix} actual hold` }) as { id: string };
  const stock = await api("inventory/stock-items", { skuId: null, code: `${prefix}-MAT`, name: `Synthetic ${prefix} measured material`, baseUnit: "gram", materialKind: "material" }) as { id: string };
  const order = await api("procurement/purchase-orders", { code: `${prefix}-PO`, supplierId: supplier.id, requisitionId: null, quoteId: null, currency: "USD",
    expectedAt: new Date(Date.now() + 86_400_000).toISOString(), lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: location.id,
      quantity: "0.25", unit: "kilogram", unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: crypto.randomUUID() }) as { id: string; code: string };
  await api(`procurement/purchase-orders/${order.id}/reviews`, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: crypto.randomUUID() });
  const standardId = await incoming({ kind: "publish_standard", targetId: stock.id, input: { code: `${prefix}-STD`, stockItemId: stock.id, expectedVersion: 0,
    title: "Synthetic actual invoice reconciliation observations", sourceReference: "Isolated synthetic specification; no supplier contact",
    criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: crypto.randomUUID() } });
  const basis = { prefix, order, stock, location, standardId }; await receive(basis, 200);
  const invoiceInput = { expectedVersion: 1, invoiceNumber: `${prefix}-INV`, currency: options.currency ?? "USD", issuedAt: new Date().toISOString(),
    lines: [{ lineKey: "LINE-1", invoicedQuantity: options.invoiced ?? "0.2", unitCostMinor: options.price ?? 1200, priceBasisQuantity: 1 }], idempotencyKey: crypto.randomUUID() };
  const invoice = await api(`procurement/purchase-orders/${order.id}/invoices`, invoiceInput) as { id: string; invoiceNumber: string };
  return { ...basis, invoice, invoiceInput };
}
type Basis = Awaited<ReturnType<typeof seed>>;
const detail = async (id: string) => InvoiceReconciliationDetailSchema.parse(await api(`procurement/invoice-reconciliations/${id}`));
const originalInvoice = async (basis: Basis) => ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.find(row => row.id === basis.invoice.id)!;
async function openDetail(page: Page, basis: Basis) {
  const dialog = page.getByRole("dialog", { name: "发票差异与供应商单据", exact: true });
  if (!await dialog.count()) await page.getByRole("listitem", { name: `发票事项 ${basis.invoice.invoiceNumber}`, exact: true }).getByRole("button", { name: "核对差异与单据", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "当前实际余额", exact: true })).toBeVisible();
  return dialog;
}
async function fillDocument(page: Page, basis: Basis, options: { number: string; quantity?: string; amount: string; kind?: "credit_note" | "debit_note" }) {
  const current = await openDetail(page, basis); await current.getByRole("button", { name: "登记供应商贷项或补差", exact: true }).click();
  const dialog = await procurementCommandDialog(page, "登记供应商调整单据"), form = dialog.getByRole("form", { name: "登记供应商调整单据", exact: true });
  await form.getByLabel("供应商单据类型", { exact: true }).selectOption(options.kind ?? "credit_note");
  await form.getByLabel("供应商单据编号", { exact: true }).fill(options.number);
  await form.getByLabel("供应商凭证引用", { exact: true }).fill(`Synthetic supplier reference ${options.number}; not externally verified or paid`);
  const line = form.getByRole("region", { name: "调整明细 1", exact: true }); await line.getByRole("checkbox").check();
  if (options.kind === "debit_note") { await expect(line.getByLabel("调整数量", { exact: true })).toHaveValue("0"); await expect(line.getByLabel("调整数量", { exact: true })).toHaveJSProperty("readOnly", true); }
  else await line.getByLabel("调整数量", { exact: true }).fill(options.quantity ?? "0");
  await line.getByLabel(`调整金额（${basis.invoiceInput.currency}）`, { exact: true }).fill(options.amount);
  await form.getByLabel("处理依据", { exact: true }).fill("Synthetic supplier original evidence recorded for current approval"); return dialog;
}
async function prepare(dialog: Locator) {
  const saved = dialog.page().waitForResponse(response => new URL(response.url()).pathname === "/api/procurement-commands/commands" && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "保存原处理并核对", exact: true }).click(); const response = await saved; expect(response.status()).toBe(201);
  const value = ProcurementCommandViewSchema.parse(await response.json()); expect(value.kind).toBe("invoice_reconcile"); expect(value.status).toBe("prepared");
  await expect(dialog.getByRole("region", { name: "核对采购原提交", exact: true })).toBeVisible(); return value;
}
async function execute(dialog: Locator, id: string) {
  const review = dialog.getByRole("region", { name: "核对采购原提交", exact: true });
  const confirmed = review.getByLabel("我已核对原填写与本次采购依据", { exact: true }); await expect(confirmed).toBeEnabled(); await confirmed.check();
  const saved = dialog.page().waitForResponse(response => new URL(response.url()).pathname === `/api/procurement-commands/commands/${id}/execute` && response.request().method() === "POST");
  await review.getByRole("button", { name: "确认执行原提交", exact: true }).click(); const response = await saved; expect(response.status()).toBe(200);
  const value = ProcurementCommandViewSchema.parse(await response.json()); expect(value.status).toBe("succeeded");
  expect(value.result).toEqual({ kind: "invoice_reconcile", id: value.reconciliationResult!.id, versionId: null, version: null });
  await expect(review.getByRole("region", { name: "实际发票处理结果", exact: true })).toContainText(value.result!.id); return value;
}
async function submit(dialog: Locator) { const saved = await prepare(dialog), value = await execute(dialog, saved.id); await acknowledgeProcurementOriginal(dialog); return value; }
async function openReview(page: Page, basis: Basis, number: string) {
  const current = await openDetail(page, basis);
  await current.getByRole("article", { name: `调整单据 ${number}`, exact: true }).getByRole("button", { name: "核对并审核这笔调整", exact: true }).click();
  const dialog = await procurementCommandDialog(page, "审核供应商调整");
  await dialog.getByLabel("调整审核决定", { exact: true }).selectOption("approved");
  await dialog.getByLabel("处理依据", { exact: true }).fill("Synthetic current authority checked the original supplier document"); return dialog;
}
async function restore(page: Page, invoiceNumber: string) {
  await page.getByRole("region", { name: "待核对的采购提交", exact: true }).getByRole("listitem").filter({ hasText: invoiceNumber })
    .getByRole("button", { name: "恢复原提交", exact: true }).click(); return procurementCommandDialog(page);
}
async function personal(page: Page, path: string, body?: object) {
  return page.request.fetch(`/api/procurement-commands/${path}`, { method: body === undefined ? "GET" : "POST", data: body, headers: { origin: new URL(page.url()).origin } });
}
async function noOverflow(page: Page, dialog: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function rights(account: "operator" | "readonly") {
  const actor = actors()[account], connection = connectDatabase();
  try {
    const [row] = await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic reconciliation role missing"); return [...row.permissions];
  } finally { await connection.client.end(); }
}

test("lost supplier correction receipts recover across personal sessions and require actual approval before closing a price discrepancy", async ({ page }, info) => {
  const basis = await seed({ price: 1300 }), number = `${basis.prefix}-CN-20`, before = await originalInvoice(basis), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); await loginErp(page, "operator", `/procurement?invoiceOrder=${basis.order.id}`);
  const dialog = await fillDocument(page, basis, { number, amount: "0.20" });
  const captured: { prepared?: ProcurementCommandView; executed?: ProcurementCommandView; original?: unknown } = {};
  const losePrepare = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    captured.original = PrepareProcurementCommandSchema.parse(route.request().postDataJSON());
    const response = await route.fetch(); expect(response.status()).toBe(201); captured.prepared = ProcurementCommandViewSchema.parse(await response.json()); await route.abort("connectionreset");
  };
  await page.route("**/api/procurement-commands/commands", losePrepare);
  try { await dialog.getByRole("button", { name: "保存原处理并核对", exact: true }).click(); await expect(dialog).toContainText("保存结果待核对 已固定原填写"); }
  finally { await page.unroute("**/api/procurement-commands/commands", losePrepare); }
  const saved = captured.prepared!; expect(saved.original).toEqual(captured.original); expect((await detail(basis.invoice.id)).events).toEqual([]);
  const browser = page.context().browser(); if (!browser) throw new Error("Personal reconciliation browser unavailable");
  const resumedContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } });
  const finalContext = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } });
  try {
    const resumed = await resumedContext.newPage(); resumed.on("pageerror", error => errors.push(error.message)); await loginErp(resumed, "operator", "/procurement");
    const restored = await restore(resumed, basis.invoice.invoiceNumber); await expect(restored).toContainText(number);
    const read = await personal(resumed, `commands/${saved.id}`); expect(read.status()).toBe(200); expect(ProcurementCommandViewSchema.parse(await read.json()).original).toEqual(saved.original);
    const loseExecute = async (route: Route) => { const response = await route.fetch(); expect(response.status()).toBe(200); captured.executed = ProcurementCommandViewSchema.parse(await response.json()); await route.abort("connectionreset"); };
    await resumed.route(`**/api/procurement-commands/commands/${saved.id}/execute`, loseExecute);
    try {
      const review = restored.getByRole("region", { name: "核对采购原提交", exact: true });
      const check = review.getByLabel("我已核对原填写与本次采购依据", { exact: true }); await expect(check).toBeEnabled(); await check.check();
      await review.getByRole("button", { name: "确认执行原提交", exact: true }).click(); await expect(restored.getByRole("alert")).toBeVisible();
    } finally { await resumed.unroute(`**/api/procurement-commands/commands/${saved.id}/execute`, loseExecute); }
    const actual = captured.executed!; expect(actual.id).toBe(saved.id); expect(actual.original).toEqual(saved.original);
    expect(actual.reconciliationResult).toMatchObject({ action: "adjustment_record", balance: { varianceMinor: 20, netAmountMinor: 260 } });
    const finalPage = await finalContext.newPage(); finalPage.on("pageerror", error => errors.push(error.message)); await loginErp(finalPage, "operator", `/procurement?invoiceOrder=${basis.order.id}`);
    const finalDialog = await restore(finalPage, basis.invoice.invoiceNumber); await expect(finalDialog.getByRole("region", { name: "实际发票处理结果", exact: true })).toContainText(actual.result!.id);
    const replay = await personal(finalPage, `commands/${saved.id}/execute`, {}); expect(replay.status()).toBe(200);
    expect(ProcurementCommandViewSchema.parse(await replay.json()).reconciliationResult).toEqual(actual.reconciliationResult);
    expect((await detail(basis.invoice.id)).events).toHaveLength(1); expect((await detail(basis.invoice.id)).adjustments[0]!.status).toBe("pending");
    await acknowledgeProcurementOriginal(finalDialog);
    const approval = await openReview(finalPage, basis, number), prepared = await prepare(approval), completed = await execute(approval, prepared.id);
    expect(completed.reconciliationResult!.balance).toMatchObject({ status: "matched", netAmountMinor: 240, varianceMinor: 0 });
    const execution = approval.getByRole("region", { name: "实际发票处理结果", exact: true }); await expect(execution).toContainText("调整后已匹配");
    await expect(execution.getByRole("region", { name: "执行时余额", exact: true })).toContainText("调整后净额 USD 2.40 · 金额差额 USD 0.00");
    const currentRecord = approval.getByRole("region", { name: "当前实际发票记录", exact: true });
    const currentBalance = currentRecord.getByRole("region", { name: "当前实际余额", exact: true });
    await expect(currentBalance).toContainText("调整后已匹配");
    await expect(currentBalance).toContainText("调整后净额 USD 2.40 · 金额差额 USD 0.00");
    await expect(currentRecord).toHaveAttribute("aria-busy", "false");
    await noOverflow(finalPage, approval); await finalPage.screenshot({ path: info.outputPath("invoice-reconciliation-desktop.png"), fullPage: true, animations: "disabled" });
    await finalPage.setViewportSize({ width: 390, height: 844 }); await noOverflow(finalPage, approval);
    await finalPage.screenshot({ path: info.outputPath("invoice-reconciliation-mobile.png"), fullPage: true, animations: "disabled" }); await acknowledgeProcurementOriginal(approval);
    expect(await originalInvoice(basis)).toEqual(before); const current = await detail(basis.invoice.id);
    expect(current.adjustments[0]!.status).toBe("approved"); expect(current.events).toHaveLength(2); expect(current.originalStatus).toBe("reconciliation_required"); expect(errors).toEqual([]);
  } finally { await Promise.all([resumedContext.close(), finalContext.close()]); }
});

test("quantity credits first reduce the unallocated claim and then release only actual prior occupation", async ({ page }) => {
  const basis = await seed({ invoiced: "0.3" }), before = await originalInvoice(basis); await loginErp(page, "operator", `/procurement?invoiceOrder=${basis.order.id}`);
  for (const index of [1, 2]) {
    const number = `${basis.prefix}-QCN-${index}`;
    const recorded = await submit(await fillDocument(page, basis, { number, quantity: "0.1", amount: "1.20" }));
    expect(recorded.reconciliationResult!.balance.lines[0]!.netQuantity).toBe(index === 1 ? "0.3" : "0.2");
    const approved = await submit(await openReview(page, basis, number));
    expect(approved.reconciliationResult!.balance).toMatchObject({ status: "matched", varianceMinor: 0,
      lines: [{ netQuantity: index === 1 ? "0.2" : "0.1", allocatedQuantity: index === 1 ? "0.2" : "0.1" }] });
    const current = await detail(basis.invoice.id); expect(current.receipts[0]!.availableQuantity).toBe(index === 1 ? 0 : "0.1");
  }
  const next = await api(`procurement/purchase-orders/${basis.order.id}/invoices`, { ...basis.invoiceInput, invoiceNumber: `${basis.prefix}-REPLACEMENT`,
    lines: [{ ...basis.invoiceInput.lines[0]!, invoicedQuantity: "0.1" }], idempotencyKey: crypto.randomUUID() }) as { status: string; lines: Array<{ allocatedQuantity: unknown }> };
  expect(next).toMatchObject({ status: "matched", lines: [{ allocatedQuantity: "0.1" }] });
  expect((await detail(basis.invoice.id)).receipts[0]!.availableQuantity).toBe(0); expect(await originalInvoice(basis)).toEqual(before);
});

test("later real receiving and amount-only supplier debit close separate quantity and price gaps", async ({ page }) => {
  const late = await seed({ invoiced: "0.25" }); await receive(late, 50);
  const operatorRights = await rights("operator"), approveOnly = operatorRights.filter(permission => permission !== Permission.ProcurementWrite);
  expect(approveOnly).toContain(Permission.ProcurementApprove); expect(approveOnly).not.toContain(Permission.ProcurementWrite);
  try {
    await changeErpRights("operator", approveOnly);
    await loginErp(page, "operator", `/procurement?invoiceOrder=${late.order.id}`); const current = await openDetail(page, late);
    await expect(current.getByRole("button", { name: "登记供应商贷项或补差", exact: true })).toBeDisabled();
    const openMatch = current.getByRole("button", { name: "匹配后续实际收货", exact: true }); await expect(openMatch).toBeEnabled(); await openMatch.click();
    const dialog = await procurementCommandDialog(page, "匹配实际收货"), record = await detail(late.invoice.id);
    expect(record.canRecord).toBe(false); expect(record.canApprove).toBe(true);
    const match = dialog.getByRole("region", { name: "收货匹配 1", exact: true });
    await match.getByLabel("匹配发票行", { exact: true }).selectOption(record.balance.lines[0]!.invoiceLineId);
    await match.getByLabel("实际收货行", { exact: true }).selectOption(record.receipts.find(receipt => receipt.availableQuantity === "0.05")!.receiptLineId);
    await match.getByLabel("本次匹配数量", { exact: true }).fill("0.05"); await dialog.getByLabel("处理依据", { exact: true }).fill("Synthetic actual later accepted 50 grams");
    const matched = await submit(dialog); expect(matched.reconciliationResult!.balance).toMatchObject({ status: "matched", varianceMinor: 0, lines: [{ allocatedQuantity: "0.25" }] });
  } finally { await changeErpRights("operator", operatorRights); }
  const debit = await seed({ price: 1000 }); await loginErp(page, "operator", `/procurement?invoiceOrder=${debit.order.id}`);
  const number = `${debit.prefix}-DEBIT`, pending = await submit(await fillDocument(page, debit, { number, kind: "debit_note", amount: "0.40" }));
  expect(pending.reconciliationResult!.balance.varianceMinor).toBe(-40);
  const approved = await submit(await openReview(page, debit, number));
  expect(approved.reconciliationResult!.balance).toMatchObject({ status: "matched", varianceMinor: 0,
    lines: [{ creditedQuantity: 0, netQuantity: "0.2", allocatedQuantity: "0.2", debitAmountMinor: 40 }] });
});

test("revoked current approval clears the private original while a read-only colleague can only inspect actual pending evidence", async ({ page }) => {
  const basis = await seed(), operatorRights = await rights("operator"), readonlyRights = await rights("readonly"), number = `${basis.prefix}-APPROVAL`;
  let commandId: string | undefined;
  try {
    await loginErp(page, "operator", `/procurement?invoiceOrder=${basis.order.id}`);
    await submit(await fillDocument(page, basis, { number, quantity: "0.1", amount: "1.20" }));
    const review = await openReview(page, basis, number), prepared = await prepare(review); commandId = prepared.id;
    const checked = review.getByLabel("我已核对原填写与本次采购依据", { exact: true }); await expect(checked).toBeEnabled(); await checked.check();
    await changeErpRights("operator", operatorRights.filter(permission => permission !== Permission.ProcurementApprove));
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === `/api/procurement-commands/commands/${commandId}/execute` && response.request().method() === "POST");
    await review.getByRole("button", { name: "确认执行原提交", exact: true }).click(); expect((await denied).status()).toBe(403);
    await expect(review).toContainText("私有填写已清除"); await expect(review.getByRole("region", { name: "核对采购原提交", exact: true })).toHaveCount(0);
    expect((await detailAfterRestoringRights()).adjustments[0]!.status).toBe("pending");
    await review.getByRole("button", { name: "关闭采购原填写与执行", exact: true }).click();
    await changeErpRights("readonly", [Permission.ProcurementRead, Permission.InventoryRead]); await loginErp(page, "readonly", `/procurement?invoiceOrder=${basis.order.id}`);
    const hidden = await personal(page, `commands/${commandId}`); expect(hidden.status()).toBe(404);
    const actual = await openDetail(page, basis); await expect(actual.getByRole("article", { name: `调整单据 ${number}`, exact: true })).toContainText("待审核");
    await expect(actual.getByRole("button", { name: "核对并审核这笔调整", exact: true })).toBeDisabled();
    await expect(actual.getByRole("button", { name: "登记供应商贷项或补差", exact: true })).toBeDisabled();
    expect((await detail(basis.invoice.id)).balance.lines[0]!.allocatedQuantity).toBe("0.2");
  } finally {
    await changeErpRights("operator", operatorRights); await changeErpRights("readonly", readonlyRights);
    if (commandId) {
      const value = ProcurementCommandViewSchema.parse(await api(`procurement/commands/${commandId}`));
      if (value.status === "prepared") await api(`procurement/commands/${commandId}/cancel`, {});
      if (!value.acknowledged) await api(`procurement/commands/${commandId}/acknowledge`, {});
    }
  }
  async function detailAfterRestoringRights(): Promise<InvoiceReconciliationDetail> { await changeErpRights("operator", operatorRights); return detail(basis.invoice.id); }
});
