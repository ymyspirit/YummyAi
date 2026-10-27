import type { CustomizationDefinition, OrderCustomizationValue } from "@yummyai/contracts";
import type { OrderIntakeCheck, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import {
  customizationFieldCandidates,
  customizationFieldVisible,
  mapOrderCustomization,
  type OrderCustomizationMappingOptions,
} from "./order-customization-mapper.js";

/** Deterministic review only: no guessing aliases, file fetching, model or approval. */
export function checkOrderIntakeFields(
  schema: CustomizationDefinition,
  draft: OrderWorkDraft,
  strict: boolean,
  options: OrderCustomizationMappingOptions = {},
) {
  const issues: OrderIntakeCheck["issues"] = [];
  const normalizedDraft = structuredClone(draft);
  const matches = draft.fields.map((source) =>
    customizationFieldCandidates(schema.fields, source.key, source.label, options),
  );
  const imageMatches = draft.images.map((source) =>
    customizationFieldCandidates(schema.fields, source.usage, source.usage, options),
  );
  const add = (code: string, fieldKey: string | null, message: string, action: string) =>
    issues.push({ code, fieldKey, message, action });
  for (const [index, source] of draft.fields.entries()) {
    const candidates = matches[index]!;
    const original = options.requirementSources?.find(item => item.sourceFieldKey === (source.sourceKey ?? source.key));
    const styleSelector = original?.origin === "amazon_raw" && ["font", "color"].includes(original.role) && source.kind === "choice";
    if (candidates.length > 1) {
      add(
        "ambiguous_field",
        null,
        `定制字段匹配有歧义：${source.label}`,
        "核对原始资料，明确填写唯一的字段编码和名称",
      );
    } else if (!candidates.length && source.value.trim() && strict && !styleSelector) {
      add(
        "unmapped_field",
        null,
        `定制字段尚未匹配：${source.label}`,
        "核对原始资料并明确字段含义；保留额外顾客要求供无人设计准备和运营审核",
      );
    }
  }
  for (const [index, source] of draft.images.entries()) {
    const candidates = imageMatches[index]!;
    if (candidates.length !== 1 || candidates[0]!.type !== "image") {
      if (strict || candidates.length > 0 || schema.fields.some(field => field.type === "image"))
        add(
          candidates.length > 1 ? "ambiguous_image" : "unmapped_image",
          null,
          `买家原图用途${candidates.length > 1 ? "有歧义" : "未匹配"}：${source.usage}`,
          "核对所选原图，并在图片用途中明确填写本单唯一的图片字段编码",
        );
    } else normalizedDraft.images[index]!.usage = candidates[0]!.key;
  }
  const sourceValues: OrderCustomizationValue[] = draft.fields.flatMap((source, index) => {
    const field = matches[index]!.length === 1 ? matches[index]![0]! : null;
    if (!field || field.type === "image" || source.kind === "image" || !source.value.trim())
      return [];
    return [{ key: field.key, label: field.label, type: "text" as const, value: source.value }];
  });
  const mapped = mapOrderCustomization(schema, sourceValues, options);
  for (const [index, source] of draft.fields.entries()) {
    const candidates = matches[index]!;
    if (candidates.length !== 1) continue;
    const field = candidates[0]!;
    const populated = (sourceIndex: number) => field.type === "image" || !!draft.fields[sourceIndex]!.value.trim();
    // Keep an emptied provider row as evidence. It must not receive another
    // row's accepted value or prevent the unique nonempty supplement from normalizing.
    if (!populated(index)) continue;
    // Invalid, duplicate and ambiguous entries remain fully editable. Never
    // replace multiple provider entries with one accepted canonical value.
    if (matches.filter((list, sourceIndex) => list.length === 1 && list[0]!.key === field.key && populated(sourceIndex)).length !== 1 ||
      draft.fields.some((other, otherIndex) => otherIndex !== index && other.key === field.key && populated(otherIndex))) continue;
    // A report's upload filename is only an editable source marker. Canonical
    // identity does not make it a selected or authorized buyer image.
    if (field.type === "image" && source.kind === "image") {
      normalizedDraft.fields[index] = { ...source, sourceKey: source.sourceKey ?? source.key, key: field.key, label: field.label };
      continue;
    }
    if (!mapped.mappedFieldKeys.includes(field.key)) continue;
    const value = mapped.values[field.key];
    normalizedDraft.fields[index] = { ...source, sourceKey: source.sourceKey ?? source.key, key: field.key, label: field.label,
      value: typeof value === "string" ? value : source.value };
  }
  const fields: OrderIntakeCheck["fields"] = schema.fields.map(
    (field): OrderIntakeCheck["fields"][number] => {
      const sources = draft.fields.filter(
        (_, index) => matches[index]!.length === 1 && matches[index]![0]!.key === field.key,
      );
      const images = draft.images.filter(
        (_, index) =>
          imageMatches[index]!.length === 1 && imageMatches[index]![0]!.key === field.key,
      );
      const visible = customizationFieldVisible(field, mapped.values);
      const required = field.required && visible;
      const populated =
        field.type === "image" ? images.length > 0 : sources.some((source) => source.value.trim());
      const invalid =
        sources.some(
          (source) => source.value.trim() && (source.kind === "image") !== (field.type === "image"),
        ) ||
        mapped.diagnostics.some(
          (diagnostic) => diagnostic.fieldKey === field.key && diagnostic.code === "invalid_value",
        );
      const duplicate =
        sources.filter((source) => source.value.trim()).length > 1 ||
        (field.type === "image" && images.length > (options.photoOnlyPillow && field.key === "buyer_photo" ? 1 : field.validation?.maxFiles ?? 1));
      if (invalid)
        add(
          "invalid_value",
          field.key,
          `定制内容不符合固定规则：${field.label}`,
          "按本单固定的字段类型、文字长度、选项或日期规则修正，不能修改规则迁就错误值",
        );
      if (duplicate)
        add(
          "duplicate_value",
          field.key,
          `定制内容重复或超过数量：${field.label}`,
          "核对原始资料，保留明确的唯一值或允许数量内的图片",
        );
      if (required && !populated)
        add(
          "missing_required",
          field.key,
          `请补齐必填定制内容：${field.label}`,
          field.type === "image"
            ? "选择本单买家原图并指定对应用途；平台效果预览不能代替原图"
            : "核对买家原始要求并补齐该字段",
        );
      const ambiguous =
        matches.some(
          (list) => list.length > 1 && list.some((candidate) => candidate.key === field.key),
        ) ||
        imageMatches.some(
          (list) => list.length > 1 && list.some((candidate) => candidate.key === field.key),
        );
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        required,
        status:
          invalid || duplicate || ambiguous
            ? "conflict"
            : !visible
              ? "inactive"
              : populated
                ? "mapped"
                : required
                  ? "missing"
                  : "optional",
        sourceKeys: sources.map((source) => source.sourceKey ?? source.key),
        imageCount: images.length,
      };
    },
  );
  return { issues, fields, normalizedDraft };
}
