import { ArrowRight, FileText } from "lucide-react";
import Link from "next/link";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

interface ListingSummary {
  id: string;
  locale: string;
  platform: "amazon" | "etsy";
  primaryVersionId?: string;
  spuId: string;
  status: "draft" | "in_review" | "approved" | "archived";
}

export default async function ListingsPage() {
  const result = await loadListings();
  return (
    <div className="research-shell listing-index-shell">
      <ErpSidebar
        active="listings"
        contextLabel="LISTING OPS"
        listingHref="/listings"
        note="从当前版本进入内容校验、审核证据与平台发布轨道。"
      />
      <main className="research-main listing-index-main">
        <header className="listing-index-header">
          <div><p className="kicker">LISTING / VERSION CONTROL</p><h1>刊登控制台</h1><p>当前版本、审批状态与平台执行入口。</p></div>
          <span><FileText size={18} />{result.items.length} LISTINGS</span>
        </header>
        {result.error && <p className="listing-index-error" role="alert">{result.error}</p>}
        <section className="listing-index-frame">
          <table>
            <thead><tr><th>平台</th><th>Listing</th><th>Locale</th><th>状态</th><th>当前版本</th><th aria-label="操作" /></tr></thead>
            <tbody>
              {result.items.map((listing) => (
                <tr key={listing.id}>
                  <td><span className={`publication-platform ${listing.platform}`}>{listing.platform === "amazon" ? "AMZ" : "ETSY"}</span></td>
                  <td><strong>{listing.spuId.slice(0, 12)}</strong><code>{listing.id}</code></td>
                  <td>{listing.locale}</td>
                  <td><span className={`listing-index-status ${listing.status}`}>{listingStatusLabel(listing.status)}</span></td>
                  <td><code>{listing.primaryVersionId?.slice(0, 13) ?? "—"}</code></td>
                  <td><Link aria-label={`打开 ${listing.spuId.slice(0, 12)}`} href={`/listings/${listing.id}`}><ArrowRight size={16} /></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.items.length === 0 && !result.error && <div className="listing-index-empty"><FileText size={24} /><strong>暂无 Listing</strong></div>}
        </section>
      </main>
    </div>
  );
}

async function loadListings(): Promise<{ error?: string; items: ListingSummary[] }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置刊登 API。", items: [] };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/listings`, { cache: "no-store" });
    if (!response.ok) throw new Error(`刊登列表读取失败 (${response.status})`);
    return { items: await response.json() as ListingSummary[] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "刊登列表读取失败", items: [] };
  }
}

function listingStatusLabel(status: ListingSummary["status"]): string {
  return ({ approved: "已审批", archived: "已归档", draft: "草稿", in_review: "评审中" })[status];
}
