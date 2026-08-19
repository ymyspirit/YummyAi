import { WorkflowDefinitionDetailSchema, type WorkflowDefinitionDetail } from "@yummyai/contracts/workflow";

import { ErpSidebar } from "../../../../../../features/navigation/erp-sidebar";
import { WorkflowDesigner } from "../../../../../../features/workflows/workflow-designer";
import { apiFetch } from "../../../../../../server-api";

export const dynamic = "force-dynamic";

export default async function WorkflowTemplateEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadDefinition(id);
  return (
    <div className="research-shell workflow-shell workflow-designer-shell">
      <ErpSidebar
        active="workflows"
        contextLabel="WORKFLOW DESIGN"
        note="发布版本不可变；修改模板会创建新草稿版本，不会改变正在执行的产品。"
      />
      <main className="research-main workflow-main workflow-canvas-main">
        {result.definition ? <WorkflowDesigner definition={result.definition} /> : <div className="workflow-alert error">{result.error}</div>}
      </main>
    </div>
  );
}

async function loadDefinition(id: string): Promise<{ definition?: WorkflowDefinitionDetail; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "API_BASE_URL 未配置。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/workflows/definitions/${encodeURIComponent(id)}/draft`, { cache: "no-store" });
    if (!response.ok) return { error: response.status === 403 ? "当前成员没有 workflow:read 权限。" : `模板读取失败 (${response.status})。` };
    return { definition: WorkflowDefinitionDetailSchema.parse(await response.json()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "模板读取失败。" };
  }
}
