import { z } from "zod";
import { InventoryUnitSchema } from "@yummyai/contracts/inventory";

const Id = z.uuidv7();
const Key = z.string().trim().min(8).max(200);
const Code = z.string().trim().min(1).max(64);
const Notes = z.string().trim().max(2000).default("");
const Positive = z.int().positive().max(1_000_000_000);
export const ManufacturingResponsibilitySchema = z.enum(["unknown", "merchant", "factory"]);
export const ManufacturingMaterialSchema = z.object({
  code: Code, name: z.string().trim().min(1).max(200), stockItemId: Id.nullable(),
  quantityNumerator: Positive.nullable(), quantityDenominator: Positive.nullable(),
  unit: InventoryUnitSchema.nullable(), lossBps: z.int().min(0).max(100000).nullable(),
  lossBasis: z.enum(["add_to_net", "fraction_of_input"]).nullable(),
  responsibility: ManufacturingResponsibilitySchema,
  operationCode: Code.nullable(), notes: Notes,
}).strict().refine(value => value.lossBasis !== "fraction_of_input" || value.lossBps === null || value.lossBps < 10000,
  { path: ["lossBps"], message: "以投入量为分母时损耗必须低于100%" });
export const ManufacturingOperationSchema = z.object({
  code: Code, name: z.string().trim().min(1).max(200), processCode: Code,
  responsibility: ManufacturingResponsibilitySchema,
  expectedSecondsPerOutput: Positive.nullable(), notes: Notes,
}).strict();
export const ManufacturingRecipeContentSchema = z.object({
  specificationVersionId: Id, name: z.string().trim().min(1).max(200),
  outputQuantity: Positive.max(1_000_000), outputUnit: z.enum(["each", "pair", "set"]),
  materials: z.array(ManufacturingMaterialSchema).max(200),
  operations: z.array(ManufacturingOperationSchema).max(200), notes: Notes,
}).strict().superRefine((value, ctx) => {
  for (const kind of ["materials", "operations"] as const) {
    const seen = new Set<string>();
    value[kind].forEach((row, index) => {
      if (seen.has(row.code)) ctx.addIssue({ code: "custom", path: [kind, index, "code"], message: "行编号不能重复" });
      seen.add(row.code);
    });
  }
  const operations = new Set(value.operations.map(row => row.code));
  value.materials.forEach((row, index) => {
    if (row.operationCode && !operations.has(row.operationCode)) ctx.addIssue({ code: "custom", path: ["materials", index, "operationCode"], message: "材料引用的工序不存在" });
  });
});
export type ManufacturingRecipeContent = z.infer<typeof ManufacturingRecipeContentSchema>;
export const CreateManufacturingRecipeSchema = z.object({
  spuId: Id, specificationId: Id, code: Code, content: ManufacturingRecipeContentSchema, idempotencyKey: Key,
}).strict();
export const ReviseManufacturingRecipeSchema = z.object({
  expectedVersion: z.int().positive(), content: ManufacturingRecipeContentSchema, idempotencyKey: Key,
}).strict();
export const ReviewManufacturingRecipeSchema = z.object({
  expectedVersion: z.int().positive(), versionId: Id, decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().min(1).max(2000), idempotencyKey: Key,
}).strict();
export const ManufacturingDemandSchema = z.object({ versionId: Id, outputQuantity: Positive.max(1_000_000) }).strict();

export function manufacturingApprovalProblems(content: ManufacturingRecipeContent): string[] {
  const problems: string[] = [];
  if (!content.materials.length) problems.push("尚未填写材料");
  if (!content.operations.length) problems.push("尚未填写制造工序");
  for (const row of content.materials) {
    if (!row.stockItemId || row.quantityNumerator === null || row.quantityDenominator === null || row.unit === null)
      problems.push(`${row.code} 的物料、耗量或单位尚未确认`);
    if (row.lossBps === null || row.lossBasis === null) problems.push(`${row.code} 的损耗和计算口径尚未确认`);
    if (row.responsibility === "unknown") problems.push(`${row.code} 的供料责任尚未确认`);
  }
  for (const row of content.operations) if (row.responsibility === "unknown") problems.push(`${row.code} 的工序责任尚未确认`);
  return problems;
}
const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
/** A proposal only: exact quantities never post inventory or imply actual consumption. */
export function calculateManufacturingDemand(content: ManufacturingRecipeContent, outputQuantity: number) {
  content = ManufacturingRecipeContentSchema.parse(content);
  const problems = manufacturingApprovalProblems(content);
  if (problems.length) throw new Error(problems.join("；"));
  Positive.max(1_000_000).parse(outputQuantity);
  const lines = content.materials.map(row => {
    let numerator = BigInt(row.quantityNumerator!) * BigInt(outputQuantity);
    let denominator = BigInt(row.quantityDenominator!) * BigInt(content.outputQuantity);
    if (row.lossBasis === "add_to_net") { numerator *= 10000n + BigInt(row.lossBps!); denominator *= 10000n; }
    else { numerator *= 10000n; denominator *= 10000n - BigInt(row.lossBps!); }
    const divisor = gcd(numerator, denominator); numerator /= divisor; denominator /= divisor;
    return { code: row.code, name: row.name, stockItemId: row.stockItemId!, unit: row.unit!, responsibility: row.responsibility,
      exactNumerator: numerator.toString(), exactDenominator: denominator.toString(),
      wholeBaseUnitCeiling: ((numerator + denominator - 1n) / denominator).toString() };
  });
  const grouped = new Map<string, { stockItemId: string; unit: typeof lines[number]["unit"]; responsibility: typeof lines[number]["responsibility"]; numerator: bigint; denominator: bigint }>();
  for (const line of lines) {
    const key = JSON.stringify([line.stockItemId, line.unit, line.responsibility]);
    const previous = grouped.get(key), numerator = BigInt(line.exactNumerator), denominator = BigInt(line.exactDenominator);
    const sumNumerator = previous ? previous.numerator * denominator + numerator * previous.denominator : numerator;
    const sumDenominator = previous ? previous.denominator * denominator : denominator;
    const divisor = gcd(sumNumerator, sumDenominator);
    grouped.set(key, { stockItemId: line.stockItemId, unit: line.unit, responsibility: line.responsibility,
      numerator: sumNumerator / divisor, denominator: sumDenominator / divisor });
  }
  const totals = [...grouped.values()].map(row => ({ stockItemId: row.stockItemId, unit: row.unit, responsibility: row.responsibility,
    exactNumerator: row.numerator.toString(), exactDenominator: row.denominator.toString(),
    wholeBaseUnitCeiling: ((row.numerator + row.denominator - 1n) / row.denominator).toString() }));
  return { outputQuantity, outputUnit: content.outputUnit, proposalOnly: true as const, lines, totals };
}
export type ManufacturingRecipeVersionView = {
  recipeId: string; versionId: string; versionNumber: number; spuId: string; specificationId: string; code: string;
  content: ManufacturingRecipeContent; createdAt: string; specificationVersionNumber?: number;
  review: { decision: "approved" | "rejected"; note: string; reviewedAt: string } | null;
};
export type ManufacturingRecipeWorkspace = {
  recipeId: string; spuId: string; specificationId: string; code: string; archived: boolean;
  currentVersion: ManufacturingRecipeVersionView; releasedVersion: ManufacturingRecipeVersionView | null;
  approvalProblems: string[]; releaseProblems: string[];
};
export const ManufacturingRecipeVersionViewSchema = z.object({
  recipeId: Id, versionId: Id, versionNumber: z.int().positive(), spuId: Id, specificationId: Id, code: Code,
  content: ManufacturingRecipeContentSchema, createdAt: z.iso.datetime(), specificationVersionNumber: z.int().positive().optional(),
  review: z.object({ decision: z.enum(["approved", "rejected"]), note: z.string(), reviewedAt: z.iso.datetime() }).strict().nullable(),
}).strict();
export const ManufacturingRecipeWorkspaceSchema = z.object({
  recipeId: Id, spuId: Id, specificationId: Id, code: Code, archived: z.boolean(),
  currentVersion: ManufacturingRecipeVersionViewSchema, releasedVersion: ManufacturingRecipeVersionViewSchema.nullable(),
  approvalProblems: z.array(z.string()), releaseProblems: z.array(z.string()),
}).strict();
export const ManufacturingRecipeListSchema = z.object({
  items: z.array(z.object({ id: Id, code: Code, specificationId: Id, versionNumber: z.int().positive() }).strict()), nextCursor: Id.nullable(),
}).strict();
export const ManufacturingVersionListSchema = z.object({ items: z.array(z.object({ id: Id, versionNumber: z.int().positive(), name: z.string(),
  createdAt: z.iso.datetime(), decision: z.enum(["approved", "rejected"]).nullable() }).strict()), nextVersion: z.int().positive().nullable() }).strict();
export const ManufacturingReferencesSchema = z.object({
  spu: z.object({ id: Id, code: z.string(), name: z.string(), ownerId: Id.nullable(), teamId: Id.nullable(), active: z.boolean() }).strict(),
  sourceProblems: z.array(z.string()), canReadMaterials: z.boolean(),
  specifications: z.array(z.object({ id: Id, code: z.string(), name: z.string(), versionId: Id, versionNumber: z.int().positive(), factsReady: z.boolean() }).strict()),
}).strict();
export const ManufacturingMaterialOptionSchema = z.object({ id: Id, code: z.string(), name: z.string(), baseUnit: InventoryUnitSchema, status: z.enum(["active", "inactive"]) }).strict();
export const ManufacturingMaterialOptionsSchema = z.object({ items: z.array(ManufacturingMaterialOptionSchema), selected: z.array(ManufacturingMaterialOptionSchema),
  missingSelected: z.array(Id), nextCursor: Id.nullable() }).strict();
const DemandLine = z.object({ stockItemId: Id, unit: InventoryUnitSchema, responsibility: ManufacturingResponsibilitySchema,
  exactNumerator: z.string().regex(/^\d+$/), exactDenominator: z.string().regex(/^[1-9]\d*$/), wholeBaseUnitCeiling: z.string().regex(/^\d+$/) }).strict();
export const ManufacturingDemandResultSchema = z.object({ recipeId: Id, versionId: Id, specificationVersionId: Id, outputQuantity: z.int().positive(),
  outputUnit: z.enum(["each", "pair", "set"]), proposalOnly: z.literal(true),
  lines: z.array(DemandLine.extend({ code: Code, name: z.string() })), totals: z.array(DemandLine),
}).strict();
export const ManufacturingResponseEnvelopeSchema = z.object({
  contextAuthority: z.string().min(1), data: z.unknown(),
}).strict();
export type ManufacturingTransport<T, Wrapped extends boolean> = Wrapped extends true ? { contextAuthority: string; data: T } : T;
export type ManufacturingReferences = z.infer<typeof ManufacturingReferencesSchema>;
export type ManufacturingMaterialOptions = z.infer<typeof ManufacturingMaterialOptionsSchema>;
