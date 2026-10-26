import type { AmazonReportDetailView } from "./report.js";
import type { PillowSubject } from "../pod/design-automation.js";

export type OrderProductionRequirements = {
  fields: Array<{ label: string; value: string; surface: string }>;
  sizeInches: number | null; sideMode: "single" | "double" | null;
  subject: PillowSubject | null; warnings: string[];
};
/** Explicit option mappings only. Customer text never supplies executable instructions. */
export function orderProductionRequirements(report: Pick<AmazonReportDetailView, "surfaces">): OrderProductionRequirements {
  const fields = report.surfaces.flatMap(surface => surface.fields.filter(field => field.kind !== "image" && !/upload.*image/i.test(field.label)).map(field => ({ label: field.label, value: field.value, surface: surface.label })));
  const sizes = new Set<number>(), sides = new Set<"single" | "double">(), subjects = new Set<PillowSubject>();
  const warnings: string[] = [];
  let unresolvedSize = false;
  for (const field of fields) {
    const value = field.value.trim();
    if (/\bsize\b|尺寸|规格/i.test(field.label)) {
      // A range ending in a supported size is not a selected size. Every size
      // declaration must be unambiguous; another valid field cannot hide it.
      const match = value.match(/^(10|12|14|16|18|20|22|24)\s*(?:inches|inch|in\.?|英寸|["″])(?:\s*[-–—]\s*(?:very small|extra small|small|medium|large|extra large|very large|x[- ]?large|xx[- ]?large))?$/i);
      if (match) sizes.add(Number(match[1]));
      else if (value) {
        unresolvedSize = true;
        warnings.push("尺寸选项无法唯一识别，请对照原文填写。");
      }
    }
    if (/style|printing|印刷|款式|范围|部位/i.test(field.label)) {
      if (/^(single[ -]sided printing|单面印刷)$/i.test(value)) sides.add("single");
      if (/^(double[ -]sided printing|双面印刷)$/i.test(value)) sides.add("double");
      if (/^(only face|face only|head only|only head|仅头部|只做头部)$/i.test(value)) subjects.add("head");
      if (/^(full body|whole body|全身)$/i.test(value)) subjects.add("body");
      if (/^(half[ _-]body|半身|上半身)$/i.test(value)) subjects.add("half_body");
    }
  }
  if (sizes.size > 1 || sides.size > 1 || subjects.size > 1) warnings.push("多个定制选项存在冲突，请按当前商品确认。");
  return { fields, sizeInches: !unresolvedSize && sizes.size === 1 ? [...sizes][0]! : null, sideMode: sides.size === 1 ? [...sides][0]! : null, subject: subjects.size === 1 ? [...subjects][0]! : null, warnings };
}
