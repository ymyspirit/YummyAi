import type { MarketplaceAccountView } from "@yummyai/contracts";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { MarketplaceAccountViewSchema } from "@yummyai/contracts/marketplace/store";
import { MarketplacePublicationRequestViewSchema } from "@yummyai/contracts/marketplace/publication";
import { OrderViewSchema } from "@yummyai/contracts/order/order";
import { Store } from "lucide-react";

import { MarketplaceAccountDetail } from "../../../../features/marketplaces/marketplace-accounts-workspace";
import { apiFetch } from "../../../../server-api";
import { erpAmbientIdentity } from "../../../../erp-auth/request";
import { assertErpIdentityCurrent } from "../../../../erp-auth/server";
import { readIdentityJson } from "../../../../identity/core";
import { localServiceAuth } from "../../../../web-auth-mode";

export const dynamic = "force-dynamic";

export default async function StoreDetailPage({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<{ oauth?: string; reason?: string }> }) {
  const [{ accountId }, query] = await Promise.all([params, searchParams]);
  const result = await loadStore(accountId);
  const notice = query.oauth === "success" ? { message: "请核对当前授权状态 完成后再同步店铺能力", status: "success" as const } : query.oauth === "failed" ? { message: "平台授权未完成 请重新读取授权状态", status: "error" as const } : undefined;
  return <div className="research-shell store-shell"><main className="research-main store-main">{result.account ? <MarketplaceAccountDetail account={result.account} error={result.error} listingCount={result.listingCount} notice={notice} orderCount={result.orderCount} publicationCount={result.publicationCount} contextAuthority={result.contextAuthority} /> : <section className="analysis-error" role="alert"><Store size={28} /><h1>未找到店铺连接</h1><p>{result.error ?? "该连接不存在或当前成员无权访问。"}</p><a href="/stores">返回店铺运营</a></section>}</main></div>;
}

async function loadStore(accountId: string): Promise<{ account?: MarketplaceAccountView; error?: string; listingCount: number | null; orderCount: number | null; publicationCount: number | null; contextAuthority?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置店铺 API。", listingCount: 0, orderCount: 0, publicationCount: 0 };
  const base = apiBase.replace(/\/$/, "");
  try {
    EntityIdSchema.parse(accountId);
    const identity = localServiceAuth() ? null : await erpAmbientIdentity();
    const [accountResponse, publicationsResponse, ordersResponse] = await Promise.all([
      apiFetch(`${base}/v1/marketplace-accounts/${accountId}`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-publications?accountId=${encodeURIComponent(accountId)}&limit=100`, { cache: "no-store" }),
      apiFetch(`${base}/v1/orders?accountId=${encodeURIComponent(accountId)}&limit=100`, { cache: "no-store" }),
    ]);
    if (!accountResponse.ok) return { error: `店铺连接读取失败 (${accountResponse.status})`, listingCount: 0, orderCount: 0, publicationCount: 0 };
    const account = MarketplaceAccountViewSchema.strict().parse(await readIdentityJson(accountResponse, 131_072));
    if (account.id !== accountId) throw new Error("marketplace_account_mismatch");
    const publications = publicationsResponse.ok ? MarketplacePublicationRequestViewSchema.strict().array().max(100)
      .parse(await readIdentityJson(publicationsResponse, 2_097_152)) : null;
    const orders = ordersResponse.ok ? OrderViewSchema.strict().array().max(100).parse(await readIdentityJson(ordersResponse, 2_097_152)) : null;
    if (publications?.some(value => value.accountId !== accountId) || orders?.some(value => value.accountId !== accountId))
      throw new Error("marketplace_related_account_mismatch");
    if (identity) await assertErpIdentityCurrent(identity);
    const errors = [
      ...(!publicationsResponse.ok ? [`发布记录读取失败 (${publicationsResponse.status})`] : []),
      ...(!ordersResponse.ok ? [`订单摘要读取失败 (${ordersResponse.status})`] : []),
    ];
    return {
      account,
      listingCount: publications ? new Set(publications.map((publication) => publication.listingId)).size : null,
      orderCount: orders?.length ?? null,
      publicationCount: publications?.length ?? null,
      ...(identity ? { contextAuthority: identity.authority } : {}),
      ...(errors.length ? { error: errors.join("；") } : {}),
    };
  } catch { return { error: "店铺连接或相关记录暂时无法核对 请重新读取", listingCount: null, orderCount: null, publicationCount: null }; }
}
