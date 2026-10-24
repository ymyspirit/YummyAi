import {
  CompetitorShopLibrary,
} from "../../../features/competitors/competitor-shop-library";
import { loadCompetitorShops } from "../../../features/competitors/competitor-shop-data";

export const dynamic = "force-dynamic";

export default async function CompetitorShopsPage() {
  const result = await loadCompetitorShops();
  return (
    <div className="research-shell competitor-shell">
      <main className="research-main competitor-main">
        <header className="competitor-header">
          <div>
            <p className="kicker">COMPETITOR / SHOP INTELLIGENCE</p>
            <h1>竞争店铺雷达</h1>
            <p>把销量、商品规模、评价、定位和政策放进同一条证据链，持续观察竞争店铺变化。</p>
          </div>
          <aside>
            <span>采集入口</span>
            <strong>Amazon / Etsy 公开页面</strong>
            <p>商品页形成卖家摘要；Etsy 店铺页可补全公告、简介、成员、生产伙伴与政策。</p>
          </aside>
        </header>
        {result.error && (
          <p className="competitor-error" role="alert">
            {result.error}
          </p>
        )}
        {!result.error && <CompetitorShopLibrary items={result.items} />}
      </main>
    </div>
  );
}

