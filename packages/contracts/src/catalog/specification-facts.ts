import { z } from "zod";

export const SpecificationDimensionBases = {
  finished_outer_2d: "成品外轮廓 平面尺寸",
  finished_outer_3d: "成品外轮廓 长宽高",
  artwork_longest: "图案主体最长边",
  flat_piece: "裁片平铺尺寸",
  diameter: "成品直径",
} as const;
const unit = z.enum(["mm", "cm", "in"]);
const measure = z.number().positive().max(1000000).nullable();
const measurements = z.object({
  unit: unit.nullable(), length: measure, width: measure, height: measure,
}).strict();
export const SpecificationFactsSchema = z.object({
  formatVersion: z.literal(2).optional(),
  material: z.string().trim().max(300),
  dimensions: z.string().trim().max(300),
  physicalDimensions: measurements.extend({
    basis: z.enum(Object.keys(SpecificationDimensionBases) as [keyof typeof SpecificationDimensionBases, ...Array<keyof typeof SpecificationDimensionBases>]).nullable(),
  }).strict().nullable().optional(),
  structure: z.string().trim().max(1000).optional(),
  packageContents: z.string().trim().max(1000),
  packageQuantity: z.int().positive().max(10000).nullable(),
  factsConfirmed: z.boolean(),
  weightGrams: z.number().positive().max(1000000).nullable().optional(),
  packagedWeightGrams: z.number().positive().max(1000000).nullable().optional(),
  packageDimensions: z.string().trim().max(300).optional(),
  packageMeasurements: measurements.nullable().optional(),
  verificationReference: z.string().trim().max(1000).optional(),
}).strict();
export type SpecificationFacts = z.infer<typeof SpecificationFactsSchema>;

export function specificationFactProblems(facts: SpecificationFacts): string[] {
  if (!SpecificationFactsSchema.safeParse(facts).success) return ["规格事实格式或测量数值无效"];
  if (facts.formatVersion !== 2)
    return ["旧规格缺少明确的尺寸口径与核验依据 请保存新的事实确认版本"];
  const problems: string[] = [];
  if (!facts.factsConfirmed) problems.push("商品事实尚未确认");
  if (!facts.material.trim()) problems.push("材质尚未确认");
  if (!facts.structure?.trim()) problems.push("产品结构尚未确认");
  const size = facts.physicalDimensions;
  if (!size?.basis || !size.unit || !size.length ||
    (["finished_outer_2d", "finished_outer_3d", "flat_piece"].includes(size.basis) && !size.width) ||
    (size.basis === "finished_outer_3d" && !size.height))
    problems.push("实际尺寸的口径 单位和必要测量值尚未确认");
  else if ((["artwork_longest", "diameter"].includes(size.basis) && (size.width !== null || size.height !== null)) ||
    (["finished_outer_2d", "flat_piece"].includes(size.basis) && size.height !== null))
    problems.push("测量值与所选尺寸口径不一致");
  if (!facts.packageContents.trim() || facts.packageQuantity === null)
    problems.push("包装内容与每份件数尚未确认");
  if (!facts.weightGrams || !facts.packagedWeightGrams) problems.push("商品重量与含包装重量尚未确认");
  else if (facts.packagedWeightGrams < facts.weightGrams) problems.push("含包装重量不能小于商品重量");
  const pack = facts.packageMeasurements;
  if (!pack?.unit || !pack.length || !pack.width || !pack.height)
    problems.push("包装外尺寸的长宽高和单位尚未确认");
  if (!facts.verificationReference?.trim()) problems.push("请填写实际核验凭证或测量记录依据");
  return problems;
}

export const specificationFactsReady = (facts: SpecificationFacts): boolean =>
  specificationFactProblems(facts).length === 0;

function measurementText(size: z.infer<typeof measurements>): string {
  if (!size.unit || size.length === null) return "";
  return `${[size.length, size.width, size.height].filter(value => value !== null).join(" × ")} ${size.unit}`;
}
/** Only a new V2 write formats its measured values; legacy snapshots stay byte-for-byte intact. */
export function normalizeSpecificationFactDisplay(facts: SpecificationFacts): SpecificationFacts {
  if (facts.formatVersion !== 2) return facts;
  const size = facts.physicalDimensions;
  return {
    ...facts,
    dimensions: size?.basis && measurementText(size)
      ? `${measurementText(size)} · ${SpecificationDimensionBases[size.basis]}` : facts.dimensions,
    packageDimensions: facts.packageMeasurements && measurementText(facts.packageMeasurements)
      ? measurementText(facts.packageMeasurements) : facts.packageDimensions,
  };
}
