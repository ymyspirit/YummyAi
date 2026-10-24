import Link from "next/link";
import { loadSuppliers } from "../manual-operations/operation-actions";
import { loadShiposWorkspace } from "../manual-operations/shipos-loader";
import { ShiposSyncPanel } from "../manual-operations/shipos-workspace";
import "../manual-operations/shipos.css";
import "./order-centers.css";

export async function ShiposSyncPage({ supplierId }: { supplierId?: string }) {
  const suppliers = await loadSuppliers();
  const selected = suppliers.suppliers.find(supplier => supplier.id === supplierId)
    ?? (!supplierId && suppliers.suppliers.length === 1 ? suppliers.suppliers[0] : undefined);
  const workspace = selected ? await loadShiposWorkspace(selected.id) : null;
  return <main className="oc-page shipos-page">
    <header className="oc-header"><div><h1>物流订单同步</h1><p>查询已有物流订单、运单与现有面单，处理本地订单关联和同步异常。</p></div>
      <div className="oc-actions"><Link className="oc-button" href="/shipments">发货订单</Link><Link className="oc-button" href="/orders?view=reports">导入订单报告</Link></div>
    </header>
    {suppliers.error ? <p className="record-notice error" role="alert">{suppliers.error}</p> : <>
      {!suppliers.suppliers.length ? <p className="record-notice">尚无可用供应商，请先到 <Link href="/suppliers">供应商档案</Link> 配置物流连接。</p> : <form className="shipos-selector" action="/shipments" method="get">
        <input type="hidden" name="view" value="logistics" />
        <label htmlFor="shipos-supplier">供应商物流连接</label><select key={selected?.id ?? ""} id="shipos-supplier" name="supplierId" defaultValue={selected?.id ?? ""} required><option value="" disabled>请选择供应商</option>{suppliers.suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select>
        <button className="oc-button" type="submit">查看同步记录</button>
      </form>}
      {supplierId && !selected ? <p className="record-notice error" role="alert">供应商不存在或当前成员无权访问，请重新选择。</p> : !selected && suppliers.suppliers.length > 0 ? <p className="record-notice">选择供应商的物流连接后，即可查询和同步该账号已有订单。</p> : null}
      {workspace?.error ? <p className="record-notice error" role="alert">{workspace.error}</p> : workspace?.data && selected && <ShiposSyncPanel key={selected.id} supplierId={selected.id} initial={workspace.data} />}
    </>}
  </main>;
}
