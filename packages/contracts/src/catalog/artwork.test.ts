import { describe, expect, it } from "vitest";
import {
  ArtworkLayoutSchema,
  CreativeRequirementsSchema,
  creativeRequirementsText,
} from "./artwork.js";

describe("creative requirements and reusable artwork placement", () => {
  const area = {
    fieldKey: "name",
    xPercent: 10,
    yPercent: 20,
    widthPercent: 80,
    heightPercent: 20,
  };
  it("rejects outside areas, duplicate regions and unbound fields", () => {
    expect(ArtworkLayoutSchema.safeParse([{ ...area, xPercent: 30 }]).success).toBe(false);
    expect(ArtworkLayoutSchema.safeParse([area, area]).success).toBe(false);
    expect(
      CreativeRequirementsSchema.safeParse({ mode: "personalized_text", layout: [area] }).success,
    ).toBe(false);
  });
  it("compiles buyer placeholders and acceptance requirements without actual buyer data", () => {
    const req = CreativeRequirementsSchema.parse({
      mode: "personalized_text",
      audience: "Pet owners",
      customization: {
        version: 1,
        fields: [{ key: "name", label: "宠物名字", type: "short_text", required: true }],
      },
      layout: [area],
      acceptance: "Keep the border intact",
    });
    expect(creativeRequirementsText(req)).toContain("宠物名字");
    expect(creativeRequirementsText(req)).toContain("Keep the border intact");
    expect(CreativeRequirementsSchema.safeParse({ ...req, mode: "fixed" }).success).toBe(false);
  });
});
