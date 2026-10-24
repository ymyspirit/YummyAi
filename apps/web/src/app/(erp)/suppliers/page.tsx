import { loadSuppliers, loadFactoryDirectory } from "../../../features/manual-operations/operation-actions";
import { SuppliersWorkspace } from "../../../features/manual-operations/suppliers-workspace";
import { loadProductSupplyWorkspace } from "../../../features/products/product-supply-actions";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const [result, supply, directory] = await Promise.all([loadSuppliers(), loadProductSupplyWorkspace(), loadFactoryDirectory()]);
  return <div className="research-shell procurement-shell"><main className="research-main procurement-main">
    <header className="procurement-header"><div><h1>供应商与工厂档案</h1><p>供应商维护合作与结算资料；进入详情，按实际地点添加工厂及产品与工艺能力。</p></div></header>
    {directory.error && <p className="record-notice error" role="alert">{directory.error}</p>}
    {supply.error && <p className="record-notice error" role="alert">{supply.error}</p>}
    {result.error ? <p className="record-notice error" role="alert">{result.error}</p> : <SuppliersWorkspace suppliers={result.suppliers} factoryCounts={directory.data ? Object.fromEntries(result.suppliers.map(supplier => [supplier.id, directory.data!.factories.filter(factory => factory.supplierId === supplier.id && factory.profile.status !== "archived").length])) : undefined} productCounts={supply.data ? Object.fromEntries(result.suppliers.map((supplier) => [supplier.id, new Set(supply.data!.links.filter((link) => link.supplierId === supplier.id && link.terms.status === "active").map((link) => link.productPlanId)).size])) : undefined} />}
  </main></div>;
}
