import {
  MAX_SPECIFICATION_COMBINATIONS,
  specificationAttributesKey,
  type SpecificationView,
} from "@yummyai/contracts/catalog/development";

export type SpecificationAxis = { id: string; name: string; values: string[] };

export function splitSpecificationValues(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，;；\n]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export function boundSpecificationAxes(
  specifications: Pick<SpecificationView, "code" | "attributes">[],
): SpecificationAxis[] {
  const axes = new Map<string, Set<string>>();
  for (const specification of [...specifications].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true }),
  ))
    for (const [name, value] of Object.entries(specification.attributes)) {
      if (!axes.has(name)) axes.set(name, new Set());
      axes.get(name)!.add(value);
    }
  return Array.from(axes, ([name, values], index) => ({
    id: `axis-${index}`,
    name,
    values: [...values],
  }));
}

export function expandSpecificationOptions(axes: SpecificationAxis[]): Record<string, string>[] {
  if (!axes.length || axes.length > 4) throw new Error("请设置 1–4 个规格维度");
  const normalized = axes.map((axis) => ({
    name: axis.name.trim(),
    values: [...new Set(axis.values.map((value) => value.trim()).filter(Boolean))],
  }));
  if (normalized.some((axis) => !axis.name || axis.name.length > 80 || !axis.values.length))
    throw new Error("每个规格维度都需要名称和至少一个选项");
  if (new Set(normalized.map((axis) => axis.name)).size !== normalized.length)
    throw new Error("规格维度名称不可重复");
  if (normalized.some((axis) => axis.values.some((value) => value.length > 200)))
    throw new Error("单个规格选项最多 200 个字符");
  const count = normalized.reduce((total, axis) => total * axis.values.length, 1);
  if (count > MAX_SPECIFICATION_COMBINATIONS)
    throw new Error(
      `当前会生成 ${count} 个组合，每次最多预览 ${MAX_SPECIFICATION_COMBINATIONS} 个，请减少选项后分批添加`,
    );
  return normalized.reduce<Record<string, string>[]>(
    (combinations, axis) =>
      combinations.flatMap((attributes) =>
        axis.values.map((value) => ({ ...attributes, [axis.name]: value })),
      ),
    [{}],
  );
}

export function nextSpecificationCode(used: Set<string>): string {
  let index = 1;
  while (used.has(`spec-${String(index).padStart(3, "0")}`)) index++;
  const code = `SPEC-${String(index).padStart(3, "0")}`;
  used.add(code.toLowerCase());
  return code;
}

export const optionSelectionKey = (axes: SpecificationAxis[]) =>
  JSON.stringify(axes.map((axis) => ({ name: axis.name, values: axis.values })));
export { specificationAttributesKey };
