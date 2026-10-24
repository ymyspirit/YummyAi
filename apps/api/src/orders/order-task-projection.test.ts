import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import type { WholeOrderDetailView } from "@yummyai/contracts/order/whole-detail";
import { OrderDesignAgentRunViewSchema } from "@yummyai/contracts/order/design-agent";
import type { LogisticsTaskView } from "@yummyai/contracts/logistics";
import { BusinessTaskViewSchema } from "@yummyai/contracts/operations/business-task";
import { aggregateTaskState, projectOrderTask } from "./order-task-projection.js";

export function taskFixture(): WholeOrderDetailView {
  const orderId = createEntityId(), line = { id: createEntityId(), orderId, externalOrderId: "Synthetic task order", externalLineId: "Synthetic item", quantity: 2,
    revision: 1, projectionVersion: 1, preparation: "pushed", artwork: "approved", proof: "not_required", production: "planned", held: false, sourceChanged: false,
    archivedAt: null, orderStatus: "processing", designRunStatus: "awaiting_review", afterSalesCount: 0, shippedQuantity: 0, readyQuantity: 0, dueAt: null, sideState: null } as OrderWorkListItem;
  return { orderId, items: [{ line, summary: { data: null, error: null }, artwork: { data: { versionId: createEntityId(), versionNumber: 2, approved: true, approvedVersionNumber: 2, preview: null, productionFile: { name: "pillow.jpg", path: "/private/pillow.jpg" }, productionPending: false }, error: null } }],
    fulfillment: { data: { orderId, orderNumber: line.externalOrderId, orderStatus: "processing", quantity: 2, shipmentIds: [], platformConfirmationPending: false, shipmentSources: [], factories: [], factoryDiagnostics: [],
      items: [{ lineId: line.id, quantity: 2, expectedRevision: 1, expectedProjectionVersion: 1, externalLineId: line.externalLineId, title: "Synthetic pillow", sku: null, specification: null,
        readyQuantity: 0, shippedQuantity: 0, renderId: createEntityId(), fileName: "pillow.jpg", editorVersionNumber: 2, productionBlockers: [], shipmentBlockers: [], operationBlockers: [],
        production: { id: createEntityId(), status: "planned", projectionVersion: 1, wholeOrder: true, qualityResult: null } }] }, error: null },
    production: { data: [], error: null }, shipments: { data: [], error: null }, cases: { data: [], error: null }, shipos: { data: [], error: null } };
}
function run(whole: WholeOrderDetailView) {
  return OrderDesignAgentRunViewSchema.parse({ id: createEntityId(), workItemId: whole.items[0]!.line.id, workRevisionId: createEntityId(), revision: 1, status: "awaiting_review", executorKey: "fixture", recipeVersion: "v1", policyVersion: "v1", modelRouteId: null, projectId: null, currentEditorVersionId: null,
    createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:03Z", errorCode: null, canResume: false, canTakeOver: true, estimatedCostUsd: null, actualCostUsd: null, costStatus: "unknown", qualityDiagnostics: [],
    steps: [{ id: createEntityId(), key: "preflight", label: "检查", status: "completed", attempt: 1, errorCode: null, outputAssetId: null, outputVersionId: null, startedAt: "2026-10-13T00:00:00Z", completedAt: "2026-10-13T00:00:03Z" }] });
}
const delivery = { state: "waiting" as const, detail: "等待工厂真实回执", href: "/production", evidence: [] };
const project = (whole: WholeOrderDetailView) => projectOrderTask({ whole, logistics: { data: [], error: null }, design: { data: [], error: null }, delivery });
describe("business task evidence projection", () => {
  it("does not confuse a completed label, formal file or factory ZIP with QC and actual dispatch", () => {
    const whole = taskFixture(), task = projectOrderTask({ whole, logistics: { data: [{ id: createEntityId(), factoryName: "Synthetic", status: "completed" } as LogisticsTaskView], error: null }, design: { data: [], error: null }, delivery });
    expect(BusinessTaskViewSchema.safeParse(task).success).toBe(true);
    expect(task.stages.find(row => row.key === "logistics")!.state).toBe("done");
    expect(task.stages.find(row => row.key === "files")!.state).toBe("done");
    expect(task.stages.find(row => row.key === "quality")!.state).toBe("working");
    expect(task.stages.find(row => row.key === "shipment")!.state).toBe("pending");
    whole.fulfillment.data!.items[0]!.readyQuantity = 1;
    expect(project(whole).stages.find(row => row.key === "quality")!.state).not.toBe("done");
    whole.fulfillment.data!.orderStatus = "shipped"; whole.fulfillment.data!.platformConfirmationPending = true;
    expect(project(whole).stages.find(row => row.key === "shipment")!.state).toBe("waiting");
    whole.fulfillment.data!.platformConfirmationPending = false;
    expect(project(whole).stages.find(row => row.key === "shipment")!.state).toBe("done");
  });
  it("requires current approval and preserves unavailable, changed and cancelled states", () => {
    const whole = taskFixture(); whole.items[0]!.line.proof = "approved"; whole.items[0]!.line.proofVersionCurrent = false;
    expect(project(whole).stages.find(row => row.key === "review")!.state).toBe("waiting");
    whole.items[0]!.line.proofVersionCurrent = true;
    expect(project(whole).stages.find(row => row.key === "review")!.state).toBe("done");
    whole.items[0]!.artwork = { data: null, error: "审核稿暂不可用" };
    expect(project(whole).stages.find(row => row.key === "files")!.state).toBe("unavailable");
    whole.items[0]!.line.sourceChanged = true; expect(project(whole).state).toBe("blocked");
    whole.items[0]!.line.orderStatus = "voided"; expect(project(whole).state).toBe("cancelled");
    expect(aggregateTaskState([])).toBe("pending");
  });
  it("reports measured costs and checks only, without inventing success from a completed check", () => {
    const whole = taskFixture(), record = run(whole);
    const read = () => projectOrderTask({ whole, delivery, logistics: { data: [], error: null }, design: { data: [record], error: null } }).metrics;
    expect(read().find(row => row.key === "cost")!.value).toBeNull();
    expect(read().find(row => row.key === "first_pass")!.value).toBe("1 / 1");
    expect(read().find(row => row.key === "duration")!.value).toBe("3 秒");
    record.qualityDiagnostics.push({ code: "low_dpi", severity: "error", message: "Synthetic failed check" });
    expect(read().find(row => row.key === "first_pass")!.value).toBe("0 / 1");
    record.qualityDiagnostics = []; record.steps[0]!.attempt = 2; record.actualCostUsd = 0.18;
    expect(read().find(row => row.key === "first_pass")!.value).toBe("0 / 1");
    expect(read().find(row => row.key === "retries")!.value).toBe("1");
    expect(read().find(row => row.key === "cost")!.value).toBe("0.1800 USD");
  });
});
