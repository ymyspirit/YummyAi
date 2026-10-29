import {
  CreativeRequirementsSchema,
  type CreativeRequirements,
} from "@yummyai/contracts/catalog/artwork";
import type { AssistDirection, AssistMatch, AssistOrderFieldBinding } from "@yummyai/contracts/ai/assist";
import type { OrderRequirementSource } from "@yummyai/contracts/order/requirement-interpretation";
import { orderRequirementField } from "../order-centers/order-requirements-model";
import {
  OrderWorkDraftSchema,
  type OrderWorkDetail,
  type OrderWorkDraft,
} from "@yummyai/contracts/order/workspace";
import type { DirectionField } from "./assist-panel";

export function adoptCreativeRequirements(
  current: CreativeRequirements,
  direction: AssistDirection,
  fields: DirectionField[],
): CreativeRequirements {
  const next = structuredClone(current);
  for (const key of fields)
    if (key !== "prompt" && key !== "negativePrompt" && key !== "customization")
      next[key] = direction.requirements[key];
  if (fields.includes("customization")) {
    next.mode = direction.requirements.mode;
    next.layout = [];
    next.customization = {
      version: 1,
      fields: direction.fields.map((f) => ({
        key: f.key,
        label: f.label,
        required: f.required,
        helpText: f.helpText,
        ...(f.type === "image"
          ? {
              type: "image" as const,
              validation: {
                allowedMediaTypes: ["image/png", "image/jpeg", "image/webp"] as (
                  "image/png" | "image/jpeg" | "image/webp"
                )[],
                maxFiles: 1,
                maxBytes: 20_000_000,
              },
            }
          : { type: f.type, validation: f.maxLength === null ? {} : { maxLength: f.maxLength } }),
      })),
    };
  }
  return CreativeRequirementsSchema.parse(next);
}
export function adoptOrderMatch(
  current: OrderWorkDraft,
  detail: OrderWorkDetail,
  match: AssistMatch,
): OrderWorkDraft {
  const art = detail.catalog?.artworks.find((a) => a.id === match.artworkVersionId),
    spec = detail.catalog?.specifications.find((s) => s.id === match.specificationVersionId);
  if (!art || !spec) throw new Error("候选已不在当前资料库中，请刷新后重新预审");
  return OrderWorkDraftSchema.parse({
    ...current,
    artworkVersionId: art.id,
    specificationVersionId: spec.id,
    printProfileVersionId: spec.processProfileVersionId,
    salesRecipeVersionId: null,
    salesPackageId: null,
    fields: [
      ...current.fields,
      ...art.customization.fields
        .filter((f) => f.type !== "image" && !current.fields.some((v) => v.key === f.key))
        .map((f) => ({ key: f.key, label: f.label, kind: "text", value: "" })),
    ],
  });
}

/** Adopt only a classification of existing source rows. Buyer values and styles are never generated here. */
export async function adoptOrderFieldBindings(current: OrderWorkDraft, detail: OrderWorkDetail,
  bindings: readonly AssistOrderFieldBinding[], sources: readonly OrderRequirementSource[], evidenceIds: readonly string[]) {
  const definitions = detail.catalog?.artworks.find(row => row.id === current.artworkVersionId)?.customization.fields ?? [];
  const sourceMap = new Map(sources.map(row => [row.sourceFieldKey, row]));
  if (sourceMap.size !== sources.length || new Set(bindings.map(row => row.sourceFieldKey)).size !== bindings.length)
    throw new Error("原始字段或建议出现重复 请重新核对当前资料");
  const fingerprints = new Map(await Promise.all(bindings.map(async binding => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(binding.sourceFieldKey)));
    return [binding.sourceFieldKey, `order-field:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")}`] as const;
  })));
  const knownEvidence = new Set(evidenceIds), usedTargets = new Set<string>(), unresolved: string[] = [];
  // A low-confidence suggestion is not exempt from the original-source boundary.
  for (const binding of bindings) {
    const source = sourceMap.get(binding.sourceFieldKey), expectedEvidence = fingerprints.get(binding.sourceFieldKey);
    if (!source || binding.role !== source.role || !binding.evidence.some(row => row.sourceId === expectedEvidence && knownEvidence.has(row.sourceId)))
      throw new Error("分析建议缺少本单原字段依据 当前填写未改变");
  }
  let next = structuredClone(current), applied = 0;
  for (const binding of bindings) {
    const source = sourceMap.get(binding.sourceFieldKey)!;
    if (binding.confidence < 0.85) { unresolved.push(`${source.label}：把握不足，请核对`); continue; }
    if (!binding.targetFieldKey) { unresolved.push(`${source.label}：${binding.reason}`); continue; }
    const target = definitions.find(row => row.key === binding.targetFieldKey);
    if (!target) throw new Error("分析建议引用了当前印花之外的字段 当前填写未改变");
    if (source.role === "font" || source.role === "color") {
      const text = source.targetTextKey ? sourceMap.get(source.targetTextKey) : null;
      const textBinding = text && bindings.find(row => row.sourceFieldKey === text.sourceFieldKey);
      if (!text || text.role !== "text" || text.groupKey !== source.groupKey || textBinding?.targetFieldKey !== target.key || !["short_text", "long_text"].includes(target.type))
        throw new Error("字体或颜色不能跨文字组应用 当前填写未改变");
      // Their native group remains the authority. A model cannot turn a selector into printable text or operator style.
      continue;
    }
    if (usedTargets.has(target.key)) throw new Error("多个原字段指向同一定制项 请保留原文并核对歧义");
    usedTargets.add(target.key);
    if (source.role === "image") {
      if (target.type !== "image") throw new Error("原图建议与定制字段类型不符");
      if (definitions.filter(row => row.type === "image").length > 1) unresolved.push(`${source.label}：请在原图下明确选择用途`);
      continue;
    }
    const validType = source.role === "text" ? ["short_text", "long_text"].includes(target.type)
      : source.role === "notes" ? target.key === "customer_notes" && ["short_text", "long_text"].includes(target.type)
        : source.role === "crop" ? target.key === "crop_scope" && ["short_text", "single_choice"].includes(target.type)
          : source.role === "side" ? target.key === "print_sides" && target.type === "single_choice"
            : ["option", "enhancement"].includes(source.role) && ["single_choice", "multiple_choice"].includes(target.type);
    if (!validType) throw new Error("原字段与定制项类型不符 当前填写未改变");
    const field = orderRequirementField(next, source.sourceFieldKey);
    if (!field) { unresolved.push(`${source.label}：原字段未纳入当前草稿`); continue; }
    if (next.fields.some(row => row !== field && row.key === target.key)) {
      unresolved.push(`${source.label}：目标已有其他原值 请核对后选择`); continue;
    }
    if ((target.type === "single_choice" || target.type === "multiple_choice") && target.options.filter(row => row.value === field.value || row.label === field.value).length !== 1) {
      unresolved.push(`${source.label}：原值未唯一对应可选项`); continue;
    }
    next = { ...next, fields: next.fields.map(row => row === field ? { ...row, key: target.key, label: target.label,
      sourceKey: row.sourceKey ?? source.sourceFieldKey } : row) };
    applied++;
  }
  return { draft: OrderWorkDraftSchema.parse(next), applied, unresolved };
}
