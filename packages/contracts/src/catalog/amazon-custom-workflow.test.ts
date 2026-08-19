import { describe, expect, it } from "vitest";

import {
  AMAZON_CUSTOM_WORKFLOW_STEPS,
  AmazonCustomWorkflowStepKeySchema,
  TransitionAmazonCustomWorkflowStepInputSchema,
  UpdateAmazonCustomWorkflowStepNoteInputSchema,
} from "./amazon-custom-workflow.js";

describe("Amazon Custom workflow contract", () => {
  it("keeps the employee SOP as a stable ordered 14-step definition", () => {
    expect(AMAZON_CUSTOM_WORKFLOW_STEPS).toHaveLength(14);
    expect(AMAZON_CUSTOM_WORKFLOW_STEPS[0]?.key).toBe("research_capture");
    expect(AMAZON_CUSTOM_WORKFLOW_STEPS[7]?.key).toBe("design_proof");
    expect(AMAZON_CUSTOM_WORKFLOW_STEPS[13]?.key).toBe("online_qa");
    expect(
      AMAZON_CUSTOM_WORKFLOW_STEPS.map((step) => step.key).every((key) =>
        AmazonCustomWorkflowStepKeySchema.safeParse(key).success,
      ),
    ).toBe(true);
  });

  it("requires an explicit reason when a step is blocked", () => {
    expect(
      TransitionAmazonCustomWorkflowStepInputSchema.safeParse({
        expectedRevision: 2,
        status: "blocked",
      }).success,
    ).toBe(false);
    expect(
      TransitionAmazonCustomWorkflowStepInputSchema.parse({
        expectedRevision: 2,
        note: "等待供应商确认定制区域尺寸",
        status: "blocked",
      }),
    ).toMatchObject({ status: "blocked" });
  });

  it("allows a completed step note to be edited or cleared", () => {
    expect(
      UpdateAmazonCustomWorkflowStepNoteInputSchema.parse({
        expectedRevision: 6,
        note: "已补充研究截图",
      }),
    ).toMatchObject({ note: "已补充研究截图" });
    expect(
      UpdateAmazonCustomWorkflowStepNoteInputSchema.parse({
        expectedRevision: 7,
        note: "   ",
      }),
    ).toMatchObject({ note: "" });
  });
});
