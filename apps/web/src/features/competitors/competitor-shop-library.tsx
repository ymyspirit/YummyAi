import { ExternalLink, MapPin, PackageSearch, Store, UsersRound } from "lucide-react";

export interface CompetitorShopSnapshotView {
  about: string | null;
  activeListingCount: number | null;
  admirerCount: number | null;
  announcement: string | null;
  badges: string[];
  capturedAt: string;
  location: string | null;
  openedYear: number | null;
  ownerName: string | null;
  policies: string | null;
  productionPartners: string[];
  rating: string | number | null;
  reviewCount: number | null;
  salesCount: number | null;
  snapshotKind: "listing" | "shop";
  sourceUrl: string;
  yearsOnPlatform: number | null;
}

export interface CompetitorShopView {
  externalId: string | null;
  id: string;
  lastCapturedAt: string;
  latestSnapshot: CompetitorShopSnapshotView | null;
  latestStatus: "complete" | "partial" | "failed";
  marketplace: string;
  normalizedUrl: string;
  platform: "amazon" | "etsy";
  shopName: string;
}

export function CompetitorShopLibrary({ items }: { items: CompetitorShopView[] }) {
  if (!items.length) {
    return (
      <div className="competitor-empty">
        <Store size={28} />
        <strong>还没有竞争店铺证据</strong>
        <span>打开 Etsy 店铺页使用 YummyAI Capture，或先采集该店铺的商品链接。</span>
      </div>
    );
  }

  return (
    <div className="competitor-ledger">
      {items.map((shop) => {
        const snapshot = shop.latestSnapshot;
        return (
          <article className="competitor-record" key={shop.id}>
            <header>
              <div className="competitor-identity">
                <span className={`platform-stamp platform-${shop.platform}`}>{shop.platform}</span>
                <div>
                  <h2>{shop.shopName}</h2>
                  <p><MapPin size={12} />{snapshot?.location ?? "所在地未公开"}</p>
                </div>
              </div>
              <a href={shop.normalizedUrl} target="_blank" rel="noreferrer">
                查看店铺<ExternalLink size={13} />
              </a>
            </header>

            <dl className="shop-signal-rail">
              <Signal label="累计销量" value={count(snapshot?.salesCount)} />
              <Signal label="店铺评分" value={snapshot?.rating ?? "—"} />
              <Signal label="评论规模" value={count(snapshot?.reviewCount)} />
              <Signal label="在售商品" value={count(snapshot?.activeListingCount)} />
              <Signal label="收藏者" value={count(snapshot?.admirerCount)} />
            </dl>

            <div className="competitor-detail-grid">
              <section>
                <p className="section-code">SHOP PROFILE</p>
                <dl>
                  <div><dt>店主 / 主理人</dt><dd>{snapshot?.ownerName ?? "未公开"}</dd></div>
                  <div><dt>开店年份</dt><dd>{snapshot?.openedYear ?? "未公开"}</dd></div>
                  <div><dt>经营年限</dt><dd>{snapshot?.yearsOnPlatform === null || snapshot?.yearsOnPlatform === undefined ? "未公开" : `${snapshot.yearsOnPlatform} 年`}</dd></div>
                  <div><dt>生产伙伴</dt><dd>{snapshot?.productionPartners.length ?? 0}</dd></div>
                </dl>
              </section>
              <section className="competitor-announcement">
                <p className="section-code">POSITIONING SIGNAL</p>
                <blockquote>{snapshot?.announcement ?? snapshot?.about ?? "店铺页尚未采集公告或简介。"}</blockquote>
              </section>
              <section className="competitor-evidence-meta">
                <p className="section-code">EVIDENCE FRESHNESS</p>
                <p><PackageSearch size={14} />{snapshot?.snapshotKind === "shop" ? "完整店铺页快照" : "来自商品页的卖家摘要"}</p>
                <p><UsersRound size={14} />{snapshot?.badges.length ? snapshot.badges.join(" · ") : "暂无平台徽章"}</p>
                <time dateTime={shop.lastCapturedAt}>{formatDate(shop.lastCapturedAt)}</time>
                <span className={`status-chip status-${shop.latestStatus}`}>{shop.latestStatus}</span>
              </section>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Signal({ label, value }: { label: string; value: string | number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
