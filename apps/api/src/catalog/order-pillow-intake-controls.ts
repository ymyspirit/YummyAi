import type { CustomizationDefinition } from "@yummyai/contracts";
import type { SpecificationView } from "@yummyai/contracts/catalog/development";
import { orderProductionRequirements } from "@yummyai/contracts/order/production-requirements";
import type { OrderIntakeCheck, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { customizationFieldCandidates } from "../orders/order-customization-mapper.js";
import { pillowSpecificationSize } from "./order-pillow-matching.js";

type PillowControlSpecification = Pick<SpecificationView, "code" | "attributes" | "spuCode" | "productType">;

/** The caller separately verifies photo-only artwork. Only an exact catalog
 * size control leaves the production projection; the original draft is intact. */
export function resolveOrderPillowIntakeControls(
  draft: OrderWorkDraft,
  specification: PillowControlSpecification,
  customization: CustomizationDefinition,
): {
  productionDraft: OrderWorkDraft;
  routingFields: OrderWorkDraft["fields"];
  issues: OrderIntakeCheck["issues"];
} {
  const productionDraft = structuredClone(draft);
  const routingFields: OrderWorkDraft["fields"] = [];
  const issues: OrderIntakeCheck["issues"] = [];
  const result = { productionDraft, routingFields, issues };
  if (specification.spuCode !== "CUSTOM-SHAPED-PILLOW" || specification.productType !== "shaped_pillow") return result;

  const candidates = draft.fields.map((field, index) => ({ field, index })).filter(({ field }) => sizeLabel(field.label));
  if (!candidates.length) return result;
  const reject = (code: string, message: string) => {
    issues.push({ code, fieldKey: candidates.length === 1 ? candidates[0]!.field.key : null, message,
      action: "请对照原始尺寸选项核对本单规格 保留原字段并明确唯一的尺寸与制作依据" });
    return result;
  };
  if (candidates.length !== 1) return reject("duplicate_value", "存在多个原始尺寸字段 不能自动作为唯一规格控制参数");
  const { field, index } = candidates[0]!;
  if (field.kind === "image") return reject("invalid_value", "图片字段不能作为抱枕规格尺寸依据");
  if (field.font !== undefined || field.color !== undefined)
    return reject("invalid_value", "尺寸字段包含字体或颜色要求 不能从制作内容中隐藏");
  if (customizationFieldCandidates(customization.fields, field.key, field.label).length ||
    customization.fields.some(target => sizeLabel(target.key) || sizeLabel(target.label)))
    return reject("ambiguous_field", "原尺寸字段与印花定制字段冲突 不能自动作为规格控制参数");

  const expected = pillowSpecificationSize(specification.code, specification.attributes);
  const requirements = orderProductionRequirements({ surfaces: [{ key: "specification-control", label: "原始规格控制参数",
    fields: [field], previewFileKey: null, buyerFileKeys: [] }] });
  if (expected === null || requirements.sizeInches === null || requirements.warnings.length)
    return reject("invalid_value", "原尺寸或已选规格无法唯一识别 请核对明确的抱枕尺寸");
  if (requirements.sizeInches !== expected)
    return reject("invalid_value", "原尺寸选项与已选抱枕规格不一致 不能隐藏尺寸差异");

  routingFields.push(structuredClone(field));
  productionDraft.fields = productionDraft.fields.filter((_, fieldIndex) => fieldIndex !== index);
  return result;
}

function sizeLabel(label: string) {
  return /^(?:Pillow Size|Size(?:\s*\([^()\r\n]*\))?)$/i.test(label.trim());
}
