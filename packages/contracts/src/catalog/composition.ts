import { z } from "zod";
import type { ArtworkView } from "@yummyai/contracts/catalog/development";
import { CustomizationSchema } from "@yummyai/contracts/catalog/product";
import { ArtworkLayoutSchema } from "@yummyai/contracts/catalog/artwork";

const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
export const PrintBindingSchema = z.object({
  key: FieldKey,
  artworkVersionId: z.uuidv7(),
  surface: z.enum(["front", "back"]),
  region: FieldKey.default("whole"),
  area: z.object({ xPercent: z.number().min(0).max(100), yPercent: z.number().min(0).max(100), widthPercent: z.number().positive().max(100), heightPercent: z.number().positive().max(100) }).strict()
    .refine(a => a.xPercent + a.widthPercent <= 100 && a.yPercent + a.heightPercent <= 100, "制作区域须位于版面内")
    .default({ xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 }),
  fieldMappings: z.array(z.object({ fieldKey: FieldKey, customerFieldKey: FieldKey }).strict()).max(30).default([]),
}).strict();
export const PrintBindingsSchema = z.array(PrintBindingSchema).min(1).max(30).superRefine((bindings, ctx) => {
  if (new Set(bindings.map(b => b.key)).size !== bindings.length)
    ctx.addIssue({ code: "custom", message: "印花绑定编号不可重复" });
  for (const [i, b] of bindings.entries()) {
    if (new Set(b.fieldMappings.map(f => f.fieldKey)).size !== b.fieldMappings.length)
      ctx.addIssue({ code: "custom", path: [i, "fieldMappings"], message: "同一印花字段只能映射一次" });
  }
});
export type PrintBinding = z.infer<typeof PrintBindingSchema>;
export type ResolvedPrintBinding = PrintBinding & { artwork: ArtworkView };

/** Stable composition identity excludes version pins: an update creates a new recipe. */
export function compositionIdentity(bindings: ResolvedPrintBinding[]) {
  return bindings.map(({ artwork, artworkVersionId, ...binding }) => {void artworkVersionId;return { ...binding, artworkId: artwork.id };});
}
export function printBindingSnapshot(b:PrintBinding):PrintBinding{return {key:b.key,artworkVersionId:b.artworkVersionId,surface:b.surface,region:b.region,area:b.area,fieldMappings:b.fieldMappings};}
export function legacyPrintBinding(artworkVersionId: string): PrintBinding {
  return PrintBindingSchema.parse({ key: "primary", artworkVersionId, surface: "front" });
}

/** Legacy callers receive the complete customization plan; identity remains the first print pin.
 * Composite masters are never represented by the first component's bitmap. */
export function composedArtwork(bindings: ResolvedPrintBinding[]): ArtworkView {
  const first = bindings[0];
  if (!first) throw new Error("销售配方缺少印花绑定");
  const fields: ArtworkView["customization"]["fields"] = [], layout: ArtworkView["layout"] = [];
  const keys = new Set<string>();
  for (const binding of bindings) {
    const art = binding.artwork;
    for (const mapping of binding.fieldMappings)
      if (!art.customization.fields.some(f => f.key === mapping.fieldKey)) throw new Error(`不存在印花字段：${binding.key}.${mapping.fieldKey}`);
    const mappedKey = (key: string) => binding.fieldMappings.find(m => m.fieldKey === key)?.customerFieldKey ?? key;
    for (const field of art.customization.fields) {
      const key = mappedKey(field.key);
      if (keys.has(key)) throw new Error(`顾客字段 ${key} 映射不唯一，请为各制作区域配置独立字段`);
      keys.add(key);
      fields.push({ ...field, key, ...(field.visibleWhen ? { visibleWhen: { ...field.visibleWhen, fieldKey: mappedKey(field.visibleWhen.fieldKey) } } : {}), productionMapping: { targetSystem: "sales_recipe", path: `${binding.key}.${binding.surface}.${binding.region}.${field.key}` } });
    }
    for (const p of art.layout) layout.push({ ...p, fieldKey: mappedKey(p.fieldKey), surface: binding.surface,
      xPercent: binding.area.xPercent + p.xPercent * binding.area.widthPercent / 100,
      yPercent: binding.area.yPercent + p.yPercent * binding.area.heightPercent / 100,
      widthPercent: p.widthPercent * binding.area.widthPercent / 100,
      heightPercent: p.heightPercent * binding.area.heightPercent / 100 });
  }
  if (bindings.length === 1 && !first.fieldMappings.length && first.surface === "front" && first.region === "whole" && first.area.widthPercent === 100 && first.area.heightPercent === 100)
    return first.artwork;
  const custom = bindings.some(b => b.artwork.mode !== "fixed");
  return { ...first.artwork, name: bindings.map(b => `${b.artwork.name}（${b.surface === "front" ? "正面" : "反面"}/${b.region}）`).join(" + "),
    mode: custom ? "mixed" : "fixed", assetId: null, assetVersion: null,
    archived: bindings.some(b => b.artwork.archived),
    customization: CustomizationSchema.parse({ version: 1, fields }), layout: ArtworkLayoutSchema.parse(layout),
    instructions: bindings.map(b => `[${b.key}/${b.surface}/${b.region}] ${b.artwork.instructions}`).join("\n"),
    materials: [...new Map(bindings.flatMap(b => b.artwork.materials).map(m => [m.assetId, m])).values()],
    researchItemIds: [...new Set(bindings.flatMap(b => b.artwork.researchItemIds))] };
}

export const CustomChoiceSchema = z.record(FieldKey, z.string().trim().min(1).max(200)).refine(v => Object.keys(v).length <= 30);
export function matchesCustomChoice(expected: Record<string, string>, actual: Record<string, string>) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}
export const CustomSalesSkuMappingSchema=z.array(z.object({skuId:z.uuidv7(),platformSkuId:z.uuidv7(),platformSkuCode:z.string().min(1),specificationId:z.uuidv7(),customChoice:CustomChoiceSchema}).strict()).min(1).max(50);
