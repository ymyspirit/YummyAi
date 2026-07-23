import {
  ProcurementWorkspaceViewSchema,
  type ProcurementWorkspaceView,
} from "@yummyai/contracts/procurement";
import { BadgeCheck, ShoppingCart } from "lucide-react";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { ProcurementWorkspace } from "../../../features/procurement/procurement-workspace";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function ProcurementPage() {
  const result = await loadProcurementWorkspace();
  return (
    <div className="research-shell procurement-shell">
      <ErpSidebar
        active="procurement"
        contextLabel="PROCUREMENT CONTROL"
        note="采购、收货与发票保留独立版本；补货建议不会自动创建或审批采购单。"
      />
      <main className="research-main procurement-main">
        <header className="procurement-header">
          <div>
            <p className="kicker">PURCHASE / RECEIPT / INVOICE</p>
            <h1>采购与补货</h1>
            <p>核对采购申请、供应商报价、审批版本、到货批次和发票差异，并追溯库存入账证据。</p>
          </div>
          <div className="procurement-integrity-mark">
            <BadgeCheck size={18} />
            <span><b>三单匹配</b>采购版本、收货凭证与供应商发票分别留痕</span>
          </div>
        </header>

        {"error" in result ? (
          <section className={`procurement-load-state state-${result.kind}`} role="alert">
            <ShoppingCart size={20} />
            <div>
              <strong>{result.kind === "unauthorized" ? "采购访问未授权" : result.kind === "forbidden" ? "缺少采购权限" : "采购工作区不可用"}</strong>
              <span>{result.error}</span>
            </div>
          </section>
        ) : <ProcurementWorkspace data={result.data} />}
      </main>
    </div>
  );
}

async function loadProcurementWorkspace(): Promise<
  | { data: ProcurementWorkspaceView; error?: never; kind?: never }
  | { data?: never; error: string; kind: "unauthorized" | "forbidden" | "failed" }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置采购 API。", kind: "failed" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/procurement/workspace`, {
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
      if (response.status === 403) return { error: "当前成员没有 procurement:read 权限。", kind: "forbidden" };
      return { error: `采购读取失败 (${response.status})。`, kind: "failed" };
    }
    return { data: ProcurementWorkspaceViewSchema.parse(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "采购读取失败。",
      kind: "failed",
    };
  }
}
