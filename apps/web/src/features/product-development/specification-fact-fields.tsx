"use client";
import { flushSync } from "react-dom";
import { cancelViewTransitions, observeViewTransition } from "../navigation/view-transition";

import { SpecificationDimensionBases, SpecificationFactsSchema, normalizeSpecificationFactDisplay, type SpecificationFacts } from "@yummyai/contracts/catalog/development";

export const emptySpecificationFactDraft = {
  material: "", structure: "", dimensions: "", packageContents: "", packageQuantity: "",
  weightGrams: "", packagedWeightGrams: "", packageDimensions: "",
  sizeBasis: "", sizeUnit: "", sizeLength: "", sizeWidth: "", sizeHeight: "",
  packageUnit: "", packageLength: "", packageWidth: "", packageHeight: "", verificationReference: "",
  productionConfirmed: "", productionRuleReferences: "[]",
};
export type SpecificationFactDraft = typeof emptySpecificationFactDraft;
export const specificationFactDraftKeys = Object.keys(emptySpecificationFactDraft) as Array<keyof SpecificationFactDraft>;
const text = (value: string | number | null | undefined) => value == null ? "" : String(value);
export function specificationFactsDraft(facts?: SpecificationFacts): SpecificationFactDraft {
  return {
    material: facts?.material ?? "", structure: facts?.structure ?? "", dimensions: facts?.dimensions ?? "",
    packageContents: facts?.packageContents ?? "", packageQuantity: text(facts?.packageQuantity),
    weightGrams: text(facts?.weightGrams), packagedWeightGrams: text(facts?.packagedWeightGrams), packageDimensions: facts?.packageDimensions ?? "",
    sizeBasis: facts?.physicalDimensions?.basis ?? "", sizeUnit: facts?.physicalDimensions?.unit ?? "",
    sizeLength: text(facts?.physicalDimensions?.length), sizeWidth: text(facts?.physicalDimensions?.width), sizeHeight: text(facts?.physicalDimensions?.height),
    packageUnit: facts?.packageMeasurements?.unit ?? "", packageLength: text(facts?.packageMeasurements?.length),
    packageWidth: text(facts?.packageMeasurements?.width), packageHeight: text(facts?.packageMeasurements?.height),
    verificationReference: facts?.verificationReference ?? "",
    productionConfirmed: facts?.productionConfirmed ? "1" : "",
    productionRuleReferences: JSON.stringify(facts?.productionRuleReferences ?? []),
  };
}
export function specificationProductionReferences(draft: Pick<SpecificationFactDraft, "productionRuleReferences">) {
  try {
    const parsed = SpecificationFactsSchema.pick({ productionRuleReferences: true }).safeParse({
      productionRuleReferences: JSON.parse(draft.productionRuleReferences || "[]"),
    });
    if (parsed.success) return { references: parsed.data.productionRuleReferences ?? [], error: "" };
  } catch { /* Keep the original draft available for an explicit correction. */ }
  return { references: [], error: "原生产规则引用无法核对 请清除原引用后重新选择" };
}
export function specificationFactsFromDraft(draft: SpecificationFactDraft, confirmed: boolean): SpecificationFacts {
  const number = (key: keyof SpecificationFactDraft) => text(draft[key]).trim() ? Number(draft[key]) : null;
  const rules = specificationProductionReferences(draft);
  if (rules.error) throw new Error(rules.error);
  return normalizeSpecificationFactDisplay({
    formatVersion: 2, material: draft.material ?? "", structure: draft.structure ?? "", dimensions: draft.dimensions ?? "",
    physicalDimensions: {
      basis: (draft.sizeBasis || null) as NonNullable<SpecificationFacts["physicalDimensions"]>["basis"],
      unit: (draft.sizeUnit || null) as NonNullable<SpecificationFacts["physicalDimensions"]>["unit"],
      length: number("sizeLength"), width: number("sizeWidth"), height: number("sizeHeight"),
    },
    packageContents: draft.packageContents ?? "", packageQuantity: number("packageQuantity"), factsConfirmed: confirmed,
    productionConfirmed: draft.productionConfirmed === "1", productionRuleReferences: rules.references,
    weightGrams: number("weightGrams"), packagedWeightGrams: number("packagedWeightGrams"), packageDimensions: draft.packageDimensions ?? "",
    packageMeasurements: {
      unit: (draft.packageUnit || null) as NonNullable<SpecificationFacts["packageMeasurements"]>["unit"],
      length: number("packageLength"), width: number("packageWidth"), height: number("packageHeight"),
    },
    verificationReference: draft.verificationReference ?? "",
  });
}

export function SpecificationFactFields({ values, onChange, prefix = "", namePrefix = "" }: {
  values: SpecificationFactDraft;
  onChange(patch: Partial<SpecificationFactDraft>): void;
  prefix?: string;
  namePrefix?: string;
}) {
  const get = (key: keyof SpecificationFactDraft) => text(values[key]);
  const label = (name: string) => prefix + name;
  const short = (key: keyof SpecificationFactDraft, title: string, max: number) => <label key={key}>
    {label(title)}<input name={namePrefix + key} aria-label={label(title)} maxLength={max} value={get(key)} onChange={event => onChange({ [key]: event.target.value })} />
  </label>;
  const numeric = (key: keyof SpecificationFactDraft, title: string, integer = false) => <label key={key}>
    {label(title)}<input name={namePrefix + key} aria-label={label(title)} type="number" min={integer ? 1 : 0.000001} max={integer ? 10000 : 1000000} step={integer ? 1 : "any"} value={get(key)} onChange={event => onChange({ [key]: event.target.value })} />
  </label>;
  const units = (key: "sizeUnit" | "packageUnit", title: string) => <label>
    {label(title)}<select name={namePrefix + key} aria-label={label(title)} value={get(key)} onChange={event => onChange({ [key]: event.target.value })}>
      <option value="">尚未确认</option><option value="mm">毫米 mm</option><option value="cm">厘米 cm</option><option value="in">英寸 in</option>
    </select>
  </label>;
  const single = ["artwork_longest", "diameter"].includes(get("sizeBasis"));
  return <>
    {short("material", "实际材质", 300)}
    {short("structure", "产品结构", 1000)}
    <label>{label("尺寸口径")}<select name={namePrefix + "sizeBasis"} aria-label={label("尺寸口径")} value={get("sizeBasis")} onChange={event => {
      const basis = event.target.value;
      const update = () => onChange({ sizeBasis: basis, ...(["artwork_longest", "diameter"].includes(basis) ? { sizeWidth: "", sizeHeight: "" } : basis === "finished_outer_3d" ? {} : { sizeHeight: "" }) });
      if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        cancelViewTransitions();
        observeViewTransition(document.startViewTransition(() => flushSync(update)));
      } else update();
    }}><option value="">尚未确认</option>{Object.entries(SpecificationDimensionBases).map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select></label>
    {units("sizeUnit", "尺寸单位")}
    {numeric("sizeLength", single ? get("sizeBasis") === "diameter" ? "实际直径" : "图案主体最长边" : "实际长度")}
    {!single && numeric("sizeWidth", "实际宽度")}
    {get("sizeBasis") === "finished_outer_3d" && numeric("sizeHeight", "实际高度")}
    <p className="pd-form-hint pd-span">按真实测量记录选择口径和单位 规格名称不作为制造尺寸 未知项可留空保存草稿</p>
    {numeric("weightGrams", "商品净重（克）")}
    {numeric("packagedWeightGrams", "含包装重量（克）")}
    <p className="pd-form-hint pd-span">净重未知可留空 有包装重量时单独记录 不将同一列重量复制为净重与含包装重量</p>
    {short("packageContents", "包装内包含", 1000)}
    {numeric("packageQuantity", "每份件数", true)}
    {units("packageUnit", "包装尺寸单位")}
    {numeric("packageLength", "包装长度")}
    {numeric("packageWidth", "包装宽度")}
    {numeric("packageHeight", "包装高度")}
    <label className="pd-span">{label("核验依据")}<textarea name={namePrefix + "verificationReference"} aria-label={label("核验依据")} maxLength={1000} rows={2} value={get("verificationReference")} onChange={event => onChange({ verificationReference: event.target.value })} placeholder="实际测量记录 样品报告或供应商确认凭证编号" /></label>
  </>;
}
