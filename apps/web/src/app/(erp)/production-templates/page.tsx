import { ProductionEditorWorkspace } from "../../../features/production-editor/production-editor-workspace";
import "../../../features/production-editor/production-editor.css";

export const dynamic = "force-dynamic";

export default async function ProductionTemplatesPage({ searchParams }: {
  searchParams: Promise<{ projectId?: string; versionId?: string }>;
}) {
  const query = await searchParams;
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return <main className="research-main production-editor-main">
    <header className="production-editor-page-header">
      <div><h1>工艺底稿</h1><p>维护产品共用的尺寸、版型和工艺参数，供订单制作时调用</p></div>
    </header>
    <ProductionEditorWorkspace scope="templates"
      initialProjectId={query.projectId && id.test(query.projectId) ? query.projectId : undefined}
      initialVersionId={query.versionId && id.test(query.versionId) ? query.versionId : undefined} />
  </main>;
}
