"use client";

import type { MarketplaceAccountView, MarketplacePublicationRequestView } from "@yummyai/contracts";
import { ArrowLeft, ArrowRight, BadgeCheck, Ban, Check, CircleAlert, CloudSync, ExternalLink, HeartPulse, KeyRound, ListChecks, LoaderCircle, Plus, Settings2, ShieldCheck, ShoppingBag, Store, Unplug } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import { authorizeAmazonPrivate, createMarketplaceAccount, revokeMarketplaceAuthorization, setMarketplaceAccountEnabled, startMarketplaceOAuth, syncMarketplaceCapabilities, type MarketplaceActionState } from "./marketplace-actions";

const initialState: MarketplaceActionState = { message: "", status: "idle" };

export function MarketplaceAccountsWorkspace({ accounts, error, oauthNotice, publications }: { accounts: MarketplaceAccountView[]; error?: string; oauthNotice?: { message: string; status: "success" | "error" }; publications: MarketplacePublicationRequestView[] }) {
  const [platform, setPlatform] = useState<"amazon" | "etsy">("etsy");
  const [createState, createAction] = useActionState(createMarketplaceAccount, initialState);
  const activeCount = accounts.filter((account) => account.status === "active").length;
  const attentionCount = accounts.filter((account) => attentionReason(account) !== "无待处理项").length;
  return (
    <div className="store-workspace">
      {(error || oauthNotice) && <p className={`store-page-notice ${error || oauthNotice?.status === "error" ? "error" : "success"}`} role="status">{error ?? oauthNotice?.message}</p>}
      <dl className="store-signal-strip" aria-label="店铺运营概览"><Signal label="店铺" value={accounts.length} /><Signal label="可发布" value={activeCount} /><Signal label="待授权" value={accounts.filter((account) => !account.hasCredential).length} /><Signal label="需处理" value={attentionCount} /></dl>
      <details className="store-create-panel" open={accounts.length === 0}>
        <summary><Plus size={16} />新增店铺连接</summary>
        <form action={createAction} className="store-create-form">
          <fieldset className="platform-segments"><legend>平台</legend>{(["amazon", "etsy"] as const).map((item) => <label key={item}><input checked={platform === item} name="platform" onChange={() => setPlatform(item)} type="radio" value={item} /><span>{item === "amazon" ? "Amazon" : "Etsy"}</span></label>)}</fieldset>
          <label><span>连接名称</span><input name="displayName" placeholder={platform === "amazon" ? "Amazon US" : "Etsy 主店"} required /></label>
          <label><span>授权方式</span><select name="authorizationMode" defaultValue={platform === "amazon" ? "amazon_private" : "etsy_oauth"} key={platform}>{platform === "amazon" ? <><option value="amazon_private">私有应用</option><option value="amazon_public">公开应用 OAuth</option></> : <option value="etsy_oauth">Etsy OAuth</option>}</select></label>
          <label><span>区域</span><select name="region" defaultValue={platform === "amazon" ? "NA" : "GLOBAL"} key={`region-${platform}`}>{platform === "amazon" ? <><option value="NA">North America</option><option value="EU">Europe</option><option value="FE">Far East</option></> : <option value="GLOBAL">Global</option>}</select></label>
          <label><span>Marketplace IDs</span><input name="marketplaceIds" defaultValue={platform === "amazon" ? "ATVPDKIKX0DER" : "etsy"} key={`market-${platform}`} required /></label>
          <label className="store-create-scopes"><span>请求权限</span><input name="requestedScopes" defaultValue={platform === "amazon" ? "product-listing" : "listings_r, listings_w, shops_r"} key={`scopes-${platform}`} required /></label>
          <div className="store-create-submit"><ActionNotice state={createState} /><SubmitButton icon={Plus}>创建连接</SubmitButton></div>
        </form>
      </details>
      {accounts.length === 0 ? <section className="store-empty"><Store size={28} /><strong>暂无店铺连接</strong><span>创建后进入店铺详情完成授权和能力同步。</span></section> : (
        <section className="store-list-frame" aria-labelledby="store-list-title">
          <header><div><p className="section-code">STORE OPERATIONS</p><h2 id="store-list-title">店铺巡检台账</h2></div><span>连接设置已下沉到单店详情</span></header>
          <div className="store-table-scroll"><table><thead><tr><th>店铺</th><th>运行状态</th><th>授权健康</th><th>能力新鲜度</th><th>最近同步</th><th>发布请求</th><th>需处理原因</th><th aria-label="操作" /></tr></thead><tbody>{accounts.map((account) => {
            const publicationCount = publications.filter((publication) => publication.accountId === account.id).length;
            return <tr key={account.id}><td><span className={`platform-mark ${account.platform}`}>{account.platform === "amazon" ? "AMZ" : "ETSY"}</span><div><strong>{account.displayName}</strong><small>{account.externalAccountId ?? "尚未绑定平台账号"} · {account.region}</small></div></td><td><StatusBadge status={account.status} /></td><td><strong>{credentialLabel(account.credentialStatus)}</strong><span>{healthLabel(account.healthStatus)}</span></td><td><span className={`store-freshness ${freshnessTone(account)}`}>{capabilityFreshness(account)}</span></td><td><time>{formatDate(account.lastCapabilitySyncAt)}</time></td><td>{publicationCount}</td><td><span className={attentionReason(account) === "无待处理项" ? "store-attention-clear" : "store-attention-risk"}>{attentionReason(account)}</span></td><td><Link aria-label={`打开 ${account.displayName} 店铺详情`} href={`/stores/${account.id}`}><ArrowRight size={16} /></Link></td></tr>;
          })}</tbody></table></div>
        </section>
      )}
    </div>
  );
}

export function MarketplaceAccountDetail({ account, error, listingCount, notice, orderCount, publicationCount }: { account: MarketplaceAccountView; error?: string; listingCount: number; notice?: { message: string; status: "success" | "error" }; orderCount: number; publicationCount: number }) {
  const [authorizationState, authorizationAction] = useActionState(authorizeAmazonPrivate.bind(null, account.id), initialState);
  const [oauthState, oauthAction] = useActionState(startMarketplaceOAuth.bind(null, account.id), initialState);
  const [syncState, syncAction] = useActionState(syncMarketplaceCapabilities.bind(null, account.id, account.platform), initialState);
  const [toggleState, toggleAction] = useActionState(setMarketplaceAccountEnabled.bind(null, account.id, account.status === "disabled"), initialState);
  const [revokeState, revokeAction] = useActionState(revokeMarketplaceAuthorization.bind(null, account.id), initialState);
  useEffect(() => { if (oauthState.redirectUrl) window.location.assign(oauthState.redirectUrl); }, [oauthState.redirectUrl]);
  const actionNotice = [authorizationState, oauthState, syncState, toggleState, revokeState].find((state) => state.status !== "idle");
  return <div className="store-detail-workspace">
    <Link className="store-back-link" href="/stores"><ArrowLeft size={15} />返回店铺运营</Link>
    {(error || notice) && <p className={`store-page-notice ${error || notice?.status === "error" ? "error" : "success"}`} role="status">{error ?? notice?.message}</p>}
    <article className="store-record store-detail-record">
      <header><div className="store-identity"><span className={`platform-mark ${account.platform}`}>{account.platform === "amazon" ? "AMZ" : "ETSY"}</span><div><p className="section-code">STORE DETAIL / SETTINGS</p><h1>{account.displayName}</h1><p>{account.externalAccountId ?? "尚未绑定平台账号"} · {account.region}</p></div></div><StatusBadge status={account.status} /></header>
      <AccountWorkflowTrack account={account} />
      <nav className="store-detail-nav" aria-label="店铺详情分区"><a href="#store-overview">概览</a><a href="#store-listings">Listings</a><a href="#store-orders">订单</a><a href="#store-health">健康</a><a href="#store-settings">设置</a></nav>
      <section className="store-detail-section" id="store-overview" aria-labelledby="store-overview-title"><SectionHeading code="STORE OVERVIEW" icon={Store} id="store-overview-title" title="概览" /><dl className="store-facts store-overview-facts"><Fact label="运行状态" value={statusLabel(account.status)} /><Fact label="授权状态" value={credentialLabel(account.credentialStatus)} /><Fact label="区域" value={account.region} /><Fact label="Marketplace" value={account.marketplaceIds.join(" · ")} /><Fact label="最近更新" value={formatDate(account.updatedAt)} /><Fact label="当前关注" value={attentionReason(account)} /></dl></section>
      <div className="store-detail-columns">
        <section className="store-detail-section" id="store-listings" aria-labelledby="store-listings-title"><SectionHeading code="LISTING OPERATIONS" icon={ListChecks} id="store-listings-title" title="Listings" /><dl className="store-layer-facts"><Fact label="近期关联 Listing" value={`${listingCount} 个`} /><Fact label="发布请求" value={`${publicationCount} 次`} /></dl><p>{publicationCount ? "统计当前店铺最近 100 条发布请求中的真实关联记录。" : "该店铺还没有发布请求；不会推断或补齐平台 Listing。"}</p><Link className="store-layer-link" href={`/listings?marketplaceId=${encodeURIComponent(account.marketplaceIds[0] ?? "")}`}>打开 Listing 目录<ArrowRight size={14} /></Link></section>
        <section className="store-detail-section" id="store-orders" aria-labelledby="store-orders-title"><SectionHeading code="ORDER FLOW" icon={ShoppingBag} id="store-orders-title" title="订单" /><dl className="store-layer-facts"><Fact label="近期订单" value={`${orderCount} 个`} /><Fact label="读取范围" value="最近 100 条" /></dl><p>{error?.includes("订单") ? "订单摘要当前不可用，店铺连接与发布信息仍可继续操作。" : orderCount ? "仅展示普通订单投影计数，不读取买家姓名、地址或联系方式。" : "该店铺当前没有可见订单；系统不会生成占位订单。"}</p><Link className="store-layer-link" href={`/orders?platform=${account.platform}`}>打开订单履约<ArrowRight size={14} /></Link></section>
      </div>
      <section className="store-detail-section" id="store-health" aria-labelledby="store-health-title"><SectionHeading code="CONNECTION HEALTH" icon={HeartPulse} id="store-health-title" title="健康与能力" /><div className="store-record-body"><dl className="store-facts"><Fact label="健康检查" value={healthLabel(account.healthStatus)} /><Fact label="最近检查" value={formatDate(account.lastHealthAt)} /><Fact label="能力同步" value={formatDate(account.lastCapabilitySyncAt)} /><Fact label="能力有效期" value={formatDate(account.capabilityExpiresAt)} /><Fact label="API 配额" value={formatQuota(account.quota)} /><Fact label="诊断代码" value={account.lastErrorCode ?? "无"} /></dl><div className="store-capabilities"><p className="section-code">GRANTED CAPABILITIES</p><div>{account.capabilities.length ? account.capabilities.map((capability) => <span key={capability}>{capability}</span>) : <em>尚未同步</em>}</div></div></div></section>
      <section className="store-settings-panel store-detail-section" id="store-settings" aria-labelledby="store-settings-title"><header><div><p className="section-code">CONNECTION SETTINGS</p><h2 id="store-settings-title"><Settings2 size={16} />设置</h2></div><span>凭证值不会回显</span></header><div className="store-account-actions">
        {!account.hasCredential && account.authorizationMode === "amazon_private" && <details><summary><KeyRound size={15} />验证私有应用</summary><form action={authorizationAction} className="store-secret-form"><label><span>Seller ID</span><input autoComplete="off" name="sellingPartnerId" required /></label><label><span>LWA Client ID</span><input autoComplete="off" name="clientId" required /></label><label><span>Client secret</span><input autoComplete="off" name="clientSecret" required type="password" /></label><label><span>Refresh token</span><input autoComplete="off" name="refreshToken" required type="password" /></label><SubmitButton icon={ShieldCheck}>验证并保存</SubmitButton></form></details>}
        {account.authorizationMode !== "amazon_private" && !account.hasCredential && <form action={oauthAction}><SubmitButton icon={ExternalLink}>前往平台授权</SubmitButton></form>}
        {account.hasCredential && <form action={syncAction} className="store-sync-form"><label><span>{account.platform === "amazon" ? "Product Types" : "Taxonomy IDs"}</span><input name="targets" placeholder={account.platform === "amazon" ? "HOME, PILLOW" : "42, 123"} /></label><SubmitButton icon={CloudSync}>同步能力</SubmitButton></form>}
        <form action={toggleAction}><SubmitButton icon={account.status === "disabled" ? Check : Ban}>{account.status === "disabled" ? "启用" : "停用"}</SubmitButton></form>
        {account.hasCredential && <form action={revokeAction}><SubmitButton danger icon={Unplug}>撤销授权</SubmitButton></form>}
      </div></section>
      {actionNotice && <ActionNotice state={actionNotice} />}{account.lastErrorCode && <p className="store-diagnostic"><CircleAlert size={14} />{account.lastErrorCode}</p>}
    </article>
  </div>;
}

function AccountWorkflowTrack({ account }: { account: MarketplaceAccountView }) { const steps = [{ done: true, label: "连接" }, { done: account.hasCredential, label: "授权" }, { done: account.status === "active" && account.healthStatus === "healthy", label: "能力" }, { done: account.status === "active", label: "可发布" }]; const firstPending = steps.findIndex((step) => !step.done); return <ol className="store-workflow" aria-label={`${account.displayName} 发布准备状态`}>{steps.map((step, index) => <li className={step.done ? "done" : index === firstPending ? "current" : "pending"} key={step.label}><span>{step.done ? <Check size={13} /> : index + 1}</span><b>{step.label}</b></li>)}</ol>; }
function Signal({ label, value }: { label: string; value: number }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function SectionHeading({ code, icon: Icon, id, title }: { code: string; icon: typeof Store; id: string; title: string }) { return <header className="store-section-heading"><span><Icon size={16} /></span><div><p className="section-code">{code}</p><h2 id={id}>{title}</h2></div></header>; }
function StatusBadge({ status }: { status: MarketplaceAccountView["status"] }) { const labels = { active: "可发布", degraded: "异常", disabled: "已停用", pending_authorization: "待授权", revoked: "已撤销" }; return <span className={`store-status ${status}`}>{labels[status]}</span>; }
function statusLabel(status: MarketplaceAccountView["status"]) { return ({ active: "可发布", degraded: "异常", disabled: "已停用", pending_authorization: "待授权", revoked: "已撤销" })[status]; }
function SubmitButton({ children, danger, icon: Icon }: { children: React.ReactNode; danger?: boolean; icon: typeof Plus }) { const { pending } = useFormStatus(); return <button className={danger ? "danger" : undefined} disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Icon size={15} />}{children}</button>; }
function ActionNotice({ state }: { state: MarketplaceActionState }) { if (state.status === "idle") return null; return <p className={`store-action-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>; }
function credentialLabel(status: MarketplaceAccountView["credentialStatus"]) { return ({ expiring: "即将过期", missing: "未授权", revoked: "已撤销", valid: "有效" })[status]; }
function healthLabel(status: MarketplaceAccountView["healthStatus"]) { return ({ degraded: "异常", healthy: "健康", not_checked: "未检查", unauthorized: "未授权", unavailable: "不可用" })[status]; }
function formatDate(value: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function capabilityFreshness(account: MarketplaceAccountView) { if (!account.lastCapabilitySyncAt || !account.capabilityExpiresAt) return "未同步"; const remaining = Date.parse(account.capabilityExpiresAt) - Date.now(); if (remaining <= 0) return "已过期"; if (remaining <= 24 * 60 * 60 * 1000) return "即将过期"; return `有效至 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(account.capabilityExpiresAt))}`; }
function freshnessTone(account: MarketplaceAccountView) { const value = capabilityFreshness(account); return value === "已过期" || value === "未同步" ? "risk" : value === "即将过期" ? "warning" : "healthy"; }
function attentionReason(account: MarketplaceAccountView) { if (account.status === "disabled") return "连接已停用"; if (!account.hasCredential || account.credentialStatus === "revoked") return "需要完成授权"; if (account.status === "degraded" || account.healthStatus === "degraded" || account.healthStatus === "unavailable") return account.lastErrorCode ?? "健康检查异常"; if (capabilityFreshness(account) === "未同步" || capabilityFreshness(account) === "已过期") return "能力快照需同步"; if (account.credentialStatus === "expiring" || capabilityFreshness(account) === "即将过期") return "授权或能力即将过期"; return "无待处理项"; }
function formatQuota(quota: MarketplaceAccountView["quota"]) { if (!quota) return "未采集"; return quota.windows.map((window) => { const scope = window.scope === "second" ? "/秒" : window.scope === "day" ? "/日" : ""; if (window.limit !== undefined && window.remaining !== undefined) return `${window.remaining}/${window.limit}${scope}`; if (window.limit !== undefined) return `${window.limit}${scope}`; if (window.remaining !== undefined) return `剩余 ${window.remaining}${scope}`; return `重置于 ${formatDate(window.resetAt ?? null)}`; }).join(" · "); }
