"use client";

import type { ListingReplicationView, MarketplaceAccountView, MarketplaceListingSyncRequestView } from "@yummyai/contracts";
import type { ListingDraft, ListingValidation } from "@yummyai/platform-rules";
import { Archive, BadgeCheck, Boxes, CircleDot, FileClock, Image, ListTree, LoaderCircle, Monitor, Plus, RadioTower, Save, Send, ShieldCheck, Sparkles, Trash2, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { ListingChannelOperations, type AutomationWorkspaceView } from "../marketplaces/listing-channel-operations";
import { PublicationPanel, type PublicationWorkspaceView } from "../marketplaces/publication-panel";
import { ReviewDrawer, type ReviewDrawerView } from "../reviews/review-drawer";
import { saveListingVersion, type ListingSaveResult } from "./listing-actions";
import { ValidationPanel } from "./validation-panel";

export interface ListingEditorView {
  id: string; platform: "amazon" | "etsy"; marketplaceId?: string; locale: string; status: "draft" | "in_review" | "approved" | "archived";
  spuCode: string; versionId: string; versionNumber: number; ruleVersion: string; source: "human" | "ai"; updatedAt: string;
  content: ListingDraft; validation: ListingValidation;
  history: Array<{ id: string; versionNumber: number; status: "draft" | "approved" | "superseded"; source: "human" | "ai"; createdAt: string }>;
}

const tabs = ["Content", "Media", "Variants", "Attributes", "Compliance", "Publish", "Channels", "History"] as const;
type Tab = typeof tabs[number];

export function ListingEditor({ accounts = [], automations = [], listing, operationsError, publicationError, publications = [], replications = [], review, syncs = [] }: { accounts?: MarketplaceAccountView[]; automations?: AutomationWorkspaceView[]; listing: ListingEditorView; operationsError?: string; publicationError?: string; publications?: PublicationWorkspaceView[]; replications?: ListingReplicationView[]; review?: ReviewDrawerView; syncs?: MarketplaceListingSyncRequestView[] }) {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<Tab>("Content");
  const [baseline, setBaseline] = useState(() => copyDraft(listing.content));
  const [draft, setDraft] = useState(() => copyDraft(listing.content));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saveResult, setSaveResult] = useState<ListingSaveResult>();
  const [saving, startSaving] = useTransition();
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(baseline), [baseline, draft]);

  useEffect(() => setHydrated(true), []);
  useEffect(() => { const next = copyDraft(listing.content); setBaseline(next); setDraft(copyDraft(next)); setSaveResult(undefined); }, [listing.content, listing.versionId]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardLink = (event: MouseEvent) => { const target = event.target as Element | null; const anchor = target?.closest("a[href]") as HTMLAnchorElement | null; if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return; if (!window.confirm("当前 Listing 有未保存改动，确定离开吗？")) { event.preventDefault(); event.stopImmediatePropagation(); } };
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", guardLink, true); };
  }, [dirty]);

  const save = () => startSaving(async () => {
    const result = await saveListingVersion(listing.id, draft);
    setSaveResult(result);
    if (result.status === "success") { setBaseline(copyDraft(draft)); router.refresh(); }
  });

  return <div aria-busy={!hydrated} className="listing-workbench" data-hydrated={hydrated ? "true" : "false"}>
    <header className="listing-header"><div><p className="kicker">{listing.platform.toUpperCase()} / LISTING CONTROL</p><h1>{listing.spuCode}</h1><p>平台内容、媒体、变体映射与合规校验固定在同一版本中。</p></div><div className="channel-stamp"><strong>{listing.platform === "amazon" ? "AMZ" : "ETSY"}</strong><span>{listing.locale}</span><b>{statusLabel(listing.status)}</b></div></header>
    <div className="listing-toolbar"><div><span className="mono">VERSION {String(listing.versionNumber).padStart(2, "0")}</span><b>{listing.source === "ai" ? <Sparkles size={13} /> : <CircleDot size={13} />}{listing.source === "ai" ? "AI 草稿" : "人工草稿"}</b>{dirty && <em>● 未保存</em>}</div><div className="listing-toolbar-actions"><button disabled={!hydrated || !dirty || saving} onClick={save} type="button">{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? "保存中" : "保存为新版本"}</button>{review && <button type="button" className="review-open" disabled={!hydrated} onClick={() => setReviewOpen(true)}><Send size={16} />查看审核</button>}</div></div>
    {saveResult && <p className={`listing-save-notice ${saveResult.status}`} role="status">{saveResult.message}</p>}
    <nav className="listing-tabs" aria-label="刊登编辑区">{tabs.map((item) => <button key={item} type="button" aria-current={tab === item ? "page" : undefined} disabled={!hydrated} onClick={() => setTab(item)}>{tabIcon(item)}{item}</button>)}</nav>
    <div className="listing-layout">
      <main className="listing-canvas">
        {tab === "Content" && <ContentEditor draft={draft} interactive={hydrated} platform={listing.platform} setDraft={setDraft} />}
        {tab === "Media" && <section className="listing-panel"><header><p className="section-code">AUTHORIZED MEDIA</p><h2>媒体与 A+ 计划</h2></header><div className="media-grid">{draft.mediaAssetIds.map((id, index) => <article key={id}><span><Image size={22} /></span><strong>{id === draft.mainImageId ? "MAIN IMAGE" : `MEDIA ${index + 1}`}</strong><code>{id.slice(0, 16)}…</code><b><ShieldCheck size={13} />授权域</b></article>)}</div>{!draft.mediaAssetIds.length && <p className="listing-panel-empty">尚未关联可发布媒体。</p>}</section>}
        {tab === "Variants" && <section className="listing-panel"><header><p className="section-code">SKU MAPPING</p><h2>变体映射</h2></header><table><thead><tr><th>SKU</th><th>平台选项</th><th>映射状态</th></tr></thead><tbody>{draft.variants.map((variant) => <tr key={variant.skuId}><td><code>{variant.skuCode}</code></td><td>{Object.entries(variant.optionValues).map(([key, value]) => `${key}: ${value}`).join(" · ") || "标准款"}</td><td><span className="mapping-ok"><BadgeCheck size={14} />已映射</span></td></tr>)}</tbody></table></section>}
        {tab === "Attributes" && <ReadOnlyRecord title="平台属性" code="CATALOG ATTRIBUTES" values={draft.attributes} source="PRODUCT MASTER" />}
        {tab === "Compliance" && <ReadOnlyRecord title="合规声明" code="COMPLIANCE" values={draft.compliance} source="VERIFIED" />}
        {tab === "Publish" && <PublicationPanel accounts={accounts} error={publicationError} listing={{ id: listing.id, platform: listing.platform, status: listing.status, validationBlockers: listing.validation.blockers.length, variants: draft.variants, versionId: listing.versionId }} publications={publications} />}
        {tab === "Channels" && <ListingChannelOperations accounts={accounts} automations={automations} error={operationsError} listing={{ id: listing.id, locale: listing.locale, marketplaceId: listing.marketplaceId, platform: listing.platform, status: listing.status, variants: draft.variants, versionId: listing.versionId }} publications={publications} replications={replications} syncs={syncs} />}
        {tab === "History" && <HistoryPanel history={listing.history} />}
      </main>
      <div className="listing-side-rail">
        <ListingPreview draft={draft} platform={listing.platform} />
        <section className="listing-activity-rail" aria-labelledby="activity-title"><header><p className="section-code">VERSION ACTIVITY</p><h2 id="activity-title">版本活动</h2></header><ol>{listing.history.slice(0, 5).map((version) => <li key={version.id}><span className={`version-dot ${version.status}`} /><div><strong>V{String(version.versionNumber).padStart(2, "0")} · {version.source === "ai" ? "AI 建议" : "人工编辑"}</strong><small>{version.status === "approved" ? "已审批" : version.status === "superseded" ? "已替代" : "草稿"}</small></div><time>{formatDate(version.createdAt)}</time></li>)}</ol>{!listing.history.length && <p>暂无历史版本。</p>}</section>
        {dirty && <p className="listing-validation-stale">当前门禁结果对应上次保存版本；保存后将按平台规则重新校验。</p>}
        <ValidationPanel validation={listing.validation} ruleVersion={listing.ruleVersion} />
      </div>
    </div>
    {reviewOpen && review && <div className="review-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewOpen(false); }}><ReviewDrawer review={review} onClose={() => setReviewOpen(false)} /></div>}
  </div>;
}

function ContentEditor({ draft, interactive, platform, setDraft }: { draft: ListingDraft; interactive: boolean; platform: ListingEditorView["platform"]; setDraft: React.Dispatch<React.SetStateAction<ListingDraft>> }) {
  const titleLimit = platform === "amazon" ? 200 : 140;
  return <section className="listing-content" aria-labelledby="content-title"><header><p className="section-code">MARKETPLACE COPY</p><h2 id="content-title">商品内容</h2><span>{platform === "amazon" ? "TITLE · BULLETS · DESCRIPTION" : "TITLE · DESCRIPTION · TAGS"}</span></header>
    <FieldMeta label="商品标题" source="HUMAN"><textarea disabled={!interactive} value={draft.title} maxLength={titleLimit} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /><small>{draft.title.length} / {titleLimit}</small></FieldMeta>
    {platform === "amazon" && <div className="listing-bullet-editor">{draft.bullets.map((bullet, index) => <FieldMeta key={index} label={`卖点 ${index + 1}`} source={index === 0 ? "AI SUGGESTION" : "HUMAN"}><div className="listing-inline-field"><input disabled={!interactive} value={bullet} onChange={(event) => setDraft((current) => ({ ...current, bullets: current.bullets.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} /><button aria-label={`删除卖点 ${index + 1}`} disabled={!interactive} onClick={() => setDraft((current) => ({ ...current, bullets: current.bullets.filter((_, itemIndex) => itemIndex !== index) }))} type="button"><Trash2 size={14} /></button></div></FieldMeta>)}<button className="listing-add-bullet" disabled={!interactive || draft.bullets.length >= 5} onClick={() => setDraft((current) => ({ ...current, bullets: [...current.bullets, ""] }))} type="button"><Plus size={14} />新增卖点</button></div>}
    <FieldMeta label="商品描述" source="HUMAN"><textarea disabled={!interactive} value={draft.description} rows={6} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></FieldMeta>
    {platform === "etsy" && <FieldMeta label="标签" source="HUMAN"><input disabled={!interactive} value={draft.tags.join(", ")} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) }))} /><small>{draft.tags.length} / 13 个标签</small></FieldMeta>}
  </section>;
}

function ListingPreview({ draft, platform }: { draft: ListingDraft; platform: ListingEditorView["platform"] }) { return <section className={`listing-local-preview ${platform}`} aria-labelledby="local-preview-title"><header><span><Monitor size={16} /></span><div><p className="section-code">LOCAL RULE PREVIEW</p><h2 id="local-preview-title">平台本地预览</h2></div></header><p className="listing-preview-disclaimer">仅按本地字段规则排版，不代表平台在线状态或最终渲染。</p><div className="listing-preview-media">{draft.mainImageId ? <><Image size={24} /><span>主图已关联</span></> : <><Image size={24} /><span>主图缺失</span></>}</div><article><small>{platform === "amazon" ? "Amazon 商品详情样式" : "Etsy 商品卡片样式"}</small><h3>{draft.title || "未填写商品标题"}</h3>{platform === "amazon" ? <ul>{draft.bullets.filter(Boolean).slice(0, 5).map((bullet, index) => <li key={index}>{bullet}</li>)}</ul> : <div className="listing-preview-tags">{draft.tags.slice(0, 13).map((tag) => <span key={tag}>{tag}</span>)}</div>}<p>{draft.description || "未填写商品描述"}</p></article></section>; }
function ReadOnlyRecord({ code, source, title, values }: { code: string; source: string; title: string; values: Record<string, string | number | boolean> }) { return <section className="listing-panel"><header><p className="section-code">{code}</p><h2>{title}</h2></header><dl className="attribute-grid">{Object.entries(values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd><span>{source}</span></div>)}</dl>{!Object.keys(values).length && <p className="listing-panel-empty">暂无可用字段。</p>}</section>; }
function HistoryPanel({ history }: { history: ListingEditorView["history"] }) { return <section className="listing-panel"><header><p className="section-code">VERSION HISTORY</p><h2>不可变历史</h2></header><ol className="listing-history">{history.map((version) => <li key={version.id}><strong>V{String(version.versionNumber).padStart(2, "0")}</strong><span>{version.source === "ai" ? "AI 建议" : "人工编辑"}</span><b>{version.status === "approved" ? "已审批" : version.status === "superseded" ? "已替代" : "草稿"}</b><time>{formatDate(version.createdAt)}</time></li>)}</ol></section>; }
function FieldMeta({ label, source, children }: { label: string; source: string; children: React.ReactNode }) { return <label className="listing-field"><span><strong>{label}</strong><em>{source}</em></span>{children}</label>; }
function tabIcon(tab: Tab) { return ({ Content: <Archive size={15} />, Media: <Image size={15} />, Variants: <Boxes size={15} />, Attributes: <ListTree size={15} />, Compliance: <ShieldCheck size={15} />, Publish: <RadioTower size={15} />, Channels: <Workflow size={15} />, History: <FileClock size={15} /> })[tab]; }
function statusLabel(status: ListingEditorView["status"]) { return ({ draft: "草稿", in_review: "评审中", approved: "已审批", archived: "已归档" })[status]; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function copyDraft(content: ListingDraft): ListingDraft { return { ...content, bullets: [...content.bullets], tags: [...content.tags], mediaAssetIds: [...content.mediaAssetIds], variants: content.variants.map((variant) => ({ ...variant, optionValues: { ...variant.optionValues } })), attributes: { ...content.attributes }, compliance: { ...content.compliance }, ...(content.aPlusModules ? { aPlusModules: content.aPlusModules.map((module) => ({ ...module, assetIds: [...module.assetIds] })) } : {}), ...(content.personalization ? { personalization: { ...content.personalization } } : {}) }; }
