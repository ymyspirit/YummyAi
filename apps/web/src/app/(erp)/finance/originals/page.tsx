import Link from "next/link";
import {ArrowLeft} from "lucide-react";
import {FinanceCommandWorkbench} from "../../../../features/finance/finance-command-workbench";
export const dynamic="force-dynamic";
export const metadata={title:"我的财务原提交 · YummyAI"};
export default function FinanceOriginalsPage(){return <div className="research-shell finance-shell"><main className="research-main finance-main">
  <header className="finance-header"><div><p className="kicker">FINANCE ORIGINALS</p><h1>我的财务原提交</h1>
    <p>恢复原填写并核对实际结果 执行前保留原请求键与固定版本</p></div><Link href="/finance"><ArrowLeft size={15}/>返回财务与利润</Link></header>
  <FinanceCommandWorkbench/>
 </main></div>;}
