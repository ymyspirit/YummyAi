import type { MarketplaceAccountView, MarketplacePublicationRequestView, OrderView } from "@yummyai/contracts";
import { Store } from "lucide-react";

import { MarketplaceAccountDetail } from "../../../../features/marketplaces/marketplace-accounts-workspace";
import { ErpSidebar } from "../../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";

export default async function StoreDetailPage({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<{ oauth?: string; reason?: string }> }) {
  const [{ accountId }, query] = await Promise.all([params, searchParams]);
  const result = await loadStore(accountId);
  const notice = query.oauth === "success" ? { message: "平台授权已完成，请同步店铺能力。", status: "success" as const } : query.oauth === "failed" ? { message: `平台授权未完成 (${query.reason ?? "unknown"})`, status: "error" as const } : undefined;
  return <div className="research-shell store-shell"><ErpSidebar active="stores" contextLabel="STORE DETAIL" note="授权凭证不会回显；能力快照、发布与订单摘要都来自租户隔离的真实投影。" /><main className="research-main store-main">{result.account ? <MarketplaceAccountDetail account={result.account} error={result.error} listingCount={result.listingCount} notice={notice} orderCount={result.orderCount} publicationCount={result.publicationCount} /> : <section className="analysis-error" role="alert"><Store size={28} /><h1>未找到店铺连接</h1><p>{result.error ?? "该连接不存在或当前成员无权访问。"}</p><a href="/stores">返回店铺运营</a></section>}</main></div>;
}

async function loadStore(accountId: string): Promise<{ account?: MarketplaceAccountView; error?: string; listingCount: number; orderCount: number; publicationCount: number }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置店铺 API。", listingCount: 0, orderCount: 0, publicationCount: 0 };
  const base = apiBase.replace(/\/$/, "");
  try {
    const [accountResponse, publicationsResponse, ordersResponse] = await Promise.all([
      apiFetch(`${base}/v1/marketplace-accounts/${accountId}`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-publications?accountId=${encodeURIComponent(accountId)}&limit=100`, { cache: "no-store" }),
      apiFetch(`${base}/v1/orders?accountId=${encodeURIComponent(accountId)}&limit=100`, { cache: "no-store" }),
    ]);
    if (!accountResponse.ok) return { error: `店铺连接读取失败 (${accountResponse.status})`, listingCount: 0, orderCount: 0, publicationCount: 0 };
    const account = await accountResponse.json() as MarketplaceAccountView;
    const publications = publicationsResponse.ok ? await publicationsResponse.json() as MarketplacePublicationRequestView[] : [];
    const orders = ordersResponse.ok ? await ordersResponse.json() as OrderView[] : [];
    const errors = [
      ...(!publicationsResponse.ok ? [`发布记录读取失败 (${publicationsResponse.status})`] : []),
      ...(!ordersResponse.ok ? [`订单摘要读取失败 (${ordersResponse.status})`] : []),
    ];
    return {
      account,
      listingCount: new Set(publications.map((publication) => publication.listingId)).size,
      orderCount: orders.length,
      publicationCount: publications.length,
      ...(errors.length ? { error: errors.join("；") } : {}),
    };
  } catch (error) { return { error: error instanceof Error ? error.message : "店铺连接读取失败", listingCount: 0, orderCount: 0, publicationCount: 0 }; }
}
