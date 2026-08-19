import { WorkflowRunDetailSchema, type WorkflowRunDetail } from "@yummyai/contracts/workflow";

import { ErpSidebar } from "../../../../../features/navigation/erp-sidebar";
import { WorkflowRunWorkspace } from "../../../../../features/workflows/workflow-run-workspace";
import { apiFetch } from "../../../../../server-api";

export const dynamic = "force-dynamic";

export default async function WorkflowRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadRun(id);
  return (
    <div className="research-shell workflow-shell workflow-run-shell">
      <ErpSidebar
        active="workflows"
        contextLabel="WORKFLOW RUN"
        note="运行拓扑只读。点击节点执行、审核、阻断或返工；已完成任务仍可修改说明。"
      />
      <main className="research-main workflow-main workflow-canvas-main">
        {result.run ? <WorkflowRunWorkspace run={result.run} /> : <div className="workflow-alert error">{result.error}</div>}
      </main>
    </div>
  );
}

async function loadRun(id: string): Promise<{ run?: WorkflowRunDetail; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "API_BASE_URL 未配置。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/workflow-runs/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) return { error: response.status === 403 ? "当前成员没有 workflow:read 权限。" : `运行实例读取失败 (${response.status})。` };
    return { run: WorkflowRunDetailSchema.parse(await response.json()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "运行实例读取失败。" };
  }
}
