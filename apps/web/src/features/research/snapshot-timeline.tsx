import type { CaptureDraft } from "@yummyai/contracts/capture";
import {
  CalendarDays,
  ChartNoAxesCombined,
  ExternalLink,
  Heart,
  ImageIcon,
  MessageSquareText,
  PackageOpen,
  Star,
  Store,
  Truck,
} from "lucide-react";

export interface ResearchSnapshotView {
  capturedAt: string;
  draft?: CaptureDraft;
  id: string;
  priceAmount?: string | null;
  priceCurrency?: string | null;
  rating?: string | null;
  sourceUrl?: string;
  status: string;
  title: string | null;
}

export interface ResearchProductIdentity {
  latestTitle: string | null;
  marketplace: string;
  normalizedUrl: string;
  platform: "amazon" | "etsy";
}

export function ResearchProductDossier({
  error,
  item,
  loading,
  snapshots,
}: {
  error: string | null;
  item: ResearchProductIdentity;
  loading: boolean;
  snapshots: ResearchSnapshotView[];
}) {
  const orderedSnapshots = [...snapshots].sort(
    (left, right) => timestamp(right.capturedAt) - timestamp(left.capturedAt),
  );
  const latestSnapshot = orderedSnapshots[0];
  const draft = latestSnapshot?.draft;
  const includedImages =
    draft?.media?.filter((media) => media.kind === "image" && media.included) ?? [];
  const mainImage = includedImages[0] ?? draft?.media?.find((media) => media.kind === "image");
  const description = draft?.contentBlocks?.find(
    (block) => block.kind === "description" || block.kind === "aplus",
  )?.text;
  const sourceUrl = draft?.sourceUrl ?? latestSnapshot?.sourceUrl ?? item.normalizedUrl;
  const title = draft?.title ?? latestSnapshot?.title ?? item.latestTitle ?? "未识别标题";
  const productRating = draft?.rating ?? draft?.shop?.rating;
  const reviewCount =
    draft?.reviewCollection?.reportedTotal ?? draft?.reviewCount ?? draft?.shop?.reviewCount;
  const descriptionBlocks = splitProductDetails(description);
  const productInformationCount =
    draft?.productInformation?.reduce(
      (total, section) => total + section.items.length,
      0,
    ) ?? 0;

  if (loading) {
    return (
      <div className="research-dossier dossier-loading" aria-live="polite">
        <span className="dossier-loading-mark" aria-hidden="true" />
        <div>
          <p className="section-code">PRODUCT EVIDENCE DOSSIER</p>
          <strong>正在整理商品证据…</strong>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="research-dossier dossier-message" role="alert">
        <p className="section-code">DOSSIER UNAVAILABLE</p>
        <strong>{error}</strong>
        <span>收起后重新展开即可重试。</span>
      </div>
    );
  }

  if (!latestSnapshot) {
    return (
      <div className="research-dossier dossier-message">
        <p className="section-code">NO SNAPSHOT</p>
        <strong>这个研究条目暂时没有可展示的商品快照。</strong>
      </div>
    );
  }

  return (
    <article className="research-dossier">
      <header className="dossier-heading">
        <div>
          <p className="section-code">PRODUCT EVIDENCE DOSSIER</p>
          <span>最新快照 · {formatDateTime(latestSnapshot.capturedAt)}</span>
        </div>
        <a href={sourceUrl} target="_blank" rel="noreferrer">
          查看原始商品页
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      </header>

      <div className="dossier-hero">
        <figure className="dossier-media">
          {mainImage ? (
            <img
              src={mainImage.sourceUrl}
              alt={mainImage.alt || title}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="dossier-media-empty">
              <ImageIcon size={28} aria-hidden="true" />
              <span>暂无主图证据</span>
            </div>
          )}
          <figcaption>
            <span>{includedImages.length || (mainImage ? 1 : 0)} 张图片</span>
            <span>{draft?.media?.filter((media) => media.kind === "video").length ?? 0} 个视频</span>
          </figcaption>
        </figure>

        <div className="dossier-product-copy">
          <div className="dossier-platform-line">
            <span className={`platform-stamp platform-${item.platform}`}>{item.platform}</span>
            <span className="mono">{item.marketplace}</span>
          </div>
          <h3>{title}</h3>
          <p className="dossier-price">{draft?.price?.raw ?? formatSnapshotPrice(latestSnapshot)}</p>
          {draft?.shop ? (
            <a className="dossier-shop" href={draft.shop.sourceUrl} target="_blank" rel="noreferrer">
              <Store size={14} aria-hidden="true" />
              <span>
                <strong>{draft.shop.name}</strong>
                {draft.shop.location ? ` · ${draft.shop.location}` : ""}
              </span>
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : null}
          {draft?.bullets?.length ? (
            <section className="dossier-selling-points" aria-labelledby={`selling-points-${latestSnapshot.id}`}>
              <p className="section-code" id={`selling-points-${latestSnapshot.id}`}>SELLING POINTS</p>
              <ul>
                {draft.bullets.slice(0, 5).map((bullet, index) => (
                  <li key={`${index}-${bullet}`}>{bullet}</li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="dossier-muted-note">本次采集未识别到公开卖点。</p>
          )}
        </div>

        <aside className="dossier-logistics" aria-label="商品物流与发布信息">
          <p className="section-code">FULFILMENT / LISTING</p>
          <dl>
            <EvidenceLine
              icon={<Truck size={15} />}
              label="预计送达"
              value={formatEstimatedDelivery(draft?.shipping?.estimatedDelivery, latestSnapshot.capturedAt)}
            />
            <EvidenceLine icon={<PackageOpen size={15} />} label="运费" value={draft?.shipping?.cost?.raw} />
            <EvidenceLine
              icon={<Store size={15} />}
              label={item.platform === "amazon" ? "发货方" : "发货地"}
              value={draft?.shipping?.shipsFrom}
            />
            <EvidenceLine icon={<Truck size={15} />} label="配送至" value={draft?.shipping?.destination} />
            <EvidenceLine
              icon={<CalendarDays size={15} />}
              label={item.platform === "amazon" ? "首次上架" : "发布日期"}
              value={
                draft?.listingPublishedAt ??
                (item.platform === "amazon" ? "Amazon 未公开" : null)
              }
            />
          </dl>
          {draft?.taxonomy?.length ? (
            <div className="dossier-taxonomy">
              <span>类目节点</span>
              <ol>
                {draft.taxonomy.map((node, index) => (
                  <li key={`${index}-${node.label}`}>{node.label}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </aside>
      </div>

      <dl className="dossier-signal-rail">
        <Signal
          icon={<Heart size={14} />}
          label="收藏"
          value={
            item.platform === "amazon" ? "Amazon 未公开" : formatCount(draft?.favoriteCount)
          }
        />
        <Signal icon={<Star size={14} />} label="评分" value={formatRating(productRating)} />
        <Signal icon={<MessageSquareText size={14} />} label="评论" value={formatCount(reviewCount)} />
        <Signal icon={<ImageIcon size={14} />} label="媒体" value={`${includedImages.length || (mainImage ? 1 : 0)} 张`} />
        <Signal
          icon={<PackageOpen size={14} />}
          label="规格"
          value={
            productInformationCount > 0
              ? `${productInformationCount} 项`
              : `${draft?.variants?.length ?? 0} 组`
          }
        />
      </dl>

      {draft?.ehuntAnalysis ? (
        <section
          className="dossier-ehunt"
          aria-labelledby={`ehunt-analysis-${latestSnapshot.id}`}
        >
          <div className="dossier-ehunt-heading">
            <div>
              <p className="section-code">THIRD-PARTY MARKET SIGNALS</p>
              <h4 id={`ehunt-analysis-${latestSnapshot.id}`}>EHunt 商品分析</h4>
            </div>
            <span>EHunt evidence</span>
          </div>
          <p className="dossier-ehunt-note">
            以下数值与标签来自采集时页面中可见的 EHunt 面板，不是 Etsy 原生字段。
          </p>
          <dl className="dossier-ehunt-metrics">
            <ExternalMetric
              icon={<ChartNoAxesCombined size={13} />}
              label="总销量"
              value={formatCount(draft.ehuntAnalysis.totalSales)}
              delta={draft.ehuntAnalysis.salesDelta}
            />
            <ExternalMetric
              label="总销售额"
              value={draft.ehuntAnalysis.totalRevenue?.raw ?? "—"}
              delta={draft.ehuntAnalysis.revenueDelta?.raw}
            />
            <ExternalMetric
              label="总浏览量"
              value={formatCount(draft.ehuntAnalysis.viewCount)}
            />
            <ExternalMetric
              label="总评论"
              value={formatCount(draft.ehuntAnalysis.reviewCount)}
              delta={draft.ehuntAnalysis.reviewDelta}
            />
            <ExternalMetric
              label="总收藏"
              value={formatCount(draft.ehuntAnalysis.favoriteCount)}
              delta={draft.ehuntAnalysis.favoriteDelta}
            />
            <ExternalMetric
              label="平均转化率"
              value={formatPercent(draft.ehuntAnalysis.conversionRatePercent)}
            />
          </dl>
          <div className="dossier-ehunt-detail-grid">
            <dl>
              <EvidenceFact label="EHunt 上架时间" value={draft.ehuntAnalysis.listingPublishedAt} />
              <EvidenceFact label="EHunt 价格" value={draft.ehuntAnalysis.price?.raw} />
              <EvidenceFact label="发货地" value={draft.ehuntAnalysis.shipsFrom} />
              <EvidenceFact
                label="库存"
                value={formatCount(draft.ehuntAnalysis.inventoryCount)}
              />
              <EvidenceFact label="店铺" value={draft.ehuntAnalysis.shopName} />
              <EvidenceFact
                label="店铺销量"
                value={formatCount(draft.ehuntAnalysis.shopSalesCount)}
              />
            </dl>
            <div className="dossier-ehunt-tags">
              <div>
                <strong>商品标签</strong>
                <span>{draft.ehuntAnalysis.tags.length} TAGS</span>
              </div>
              {draft.ehuntAnalysis.tags.length > 0 ? (
                <ul>
                  {draft.ehuntAnalysis.tags.map((tag) => (
                    <li key={tag.label}>
                      <span>{tag.label}</span>
                      {tag.metricRaw ? <small>{tag.metricRaw}</small> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dossier-muted-note">EHunt 面板没有显示商品标签。</p>
              )}
              {draft.ehuntAnalysis.categoryPath.length > 0 ? (
                <ol aria-label="EHunt 类目路径">
                  {draft.ehuntAnalysis.categoryPath.map((node) => (
                    <li key={node}>{node}</li>
                  ))}
                </ol>
              ) : null}
              {draft.ehuntAnalysis.annualTrendUrl ? (
                <a
                  href={draft.ehuntAnalysis.annualTrendUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看 EHunt 年度历史趋势
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      <div className="dossier-lower-grid">
        <section className="dossier-description">
          <p className="section-code">PRODUCT DETAILS</p>
          <h4>商品详情</h4>
          {descriptionBlocks.length ? (
            <div className="dossier-description-copy">
              {descriptionBlocks.map((block, index) => <p key={`${index}-${block}`}>{block}</p>)}
            </div>
          ) : <p className="dossier-muted-note">本次采集未识别到商品描述。</p>}
          {draft?.variants?.length ? (
            <dl className="dossier-variants">
              {draft.variants.map((variant) => {
                const options = variant.options.filter((option) => !isVariantPlaceholder(option.label));
                return (
                  <div key={variant.label}>
                    <dt>
                      <span>{variant.label}</span>
                      <small>{options.length} OPTIONS</small>
                    </dt>
                    <dd>
                      <ul className="dossier-variant-options" aria-label={`${variant.label}选项`}>
                        {options.map((option, index) => (
                          <li key={option.externalId ?? `${index}-${option.label}`}>{option.label}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
          {item.platform === "amazon" ? (
            <section
              className="dossier-product-information"
              aria-labelledby={`product-information-${latestSnapshot.id}`}
            >
              <div className="dossier-parameter-heading">
                <h5 id={`product-information-${latestSnapshot.id}`}>产品参数</h5>
                <span>{productInformationCount} 项</span>
              </div>
              {draft?.productInformation?.length ? (
                <div className="dossier-parameter-groups">
                  {draft.productInformation.map((section, sectionIndex) => (
                    <details key={`${sectionIndex}-${section.name}`} open={sectionIndex === 0}>
                      <summary>
                        <span>{section.name}</span>
                        <small>{section.items.length}</small>
                      </summary>
                      <dl>
                        {section.items.map((item, itemIndex) => (
                          <div key={`${itemIndex}-${item.label}-${item.value}`}>
                            <dt>{item.label}</dt>
                            <dd>
                              <span>{item.value}</span>
                              {item.links.length > 0 ? (
                                <span className="dossier-parameter-links">
                                  {item.links.map((link) => (
                                    <a
                                      key={link.url}
                                      href={link.url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {link.label}
                                      <ExternalLink size={10} aria-hidden="true" />
                                    </a>
                                  ))}
                                </span>
                              ) : null}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ))}
                </div>
              ) : (
                <p className="dossier-muted-note">
                  当前快照没有公开 Product information 参数。
                </p>
              )}
            </section>
          ) : null}
        </section>

        <section className="dossier-history" aria-labelledby={`snapshot-history-${latestSnapshot.id}`}>
          <div className="dossier-section-heading">
            <div>
              <p className="section-code">SNAPSHOT HISTORY</p>
              <h4 id={`snapshot-history-${latestSnapshot.id}`}>版本记录</h4>
            </div>
            <span>{orderedSnapshots.length} VERSIONS</span>
          </div>
          <ol className="snapshot-list">
            {orderedSnapshots.map((snapshot, index) => (
              <li key={snapshot.id}>
                <span className="snapshot-dot" aria-hidden="true" />
                <div className="snapshot-copy">
                  <time className="mono" dateTime={snapshot.capturedAt}>
                    {formatDateTime(snapshot.capturedAt)}
                  </time>
                  <strong>{snapshot.title ?? "未识别标题"}</strong>
                </div>
                {index === 0 ? <span className="snapshot-latest">LATEST</span> : null}
                <span className={`status-chip status-${snapshot.status}`}>{snapshot.status}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </article>
  );
}

function EvidenceLine({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <dt>{icon}<span>{label}</span></dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

function Signal({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <dt>{icon}{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ExternalMetric({
  delta,
  icon,
  label,
  value,
}: {
  delta?: number | string | null;
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt>{icon}{label}</dt>
      <dd>
        <span>{value}</span>
        {delta !== null && delta !== undefined ? <small>+{delta}</small> : null}
      </dd>
    </div>
  );
}

function EvidenceFact({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatCount(value: number | null | undefined) {
  return value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatRating(value: number | null | undefined) {
  return value == null ? "—" : value.toFixed(1);
}

function formatPercent(value: number | null | undefined) {
  return value == null ? "—" : `${value}%`;
}

function formatSnapshotPrice(snapshot: ResearchSnapshotView) {
  if (!snapshot.priceAmount) return "价格未识别";
  return [snapshot.priceCurrency, snapshot.priceAmount].filter(Boolean).join(" ");
}

function splitProductDetails(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value
    .replace(/(?=(?:Details of Listed Design|Fabric Frontside|FabricBackside|Size-|Font-|Yarn Colors-|EMBROIDERY|D E T A I L S|CARE INSTRUCTIONS|DESIGN PROOF(?:\s*&\s*CUSTOMIZATIONS)?|NOTE:|IMPORTANT))/gi, "\n")
    .replace(/(?=(?:Please Select|Please note|Please mention|Please read))/gi, "\n")
    .replace(/\s*[—–]\s*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const blocks = normalized.split(/\n+/).map((block) => block.trim()).filter(Boolean);
  return blocks.length ? blocks : [value.trim()];
}

function isVariantPlaceholder(value: string) {
  return /^(?:select|choose)\b.*\boption\b$/i.test(value.trim());
}

function formatEstimatedDelivery(value: string | null | undefined, capturedAt: string) {
  if (!value) return null;
  const range = deliveryDayRange(value, capturedAt);
  if (!range) return value;
  const days = range.minimum === range.maximum
    ? `${range.minimum}`
    : `${range.minimum}–${range.maximum}`;
  return `${value} · 约 ${days} 天`;
}

function deliveryDayRange(value: string, capturedAt: string) {
  const months = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
  const match = value.match(
    new RegExp(
      `\\b(${months})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s*[-–—]\\s*(?:(${months})\\s+)?(\\d{1,2})(?:,\\s*(\\d{4}))?`,
      "i",
    ),
  );
  const captured = new Date(capturedAt);
  if (!match || Number.isNaN(captured.getTime())) return null;

  const capturedDay = Date.UTC(
    captured.getUTCFullYear(),
    captured.getUTCMonth(),
    captured.getUTCDate(),
  );
  let startYear = Number(match[3] ?? captured.getUTCFullYear());
  const startMonth = monthIndex(match[1]);
  const endMonth = monthIndex(match[4] ?? match[1]);
  if (startMonth === null || endMonth === null) return null;

  let start = Date.UTC(startYear, startMonth, Number(match[2]));
  if (!match[3] && start < capturedDay - 45 * 86_400_000) {
    startYear += 1;
    start = Date.UTC(startYear, startMonth, Number(match[2]));
  }
  let endYear = Number(match[6] ?? startYear);
  let end = Date.UTC(endYear, endMonth, Number(match[5]));
  if (!match[6] && end < start) {
    endYear += 1;
    end = Date.UTC(endYear, endMonth, Number(match[5]));
  }
  const minimum = Math.ceil((start - capturedDay) / 86_400_000);
  const maximum = Math.ceil((end - capturedDay) / 86_400_000);
  if (minimum < 0 || maximum < minimum || maximum > 400) return null;
  return { minimum, maximum };
}

function monthIndex(value: string) {
  const index = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(value.slice(0, 3).toLowerCase());
  return index < 0 ? null : index;
}

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
