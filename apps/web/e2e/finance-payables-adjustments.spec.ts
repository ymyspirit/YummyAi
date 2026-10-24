import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type Request as BrowserRequest } from "@playwright/test";
import type { z } from "zod";
import { Permission } from "@yummyai/authz";
import { FinanceAllocationReleaseViewSchema, FinancePayableBillViewSchema, FinancePayablePaymentViewSchema,
  FinancePayablesWorkspaceViewSchema, FinancePaymentAllocationBatchViewSchema } from "@yummyai/contracts/finance/payables";
import { FinanceBillAdjustmentViewSchema, FinancePaymentAdjustmentViewSchema, RecordFinanceBillAdjustmentInputSchema,
  type FinanceBillAdjustmentView, type RecordFinanceBillAdjustmentInput } from "@yummyai/contracts/finance/payables-adjustments";
import { IncomingCommandViewSchema, type PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { IncomingWorkspaceViewSchema } from "@yummyai/contracts/procurement/incoming";
import { InvoiceReconciliationDetailSchema, type InvoiceReconciliationInput } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { ProcurementCommandViewSchema } from "@yummyai/contracts/procurement/procurement-command";
import { ProcurementWorkspaceViewSchema } from "@yummyai/contracts/procurement";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { FinanceCommandDetailSchema, PrepareFinanceCommandSchema, type FinanceCommandDetail } from "@yummyai/contracts/finance/finance-command";
import { acknowledgeFinanceCommand, executeFinanceCommand, financeCommandEndpoint, financeCommandReview, prepareFinanceCommand,
  readFinanceCommandOriginal, readFinancePayableResult, submitFinancePayableForm } from "./finance-command-fixture";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_PAYABLES_ADJUSTMENTS_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || !["postgres:", "postgresql:"].includes(database.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Personal disposable payable adjustments fixture required before connection");
const base = process.env.API_BASE_URL!.replace(/\/$/, ""), endpoint = "/api/finance/payables", key = () => randomUUID();
const code = () => `ADJ-${randomUUID().slice(0, 8).toUpperCase()}`;
test.describe.configure({ mode: "serial" });

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { code?: unknown } | null;
    const safeCode = typeof failure?.code === "string" && /^[a-z_]{1,100}$/.test(failure.code) ? failure.code : "unavailable";
    throw new Error(`Synthetic payable adjustment fixture failed ${response.status} ${path} ${safeCode}`);
  }
  return response.json();
}
async function savedRights() {
  const actor = actors().operator, connection = connectDatabase();
  try {
    const [row] = await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic payable adjustment operator role missing"); return [...row.permissions];
  } finally { await connection.client.end(); }
}
const fullRights = (original: string[]) => [...new Set([...original, Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview])];
async function workspace(page: Page) { const response = await page.request.get(`${endpoint}/workspace`); expect(response.status()).toBe(200); return FinancePayablesWorkspaceViewSchema.parse(await response.json()); }
const billRow = (page: Page, number: string) => page.getByRole("row", { name: `应付账单 ${number}`, exact: true });
const paymentRow = (page: Page, number: string) => page.getByRole("row", { name: `付款证据 ${number}`, exact: true });
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const dialog = page.getByRole("dialog"); if (await dialog.count()) expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function closeResult(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const pair = financeCommandReview(page).locator("dl.finance-command-pairs > div").filter({ has: page.getByText("原提交 ID", { exact: true }) });
  const id = await pair.locator("dd code").innerText(), response = await page.request.get(`${financeCommandEndpoint}/${id}`); expect(response.status()).toBe(200);
  await acknowledgeFinanceCommand(page, FinanceCommandDetailSchema.parse(await response.json()));
  await expect(dialog).toHaveCount(0); await expect(page.locator(".payables-workspace")).toHaveAttribute("aria-busy", "false");
}
async function submit<T>(page: Page, title: string, suffix: string, schema: z.ZodType<T>, close = true): Promise<T> {
  return submitFinancePayableForm(page, title, suffix, schema, close);
}
async function bill(page: Page, supplierId: string, number: string, amount: string, procurementInvoiceId?: string) {
  await page.getByRole("button", { name: "登记应付账单", exact: true }).click(); const form = page.getByRole("form", { name: "登记应付账单", exact: true });
  await form.getByLabel("供应商", { exact: true }).selectOption(supplierId);
  await form.getByLabel("账单类型", { exact: true }).selectOption(procurementInvoiceId ? "procurement_invoice" : "factory_invoice");
  await form.getByLabel("账单编号", { exact: true }).fill(number); await form.getByLabel("账单币种", { exact: true }).selectOption("USD");
  await form.getByLabel("账单金额（主货币单位）", { exact: true }).fill(amount);
  // Match the original synthetic invoice's UTC minute in the browser's local timezone.
  const localIssue = await page.evaluate(() => { const date = new Date("2026-07-01T00:00:00.000Z"), pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; });
  await form.getByLabel("账单开具时间", { exact: true }).fill(localIssue);
  if (procurementInvoiceId) await form.getByLabel("实际采购发票 ID", { exact: true }).fill(procurementInvoiceId);
  return submit(page, "登记应付账单", "bills", FinancePayableBillViewSchema);
}
async function payment(page: Page, supplierId: string, number: string, amount: string) {
  await page.getByRole("button", { name: "登记付款证据", exact: true }).click(); const form = page.getByRole("form", { name: "登记付款证据", exact: true });
  await form.getByLabel("供应商", { exact: true }).selectOption(supplierId); await form.getByLabel("付款记录编号", { exact: true }).fill(number);
  await form.getByLabel("付款币种", { exact: true }).selectOption("USD"); await form.getByLabel("付款金额（主货币单位）", { exact: true }).fill(amount);
  await form.getByLabel("实际付款时间", { exact: true }).fill("2026-07-02T10:00"); await form.getByLabel("付款方式", { exact: true }).selectOption("bank_transfer");
  await form.getByLabel("付款证据流水标识", { exact: true }).fill(`${number}-EVIDENCE`);
  return submit(page, "登记付款证据", "payments", FinancePayablePaymentViewSchema);
}
async function allocation(page: Page, paymentNumber: string, billNumber: string, amount: string) {
  await paymentRow(page, paymentNumber).getByRole("button", { name: "分配到多个账单", exact: true }).click();
  await page.getByRole("form", { name: "分配付款到多个账单", exact: true }).getByLabel(`本次核销金额 ${billNumber}`, { exact: true }).fill(amount);
  return submit(page, "分配付款到多个账单", "allocations", FinancePaymentAllocationBatchViewSchema);
}
async function evidence(form: Locator, number: string, documentRequired = true) {
  if (documentRequired) await form.getByLabel("外部更正单据编号", { exact: true }).fill(number);
  await form.getByLabel("证据流水标识", { exact: true }).fill(`Synthetic actual supplier evidence ${number}`);
  await form.getByLabel("实际发生时间", { exact: true }).fill("2026-07-03T10:00"); await form.getByLabel("原因代码", { exact: true }).fill("SUPPLIER_CORRECTION");
}
async function billCorrectionForm(page: Page, number: string, kind: "credit" | "debit" | "void", document: string, amount?: string) {
  await billRow(page, number).getByRole("button", { name: "更正应付记录", exact: true }).click();
  const form = page.getByRole("form", { name: "登记应付更正", exact: true }); await form.getByLabel("应付更正类型", { exact: true }).selectOption(kind);
  await expect(form.getByLabel("应付更正类型", { exact: true })).toHaveValue(kind);
  if (kind === "void") await expect(form.getByLabel("外部更正单据编号", { exact: true })).toHaveCount(0);
  if (amount) await form.getByLabel(kind === "credit" ? "贷项金额（主货币单位）" : "补差金额（主货币单位）", { exact: true }).fill(amount);
  await evidence(form, document, kind !== "void"); return form;
}
async function paymentCorrectionForm(page: Page, number: string, kind: "refund" | "void", document: string, amount?: string) {
  await paymentRow(page, number).getByRole("button", { name: "更正付款记录", exact: true }).click();
  const form = page.getByRole("form", { name: "登记付款更正", exact: true }); await form.getByLabel("付款更正类型", { exact: true }).selectOption(kind);
  await expect(form.getByLabel("付款更正类型", { exact: true })).toHaveValue(kind);
  if (kind === "void") await expect(form.getByLabel("外部更正单据编号", { exact: true })).toHaveCount(0);
  if (amount) await form.getByLabel("已发生退款金额（主货币单位）", { exact: true }).fill(amount);
  await evidence(form, document, kind !== "void"); return form;
}

test("personal correction flow retains original principal, explicitly releases occupation, reallocates the net and records actual refunds separately from voids", async ({ page }, info) => {
  const originalRights = await savedRights(), prefix = code(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await changeErpRights("operator", fullRights(originalRights)); const supplier = await api("sourcing/suppliers", {
      name: `${prefix} Synthetic correction supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string };
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/finance/payables");
    const due = await bill(page, supplier.id, `${prefix}-BILL`, "1.00"), paid = await payment(page, supplier.id, `${prefix}-PAYMENT`, "1.00");
    const occupied = (await allocation(page, paid.externalPaymentId, due.externalBillId, "1.00")).allocations[0]!;
    await billRow(page, due.externalBillId).getByRole("button", { name: "更正应付记录", exact: true }).click();
    const blocked = page.getByRole("dialog", { name: "登记应付更正", exact: true });
    await expect(blocked).toContainText("请先撤销对应核销"); await expect(blocked.getByRole("button", { name: "保存原填写并核对", exact: true })).toBeDisabled();
    await blocked.getByRole("button", { name: "关闭登记应付更正", exact: true }).click(); await expect(blocked).toHaveCount(0);
    expect((await workspace(page)).billAdjustments.filter(row => row.billId === due.id)).toEqual([]);
    await page.getByRole("listitem", { name: `核销记录 ${occupied.id}`, exact: true }).getByRole("button", { name: "撤销本笔核销", exact: true }).click();
    await page.getByRole("form", { name: "撤销本笔核销", exact: true }).getByLabel("撤销原因代码", { exact: true }).selectOption("SOURCE_RECHECK");
    await submit(page, "撤销本笔核销", `allocations/${occupied.id}/releases`, FinanceAllocationReleaseViewSchema);
    expect((await workspace(page)).payments.find(row => row.id === paid.id)).toMatchObject({ amountMinor: 100, refundedMinor: 0, netAmountMinor: 100, unallocatedMinor: 100 });
    await billCorrectionForm(page, due.externalBillId, "credit", `${prefix}-CREDIT`, "0.20");
    const credit = await submit(page, "登记应付更正", `bills/${due.id}/adjustments`, FinanceBillAdjustmentViewSchema);
    expect(credit.balanceAfter.netAmountMinor).toBe(80);
    await billCorrectionForm(page, due.externalBillId, "debit", `${prefix}-DEBIT`, "0.05");
    const debit = await submit(page, "登记应付更正", `bills/${due.id}/adjustments`, FinanceBillAdjustmentViewSchema);
    expect(debit.balanceAfter).toMatchObject({ amountMinor: 100, creditMinor: 20, debitMinor: 5, netAmountMinor: 85 });
    await allocation(page, paid.externalPaymentId, due.externalBillId, "0.85");
    await page.setViewportSize({ width: 390, height: 844 }); await paymentCorrectionForm(page, paid.externalPaymentId, "refund", `${prefix}-REFUND`, "0.15");
    const refunded = await submit(page, "登记付款更正", `payments/${paid.id}/adjustments`, FinancePaymentAdjustmentViewSchema, false);
    expect(refunded).toMatchObject({ kind: "refund", evidenceStatus: "operator_recorded", balanceAfter: { amountMinor: 100, refundedMinor: 15, netAmountMinor: 85, allocatedMinor: 85, unallocatedMinor: 0 } });
    const result = page.getByRole("dialog", { name: "登记付款更正", exact: true }); await expect(result).toContainText("不表示银行转账、退款成功或当前完整余额");
    await expect(result.locator(".payables-dialog-body")).toHaveCSS("opacity", "1"); await noOverflow(page);
    const resultHeading = result.getByRole("heading", { name: "原操作已登记", exact: true }), closeButton = result.getByRole("button", { name: "关闭登记付款更正", exact: true });
    await expect(resultHeading).toBeVisible(); await expect(resultHeading).toBeInViewport(); await expect(closeButton).toBeVisible(); await expect(closeButton).toBeInViewport();
    await page.screenshot({ path: info.outputPath("payables-adjustments-mobile-viewport.png"), fullPage: false, animations: "disabled" });
    await page.screenshot({ path: info.outputPath("payables-adjustments-mobile.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 1000 }); await noOverflow(page);
    await expect(resultHeading).toBeVisible(); await expect(resultHeading).toBeInViewport(); await expect(closeButton).toBeVisible(); await expect(closeButton).toBeInViewport();
    await page.screenshot({ path: info.outputPath("payables-adjustments-desktop-viewport.png"), fullPage: false, animations: "disabled" });
    await page.screenshot({ path: info.outputPath("payables-adjustments-desktop.png"), fullPage: true, animations: "disabled" }); await closeResult(page, "登记付款更正");
    const voidBill = await bill(page, supplier.id, `${prefix}-VOID-BILL`, "0.05"), voidPayment = await payment(page, supplier.id, `${prefix}-VOID-PAYMENT`, "0.05");
    await billCorrectionForm(page, voidBill.externalBillId, "void", `${prefix}-BILL-VOID`);
    const billVoided = await submit(page, "登记应付更正", `bills/${voidBill.id}/adjustments`, FinanceBillAdjustmentViewSchema);
    await paymentCorrectionForm(page, voidPayment.externalPaymentId, "void", `${prefix}-PAYMENT-VOID`);
    const paymentVoided = await submit(page, "登记付款更正", `payments/${voidPayment.id}/adjustments`, FinancePaymentAdjustmentViewSchema);
    expect(billVoided.balanceAfter.lifecycle).toBe("voided"); expect(paymentVoided.balanceAfter).toMatchObject({ amountMinor: 5, voidedMinor: 5, refundedMinor: 0, netAmountMinor: 0, lifecycle: "voided" });
    await page.reload(); const actual = await workspace(page);
    expect(actual.bills.find(row => row.id === due.id)).toMatchObject({ amountMinor: 100, creditMinor: 20, debitMinor: 5, netAmountMinor: 85, allocatedMinor: 85, outstandingMinor: 0 });
    expect(actual.payments.find(row => row.id === paid.id)).toMatchObject({ amountMinor: 100, refundedMinor: 15, netAmountMinor: 85, allocatedMinor: 85 });
    expect(actual.allocations.find(row => row.id === occupied.id)).toMatchObject({ amountMinor: 100, released: true });
    expect(actual.billAdjustments.find(row => row.id === credit.id)).toEqual(credit);
    const earlier = page.getByRole("listitem", { name: `应付更正凭据 ${credit.id}`, exact: true });
    await earlier.getByText("查看该次执行时余额", { exact: true }).click(); await expect(earlier).toContainText("USD 0.80"); await expect(earlier).toContainText("不是当前余额");
    await expect(billRow(page, due.externalBillId)).toContainText("USD 0.85");
    await expect(billRow(page, voidBill.externalBillId).getByRole("button", { name: "更正应付记录", exact: true })).toBeDisabled();
    await expect(paymentRow(page, voidPayment.externalPaymentId).getByRole("button", { name: "更正付款记录", exact: true })).toBeDisabled(); expect(errors).toEqual([]);
  } finally { await changeErpRights("operator", originalRights); }
});

async function incoming(original: PrepareIncomingCommand) {
  const prepared = IncomingCommandViewSchema.parse(await api("procurement/incoming/commands", original));
  const completed = IncomingCommandViewSchema.parse(await api(`procurement/incoming/commands/${prepared.id}/execute`, {})); expect(completed.status).toBe("succeeded");
  await api(`procurement/incoming/commands/${prepared.id}/acknowledge`, {}); return completed.result!.id;
}
async function reconcile(invoiceId: string, input: InvoiceReconciliationInput) {
  const prepared = ProcurementCommandViewSchema.parse(await api("procurement/commands", { kind: "invoice_reconcile", targetId: invoiceId, input }));
  const completed = ProcurementCommandViewSchema.parse(await api(`procurement/commands/${prepared.id}/execute`, {})); expect(completed.status).toBe("succeeded");
  await api(`procurement/commands/${prepared.id}/acknowledge`, {}); return completed.reconciliationResult!;
}
async function procurementInvoiceSource(unitCostMinor = 1300) {
  const prefix = code(), supplier = await api("sourcing/suppliers", { name: `${prefix} Synthetic original supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string };
  const warehouse = await api("inventory/warehouses", { code: `${prefix}-WH`, name: `Synthetic ${prefix} warehouse`, type: "owned", countryCode: "US", timeZone: "UTC" }) as { id: string };
  const location = await api("inventory/locations", { warehouseId: warehouse.id, code: `${prefix}-HOLD`, name: `Synthetic ${prefix} actual hold` }) as { id: string };
  const stock = await api("inventory/stock-items", { skuId: null, code: `${prefix}-MAT`, name: `Synthetic ${prefix} measured material`, baseUnit: "gram", materialKind: "material" }) as { id: string };
  const order = await api("procurement/purchase-orders", { code: `${prefix}-PO`, supplierId: supplier.id, requisitionId: null, quoteId: null, currency: "USD",
    expectedAt: new Date(Date.now() + 86_400_000).toISOString(), lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: location.id,
      quantity: "0.25", unit: "kilogram", unitCostMinor: 1200, priceBasisQuantity: 1 }], idempotencyKey: key() }) as { id: string };
  await api(`procurement/purchase-orders/${order.id}/reviews`, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: key() });
  const standardId = await incoming({ kind: "publish_standard", targetId: stock.id, input: { code: `${prefix}-STD`, stockItemId: stock.id, expectedVersion: 0,
    title: "Synthetic actual supplier observations", sourceReference: "Isolated observation; no supplier contact",
    criteria: [{ code: "WIDTH", label: "Synthetic width", kind: "numeric_range", unit: "mm", minimum: "9", maximum: "11" }], idempotencyKey: key() } });
  const at = IncomingWorkspaceViewSchema.parse(await api(`procurement/incoming/orders/${order.id}`)).recordingTime;
  const arrivalId = await incoming({ kind: "record_arrival", targetId: order.id, input: { code: `${prefix}-ARR`, expectedPurchaseOrderVersion: 1, arrivedAt: at,
    externalReference: "Synthetic actual accepted material", lines: [{ lineKey: "LINE-1", quantity: 200, unit: "gram", holdingLocationId: location.id,
      lotCode: `${prefix}-LOT`, expiresAt: null }], idempotencyKey: key() } });
  const arrived = IncomingWorkspaceViewSchema.parse(await api(`procurement/incoming/orders/${order.id}`)), line = arrived.arrivals.find(row => row.id === arrivalId)!.lines[0]!;
  const inspectionId = await incoming({ kind: "record_inspection", targetId: line.id, input: { expectedInspectionVersion: 0, standardVersionId: standardId,
    acceptedQuantity: 200, rejectedQuantity: 0, sampleQuantity: 1, rejectionReason: null, measuredAt: at,
    readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: key() } });
  const reviewId = await incoming({ kind: "review_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, inspectionId, decision: "approved", reason: "Synthetic actual receipt checked", idempotencyKey: key() } });
  await incoming({ kind: "post_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, approvalId: reviewId, acceptedQuantity: 200, rejectedQuantity: 0,
    rejectionLocationId: null, ownershipConfirmation: "merchant_received", postedAt: at, idempotencyKey: key() } });
  const invoice = await api(`procurement/purchase-orders/${order.id}/invoices`, { expectedVersion: 1, invoiceNumber: `${prefix}-INVOICE`, currency: "USD", issuedAt: "2026-07-01T00:00:00.000Z",
    lines: [{ lineKey: "LINE-1", invoicedQuantity: "0.2", unitCostMinor, priceBasisQuantity: 1 }], idempotencyKey: key() }) as { id: string; invoiceNumber: string };
  return { prefix, supplier, order, invoice };
}
async function approveProcurementAdjustment(source: Awaited<ReturnType<typeof procurementInvoiceSource>>,
  options: { kind?: "credit_note" | "debit_note"; quantity?: "0.05" | "0.01"; amountMinor?: number; number?: string } = {}) {
  const { prefix, invoice } = source;
  const detail = InvoiceReconciliationDetailSchema.parse(await api(`procurement/invoice-reconciliations/${invoice.id}`));
  const record = await reconcile(invoice.id, { action: "adjustment_record", expectedFingerprint: detail.fingerprint, reason: "Synthetic actual supplier correction",
    document: { kind: options.kind ?? "credit_note", number: options.number ?? `${prefix}-CREDIT`, issuedAt: "2026-07-03T00:00:00.000Z", currency: "USD", evidenceReference: "Synthetic approved supplier correction evidence" },
    lines: [{ invoiceLineId: detail.balance.lines[0]!.invoiceLineId, quantity: options.quantity ?? 0, unit: "kilogram", amountMinor: options.amountMinor ?? 20 }], idempotencyKey: key() });
  const pending = InvoiceReconciliationDetailSchema.parse(await api(`procurement/invoice-reconciliations/${invoice.id}`));
  const review = await reconcile(invoice.id, { action: "adjustment_review", expectedFingerprint: pending.fingerprint, adjustmentId: record.id, decision: "approved",
    reason: "Synthetic current approver checked original credit", idempotencyKey: key() });
  return { ...source, record, review };
}
async function approvedProcurementSource() { return approveProcurementAdjustment(await procurementInvoiceSource()); }

test("a personal reviewer synchronizes a real approved procurement credit without manual source replacement and allocates only its corrected net", async ({ page }) => {
  const originalRights = await savedRights();
  try {
    await changeErpRights("operator", fullRights(originalRights)); const source = await approvedProcurementSource();
    const beforeInvoice = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.find(row => row.id === source.invoice.id)!;
    await loginErp(page, "operator", "/finance/payables"); const due = await bill(page, source.supplier.id, source.invoice.invoiceNumber, "2.60", source.invoice.id);
    const paid = await payment(page, source.supplier.id, `${source.prefix}-PAYMENT`, "2.40");
    expect(due).toMatchObject({ amountMinor: 260, netAmountMinor: 260, sourceStatus: "source_adjusted" });
    await expect(billRow(page, due.externalBillId).getByRole("button", { name: "选择付款核销", exact: true })).toBeDisabled();
    await changeErpRights("operator", fullRights(originalRights).filter(permission => permission !== Permission.FinanceWrite));
    await loginErp(page, "operator", "/finance/payables"); await expect(page.getByRole("button", { name: "登记应付账单", exact: true })).toHaveCount(0);
    await billRow(page, due.externalBillId).getByRole("button", { name: "更正应付记录", exact: true }).click();
    const form = page.getByRole("form", { name: "登记应付更正", exact: true });
    await expect(form.getByLabel("应付更正类型", { exact: true }).locator('option[value="credit"]')).toHaveCount(0);
    await expect(form.getByLabel("贷项金额（主货币单位）", { exact: true })).toHaveCount(0);
    await form.getByLabel("已批准采购调整", { exact: true }).selectOption(source.record.id);
    await expect(form.locator('[aria-label="所选采购调整依据"]')).toContainText(source.record.id);
    await expect(form.locator('[aria-label="所选采购调整依据"]')).toContainText(source.review.id); await noOverflow(page);
    const actual = await submit(page, "登记应付更正", `bills/${due.id}/adjustments`, FinanceBillAdjustmentViewSchema);
    expect(actual).toMatchObject({ kind: "credit", amountMinor: 20, procurementAdjustmentId: source.record.id, procurementReviewId: source.review.id,
      balanceAfter: { amountMinor: 260, creditMinor: 20, netAmountMinor: 240 } });
    expect((await workspace(page)).bills.find(row => row.id === due.id)).toMatchObject({ sourceStatus: "current", amountMinor: 260, netAmountMinor: 240 });
    await allocation(page, paid.externalPaymentId, due.externalBillId, "2.40"); await page.reload();
    const current = await workspace(page); expect(current.bills.find(row => row.id === due.id)).toMatchObject({ amountMinor: 260, creditMinor: 20, netAmountMinor: 240, allocatedMinor: 240, outstandingMinor: 0 });
    expect(current.procurementAdjustments.find(row => row.procurementAdjustmentId === source.record.id)?.mappedEventId).toBe(actual.id);
    expect(ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.find(row => row.id === source.invoice.id)).toEqual(beforeInvoice);
    await expect(page.getByRole("listitem", { name: `应付更正凭据 ${actual.id}`, exact: true })).toContainText(source.review.id);
  } finally { await changeErpRights("operator", originalRights); }
});

test("an occupied real procurement credit requires explicit release before synchronization, while approved debits and zero-money acknowledgements remain selectable", async ({ page }) => {
  const originalRights = await savedRights(), submitted: RecordFinanceBillAdjustmentInput[] = [];
  let watchedPath: string | undefined;
  const watch = (request: BrowserRequest) => {
    if (new URL(request.url()).pathname === financeCommandEndpoint && request.method() === "POST") {
      const original = PrepareFinanceCommandSchema.parse(request.postDataJSON());
      if (original.kind === "bill_adjustment_record" && `${endpoint}/bills/${original.targetId}/adjustments` === watchedPath)
        submitted.push(RecordFinanceBillAdjustmentInputSchema.parse(original.input));
    }
  };
  page.on("request", watch);
  try {
    await changeErpRights("operator", fullRights(originalRights)); const source = await procurementInvoiceSource(1200);
    await loginErp(page, "operator", "/finance/payables"); const due = await bill(page, source.supplier.id, source.invoice.invoiceNumber, "2.40", source.invoice.id);
    const paid = await payment(page, source.supplier.id, `${source.prefix}-OCCUPIED-PAYMENT`, "2.40");
    expect(due).toMatchObject({ sourceStatus: "current", amountMinor: 240, netAmountMinor: 240 });
    const occupied = (await allocation(page, paid.externalPaymentId, due.externalBillId, "2.00")).allocations[0]!;
    const actualCredit = await approveProcurementAdjustment(source, { quantity: "0.05", amountMinor: 60, number: `${source.prefix}-QUANTITY-CREDIT` });
    const actualDebit = await approveProcurementAdjustment(source, { kind: "debit_note", amountMinor: 12, number: `${source.prefix}-DEBIT` });
    const actualAcknowledgement = await approveProcurementAdjustment(source, { quantity: "0.01", amountMinor: 0, number: `${source.prefix}-QUANTITY-ACK` });
    // The last real price correction leaves all four approved source effects matched:
    // 0.20kg - 0.05kg - 0.01kg = 0.14kg; 240 - 60 + 12 - 24 = 168 minor.
    const actualPriceCredit = await approveProcurementAdjustment(source, { amountMinor: 24, number: `${source.prefix}-PRICE-CREDIT` });
    const reconciled = InvoiceReconciliationDetailSchema.parse(await api(`procurement/invoice-reconciliations/${source.invoice.id}`));
    expect(reconciled.balance).toMatchObject({ status: "matched", netAmountMinor: 168, varianceMinor: 0, lines: [{ netQuantity: "0.14" }] });
    const originalInvoice = ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.find(row => row.id === source.invoice.id)!;
    await changeErpRights("operator", fullRights(originalRights).filter(permission => permission !== Permission.FinanceWrite));
    await page.setViewportSize({ width: 390, height: 844 }); await loginErp(page, "operator", "/finance/payables");
    const before = await workspace(page); expect(before.permissions).toEqual({ canWrite: false, canReview: true });
    expect(before.bills.find(row => row.id === due.id)).toMatchObject({ amountMinor: 240, netAmountMinor: 240, allocatedMinor: 200, outstandingMinor: 40, sourceStatus: "source_adjusted" });
    watchedPath = `${endpoint}/bills/${due.id}/adjustments`;
    await billRow(page, due.externalBillId).getByRole("button", { name: "更正应付记录", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记应付更正", exact: true }), form = dialog.getByRole("form", { name: "登记应付更正", exact: true });
    const selected = form.getByLabel("已批准采购调整", { exact: true }), submitButton = form.getByRole("button", { name: "保存原填写并核对", exact: true });
    await selected.selectOption(actualCredit.record.id);
    const exactReason = "所选采购贷项 USD 0.60 超过本次读取的净额待核销余额 USD 0.40 请先在核销历史中撤销相关核销 再同步真实批准记录 并按调整后的净额重新分配";
    await expect(form).toContainText(exactReason); await expect(submitButton).toBeDisabled(); expect(submitted).toEqual([]);
    await selected.selectOption(actualDebit.record.id); await expect(submitButton).toBeEnabled(); await expect(form).not.toContainText(exactReason);
    await selected.selectOption(actualAcknowledgement.record.id); await expect(submitButton).toBeEnabled();
    await expect(form.locator('[aria-label="所选采购调整依据"]')).toContainText("仅确认采购来源或数量依据 不新增应付金额");
    await selected.selectOption(actualCredit.record.id); await expect(submitButton).toBeDisabled(); await expect(form).toContainText(exactReason); await noOverflow(page);
    expect((await workspace(page)).billAdjustments.filter(row => row.billId === due.id)).toEqual([]); expect(submitted).toEqual([]);
    page.once("dialog", confirmation => confirmation.accept());
    await dialog.getByRole("button", { name: "关闭登记应付更正", exact: true }).click(); await expect(dialog).toHaveCount(0); expect(submitted).toEqual([]);
    await page.getByRole("listitem", { name: `核销记录 ${occupied.id}`, exact: true }).getByRole("button", { name: "撤销本笔核销", exact: true }).click();
    await page.getByRole("form", { name: "撤销本笔核销", exact: true }).getByLabel("撤销原因代码", { exact: true }).selectOption("SOURCE_RECHECK");
    await submit(page, "撤销本笔核销", `allocations/${occupied.id}/releases`, FinanceAllocationReleaseViewSchema);
    expect((await workspace(page)).payments.find(row => row.id === paid.id)).toMatchObject({ amountMinor: 240, refundedMinor: 0, netAmountMinor: 240, allocatedMinor: 0, unallocatedMinor: 240 });
    for (const [approved, net, kind, amountMinor] of [[actualCredit, 180, "credit", 60], [actualDebit, 192, "debit", 12],
      [actualAcknowledgement, 192, "source_acknowledgement", 0], [actualPriceCredit, 168, "credit", 24]] as const) {
      await billRow(page, due.externalBillId).getByRole("button", { name: "更正应付记录", exact: true }).click();
      const current = page.getByRole("form", { name: "登记应付更正", exact: true }); await current.getByLabel("已批准采购调整", { exact: true }).selectOption(approved.record.id);
      await expect(current.getByRole("button", { name: "保存原填写并核对", exact: true })).toBeEnabled();
      const receipt = await submit(page, "登记应付更正", `bills/${due.id}/adjustments`, FinanceBillAdjustmentViewSchema);
      expect(receipt).toMatchObject({ kind, amountMinor, procurementAdjustmentId: approved.record.id, procurementReviewId: approved.review.id,
        balanceAfter: { amountMinor: 240, netAmountMinor: net, allocatedMinor: 0 } });
    }
    await allocation(page, paid.externalPaymentId, due.externalBillId, "1.68"); await page.reload();
    const actual = await workspace(page); expect(actual.bills.find(row => row.id === due.id)).toMatchObject({ amountMinor: 240, creditMinor: 84,
      debitMinor: 12, netAmountMinor: 168, allocatedMinor: 168, outstandingMinor: 0, sourceStatus: "current" });
    expect(actual.payments.find(row => row.id === paid.id)).toMatchObject({ amountMinor: 240, refundedMinor: 0, netAmountMinor: 240, allocatedMinor: 168, unallocatedMinor: 72 });
    expect(actual.allocations.find(row => row.id === occupied.id)).toMatchObject({ amountMinor: 200, released: true });
    expect(submitted).toHaveLength(4); expect(new Set(submitted.map(row => row.idempotencyKey)).size).toBe(4);
    expect(ProcurementWorkspaceViewSchema.parse(await api("procurement/workspace")).invoices.find(row => row.id === source.invoice.id)).toEqual(originalInvoice);
  } finally { page.off("request", watch); await changeErpRights("operator", originalRights); }
});

test("a lost correction receipt keeps the exact original key, and live reviewer revocation removes private editing while reads remain authorized", async ({ page }) => {
  const originalRights = await savedRights(), prefix = code(), originals: RecordFinanceBillAdjustmentInput[] = [];
  let stored: FinanceBillAdjustmentView | undefined, prepared: FinanceCommandDetail | undefined, routePattern: string | undefined;
  try {
    await changeErpRights("operator", fullRights(originalRights)); const supplier = await api("sourcing/suppliers", {
      name: `${prefix} Synthetic unknown-result supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string };
    await loginErp(page, "operator", "/finance/payables"); const due = await bill(page, supplier.id, `${prefix}-ORIGINAL`, "1.00");
    routePattern = `**${financeCommandEndpoint}`;
    await page.route(routePattern, async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      const original = PrepareFinanceCommandSchema.parse(route.request().postDataJSON()); expect(original.kind).toBe("bill_adjustment_record");
      originals.push(RecordFinanceBillAdjustmentInputSchema.parse(original.input)); const response = await route.fetch(); expect(response.status()).toBe(201);
      const receipt = FinanceCommandDetailSchema.parse(await response.json());
      if (originals.length === 1) { prepared = receipt; await route.abort("failed"); } else { expect(receipt).toEqual(prepared); await route.fulfill({ response }); }
    });
    const form = await billCorrectionForm(page, due.externalBillId, "credit", `${prefix}-CREDIT`, "0.20");
    await form.getByRole("button", { name: "保存原填写并核对", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "登记应付更正", exact: true });
    await expect(dialog.getByText("准备响应尚未确认 原正文与原键已固定", { exact: true })).toBeVisible();
    await expect(dialog.locator("fieldset.record-fields")).toHaveAttribute("inert", ""); await expect(form.getByLabel("贷项金额（主货币单位）", { exact: true })).toHaveValue("0.20");
    expect((await workspace(page)).billAdjustments.filter(row => row.billId === due.id)).toEqual([]);
    const restored = await prepareFinanceCommand(page, form, "重试保存同一笔原提交"); expect(restored.detail.id).toBe(prepared!.id);
    expect(await readFinanceCommandOriginal(page, restored.detail)).toEqual(restored.original); const completed = await executeFinanceCommand(page, restored.detail);
    stored = await readFinancePayableResult(page, completed, FinanceBillAdjustmentViewSchema); await acknowledgeFinanceCommand(page, completed);
    expect(stored).toMatchObject({ id: completed.result!.id, amountMinor: 20, balanceAfter: { amountMinor: 100, netAmountMinor: 80 } });
    expect(originals).toHaveLength(2); expect(originals[1]).toEqual(originals[0]); expect(originals[0]!.expectedNetAmountMinor).toBe(100);
    await page.unroute(routePattern); routePattern = undefined;
    await billCorrectionForm(page, due.externalBillId, "debit", `${prefix}-DENIED`, "0.05");
    const readRights = fullRights(originalRights).filter(permission => permission !== Permission.FinanceReview);
    await changeErpRights("operator", readRights);
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === financeCommandEndpoint && response.request().method() === "POST");
    await page.getByRole("form", { name: "登记应付更正", exact: true }).getByRole("button", { name: "保存原填写并核对", exact: true }).click(); expect((await denied).status()).toBe(403);
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("alert").filter({ hasText: "当前权限不足" })).toBeVisible();
    await expect(page.getByText(`${prefix}-DENIED`, { exact: true })).toHaveCount(0);
    await loginErp(page, "operator", "/finance/payables"); await expect(billRow(page, due.externalBillId)).toContainText("USD 0.80");
    await expect(page.getByRole("button", { name: "更正应付记录", exact: true })).toHaveCount(0); await expect(page.getByRole("listitem", { name: `应付更正凭据 ${stored!.id}`, exact: true })).toBeVisible();
    const deniedReplay = await page.request.post(`${endpoint}/bills/${due.id}/adjustments`, { data: originals[0], headers: { origin: new URL(page.url()).origin } });
    expect(deniedReplay.status()).toBe(403); expect((await workspace(page)).billAdjustments.filter(row => row.billId === due.id)).toEqual([stored]);
    // Retain the original nonfinance capabilities so only financial reading is revoked.
    await changeErpRights("operator", readRights.filter(permission => permission !== Permission.FinanceRead)); await loginErp(page, "operator", "/finance/payables");
    const alert = page.getByRole("alert").filter({ hasText: "缺少财务读取权限" }); await expect(alert).toHaveCount(1); await expect(alert).toBeVisible();
    await expect(page.getByRole("table", { name: "实际应付账单", exact: true })).toHaveCount(0); await expect(page.getByText(`${prefix}-CREDIT`, { exact: true })).toHaveCount(0);
    expect((await page.request.get(`${endpoint}/workspace`)).status()).toBe(403);
  } finally {
    try { if (routePattern) await page.unroute(routePattern); }
    finally { await changeErpRights("operator", originalRights); }
  }
});
