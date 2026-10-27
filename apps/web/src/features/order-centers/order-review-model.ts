import type { OrderIntakeCheck, OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { orderIntakeReceiptMatches, orderIntakeSnapshot } from "./order-work-input-model";

export type OrderReviewTarget = "basis" | "requirements" | "images" | "design" | "deadline" | "status";
export type OrderReviewCheckState = {
  orderLineId: string;
  input: string;
  projectionVersion?: number;
  lineState?: string;
  status: "checking" | "ready" | "blocked" | "failed";
  check: OrderIntakeCheck | null;
  error: string | null;
};

export function orderReviewLineState(detail: Pick<OrderWorkDetail, "line" | "report">) {
  const line = detail.line;
  return JSON.stringify([line.id, line.revision, line.projectionVersion, line.held, line.sourceChanged,
    line.archivedAt ?? null, line.sideState ?? null, line.preparation, detail.report?.versionId ?? null]);
}

/** A previous green result must never authorize a different draft, source or order. */
export function orderReviewCheckCurrent(state: OrderReviewCheckState | null,
  detail: Pick<OrderWorkDetail, "line" | "report">, draft: OrderWorkDraft) {
  const snapshot = orderIntakeSnapshot(detail, draft);
  return !!state && state.orderLineId === snapshot.orderLineId && state.input === snapshot.input &&
    state.projectionVersion === detail.line.projectionVersion &&
    state.lineState === orderReviewLineState(detail) &&
    (!state.check || orderIntakeReceiptMatches(state.check, snapshot));
}

export function orderReviewIssueTarget(issue: OrderIntakeCheck["issues"][number], check?: OrderIntakeCheck | null): OrderReviewTarget {
  const field = check?.fields.find(value => value.key === issue.fieldKey || value.sourceKeys.includes(issue.fieldKey ?? ""));
  if (issue.code === "basis_or_image_invalid") return /原图|图片|image|photo/iu.test(issue.message) ? "images" : "basis";
  if (field?.type === "image" || /image|photo|original/.test(issue.code)) return "images";
  if (/deadline|due_at/.test(issue.code)) return "deadline";
  if (/held|archived|cancelled|source_changed/.test(issue.code)) return "status";
  if (issue.code === "automatic_artwork_not_ready") return issue.fieldKey ? "requirements" : "design";
  if (issue.fieldKey) return "requirements";
  if (/basis|package|recipe|profile|specification|version/.test(issue.code)) return "basis";
  return "requirements";
}

export function orderReviewIssueAction(target: OrderReviewTarget) {
  return { basis: "核对制作依据", requirements: "查看顾客要求", images: "补齐顾客原图",
    design: "选择制图方式", deadline: "核对平台截止", status: "查看订单状态" }[target];
}
