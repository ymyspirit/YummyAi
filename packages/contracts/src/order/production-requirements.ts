import type { AmazonReportDetailView } from "./report.js";
import type { PillowSubject } from "../pod/design-automation.js";

export type OrderProductionRequirements = {
  fields: Array<{ label: string; value: string; surface: string }>;
  sizeInches: number | null; sideMode: "single" | "double" | null;
  subject: PillowSubject | null; warnings: string[];
};

/** Only explicit platform options are executable; arbitrary buyer prose is not. */
export function pillowCropSubject(value: string): PillowSubject | null {
  const option = value.trim().normalize("NFC");
  if (/^(head|only face|face only|head only|only head|仅头部|只做头部)$/i.test(option)) return "head";
  if (/^(body|full body|whole body|全身)$/i.test(option)) return "body";
  if (/^(half[ _-]body|半身|上半身)$/i.test(option)) return "half_body";
  return null;
}

export function pillowPrintSide(value: string): "single" | "double" | null {
  const option = value.trim().normalize("NFC");
  if (/^(single_sided|single[ -]sided(?: print(?:ing)?)?|单面(?:印刷)?)$/i.test(option)) return "single";
  if (/^(double_sided|double[ -]sided(?: print(?:ing)?)?|double[ -]sided print\s*[—–-]\s*same photo on back|双面(?:印刷)?)$/i.test(option)) return "double";
  return null;
}
/** Explicit option mappings only. Customer text never supplies executable instructions. */
export function orderProductionRequirements(report: Pick<AmazonReportDetailView, "surfaces">): OrderProductionRequirements {
  const fields = report.surfaces.flatMap(surface => surface.fields.filter(field => field.kind !== "image" && !/upload.*image/i.test(field.label)).map(field => ({ label: field.label, value: field.value, surface: surface.label })));
  const sizes = new Set<number>(), sides = new Set<"single" | "double">(), subjects = new Set<PillowSubject>();
  const warnings: string[] = [];
  let unresolvedSize = false;
  for (const field of fields) {
    const value = field.value.trim().normalize("NFC");
    if (/\bsize\b|尺寸|规格/i.test(field.label)) {
      // A range ending in a supported size is not a selected size. Every size
      // declaration must be unambiguous; another valid field cannot hide it.
      // Marketplace options may append a descriptive name such as Mini
      // Keepsake. It cannot contain another quantity, unit or range operator.
      const match = value.match(/^(10|12|14|16|18|20|22|24)\s*(?:inches|inch|in\.?|英寸|["″])(?:\s*[-–—]\s*(\p{L}+(?:[ -]+\p{L}+){0,7}))?$/iu);
      const ambiguousSuffix = match?.[2] && /\b(?:or|to|through|and|inches?|in|cm|mm)\b/i.test(match[2]);
      if (match && !ambiguousSuffix) sizes.add(Number(match[1]));
      else if (value) {
        unresolvedSize = true;
        warnings.push("尺寸选项无法唯一识别，请对照原文填写。");
      }
    }
    if (/style|printing|pillow shape|印刷|款式|范围|部位/i.test(field.label)) {
      const side = pillowPrintSide(value), subject = pillowCropSubject(value);
      if (side) sides.add(side);
      if (subject) subjects.add(subject);
    }
  }
  if (sizes.size > 1 || sides.size > 1 || subjects.size > 1) warnings.push("多个定制选项存在冲突，请按当前商品确认。");
  return { fields, sizeInches: !unresolvedSize && sizes.size === 1 ? [...sizes][0]! : null, sideMode: sides.size === 1 ? [...sides][0]! : null, subject: subjects.size === 1 ? [...subjects][0]! : null, warnings };
}
