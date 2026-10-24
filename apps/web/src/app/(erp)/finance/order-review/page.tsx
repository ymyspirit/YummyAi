import { OrderReviewWorkspacePanel } from "../../../../features/order-centers/order-review-workspace";
export const dynamic = "force-dynamic";
export default function OrderReviewPage() {
  return <div className="research-shell finance-shell"><main className="research-main finance-main">
    <header className="finance-header"><div><p className="kicker">ORDER / SKU / FULFILLMENT</p><h1>定制订单履约与利润复盘</h1>
      <p>按固定规格、配方和工厂核对交运、返工与单单贡献利润。</p></div><a href="/finance">返回财务与利润</a></header>
    <OrderReviewWorkspacePanel />
  </main></div>;
}
