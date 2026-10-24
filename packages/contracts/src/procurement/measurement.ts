import { z } from "zod";
import { PositiveStockQuantitySchema } from "@yummyai/contracts/inventory/quantity-schema";
import { stockQuantityAtoms, stockQuantityFromRatio, stockQuantityMatchesUnit, stockQuantityValue,
  stockQuantityWithinCommandLimit, type StockQuantity } from "@yummyai/contracts/inventory/quantity";

export const ProcurementUnitSchema = z.enum(["each", "pair", "set", "meter", "gram", "kilogram"]);
export type ProcurementUnit = z.infer<typeof ProcurementUnitSchema>;

/** Versioned physical conversions. A pair/set/roll is never guessed to mean pieces. */
export function procurementUnitRatio(from: ProcurementUnit, to: ProcurementUnit) {
  if (from === to) return { numerator: 1n, denominator: 1n };
  if (from === "kilogram" && to === "gram") return { numerator: 1000n, denominator: 1n };
  if (from === "gram" && to === "kilogram") return { numerator: 1n, denominator: 1000n };
  throw new RangeError("procurement_unit_conversion_unavailable");
}

export function convertProcurementQuantity(quantity: StockQuantity, from: ProcurementUnit, to: ProcurementUnit): StockQuantity {
  if (!stockQuantityWithinCommandLimit(quantity) || !stockQuantityMatchesUnit(quantity, from)) throw new RangeError("procurement_quantity_invalid");
  const { numerator, denominator } = procurementUnitRatio(from, to);
  const result = stockQuantityFromRatio(stockQuantityAtoms(quantity) * numerator, denominator * 1_000_000_000n);
  if (!stockQuantityWithinCommandLimit(result) || !stockQuantityMatchesUnit(result, to)) throw new RangeError("procurement_converted_quantity_invalid");
  return result;
}

/** Price is an integer minor amount for an explicit quantity in the purchase UoM. */
export function procurementAmountMinor(quantity: StockQuantity, unitCostMinor: number, priceBasisQuantity: StockQuantity = 1): number {
  if (!Number.isSafeInteger(unitCostMinor) || unitCostMinor < 0) throw new RangeError("procurement_money_invalid");
  const numerator = stockQuantityAtoms(quantity) * BigInt(unitCostMinor), denominator = stockQuantityAtoms(priceBasisQuantity);
  if (numerator < 0n || denominator <= 0n) throw new RangeError("procurement_price_basis_invalid");
  if (numerator % denominator !== 0n) throw new RangeError("procurement_amount_precision_unavailable");
  return safeMinorValue(numerator / denominator);
}
export function safeMinorValue(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError("procurement_money_out_of_range");
  return Number(value);
}
export function sumProcurementMinor(values: Iterable<number>): number {
  let total = 0n;
  for (const value of values) { if (!Number.isSafeInteger(value)) throw new RangeError("procurement_money_invalid"); total += BigInt(value); }
  return safeMinorValue(total);
}
export function subtractProcurementMinor(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new RangeError("procurement_money_invalid");
  return safeMinorValue(BigInt(left) - BigInt(right));
}
export function equivalentProcurementPrice(leftMinor: number, leftBasis: StockQuantity, rightMinor: number, rightBasis: StockQuantity): boolean {
  return BigInt(leftMinor) * stockQuantityAtoms(rightBasis) === BigInt(rightMinor) * stockQuantityAtoms(leftBasis);
}

export const ProcurementStockBasisSchema = z.object({
  version: z.literal(1), rule: z.literal("metric-unit-v1"), stockUnit: ProcurementUnitSchema,
  stockQuantity: PositiveStockQuantitySchema,
  conversionNumerator: z.string().regex(/^[1-9]\d*$/).max(20), conversionDenominator: z.string().regex(/^[1-9]\d*$/).max(20),
  priceBasisStockQuantity: PositiveStockQuantitySchema,
}).strict();
export type ProcurementStockBasis = z.infer<typeof ProcurementStockBasisSchema>;
export function pinProcurementStockBasis<T extends { quantity: StockQuantity; unit: ProcurementUnit; priceBasisQuantity?: StockQuantity }>(line: T, stockUnit: ProcurementUnit): T & { stockBasis: ProcurementStockBasis } {
  const ratio = procurementUnitRatio(line.unit, stockUnit);
  return { ...line, quantity: stockQuantityValue(line.quantity), stockBasis: {
    version: 1, rule: "metric-unit-v1", stockUnit, stockQuantity: convertProcurementQuantity(line.quantity, line.unit, stockUnit),
    conversionNumerator: ratio.numerator.toString(), conversionDenominator: ratio.denominator.toString(),
    priceBasisStockQuantity: convertProcurementQuantity(line.priceBasisQuantity ?? 1, line.unit, stockUnit),
  } };
}

/** Decimal inputs are parsed before canonical request hashing; old integers stay numbers. */
export function assertProcurementQuantityUnit(quantity: StockQuantity, unit: ProcurementUnit) {
  if (!stockQuantityMatchesUnit(quantity, unit)) throw new RangeError("procurement_discrete_quantity_invalid");
}
