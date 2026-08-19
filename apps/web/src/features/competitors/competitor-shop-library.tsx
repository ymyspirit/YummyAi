"use client";

import type {
  CapturedShopSummary,
  CaptureEhuntShopActiveSection,
  CaptureEhuntShopAnalysis,
  CompetitorShopDraft,
  CompetitorShopSection,
} from "@yummyai/contracts";
import {
  ChevronDown,
  ExternalLink,
  MapPin,
  PackageSearch,
  Store,
  UsersRound,
} from "lucide-react";
import { useState } from "react";

export interface CompetitorShopSnapshotView {
  about: string | null;
  activeListingCount: number | null;
  admirerCount: number | null;
  announcement: string | null;
  badges: string[];
  capturedAt: string;
  draft?: CapturedShopSummary | CompetitorShopDraft;
  location: string | null;
  openedYear: number | null;
  ownerName: string | null;
  policies: string | null;
  productionPartners: string[];
  rating: string | number | null;
  reviewCount: number | null;
  salesCount: number | null;
  shopSections: CompetitorShopSection[];
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

export type CompetitorPlatformFilter = "all" | CompetitorShopView["platform"];

export function CompetitorShopLibrary({ items }: { items: CompetitorShopView[] }) {
  const [platform, setPlatform] = useState<CompetitorPlatformFilter>("all");
  const visibleItems = filterCompetitorShops(items, "all");

  if (!visibleItems.length) {
    return (
      <div className="competitor-empty">
        <Store size={28} />
        <strong>还没有竞争店铺证据</strong>
        <span>打开 Amazon、Etsy 商品页或 Etsy 店铺页使用 YummyAI Capture。</span>
      </div>
    );
  }

  const filteredItems = filterCompetitorShops(visibleItems, platform);
  const platformOptions: {
    label: string;
    value: CompetitorPlatformFilter;
  }[] = [
    { label: "全部", value: "all" },
    { label: "Amazon", value: "amazon" },
    { label: "Etsy", value: "etsy" },
  ];

  return (
    <div className="competitor-library">
      <section className="competitor-filter-bar" aria-label="竞争店铺筛选">
        <div className="competitor-filter-label">
          <span>PLATFORM FILTER</span>
          <strong>平台</strong>
        </div>
        <div className="competitor-platform-filter" role="group" aria-label="按平台筛选">
          {platformOptions.map((option) => (
            <button
              aria-pressed={platform === option.value}
              key={option.value}
              onClick={() => setPlatform(option.value)}
              type="button"
            >
              <span>{option.label}</span>
              <small>{filterCompetitorShops(visibleItems, option.value).length}</small>
            </button>
          ))}
        </div>
        <span className="competitor-filter-count">
          {filteredItems.length} / {visibleItems.length} SHOP RECORDS
        </span>
      </section>

      {filteredItems.length ? (
        <div className="competitor-ledger">
          {filteredItems.map((shop) => {
            const snapshot = shop.latestSnapshot;
            const ehuntAnalysis =
              snapshot?.draft && "parserVersion" in snapshot.draft
                ? snapshot.draft.ehuntAnalysis
                : undefined;
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
                    <blockquote>{positioningSignal(snapshot)}</blockquote>
                  </section>
                  <section className="competitor-evidence-meta">
                    <p className="section-code">EVIDENCE FRESHNESS</p>
                    <p><PackageSearch size={14} />{snapshot?.snapshotKind === "shop" ? "完整店铺页快照" : "来自商品页的卖家摘要"}</p>
                    <p><UsersRound size={14} />{snapshot?.badges.length ? snapshot.badges.join(" · ") : "暂无平台徽章"}</p>
                    <time dateTime={shop.lastCapturedAt}>{formatDate(shop.lastCapturedAt)}</time>
                    <span className={`status-chip status-${shop.latestStatus}`}>{shop.latestStatus}</span>
                  </section>
                </div>
                {ehuntAnalysis && <EhuntShopEvidence analysis={ehuntAnalysis} />}
                <section className="competitor-sections" aria-label="店铺标签">
                  {snapshot?.shopSections.length ? (
                    <details>
                      <summary>
                        <span>
                          <small>SHOP SECTIONS</small>
                          <strong>店铺标签</strong>
                        </span>
                        <span>
                          {snapshot.shopSections.length} 个 · 全部{" "}
                          {count(
                            snapshot.shopSections.find((section) => section.kind === "all")
                              ?.listingCount,
                          )}
                        </span>
                        <ChevronDown size={16} aria-hidden="true" />
                      </summary>
                      <ul>
                        {snapshot.shopSections.map((section) => (
                          <li key={`${section.kind}-${section.externalId}`}>
                            {section.sourceUrl ? (
                              <a href={section.sourceUrl} target="_blank" rel="noreferrer">
                                <span>{section.name}</span>
                                <ExternalLink size={11} aria-hidden="true" />
                              </a>
                            ) : (
                              <span>{section.name}</span>
                            )}
                            <strong>{count(section.listingCount)}</strong>
                          </li>
                        ))}
                      </ul>
                      <p>数量为 Etsy 页面报告值，未逐条访问商品链接。</p>
                    </details>
                  ) : (
                    <div className="competitor-sections-empty">
                      <span>此快照未包含店铺标签</span>
                      <small>使用最新扩展重新采集后显示。</small>
                    </div>
                  )}
                </section>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="competitor-empty competitor-filter-empty">
          <Store size={28} />
          <strong>该平台还没有竞争店铺</strong>
          <span>切换到其他平台，或先采集该平台的公开店铺证据。</span>
        </div>
      )}
    </div>
  );
}

export function filterCompetitorShops(
  items: CompetitorShopView[],
  platform: CompetitorPlatformFilter,
): CompetitorShopView[] {
  return items.filter(
    (shop) =>
      !/^learn more about the seller$/i.test(shop.shopName.trim()) &&
      (platform === "all" || shop.platform === platform),
  );
}

function Signal({ label, value }: { label: string; value: string | number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function EhuntShopEvidence({ analysis }: { analysis: CaptureEhuntShopAnalysis }) {
  return (
    <section className="competitor-ehunt" aria-label="EHunt 店铺分析">
      <header>
        <div>
          <span>THIRD-PARTY EVIDENCE</span>
          <strong>EHunt 店铺分析</strong>
        </div>
        <p>当前已显示的店铺摘要{analysis.activeSection ? ` · ${analysis.activeSection.label}` : ""}</p>
      </header>
      <dl className="competitor-ehunt-metrics">
        <Signal label="周销量" value={analysis.weeklySales?.raw ?? "—"} />
        <Signal label="周销售额" value={analysis.weeklyRevenue?.raw ?? "—"} />
        <Signal label="总销量" value={analysis.totalSales?.raw ?? "—"} />
        <Signal label="总销售额" value={analysis.totalRevenue?.raw ?? "—"} />
        <Signal label="周收藏" value={analysis.weeklyFavorites?.raw ?? "—"} />
        <Signal label="商品总数" value={analysis.listingCount?.raw ?? "—"} />
      </dl>
      <div className="competitor-ehunt-detail">
        <dl>
          <div><dt>开店时间</dt><dd>{analysis.openedAt ?? "未显示"}</dd></div>
          <div><dt>国家</dt><dd>{analysis.country ?? "未显示"}</dd></div>
          <div><dt>主营类目</dt><dd>{analysis.primaryCategory ?? "未显示"}</dd></div>
          <div><dt>Star Seller</dt><dd>{optionalBoolean(analysis.starSeller)}</dd></div>
          <div><dt>总评论</dt><dd>{analysis.totalReviews?.raw ?? "未显示"}</dd></div>
          <div><dt>总收藏</dt><dd>{analysis.totalFavorites?.raw ?? "未显示"}</dd></div>
        </dl>
        {(analysis.paymentMethods.length > 0 || analysis.socialMedia.length > 0) && (
          <div className="competitor-ehunt-chips">
            {analysis.paymentMethods.length > 0 && (
              <div>
                <span>支付方式</span>
                <ul>
                  {analysis.paymentMethods.map((method) => <li key={method}>{method}</li>)}
                </ul>
              </div>
            )}
            {analysis.socialMedia.length > 0 && (
              <div>
                <span>社媒信息</span>
                <ul>
                  {analysis.socialMedia.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      {analysis.activeSection && <EhuntShopSectionEvidence section={analysis.activeSection} />}
      <footer>来源：EHunt 当前可见 DOM · 未自动切换页签</footer>
    </section>
  );
}

function EhuntShopSectionEvidence({
  section,
}: {
  section: CaptureEhuntShopActiveSection;
}) {
  if (
    section.kind === "hot_products" ||
    section.kind === "new_products" ||
    section.kind === "delisted_products"
  ) {
    return (
      <div className="competitor-ehunt-section">
        <p><span>ACTIVE TAB</span><strong>{section.label}</strong></p>
        <ul>
          {section.items.map((item, index) => (
            <li key={`${item.detailUrl ?? item.title}-${index}`}>
              {item.detailUrl ? (
                <a href={item.detailUrl} target="_blank" rel="noreferrer">
                  <strong>{item.title}</strong><ExternalLink size={11} />
                </a>
              ) : (
                <strong>{item.title}</strong>
              )}
              <span>总销量 {item.totalSales?.raw ?? "—"} · 价格 {item.price?.raw ?? "—"}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (section.kind === "common_tags") {
    return (
      <div className="competitor-ehunt-section">
        <p><span>ACTIVE TAB</span><strong>{section.label}</strong></p>
        <ul>
          {section.items.map((item) => (
            <li key={item.label}>
              <strong>{item.label}</strong>
              <span>
                频次 {item.frequency?.raw ?? "—"} · 竞争度 {item.competition?.raw ?? "—"} ·
                浏览 {item.views?.raw ?? "—"} · 销售 {item.sales?.raw ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (section.kind === "popular_categories") {
    return (
      <div className="competitor-ehunt-section">
        <p><span>ACTIVE TAB</span><strong>{section.label}</strong></p>
        <ul>
          {section.items.map((item) => (
            <li key={item.raw}>
              <strong>{item.path.join(" › ")}</strong>
              <span>{item.sharePercent === null ? "占比未显示" : `${item.sharePercent}%`}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (!("points" in section)) return null;
  return (
    <div className="competitor-ehunt-section">
      <p><span>ACTIVE TAB</span><strong>{section.label}</strong></p>
      <ul>
        {section.points.map((point) => (
          <li key={point.period}>
            <strong>{point.period}</strong>
            <span>{point.values.map((value) => `${value.label} ${value.metric.raw}`).join(" · ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function optionalBoolean(value: boolean | null): string {
  return value === null ? "未显示" : value ? "是" : "否";
}

function positioningSignal(snapshot: CompetitorShopSnapshotView | null): string {
  const value = snapshot?.announcement ?? snapshot?.about;
  const cleaned = value
    ?.replace(/Learn more about the seller/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "店铺页尚未采集公告或简介。";
}

function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
