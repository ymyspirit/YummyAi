import type { DesignAgentRunView } from "@yummyai/contracts/order/design-agent";

type RecoveryRun = Pick<DesignAgentRunView, "status" | "canResume" | "responseRecoveryTarget" | "steps">
  & Partial<Pick<DesignAgentRunView, "errorCode" | "nextRetryAt">>;

/** Only persisted public failure codes select a recovery path. A missing bill or
 * a historical unknown result is never evidence of a provider rejection. */
export function designAgentInterruption(run: RecoveryRun) {
  if (run.status !== "needs_attention" && !(run.status === "queued" && run.errorCode === "agent_provider_rate_limited")) return null;
  const code = run.errorCode ?? run.steps.find(step => step.status === "failed" || step.status === "uncertain")?.errorCode ?? null;
  const retryAt = run.status === "queued" && run.nextRetryAt && Number.isFinite(Date.parse(run.nextRetryAt)) ? run.nextRetryAt : null;
  if (run.status === "queued") return {
    title: "模型限流 等待自动重试", kind: "retry" as const, retryAt,
    nextAction: "系统已安排延后重试，无需重新派发。已完成步骤和原始资料继续保留。",
    primaryTakeover: false,
  };
  switch (code) {
    case "agent_provider_moderation_blocked": return {
      title: "图像模型安全审核拒绝", kind: "moderation" as const, retryAt: null,
      nextAction: "请交美工接管本单，继续使用原项目和保留素材。如需核实误判，请管理员核对提供方审核记录。",
      primaryTakeover: true,
    };
    case "agent_provider_authentication_failed": return {
      title: "模型渠道授权不可用", kind: "authentication" as const, retryAt: null,
      nextAction: "请管理员核对模型渠道的密钥、权限和账户状态；需要继续制作时，可先交美工接管。",
      primaryTakeover: true,
    };
    case "agent_provider_invalid_request": return {
      title: "模型未接受本次请求", kind: "invalid_request" as const, retryAt: null,
      nextAction: "请接管核对固定素材与制作要求，或由管理员检查模型请求参数。已完成步骤仍保留。",
      primaryTakeover: true,
    };
    case "agent_provider_retry_exhausted": return {
      title: "自动重试已用完", kind: "exhausted" as const, retryAt: null,
      nextAction: "自动重试仍未恢复，后续模型请求已停止。请管理员核对渠道，或交美工接管继续制作。",
      primaryTakeover: true,
    };
    case "agent_provider_retry_deferred": return {
      title: "自动重试已暂缓", kind: "deferred" as const, retryAt: null,
      nextAction: "等待时间超出本轮自动恢复范围，或本轮恢复已停止。请管理员核对渠道与原调用记录，或交美工接管当前项目。",
      primaryTakeover: true,
    };
    case "agent_model_submission_unknown":
    case "agent_model_response_uncheckpointed": return {
      title: "原模型结果待核实", kind: "uncertain" as const, retryAt: null,
      nextAction: run.responseRecoveryTarget
        ? "核实提供方原结果后导入，继续后续制图；缺少可信原结果时接管处理。"
        : "请核对提供方原调用记录；无法取得可信原结果时，交美工接管。系统不会自动再次提交该请求。",
      primaryTakeover: false,
    };
    default: return {
      title: "自动制作需要处理", kind: "other" as const, retryAt: null,
      nextAction: run.responseRecoveryTarget
        ? "核实提供方原结果后导入，继续后续制图；缺少可信原结果时接管处理。"
        : run.canResume
        ? "先修复失败原因，再恢复可重试步骤。已完成步骤和已保存的模型结果会继续复用。"
        : "核对失败原因和检查报告；需改图、变更来源或达到重试上限时，接管后制作新版本并重新检查。",
      primaryTakeover: false,
    };
  }
}

export function designAgentRecoveryGuidance(run: RecoveryRun) {
  const blockedStep = run.steps.find(step => step.status === "uncertain" || step.status === "failed")
    ?? run.steps.find(step => step.status === "running" || step.status === "pending");
  const completed = run.steps.filter(step => step.status === "completed");
  const lastCompleted = completed.at(-1);
  const interruption = designAgentInterruption(run);
  const nextAction = run.status === "awaiting_review"
    ? "核对原图、当前稿件和全尺寸 JPG，通过审核或填写驳回理由。驳回后修改新版本，再重新送审。"
    : run.status === "cancelled"
      ? "在已保留的稿件和素材上继续人工制作，修改后重新检查并送审。"
      : interruption?.nextAction
        ?? (
        run.responseRecoveryTarget
        ? "核实提供方原结果后导入，继续后续制图；缺少可信原结果时接管处理。"
        : run.canResume
          ? "先修复失败原因，再恢复可重试步骤。已完成步骤和已保存的模型结果会继续复用。"
          : run.status === "needs_attention"
            ? "核对失败原因和检查报告；需改图、变更来源或达到重试上限时，接管后制作新版本并重新检查。"
            : "后台继续执行固定步骤；需要改图时先接管制作。");
  return { completedCount: completed.length, totalCount: run.steps.length, lastCompleted, blockedStep, nextAction };
}
