import {
  SupplierPerformanceWorkspaceViewSchema,
  type SupplierPerformanceWorkspaceView,
} from "@yummyai/contracts/supplier-performance";
import { ChartNoAxesCombined, ShieldAlert } from "lucide-react";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { SupplierPerformanceWorkspace } from "../../../features/supplier-performance/supplier-performance-workspace";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function SupplierPerformancePage() {
  const result = await loadSupplierPerformanceWorkspace();
  return (
    <div className="research-shell supplier-performance-shell">
      <ErpSidebar
        active="supplier-performance"
        contextLabel="SUPPLIER EVIDENCE"
        note="评分固定 KPI 版本、统计窗口和原始证据；结果不会直接改写供应商路由。"
      />
      <main className="research-main supplier-performance-main">
        <header className="supplier-performance-header">
          <div>
            <p className="kicker">QUALITY / DELIVERY / CAPACITY</p>
            <h1>供应商绩效</h1>
            <p>比较质量、交付、价格、响应和产能履约，所有评分都可回到采购、生产和质检证据。</p>
          </div>
          <div className="supplier-performance-integrity">
            <ChartNoAxesCombined size={18} />
            <span><b>只读分析</b>评分不会自动修改路由策略</span>
          </div>
        </header>

        {"error" in result ? (
          <section className={`supplier-performance-load-state state-${result.kind}`} role="alert">
            <ShieldAlert size={20} />
            <div>
              <strong>{result.kind === "unauthorized" ? "供应商绩效访问未授权" : result.kind === "forbidden" ? "缺少供应商绩效读取权限" : "供应商绩效工作区不可用"}</strong>
              <span>{result.error}</span>
            </div>
          </section>
        ) : <SupplierPerformanceWorkspace data={result.data} />}
      </main>
    </div>
  );
}

async function loadSupplierPerformanceWorkspace(): Promise<
  | { data: SupplierPerformanceWorkspaceView; error?: never; kind?: never }
  | { data?: never; error: string; kind: "unauthorized" | "forbidden" | "failed" }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置供应商绩效 API。", kind: "failed" };
  try {
    const response = await apiFetch(
      `${apiBase.replace(/\/$/, "")}/v1/supplier-performance/workspace`,
      { cache: "no-store" },
    );
    if (!response.ok) {
      if (response.status === 401) return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" };
      if (response.status === 403) return { error: "当前成员没有 supplier_performance:read 权限。", kind: "forbidden" };
      return { error: `供应商绩效工作区读取失败 (${response.status})。`, kind: "failed" };
    }
    return { data: SupplierPerformanceWorkspaceViewSchema.parse(await response.json()) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "供应商绩效工作区读取失败。",
      kind: "failed",
    };
  }
}
