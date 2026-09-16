import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts/common/ids";
import {
  ResearchStudyContentSchema,
  SaveResearchStudyInputSchema,
} from "@yummyai/contracts/research/creative";
import { CreateCanvasBriefInputSchema } from "@yummyai/contracts/pod/canvas-bridge";

describe("research conclusions and creative source contracts", () => {
  it("requires an original direction for analyzed research and distinct media notes", () => {
    const input = {
      requestId: crypto.randomUUID(),
      snapshotId: createEntityId(),
      expectedVersion: 0,
      content: { status: "analyzed", theme: "Test" },
    };
    expect(SaveResearchStudyInputSchema.safeParse(input).success).toBe(false);
    expect(
      SaveResearchStudyInputSchema.safeParse({
        ...input,
        content: { ...input.content, differentiation: "New original composition" },
      }).success,
    ).toBe(true);
    expect(
      ResearchStudyContentSchema.safeParse({
        annotations: [
          { mediaIndex: 0, note: "one" },
          { mediaIndex: 0, note: "two" },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects version pins outside the selected source set and caller-authored reference contents", () => {
    const id = createEntityId(),
      input = {
        requestId: crypto.randomUUID(),
        name: "Brief",
        prompt: "Original artwork",
        requirements: { mode: "fixed", researchItemIds: [id] },
      };
    expect(
      CreateCanvasBriefInputSchema.safeParse({
        ...input,
        researchSources: [
          { researchItemId: id, snapshotId: createEntityId(), studyRevisionId: null },
        ],
      }).success,
    ).toBe(true);
    expect(
      CreateCanvasBriefInputSchema.safeParse({
        ...input,
        researchSources: [{ researchItemId: createEntityId() }],
      }).success,
    ).toBe(false);
    expect(
      CreateCanvasBriefInputSchema.safeParse({
        ...input,
        researchSources: [{ researchItemId: id, content: { theme: "Caller data" } }],
      }).success,
    ).toBe(false);
  });
});
