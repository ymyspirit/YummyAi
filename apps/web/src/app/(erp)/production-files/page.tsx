import Link from "next/link";
import { ProductionEditorWorkspace } from "../../../features/production-editor/production-editor-workspace";
import "../../../features/production-editor/production-editor.css";

export const dynamic = "force-dynamic";

export default async function ProductionFilesPage({ searchParams }: {
  searchParams: Promise<{ projectId?: string; versionId?: string }>;
}) {
  const query = await searchParams;
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return <main className="research-main production-editor-main">
    <header className="production-editor-page-header">
      <div><h1>生产文件</h1><p>查看订单和商品的生产稿、审核版本及导出文件</p></div>
      <Link href="/orders">返回订单工作台</Link>
    </header>
    <ProductionEditorWorkspace scope="production"
      initialProjectId={query.projectId && id.test(query.projectId) ? query.projectId : undefined}
      initialVersionId={query.versionId && id.test(query.versionId) ? query.versionId : undefined} />
  </main>;
}
