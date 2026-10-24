import type { CreativeRequirements } from "@yummyai/contracts/catalog/artwork";
import type { ResearchSourceReference } from "@yummyai/contracts/research/creative";

export function researchProjectName(sources: ResearchSourceReference[]) {
  return `${sources.map((source) => source.content?.theme || source.title).join(" / ")} · 创意`.slice(
    0,
    160,
  );
}
export function researchProjectPrompt(sources: ResearchSourceReference[]) {
  return (
    sources
      .map((source, index) =>
        [
          `研究方向 ${index + 1}：${source.content?.theme || source.title}`,
          source.content?.differentiation
            ? `原创方向：${source.content.differentiation}`
            : "请补充本项目的原创设计方向。",
          source.content?.customizationNotes
            ? `定制思路：${source.content.customizationNotes}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n")
      .slice(0, 7800) +
    "\n\n以上为需求提要，完整研究结论和媒体批注见研究依据。请确认本项目的定制类型与交付要求。"
  );
}
export function fillResearchRequirements(
  current: CreativeRequirements,
  sources: ResearchSourceReference[],
): CreativeRequirements {
  const result = { ...current };
  for (const [key, max] of [
    ["audience", 500],
    ["occasion", 500],
    ["style", 1000],
    ["imageInstructions", 2000],
    ["acceptance", 3000],
  ] as const) {
    if (!result[key].trim())
      result[key] = [...new Set(sources.map((source) => source.content?.[key]).filter(Boolean))]
        .join("\n")
        .slice(0, max);
  }
  // Observed competitor elements are evidence; the operator chooses the original fixed elements.
  return result;
}
