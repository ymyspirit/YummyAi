import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FinanceCostAllocationWorkspace } from "../../../../features/finance/finance-cost-allocation-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "费用分摊与归属利润 · YummyAI" };
export default function FinanceCostAllocationsPage() {
  return <div className="research-shell finance-shell"><main className="research-main finance-main">
    <header className="finance-header"><div><p className="kicker">COST ALLOCATION</p><h1>费用分摊与归属利润</h1>
      <p>从原汇总选择真实费用 明确分摊依据 核对逐目标完整性</p></div>
      <Link href="/finance"><ArrowLeft size={15}/>返回财务与利润</Link></header>
    <FinanceCostAllocationWorkspace/>
  </main></div>;
}
