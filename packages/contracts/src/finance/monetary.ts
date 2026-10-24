import { z } from "zod";
import { FINANCE_CURRENCY_MINOR_DIGITS, FINANCE_CURRENCY_TABLE_VERSION } from "@yummyai/contracts/finance/currency-snapshot";

export { FINANCE_CURRENCY_TABLE_VERSION } from "@yummyai/contracts/finance/currency-snapshot";
export const FinanceCurrencySchema = z.string().regex(/^[A-Z]{3}$/);
const DigitsSchema = z.number().int().min(0).max(4);

export const FinanceFxMonetaryBasisSchema = z.object({
  schemaVersion: z.literal(1), rateUnit: z.literal("major_to_major"),
  baseMinorDigits: DigitsSchema, quoteMinorDigits: DigitsSchema,
  currencyTableVersion: z.literal(FINANCE_CURRENCY_TABLE_VERSION),
}).strict();
export const FinanceCalculationMonetaryBasisSchema = z.object({
  schemaVersion: z.literal(2), algorithm: z.literal("iso_minor_fx_v2"),
  rounding: z.literal("half_away_from_zero_per_fact"), currencyTableVersion: z.literal(FINANCE_CURRENCY_TABLE_VERSION),
  currencies: z.array(z.object({ currency: FinanceCurrencySchema, minorDigits: DigitsSchema.nullable() }).strict()).min(1).max(501),
}).strict().superRefine((basis, context) => {
  const codes = basis.currencies.map(item => item.currency);
  if (new Set(codes).size !== codes.length || [...codes].sort().some((code, index) => code !== codes[index]))
    context.addIssue({ code: "custom", path: ["currencies"], message: "Pinned currencies must be unique and sorted" });
  for (const [index, item] of basis.currencies.entries()) if (item.minorDigits !== financeCurrencyMinorDigits(item.currency))
    context.addIssue({ code: "custom", path: ["currencies", index, "minorDigits"], message: "Currency precision does not match the pinned ISO snapshot" });
});
export const FinanceMonetaryDiagnosticSchema = z.object({
  unknownCurrencies: z.array(FinanceCurrencySchema),
  ambiguousFxRateIds: z.array(z.uuidv7()),
}).strict();
export type FinanceFxMonetaryBasis = z.infer<typeof FinanceFxMonetaryBasisSchema>;
export type FinanceCalculationMonetaryBasis = z.infer<typeof FinanceCalculationMonetaryBasisSchema>;
export type FinanceMonetaryDiagnostic = z.infer<typeof FinanceMonetaryDiagnosticSchema>;

export function financeCurrencyMinorDigits(currency: string): number | null {
  return Object.hasOwn(FINANCE_CURRENCY_MINOR_DIGITS, currency) ? FINANCE_CURRENCY_MINOR_DIGITS[currency] ?? null : null;
}
export function pinFinanceFxBasis(baseCurrency: string, quoteCurrency: string): FinanceFxMonetaryBasis {
  const baseMinorDigits = financeCurrencyMinorDigits(baseCurrency), quoteMinorDigits = financeCurrencyMinorDigits(quoteCurrency);
  if (baseMinorDigits === null || quoteMinorDigits === null) throw new RangeError("finance_currency_precision_unknown");
  return { schemaVersion: 1, rateUnit: "major_to_major", baseMinorDigits, quoteMinorDigits, currencyTableVersion: FINANCE_CURRENCY_TABLE_VERSION };
}
export function buildFinanceCalculationBasis(currencies: string[]): FinanceCalculationMonetaryBasis {
  return FinanceCalculationMonetaryBasisSchema.parse({ schemaVersion: 2, algorithm: "iso_minor_fx_v2", rounding: "half_away_from_zero_per_fact",
    currencyTableVersion: FINANCE_CURRENCY_TABLE_VERSION,
    currencies: [...new Set(currencies)].sort().map(currency => ({ currency, minorDigits: financeCurrencyMinorDigits(currency) })),
  });
}

export function convertFinanceMinorAmount(input: {
  amountMinor: number; sourceCurrency: string; targetCurrency: string;
  rateNumerator?: number; rateDenominator?: number; rateBasis: FinanceFxMonetaryBasis | null;
  calculationBasis: FinanceCalculationMonetaryBasis;
}): { amountMinor: number | null; problem: "currency_precision_unknown" | "fx_rate_unit_unknown" | null } {
  if (!Number.isSafeInteger(input.amountMinor)) throw new RangeError("finance_money_overflow");
  const basis = FinanceCalculationMonetaryBasisSchema.parse(input.calculationBasis);
  const sourceDigits = basis.currencies.find(item => item.currency === input.sourceCurrency)?.minorDigits;
  const targetDigits = basis.currencies.find(item => item.currency === input.targetCurrency)?.minorDigits;
  if (sourceDigits == null || targetDigits == null) return { amountMinor: null, problem: "currency_precision_unknown" };
  if (input.sourceCurrency === input.targetCurrency) return { amountMinor: input.amountMinor, problem: null };
  if (input.rateNumerator === undefined || input.rateDenominator === undefined) return { amountMinor: null, problem: null };
  if (!Number.isSafeInteger(input.rateNumerator) || input.rateNumerator <= 0 || !Number.isSafeInteger(input.rateDenominator) || input.rateDenominator <= 0)
    throw new RangeError("finance_fx_ratio_invalid");
  if (input.rateBasis) {
    const pinned = FinanceFxMonetaryBasisSchema.safeParse(input.rateBasis);
    if (!pinned.success || pinned.data.baseMinorDigits !== sourceDigits || pinned.data.quoteMinorDigits !== targetDigits)
      return { amountMinor: null, problem: "fx_rate_unit_unknown" };
  } else if (sourceDigits !== targetDigits) return { amountMinor: null, problem: "fx_rate_unit_unknown" };
  const amount = BigInt(input.amountMinor), negative = amount < 0n;
  const numerator = (negative ? -amount : amount) * BigInt(input.rateNumerator) * 10n ** BigInt(targetDigits);
  const denominator = BigInt(input.rateDenominator) * 10n ** BigInt(sourceDigits);
  const rounded = numerator / denominator + (numerator % denominator * 2n >= denominator ? 1n : 0n);
  const signed = negative ? -rounded : rounded;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError("finance_money_overflow");
  return { amountMinor: Number(signed), problem: null };
}

export function formatFinanceMinorAmount(value: number, currency: string): string {
  if (!Number.isSafeInteger(value)) throw new RangeError("finance_money_overflow");
  const digits = financeCurrencyMinorDigits(currency), amount = BigInt(value);
  if (digits === null) return `${currency} ${amount} 最小单位（精度待核对）`;
  const absolute = amount < 0n ? -amount : amount, scale = 10n ** BigInt(digits);
  return `${currency} ${amount < 0n ? "-" : ""}${absolute / scale}${digits ? "." + String(absolute % scale).padStart(digits, "0") : ""}`;
}

/** Historical amounts are preserved; a legacy conversion is only numerically unambiguous when both precisions agree. */
export function hasFinanceMonetaryEvidence(run: {
  reportingCurrency?: string;
  monetaryBasis?: FinanceCalculationMonetaryBasis | null;
  contributions?: Array<{ sourceCurrency: string; reportingCurrency: string }>;
}): boolean {
  if (!run.reportingCurrency || !run.contributions?.length) return false;
  const reportingDigits = financeCurrencyMinorDigits(run.reportingCurrency);
  if (reportingDigits === null) return false;
  if (run.monetaryBasis) {
    const basis = FinanceCalculationMonetaryBasisSchema.safeParse(run.monetaryBasis);
    if (!basis.success || basis.data.currencies.some(item => item.minorDigits === null)) return false;
    const codes = new Set(basis.data.currencies.map(item => item.currency));
    return codes.has(run.reportingCurrency) && run.contributions.every(item => item.reportingCurrency === run.reportingCurrency && codes.has(item.sourceCurrency));
  }
  return run.contributions.every(item => item.reportingCurrency === run.reportingCurrency && financeCurrencyMinorDigits(item.sourceCurrency) === reportingDigits);
}
