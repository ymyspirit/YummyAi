import type { PreparationView } from "@yummyai/contracts/catalog/sales-plan-agent";
import type { BusinessTaskView, BusinessTaskState } from "@yummyai/contracts/operations/business-task";

export function salesTaskView(view: PreparationView): BusinessTaskView {
  const states: Record<string, BusinessTaskState> = { passed: "done", blocked: "blocked", waiting: "waiting", pending: "pending" };
  const elapsed = Math.max(0, Date.parse(view.run.updatedAt) - Date.parse(view.run.createdAt));
  return { id: view.run.id, kind: "sales_plan", title: `销售方案 V${view.run.planRevision}`, goal: view.run.goal,
    state: view.run.status === "cancelled" ? "cancelled" : view.sourceChanged ? "blocked" : view.run.status === "ready" ? "done" : view.run.status === "running" ? "working" : view.run.status,
    notices: view.sourceChanged ? ["来源已变化，原检查结果保留；按当前版本继续后重新核对"] : [],
    stages: view.run.steps.map(step => ({ key: step.key, label: step.label, state: view.sourceChanged && step.state === "passed" ? "pending" : states[step.state]!, detail: step.detail, href: step.href, action: "打开处理",
      evidence: step.key === "product" ? view.run.evidence.filter(row => ["sales_plan", "specification"].includes(row.kind)).map(row => ({ label: row.kind === "sales_plan" ? "销售方案" : "规格", value: row.version })) : step.key === "design" ? view.run.evidence.filter(row => row.kind === "artwork").map(row => ({ label: `印花 ${row.id.slice(-8)}`, value: row.version })) : view.run.evidence.filter(row => row.kind === "listing").map(row => ({ label: "刊登草稿", value: row.version })) })),
    metrics: [
      { key: "checks", label: "当前通过环节", value: view.sourceChanged ? null : `${view.run.steps.filter(step => step.state === "passed").length} / 4`, note: "针对固定版本的技术检查，不代表刊登审核通过或平台接受" },
      { key: "duration", label: "任务经历时间", value: `${Math.round(elapsed / 1000)} 秒`, note: "从建立到最后检查点，包含等待与人工处理时间" },
      { key: "tools", label: "业务工具调用", value: String(view.run.toolCalls), note: "累计已确认的草稿准备和分析派发" },
      { key: "analysis", label: "最近分析费用", value: view.analysis?.costUsd == null ? null : `${view.analysis.costUsd.toFixed(4)} USD`, note: "仅最近一次分析的已记录费用，历史分析请打开原任务核对" },
    ],
  };
}
