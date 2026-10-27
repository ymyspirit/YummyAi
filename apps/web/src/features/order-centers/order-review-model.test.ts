import { describe, expect, it } from "vitest";
import type { OrderIntakeCheck, OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { orderIntakeSnapshot } from "./order-work-input-model";
import { orderReviewCheckCurrent, orderReviewIssueTarget, orderReviewLineState, type OrderReviewCheckState } from "./order-review-model";

const draft: OrderWorkDraft = { artworkVersionId: null, printProfileVersionId: null, fields: [], images: [], instructions: "保留帽子", dueAt: null, customerApprovalRequired: false };
const detail = { line: { id: "synthetic-line", revision: 3, projectionVersion: 7 }, report: { versionId: "synthetic-source" } } as Pick<OrderWorkDetail, "line" | "report">;
const snapshot = orderIntakeSnapshot(detail, draft);
const check: OrderIntakeCheck = { orderLineId: snapshot.orderLineId, revision: 3, sourceVersionId: snapshot.sourceVersionId,
  ready: true, basis: "manual", package: null, fields: [], issues: [], normalizedDraft: draft, notes: [] };
const state: OrderReviewCheckState = { orderLineId: snapshot.orderLineId, input: snapshot.input, projectionVersion: 7, lineState: orderReviewLineState(detail), status: "ready", check, error: null };

describe("current order review readiness", () => {
  it("accepts only the same draft and receipt identity", () => {
    expect(orderReviewCheckCurrent(state, detail, draft)).toBe(true);
    expect(orderReviewCheckCurrent(state, detail, { ...draft, instructions: "保留耳朵" })).toBe(false);
    expect(orderReviewCheckCurrent({ ...state, check: { ...check, revision: 2 } }, detail, draft)).toBe(false);
    expect(orderReviewCheckCurrent(null, detail, draft)).toBe(false);
  });
  it("invalidates previous readiness for a new source, order or projection", () => {
    expect(orderReviewCheckCurrent(state, { ...detail, report: { ...detail.report!, versionId: "new-source" } }, draft)).toBe(false);
    expect(orderReviewCheckCurrent(state, { ...detail, line: { ...detail.line, id: "other-line" } }, draft)).toBe(false);
    expect(orderReviewCheckCurrent(state, { ...detail, line: { ...detail.line, projectionVersion: 8 } }, draft)).toBe(false);
    expect(orderReviewCheckCurrent(state, { ...detail, line: { ...detail.line, held: true } }, draft)).toBe(false);
    expect(orderReviewCheckCurrent(state, { ...detail, line: { ...detail.line, archivedAt: "2026-10-27T06:00:00Z" } }, draft)).toBe(false);
  });
  it("keeps checking and failure states tied to their precise current input", () => {
    const failed = { ...state, status: "failed" as const, check: null, error: "网络不可用" };
    expect(orderReviewCheckCurrent(failed, detail, draft)).toBe(true);
    expect(orderReviewCheckCurrent(failed, detail, { ...draft, designExecutor: "human" })).toBe(false);
  });
});

describe("actionable order review issue routing", () => {
  const issue = (code: string, fieldKey: string | null = null) => ({ code, fieldKey, message: "需要核对", action: "查看对应内容" });
  it("locates the actual image field even when the issue code is generic", () => {
    const actual = { ...check, fields: [{ key: "photo", label: "顾客原图", type: "image", required: true, status: "missing" as const, sourceKeys: ["raw-photo"], imageCount: 0 }] };
    expect(orderReviewIssueTarget(issue("missing_required", "photo"), actual)).toBe("images");
    expect(orderReviewIssueTarget(issue("missing_required", "raw-photo"), actual)).toBe("images");
  });
  it("keeps special customer instructions distinct from a generic design route issue", () => {
    expect(orderReviewIssueTarget(issue("automatic_artwork_not_ready", "customer_notes"))).toBe("requirements");
    expect(orderReviewIssueTarget(issue("automatic_artwork_not_ready", "instructions"))).toBe("requirements");
    expect(orderReviewIssueTarget(issue("automatic_artwork_not_ready"))).toBe("design");
  });
  it("locates status and version blockers instead of inventing missing customization", () => {
    expect(orderReviewIssueTarget(issue("order_held"))).toBe("status");
    expect(orderReviewIssueTarget(issue("source_changed"))).toBe("status");
    expect(orderReviewIssueTarget(issue("basis_or_image_invalid"))).toBe("basis");
    expect(orderReviewIssueTarget({ ...issue("basis_or_image_invalid"), message: "请核对买家原图" })).toBe("images");
    expect(orderReviewIssueTarget(issue("missing_profile"))).toBe("basis");
  });
});
