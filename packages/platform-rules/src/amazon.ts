import type { PlatformRules } from "./types.js";

export const amazonRules: PlatformRules = {
  platform: "amazon",
  version: "amazon-2026.07",
  effectiveAt: "2026-07-01T00:00:00.000Z",
  requiredPaths: ["title", "description", "mainImageId", "variants", "attributes.brand", "compliance.countryOfOrigin"],
  limits: { title: 200, description: 2_000, bullets: 5, bulletLength: 500, media: 9 },
  validate(draft) {
    const issues: ReturnType<PlatformRules["validate"]> = [];
    if (draft.bullets.length > 5) issues.push(blocker("amazon.bullets.max", "bullets", "Amazon supports at most 5 bullet points"));
    draft.bullets.forEach((bullet, index) => {
      if (bullet.length > 500) issues.push(blocker("amazon.bullet.length", `bullets.${index}`, "Bullet point exceeds 500 characters"));
    });
    if (draft.mediaAssetIds.length > 9) issues.push(blocker("amazon.media.max", "mediaAssetIds", "Amazon supports at most 9 media assets"));
    if (!draft.aPlusModules?.length) issues.push(warning("amazon.aplus.missing", "aPlusModules", "No A+ content plan is attached"));
    if (/[!$?_{}^¬¦]/u.test(draft.title)) issues.push(blocker("amazon.title.characters", "title", "Title contains a character prohibited by Amazon title policy"));
    return issues;
  },
};

function blocker(code: string, path: string, message: string) { return { severity: "blocker" as const, code, path, message }; }
function warning(code: string, path: string, message: string) { return { severity: "warning" as const, code, path, message }; }
