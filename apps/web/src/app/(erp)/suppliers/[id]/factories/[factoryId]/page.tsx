import Link from "next/link";
import { loadFactoryDirectory } from "../../../../../../features/manual-operations/operation-actions";
import { FactoryWorkspace } from "../../../../../../features/manual-operations/factory-directory-workspace";

export const dynamic = "force-dynamic";
export default async function FactoryPage({ params }: { params: Promise<{ id: string; factoryId: string }> }) {
  const { id, factoryId } = await params, result = await loadFactoryDirectory(id), factory = result.data?.factories.find(factory => factory.id === factoryId && factory.supplierId === id);
  return <div className="research-shell procurement-shell"><main className="research-main procurement-main"><header className="supplier-detail-header"><div><Link href={`/suppliers/${id}`}>← 所属供应商与工厂</Link><h1>工厂详情</h1><p>按地点维护生产与交付资料</p></div></header>
    {result.error ? <p className="record-notice error" role="alert">{result.error}</p> : !factory ? <p className="record-notice error" role="alert">工厂不存在或当前成员无权访问。</p> : <FactoryWorkspace factory={factory} directory={result.data!} />}
  </main></div>;
}
