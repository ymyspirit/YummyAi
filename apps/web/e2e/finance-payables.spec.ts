import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { z } from "zod";
import { Permission } from "@yummyai/authz";
import { FinanceAllocationReleaseViewSchema, FinancePayableBillViewSchema, FinancePayablePaymentViewSchema,
  FinancePayablesWorkspaceViewSchema, FinancePaymentAllocationBatchViewSchema, RecordFinanceBillInputSchema,
  type RecordFinanceBillInput } from "@yummyai/contracts/finance/payables";
import { FulfillmentSupplierViewSchema } from "@yummyai/contracts/order/routing";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { FinanceCommandDetailSchema, PrepareFinanceCommandSchema, type FinanceCommandDetail } from "@yummyai/contracts/finance/finance-command";
import { acknowledgeFinanceCommand, executeFinanceCommand, financeCommandEndpoint, prepareFinanceCommand,
  readFinanceCommandOriginal, readFinancePayableResult, submitFinancePayableForm } from "./finance-command-fixture";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_PAYABLES_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || !["postgres:", "postgresql:"].includes(database.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Personal disposable finance payables browser fixture required before connection");
const base = process.env.API_BASE_URL!.replace(/\/$/, ""), endpoint = "/api/finance/payables", prefix = () => `PAY-${randomUUID().slice(0, 8).toUpperCase()}`;
test.describe.configure({ mode: "serial" });

async function seedSupplier(name: string) {
  const response = await fetch(`${base}/v1/sourcing/suppliers`, { method: "POST", headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`,
    "content-type": "application/json" }, body: JSON.stringify({ name, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) });
  if (!response.ok) throw new Error(`Synthetic payables supplier setup failed ${response.status}`);
  return FulfillmentSupplierViewSchema.parse(await response.json());
}
async function savedRights() {
  const actor = actors().operator, connection = connectDatabase();
  try {
    const [row] = await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic payable operator role missing"); return [...row.permissions];
  } finally { await connection.client.end(); }
}
const fullRights = (original: string[]) => [...new Set([...original, Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview])];
async function readWorkspace(page: Page) {
  const response = await page.request.get(`${endpoint}/workspace`); expect(response.status()).toBe(200);
  return FinancePayablesWorkspaceViewSchema.parse(await response.json());
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
const billRow = (page: Page, externalBillId: string) => page.getByRole("row", { name: `应付账单 ${externalBillId}`, exact: true });
const paymentRow = (page: Page, externalPaymentId: string) => page.getByRole("row", { name: `付款证据 ${externalPaymentId}`, exact: true });
async function submit<T>(page: Page, title: string, path: string, schema: z.ZodType<T>): Promise<T> {
  return submitFinancePayableForm(page, title, path, schema);
}
async function billForm(page: Page, supplierId: string, externalBillId: string, amount: string, kind = "factory_invoice") {
  await page.getByRole("button", { name: "登记应付账单", exact: true }).click();
  const form = page.getByRole("form", { name: "登记应付账单", exact: true });
  await form.getByLabel("供应商", { exact: true }).selectOption(supplierId); await form.getByLabel("账单类型", { exact: true }).selectOption(kind);
  await form.getByLabel("账单编号", { exact: true }).fill(externalBillId); await form.getByLabel("账单币种", { exact: true }).selectOption("USD");
  await form.getByLabel("账单金额（主货币单位）", { exact: true }).fill(amount); await form.getByLabel("账单开具时间", { exact: true }).fill("2026-07-01T10:00");
  await form.getByLabel("账单到期时间", { exact: true }).fill("2026-07-31T10:00"); return form;
}
async function createBill(page: Page, supplierId: string, externalBillId: string, amount: string, kind = "factory_invoice") {
  await billForm(page, supplierId, externalBillId, amount, kind);
  return submit(page, "登记应付账单", "bills", FinancePayableBillViewSchema);
}
async function createPayment(page: Page, supplierId: string, externalPaymentId: string, amount: string) {
  await page.getByRole("button", { name: "登记付款证据", exact: true }).click(); const form = page.getByRole("form", { name: "登记付款证据", exact: true });
  await form.getByLabel("供应商", { exact: true }).selectOption(supplierId); await form.getByLabel("付款记录编号", { exact: true }).fill(externalPaymentId);
  await form.getByLabel("付款币种", { exact: true }).selectOption("USD"); await form.getByLabel("付款金额（主货币单位）", { exact: true }).fill(amount);
  await form.getByLabel("实际付款时间", { exact: true }).fill("2026-07-02T10:00"); await form.getByLabel("付款方式", { exact: true }).selectOption("bank_transfer");
  await form.getByLabel("付款证据流水标识", { exact: true }).fill(`${externalPaymentId}-EVIDENCE`);
  return submit(page, "登记付款证据", "payments", FinancePayablePaymentViewSchema);
}
async function allocate(page: Page, externalPaymentId: string, entries: Array<{ bill: string; amount: string }>) {
  await paymentRow(page, externalPaymentId).getByRole("button", { name: "分配到多个账单", exact: true }).click();
  const form = page.getByRole("form", { name: "分配付款到多个账单", exact: true });
  await expect(form.getByLabel("用于核销的付款记录", { exact: true })).not.toHaveValue("");
  for (const entry of entries) await form.getByLabel(`本次核销金额 ${entry.bill}`, { exact: true }).fill(entry.amount);
  await noOverflow(page); return submit(page, "分配付款到多个账单", "allocations", FinancePaymentAllocationBatchViewSchema);
}
async function textVisible(locator: Locator) {
  await locator.scrollIntoViewIfNeeded(); await expect(locator).toBeInViewport(); await expect(locator).toHaveCSS("opacity", "1");
}

test("personal operator records two bills and actual payment evidence, partially allocates, releases and reallocates with persistent desktop and mobile balances", async ({ page }, info) => {
  const originalRights = await savedRights(), code = prefix(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await changeErpRights("operator", fullRights(originalRights)); const supplier = await seedSupplier(`${code} Synthetic supplier`);
    await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "operator", "/finance/payables");
    await expect(page.getByRole("heading", { name: "应付与付款核销", exact: true })).toBeVisible();
    const a = await createBill(page, supplier.id, `${code}-FACTORY-A`, "100.00"); expect(a.amountMinor).toBe(10000);
    const b = await createBill(page, supplier.id, `${code}-SUPPLIER-B`, "50.00", "supplier_invoice"); expect(b.amountMinor).toBe(5000);
    await page.setViewportSize({ width: 390, height: 844 });
    const paid = await createPayment(page, supplier.id, `${code}-BANK-EVIDENCE`, "120.00");
    expect(paid).toMatchObject({ amountMinor: 12000, evidenceStatus: "operator_recorded", unallocatedMinor: 12000 });
    await expect(paymentRow(page, paid.externalPaymentId)).toContainText("人工登记 未经银行认证");
    const first = await allocate(page, paid.externalPaymentId, [{ bill: a.externalBillId, amount: "70.00" }, { bill: b.externalBillId, amount: "50.00" }]);
    expect(first.allocations).toHaveLength(2); const originalAllocation = first.allocations.find(row => row.billId === a.id)!;
    let actual = await readWorkspace(page); expect(actual.bills.find(row => row.id === a.id)).toMatchObject({ allocatedMinor: 7000, outstandingMinor: 3000, status: "partially_allocated" });
    expect(actual.bills.find(row => row.id === b.id)).toMatchObject({ allocatedMinor: 5000, outstandingMinor: 0, status: "fully_allocated" });
    await expect(billRow(page, a.externalBillId)).toContainText("部分核销"); await expect(billRow(page, b.externalBillId)).toContainText("已全额核销");
    await page.getByRole("listitem", { name: `核销记录 ${originalAllocation.id}`, exact: true }).getByRole("button", { name: "撤销本笔核销", exact: true }).click();
    await page.getByRole("form", { name: "撤销本笔核销", exact: true }).getByLabel("撤销原因代码", { exact: true }).selectOption("AMOUNT_CORRECTION");
    const release = await submit(page, "撤销本笔核销", `allocations/${originalAllocation.id}/releases`, FinanceAllocationReleaseViewSchema);
    expect(release.allocationId).toBe(originalAllocation.id); actual = await readWorkspace(page);
    expect(actual.bills.find(row => row.id === a.id)).toMatchObject({ allocatedMinor: 0, outstandingMinor: 10000 });
    expect(actual.payments.find(row => row.id === paid.id)).toMatchObject({ amountMinor: 12000, allocatedMinor: 5000, unallocatedMinor: 7000 });
    const amended = await allocate(page, paid.externalPaymentId, [{ bill: a.externalBillId, amount: "60.00" }]); expect(amended.allocations[0]!.amountMinor).toBe(6000);
    await page.setViewportSize({ width: 1440, height: 1000 }); const remainder = await createPayment(page, supplier.id, `${code}-SECOND-EVIDENCE`, "40.00");
    await allocate(page, remainder.externalPaymentId, [{ bill: a.externalBillId, amount: "40.00" }]);
    await page.reload(); await expect(billRow(page, a.externalBillId)).toContainText("已全额核销"); actual = await readWorkspace(page);
    expect(actual.bills.find(row => row.id === a.id)).toMatchObject({ amountMinor: 10000, allocatedMinor: 10000, outstandingMinor: 0 });
    expect(actual.payments.find(row => row.id === paid.id)).toMatchObject({ amountMinor: 12000, allocatedMinor: 11000, unallocatedMinor: 1000 });
    expect(actual.allocations.find(row => row.id === originalAllocation.id)).toMatchObject({ amountMinor: 7000, released: true });
    expect(actual.releases.filter(row => row.allocationId === originalAllocation.id)).toEqual([release]);
    await expect(page.getByRole("listitem", { name: `核销记录 ${originalAllocation.id}`, exact: true })).toContainText("已撤销 本笔不再占用余额");
    const bills = page.getByRole("region", { name: "实际应付账单", exact: true }); await textVisible(bills); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("finance-payables-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 }); await textVisible(bills); await noOverflow(page);
    await expect(paymentRow(page, paid.externalPaymentId)).toContainText("USD 10.00");
    await page.screenshot({ path: info.outputPath("finance-payables-mobile.png"), fullPage: true, animations: "disabled" }); expect(errors).toEqual([]);
  } finally { await changeErpRights("operator", originalRights); }
});

test("a lost write response retries the same original key once, then current write and read permissions control the actual personal page", async ({ page }) => {
  const originalRights = await savedRights(), code = prefix(), bodies: RecordFinanceBillInput[] = []; let firstSaved: FinanceCommandDetail | undefined;
  const routePattern = `**${financeCommandEndpoint}`;
  try {
    await changeErpRights("operator", fullRights(originalRights)); const supplier = await seedSupplier(`${code} Synthetic unknown-response supplier`);
    await loginErp(page, "operator", "/finance/payables");
    await page.route(routePattern, async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      const original = PrepareFinanceCommandSchema.parse(route.request().postDataJSON()); expect(original.kind).toBe("bill_record");
      bodies.push(RecordFinanceBillInputSchema.parse(original.input)); const response = await route.fetch(); expect(response.status()).toBe(201);
      const receipt = FinanceCommandDetailSchema.parse(await response.json());
      if (bodies.length === 1) { firstSaved = receipt; await route.abort("failed"); } else { expect(receipt.id).toBe(firstSaved!.id); await route.fulfill({ response }); }
    });
    const form = await billForm(page, supplier.id, `${code}-ORIGINAL`, "0.29"); await form.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记应付账单", exact: true });
    await expect(dialog.getByText("准备响应尚未确认 原正文与原键已固定", { exact: true })).toBeVisible();
    await expect(dialog.locator("fieldset.record-fields")).toHaveAttribute("inert", ""); await expect(form.getByLabel("账单金额（主货币单位）", { exact: true })).toHaveValue("0.29");
    // Saving an unknown preparation has not yet registered the actual bill.
    expect((await readWorkspace(page)).bills.filter(row => row.externalBillId === `${code}-ORIGINAL`)).toHaveLength(0);
    const restored = await prepareFinanceCommand(page, form, "重试保存同一笔原提交"); expect(restored.detail.id).toBe(firstSaved!.id);
    expect(await readFinanceCommandOriginal(page, restored.detail)).toEqual(restored.original); const completed = await executeFinanceCommand(page, restored.detail);
    const recovered = await readFinancePayableResult(page, completed, FinancePayableBillViewSchema); await acknowledgeFinanceCommand(page, completed);
    expect(recovered).toMatchObject({ id: completed.result!.id, amountMinor: 29 }); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
    expect((await readWorkspace(page)).bills.filter(row => row.externalBillId === `${code}-ORIGINAL`)).toHaveLength(1);
    await page.unroute(routePattern); await page.reload(); await expect(billRow(page, recovered.externalBillId)).toContainText("USD 0.29");
    const readRights = fullRights(originalRights).filter(permission => permission !== Permission.FinanceWrite && permission !== Permission.FinanceReview);
    await changeErpRights("operator", readRights); await loginErp(page, "operator", "/finance/payables");
    await expect(billRow(page, recovered.externalBillId)).toBeVisible(); await expect(page.getByRole("button", { name: "登记应付账单", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "登记付款证据", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "选择付款核销", exact: true })).toHaveCount(0);
    const before = await readWorkspace(page); expect(before.permissions).toEqual({ canWrite: false, canReview: false });
    const deniedWrite = await page.request.post(`${endpoint}/bills`, { data: bodies[0], headers: { origin: new URL(page.url()).origin } });
    expect(deniedWrite.status()).toBe(403); expect((await readWorkspace(page)).bills).toEqual(before.bills);
    // Keep the fixture's nonfinance ERP capabilities so only this page is denied.
    await changeErpRights("operator", readRights.filter(permission => permission !== Permission.FinanceRead));
    await loginErp(page, "operator", "/finance/payables"); const denied = page.getByRole("alert").filter({ hasText: "缺少财务读取权限" });
    await expect(denied).toHaveCount(1); await expect(denied).toBeVisible(); await expect(page.getByRole("table", { name: "实际应付账单", exact: true })).toHaveCount(0);
    await expect(page.getByText(recovered.externalBillId, { exact: true })).toHaveCount(0); expect((await page.request.get(`${endpoint}/workspace`)).status()).toBe(403);
  } finally { try { await page.unroute(routePattern); } finally { await changeErpRights("operator", originalRights); } }
});
