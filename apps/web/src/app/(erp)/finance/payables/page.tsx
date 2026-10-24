import Link from "next/link";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { FinancePayablesWorkspaceViewSchema, type FinancePayablesWorkspaceView } from "@yummyai/contracts/finance/payables";
import { PayablesWorkspace } from "../../../../features/finance/payables-workspace";
import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";
export const metadata = { title: "应付与付款核销 · YummyAI" };

export default async function FinancePayablesPage() {
  const result = await loadPayables();
  return <div className="research-shell finance-shell"><main className="research-main finance-main">
    <header className="finance-header"><div><p className="kicker">PAYABLES / PAYMENT EVIDENCE / ALLOCATION</p><h1>应付与付款核销</h1><p>核对工厂与供应商账单 登记已发生的付款证据 按同供应商、同币种分配核销</p></div><Link href="/finance"><ArrowLeft size={15} />返回财务与利润</Link></header>
    <p><Link href="/finance/ledger">查阅完整财务与应付台账</Link></p>
    {"error" in result ? <section className={`finance-load-state state-${result.kind}`} role="alert"><ShieldAlert size={20} /><div><strong>{result.kind === "unauthorized" ? "应付工作区访问未授权" : result.kind === "forbidden" ? "缺少财务读取权限" : "应付与付款核销暂不可用"}</strong><span>{result.error}</span></div></section> : <PayablesWorkspace initialData={result.data} />}
  </main></div>;
}

async function loadPayables(): Promise<{ data: FinancePayablesWorkspaceView; error?: never; kind?: never } | { data?: never; error: string; kind: "unauthorized" | "forbidden" | "failed" }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置财务 API", kind: "failed" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/finance/payables/workspace`, { cache: "no-store" });
    if (response.status === 401) return { error: "身份会话无效 请重新登录 ERP", kind: "unauthorized" };
    if (response.status === 403) return { error: "当前成员没有财务读取权限", kind: "forbidden" };
    if (!response.ok) return { error: "无法读取实际账单与付款核销记录 请稍后重试", kind: "failed" };
    const parsed = FinancePayablesWorkspaceViewSchema.safeParse(await response.json());
    return parsed.success ? { data: parsed.data } : { error: "实际账单与付款记录返回格式暂不可核对", kind: "failed" };
  } catch { return { error: "暂时无法连接财务工作区 请稍后重试", kind: "failed" }; }
}
