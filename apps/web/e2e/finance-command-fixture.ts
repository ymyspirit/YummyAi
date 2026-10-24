import { expect, type Locator, type Page, type Request as BrowserRequest } from "@playwright/test";
import type { z } from "zod";
import { FinanceCommandDetailSchema, FinanceCommandOriginalSchema, PrepareFinanceCommandSchema,
  type FinanceCommandDetail, type FinanceCommandKind } from "@yummyai/contracts/finance/finance-command";
import { FinanceLedgerDetailViewSchema } from "@yummyai/contracts/finance/ledger";

export const financeCommandEndpoint = "/api/finance/commands";
export const financeCommandReview = (page: Page) => page.getByRole("region", { name: "核对财务原提交", exact: true });
export const financeCommandConfirmation = "我已核对原填写、真实来源与固定版本 明确执行这笔财务提交";

export async function prepareFinanceCommand(page: Page, form: Locator, label = "保存原填写并核对") {
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === financeCommandEndpoint && response.request().method() === "POST");
  await form.getByRole("button", { name: label, exact: true }).click();
  const response = await submitted; expect(response.status()).toBe(201);
  const original = PrepareFinanceCommandSchema.parse(response.request().postDataJSON()), detail = FinanceCommandDetailSchema.parse(await response.json());
  expect(detail).toMatchObject({ kind: original.kind, targetId: original.targetId, requestKey: original.input.idempotencyKey, status: "prepared", result: null });
  await expect(financeCommandReview(page)).toContainText(detail.id); return { detail, original };
}
export async function readFinanceCommandOriginal(page: Page, detail: FinanceCommandDetail) {
  const review = financeCommandReview(page);
  await expect(review).toContainText(detail.id);
  const read = page.waitForResponse(response => new URL(response.url()).pathname === `${financeCommandEndpoint}/${detail.id}/original` && response.request().method() === "GET");
  await review.getByRole("button", { name: /^(读取原填写并核对|重新读取原填写)$/ }).click();
  const response = await read; expect(response.status()).toBe(200);
  const original = FinanceCommandOriginalSchema.parse(await response.json());
  expect(original.id).toBe(detail.id); expect(original.original).not.toBeNull();
  expect(original.original).toMatchObject({ kind: detail.kind, targetId: detail.targetId, input: { idempotencyKey: detail.requestKey } });
  await expect(review.getByRole("region", { name: "原财务填写", exact: true })).toBeVisible(); return original.original!;
}
export async function executeFinanceCommand(page: Page, detail: FinanceCommandDetail) {
  const review = financeCommandReview(page);
  await review.getByLabel(financeCommandConfirmation, { exact: true }).check();
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === `${financeCommandEndpoint}/${detail.id}/execute` && response.request().method() === "POST");
  await review.getByRole("button", { name: "确认执行原提交", exact: true }).click();
  const response = await submitted; expect(response.status()).toBe(200); expect(response.request().postDataJSON()).toEqual({});
  const completed = FinanceCommandDetailSchema.parse(await response.json());
  expect(completed).toMatchObject({ id: detail.id, kind: detail.kind, targetId: detail.targetId, requestKey: detail.requestKey, status: "succeeded" });
  expect(completed.result).not.toBeNull();
  await expect(review.getByRole("region", { name: "实际不可变财务凭据", exact: true })).toContainText(completed.result!.id); return completed;
}
export async function acknowledgeFinanceCommand(page: Page, detail: FinanceCommandDetail) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === `${financeCommandEndpoint}/${detail.id}/acknowledge` && value.request().method() === "POST");
  await financeCommandReview(page).getByRole("button", { name: "确认结果并清除填写副本", exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200); expect(actual.request().postDataJSON()).toEqual({});
  const acknowledged = FinanceCommandDetailSchema.parse(await actual.json());
  expect(acknowledged).toMatchObject({ id: detail.id, acknowledged: true, originalRetained: false, result: detail.result });
  await expect(financeCommandReview(page)).toHaveCount(0); return acknowledged;
}
export function financePayableCommandScope(path: string): { kind: FinanceCommandKind; targetId: string | null } {
  if (path === "bills") return { kind: "bill_record", targetId: null };
  if (path === "payments") return { kind: "payment_record", targetId: null };
  if (path === "allocations") return { kind: "payment_allocate", targetId: null };
  const match = /^(bills|payments|allocations)\/([a-f0-9-]{36})\/(adjustments|releases)$/.exec(path);
  if (!match) throw new Error("Synthetic payable path is not an actual command operation");
  return { kind: match[1] === "bills" ? "bill_adjustment_record" : match[1] === "payments" ? "payment_adjustment_record" : "allocation_release", targetId: match[2]! };
}
export async function readFinancePayableResult<T>(page: Page, completed: FinanceCommandDetail, schema: z.ZodType<T>): Promise<T> {
  const kinds: Partial<Record<FinanceCommandKind, string>> = { bill_record: "bills", payment_record: "payments", payment_allocate: "allocation_batches",
    allocation_release: "releases", bill_adjustment_record: "bill_adjustments", payment_adjustment_record: "payment_adjustments" };
  const kind = kinds[completed.kind]; if (!kind || !completed.result) throw new Error("Actual payable command receipt required");
  const response = await page.request.get(`/api/finance/ledger/${kind}/${completed.result.id}`); expect(response.status()).toBe(200);
  const detail = FinanceLedgerDetailViewSchema.parse(await response.json()); expect(detail.kind).toBe(kind);
  if (detail.kind === "procurement_adjustments") throw new Error("Actual payable receipt required, not a procurement candidate");
  expect(detail.record.id).toBe(completed.result.id);
  return schema.parse(detail.record);
}
export async function submitFinancePayableForm<T>(page: Page, title: string, path: string, schema: z.ZodType<T>, close = true): Promise<T> {
  const rawWrites: string[] = [], observe = (request: BrowserRequest) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/finance/payables/${path}`) rawWrites.push(request.url());
  };
  page.on("request", observe);
  try {
    const { detail, original } = await prepareFinanceCommand(page, page.getByRole("form", { name: title, exact: true })), scope = financePayableCommandScope(path);
    expect(original.kind).toBe(scope.kind);
    if (path === "allocations") { if (original.kind !== "payment_allocate") throw new Error("Actual allocation original required"); expect(original.targetId).toBe(original.input.paymentId); }
    else expect(original.targetId).toBe(scope.targetId);
    expect(await readFinanceCommandOriginal(page, detail)).toEqual(original);
    const completed = await executeFinanceCommand(page, detail), result = await readFinancePayableResult(page, completed, schema);
    if (close) {
      await acknowledgeFinanceCommand(page, completed);
      await expect(page.locator(".payables-workspace")).toHaveAttribute("aria-busy", "false");
    }
    expect(rawWrites).toEqual([]); return result;
  } finally { page.off("request", observe); }
}
