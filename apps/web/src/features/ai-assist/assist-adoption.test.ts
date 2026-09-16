import { describe, expect, it } from "vitest";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { AssistDirectionSchema, type AssistMatch } from "@yummyai/contracts/ai/assist";
import { OrderWorkDraftSchema, type OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { adoptCreativeRequirements, adoptOrderMatch } from "./assist-adoption";
import { sameAssistInput } from "./assist-client";
const id = (n: number) => `019f0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const direction = AssistDirectionSchema.parse({
  title: "测试原创方向",
  rationale: "来自研究",
  prompt: "新方案",
  negativePrompt: "",
  requirements: { mode: "personalized_text", audience: "AI 建议人群", style: "AI 建议风格" },
  fields: [
    {
      key: "name",
      label: "名字",
      type: "short_text",
      required: true,
      maxLength: 20,
      helpText: "按买家原文",
    },
  ],
  evidence: [],
});
describe("operator adoption", () => {
  it("only replaces selected fields and preserves research and product pins", () => {
    const current = CreativeRequirementsSchema.parse({
      mode: "fixed",
      audience: "运营确认人群",
      style: "原风格",
      researchItemIds: [id(1)],
      specificationVersionIds: [id(2)],
    });
    const next = adoptCreativeRequirements(current, direction, ["style"]);
    expect(next.style).toBe("AI 建议风格");
    expect(next.audience).toBe(current.audience);
    expect(next.mode).toBe("fixed");
    expect(next.researchItemIds).toEqual([id(1)]);
    expect(next.specificationVersionIds).toEqual([id(2)]);
    expect(current.style).toBe("原风格");
    expect(
      adoptCreativeRequirements(current, direction, ["customization"]).customization.fields[0],
    ).toMatchObject({ key: "name", required: true });
  });
  it("changes only the matching draft, retaining buyer text and images", () => {
    const current = OrderWorkDraftSchema.parse({
      printProfileVersionId: null,
      fields: [{ key: "name", kind: "text", label: "名字", value: "Alice / 2026-09-13" }],
      images: [{ origin: "report", key: "private-file", usage: "photo" }],
      instructions: "不要修改买家文字",
      customerApprovalRequired: true,
      dueAt: null,
    });
    const detail = {
      catalog: {
        artworks: [
          {
            id: id(1),
            customization: {
              fields: [
                { key: "name", label: "名字", type: "short_text" },
                { key: "date", label: "日期", type: "short_text" },
              ],
            },
          },
        ],
        specifications: [{ id: id(2), processProfileVersionId: id(3) }],
      },
    } as unknown as OrderWorkDetail;
    const match: AssistMatch = {
      artworkVersionId: id(1),
      specificationVersionId: id(2),
      reason: "依据资料",
      evidence: [],
    };
    const next = adoptOrderMatch(current, detail, match);
    expect(next.fields[0]).toEqual(current.fields[0]);
    expect(next.images).toEqual(current.images);
    expect(next.instructions).toBe(current.instructions);
    expect(next.fields[1]).toEqual({ key: "date", kind: "text", label: "日期", value: "" });
    expect(next.printProfileVersionId).toBe(id(3));
    expect(() => adoptOrderMatch(current, detail, { ...match, artworkVersionId: id(8) })).toThrow(
      "候选已不在当前资料库",
    );
  });
  it("detects changed order or editor versions before adoption", () => {
    const input = {
      kind: "artwork_preflight" as const,
      orderLineId: id(1),
      expectedRevision: 2,
      expectedEditorVersionId: id(3),
    };
    const request = { ...input, requestId: id(4), modelId: id(5) };
    expect(sameAssistInput(request, input)).toBe(true);
    expect(sameAssistInput(request, { ...input, expectedEditorVersionId: id(6) })).toBe(false);
    expect(sameAssistInput(request, { ...input, expectedRevision: 3 })).toBe(false);
  });
});
