import { describe, expect, it } from "vitest";
import { designAgentRecoveryGuidance } from "./order-design-recovery-model";
import type { DesignAgentRunView } from "@yummyai/contracts/order/design-agent";

const steps = [
  { id: "prepared", label: "保真美化", status: "completed" },
  { id: "uncertain", label: "主体抠图", status: "uncertain" },
  { id: "pending", label: "测量主体", status: "pending" },
] as DesignAgentRunView["steps"];

describe("order design recovery guidance", () => {
  it("locates the unknown step and completed checkpoint without treating pending work as complete", () => {
    const progress = designAgentRecoveryGuidance({ status: "needs_attention", canResume: false, steps,
      responseRecoveryTarget: { stepId: "uncertain", requestId: "request", stepLabel: "主体抠图", model: "pinned", sourceAssetId: "prepared", knownResponseChecksum: null } });
    expect(progress).toMatchObject({ completedCount: 1, totalCount: 3, lastCompleted: steps[0], blockedStep: steps[1] });
    expect(progress.nextAction).toContain("核实提供方原结果"); expect(progress.nextAction).toContain("缺少可信原结果时接管");
  });
  it("keeps safe local resumption, manual corrections and human review as distinct actions", () => {
    const view = { canResume: false, steps, responseRecoveryTarget: null };
    expect(designAgentRecoveryGuidance({ ...view, status: "needs_attention" }).nextAction).toContain("接管后制作新版本");
    expect(designAgentRecoveryGuidance({ ...view, status: "needs_attention", canResume: true }).nextAction).toContain("已保存的模型结果会继续复用");
    expect(designAgentRecoveryGuidance({ ...view, status: "awaiting_review" }).nextAction).toContain("填写驳回理由");
    expect(designAgentRecoveryGuidance({ ...view, status: "cancelled" }).nextAction).toContain("重新检查并送审");
  });
});
