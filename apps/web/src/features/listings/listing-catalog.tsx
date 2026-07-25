"use client";

import { AlertTriangle, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Image as ImageIcon, ImageOff, ListFilter, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

export interface ListingCatalogItemView {
  id: string;
  spuId: string;
  spuCode: string;
  spuName: string;
  platform: "amazon" | "etsy";
  marketplaceId?: string;
  locale: string;
  status: "draft" | "in_review" | "approved" | "archived";
  primaryVersionId?: string;
  versionId: string;
  versionNumber: number;
  title: string;
  hasMainImage: boolean;
  completeness: number;
  blockerCount: number;
  source: "human" | "ai";
  updatedAt: string;
}

export interface ListingCatalogPageView {
  items: ListingCatalogItemView[];
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ListingCatalogFilters {
  q?: string;
  platform?: string;
  marketplaceId?: string;
  locale?: string;
  status?: string;
  completeness?: string;
  blockers?: string;
  sort?: string;
  direction?: string;
}

export function ListingCatalog({ catalog, filters }: { catalog: ListingCatalogPageView; filters: ListingCatalogFilters }) {
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const selectedItems = useMemo(() => catalog.items.filter((item) => selected.includes(item.id)), [catalog.items, selected]);
  const readyCount = selectedItems.filter((item) => item.status === "approved" && item.blockerCount === 0 && item.primaryVersionId).length;
  const allVisibleSelected = catalog.items.length > 0 && catalog.items.every((item) => selected.includes(item.id));

  useEffect(() => setHydrated(true), []);

  return (
    <section aria-busy={!hydrated} className="listing-catalog-frame" data-hydrated={hydrated ? "true" : "false"} aria-labelledby="listing-catalog-title">
      <header className="listing-library-header">
        <div><p className="section-code">CATALOG WORKSPACE</p><h2 id="listing-catalog-title">Listing 目录</h2></div>
        <span>{catalog.total} RECORDS</span>
      </header>

      <form className="listing-catalog-filters" method="get">
        <label className="listing-catalog-search"><span>搜索</span><div><Search size={15} /><input defaultValue={filters.q} name="q" placeholder="标题、SPU、Listing ID" /></div></label>
        <FilterSelect label="平台" name="platform" value={filters.platform} options={[['', '全部平台'], ['amazon', 'Amazon'], ['etsy', 'Etsy']]} />
        <FilterInput label="站点 / 店铺标识" name="marketplaceId" placeholder="ATVPDKIKX0DER" value={filters.marketplaceId} />
        <FilterInput label="语言" name="locale" placeholder="en-US" value={filters.locale} />
        <FilterSelect label="状态" name="status" value={filters.status} options={[['', '全部状态'], ['draft', '草稿'], ['in_review', '评审中'], ['approved', '已审批'], ['archived', '已归档']]} />
        <FilterSelect label="完整度" name="completeness" value={filters.completeness ?? "all"} options={[["all", "全部"], ["low", "低于 80%"], ["partial", "80–99%"], ["complete", "100%"]]} />
        <FilterSelect label="阻断" name="blockers" value={filters.blockers ?? "all"} options={[["all", "全部"], ["with", "有阻断"], ["without", "无阻断"]]} />
        <FilterSelect label="排序" name="sort" value={filters.sort ?? "updatedAt"} options={[["updatedAt", "最近更新"], ["title", "标题"], ["completeness", "完整度"], ["versionNumber", "版本号"]]} />
        <FilterSelect label="方向" name="direction" value={filters.direction ?? "desc"} options={[["desc", "降序"], ["asc", "升序"]]} />
        <button type="submit"><ListFilter size={15} />应用</button>
      </form>

      <div className="listing-bulk-gate" aria-live="polite">
        <div><strong>{selected.length}</strong><span>已选</span></div>
        <div><strong>{readyCount}</strong><span>通过批量发布门禁</span></div>
        <p>{selected.length === 0 ? "选择 Listing 后查看批量发布资格。" : readyCount === selected.length ? "所选项目均已审批且无阻断，可在下方创建发布批次。" : `${selected.length - readyCount} 个所选项目尚未审批、存在阻断或没有已批准主版本。`}</p>
        <a aria-disabled={readyCount < 2} href="#publication-batches">前往批量发布</a>
      </div>

      <div className="listing-index-table-scroll">
        <table className="listing-catalog-table">
          <thead><tr><th className="listing-select-cell"><input aria-label="选择当前页全部 Listing" checked={allVisibleSelected} disabled={!hydrated} onChange={(event) => setSelected(event.target.checked ? catalog.items.map((item) => item.id) : [])} type="checkbox" /></th><th>媒体</th><th>标题 / SPU</th><th>渠道</th><th>版本</th><th>完整度</th><th>状态</th><th>更新时间</th><th aria-label="操作" /></tr></thead>
          <tbody>{catalog.items.map((item) => (
            <tr key={item.id}>
              <td className="listing-select-cell"><input aria-label={`选择 ${item.title || item.spuCode}`} checked={selected.includes(item.id)} disabled={!hydrated} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} type="checkbox" /></td>
              <td><span className={`listing-media-signal ${item.hasMainImage ? "available" : "missing"}`} title={item.hasMainImage ? "主图已关联" : "主图缺失"}>{item.hasMainImage ? <ImageIcon size={17} /> : <ImageOff size={17} />}</span></td>
              <td><strong className="listing-catalog-title">{item.title || "未填写标题"}</strong><span>{item.spuCode} · {item.spuName}</span><code>{item.id}</code></td>
              <td><span className={`publication-platform ${item.platform}`}>{item.platform === "amazon" ? "AMZ" : "ETSY"}</span><b>{item.marketplaceId ?? "未指定店铺"}</b><small>{item.locale}</small></td>
              <td><strong>V{String(item.versionNumber).padStart(2, "0")}</strong><span>{item.source === "ai" ? "AI 草稿" : "人工版本"}</span></td>
              <td><strong>{item.completeness}%</strong><span className={item.blockerCount ? "listing-blocker-count" : "listing-clear-count"}>{item.blockerCount ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}{item.blockerCount ? `${item.blockerCount} 阻断` : "无阻断"}</span></td>
              <td><span className={`listing-index-status ${item.status}`}>{statusLabel(item.status)}</span></td>
              <td><time>{formatDate(item.updatedAt)}</time></td>
              <td><Link aria-label={`打开 ${item.title || item.spuCode}`} href={`/listings/${item.id}`}><ArrowRight size={16} /></Link></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {catalog.items.length === 0 ? <div className="listing-index-empty"><Search size={24} /><strong>没有匹配的 Listing</strong><span>调整搜索或筛选条件后重试。</span></div> : null}
      <nav className="listing-pagination" aria-label="Listing 分页">
        <Link aria-disabled={catalog.page <= 1} href={pageHref(filters, Math.max(1, catalog.page - 1))}><ChevronLeft size={15} />上一页</Link>
        <span>第 {catalog.page} / {catalog.pages} 页 · 共 {catalog.total} 条</span>
        <Link aria-disabled={catalog.page >= catalog.pages} href={pageHref(filters, Math.min(catalog.pages, catalog.page + 1))}>下一页<ChevronRight size={15} /></Link>
      </nav>
    </section>
  );
}

function FilterSelect({ label, name, options, value }: { label: string; name: string; options: Array<[string, string]>; value?: string }) {
  return <label><span>{label}</span><select defaultValue={value ?? ""} name={name}>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select></label>;
}

function FilterInput({ label, name, placeholder, value }: { label: string; name: string; placeholder: string; value?: string }) {
  return <label><span>{label}</span><input defaultValue={value} name={name} placeholder={placeholder} /></label>;
}

function pageHref(filters: ListingCatalogFilters, page: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  query.set("page", String(page));
  return `/listings?${query.toString()}`;
}

function statusLabel(status: ListingCatalogItemView["status"]) { return ({ approved: "已审批", archived: "已归档", draft: "草稿", in_review: "评审中" })[status]; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
