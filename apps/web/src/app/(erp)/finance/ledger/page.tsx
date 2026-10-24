import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { FinanceLedgerWorkspace } from "../../../../features/finance/finance-ledger-workspace";
export const dynamic="force-dynamic";
export const metadata={title:"财务台账 · YummyAI"};
export default function FinanceLedgerPage(){
  return <div className="research-shell finance-shell"><main className="research-main finance-main">
    <header className="finance-header"><div><p className="kicker">FINANCE LEDGER</p><h1>财务台账</h1><p>逐页查阅真实财务与应付记录 按原始编号核对完整依据</p></div><Link href="/finance"><ArrowLeft size={15}/>返回财务与利润</Link></header>
    <FinanceLedgerWorkspace/>
  </main></div>;
}
