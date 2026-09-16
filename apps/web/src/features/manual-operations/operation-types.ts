export type Operation = "store.create" | "store.update" | "supplier.create" | "supplier.update"
  | "warehouse.create" | "warehouse.update" | "location.create" | "location.update"
  | "stock.create" | "stock.update" | "movement.create" | "purchase.create" | "purchase.revise"
  | "purchase.review" | "purchase.receive" | "product.create" | "supply.create" | "supply.revise" | "supply.purchase";

export interface OperationResult {
  ok: boolean;
  message: string;
  record?: Record<string, unknown>;
  fieldErrors?: Record<string, string>;
}

export const unitNames = { each: "件", pair: "双", set: "套", meter: "米", gram: "克", kilogram: "千克" };
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
export function moneyMinor(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("单价必须是不小于 0、最多两位小数的金额。");
  const [whole, fraction = ""] = value.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("金额超出可保存范围。");
  return minor;
}
