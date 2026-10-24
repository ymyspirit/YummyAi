import type { MarketplaceAccountView, MarketplacePublicationRequestView } from "@yummyai/contracts";
import { MarketplaceAccountViewSchema } from "@yummyai/contracts/marketplace/store";
import { MarketplacePublicationRequestViewSchema } from "@yummyai/contracts/marketplace/publication";
import { ShieldCheck } from "lucide-react";

import { MarketplaceAccountsWorkspace } from "../../../features/marketplaces/marketplace-accounts-workspace";
import { apiFetch } from "../../../server-api";
import { erpAmbientIdentity } from "../../../erp-auth/request";
import { assertErpIdentityCurrent } from "../../../erp-auth/server";
import { readIdentityJson } from "../../../identity/core";
import { localServiceAuth } from "../../../web-auth-mode";

export const dynamic = "force-dynamic";

export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string; reason?: string }>;
}) {
  const [result, query] = await Promise.all([loadStoreWorkspace(), searchParams]);
  const oauthNotice = query.oauth === "success"
    ? { message: "请核对当前授权状态 完成后再同步店铺能力", status: "success" as const }
    : query.oauth === "failed"
      ? { message: "平台授权未完成 请重新读取授权状态", status: "error" as const }
      : undefined;
  return (
    <div className="research-shell store-shell">
      <main className="research-main store-main">
        <header className="store-header">
          <div>
            <p className="kicker">MARKETPLACE / CONNECTION CONTROL</p>
            <h1>店铺运营</h1>
            <p>建立店铺档案，归集订单；在单店详情管理平台连接与授权状态。</p>
          </div>
          <span><ShieldCheck size={18} />TENANT ISOLATED</span>
        </header>
        <MarketplaceAccountsWorkspace
          accounts={result.accounts}
          error={result.error}
          oauthNotice={oauthNotice}
          publications={result.publications}
          contextAuthority={result.contextAuthority}
        />
      </main>
    </div>
  );
}

async function loadStoreWorkspace(): Promise<{
  accounts: MarketplaceAccountView[];
  error?: string;
  publications: MarketplacePublicationRequestView[];
  contextAuthority?: string;
}> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { accounts: [], error: "尚未配置店铺 API。", publications: [] };
  const base = apiBase.replace(/\/$/, "");
  try {
    const identity = localServiceAuth() ? null : await erpAmbientIdentity();
    const [accountsResponse, publicationsResponse] = await Promise.all([
      apiFetch(`${base}/v1/marketplace-accounts`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-publications?limit=100`, { cache: "no-store" }),
    ]);
    if (!accountsResponse.ok || !publicationsResponse.ok) throw new Error("marketplace_workspace_unavailable");
    const [accounts, publications] = await Promise.all([
      readIdentityJson(accountsResponse, 2_097_152).then(value => MarketplaceAccountViewSchema.strict().array().max(1_000).parse(value)),
      readIdentityJson(publicationsResponse, 2_097_152).then(value => MarketplacePublicationRequestViewSchema.strict().array().max(100).parse(value)),
    ]);
    if (identity) await assertErpIdentityCurrent(identity);
    return {
      accounts, publications, ...(identity ? { contextAuthority: identity.authority } : {}),
    };
  } catch {
    return { accounts: [], error: "店铺连接或相关记录暂时无法核对 请重新读取", publications: [] };
  }
}
