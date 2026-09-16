import { describe, expect, it } from "vitest";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import {
  ResearchStudyContentSchema,
  type ResearchSourceReference,
} from "@yummyai/contracts/research/creative";
import { fillResearchRequirements, researchProjectPrompt } from "./research-brief";

describe("research requirement summaries", () => {
  it("preserves operator decisions and keeps observed competitor elements separate", () => {
    const source = {
      title: "Synthetic competitor",
      content: ResearchStudyContentSchema.parse({
        audience: "研究中的人群",
        style: "简洁",
        fixedElements: "竞品专属图案",
        differentiation: "原创花卉",
        customizationNotes: "预留名字",
      }),
    } as ResearchSourceReference;
    const current = CreativeRequirementsSchema.parse({ mode: "mixed", audience: "运营确认的人群" });
    const filled = fillResearchRequirements(current, [source]);
    expect(filled.audience).toBe("运营确认的人群");
    expect(filled.style).toBe("简洁");
    expect(filled.fixedElements).toBe("");
    expect(filled.mode).toBe("mixed");
    expect(researchProjectPrompt([source])).toContain("原创花卉");
    expect(researchProjectPrompt([source])).toContain("预留名字");
  });
});
