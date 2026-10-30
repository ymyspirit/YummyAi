import type { SpecificationView } from "@yummyai/contracts/catalog/development";

const naturalOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const weightDisplay = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
  useGrouping: false,
});

/** Display order only. Keep the original objects, version identities and input array intact. */
export function orderedSpecifications<T extends Pick<SpecificationView, "id" | "name" | "code">>(
  specifications: readonly T[],
): T[] {
  return [...specifications].sort((left, right) =>
    naturalOrder.compare(left.name, right.name)
    || naturalOrder.compare(left.code, right.code)
    || left.id.localeCompare(right.id),
  );
}

/** Compact display only; the detail view retains the exact saved gram value. */
export function formatSpecificationWeight(grams: number | null | undefined): string {
  if (grams == null || !Number.isFinite(grams) || grams <= 0) return "待确认";
  if (grams < 0.01) return "<0.01 g";
  return `${weightDisplay.format(grams)} g`;
}
