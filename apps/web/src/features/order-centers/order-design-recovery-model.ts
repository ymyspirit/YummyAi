import type { DesignAgentRunView } from "@yummyai/contracts/order/design-agent";

export function designAgentRecoveryGuidance(run: Pick<DesignAgentRunView, "status" | "canResume" | "responseRecoveryTarget" | "steps">) {
  const blockedStep = run.steps.find(step => step.status === "uncertain" || step.status === "failed")
    ?? run.steps.find(step => step.status === "running" || step.status === "pending");
  const completed = run.steps.filter(step => step.status === "completed");
  const lastCompleted = completed.at(-1);
  const nextAction = run.status === "awaiting_review"
    ? "核对原图、当前稿件和全尺寸 JPG，通过审核或填写驳回理由。驳回后修改新版本，再重新送审。"
    : run.status === "cancelled"
      ? "在已保留的稿件和素材上继续人工制作，修改后重新检查并送审。"
      : run.responseRecoveryTarget
        ? "核实提供方原结果后导入，继续后续制图；缺少可信原结果时接管处理。"
        : run.canResume
          ? "先修复失败原因，再恢复可重试步骤。已完成步骤和已保存的模型结果会继续复用。"
          : run.status === "needs_attention"
            ? "核对失败原因和检查报告；需改图、变更来源或达到重试上限时，接管后制作新版本并重新检查。"
            : "后台继续执行固定步骤；需要改图时先接管制作。";
  return { completedCount: completed.length, totalCount: run.steps.length, lastCompleted, blockedStep, nextAction };
}
