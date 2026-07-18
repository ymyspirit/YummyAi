import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { ResearchTable, type ResearchItemView } from "../../../features/research/research-table";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ResearchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["platform", "marketplace", "captureStatus", "priceMin", "priceMax", "rating", "tags", "project", "owner", "dateFrom", "dateTo", "cursor"]) {
    const value = params[key];
    if (typeof value === "string" && value) query.set(key, value);
  }
  const result = await loadResearch(query);
  return (
    <div className="research-shell">
      <ErpSidebar active="research" contextLabel="EVIDENCE ERP" note="公开页面证据、版本快照与媒体状态均保留来源链路。" />
      <main className="research-main">
        <header className="page-header"><div><p className="kicker">RESEARCH / EVIDENCE INDEX</p><h1>研究资料库</h1><p>用版本化快照追踪商品页面变化，而不是覆盖历史。</p></div><div className="capture-prompt">在 Amazon 或 Etsy 商品页使用浏览器扩展，将当前公开证据发送到这里。</div></header>
        <section className="filter-panel" aria-label="研究资料筛选">
          <form method="get">
            <label>平台<select name="platform" defaultValue={stringValue(params.platform)}><option value="">全部</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label>
            <label>站点<input name="marketplace" defaultValue={stringValue(params.marketplace)} placeholder="amazon.com" /></label>
            <label>状态<select name="captureStatus" defaultValue={stringValue(params.captureStatus)}><option value="">全部</option><option value="complete">完成</option><option value="partial">部分完成</option><option value="failed">失败</option></select></label>
            <label>最低价格<input name="priceMin" type="number" min="0" step="0.01" defaultValue={stringValue(params.priceMin)} /></label>
            <label>最高价格<input name="priceMax" type="number" min="0" step="0.01" defaultValue={stringValue(params.priceMax)} /></label>
            <label>最低评分<input name="rating" type="number" min="0" max="5" step="0.1" defaultValue={stringValue(params.rating)} /></label>
            <label>标签<input name="tags" defaultValue={stringValue(params.tags)} placeholder="gift, seasonal" /></label>
            <label>项目 ID<input name="project" defaultValue={stringValue(params.project)} /></label>
            <label>负责人 ID<input name="owner" defaultValue={stringValue(params.owner)} /></label>
            <label>开始日期<input name="dateFrom" type="date" defaultValue={stringValue(params.dateFrom)} /></label>
            <label>结束日期<input name="dateTo" type="date" defaultValue={stringValue(params.dateTo)} /></label>
            <button className="filter-button" type="submit">应用筛选</button>
          </form>
        </section>
        <section className="library-frame" aria-labelledby="library-title">
          <div className="library-heading"><div><p className="section-code">LIVE INDEX</p><h2 id="library-title">证据条目</h2></div><span className="result-count">{result.items.length} RESULTS</span></div>
          {result.error && <p role="alert" className="empty-library">{result.error}</p>}
          {!result.error && <ResearchTable items={result.items} nextCursor={result.nextCursor} />}
        </section>
      </main>
    </div>
  );
}

async function loadResearch(query: URLSearchParams): Promise<{ items: ResearchItemView[]; nextCursor: string | null; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], nextCursor: null };
  try {
    const response = await fetch(`${apiBase.replace(/\/$/, "")}/v1/research-items?${query}`, { cache:"no-store", headers: process.env.API_ACCESS_TOKEN ? { authorization:`Bearer ${process.env.API_ACCESS_TOKEN}` } : {} });
    if (!response.ok) throw new Error(`资料库读取失败 (${response.status})`);
    return await response.json() as { items: ResearchItemView[]; nextCursor: string | null };
  } catch (error) { return { items: [], nextCursor:null, error:error instanceof Error ? error.message : "资料库读取失败" }; }
}

function stringValue(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }
