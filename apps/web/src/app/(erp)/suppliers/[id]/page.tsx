import Link from "next/link";
import { loadProductSupplyWorkspace } from "../../../../features/products/product-supply-actions";
import { ProductSupplyWorkspacePanel } from "../../../../features/products/product-supply-workspace";
import { SuppliersWorkspace } from "../../../../features/manual-operations/suppliers-workspace";

export const dynamic = "force-dynamic";

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, result] = await Promise.all([params, loadProductSupplyWorkspace()]);
  const supplier = result.data?.suppliers.find((item) => item.id === id);
  return <div className="research-shell procurement-shell"><main className="research-main procurement-main">
    <header className="supplier-detail-header"><div><Link href="/suppliers">← 供应商档案</Link><h1>{supplier?.name ?? "供应商详情"}</h1><p>查看供应产品，维护规格、报价和供货条件。</p></div></header>
    {result.error ? <p className="record-notice error" role="alert">{result.error}</p> : !supplier ? <p className="record-notice error" role="alert">供应商不存在或当前成员无权访问。</p> : <>
      <SuppliersWorkspace suppliers={[supplier]} compact />
      <ProductSupplyWorkspacePanel data={result.data!} supplierId={id} />
    </>}
  </main></div>;
}
