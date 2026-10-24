import { z } from "zod";
import {
  CreateManufacturingRecipeSchema, ReviseManufacturingRecipeSchema, ReviewManufacturingRecipeSchema,
  ManufacturingRecipeContentSchema, type ManufacturingRecipeContent, type ManufacturingRecipeVersionView,
} from "@yummyai/contracts/catalog/manufacturing";
import { InventoryUnitSchema } from "@yummyai/contracts/inventory";
const Text = z.string().max(4000), Key = z.uuid();
const Responsibility = z.enum(["unknown", "merchant", "factory"]);
const Material = z.object({ key: Key, code: Text, name: Text, stockItemId: z.union([z.uuidv7(), z.literal("")]),
  quantity: Text, quantityUnit: z.union([InventoryUnitSchema, z.literal("")]), unit: z.union([InventoryUnitSchema, z.literal("")]), lossPercent: Text,
  lossBasis: z.enum(["", "add_to_net", "fraction_of_input"]), responsibility: Responsibility, operationKey: z.union([Key, z.literal("")]), notes: Text }).strict();
const Operation = z.object({ key: Key, code: Text, name: Text, processCode: Text, responsibility: Responsibility, seconds: Text, notes: Text }).strict();
export const ManufacturingIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), body: CreateManufacturingRecipeSchema }).strict(),
  z.object({ kind: z.literal("revise"), recipeId: z.uuidv7(), body: ReviseManufacturingRecipeSchema }).strict(),
  z.object({ kind: z.literal("review"), recipeId: z.uuidv7(), body: ReviewManufacturingRecipeSchema }).strict(),
]);
export const ManufacturingDraftSchema = z.object({ code: Text, name: Text, specificationId: z.union([z.uuidv7(), z.literal("")]),
  specificationVersionId: z.union([z.uuidv7(), z.literal("")]), outputQuantity: Text, outputUnit: z.enum(["", "each", "pair", "set"]), notes: Text,
  basisVersion: z.int().positive().nullable(), materials: z.array(Material).max(200), operations: z.array(Operation).max(200),
  reviewNote: Text, pending: ManufacturingIntentSchema.nullable() }).strict();
export type ManufacturingDraft = z.infer<typeof ManufacturingDraftSchema>;
export type MaterialDraft = z.infer<typeof Material>;
export type OperationDraft = z.infer<typeof Operation>;
export type ManufacturingIntent = z.infer<typeof ManufacturingIntentSchema>;
export const unitLabels: Record<z.infer<typeof InventoryUnitSchema>, string> = { each: "件", pair: "双", set: "套", meter: "米", gram: "克", kilogram: "千克" };
export const responsibilityLabels = { unknown: "待确认", merchant: "本方", factory: "工厂" };
export const blankMaterial = (): MaterialDraft => ({ key: crypto.randomUUID(), code: "", name: "", stockItemId: "", quantity: "", quantityUnit: "", unit: "", lossPercent: "", lossBasis: "", responsibility: "unknown", operationKey: "", notes: "" });
export const blankOperation = (): OperationDraft => ({ key: crypto.randomUUID(), code: "", name: "", processCode: "", responsibility: "unknown", seconds: "", notes: "" });
const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a;
export function quantityFraction(input: string): { numerator: number; denominator: number } | null {
  const text = input.trim(); if (!text) return null;
  let numerator: bigint, denominator: bigint;
  if (/^\d+\/\d+$/.test(text)) [numerator, denominator] = text.split("/").map(BigInt) as [bigint, bigint];
  else if (/^\d+(?:\.\d{1,9})?$/.test(text)) { const [integer, fraction = ""] = text.split("."); denominator = 10n ** BigInt(fraction.length); numerator = BigInt(integer!) * denominator + BigInt(fraction || "0"); }
  else throw new Error("净用量请填写正数或分数 例如0.25或1/4");
  if (!numerator || !denominator) throw new Error("净用量须大于零");
  const divisor = gcd(numerator, denominator); numerator /= divisor; denominator /= divisor;
  if (numerator > 1000000000n || denominator > 1000000000n) throw new Error("净用量或精度超出允许范围");
  return { numerator: Number(numerator), denominator: Number(denominator) };
}
export const quantityText = (numerator: number | string | null, denominator: number | string | null) => {
  if (numerator === null || denominator === null) return "";
  const n = BigInt(numerator), d = BigInt(denominator); if (!d) return "";
  if (n % d === 0n) return (n / d).toString();
  const scaled = n * 1000000000n;
  if (scaled % d === 0n) { const s = (scaled / d).toString().padStart(10, "0"); return `${s.slice(0, -9)}.${s.slice(-9).replace(/0+$/, "")}`; }
  return `${n}/${d}`;
};
export function blankManufacturingDraft(specificationId = "", specificationVersionId = ""): ManufacturingDraft {
  return { code: "", name: "", specificationId, specificationVersionId, outputQuantity: "", outputUnit: "", notes: "", basisVersion: null,
    materials: [], operations: [], reviewNote: "", pending: null };
}
export function draftFromVersion(version: ManufacturingRecipeVersionView): ManufacturingDraft {
  const operations: OperationDraft[] = version.content.operations.map(row => ({ ...row, key: crypto.randomUUID(), seconds: row.expectedSecondsPerOutput?.toString() ?? "" }));
  return { code: version.code, name: version.content.name, specificationId: version.specificationId, specificationVersionId: version.content.specificationVersionId,
    outputQuantity: version.content.outputQuantity.toString(), outputUnit: version.content.outputUnit, notes: version.content.notes, basisVersion: version.versionNumber,
    operations: operations.map(({ key, code, name, processCode, responsibility, seconds, notes }) => ({ key, code, name, processCode, responsibility, seconds, notes })),
    materials: version.content.materials.map(row => ({ key: crypto.randomUUID(), code: row.code, name: row.name, stockItemId: row.stockItemId ?? "",
      quantity: quantityText(row.quantityNumerator, row.quantityDenominator), quantityUnit: row.unit ?? "", unit: row.unit ?? "", lossPercent: row.lossBps === null ? "" : quantityText(row.lossBps, 100),
      lossBasis: row.lossBasis ?? "", responsibility: row.responsibility, operationKey: operations.find(op => op.code === row.operationCode)?.key ?? "", notes: row.notes })),
    reviewNote: "", pending: null };
}
const integer = (text: string, label: string, optional = false) => {
  if (!text.trim() && optional) return null;
  if (!/^\d+$/.test(text.trim()) || Number(text) <= 0 || !Number.isSafeInteger(Number(text))) throw new Error(`${label}须为正整数`);
  return Number(text);
};
export function contentFromDraft(draft: ManufacturingDraft): ManufacturingRecipeContent {
  if (!draft.name.trim()) throw new Error("请填写制造名称");
  if (!draft.specificationVersionId) throw new Error("请选择实际产品规格");
  const content = {
    specificationVersionId: draft.specificationVersionId, name: draft.name, outputQuantity: integer(draft.outputQuantity, "产出数量"), outputUnit: draft.outputUnit, notes: draft.notes,
    operations: draft.operations.map((row, index) => {
      if (!row.code.trim() || !row.name.trim() || !row.processCode.trim()) throw new Error(`请补齐工序${index + 1}的编号、名称和加工代码`);
      return { code: row.code, name: row.name, processCode: row.processCode, responsibility: row.responsibility, expectedSecondsPerOutput: integer(row.seconds, `工序${index + 1}预计秒数`, true), notes: row.notes };
    }),
    materials: draft.materials.map((row, index) => {
      if (!row.code.trim() || !row.name.trim()) throw new Error(`请填写材料${index + 1}的行编号和说明`);
      if (row.quantity.trim() && row.quantityUnit !== row.unit) throw new Error(`材料${index + 1}已换单位 请重新填写净用量后保存 原数值未自动换算`);
      const quantity = quantityFraction(row.quantity), text = row.lossPercent.trim();
      if (text && !/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`材料${index + 1}损耗比例最多填写两位小数`);
      const [percent = "0", fraction = ""] = text.split(".");
      const operation = row.operationKey ? draft.operations.find(op => op.key === row.operationKey) : null;
      if (row.operationKey && !operation) throw new Error(`材料${index + 1}引用的工序已变化 请重新选择`);
      return { code: row.code, name: row.name, stockItemId: row.stockItemId || null, quantityNumerator: quantity?.numerator ?? null, quantityDenominator: quantity?.denominator ?? null,
        unit: row.unit || null, lossBps: text ? Number(BigInt(percent) * 100n + BigInt(fraction.padEnd(2, "0") || "0")) : null,
        lossBasis: row.lossBasis || null, responsibility: row.responsibility, operationCode: operation?.code ?? null, notes: row.notes };
    }),
  };
  const parsed = ManufacturingRecipeContentSchema.safeParse(content);
  if (!parsed.success) throw new Error(parsed.error.issues.find(issue => /[\u4e00-\u9fff]/.test(issue.message))?.message ?? "请核对产出单位、数量或材料字段是否超出范围");
  return parsed.data;
}
export function draftContentKey(draft: ManufacturingDraft) {
  return JSON.stringify({ ...draft, reviewNote: "", pending: null,
    materials: draft.materials.map(row => ({ ...row, key: undefined, operationKey: row.operationKey ? draft.operations.findIndex(op => op.key === row.operationKey) : -1 })),
    operations: draft.operations.map(row => ({ ...row, key: undefined })) });
}
export function intentPath(intent: ManufacturingIntent) {
  return intent.kind === "create" ? "" : `/${intent.recipeId}/${intent.kind === "review" ? "reviews" : "versions"}`;
}
