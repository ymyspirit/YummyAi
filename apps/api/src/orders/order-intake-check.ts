import type { CustomizationDefinition, OrderCustomizationValue } from "@yummyai/contracts";
import type { OrderIntakeCheck, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import {
  customizationFieldCandidates,
  customizationFieldVisible,
  mapOrderCustomization,
} from "./order-customization-mapper.js";

/** Deterministic review only: no guessing aliases, file fetching, model or approval. */
export function checkOrderIntakeFields(
  schema: CustomizationDefinition,
  draft: OrderWorkDraft,
  strict: boolean,
) {
  const issues: OrderIntakeCheck["issues"] = [];
  const normalizedDraft = structuredClone(draft);
  const matches = draft.fields.map((source) =>
    customizationFieldCandidates(schema.fields, source.key, source.label),
  );
  const imageMatches = draft.images.map((source) =>
    customizationFieldCandidates(schema.fields, source.usage, source.usage),
  );
  const add = (code: string, fieldKey: string | null, message: string, action: string) =>
    issues.push({ code, fieldKey, message, action });
  for (const [index, source] of draft.fields.entries()) {
    const candidates = matches[index]!;
    if (candidates.length > 1) {
      add(
        "ambiguous_field",
        null,
        `定制字段匹配有歧义：${source.label}`,
        "核对原始资料，明确填写唯一的字段编码和名称",
      );
    } else if (!candidates.length && source.value.trim() && strict) {
      add(
        "unmapped_field",
        null,
        `定制字段尚未匹配：${source.label}`,
        "匹配到已封存字段；额外要求交由美工核对，并保留原始资料",
      );
    } else if (candidates.length === 1) {
      const field = candidates[0]!;
      // Two provider entries must not be collapsed into one accepted value.
      if (
        matches.filter((list) => list.length === 1 && list[0]!.key === field.key).length === 1 &&
        !draft.fields.some((other, otherIndex) => otherIndex !== index && other.key === field.key)
      ) {
        normalizedDraft.fields[index] = { ...source, key: field.key, label: field.label };
      }
    }
  }
  for (const [index, source] of draft.images.entries()) {
    const candidates = imageMatches[index]!;
    if (candidates.length !== 1 || candidates[0]!.type !== "image") {
      if (strict || candidates.length > 0)
        add(
          candidates.length > 1 ? "ambiguous_image" : "unmapped_image",
          null,
          `买家原图用途${candidates.length > 1 ? "有歧义" : "未匹配"}：${source.usage}`,
          "在图片用途中填写唯一的图片字段编码",
        );
    } else normalizedDraft.images[index]!.usage = candidates[0]!.key;
  }
  const sourceValues: OrderCustomizationValue[] = draft.fields.flatMap((source, index) => {
    const field = matches[index]!.length === 1 ? matches[index]![0]! : null;
    if (!field || field.type === "image" || source.kind === "image" || !source.value.trim())
      return [];
    return [{ key: field.key, label: field.label, type: "text" as const, value: source.value }];
  });
  const mapped = mapOrderCustomization(schema, sourceValues);
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
        (field.type === "image" && images.length > (field.validation?.maxFiles ?? 1));
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
        sourceKeys: sources.map((source) => source.key),
        imageCount: images.length,
      };
    },
  );
  return { issues, fields, normalizedDraft };
}
