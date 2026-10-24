import Link from "next/link";
import { ChevronDown } from "lucide-react";

import { DateFilter } from "../../../features/research/date-filter";
import { ResearchTable } from "../../../features/research/research-table";
import { loadResearch, loadProductTypes } from "../../../features/research/research-page-data";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ResearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of [
    "item",
    "visibility",
    "researchStatus",
    "platform",
    "marketplace",
    "captureStatus",
    "classificationStatus",
    "priceMin",
    "priceMax",
    "productType",
    "q",
    "rating",
    "tags",
    "project",
    "owner",
    "dateFrom",
    "dateTo",
    "cursor",
  ]) {
    const value = params[key];
    if (typeof value === "string" && value) query.set(key, value);
  }
  const [result, productTypes] = await Promise.all([loadResearch(query), loadProductTypes(stringValue(params.visibility))]);
  const nextPageHref = result.nextCursor ? researchPageHref(query, result.nextCursor) : null;
  const advancedCount = ["marketplace", "captureStatus", "priceMin", "priceMax", "rating", "tags", "project", "owner", "dateFrom", "dateTo"]
    .filter(key => stringValue(params[key])).length;
  return (
    <div className="research-shell">
      <main className="research-main">
        <header className="page-header">
          <div>
            <p className="kicker">RESEARCH / EVIDENCE INDEX</p>
            <h1>研究资料库</h1>
            <p>浏览竞品证据、整理研究结论，选中资料后加入创意项目。</p>
          </div>
          <div className="capture-prompt">
            在 Amazon 或 Etsy 商品页使用浏览器扩展，将当前公开证据发送到这里。
          </div>
        </header>
        <section className="filter-panel research-filters" aria-label="研究资料筛选">
          <form method="get">
            <div className="research-filter-grid">
            <label>
              资料范围
              <select name="visibility" defaultValue={stringValue(params.visibility) || "active"}>
                <option value="active">日常资料</option>
                <option value="archived">已归档</option>
                <option value="all">全部资料</option>
              </select>
            </label>
            <label className="research-query-filter">
              搜索标题
              <input
                name="q"
                type="search"
                defaultValue={stringValue(params.q)}
                placeholder="pillow, mug, gift tag"
              />
            </label>
            <label>
              产品类型
              <select name="productType" defaultValue={stringValue(params.productType)}>
                <option value="">全部类型</option>
                {productTypes.items.map((type) => (
                  <option key={type.key} value={type.key}>
                    {type.name} ({type.total})
                  </option>
                ))}
              </select>
            </label>
            <label>
              研究状态
              <select name="researchStatus" defaultValue={stringValue(params.researchStatus)}>
                <option value="">全部研究</option>
                <option value="unreviewed">待研究</option>
                <option value="analyzed">已研究</option>
                <option value="parked">暂不采用</option>
              </select>
            </label>
            <label>
              分类状态
              <select
                name="classificationStatus"
                defaultValue={stringValue(params.classificationStatus)}
              >
                <option value="">全部状态</option>
                <option value="confirmed">已确认</option>
                <option value="suggested">待复核</option>
                <option value="unclassified">未分类</option>
              </select>
            </label>
            <label>
              平台
              <select name="platform" defaultValue={stringValue(params.platform)}>
                <option value="">全部</option>
                <option value="amazon">Amazon</option>
                <option value="etsy">Etsy</option>
              </select>
            </label>
            </div>
            <details className="research-advanced-filters" open={advancedCount > 0}>
              <summary><ChevronDown size={15} aria-hidden="true" />更多筛选{advancedCount > 0 ? ` · ${advancedCount} 项已应用` : ""}</summary>
              <div className="research-filter-grid">
            <label>
              站点
              <input
                name="marketplace"
                defaultValue={stringValue(params.marketplace)}
                placeholder="amazon.com"
              />
            </label>
            <label>
              采集状态
              <select name="captureStatus" defaultValue={stringValue(params.captureStatus)}>
                <option value="">全部</option>
                <option value="complete">完成</option>
                <option value="partial">部分完成</option>
                <option value="failed">失败</option>
              </select>
            </label>
            <label>
              最低价格
              <input
                name="priceMin"
                type="number"
                min="0"
                step="0.01"
                defaultValue={stringValue(params.priceMin)}
              />
            </label>
            <label>
              最高价格
              <input
                name="priceMax"
                type="number"
                min="0"
                step="0.01"
                defaultValue={stringValue(params.priceMax)}
              />
            </label>
            <label>
              最低评分
              <input
                name="rating"
                type="number"
                min="0"
                max="5"
                step="0.1"
                defaultValue={stringValue(params.rating)}
              />
            </label>
            <label>
              标签
              <input
                name="tags"
                defaultValue={stringValue(params.tags)}
                placeholder="gift, seasonal"
              />
            </label>
            <label>
              项目 ID
              <input name="project" defaultValue={stringValue(params.project)} />
            </label>
            <label>
              负责人 ID
              <input name="owner" defaultValue={stringValue(params.owner)} />
            </label>
            <DateFilter
              label="开始日期"
              name="dateFrom"
              defaultValue={stringValue(params.dateFrom)}
            />
            <DateFilter label="结束日期" name="dateTo" defaultValue={stringValue(params.dateTo)} />
              </div>
            </details>
            <div className="research-filter-actions">
            <button className="filter-button" type="submit">
              应用筛选
            </button>
            <Link className="filter-reset" href="/research">
              清除
            </Link>
            </div>
          </form>
        </section>
        <section className="library-frame" aria-labelledby="library-title">
          <div className="library-heading">
            <div>
              <p className="section-code">LIVE INDEX</p>
              <h2 id="library-title">证据条目</h2>
            </div>
            <span className="result-count">{result.error ? "暂不可用" : `${result.total} RESULTS`}</span>
          </div>
          {result.error && (
            <div role="alert" className="empty-library">
              <p>{result.error}</p>
              <a className="research-reload" href={`/research${query.size ? `?${query}` : ""}`}>重新加载</a>
            </div>
          )}
          {!result.error && (
            <ResearchTable
              items={result.items}
              nextPageHref={nextPageHref}
              productTypes={productTypes.items}
              initialItemId={stringValue(params.item) || undefined}
              initialSnapshotId={stringValue(params.snapshot) || undefined}
              studyRevisionId={stringValue(params.study) || undefined}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function researchPageHref(query: URLSearchParams, cursor: string) {
  const next = new URLSearchParams(query);
  next.set("cursor", cursor);
  return `/research?${next.toString()}`;
}

function stringValue(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}
