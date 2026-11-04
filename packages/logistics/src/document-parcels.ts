import type { ParcelSpecification } from "@yummyai/contracts/logistics/documents";

export const PARCEL_PACKING_RULE = "fixed-length-balanced-cross-section-v1";
const round = (value: number) => Math.round(value * 1e9) / 1e9;
export const ceilThree = (value: number) => Math.ceil(round(value * 1000)) / 1000;
export function unitWeight(spec: Pick<ParcelSpecification, "weight" | "weightUnit">, target: "lb" | "kg") {
  const kg = spec.weight * ({ kg: 1, lb: 0.45359237, g: 0.001 }[spec.weightUnit]);
  return ceilThree(target === "kg" ? kg : kg / 0.45359237);
}
export function inches(value: number | null, unit: ParcelSpecification["dimensionUnit"]) {
  return value === null ? null : round(value / ({ in: 1, cm: 2.54, mm: 25.4 }[unit]));
}

/** Conservative cells preserve the longest unit length, including mixed sizes. */
export function balancedParcel(units: Array<{ length: number | null; width: number | null; height: number | null; quantity: number }>) {
  const missing = { lengthIn: null, widthIn: null, heightIn: null, columns: null, rows: null };
  if (!units.length || units.some(unit => [unit.length, unit.width, unit.height].some(value => value === null))) return missing;
  if (units.some(unit => !Number.isSafeInteger(unit.quantity) || unit.quantity <= 0 ||
    [unit.length, unit.width, unit.height].some(value => !Number.isFinite(value) || value! <= 0))) throw Error("包裹参数或件数无效");
  const quantity = units.reduce((sum, unit) => sum + unit.quantity, 0);
  if (quantity > 10000) throw Error("单个包裹超过 10000 件 请拆分核对");
  const length = Math.max(...units.map(unit => unit.length!));
  const width = Math.max(...units.map(unit => unit.width!));
  const height = Math.max(...units.map(unit => unit.height!));
  let best: { score: number[]; widthIn: number; heightIn: number; columns: number; rows: number } | null = null;
  for (let columns = 1; columns <= quantity; columns++) {
    const rows = Math.ceil(quantity / columns), w = round(width * columns), h = round(height * rows);
    const score = [Math.max(w, h), round(w + h), columns * rows - quantity, w >= h ? 0 : 1];
    if (!best || less(score, best.score)) best = { score, widthIn: w, heightIn: h, columns, rows };
  }
  return { lengthIn: length, widthIn: best!.widthIn, heightIn: best!.heightIn, columns: best!.columns, rows: best!.rows };
}
function less(a: number[], b: number[]) {
  for (let index = 0; index < a.length; index++) { if (a[index] !== b[index]) return a[index]! < b[index]!; }
  return false;
}
export function parcelCarrierChecks(length: number | null, width: number | null, height: number | null) {
  if ([length, width, height].some(value => value === null || !Number.isFinite(value) || value! <= 0))
    return { gofo: false, usps: false, blockers: ["包裹长宽高尚未补齐"] };
  const longest = Math.max(length!, width!, height!), sum = round(length! + width! + height!);
  const gofo = longest <= 24 && sum <= 60, usps = longest <= 22;
  return { gofo, usps, blockers: [
    ...(!gofo ? ["GOFO 尺寸超限 单边须不超过 24 in 且三边和不超过 60 in"] : []),
    ...(!usps ? ["USPS 尺寸超限 最长边须不超过 22 in"] : []),
  ] };
}
