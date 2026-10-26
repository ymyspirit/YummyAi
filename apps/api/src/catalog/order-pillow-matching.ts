import type { AmazonReportDetailView } from "@yummyai/contracts/order/report";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import type { OrderAutomaticBasis } from "@yummyai/contracts/order/automatic-basis";
import { orderProductionRequirements } from "@yummyai/contracts/order/production-requirements";

type SpecificationCandidate = {
  id: string; spuId: string; spuCode: string; name: string; code?: string;
  sizeInches?: number | null; processProfileVersionId: string | null;
  productionReady?: boolean; issues?: string[];
};

/** Exact structured catalog identity only; packaging dimensions are not artwork sizes. */
export function pillowSpecificationSize(code: string, attributes: Record<string, string>): number | null {
  const codeSize = code.match(/^SIZE-(10|12|14|16|18|20|22|24)IN$/i)?.[1];
  const values = Object.entries(attributes).filter(([key]) => /^(size|尺寸|规格)$/i.test(key));
  const sizes = values.map(([, value]) => value.trim().match(/^(10|12|14|16|18|20|22|24)\s*(?:inches|inch|in\.?|英寸|["″])$/i)?.[1]);
  if (!codeSize || sizes.some(size => !size || size !== codeSize)) return null;
  return Number(codeSize);
}

/** This only prepares editable intake fields. It never reviews a template or dispatches work. */
export function resolvePillowOrderBasis(input: {
  report: Pick<AmazonReportDetailView, "surfaces"> | null;
  productTitle?: string;
  sourceVersionId: string | null;
  draft: OrderWorkDraft;
  preserve: boolean;
  controlledDelivery: boolean;
  specifications: SpecificationCandidate[];
  artworks?: Array<{ id: string; code: string; mode: string; version: number; materials: Array<{ role: string }> }>;
}): OrderAutomaticBasis {
  const requirements = input.report ? orderProductionRequirements(input.report) : null;
  const base: OrderAutomaticBasis = {
    status: "missing", sourceVersionId: input.sourceVersionId,
    sizeInches: requirements?.sizeInches ?? null,
    spuId: null, specificationVersionId: null, processProfileVersionId: null, artworkVersionId: null,
    applied: false, reasons: [], issues: [],
  };
  if (input.preserve || input.draft.salesRecipeVersionId || input.draft.salesPackageId ||
      input.draft.specificationVersionId || input.draft.printProfileVersionId || input.draft.artworkVersionId) {
    const pinned = input.specifications.find(candidate => candidate.id === input.draft.specificationVersionId);
    return { ...base, status: "preserved", spuId: pinned?.spuId ?? null,
      specificationVersionId: input.draft.specificationVersionId ?? null,
      processProfileVersionId: input.draft.printProfileVersionId,
      artworkVersionId: input.draft.artworkVersionId ?? null,
      reasons: ["保留本单已选或已保存的制作依据；目录更新不会覆盖本单固定版本。"] };
  }
  if (input.controlledDelivery)
    return { ...base, status: "conflict", issues: ["本渠道有封存资料，需要先核对下单时映射，不能以通用规格替代。"] };
  const title = input.productTitle ?? "";
  const shapedPillow = /异形.*抱枕|抱枕.*异形/i.test(title) ||
    (/\bpillows?\b/i.test(title) && /\b(?:shaped?|cutout)\b/i.test(title) && !/\b(?:cases?|covers?)\b/i.test(title));
  if (!shapedPillow)
    return { ...base, issues: ["尚未确认本单属于异形抱枕，保留人工匹配。"] };
  if (!requirements || !input.sourceVersionId)
    return { ...base, issues: ["尚未取得本单定制资料版本，不能自动匹配规格。"] };
  if (requirements.sizeInches === null) {
    const warnings = requirements.warnings.filter(warning => /尺寸|冲突/.test(warning));
    return { ...base, status: warnings.length ? "ambiguous" : "missing",
      issues: warnings.length ? warnings : ["定制信息缺少明确尺寸；商品标题中的可选范围不作为顾客选择。"] };
  }
  const candidates = input.specifications.filter(candidate =>
    candidate.spuCode === "CUSTOM-SHAPED-PILLOW" && candidate.sizeInches === requirements.sizeInches);
  if (candidates.length !== 1)
    return { ...base, status: candidates.length > 1 ? "ambiguous" : "missing",
      issues: [candidates.length > 1 ? "相同尺寸有多个规格候选，请核对产品配置。" : `目录中没有 ${requirements.sizeInches} 英寸的唯一异形抱枕规格。`] };
  const candidate = candidates[0]!;
  const issues = [...(candidate.issues ?? []), ...requirements.warnings];
  const commonArtwork = input.artworks?.filter(artwork => artwork.code === "ART-CUSTOM-SHAPED-PILLOW");
  const latestArtworkVersion = Math.max(0, ...(commonArtwork?.map(artwork => artwork.version) ?? []));
  const artworks = commonArtwork?.filter(artwork => artwork.version === latestArtworkVersion &&
    artwork.mode === "customer_image" && artwork.materials.every(material => material.role === "reference")) ?? [];
  const artworkVersionId = artworks.length === 1 ? artworks[0]!.id : null;
  if (input.artworks && !artworkVersionId)
    issues.push(artworks.length > 1 ? "通用来图方案存在多个当前版本，请核对商品配置。" : "尚未配置唯一的异形抱枕通用来图方案。");
  if (!candidate.processProfileVersionId && !issues.some(issue => /底稿/.test(issue)))
    issues.push("该尺寸尚未绑定已审核通用工艺底稿；补齐一次后同规格订单可复用。");
  if (candidate.productionReady === false && !issues.length)
    issues.push("规格生产资料待核对，匹配不代表生产放行。");
  return { ...base, status: issues.length ? "partial" : "matched", applied: true,
    spuId: candidate.spuId, specificationVersionId: candidate.id,
    processProfileVersionId: candidate.processProfileVersionId, artworkVersionId,
    reasons: [`按顾客明确选择的 ${requirements.sizeInches} 英寸匹配异形抱枕规格。`,
      "只带入本单需求草稿，仍需按已固定工艺核对、审核和生产放行。"], issues };
}
