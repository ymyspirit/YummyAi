import { CompetitorShopLibrary, type CompetitorShopView } from "../../../features/competitors/competitor-shop-library";
import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

export default async function CompetitorShopsPage() {
  const result = await loadCompetitorShops();
  return (
    <div className="research-shell competitor-shell">
      <ErpSidebar
        active="competitors"
        contextLabel="MARKET RADAR"
        note="店铺经营信号采用版本快照保存，商品页摘要与完整店铺页证据分开标记。"
      />
      <main className="research-main competitor-main">
        <header className="competitor-header">
          <div>
            <p className="kicker">COMPETITOR / SHOP INTELLIGENCE</p>
            <h1>竞争店铺雷达</h1>
            <p>把销量、商品规模、评价、定位和政策放进同一条证据链，持续观察竞争店铺变化。</p>
          </div>
          <aside>
            <span>采集入口</span>
            <strong>Etsy 店铺页</strong>
            <p>打开店铺后使用浏览器扩展，可补全公告、简介、成员、生产伙伴与政策。</p>
          </aside>
        </header>
        {result.error && <p className="competitor-error" role="alert">{result.error}</p>}
        {!result.error && <CompetitorShopLibrary items={result.items} />}
      </main>
    </div>
  );
}

async function loadCompetitorShops(): Promise<{ items: CompetitorShopView[]; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [] };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/competitor-shops`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`竞争店铺读取失败 (${response.status})`);
    return (await response.json()) as { items: CompetitorShopView[] };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "竞争店铺读取失败" };
  }
}
