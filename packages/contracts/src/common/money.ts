/** Integer minor amounts remain exact when a currency has zero, two or three digits. */
const currencies = new Set(Intl.supportedValuesOf("currency"));
export function currencyMinorDigits(currency: string): number | null {
  if (!currencies.has(currency)) return null;
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
}
export function parseMinorAmount(value: string, currency: string): number {
  const digits = currencyMinorDigits(currency);
  if (digits === null) throw new RangeError("currency_precision_unknown");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > digits) throw new RangeError("money_decimal_precision_invalid");
  const amount = BigInt(match[1]!) * 10n ** BigInt(digits) + BigInt((match[2] ?? "").padEnd(digits, "0") || "0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("money_out_of_range");
  return Number(amount);
}
export function formatMinorAmount(value: number, currency: string): string {
  if (!Number.isSafeInteger(value)) throw new RangeError("money_out_of_range");
  const digits = currencyMinorDigits(currency);
  if (digits === null) return `${value} 最小单位`;
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount, scale = 10n ** BigInt(digits);
  return `${amount < 0n ? "-" : ""}${absolute / scale}${digits ? "." + String(absolute % scale).padStart(digits, "0") : ""}`;
}
