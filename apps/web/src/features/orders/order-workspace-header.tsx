import Link from "next/link";
import { ClipboardList, FileUp } from "lucide-react";

export function OrderWorkspaceHeader({ view }: { view: "reports" | "fulfillment" }) {
  return <>
    <header className="order-header"><div><h1>订单工作台</h1><p>导入报告、核对定制并制作生产图；在履约队列跟进生产与发货。</p></div>
      {view === "fulfillment" ? <Link className="filter-reset" href="/orders?view=reports"><FileUp size={16} />导入亚马逊报告</Link> : null}
    </header>
    <nav className="order-workspace-tabs" aria-label="订单工作台视图">
      <Link href="/orders?view=reports" aria-current={view === "reports" ? "page" : undefined}><FileUp size={16} />导入与定制</Link>
      <Link href="/orders" aria-current={view === "fulfillment" ? "page" : undefined}><ClipboardList size={16} />履约队列</Link>
    </nav>
  </>;
}
