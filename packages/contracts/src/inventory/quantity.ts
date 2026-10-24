/** Exact stock amounts. Decimal quantities travel as strings, never binary floats. */
export type StockQuantity = number | string;

export const STOCK_QUANTITY_SCALE = 9;
const atomsPerUnit = 1_000_000_000n;
const maximumCommandAtoms = 2_147_483_647n * atomsPerUnit;
const decimal = /^-?\d{1,30}(?:\.\d{1,9})?$/;

export function stockQuantityAtoms(value: StockQuantity): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError("Fractional stock quantities must use decimal strings");
  }
  const text = String(value);
  if (!decimal.test(text)) throw new RangeError("Stock quantity requires at most nine decimal places");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const atoms = BigInt(whole!) * atomsPerUnit + BigInt(fraction.padEnd(STOCK_QUANTITY_SCALE, "0"));
  return negative ? -atoms : atoms;
}

function atomString(atoms: bigint): string {
  const absolute = atoms < 0n ? -atoms : atoms;
  const whole = absolute / atomsPerUnit;
  const fraction = String(absolute % atomsPerUnit).padStart(STOCK_QUANTITY_SCALE, "0").replace(/0+$/, "");
  return `${atoms < 0n ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}

function atomValue(atoms: bigint): StockQuantity {
  const whole = atoms / atomsPerUnit;
  if (String(whole < 0n ? -whole : whole).length > 30) throw new RangeError("Stock quantity exceeds the supported range");
  if (atoms % atomsPerUnit === 0n && whole >= BigInt(Number.MIN_SAFE_INTEGER) && whole <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(whole);
  }
  return atomString(atoms);
}

/** Keeps historical whole-number JSON values and canonicalizes decimal strings. */
export function stockQuantityValue(value: StockQuantity): StockQuantity {
  return atomValue(stockQuantityAtoms(value));
}

export function stockQuantityString(value: StockQuantity): string {
  return atomString(stockQuantityAtoms(value));
}

export function formatStockQuantity(value: StockQuantity, locale = "zh-CN"): string {
  const text = stockQuantityString(value);
  const negative = text.startsWith("-");
  const [whole, fraction] = (negative ? text.slice(1) : text).split(".");
  return `${negative ? "-" : ""}${BigInt(whole!).toLocaleString(locale)}${fraction ? "." + fraction : ""}`;
}

export function addStockQuantity(left: StockQuantity, right: StockQuantity): StockQuantity {
  return atomValue(stockQuantityAtoms(left) + stockQuantityAtoms(right));
}

export function subtractStockQuantity(left: StockQuantity, right: StockQuantity): StockQuantity {
  return atomValue(stockQuantityAtoms(left) - stockQuantityAtoms(right));
}

export function negateStockQuantity(value: StockQuantity): StockQuantity {
  return atomValue(-stockQuantityAtoms(value));
}

export function sumStockQuantities(values: Iterable<StockQuantity>): StockQuantity {
  let sum = 0n;
  for (const value of values) sum += stockQuantityAtoms(value);
  return atomValue(sum);
}

export function compareStockQuantity(left: StockQuantity, right: StockQuantity): -1 | 0 | 1 {
  const difference = stockQuantityAtoms(left) - stockQuantityAtoms(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function wholeStockQuantity(value: StockQuantity): boolean {
  return stockQuantityAtoms(value) % atomsPerUnit === 0n;
}

export function stockQuantityMatchesUnit(value: StockQuantity, unit: string): boolean {
  return !["each", "pair", "set"].includes(unit) || wholeStockQuantity(value);
}

export function stockQuantityWithinCommandLimit(value: StockQuantity): boolean {
  const amount = stockQuantityAtoms(value);
  return amount >= -maximumCommandAtoms && amount <= maximumCommandAtoms;
}

/** Exact BOM ratio conversion. Non-terminating or over-precise values are refused. */
export function stockQuantityFromRatio(numerator: bigint, denominator: bigint): StockQuantity {
  if (denominator === 0n || numerator * atomsPerUnit % denominator !== 0n) {
    throw new RangeError("The stock ratio cannot be represented exactly at the supported precision");
  }
  return atomValue(numerator * atomsPerUnit / denominator);
}

/** Explicit whole purchase-unit coverage; never use this to round consumption. */
export function ceilStockQuantity(value: StockQuantity): StockQuantity {
  const atoms = stockQuantityAtoms(value);
  const whole = atoms / atomsPerUnit + (atoms > 0n && atoms % atomsPerUnit !== 0n ? 1n : 0n);
  return atomValue(whole * atomsPerUnit);
}
