import {
  FinanceWorkspaceViewSchema,
  type FinanceWorkspaceView,
} from "@yummyai/contracts/finance";
import { BadgeDollarSign, ShieldAlert } from "lucide-react";

import { FinanceWorkspace } from "../../../features/finance/finance-workspace";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const result = await loadFinanceWorkspace();
  return (
    <div className="research-shell finance-shell">
      <ErpSidebar
        active="finance"
        contextLabel="FINANCE EVIDENCE"
        note="收入、成本、汇率与利润都锁定到不可变证据；缺失事实不会按零计算。"
      />
      <main className="research-main finance-main">
        <header className="finance-header">
          <div>
            <p className="kicker">SETTLEMENT / FX / CONTRIBUTION MARGIN</p>
            <h1>财务与利润</h1>
            <p>核对结算单、费用、历史汇率和利润口径，追踪订单、SKU、店铺与供应商的贡献结果。</p>
          </div>
          <div className="finance-integrity-mark">
            <BadgeDollarSign size={18} />
            <span><b>事实锁定</b>每次计算固定结算单、汇率与指标版本</span>
          </div>
        </header>

        {"error" in result ? (
          <section className={`finance-load-state state-${result.kind}`} role="alert">
            <ShieldAlert size={20} />
            <div>
              <strong>{result.kind === "unauthorized" ? "财务工作区访问未授权" : result.kind === "forbidden" ? "缺少财务读取权限" : "财务工作区不可用"}</strong>
              <span>{result.error}</span>
            </div>
          </section>
        ) : <FinanceWorkspace data={result.data} />}
      </main>
    </div>
  );
}

async function loadFinanceWorkspace(): Promise<
  | { data: FinanceWorkspaceView; error?: never; kind?: never }
  | { data?: never; error: string; kind: "unauthorized" | "forbidden" | "failed" }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置财务 API。", kind: "failed" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/finance/workspace`, {
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
      if (response.status === 403) return { error: "当前成员没有 finance:read 权限。", kind: "forbidden" };
      return { error: `财务工作区读取失败 (${response.status})。`, kind: "failed" };
    }
    return { data: FinanceWorkspaceViewSchema.parse(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "财务工作区读取失败。",
      kind: "failed",
    };
  }
}
