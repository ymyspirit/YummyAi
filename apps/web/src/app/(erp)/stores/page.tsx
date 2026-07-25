import type { MarketplaceAccountView, MarketplacePublicationRequestView } from "@yummyai/contracts";
import { ShieldCheck } from "lucide-react";

import { MarketplaceAccountsWorkspace } from "../../../features/marketplaces/marketplace-accounts-workspace";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string; reason?: string }>;
}) {
  const [result, query] = await Promise.all([loadStoreWorkspace(), searchParams]);
  const oauthNotice = query.oauth === "success"
    ? { message: "平台授权已完成，请同步店铺能力。", status: "success" as const }
    : query.oauth === "failed"
      ? { message: `平台授权未完成 (${query.reason ?? "unknown"})`, status: "error" as const }
      : undefined;
  return (
    <div className="research-shell store-shell">
      <ErpSidebar
        active="stores"
        contextLabel="CHANNEL OPS"
        note="授权、能力快照和发布记录按租户隔离；撤销授权不会删除历史证据。"
      />
      <main className="research-main store-main">
        <header className="store-header">
          <div>
            <p className="kicker">MARKETPLACE / CONNECTION CONTROL</p>
            <h1>店铺运营</h1>
            <p>先在台账中识别授权、能力新鲜度与发布异常，再进入单店处理连接设置。</p>
          </div>
          <span><ShieldCheck size={18} />TENANT ISOLATED</span>
        </header>
        <MarketplaceAccountsWorkspace
          accounts={result.accounts}
          error={result.error}
          oauthNotice={oauthNotice}
          publications={result.publications}
        />
      </main>
    </div>
  );
}

async function loadStoreWorkspace(): Promise<{
  accounts: MarketplaceAccountView[];
  error?: string;
  publications: MarketplacePublicationRequestView[];
}> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { accounts: [], error: "尚未配置店铺 API。", publications: [] };
  const base = apiBase.replace(/\/$/, "");
  try {
    const [accountsResponse, publicationsResponse] = await Promise.all([
      apiFetch(`${base}/v1/marketplace-accounts`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-publications?limit=100`, { cache: "no-store" }),
    ]);
    if (!accountsResponse.ok) throw new Error(`店铺连接读取失败 (${accountsResponse.status})`);
    if (!publicationsResponse.ok) throw new Error(`发布记录读取失败 (${publicationsResponse.status})`);
    return {
      accounts: await accountsResponse.json() as MarketplaceAccountView[],
      publications: await publicationsResponse.json() as MarketplacePublicationRequestView[],
    };
  } catch (error) {
    return { accounts: [], error: error instanceof Error ? error.message : "店铺连接读取失败", publications: [] };
  }
}
