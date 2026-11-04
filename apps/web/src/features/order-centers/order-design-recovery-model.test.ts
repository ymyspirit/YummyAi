import { describe, expect, it } from "vitest";
import { designAgentInterruption, designAgentRecoveryGuidance } from "./order-design-recovery-model";
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

  it("keeps provider rejection separate from legacy uncertainty and gives an immediate handoff action", () => {
    const run = { status: "needs_attention" as const, canResume: false, steps, responseRecoveryTarget: null };
    const moderation = designAgentInterruption({ ...run, errorCode: "agent_provider_moderation_blocked" });
    expect(moderation).toMatchObject({ kind: "moderation", primaryTakeover: true, retryAt: null });
    expect(moderation?.nextAction).toContain("美工接管");
    expect(moderation?.nextAction).not.toContain("导入");
    expect(designAgentInterruption({ ...run, errorCode: "agent_model_submission_unknown" })?.kind).toBe("uncertain");
    expect(designAgentInterruption(run)?.kind).toBe("other");
    expect(designAgentInterruption({ ...run, errorCode: "agent_provider_authentication_failed" })?.nextAction).toContain("密钥");
    expect(designAgentInterruption({ ...run, errorCode: "agent_provider_invalid_request" })?.nextAction).toContain("请求参数");
    expect(designAgentRecoveryGuidance({ ...run, errorCode: "agent_provider_moderation_blocked" }).nextAction).toBe(moderation?.nextAction);
  });

  it("only describes automatic retry for a queued persisted rate-limit failure and never invents a time", () => {
    const run = { status: "queued" as const, canResume: false, steps, responseRecoveryTarget: null, errorCode: "agent_provider_rate_limited" };
    expect(designAgentInterruption({ ...run, nextRetryAt: "2026-11-04T00:01:00.000Z" })).toMatchObject({ kind: "retry", retryAt: "2026-11-04T00:01:00.000Z" });
    expect(designAgentRecoveryGuidance(run).nextAction).toContain("无需重新派发");
    expect(designAgentInterruption(run)?.retryAt).toBeNull();
    expect(designAgentInterruption({ ...run, nextRetryAt: "not a date" })?.retryAt).toBeNull();
    expect(designAgentInterruption({ ...run, errorCode: null })).toBeNull();
    expect(designAgentInterruption({ ...run, status: "running" })).toBeNull();
    expect(designAgentInterruption({ ...run, status: "needs_attention", errorCode: "agent_provider_retry_exhausted" })).toMatchObject({ kind: "exhausted", primaryTakeover: true, retryAt: null });
    const deferred = designAgentInterruption({ ...run, status: "needs_attention", errorCode: "agent_provider_retry_deferred" });
    expect(deferred).toMatchObject({ kind: "deferred", primaryTakeover: true, retryAt: null });
    expect(deferred?.nextAction).not.toContain("次数");
    expect(deferred?.title).not.toContain("用完");
  });
});
