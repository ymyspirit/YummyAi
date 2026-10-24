import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdvertisingCommandWorkbench } from "../../../../features/customer-intelligence/advertising-command-workbench";

export const dynamic = "force-dynamic";
export const metadata = { title: "我的广告原提交 · YummyAI" };
export default function AdvertisingOriginalsPage() {
  return <div className="research-shell customer-intelligence-shell"><main className="research-main customer-intelligence-main"><header className="customer-intelligence-header"><div><p className="kicker">ADVERTISING ORIGINALS</p><h1>我的广告原提交</h1><p>恢复原填写 核对固定来源与原版本 再明确执行实际广告登记</p></div><Link href="/customer-intelligence"><ArrowLeft size={15} />返回广告与 VOC</Link></header><AdvertisingCommandWorkbench /></main></div>;
}
