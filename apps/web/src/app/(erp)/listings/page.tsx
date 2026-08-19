import type { MarketplaceAccountView, MarketplacePublicationBatchView } from "@yummyai/contracts";
import { FileText } from "lucide-react";

import { ListingCatalog, type ListingCatalogFilters, type ListingCatalogPageView } from "../../../features/listings/listing-catalog";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { PublicationBatchWorkspace, type PublicationBatchCandidate } from "../../../features/marketplaces/publication-batch-workspace";
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
  version: { content: { title: string; variants: Array<{ skuCode: string; skuId: string }> }; id: string; versionNumber: number };
}

interface ListingsWorkspaceResult {
  accounts: MarketplaceAccountView[];
  batchError?: string;
  batches: MarketplacePublicationBatchView[];
  candidates: PublicationBatchCandidate[];
  catalog: ListingCatalogPageView;
  listingError?: string;
}

export default async function ListingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const rawQuery = await searchParams;
  const filters = normalizeFilters(rawQuery);
  const result = await loadListingsWorkspace(filters, value(rawQuery.page));
  return (
    <div className="research-shell listing-index-shell">
      <ErpSidebar active="listings" contextLabel="LISTING OPS" listingHref="/listings" note="目录用于筛选与门禁判断；编辑器保存为不可变新版本，批准版本才可进入发布轨道。" />
      <main className="research-main listing-index-main">
        <header className="listing-index-header">
          <div><p className="kicker">LISTING / VERSION CONTROL</p><h1>刊登控制台</h1><p>按标题、渠道、门禁和版本状态组织 Listing，再进入内容编辑或批量发布。</p></div>
          <span><FileText size={18} />{result.catalog.total} LISTINGS · {result.batches.length} BATCHES</span>
        </header>
        {result.listingError ? <p className="listing-index-error" role="alert">{result.listingError}</p> : null}
        <ListingCatalog catalog={result.catalog} filters={filters} />
        <section id="publication-batches" className="listing-batch-section" aria-label="批量发布工作区">
          <PublicationBatchWorkspace accounts={result.accounts} batches={result.batches} candidates={result.candidates} error={result.batchError} />
        </section>
      </main>
    </div>
  );
}

async function loadListingsWorkspace(filters: ListingCatalogFilters, page?: string): Promise<ListingsWorkspaceResult> {
  const emptyCatalog = { items: [], page: 1, limit: 25, total: 0, pages: 1 } satisfies ListingCatalogPageView;
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { accounts: [], batches: [], candidates: [], catalog: emptyCatalog, listingError: "尚未配置刊登 API。", batchError: "尚未配置批量发布 API。" };
  const base = apiBase.replace(/\/$/, "");
  const catalogQuery = new URLSearchParams();
  for (const [key, filterValue] of Object.entries(filters)) if (filterValue) catalogQuery.set(key, filterValue);
  if (page) catalogQuery.set("page", page);
  try {
    const [catalogResponse, listingsResponse, accountsResponse, batchesResponse] = await Promise.all([
      apiFetch(`${base}/v1/listings/catalog?${catalogQuery.toString()}`, { cache: "no-store" }),
      apiFetch(`${base}/v1/listings`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-accounts`, { cache: "no-store" }),
      apiFetch(`${base}/v1/marketplace-publication-batches?limit=50`, { cache: "no-store" }),
    ]);
    const catalog = catalogResponse.ok ? await catalogResponse.json() as ListingCatalogPageView : emptyCatalog;
    const listings = listingsResponse.ok ? await listingsResponse.json() as ListingSummary[] : [];
    const accounts = accountsResponse.ok ? await accountsResponse.json() as MarketplaceAccountView[] : [];
    const batches = batchesResponse.ok ? await batchesResponse.json() as MarketplacePublicationBatchView[] : [];
    const candidateResult = await loadCandidates(base, listings);
    const batchErrors = [!accountsResponse.ok ? `店铺连接读取失败 (${accountsResponse.status})` : undefined, !batchesResponse.ok ? `批次记录读取失败 (${batchesResponse.status})` : undefined, candidateResult.error].filter((entry): entry is string => Boolean(entry));
    return {
      accounts, batches, candidates: candidateResult.items, catalog,
      ...(!catalogResponse.ok ? { listingError: `刊登目录读取失败 (${catalogResponse.status})` } : {}),
      ...(batchErrors.length ? { batchError: batchErrors.join("；") } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "刊登工作区读取失败";
    return { accounts: [], batches: [], candidates: [], catalog: emptyCatalog, listingError: message, batchError: message };
  }
}

async function loadCandidates(base: string, listings: ListingSummary[]): Promise<{ error?: string; items: PublicationBatchCandidate[] }> {
  const approved = listings.filter((listing) => listing.status === "approved" && listing.primaryVersionId);
  const results = await Promise.all(approved.map(async (listing) => {
    const response = await apiFetch(`${base}/v1/listings/${listing.id}`, { cache: "no-store" });
    if (!response.ok) return { error: `审批版本读取失败 (${response.status})`, items: [] };
    const payload = await response.json() as ListingDetailPayload;
    const common = { listingId: listing.id, listingVersionId: payload.version.id, platform: listing.platform, spuCode: listing.spuId.slice(0, 12), title: payload.version.content.title, versionNumber: payload.version.versionNumber } as const;
    if (listing.platform === "etsy") return { items: [{ ...common, id: `${listing.id}:${payload.version.id}` }] };
    return { items: payload.version.content.variants.map((variant) => ({ ...common, id: `${listing.id}:${payload.version.id}:${variant.skuId}`, skuCode: variant.skuCode, variantSkuId: variant.skuId })) };
  }));
  const errors = results.flatMap((result) => result.error ? [result.error] : []);
  return { items: results.flatMap((result) => result.items), ...(errors.length ? { error: `${errors.length} 个审批版本无法读取。` } : {}) };
}

function normalizeFilters(query: Record<string, string | string[] | undefined>): ListingCatalogFilters {
  return { q: value(query.q), platform: value(query.platform), marketplaceId: value(query.marketplaceId), locale: value(query.locale), status: value(query.status), completeness: value(query.completeness) || "all", blockers: value(query.blockers) || "all", sort: value(query.sort) || "updatedAt", direction: value(query.direction) || "desc" };
}

function value(input: string | string[] | undefined) { return Array.isArray(input) ? input[0] : input; }
