"use client";

import type { ListingDraft, ListingValidation } from "@yummyai/platform-rules";
import type { MarketplaceAccountView } from "@yummyai/contracts";
import { Archive, BadgeCheck, Boxes, CircleDot, FileClock, Image, ListTree, RadioTower, Save, Send, ShieldCheck, Sparkles, Workflow } from "lucide-react";
import { useState } from "react";

import { ValidationPanel } from "./validation-panel";
import { PublicationPanel, type PublicationWorkspaceView } from "../marketplaces/publication-panel";
import { ListingChannelOperations, type AutomationWorkspaceView } from "../marketplaces/listing-channel-operations";
import type { ListingReplicationView, MarketplaceListingSyncRequestView } from "@yummyai/contracts";
import { ReviewDrawer, type ReviewDrawerView } from "../reviews/review-drawer";

export interface ListingEditorView {
  id: string; platform: "amazon" | "etsy"; marketplaceId?: string; locale: string; status: "draft" | "in_review" | "approved" | "archived";
  spuCode: string; versionId: string; versionNumber: number; ruleVersion: string; source: "human" | "ai"; updatedAt: string;
  content: ListingDraft; validation: ListingValidation;
  history: Array<{ id: string; versionNumber: number; status: "draft" | "approved" | "superseded"; source: "human" | "ai"; createdAt: string }>;
}

const tabs = ["Content", "Media", "Variants", "Attributes", "Compliance", "Publish", "Channels", "History"] as const;
type Tab = typeof tabs[number];

export function ListingEditor({ accounts = [], automations = [], listing, operationsError, publicationError, publications = [], replications = [], review, syncs = [] }: { accounts?: MarketplaceAccountView[]; automations?: AutomationWorkspaceView[]; listing: ListingEditorView; operationsError?: string; publicationError?: string; publications?: PublicationWorkspaceView[]; replications?: ListingReplicationView[]; review?: ReviewDrawerView; syncs?: MarketplaceListingSyncRequestView[] }) {
  const [tab, setTab] = useState<Tab>("Content");
  const [title, setTitle] = useState(listing.content.title);
  const [dirty, setDirty] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <div className="listing-workbench">
      <header className="listing-header">
        <div><p className="kicker">{listing.platform.toUpperCase()} / LISTING CONTROL</p><h1>{listing.spuCode}</h1><p>平台内容、媒体、变体映射与合规校验固定在同一版本中。</p></div>
        <div className="channel-stamp"><strong>{listing.platform === "amazon" ? "AMZ" : "ETSY"}</strong><span>{listing.locale}</span><b>{statusLabel(listing.status)}</b></div>
      </header>
      <div className="listing-toolbar"><div><span className="mono">VERSION {String(listing.versionNumber).padStart(2, "0")}</span><b>{listing.source === "ai" ? <Sparkles size={13} /> : <CircleDot size={13} />}{listing.source === "ai" ? "AI 草稿" : "人工草稿"}</b>{dirty && <em>● 未保存</em>}</div><div className="listing-toolbar-actions"><button type="button"><Save size={16} />保存为新版本</button>{review && <button type="button" className="review-open" onClick={() => setReviewOpen(true)}><Send size={16} />查看审核</button>}</div></div>
      <nav className="listing-tabs" aria-label="刊登编辑区">{tabs.map((item) => <button key={item} type="button" aria-current={tab === item ? "page" : undefined} onClick={() => setTab(item)}>{tabIcon(item)}{item}</button>)}</nav>
      <div className="listing-layout">
        <main className="listing-canvas">
          {tab === "Content" && <section className="listing-content" aria-labelledby="content-title"><header><p className="section-code">MARKETPLACE COPY</p><h2 id="content-title">商品内容</h2><span>{listing.platform === "amazon" ? "TITLE · BULLETS · DESCRIPTION" : "TITLE · DESCRIPTION · TAGS"}</span></header><FieldMeta label="商品标题" source="HUMAN" editor="林运营 · 10:28" dirty={dirty}><textarea value={title} maxLength={listing.platform === "amazon" ? 200 : 140} onChange={(event) => { setTitle(event.target.value); setDirty(true); }} /><small>{title.length} / {listing.platform === "amazon" ? 200 : 140}</small></FieldMeta>{listing.content.bullets.map((bullet, index) => <FieldMeta key={`${index}-${bullet.slice(0, 12)}`} label={`卖点 ${index + 1}`} source={index === 0 ? "AI SUGGESTION" : "HUMAN"} editor="林运营 · 10:24"><input defaultValue={bullet} /></FieldMeta>)}<FieldMeta label="商品描述" source="HUMAN" editor="王设计 · 昨天"><textarea defaultValue={listing.content.description} rows={6} /></FieldMeta></section>}
          {tab === "Media" && <section className="listing-panel"><header><p className="section-code">AUTHORIZED MEDIA</p><h2>媒体与 A+ 计划</h2></header><div className="media-grid">{listing.content.mediaAssetIds.map((id, index) => <article key={id}><span><Image size={22} /></span><strong>{index === 0 ? "MAIN IMAGE" : `MEDIA ${index + 1}`}</strong><code>{id.slice(0, 16)}…</code><b><ShieldCheck size={13} />授权域</b></article>)}</div></section>}
          {tab === "Variants" && <section className="listing-panel"><header><p className="section-code">SKU MAPPING</p><h2>变体映射</h2></header><table><thead><tr><th>SKU</th><th>平台选项</th><th>映射状态</th></tr></thead><tbody>{listing.content.variants.map((variant) => <tr key={variant.skuId}><td><code>{variant.skuCode}</code></td><td>{Object.entries(variant.optionValues).map(([key, value]) => `${key}: ${value}`).join(" · ") || "标准款"}</td><td><span className="mapping-ok"><BadgeCheck size={14} />已映射</span></td></tr>)}</tbody></table></section>}
          {tab === "Attributes" && <section className="listing-panel"><header><p className="section-code">CATALOG ATTRIBUTES</p><h2>平台属性</h2></header><dl className="attribute-grid">{Object.entries(listing.content.attributes).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd><span>PRODUCT MASTER</span></div>)}</dl></section>}
          {tab === "Compliance" && <section className="listing-panel"><header><p className="section-code">COMPLIANCE</p><h2>合规声明</h2></header><dl className="attribute-grid">{Object.entries(listing.content.compliance).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd><span>VERIFIED</span></div>)}</dl></section>}
          {tab === "Publish" && <PublicationPanel accounts={accounts} error={publicationError} listing={{ id: listing.id, platform: listing.platform, status: listing.status, validationBlockers: listing.validation.blockers.length, variants: listing.content.variants, versionId: listing.versionId }} publications={publications} />}
          {tab === "Channels" && <ListingChannelOperations accounts={accounts} automations={automations} error={operationsError} listing={{ id: listing.id, locale: listing.locale, marketplaceId: listing.marketplaceId, platform: listing.platform, status: listing.status, variants: listing.content.variants, versionId: listing.versionId }} publications={publications} replications={replications} syncs={syncs} />}
          {tab === "History" && <section className="listing-panel"><header><p className="section-code">VERSION HISTORY</p><h2>不可变历史</h2></header><ol className="listing-history">{listing.history.map((version) => <li key={version.id}><strong>V{String(version.versionNumber).padStart(2, "0")}</strong><span>{version.source === "ai" ? "AI 建议" : "人工编辑"}</span><b>{version.status === "approved" ? "已审批" : "草稿"}</b><time>{formatDate(version.createdAt)}</time></li>)}</ol></section>}
        </main>
        <ValidationPanel validation={listing.validation} ruleVersion={listing.ruleVersion} />
      </div>
      {reviewOpen && review && <div className="review-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewOpen(false); }}><ReviewDrawer review={review} onClose={() => setReviewOpen(false)} /></div>}
    </div>
  );
}

function FieldMeta({ label, source, editor, dirty, children }: { label: string; source: string; editor: string; dirty?: boolean; children: React.ReactNode }) { return <label className="listing-field"><span><strong>{label}</strong><em>{source}</em><small>{editor}</small>{dirty && <b>● 未保存</b>}</span>{children}</label>; }
function tabIcon(tab: Tab) { return ({ Content: <Archive size={15} />, Media: <Image size={15} />, Variants: <Boxes size={15} />, Attributes: <ListTree size={15} />, Compliance: <ShieldCheck size={15} />, Publish: <RadioTower size={15} />, Channels: <Workflow size={15} />, History: <FileClock size={15} /> })[tab]; }
function statusLabel(status: ListingEditorView["status"]) { return ({ draft: "草稿", in_review: "评审中", approved: "已审批", archived: "已归档" })[status]; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
