import Link from "next/link";
import { loadProductSupplyWorkspace } from "../../../../features/products/product-supply-actions";
import { ProductSupplyWorkspacePanel } from "../../../../features/products/product-supply-workspace";
import { SuppliersWorkspace } from "../../../../features/manual-operations/suppliers-workspace";
import { loadFactoryDirectory, loadSuppliers } from "../../../../features/manual-operations/operation-actions";
import { SupplierFactories, SupplierBusinessDetails } from "../../../../features/manual-operations/factory-directory-workspace";
import { loadShiposWorkspace } from "../../../../features/manual-operations/shipos-loader";
import { ShiposConnectionPanel } from "../../../../features/manual-operations/shipos-workspace";

export const dynamic = "force-dynamic";

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [result, supply, directory, shipos] = await Promise.all([loadSuppliers(), loadProductSupplyWorkspace(), loadFactoryDirectory(id), loadShiposWorkspace(id)]);
  const supplier = result.suppliers.find((item) => item.id === id);
  return <div className="research-shell procurement-shell"><main className="research-main procurement-main">
    <header className="supplier-detail-header"><div><Link href="/suppliers">← 供应商档案</Link><h1>{supplier?.name ?? "供应商详情"}</h1><p>维护企业与结算资料，按实际生产地点配置工厂及产品能力。</p></div></header>
    {result.error ? <p className="record-notice error" role="alert">{result.error}</p> : !supplier ? <p className="record-notice error" role="alert">供应商不存在或当前成员无权访问。</p> : <>
      <SuppliersWorkspace suppliers={[supplier]} compact />
      <SupplierBusinessDetails supplier={supplier} />
      {directory.error ? <p className="record-notice error" role="alert">{directory.error}</p> : directory.data && <SupplierFactories supplierId={id} directory={directory.data} />}
      {shipos.error ? <p className="record-notice error" role="alert">{shipos.error}</p> : shipos.data && <ShiposConnectionPanel supplierId={id} initial={shipos.data} />}
      {supply.error ? <p className="record-notice error" role="alert">{supply.error}</p> : supply.data && <ProductSupplyWorkspacePanel data={supply.data} supplierId={id} />}
    </>}
  </main></div>;
}
