import {
  ResearchListResponseSchema,
  ResearchProductTypeFacetResponseSchema,
  type ResearchProductTypeFacet,
} from "@yummyai/contracts/research";
import Link from "next/link";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { DateFilter } from "../../../features/research/date-filter";
import { ResearchTable } from "../../../features/research/research-table";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ResearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of [
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
  const [result, productTypes] = await Promise.all([loadResearch(query), loadProductTypes()]);
  const nextPageHref = result.nextCursor ? researchPageHref(query, result.nextCursor) : null;
  return (
    <div className="research-shell">
      <ErpSidebar
        active="research"
        contextLabel="EVIDENCE ERP"
        note="公开页面证据、版本快照与媒体状态均保留来源链路。"
      />
      <main className="research-main">
        <header className="page-header">
          <div>
            <p className="kicker">RESEARCH / EVIDENCE INDEX</p>
            <h1>研究资料库</h1>
            <p>用版本化快照追踪商品页面变化，而不是覆盖历史。</p>
          </div>
          <div className="capture-prompt">
            在 Amazon 或 Etsy 商品页使用浏览器扩展，将当前公开证据发送到这里。
          </div>
        </header>
        <section className="filter-panel" aria-label="研究资料筛选">
          <form method="get">
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
            <label>
              站点
              <input
                name="marketplace"
                defaultValue={stringValue(params.marketplace)}
                placeholder="amazon.com"
              />
            </label>
            <label>
              状态
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
            <button className="filter-button" type="submit">
              应用筛选
            </button>
            <Link className="filter-reset" href="/research">
              清除
            </Link>
          </form>
        </section>
        <section className="library-frame" aria-labelledby="library-title">
          <div className="library-heading">
            <div>
              <p className="section-code">LIVE INDEX</p>
              <h2 id="library-title">证据条目</h2>
            </div>
            <span className="result-count">{result.total} RESULTS</span>
          </div>
          {result.error && (
            <p role="alert" className="empty-library">
              {result.error}
            </p>
          )}
          {!result.error && (
            <ResearchTable
              items={result.items}
              nextPageHref={nextPageHref}
              productTypes={productTypes.items}
            />
          )}
        </section>
      </main>
    </div>
  );
}

export async function loadResearch(query: URLSearchParams): Promise<{
  items: ReturnType<typeof ResearchListResponseSchema.parse>["items"];
  nextCursor: string | null;
  total: number;
  error?: string;
}> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) {
    return {
      items: [],
      nextCursor: null,
      total: 0,
      error: "尚未配置研究 API。请设置 API_BASE_URL 后重试。",
    };
  }
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/research-items?${query}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("身份会话无效，请重新登录。");
      if (response.status === 403) throw new Error("当前成员没有 research:read 权限。");
      throw new Error(`资料库读取失败 (${response.status})`);
    }
    return ResearchListResponseSchema.parse(await response.json());
  } catch (error) {
    return {
      items: [],
      nextCursor: null,
      total: 0,
      error: error instanceof Error ? error.message : "资料库读取失败",
    };
  }
}

async function loadProductTypes(): Promise<{ items: ResearchProductTypeFacet[] }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [] };
  try {
    const response = await apiFetch(
      `${apiBase.replace(/\/$/, "")}/v1/research-items/product-types`,
      { cache: "no-store" },
    );
    if (!response.ok) return { items: [] };
    return ResearchProductTypeFacetResponseSchema.parse(await response.json());
  } catch {
    return { items: [] };
  }
}

function researchPageHref(query: URLSearchParams, cursor: string) {
  const next = new URLSearchParams(query);
  next.set("cursor", cursor);
  return `/research?${next.toString()}`;
}

function stringValue(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}
