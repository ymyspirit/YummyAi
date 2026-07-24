import type { MarketplaceAccountView, MarketplacePublicationBatchView } from "@yummyai/contracts";
import { ArrowRight, FileText } from "lucide-react";
import Link from "next/link";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import {
  PublicationBatchWorkspace,
  type PublicationBatchCandidate,
} from "../../../features/marketplaces/publication-batch-workspace";
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

interface ListingDetailPayload {
  listing: ListingSummary;
  version: {
    content: {
      title: string;
      variants: Array<{ skuCode: string; skuId: string }>;
    };
    id: string;
    versionNumber: number;
  };
}

interface ListingsWorkspaceResult {
  accounts: MarketplaceAccountView[];
  batchError?: string;
  batches: MarketplacePublicationBatchView[];
  candidates: PublicationBatchCandidate[];
  items: ListingSummary[];
  listingError?: string;
}

export default async function ListingsPage() {
  const result = await loadListingsWorkspace();
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
          <span><FileText size={18} />{result.items.length} LISTINGS · {result.batches.length} BATCHES</span>
        </header>
        {result.listingError ? <p className="listing-index-error" role="alert">{result.listingError}</p> : null}
        <PublicationBatchWorkspace
          accounts={result.accounts}
          batches={result.batches}
          candidates={result.candidates}
          error={result.batchError}
        />
        <section className="listing-index-frame" aria-labelledby="listing-library-title">
          <header className="listing-library-header">
            <div><p className="section-code">VERSION LIBRARY</p><h2 id="listing-library-title">Listing 版本</h2></div>
            <span>{result.items.length} RECORDS</span>
          </header>
          <div className="listing-index-table-scroll">
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
          </div>
          {result.items.length === 0 && !result.listingError ? <div className="listing-index-empty"><FileText size={24} /><strong>暂无 Listing</strong></div> : null}
        </section>
      </main>
    </div>
  );
}

async function loadListingsWorkspace(): Promise<ListingsWorkspaceResult> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) {
    return {
      accounts: [],
      batches: [],
      candidates: [],
      items: [],
      listingError: "尚未配置刊登 API。",
      batchError: "尚未配置批量发布 API。",
    };
  }
  const base = apiBase.replace(/\/$/, "");
  try {
    const [listingsResponse, accountsResponse, batchesResponse] = await Promise.all([
      apiFetch(`${base}/v1/listings`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-accounts`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-publication-batches?limit=50`, { cache: "no-store" }),
    ]);
    const items = listingsResponse.ok ? await listingsResponse.json() as ListingSummary[] : [];
    const accounts = accountsResponse.ok ? await accountsResponse.json() as MarketplaceAccountView[] : [];
    const batches = batchesResponse.ok ? await batchesResponse.json() as MarketplacePublicationBatchView[] : [];
    const candidateResult = await loadCandidates(base, items);
    const batchErrors = [
      !accountsResponse.ok ? `店铺连接读取失败 (${accountsResponse.status})` : undefined,
      !batchesResponse.ok ? `批次记录读取失败 (${batchesResponse.status})` : undefined,
      candidateResult.error,
    ].filter((entry): entry is string => Boolean(entry));
    return {
      accounts,
      batches,
      candidates: candidateResult.items,
      items,
      ...(!listingsResponse.ok ? { listingError: `刊登列表读取失败 (${listingsResponse.status})` } : {}),
      ...(batchErrors.length ? { batchError: batchErrors.join("；") } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "刊登工作区读取失败";
    return { accounts: [], batches: [], candidates: [], items: [], listingError: message, batchError: message };
  }
}

async function loadCandidates(
  base: string,
  listings: ListingSummary[],
): Promise<{ error?: string; items: PublicationBatchCandidate[] }> {
  const approved = listings.filter((listing) => listing.status === "approved" && listing.primaryVersionId);
  const results = await Promise.all(approved.map(async (listing) => {
    const response = await apiFetch(`${base}/v1/listings/${listing.id}`, { cache: "no-store" });
    if (!response.ok) return { error: `审批版本读取失败 (${response.status})`, items: [] };
    const payload = await response.json() as ListingDetailPayload;
    const common = {
      listingId: listing.id,
      listingVersionId: payload.version.id,
      platform: listing.platform,
      spuCode: listing.spuId.slice(0, 12),
      title: payload.version.content.title,
      versionNumber: payload.version.versionNumber,
    } as const;
    if (listing.platform === "etsy") {
      return { items: [{ ...common, id: `${listing.id}:${payload.version.id}` }] };
    }
    return {
      items: payload.version.content.variants.map((variant) => ({
        ...common,
        id: `${listing.id}:${payload.version.id}:${variant.skuId}`,
        skuCode: variant.skuCode,
        variantSkuId: variant.skuId,
      })),
    };
  }));
  const errors = results.flatMap((result) => result.error ? [result.error] : []);
  return {
    items: results.flatMap((result) => result.items),
    ...(errors.length ? { error: `${errors.length} 个审批版本无法读取。` } : {}),
  };
}

function listingStatusLabel(status: ListingSummary["status"]): string {
  return ({ approved: "已审批", archived: "已归档", draft: "草稿", in_review: "评审中" })[status];
}
