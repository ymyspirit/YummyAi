import { currencyMinorDigits, parseMinorAmount } from "@yummyai/contracts/common/money";

export type Operation = "store.create" | "store.update" | "supplier.create" | "supplier.update"
  | "factory.create" | "factory.revise" | "factoryCapability.create" | "factoryCapability.revise"
  | "warehouse.create" | "warehouse.update" | "location.create" | "location.update"
  | "stock.create" | "stock.update" | "stock.classify" | "movement.create" | "purchase.create" | "purchase.revise"
  | "purchase.review" | "purchase.receive" | "product.create" | "supply.create" | "supply.revise" | "supply.purchase";

export interface OperationResult {
  ok: boolean;
  message: string;
  record?: Record<string, unknown>;
  fieldErrors?: Record<string, string>;
  denied?: boolean;
}

export const unitNames = { each: "件", pair: "双", set: "套", meter: "米", gram: "克", kilogram: "千克" };
export const materialKindNames = { blank: "坯料", material: "材料", packaging: "包装", work_in_progress: "在制品", finished_good: "标准成品" };
export function localDateTime(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function formText(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }
export function formNumber(form: FormData, name: string) {
  const text = formText(form, name);
  return text ? Number(text) : Number.NaN;
}
export function formDate(form: FormData, name: string) {
  const value = formText(form, name);
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error("请填写有效日期。");
  return new Date(value).toISOString();
}
export function moneyMinor(value: string, currency = "CNY") {
  try { return parseMinorAmount(value, currency); }
  catch (error) {
    if (error instanceof RangeError && error.message === "money_out_of_range") throw new Error("金额超出可保存范围。");
    const digits = currencyMinorDigits(currency);
    throw new Error(digits === null ? "此币种的金额精度尚未确认 请核对币种" : `单价必须是不小于 0、最多 ${digits} 位小数的 ${currency} 金额。`);
  }
}
