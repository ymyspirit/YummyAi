import { ProductionEditorWorkspace } from "../../../../features/production-editor/production-editor-workspace";
import { WorkflowReturnLink } from "../../../../features/navigation/use-workflow-return";
import { redirect } from "next/navigation";
import "../../../../features/production-editor/production-editor.css";

export const dynamic = "force-dynamic";

export default async function ProductionEditorPage({ searchParams }: {
  searchParams: Promise<{ kind?: string; projectId?: string; versionId?: string; reportLineId?: string }>;
}) {
  const query = await searchParams;
  if (!query.projectId && !query.reportLineId) redirect("/production-templates");
  const kind = query.kind === "shaped_pillow" || query.kind === "tire_cover" || query.kind === "rectangular_print" ? query.kind : undefined;
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return <div className="research-shell production-editor-shell">
    <main className="research-main production-editor-main">
      <WorkflowReturnLink className="listing-return-link" label="返回工艺登记 / 原任务" />
      <header className="production-editor-page-header">
        <div><h1>制作文件</h1><p>查看原任务的制作文件与固定版本</p></div>
      </header>
      <ProductionEditorWorkspace kind={kind} scope={query.projectId ? "project" : "order"}
        initialProjectId={query.projectId && id.test(query.projectId) ? query.projectId : undefined}
        initialVersionId={query.versionId && id.test(query.versionId) ? query.versionId : undefined}
        reportLineId={query.reportLineId && id.test(query.reportLineId) ? query.reportLineId : undefined} />
    </main>
  </div>;
}
