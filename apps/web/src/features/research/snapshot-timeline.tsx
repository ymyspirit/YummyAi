import type { CaptureDraft } from "@yummyai/contracts";
import {
  CalendarDays,
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
  const reviewCount = draft?.reviewCollection?.reportedTotal ?? draft?.reviewCount;

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
            <EvidenceLine icon={<CalendarDays size={15} />} label="处理时间" value={draft?.shipping?.processingTime} />
            <EvidenceLine icon={<PackageOpen size={15} />} label="运费" value={draft?.shipping?.cost?.raw} />
            <EvidenceLine icon={<Store size={15} />} label="发货地" value={draft?.shipping?.shipsFrom} />
            <EvidenceLine icon={<Truck size={15} />} label="配送至" value={draft?.shipping?.destination} />
            <EvidenceLine icon={<CalendarDays size={15} />} label="发布日期" value={draft?.listingPublishedAt} />
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
        <Signal icon={<Heart size={14} />} label="收藏" value={formatCount(draft?.favoriteCount)} />
        <Signal icon={<Star size={14} />} label="评分" value={formatRating(draft?.rating)} />
        <Signal icon={<MessageSquareText size={14} />} label="评论" value={formatCount(reviewCount)} />
        <Signal icon={<ImageIcon size={14} />} label="媒体" value={`${includedImages.length || (mainImage ? 1 : 0)} 张`} />
        <Signal icon={<PackageOpen size={14} />} label="规格" value={`${draft?.variants?.length ?? 0} 组`} />
      </dl>

      <div className="dossier-lower-grid">
        <section className="dossier-description">
          <p className="section-code">PRODUCT DETAILS</p>
          <h4>商品详情</h4>
          {description ? <p>{description}</p> : <p className="dossier-muted-note">本次采集未识别到商品描述。</p>}
          {draft?.variants?.length ? (
            <dl className="dossier-variants">
              {draft.variants.map((variant) => (
                <div key={variant.label}>
                  <dt>{variant.label}</dt>
                  <dd>{variant.options.map((option) => option.label).join(" · ")}</dd>
                </div>
              ))}
            </dl>
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

function formatSnapshotPrice(snapshot: ResearchSnapshotView) {
  if (!snapshot.priceAmount) return "价格未识别";
  return [snapshot.priceCurrency, snapshot.priceAmount].filter(Boolean).join(" ");
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
