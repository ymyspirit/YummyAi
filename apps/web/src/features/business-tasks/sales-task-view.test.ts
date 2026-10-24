import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { PreparationViewSchema } from "@yummyai/contracts/catalog/sales-plan-agent";
import { BusinessTaskViewSchema } from "@yummyai/contracts/operations/business-task";
import { salesTaskView } from "./sales-task-view";
describe("sales preparation task display", () => {
  it("invalidates old checks after source changes without claiming publication or invented cost", () => {
    const view = PreparationViewSchema.parse({ run: { id: createEntityId(), planId: createEntityId(), revision: 2, planRevision: 1, status: "ready", goal: "准备当前销售方案至可提交刊登审核", message: "Ready for review", steps: [{ key: "product", label: "载体", state: "passed", detail: "Pinned", href: "/sales-plans" }], evidence: [], listingId: null, listingVersionId: null, analyses: [], toolCalls: 1, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:05Z" }, currentPlanRevision: 1, sourceChanged: false, busy: false, canContinue: false, history: [], analysis: null });
    const task = salesTaskView(view); expect(BusinessTaskViewSchema.safeParse(task).success).toBe(true); expect(task.state).toBe("done");
    expect(task.goal).toContain("审核"); expect(task.metrics.find(row => row.key === "analysis")!.value).toBeNull();
    view.sourceChanged = true; expect(salesTaskView(view)).toMatchObject({ state: "blocked", stages: [{ state: "pending" }] });
    view.run.status = "cancelled"; expect(salesTaskView(view).state).toBe("cancelled");
  });
});
