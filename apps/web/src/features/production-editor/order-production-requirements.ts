import type { AmazonReportDetailView } from "@yummyai/contracts/order/report";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";

export type OrderProductionRequirements = {
  fields: Array<{ label: string; value: string; surface: string }>;
  sizeInches: number | null; sideMode: "single" | "double" | null;
  subject: "head" | "body" | null; warnings: string[];
};
/** Explicit option mappings only. Free text is displayed as data, never executed. */
export function orderProductionRequirements(report: Pick<AmazonReportDetailView, "surfaces">): OrderProductionRequirements {
  const fields = report.surfaces.flatMap((surface) => surface.fields.filter((field) => field.kind !== "image" && !/upload.*image/i.test(field.label)).map((field) => ({ label: field.label, value: field.value, surface: surface.label })));
  const sizes = new Set<number>(), sides = new Set<"single" | "double">(), subjects = new Set<"head" | "body">();
  const warnings: string[] = [];
  for (const field of fields) {
    const value = field.value.trim();
    if (/\bsize\b|尺寸|规格/i.test(field.label)) {
      const matches = [...value.matchAll(/(?<!\d)(10|12|14|16|18|20|22|24)\s*(?:inches|inch|in\b|英寸)/gi)];
      if (matches.length === 1) sizes.add(Number(matches[0]![1]));
      else if (value) warnings.push("尺寸选项无法唯一识别，请对照原文填写。");
    }
    if (/style|printing|印刷|款式|范围|部位/i.test(field.label)) {
      if (/^(single[ -]sided printing|单面印刷)$/i.test(value)) sides.add("single");
      if (/^(double[ -]sided printing|双面印刷)$/i.test(value)) sides.add("double");
      if (/^(only face|face only|head only|only head|仅头部|只做头部)$/i.test(value)) subjects.add("head");
      if (/^(full body|whole body|全身)$/i.test(value)) subjects.add("body");
    }
  }
  if (sizes.size > 1 || sides.size > 1 || subjects.size > 1) warnings.push("多个定制选项存在冲突，请按当前商品确认。");
  return { fields, sizeInches: sizes.size === 1 ? [...sizes][0]! : null, sideMode: sides.size === 1 ? [...sides][0]! : null, subject: subjects.size === 1 ? [...subjects][0]! : null, warnings };
}
export function applyOrderProductionRequirements(document: ProductionEditorDocument, requirements: OrderProductionRequirements): ProductionEditorDocument {
  if (document.productType !== "shaped_pillow") return document;
  return { ...document, spec: { ...document.spec,
    ...(requirements.sizeInches && !requirements.warnings.length ? { declaredLongestMm: requirements.sizeInches * 25.4, sizeBasis: "finished" as const } : {}),
    ...(requirements.sideMode ? { sideMode: requirements.sideMode } : {}),
  }, confirmations: { ...document.confirmations, physicalSize: false, backText: false, visualReview: false } };
}
