import { ProductionEditorWorkspace } from "../../../../features/production-editor/production-editor-workspace";
import "../../../../features/production-editor/production-editor.css";

export const dynamic = "force-dynamic";

export default async function ProductionEditorPage({ searchParams }: {
  searchParams: Promise<{ kind?: string; projectId?: string; reportLineId?: string }>;
}) {
  const query = await searchParams;
  const kind = query.kind === "shaped_pillow" || query.kind === "tire_cover" ? query.kind : undefined;
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return <div className="research-shell production-editor-shell">
    <main className="research-main production-editor-main">
      <header className="production-editor-page-header">
        <div><h1>生产文件与底稿</h1><p>管理已保存的生产稿和通用工艺底稿。订单作图从订单工作台进入，创意作图从对应创意项目进入。</p></div>
      </header>
      <ProductionEditorWorkspace kind={kind}
        initialProjectId={query.projectId && id.test(query.projectId) ? query.projectId : undefined}
        reportLineId={query.reportLineId && id.test(query.reportLineId) ? query.reportLineId : undefined} />
    </main>
  </div>;
}
