import { loadSuppliers } from "../../../features/manual-operations/operation-actions";
import { SuppliersWorkspace } from "../../../features/manual-operations/suppliers-workspace";
import { loadProductSupplyWorkspace } from "../../../features/products/product-supply-actions";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const [result, supply] = await Promise.all([loadSuppliers(), loadProductSupplyWorkspace()]);
  return <div className="research-shell procurement-shell"><main className="research-main procurement-main">
    <header className="procurement-header"><div><h1>供应商档案</h1><p>手动维护合作供应商，供采购、补货和订单履约选择。</p></div></header>
    {supply.error && <p className="record-notice error" role="alert">{supply.error}</p>}
    {result.error ? <p className="record-notice error" role="alert">{result.error}</p> : <SuppliersWorkspace suppliers={result.suppliers} productCounts={supply.data ? Object.fromEntries(result.suppliers.map((supplier) => [supplier.id, new Set(supply.data!.links.filter((link) => link.supplierId === supplier.id && link.terms.status === "active").map((link) => link.productPlanId)).size])) : undefined} />}
  </main></div>;
}
