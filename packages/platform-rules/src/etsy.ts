import type { PlatformRules } from "./types.js";

export const etsyRules: PlatformRules = {
  platform: "etsy",
  version: "etsy-2026.07",
  effectiveAt: "2026-07-01T00:00:00.000Z",
  requiredPaths: ["title", "description", "mainImageId", "mediaAssetIds", "variants"],
  limits: { title: 140, description: 5_000, tags: 13, tagLength: 20, media: 20 },
  validate(draft) {
    const issues: ReturnType<PlatformRules["validate"]> = [];
    if (draft.tags.length > 13) issues.push(blocker("etsy.tags.max", "tags", "Etsy supports at most 13 tags"));
    draft.tags.forEach((tag, index) => {
      if (tag.length > 20) issues.push(blocker("etsy.tag.length", `tags.${index}`, "Etsy tags cannot exceed 20 characters"));
    });
    if (draft.mediaAssetIds.length > 20) issues.push(blocker("etsy.media.max", "mediaAssetIds", "Etsy supports at most 20 listing photos"));
    if (draft.personalization?.enabled && !draft.personalization.instructions?.trim()) {
      issues.push(blocker("etsy.personalization.instructions", "personalization.instructions", "Personalization instructions are required when personalization is enabled"));
    }
    if (new Set(draft.tags.map((tag) => tag.toLocaleLowerCase())).size !== draft.tags.length) {
      issues.push(warning("etsy.tags.duplicate", "tags", "Duplicate tags reduce search coverage"));
    }
    return issues;
  },
};

function blocker(code: string, path: string, message: string) { return { severity: "blocker" as const, code, path, message }; }
function warning(code: string, path: string, message: string) { return { severity: "warning" as const, code, path, message }; }
