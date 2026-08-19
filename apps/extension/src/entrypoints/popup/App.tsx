import type {
  CaptureDomain,
  CaptureDraft,
  CaptureEhuntShopActiveSection,
  CaptureEhuntShopAnalysis,
  CompetitorShopDraft,
} from "@yummyai/contracts";
import {
  AlertCircle,
  Check,
  CircleStop,
  ExternalLink,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquareText,
  Play,
  RefreshCw,
  ScanSearch,
  Send,
  ShieldCheck,
  Store,
  Truck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { browser } from "wxt/browser";

import {
  authenticateExtension,
  exchangeExtensionCode,
  refreshExtensionAccessToken,
  type ExtensionAccessToken,
} from "../../lib/auth.js";
import {
  readActiveEvidence,
  redactCaptureDraft,
  startActiveReviewCollection,
  uploadCapture,
  uploadCompetitorShop,
  type CaptureProgressState,
} from "../../lib/capture-client.js";
import { withoutReviewEvidence } from "../../lib/capture-messages.js";
import { MediaPreview } from "./media-preview.js";

const stateLabel: Record<CaptureProgressState, string> = {
  pending: "待采集",
  parsing: "解析中",
  preview: "待确认",
  uploading: "上传中",
  normalizing: "标准化中",
  complete: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

type FieldSelection = "title" | "price" | "bullets";

export function App() {
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [shopDraft, setShopDraft] = useState<CompetitorShopDraft | null>(null);
  const [state, setState] = useState<CaptureProgressState>("pending");
  const [domain, setDomain] = useState<CaptureDomain>("research");
  const [includedMedia, setIncludedMedia] = useState<Set<string>>(new Set());
  const [includedFields, setIncludedFields] = useState<Set<FieldSelection>>(
    new Set(["title", "price", "bullets"]),
  );
  const [error, setError] = useState<string | null>(null);
  const [reviewPageDelayMs, setReviewPageDelayMs] = useState(4_000);
  const [includeReviews, setIncludeReviews] = useState(false);
  const [reviewCollectorActive, setReviewCollectorActive] = useState(false);
  const abortController = useRef<AbortController | null>(null);

  const loadPage = useCallback(async (withReviews: boolean) => {
    setState("parsing");
    setError(null);
    try {
      const evidence = await readActiveEvidence({ includeReviews: withReviews });
      if (evidence.kind === "product") {
        setDraft(evidence.draft);
        setShopDraft(null);
        setIncludedMedia(new Set(evidence.draft.media.map((item) => item.id)));
      } else {
        setDraft(null);
        setShopDraft(evidence.draft);
        setIncludedMedia(new Set());
      }
      setDomain("research");
      setState("preview");
    } catch (loadError) {
      setDraft(null);
      setShopDraft(null);
      setError(messageFrom(loadError));
      setState("failed");
    }
  }, []);

  useEffect(() => {
    void loadPage(false);
    return () => abortController.current?.abort();
  }, [loadPage]);

  const includedMediaCount = includedMedia.size;
  const progress = progressFor(state);
  const canUpload =
    state === "preview" && (shopDraft !== null || (draft !== null && includedMediaCount > 0));
  const visibleFields = useMemo(
    () => [
      { key: "title" as const, label: "标题", available: Boolean(draft?.title) },
      { key: "price" as const, label: "价格", available: Boolean(draft?.price) },
      { key: "bullets" as const, label: "卖点", available: Boolean(draft?.bullets.length) },
    ],
    [draft],
  );

  async function submitCapture() {
    if (!draft && !shopDraft) return;
    const controller = new AbortController();
    abortController.current = controller;
    setError(null);

    try {
      const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
      const isLocalProxy =
        import.meta.env.VITE_LOCAL_EXTENSION_PROXY === "1" ||
        apiBaseUrl.replace(/\/$/, "") === "http://localhost:3000";
      const token = isLocalProxy ? undefined : await getSessionAccessToken();
      const options = {
        apiBaseUrl,
        ...(token ? { accessToken: token } : {}),
        ...(isLocalProxy ? { extensionId: browser.runtime.id } : {}),
        signal: controller.signal,
        onProgress: setState,
      };
      if (shopDraft) {
        await uploadCompetitorShop(shopDraft, options);
      } else if (draft) {
        const prepared = redactCaptureDraft(draft, {
          domain,
          includeTitle: includedFields.has("title"),
          includePrice: includedFields.has("price"),
          includeBullets: includedFields.has("bullets"),
          includeReviews,
          includedMediaIds: includedMedia,
        });
        await uploadCapture(prepared, options);
      }
    } catch (uploadError) {
      if (controller.signal.aborted) {
        setState("cancelled");
      } else {
        setError(messageFrom(uploadError));
        setState("failed");
      }
    }
  }

  async function collectAllReviews() {
    if (!draft || draft.platform !== "etsy" || !includeReviews) return;
    setReviewCollectorActive(true);
    setError(null);
    try {
      await startActiveReviewCollection(reviewPageDelayMs);
      for (let attempt = 0; attempt < 600; attempt += 1) {
        await wait(1_000);
        const evidence = await readActiveEvidence();
        if (evidence.kind !== "product") break;
        setDraft(evidence.draft);
        if (["complete", "paused"].includes(evidence.draft.reviewCollection.status)) break;
      }
    } catch (collectionError) {
      setError(messageFrom(collectionError));
    } finally {
      setReviewCollectorActive(false);
    }
  }

  function cancelUpload() {
    abortController.current?.abort();
  }

  function toggleField(field: FieldSelection) {
    setIncludedFields((current) => toggled(current, field));
  }

  async function toggleReviewInclusion(checked: boolean) {
    setIncludeReviews(checked);
    if (!checked) {
      setDraft((current) => (current ? withoutReviewEvidence(current) : current));
      return;
    }
    await loadPage(true);
  }

  function toggleMedia(id: string) {
    setIncludedMedia((current) => toggled(current, id));
  }

  const busy = state === "parsing" || state === "uploading" || state === "normalizing";

  return (
    <main className="capture-shell">
      <header className="capture-header">
        <div className="brand-mark" aria-hidden="true">
          <ScanSearch size={19} strokeWidth={1.8} />
        </div>
        <div className="brand-copy">
          <p className="eyebrow">YUMMYAI / CAPTURE</p>
          <h1>页面证据检查</h1>
        </div>
        <StatusBadge state={state} />
      </header>

      <div className="progress-track" aria-label={`采集进度：${stateLabel[state]}`}>
        <span style={{ transform: `scaleX(${progress / 100})` }} />
      </div>

      {busy && !draft && !shopDraft ? (
        <EmptyState
          icon={<LoaderCircle className="spin" />}
          title="正在读取公开页面"
          detail="只分析当前页面中你能看到的商品信息。"
        />
      ) : error && !draft && !shopDraft ? (
        <EmptyState icon={<AlertCircle />} title="无法生成预览" detail={error}>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void loadPage(includeReviews)}
          >
            <RefreshCw size={16} />
            重新读取
          </button>
        </EmptyState>
      ) : draft ? (
        <>
          <section className="source-section" aria-labelledby="source-heading">
            <div className="section-heading">
              <div>
                <p className="section-index">01 / SOURCE</p>
                <h2 id="source-heading">来源快照</h2>
              </div>
              <span className={`platform-tag platform-${draft.platform}`}>{draft.platform}</span>
            </div>
            <p className="product-title">{draft.title ?? "未识别商品标题"}</p>
            <a
              className="source-url"
              href={draft.sourceUrl}
              target="_blank"
              rel="noreferrer"
              title={draft.sourceUrl}
            >
              <span>{compactUrl(draft.sourceUrl)}</span>
              <ExternalLink size={14} />
            </a>
            <dl className="evidence-stats">
              <div>
                <dt>商品 ID</dt>
                <dd>{draft.externalId ?? "—"}</dd>
              </div>
              <div>
                <dt>媒体</dt>
                <dd>
                  {includedMediaCount}
                  <span> / {draft.media.length}</span>
                </dd>
              </div>
              <div>
                <dt>字段缺失</dt>
                <dd>{draft.missingFields.length}</dd>
              </div>
            </dl>
          </section>

          <section className="signal-section" aria-labelledby="signal-heading">
            <div className="section-heading compact">
              <div>
                <p className="section-index">02 / SIGNALS</p>
                <h2 id="signal-heading">经营证据</h2>
              </div>
              <Truck size={18} aria-hidden="true" />
            </div>
            {draft.taxonomy.length > 0 && (
              <div className="taxonomy-path" aria-label="类目路径">
                {draft.taxonomy.map((node) => (
                  <span key={node.url}>{node.label}</span>
                ))}
              </div>
            )}
            <dl className="signal-grid">
              <div>
                <dt>预计送达</dt>
                <dd>{draft.shipping?.estimatedDelivery ?? "页面未提供"}</dd>
              </div>
              <div>
                <dt>运费</dt>
                <dd>{draft.shipping?.cost?.raw ?? "页面未提供"}</dd>
              </div>
              <div>
                <dt>{draft.platform === "amazon" ? "发货方" : "发货地"}</dt>
                <dd>{draft.shipping?.shipsFrom ?? "页面未提供"}</dd>
              </div>
              <div>
                <dt>目的地</dt>
                <dd>{draft.shipping?.destination ?? "页面未提供"}</dd>
              </div>
              <div>
                <dt>{draft.platform === "amazon" ? "首次上架" : "发布日期"}</dt>
                <dd>
                  {draft.listingPublishedAt ??
                    (draft.platform === "amazon" ? "Amazon 未公开" : "页面未提供")}
                </dd>
              </div>
              <div>
                <dt>收藏数</dt>
                <dd>
                  {draft.favoriteCount ??
                    (draft.platform === "amazon" ? "Amazon 未公开" : "页面未提供")}
                </dd>
              </div>
            </dl>
            {draft.shop && (
              <a
                className="linked-shop"
                href={draft.shop.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Store size={15} />
                <span>
                  <small>关联竞争店铺</small>
                  <strong>{draft.shop.name}</strong>
                </span>
                <ExternalLink size={13} />
              </a>
            )}
          </section>

          {draft.ehuntAnalysis && (
            <section className="ehunt-analysis-section" aria-labelledby="ehunt-analysis-heading">
              <div className="section-heading compact">
                <div>
                  <p className="section-index">EHUNT / THIRD-PARTY</p>
                  <h2 id="ehunt-analysis-heading">商品分析</h2>
                </div>
                <span className="external-source-badge">EHunt</span>
              </div>
              <p className="external-source-note">
                读取当前页面中 EHunt 已显示的数据；数值和标签由 EHunt 提供。
              </p>
              <dl className="ehunt-metric-grid">
                <EhuntMetric
                  label="总销量"
                  value={formatCount(draft.ehuntAnalysis.totalSales)}
                  delta={draft.ehuntAnalysis.salesDelta}
                />
                <EhuntMetric
                  label="总销售额"
                  value={draft.ehuntAnalysis.totalRevenue?.raw ?? "—"}
                  delta={draft.ehuntAnalysis.revenueDelta?.raw}
                />
                <EhuntMetric
                  label="总浏览量"
                  value={formatCount(draft.ehuntAnalysis.viewCount)}
                />
                <EhuntMetric
                  label="总评论"
                  value={formatCount(draft.ehuntAnalysis.reviewCount)}
                  delta={draft.ehuntAnalysis.reviewDelta}
                />
                <EhuntMetric
                  label="总收藏"
                  value={formatCount(draft.ehuntAnalysis.favoriteCount)}
                  delta={draft.ehuntAnalysis.favoriteDelta}
                />
                <EhuntMetric
                  label="平均转化率"
                  value={formatPercent(draft.ehuntAnalysis.conversionRatePercent)}
                />
              </dl>
              <dl className="ehunt-facts">
                <div>
                  <dt>EHunt 上架时间</dt>
                  <dd>{draft.ehuntAnalysis.listingPublishedAt ?? "—"}</dd>
                </div>
                <div>
                  <dt>EHunt 价格</dt>
                  <dd>{draft.ehuntAnalysis.price?.raw ?? "—"}</dd>
                </div>
                <div>
                  <dt>发货地</dt>
                  <dd>{draft.ehuntAnalysis.shipsFrom ?? "—"}</dd>
                </div>
                <div>
                  <dt>库存</dt>
                  <dd>{formatCount(draft.ehuntAnalysis.inventoryCount)}</dd>
                </div>
                <div>
                  <dt>店铺</dt>
                  <dd>{draft.ehuntAnalysis.shopName ?? "—"}</dd>
                </div>
                <div>
                  <dt>店铺销量</dt>
                  <dd>{formatCount(draft.ehuntAnalysis.shopSalesCount)}</dd>
                </div>
              </dl>
              {draft.ehuntAnalysis.categoryPath.length > 0 && (
                <div className="ehunt-category-path">
                  {draft.ehuntAnalysis.categoryPath.map((node) => (
                    <span key={node}>{node}</span>
                  ))}
                </div>
              )}
              {draft.ehuntAnalysis.tags.length > 0 && (
                <div className="ehunt-tags">
                  <div className="ehunt-tags-heading">
                    <strong>商品标签</strong>
                    <span>{draft.ehuntAnalysis.tags.length} TAGS</span>
                  </div>
                  <ul>
                    {draft.ehuntAnalysis.tags.map((tag) => (
                      <li key={tag.label}>
                        <span>{tag.label}</span>
                        {tag.metricRaw && <small>{tag.metricRaw}</small>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {draft.ehuntAnalysis.annualTrendUrl && (
                <a
                  className="ehunt-detail-link"
                  href={draft.ehuntAnalysis.annualTrendUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看 EHunt 年度历史趋势
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </section>
          )}

          {draft.platform === "amazon" && (
            <section
              className="product-information-section"
              aria-labelledby="product-information-heading"
            >
              <div className="section-heading compact">
                <div>
                  <p className="section-index">PRODUCT INFORMATION</p>
                  <h2 id="product-information-heading">产品参数</h2>
                </div>
                <span className="parameter-count">
                  {draft.productInformation.reduce(
                    (total, section) => total + section.items.length,
                    0,
                  )}{" "}
                  项
                </span>
              </div>
              {draft.productInformation.length > 0 ? (
                <div className="product-information-groups">
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
                              {item.links.length > 0 && (
                                <span className="parameter-links">
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
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ))}
                </div>
              ) : (
                <p className="product-information-empty">
                  当前公开页面没有提供 Product information 参数。
                </p>
              )}
            </section>
          )}

          {(draft.reviewSummary || draft.platform === "etsy") && (
            <section className="review-collector" aria-labelledby="review-evidence-heading">
              <div className="section-heading compact">
                <div>
                  <p className="section-index">03 / REVIEWS</p>
                  <h2 id="review-evidence-heading">评价证据</h2>
                </div>
                <MessageSquareText size={18} aria-hidden="true" />
              </div>
              <label className={`review-choice ${includeReviews ? "selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={includeReviews}
                  onChange={(event) => void toggleReviewInclusion(event.target.checked)}
                />
                <span>
                  <strong>获取评论</strong>
                  <small>默认关闭；开启后读取评价摘要和当前可见评论。</small>
                </span>
                <b>{includeReviews ? "已开启" : "可选"}</b>
              </label>
              {!includeReviews ? (
                <p className="review-choice-note">本次不会读取或上传评论数据。</p>
              ) : (
                <>
                  {draft.reviewSummary && (
                    <div className="review-summary-copy">
                      <strong>What buyers say, summarized by AI:</strong>
                      <div>
                        {draft.reviewSummary.tags.map((tag) => (
                          <span key={`${tag.category}-${tag.label}`}>{tag.label}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="review-collection-meter">
                    <span>
                      已保存 <b>{draft.reviewCollection.collectedCount}</b> /{" "}
                      {draft.reviewCollection.reportedTotal ?? "?"} 条
                    </span>
                    <span>
                      {draft.reviewCollection.pageCount} 页 ·{" "}
                      {reviewStatusLabel(draft.reviewCollection.status)}
                    </span>
                  </div>
                  {draft.platform === "etsy" && draft.reviewCollection.status !== "complete" && (
                    <div className="review-speed-control">
                      <label>
                        翻页间隔
                        <select
                          value={reviewPageDelayMs}
                          onChange={(event) => setReviewPageDelayMs(Number(event.target.value))}
                        >
                          <option value={2000}>2 秒</option>
                          <option value={4000}>4 秒</option>
                          <option value={8000}>8 秒</option>
                          <option value={12000}>12 秒</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={reviewCollectorActive}
                        onClick={() => void collectAllReviews()}
                      >
                        {reviewCollectorActive ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : (
                          <Play size={15} />
                        )}
                        {reviewCollectorActive ? "正在逐页采集" : "采集全部评论"}
                      </button>
                    </div>
                  )}
                  <p className="collector-note">
                    仅操作 Etsy 当前公开评论弹层；遇到安全验证自动暂停并保留进度。
                  </p>
                </>
              )}
            </section>
          )}

          <section className="review-section" aria-labelledby="scope-heading">
            <div className="section-heading compact">
              <div>
                <p className="section-index">04 / SCOPE</p>
                <h2 id="scope-heading">采集范围</h2>
              </div>
              <ShieldCheck size={18} aria-hidden="true" />
            </div>
            <fieldset className="domain-switch">
              <legend className="sr-only">资料用途</legend>
              <label className={domain === "research" ? "selected" : ""}>
                <input
                  type="radio"
                  name="domain"
                  value="research"
                  checked={domain === "research"}
                  onChange={() => setDomain("research")}
                />
                竞品研究<span>默认</span>
              </label>
              <label className={domain === "authorized" ? "selected" : ""}>
                <input
                  type="radio"
                  name="domain"
                  value="authorized"
                  checked={domain === "authorized"}
                  onChange={() => setDomain("authorized")}
                />
                自有 / 已授权
              </label>
            </fieldset>
            <div className="field-row" aria-label="字段排除">
              {visibleFields.map((field) => (
                <label key={field.key} className={!field.available ? "unavailable" : ""}>
                  <input
                    type="checkbox"
                    checked={field.available && includedFields.has(field.key)}
                    disabled={!field.available}
                    onChange={() => toggleField(field.key)}
                  />
                  <span>{field.label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="media-section" aria-labelledby="media-heading">
            <div className="section-heading compact">
              <div>
                <p className="section-index">05 / MEDIA</p>
                <h2 id="media-heading">媒体取舍</h2>
              </div>
              <span className="media-count">
                <ImageIcon size={15} />
                {includedMediaCount} 已选
              </span>
            </div>
            <div className="media-grid">
              {draft.media.map((item, index) => {
                const included = includedMedia.has(item.id);
                return (
                  <label
                    className={`media-tile ${included ? "included" : "excluded"}`}
                    key={item.id}
                  >
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => toggleMedia(item.id)}
                    />
                    <MediaPreview item={item} index={index} />
                    <span className="media-check" aria-hidden="true">
                      <Check size={13} />
                    </span>
                    <span className="media-number">{String(index + 1).padStart(2, "0")}</span>
                  </label>
                );
              })}
            </div>
          </section>

          {draft.diagnostics.length > 0 && (
            <section className="diagnostics" aria-labelledby="diagnostics-heading">
              <div className="diagnostic-title">
                <AlertCircle size={16} />
                <h2 id="diagnostics-heading">解析提示</h2>
              </div>
              <ul>
                {draft.diagnostics.map((item, index) => (
                  <li key={`${item.field}-${index}`}>{item.message}</li>
                ))}
              </ul>
            </section>
          )}

          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : shopDraft ? (
        <>
          <section className="source-section" aria-labelledby="shop-source-heading">
            <div className="section-heading">
              <div>
                <p className="section-index">01 / SHOP</p>
                <h2 id="shop-source-heading">竞争店铺快照</h2>
              </div>
              <span className="platform-tag platform-etsy">etsy</span>
            </div>
            <p className="product-title">{shopDraft.name}</p>
            <a className="source-url" href={shopDraft.sourceUrl} target="_blank" rel="noreferrer">
              <span>{compactUrl(shopDraft.sourceUrl)}</span>
              <ExternalLink size={14} />
            </a>
            <dl className="evidence-stats">
              <div>
                <dt>店铺 ID</dt>
                <dd>{shopDraft.externalId ?? "—"}</dd>
              </div>
              <div>
                <dt>在售商品</dt>
                <dd>{shopDraft.activeListingCount ?? "—"}</dd>
              </div>
              <div>
                <dt>字段缺失</dt>
                <dd>{shopDraft.missingFields.length}</dd>
              </div>
            </dl>
          </section>
          <section className="shop-signal-card" aria-labelledby="shop-signal-heading">
            <div className="section-heading compact">
              <div>
                <p className="section-index">02 / OPERATIONS</p>
                <h2 id="shop-signal-heading">经营信号</h2>
              </div>
              <Store size={18} />
            </div>
            <dl className="shop-signal-band">
              <div>
                <dt>销量</dt>
                <dd>{formatCount(shopDraft.salesCount)}</dd>
              </div>
              <div>
                <dt>评分</dt>
                <dd>{shopDraft.rating ?? "—"}</dd>
              </div>
              <div>
                <dt>评论</dt>
                <dd>{formatCount(shopDraft.reviewCount)}</dd>
              </div>
              <div>
                <dt>收藏者</dt>
                <dd>{formatCount(shopDraft.admirerCount)}</dd>
              </div>
              <div>
                <dt>开店</dt>
                <dd>{shopDraft.openedYear ?? "—"}</dd>
              </div>
            </dl>
            <dl className="shop-profile-grid">
              <div>
                <dt>所在地</dt>
                <dd>{shopDraft.location ?? "页面未提供"}</dd>
              </div>
              <div>
                <dt>店主</dt>
                <dd>{shopDraft.ownerName ?? "页面未提供"}</dd>
              </div>
              <div>
                <dt>成员</dt>
                <dd>{shopDraft.members.length}</dd>
              </div>
              <div>
                <dt>生产伙伴</dt>
                <dd>{shopDraft.productionPartners.length}</dd>
              </div>
            </dl>
            {shopDraft.announcement && <blockquote>{shopDraft.announcement}</blockquote>}
          </section>
          {shopDraft.ehuntAnalysis && (
            <EhuntShopAnalysisPanel analysis={shopDraft.ehuntAnalysis} />
          )}
          <section className="shop-sections-card" aria-labelledby="shop-sections-heading">
            <div className="section-heading compact">
              <div>
                <p className="section-index">03 / SECTIONS</p>
                <h2 id="shop-sections-heading">店铺标签</h2>
              </div>
              <span className="shop-section-summary">
                {shopDraft.shopSections.length} 标签 · 全部{" "}
                {formatCount(
                  shopDraft.shopSections.find((section) => section.kind === "all")
                    ?.listingCount ?? null,
                )}
              </span>
            </div>
            {shopDraft.shopSections.length > 0 ? (
              <ul className="shop-section-list">
                {shopDraft.shopSections.map((section) => (
                  <li key={`${section.kind}-${section.externalId}`}>
                    {section.sourceUrl ? (
                      <a href={section.sourceUrl} target="_blank" rel="noreferrer">
                        <span>{section.name}</span>
                        <ExternalLink size={10} aria-hidden="true" />
                      </a>
                    ) : (
                      <span>{section.name}</span>
                    )}
                    <strong>{formatCount(section.listingCount)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="shop-section-empty">当前页面没有公开店铺标签。</p>
            )}
            <p className="shop-section-note">数量为页面报告值，未逐条访问商品链接。</p>
          </section>
          {shopDraft.diagnostics.length > 0 && (
            <section className="diagnostics" aria-labelledby="shop-diagnostics-heading">
              <div className="diagnostic-title">
                <AlertCircle size={16} />
                <h2 id="shop-diagnostics-heading">解析提示</h2>
              </div>
              <ul>
                {shopDraft.diagnostics.map((item, index) => (
                  <li key={`${item.field}-${index}`}>{item.message}</li>
                ))}
              </ul>
            </section>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : null}

      <footer className="action-dock">
        <div className="privacy-note">
          <ShieldCheck size={14} />
          <span>仅采集当前公开页面</span>
        </div>
        {state === "uploading" || state === "normalizing" ? (
          <button className="danger-button" type="button" onClick={cancelUpload}>
            <CircleStop size={17} />
            取消
          </button>
        ) : state === "complete" || state === "partial" ? (
          <button
            className="primary-button success"
            type="button"
            onClick={() => void loadPage(includeReviews)}
          >
            <Check size={17} />
            {stateLabel[state]}
          </button>
        ) : (
          <button
            className="primary-button"
            type="button"
            disabled={!canUpload}
            onClick={() => void submitCapture()}
          >
            <Send size={17} />
            {shopDraft ? "保存竞争店铺" : "发送到研究库"}
          </button>
        )}
      </footer>
    </main>
  );
}

function StatusBadge({ state }: { state: CaptureProgressState }) {
  const active = state === "parsing" || state === "uploading" || state === "normalizing";
  return (
    <span className={`status-badge status-${state}`} role="status" aria-live="polite">
      {active && <LoaderCircle className="spin" size={13} />}
      {stateLabel[state]}
    </span>
  );
}

function EhuntMetric({
  delta,
  label,
  value,
}: {
  delta?: number | string | null;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        {delta !== null && delta !== undefined ? <small>+{delta}</small> : null}
      </dd>
    </div>
  );
}

function EhuntShopAnalysisPanel({ analysis }: { analysis: CaptureEhuntShopAnalysis }) {
  return (
    <section
      className="ehunt-analysis-section ehunt-shop-analysis-section"
      aria-labelledby="ehunt-shop-analysis-heading"
    >
      <div className="section-heading compact">
        <div>
          <p className="section-index">03 / THIRD-PARTY</p>
          <h2 id="ehunt-shop-analysis-heading">店铺分析</h2>
        </div>
        <span className="external-source-badge">EHunt</span>
      </div>
      <p className="external-source-note">
        读取 EHunt 当前已显示的店铺摘要和活动页签；不会自动切换页签。
      </p>
      <dl className="ehunt-metric-grid ehunt-shop-metric-grid">
        <EhuntMetric label="周销量" value={analysis.weeklySales?.raw ?? "—"} />
        <EhuntMetric label="周销售额" value={analysis.weeklyRevenue?.raw ?? "—"} />
        <EhuntMetric label="周收藏" value={analysis.weeklyFavorites?.raw ?? "—"} />
        <EhuntMetric label="总销量" value={analysis.totalSales?.raw ?? "—"} />
        <EhuntMetric label="总销售额" value={analysis.totalRevenue?.raw ?? "—"} />
        <EhuntMetric label="商品总数" value={analysis.listingCount?.raw ?? "—"} />
      </dl>
      <dl className="ehunt-facts ehunt-shop-facts">
        <div>
          <dt>EHunt 开店时间</dt>
          <dd>{analysis.openedAt ?? "—"}</dd>
        </div>
        <div>
          <dt>国家</dt>
          <dd>{analysis.country ?? "—"}</dd>
        </div>
        <div>
          <dt>主营类目</dt>
          <dd>{analysis.primaryCategory ?? "—"}</dd>
        </div>
        <div>
          <dt>Star Seller</dt>
          <dd>{formatOptionalBoolean(analysis.starSeller)}</dd>
        </div>
        <div>
          <dt>总评论</dt>
          <dd>{analysis.totalReviews?.raw ?? "—"}</dd>
        </div>
        <div>
          <dt>总收藏</dt>
          <dd>{analysis.totalFavorites?.raw ?? "—"}</dd>
        </div>
      </dl>
      {(analysis.paymentMethods.length > 0 || analysis.socialMedia.length > 0) && (
        <div className="ehunt-shop-chip-groups">
          {analysis.paymentMethods.length > 0 && (
            <div>
              <strong>支付方式</strong>
              <ul>
                {analysis.paymentMethods.map((method) => <li key={method}>{method}</li>)}
              </ul>
            </div>
          )}
          {analysis.socialMedia.length > 0 && (
            <div>
              <strong>社媒信息</strong>
              <ul>
                {analysis.socialMedia.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {analysis.activeSection && <EhuntShopActiveSectionView section={analysis.activeSection} />}
    </section>
  );
}

function EhuntShopActiveSectionView({
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
      <EhuntShopActiveSectionFrame label={section.label}>
        <ul className="ehunt-shop-product-list">
          {section.items.map((item, index) => (
            <li key={`${item.detailUrl ?? item.title}-${index}`}>
              <div>
                {item.detailUrl ? (
                  <a href={item.detailUrl} target="_blank" rel="noreferrer">
                    {item.title}
                    <ExternalLink size={10} aria-hidden="true" />
                  </a>
                ) : (
                  <strong>{item.title}</strong>
                )}
                <span>
                  总销量 {item.totalSales?.raw ?? "—"} · 价格 {item.price?.raw ?? "—"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </EhuntShopActiveSectionFrame>
    );
  }
  if (section.kind === "common_tags") {
    return (
      <EhuntShopActiveSectionFrame label={section.label}>
        <ul className="ehunt-shop-data-list">
          {section.items.map((item) => (
            <li key={item.label}>
              <strong>{item.label}</strong>
              <span>
                频次 {item.frequency?.raw ?? "—"} · 竞争度 {item.competition?.raw ?? "—"} ·
                销售 {item.sales?.raw ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      </EhuntShopActiveSectionFrame>
    );
  }
  if (section.kind === "popular_categories") {
    return (
      <EhuntShopActiveSectionFrame label={section.label}>
        <ul className="ehunt-shop-data-list">
          {section.items.map((item) => (
            <li key={item.raw}>
              <strong>{item.path.join(" › ")}</strong>
              <span>{item.sharePercent === null ? "占比未显示" : `${item.sharePercent}%`}</span>
            </li>
          ))}
        </ul>
      </EhuntShopActiveSectionFrame>
    );
  }
  if (!("points" in section)) return null;
  return (
    <EhuntShopActiveSectionFrame label={section.label}>
      <ul className="ehunt-shop-data-list">
        {section.points.map((point) => (
          <li key={point.period}>
            <strong>{point.period}</strong>
            <span>
              {point.values.map((value) => `${value.label} ${value.metric.raw}`).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </EhuntShopActiveSectionFrame>
  );
}

function EhuntShopActiveSectionFrame({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="ehunt-shop-active-section">
      <div className="ehunt-shop-active-heading">
        <strong>当前页签</strong>
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

function formatOptionalBoolean(value: boolean | null): string {
  return value === null ? "—" : value ? "是" : "否";
}

function EmptyState({
  icon,
  title,
  detail,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </section>
  );
}

function toggled<T>(current: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function progressFor(state: CaptureProgressState): number {
  return {
    pending: 4,
    parsing: 22,
    preview: 44,
    uploading: 68,
    normalizing: 86,
    complete: 100,
    partial: 100,
    failed: 100,
    cancelled: 100,
  }[state];
}

function compactUrl(value: string): string {
  const url = new URL(value);
  return `${url.hostname}${url.pathname}`;
}

function reviewStatusLabel(status: CaptureDraft["reviewCollection"]["status"]): string {
  return {
    visible: "当前页",
    in_progress: "采集中",
    complete: "已完成",
    paused: "已暂停",
  }[status];
}

function formatCount(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误，请重试。";
}

async function getSessionAccessToken(): Promise<string | undefined> {
  const issuer = import.meta.env.VITE_OIDC_ISSUER ?? "http://localhost:8081/realms/yummyai";
  const tokenEndpoint = `${issuer.replace(/\/$/, "")}/protocol/openid-connect/token`;
  const authorizationEndpoint = `${issuer.replace(/\/$/, "")}/protocol/openid-connect/auth`;
  const stored = await browser.storage.session.get([
    "yummyai.accessToken",
    "yummyai.accessTokenExpiresAt",
    "yummyai.refreshToken",
  ]);
  const accessToken = stored["yummyai.accessToken"];
  const expiresAt = stored["yummyai.accessTokenExpiresAt"];
  if (
    typeof accessToken === "string" &&
    accessToken.length > 0 &&
    typeof expiresAt === "number" &&
    expiresAt > Date.now() + 30_000
  ) {
    return accessToken;
  }

  const refreshToken = stored["yummyai.refreshToken"];
  if (typeof refreshToken === "string" && refreshToken.length > 0) {
    try {
      const refreshed = await refreshExtensionAccessToken(refreshToken, { tokenEndpoint });
      await storeSessionAccessToken(refreshed);
      return refreshed.accessToken;
    } catch {
      await browser.storage.session.remove([
        "yummyai.accessToken",
        "yummyai.accessTokenExpiresAt",
        "yummyai.refreshToken",
      ]);
    }
  }

  const auth = await authenticateExtension(browser.identity, {
    authorizationEndpoint,
    clientId: "yummyai-extension",
  });
  const token = await exchangeExtensionCode(auth, {
    tokenEndpoint,
    clientId: "yummyai-extension",
  });
  await storeSessionAccessToken(token);
  return token.accessToken;
}

async function storeSessionAccessToken(token: ExtensionAccessToken): Promise<void> {
  await browser.storage.session.set({
    "yummyai.accessToken": token.accessToken,
    "yummyai.accessTokenExpiresAt": token.expiresAt,
    ...(token.refreshToken ? { "yummyai.refreshToken": token.refreshToken } : {}),
  });
}
