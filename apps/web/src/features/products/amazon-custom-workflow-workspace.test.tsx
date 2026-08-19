import {
  AMAZON_CUSTOM_WORKFLOW_STEPS,
  type AmazonCustomWorkflowDetail,
  type AmazonCustomWorkflowSummary,
} from "@yummyai/contracts/catalog/amazon-custom-workflow";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AmazonCustomWorkflowWorkspace } from "./amazon-custom-workflow-workspace";

describe("Amazon Custom workflow workspace", () => {
  it("shows every product and the selected product's executable 14-step workflow", () => {
    const detail = workflowDetail();
    const items: AmazonCustomWorkflowSummary[] = [
      detail,
      {
        productPlanId: "019fb700-0000-7000-8000-000000000002",
        productName: "Photo logo plaque",
        productStatus: "researching",
        skuCodes: [],
        status: "not_started",
        completedSteps: 0,
        totalSteps: 14,
        currentStepKey: "research_capture",
        currentStepTitle: "录入竞品研究资料",
        currentStepStatus: "not_started",
        revision: 0,
        updatedAt: "2026-07-31T08:00:00.000Z",
      },
    ];

    const html = renderToStaticMarkup(
      <AmazonCustomWorkflowWorkspace
        detail={detail}
        items={items}
        selectedPlanId={detail.productPlanId}
      />,
    );

    expect(html).toContain("产品开发进度");
    expect(html).toContain("Vintage photo cake topper");
    expect(html).toContain("Photo logo plaque");
    expect(html).toContain("完成设计校样");
    expect(html).toContain("完成");
    expect(html).toContain("设为阻断");
    expect(html).toContain("编辑完成记录");
    expect(html).toContain("保存说明");
    expect(html).toContain("事件记录");
    expect(html.match(/custom-workflow-step-row/g)).toHaveLength(14);
    expect(html).toContain(
      `/products?plan=${detail.productPlanId}#product-detail`,
    );
  });
});

function workflowDetail(): AmazonCustomWorkflowDetail {
  const planId = "019fb700-0000-7000-8000-000000000001";
  return {
    workflowId: "019fb700-0000-7000-8000-000000000010",
    productPlanId: planId,
    productName: "Vintage photo cake topper",
    productStatus: "developing",
    ownerName: "YummyAI Operator",
    spuCode: "VPHOTO-TOPPER",
    skuCodes: ["VPHOTO-TOPPER-001"],
    status: "active",
    completedSteps: 7,
    totalSteps: 14,
    currentStepKey: "design_proof",
    currentStepTitle: "完成设计校样",
    currentStepStatus: "in_progress",
    revision: 9,
    updatedAt: "2026-07-31T08:00:00.000Z",
    steps: AMAZON_CUSTOM_WORKFLOW_STEPS.map((step, index) => ({
      ...step,
      status: index < 7 ? ("completed" as const) : index === 7 ? ("in_progress" as const) : ("not_started" as const),
      ...(index <= 7
        ? {
            startedAt: "2026-07-31T07:00:00.000Z",
            updatedAt: "2026-07-31T08:00:00.000Z",
            updatedByName: "YummyAI Operator",
          }
        : {}),
      ...(index < 7
        ? {
            completedAt: "2026-07-31T07:30:00.000Z",
            note: index === 0 ? "研究资料已确认" : undefined,
          }
        : {}),
    })),
    events: [
      {
        id: "019fb700-0000-7000-8000-000000000020",
        stepKey: "design_proof",
        action: "step_started",
        fromStatus: "not_started",
        toStatus: "in_progress",
        actorName: "YummyAI Operator",
        revision: 9,
        occurredAt: "2026-07-31T08:00:00.000Z",
      },
    ],
  };
}
