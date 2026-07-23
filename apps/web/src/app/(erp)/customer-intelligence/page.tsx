import { CustomerIntelligenceWorkspaceViewSchema, type CustomerIntelligenceWorkspaceView } from "@yummyai/contracts/customer-intelligence";
import { Megaphone, ShieldAlert } from "lucide-react";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { CustomerIntelligenceWorkspace } from "../../../features/customer-intelligence/customer-intelligence-workspace";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function CustomerIntelligencePage() {
  const result = await loadWorkspace();
  return <div className="research-shell customer-intelligence-shell"><ErpSidebar active="customer-intelligence" contextLabel="ADVERTISING / VOC" note="广告花费与客户信号固定来源、归因、同意边界和分析版本；建议只能进入审阅队列。" /><main className="research-main customer-intelligence-main"><header className="customer-intelligence-header"><div><p className="kicker">ADVERTISING / KEYWORDS / VOICE OF CUSTOMER</p><h1>广告与 VOC</h1><p>把广告表现与脱敏客户信号放在同一条证据链里，发现主题后交给人审阅。</p></div><div className="customer-intelligence-integrity"><Megaphone size={18} /><span><b>分析边界</b>不会直接改写 Listing、预算或产品事实</span></div></header>{"error" in result ? <section className={`customer-intelligence-load-state state-${result.kind}`} role="alert"><ShieldAlert size={20} /><div><strong>{result.kind === "unauthorized" ? "广告与 VOC 访问未授权" : result.kind === "forbidden" ? "缺少广告与 VOC 读取权限" : "广告与 VOC 工作区不可用"}</strong><span>{result.error}</span></div></section> : <CustomerIntelligenceWorkspace data={result.data} />}</main></div>;
}
async function loadWorkspace(): Promise<{ data: CustomerIntelligenceWorkspaceView } | { error: string; kind: "unauthorized" | "forbidden" | "failed" }> {
  const apiBase = process.env.API_BASE_URL; if (!apiBase) return { error: "尚未配置广告与 VOC API。", kind: "failed" };
  try { const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/customer-intelligence/workspace`, { cache: "no-store" }); if (!response.ok) { if (response.status === 401) return { error: "身份会话无效，请重新登录本地身份服务。", kind: "unauthorized" }; if (response.status === 403) return { error: "当前成员没有 customer_intelligence:read 权限。", kind: "forbidden" }; return { error: `广告与 VOC 工作区读取失败 (${response.status})。`, kind: "failed" }; } return { data: CustomerIntelligenceWorkspaceViewSchema.parse(await response.json()) }; } catch (error) { return { error: error instanceof Error ? error.message : "广告与 VOC 工作区读取失败。", kind: "failed" }; }
}
