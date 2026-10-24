"use client";

import type { MarketplaceAccountView, MarketplacePublicationRequestView } from "@yummyai/contracts";
import { MarketplaceAccountViewSchema } from "@yummyai/contracts/marketplace/store";
import { MarketplaceAuthorityWorkspaceSchema, type MarketplaceAuthorityWorkspace } from "@yummyai/contracts/marketplace/authority";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { Permission } from "@yummyai/authz/permissions";
import { z } from "zod";
import { ArrowLeft, ArrowRight, BadgeCheck, Ban, Check, CircleAlert, ExternalLink, HeartPulse, KeyRound, ListChecks, LoaderCircle, RefreshCw, Settings2, ShieldCheck, ShoppingBag, Store, Unplug, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import { authorizeAmazonPrivate, revokeMarketplaceAuthorization, setMarketplaceAccountEnabled, startMarketplaceOAuth, syncMarketplaceCapabilities, type MarketplaceLifecycleActionState } from "./marketplace-actions";

import { StoreRecordButton } from "./store-record-form";
import { StoreNodeWorkspace } from "./store-node-workspace";
import { StoreNodeExecutionWorkspace } from "./store-node-execution-workspace";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";
import { MarketplaceLifecycleActionSchema, MarketplaceLifecycleError, marketplaceAuthorityDigest, marketplaceAuthorityMatches,
  marketplaceLifecycleFailure, marketplaceLifecycleState, marketplaceOAuthAuthorizationUrl, marketplaceResponseCode,
  readMarketplaceJson, type MarketplaceLifecycleOperation } from "./marketplace-lifecycle";
import "./marketplace-accounts.css";

const initialState: MarketplaceLifecycleActionState = { message: "", status: "idle" };

export function MarketplaceAccountsWorkspace({ accounts: allAccounts, contextAuthority, error, oauthNotice, publications }: { accounts: MarketplaceAccountView[]; contextAuthority?: string; error?: string; oauthNotice?: { message: string; status: "success" | "error" }; publications: MarketplacePublicationRequestView[] }) {
  const access = useErpAccess(), authorityDigest = useMarketplaceAuthorityDigest(access.authority);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const parsed = z.array(MarketplaceAccountViewSchema.strict()).safeParse(allAccounts);
  if (!access.authority || !access.can(Permission.StoreRead) || !contextAuthority || authorityDigest !== contextAuthority)
    return <StoreAccessNotice failed={Boolean(error)} />;
  if (!parsed.success) return <p className="store-page-notice error" role="alert">店铺资料格式暂时无法核对 请重新加载</p>;
  const accounts = includeDisabled ? parsed.data : parsed.data.filter(account => account.status !== "disabled");
  const activeCount = accounts.filter((account) => account.status === "active").length;
  const attentionCount = accounts.filter((account) => attentionReason(account) !== "无待处理项").length;
  return (
    <div className="store-workspace">
      <label className="record-help"><input type="checkbox" checked={includeDisabled} onChange={event => setIncludeDisabled(event.target.checked)} /> 包含已停用店铺（{allAccounts.filter(account => account.status === "disabled").length}）</label>
      {(error || oauthNotice) && <p className={`store-page-notice ${error || oauthNotice?.status === "error" ? "error" : "success"}`} role="status">{error ? "店铺资料暂时无法读取 请重新加载" : "已返回平台授权流程 请进入原店铺重新读取当前授权状态"}</p>}
      <dl className="store-signal-strip" aria-label="店铺运营概览"><Signal label="店铺" value={accounts.length} /><Signal label="原授权有效" value={activeCount} /><Signal label="待授权" value={accounts.filter((account) => !account.hasCredential).length} /><Signal label="需处理" value={attentionCount} /></dl>
      {access.can(Permission.StoreManage) && <StoreRecordButton />}
      {accounts.length === 0 ? <section className="store-empty"><Store size={28} /><strong>暂无店铺档案</strong><span>点击新增店铺建立档案，即可手动导入订单；平台授权可以稍后完成。</span></section> : (
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

type DetailProps = { account: MarketplaceAccountView; contextAuthority?: string; error?: string; listingCount: number | null; notice?: { message: string; status: "success" | "error" }; orderCount: number | null; publicationCount: number | null };
export function MarketplaceAccountDetail(props: DetailProps) {
  const access = useErpAccess(), identity = useContext(ErpIdentityContext);
  if (!access.authority || !access.can(Permission.StoreRead) || !identity?.session) return <StoreAccessNotice />;
  return <MarketplaceAccountAuthority key={`${access.authority}:${props.account.id.toLowerCase()}`} {...props} />;
}
function MarketplaceAccountAuthority({ account: originalAccount, contextAuthority, error, listingCount, notice, orderCount, publicationCount }: DetailProps) {
  const access = useErpAccess(), identity = useContext(ErpIdentityContext), session = identity?.session;
  const authority = access.authority, accountId = originalAccount.id.toLowerCase(), actorId = session?.userId ?? "", tenantId = session?.tenantId ?? "";
  const scope = `${authority}:${accountId}:${actorId}:${tenantId}`, currentScope = useRef(scope); currentScope.current = scope;
  const alive = useRef(true), readSequence = useRef(0), operationSequence = useRef(0), controller = useRef<AbortController | null>(null);
  const deniedRef = useRef(false);
  const pending = useRef<{ operation: MarketplaceLifecycleOperation; sequence: number } | null>(null), secretForm = useRef<HTMLFormElement | null>(null);
  const dataRef = useRef<MarketplaceAuthorityWorkspace | null>(null);
  const [data, setData] = useState<MarketplaceAuthorityWorkspace | null>(null), [reading, setReading] = useState(false);
  const [unverified, setUnverified] = useState(true), [readMessage, setReadMessage] = useState("");
  const [operation, setOperation] = useState<MarketplaceLifecycleOperation | null>(null), [formVersion, setFormVersion] = useState(0);
  const [actionState, setActionState] = useState<MarketplaceLifecycleActionState>(initialState);
  const [capabilityExpired, setCapabilityExpired] = useState(false);
  const valid = useCallback(() => alive.current && currentScope.current === scope, [scope]);
  const clearSecret = useCallback(() => { secretForm.current?.reset(); setFormVersion(value => value + 1); }, []);
  const deny = useCallback((message: string) => {
    deniedRef.current = true;
    readSequence.current++; operationSequence.current++; controller.current?.abort(); pending.current = null;
    secretForm.current?.reset(); dataRef.current = null; setData(null); setReading(false); setOperation(null);
    setFormVersion(value => value + 1); setUnverified(true); setActionState(initialState); setReadMessage(message);
    window.dispatchEvent(new Event("focus"));
  }, []);
  useLayoutEffect(() => {
    alive.current = true;
    const invalidate = () => { alive.current = false; deniedRef.current = true; readSequence.current++; operationSequence.current++;
      controller.current?.abort(); pending.current = null; dataRef.current = null; secretForm.current?.reset(); };
    const cleared = () => { invalidate(); setData(null); setReading(false); setOperation(null); setUnverified(true); setActionState(initialState);
      setReadMessage("当前本人会话已清除 原资料和填写已隐藏"); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, cleared);
    return () => { window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, cleared); invalidate(); };
  }, []);
  const load = useCallback(async (manual = false) => {
    if (!authority || !actorId || !tenantId || !valid() || deniedRef.current && !manual) return;
    const sequence = ++readSequence.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setReading(true); setReadMessage("");
    try {
      const digest = await marketplaceAuthorityDigest(authority);
      if (!valid() || sequence !== readSequence.current || abort.signal.aborted) return;
      const response = await fetch(`/api/marketplace-accounts/${accountId}/authority`, { cache: "no-store", signal: abort.signal,
        headers: { "x-yummyai-context-authority": digest } });
      if (!response.ok) { const code = await marketplaceResponseCode(response); throw new MarketplaceLifecycleError(response.status, code ?? "marketplace_read_unavailable"); }
      const result = MarketplaceAuthorityWorkspaceSchema.parse(await readMarketplaceJson(response, 1024 * 1024));
      if (response.status !== 200 || response.headers.get("x-yummyai-context-authority") !== digest ||
        !marketplaceAuthorityMatches(result, { accountId, actorId, tenantId, authority: digest })) throw new MarketplaceLifecycleError(409, "authority_changed");
      if (!valid() || sequence !== readSequence.current || abort.signal.aborted) return;
      deniedRef.current = false; dataRef.current = result; setData(result); setUnverified(false);
    } catch (failure) {
      if (!valid() || sequence !== readSequence.current || abort.signal.aborted) return;
      const result = failure instanceof MarketplaceLifecycleError ? marketplaceLifecycleFailure(failure.status, failure.code) : marketplaceLifecycleFailure(502);
      if (result.denied) { deny(result.message); return; }
      setUnverified(true); setReadMessage(result.message);
    } finally { if (valid() && sequence === readSequence.current) setReading(false); }
  }, [accountId, actorId, authority, deny, tenantId, valid]);
  useEffect(() => { void load(); const focus = () => { if (document.visibilityState !== "hidden") void load(); };
    window.addEventListener("focus", focus); window.addEventListener("pageshow", focus);
    return () => { controller.current?.abort(); window.removeEventListener("focus", focus); window.removeEventListener("pageshow", focus); }; }, [load]);
  const lifecycle = data ? marketplaceLifecycleState(data) : null;
  useEffect(() => { if (!lifecycle?.busy) return; const timer = window.setInterval(() => void load(), 3000); return () => window.clearInterval(timer); }, [lifecycle?.busy, load]);
  useEffect(() => {
    if (!data?.account.capabilityExpiresAt) { setCapabilityExpired(true); return; }
    const remaining = Date.parse(data.account.capabilityExpiresAt) - Date.parse(data.observedAt);
    setCapabilityExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setCapabilityExpired(true), Math.min(remaining, 2147483647));
    return () => window.clearTimeout(timer);
  }, [data]);

  async function run(next: MarketplaceLifecycleOperation, form: FormData) {
    const before = dataRef.current;
    const preempt = next === "revoke" || next === "disable";
    if (!valid() || !before || unverified || !authority || !session || pending.current && (!preempt || ["revoke", "disable"].includes(pending.current.operation))) return;
    const controls = marketplaceLifecycleState(before);
    if ((next === "authorize" || next === "oauth" || next === "revoke") ? !before.access.authorize || !access.can(Permission.StoreAuthorize)
      : next === "sync" ? !controls.canSync || !access.can(Permission.StoreManage) : !before.access.manage || !access.can(Permission.StoreManage)) return;
    const sequence = ++operationSequence.current; pending.current = { operation: next, sequence };
    readSequence.current++; controller.current?.abort(); setReading(false); setOperation(next); setReadMessage(""); setActionState(initialState);
    if (preempt) clearSecret();
    form.set("__marketplaceAuthority", before.context.authority); form.set("__authorizationGeneration", before.lifecycle.authorizationGeneration);
    try {
      const raw = next === "authorize" ? await authorizeAmazonPrivate(accountId, initialState, form)
        : next === "oauth" ? await startMarketplaceOAuth(accountId, initialState, form)
          : next === "sync" ? await syncMarketplaceCapabilities(accountId, before.account.platform, initialState, form)
            : next === "revoke" ? await revokeMarketplaceAuthorization(accountId, initialState, form)
              : await setMarketplaceAccountEnabled(accountId, next === "enable", initialState, form);
      if (!valid() || operationSequence.current !== sequence) return;
      const parsed = MarketplaceLifecycleActionSchema.safeParse(raw);
      if (!parsed.success || (parsed.data.status === "success" || parsed.data.status === "unknown") &&
        (parsed.data.accountId?.toLowerCase() !== accountId || parsed.data.contextAuthority !== before.context.authority || parsed.data.operation !== next) ||
        parsed.data.accountId && parsed.data.accountId.toLowerCase() !== accountId ||
        parsed.data.contextAuthority && parsed.data.contextAuthority !== before.context.authority || parsed.data.operation && parsed.data.operation !== next)
        throw new Error("marketplace_action_invalid");
      const result = parsed.data;
      if (result.denied) { deny(result.message); return; }
      if (result.workspace && !marketplaceAuthorityMatches(result.workspace, { accountId, actorId, tenantId, authority: before.context.authority })) {
        deny("店铺响应与当前本人或账户不一致 原资料已隐藏 请重新读取"); return;
      }
      if (result.status !== "error") clearSecret();
      setActionState(result);
      if (result.workspace) { readSequence.current++; controller.current?.abort(); dataRef.current = result.workspace; setData(result.workspace); setUnverified(false); }
      else setUnverified(true);
      if (result.status === "success" && result.redirectUrl) {
        const redirect = marketplaceOAuthAuthorizationUrl(result.redirectUrl, before.account.platform);
        if (valid() && operationSequence.current === sequence) window.location.assign(redirect.url.toString());
      }
    } catch {
      if (!valid() || operationSequence.current !== sequence) return;
      clearSecret(); setUnverified(true); setActionState(marketplaceLifecycleFailure(502, undefined, true));
    } finally { if (valid() && operationSequence.current === sequence) { pending.current = null; setOperation(null); } }
  }
  if (!data) return <div className="store-detail-workspace store-authority-empty"><Link className="store-back-link" href="/stores"><ArrowLeft size={15} />返回店铺运营</Link>
    <section aria-label="店铺授权状态" aria-busy={reading}><ShieldCheck size={23} /><h1>核对当前店铺授权</h1>
      <p role="status">{reading ? "正在读取本人与店铺的当前授权状态" : readMessage || "店铺资料与本人权限尚未核对 旧资料和填写已隐藏"}</p>
      <button disabled={reading} onClick={() => void load(true)}><RefreshCw size={15} />重新读取授权状态</button></section></div>;
  const account = data.account, canAuthorize = data.access.authorize && access.can(Permission.StoreAuthorize), canManage = data.access.manage && access.can(Permission.StoreManage);
  const verifiedListingCount = contextAuthority === data.context.authority ? listingCount : null;
  const verifiedOrderCount = contextAuthority === data.context.authority ? orderCount : null;
  const verifiedPublicationCount = contextAuthority === data.context.authority ? publicationCount : null;
  const busy = operation !== null, locked = unverified || reading;
  const canInterrupt = !pending.current || !["revoke", "disable"].includes(pending.current.operation);
  return <div className="store-detail-workspace">
    <Link className="store-back-link" href="/stores"><ArrowLeft size={15} />返回店铺运营</Link>
    {(error || notice) && <p className={`store-page-notice ${error || notice?.status === "error" ? "error" : "success"}`} role="status">{error ? "部分原目录摘要暂不可用 授权状态以本次读取为准" : "已返回平台授权流程 当前状态以本次读取为准"}</p>}
    <article className="store-record store-detail-record">
      <header><div className="store-identity"><span className={`platform-mark ${account.platform}`}>{account.platform === "amazon" ? "AMZ" : "ETSY"}</span><div><p className="section-code">STORE DETAIL / SETTINGS</p><h1>{account.displayName}</h1><p>{account.externalAccountId ?? "尚未绑定平台账号"} · {account.region}</p></div></div><StatusBadge status={account.status} /></header>
      {canManage && !locked && !busy && <StoreRecordButton account={account} />}
      {!account.hasCredential && <p className="record-notice">档案已建立。{account.platform === "amazon" && <Link href="/orders?view=reports">导入订单报告</Link>} 需要自动同步时，在下方设置中完成平台授权。</p>}
      <AccountWorkflowTrack account={account} capabilityCurrent={data.lifecycle.capabilityCurrent && !capabilityExpired} />
      <section className="store-lifecycle" aria-label="店铺授权状态" aria-busy={reading || busy}>
        <header><h2><ShieldCheck size={16} />{lifecycle?.label}</h2><button disabled={reading} onClick={() => void load(true)}><RefreshCw size={15} />重新读取授权状态</button></header>
        <dl><Fact label="授权代次" value={data.lifecycle.authorizationGeneration} /><Fact label="凭据版本" value={data.lifecycle.credentialVersion === null ? "未提供" : String(data.lifecycle.credentialVersion)} />
          <Fact label="本次状态截至" value={formatDate(data.observedAt)} /><Fact label="当前能力依据" value={data.lifecycle.capabilityCurrent && !capabilityExpired ? "当前代次有效" : "尚未核验或已失效"} /></dl>
        {lifecycle?.busy && <p role="status">原凭据操作正在处理中 当前只重新读取状态 不会再次交换或刷新凭据</p>}
        {lifecycle?.reauthorize && <p className="store-lifecycle-risk" role="status">凭据刷新结果未知 需要重新授权 不会重试旧刷新</p>}
        {unverified && <p className="store-lifecycle-risk" role="status">当前状态尚未重新核对 请先只读取授权状态 不会自动重发原操作</p>}
        {readMessage && <p className="store-lifecycle-risk" role="alert">{readMessage}</p>}
        <p className="store-lifecycle-note">此处核对中央授权和能力同步 店铺独立节点及平台执行仍需另行验收</p>
      </section>
      <nav className="store-detail-nav" aria-label="店铺详情分区"><a href="#store-overview">概览</a><a href="#store-listings">Listings</a><a href="#store-orders">订单</a><a href="#store-health">健康</a><a href="#store-settings">设置</a></nav>
      <section className="store-detail-section" id="store-overview" aria-labelledby="store-overview-title"><SectionHeading code="STORE OVERVIEW" icon={Store} id="store-overview-title" title="概览" /><dl className="store-facts store-overview-facts"><Fact label="运行状态" value={statusLabel(account.status)} /><Fact label="授权状态" value={credentialLabel(account.credentialStatus)} /><Fact label="区域" value={account.region} /><Fact label="Marketplace" value={account.marketplaceIds.join(" · ")} /><Fact label="最近更新" value={formatDate(account.updatedAt)} /><Fact label="当前关注" value={attentionReason(account)} /></dl></section>
      <div className="store-detail-columns">
        <section className="store-detail-section" id="store-listings" aria-labelledby="store-listings-title"><SectionHeading code="LISTING OPERATIONS" icon={ListChecks} id="store-listings-title" title="Listings" /><dl className="store-layer-facts"><Fact label="近期关联 Listing" value={verifiedListingCount === null ? "不可用" : `${verifiedListingCount} 个`} /><Fact label="发布请求" value={verifiedPublicationCount === null ? "不可用" : `${verifiedPublicationCount} 次`} /></dl><p>{verifiedPublicationCount === null ? "发布记录摘要当前不可用 不代表没有原记录" : verifiedPublicationCount ? "统计当前店铺最近 100 条发布请求中的真实关联记录。" : "该店铺还没有发布请求；不会推断或补齐平台 Listing。"}</p><Link className="store-layer-link" href={`/listings?marketplaceId=${encodeURIComponent(account.marketplaceIds[0] ?? "")}`}>打开 Listing 目录<ArrowRight size={14} /></Link></section>
        <section className="store-detail-section" id="store-orders" aria-labelledby="store-orders-title"><SectionHeading code="ORDER FLOW" icon={ShoppingBag} id="store-orders-title" title="订单" /><dl className="store-layer-facts"><Fact label="近期订单" value={verifiedOrderCount === null ? "不可用" : `${verifiedOrderCount} 个`} /><Fact label="读取范围" value="最近 100 条" /></dl><p>{verifiedOrderCount === null ? "订单摘要当前不可用 不代表没有订单" : verifiedOrderCount ? "仅展示普通订单投影计数，不读取买家姓名、地址或联系方式。" : "该店铺当前没有可见订单；系统不会生成占位订单。"}</p><Link className="store-layer-link" href={`/orders?platform=${account.platform}&accountId=${account.id}`}>打开订单履约<ArrowRight size={14} /></Link></section>
      </div>
      <section className="store-detail-section" id="store-health" aria-labelledby="store-health-title"><SectionHeading code="CONNECTION HEALTH" icon={HeartPulse} id="store-health-title" title="健康与能力" /><div className="store-record-body"><dl className="store-facts"><Fact label="健康检查" value={healthLabel(account.healthStatus)} /><Fact label="最近检查" value={formatDate(account.lastHealthAt)} /><Fact label="能力同步" value={formatDate(account.lastCapabilitySyncAt)} /><Fact label="能力有效期" value={formatDate(account.capabilityExpiresAt)} /><Fact label="API 配额" value={formatQuota(account.quota)} /><Fact label="诊断代码" value={account.lastErrorCode ?? "无"} /></dl><div className="store-capabilities"><p className="section-code">GRANTED CAPABILITIES</p><div>{account.capabilities.length ? account.capabilities.map((capability) => <span key={capability}>{capability}</span>) : <em>尚未同步</em>}</div></div></div></section>
      <section className="store-settings-panel store-detail-section store-authority-settings" id="store-settings" aria-labelledby="store-settings-title"><header><div><p className="section-code">CONNECTION SETTINGS</p><h2 id="store-settings-title"><Settings2 size={16} />设置</h2></div><span>凭证值不会回显</span></header><div className="store-account-actions">
        {canAuthorize && account.authorizationMode === "amazon_private" && account.status !== "disabled" && <details key={formVersion}><summary><KeyRound size={15} />{account.hasCredential || lifecycle?.reauthorize ? "重新验证私有应用" : "验证私有应用"}</summary>
          <form ref={secretForm} onSubmit={event => { event.preventDefault(); void run("authorize", new FormData(event.currentTarget)); }} className="store-secret-form"><fieldset disabled={locked || busy || lifecycle?.busy}>
            <label><span>Seller ID</span><input autoComplete="off" name="sellingPartnerId" required maxLength={160} /></label><label><span>LWA Client ID</span><input autoComplete="off" name="clientId" required maxLength={2048} /></label>
            <label><span>Client secret</span><input data-private-secret autoComplete="off" name="clientSecret" required type="password" maxLength={8192} /></label><label><span>Refresh token</span><input data-private-secret autoComplete="off" name="refreshToken" required type="password" maxLength={16384} /></label>
            <SubmitButton icon={ShieldCheck} pending={operation === "authorize"}>验证并保存</SubmitButton></fieldset></form></details>}
        <MarketplaceOAuthAction account={account} canAuthorize={canAuthorize} reauthorize={!!lifecycle?.reauthorize} locked={locked} busy={busy} lifecycleBusy={!!lifecycle?.busy} pending={operation === "oauth"} onSubmit={form => void run("oauth", form)} />
        <StoreNodeExecutionWorkspace key={data.lifecycle.authorizationGeneration} accountId={accountId} contextAuthority={data.context.authority} sourceBusy={locked || busy || reading} onDenied={() => deny("本店或本人权限已变化 原资料和填写已隐藏 请重新读取授权状态")} onCompleted={() => void load(true)} />
        {canManage && <form onSubmit={event => { event.preventDefault(); void run(account.status === "disabled" ? "enable" : "disable", new FormData(event.currentTarget)); }}><SubmitButton icon={account.status === "disabled" ? Check : Ban} pending={operation === "enable" || operation === "disable"} disabled={locked || (account.status === "disabled" ? busy : !canInterrupt)}>{account.status === "disabled" ? "启用" : "停用"}</SubmitButton></form>}
        {canAuthorize && account.hasCredential && <form onSubmit={event => { event.preventDefault(); void run("revoke", new FormData(event.currentTarget)); }}><SubmitButton danger icon={Unplug} pending={operation === "revoke"} disabled={locked || !canInterrupt}>撤销授权</SubmitButton></form>}
        {!canAuthorize && !canManage && <p className="store-lifecycle-note">当前仅可读取本店授权状态 无授权或管理操作权限</p>}
      </div></section>
      <StoreNodeWorkspace key={data.lifecycle.authorizationGeneration} accountId={accountId} contextAuthority={data.context.authority} onDenied={() => deny("本店或本人权限已变化 原资料和填写已隐藏 请重新读取授权状态")} />
      <ActionNotice state={actionState} />{account.lastErrorCode && <p className="store-diagnostic"><CircleAlert size={14} />{account.lastErrorCode}</p>}
    </article>
  </div>;
}

export function MarketplaceOAuthAction({ account, canAuthorize, reauthorize = false, locked = false, busy = false, lifecycleBusy = false, pending = false, onSubmit }: {
  account: Pick<MarketplaceAccountView, "authorizationMode" | "status" | "hasCredential">; canAuthorize: boolean;
  reauthorize?: boolean; locked?: boolean; busy?: boolean; lifecycleBusy?: boolean; pending?: boolean; onSubmit(form: FormData): void;
}) {
  if (!canAuthorize || account.authorizationMode === "amazon_private" || account.status === "disabled" ||
    account.authorizationMode !== "amazon_public" && account.hasCredential && !reauthorize) return null;
  const label = account.authorizationMode === "amazon_public" && account.hasCredential ? "重新授权公开应用" : "前往平台授权";
  return <form onSubmit={event => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}>
    <SubmitButton icon={ExternalLink} pending={pending} disabled={locked || busy || lifecycleBusy}>{label}</SubmitButton>
  </form>;
}

function useMarketplaceAuthorityDigest(authority: string | null) {
  const [value, setValue] = useState<{ authority: string; digest: string } | null>(null);
  useEffect(() => {
    let current = true;
    const clear = () => { current = false; setValue(null); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    if (authority) void marketplaceAuthorityDigest(authority).then(digest => { if (current) setValue({ authority, digest }); }).catch(() => { if (current) setValue(null); });
    return () => { current = false; window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, [authority]);
  return value?.authority === authority ? value.digest : null;
}
function StoreAccessNotice({ failed = false }: { failed?: boolean }) { return <section className="store-authority-empty" role="status"><ShieldCheck size={23} /><h1>当前店铺资料不可读取</h1><p>{failed ? "店铺资料暂时无法核对 请重新读取 旧资料和填写已隐藏" : "当前本人身份或店铺读取权限尚未核对 旧资料和填写已隐藏"}</p></section>; }
function AccountWorkflowTrack({ account, capabilityCurrent }: { account: MarketplaceAccountView; capabilityCurrent: boolean }) { const steps = [{ done: true, label: "档案" }, { done: account.hasCredential, label: "授权" }, { done: capabilityCurrent, label: "能力依据" }, { done: capabilityCurrent && account.status === "active" && account.healthStatus === "healthy", label: "能力已验证" }]; const firstPending = steps.findIndex((step) => !step.done); return <ol className="store-workflow" aria-label={`${account.displayName} 中央授权状态`}>{steps.map((step, index) => <li className={step.done ? "done" : index === firstPending ? "current" : "pending"} key={step.label}><span>{step.done ? <Check size={13} /> : index + 1}</span><b>{step.label}</b></li>)}</ol>; }
function Signal({ label, value }: { label: string; value: number }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function SectionHeading({ code, icon: Icon, id, title }: { code: string; icon: typeof Store; id: string; title: string }) { return <header className="store-section-heading"><span><Icon size={16} /></span><div><p className="section-code">{code}</p><h2 id={id}>{title}</h2></div></header>; }
function StatusBadge({ status }: { status: MarketplaceAccountView["status"] }) { return <span className={`store-status ${status}`}>{statusLabel(status)}</span>; }
function statusLabel(status: MarketplaceAccountView["status"]) { return ({ active: "授权有效", degraded: "异常", disabled: "已停用", pending_authorization: "待授权", revoked: "已撤销" })[status]; }
function SubmitButton({ children, danger, icon: Icon, pending = false, disabled = false }: { children: React.ReactNode; danger?: boolean; icon: LucideIcon; pending?: boolean; disabled?: boolean }) { return <button className={danger ? "danger" : undefined} disabled={pending || disabled} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Icon size={15} />}{children}</button>; }
function ActionNotice({ state }: { state: MarketplaceLifecycleActionState }) { if (state.status === "idle") return null; return <p className={`store-action-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>; }
function credentialLabel(status: MarketplaceAccountView["credentialStatus"]) { return ({ expiring: "即将过期", missing: "未授权", revoked: "已撤销", valid: "有效" })[status]; }
function healthLabel(status: MarketplaceAccountView["healthStatus"]) { return ({ degraded: "异常", healthy: "健康", not_checked: "未检查", unauthorized: "未授权", unavailable: "不可用" })[status]; }
function formatDate(value: string | null) { if (!value) return "—"; return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function capabilityFreshness(account: MarketplaceAccountView) { if (!account.lastCapabilitySyncAt || !account.capabilityExpiresAt) return "未同步"; const remaining = Date.parse(account.capabilityExpiresAt) - Date.now(); if (remaining <= 0) return "已过期"; if (remaining <= 24 * 60 * 60 * 1000) return "即将过期"; return `有效至 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(account.capabilityExpiresAt))}`; }
function freshnessTone(account: MarketplaceAccountView) { const value = capabilityFreshness(account); return value === "已过期" || value === "未同步" ? "risk" : value === "即将过期" ? "warning" : "healthy"; }
function attentionReason(account: MarketplaceAccountView) { if (account.status === "disabled") return "连接已停用"; if (!account.hasCredential || account.credentialStatus === "revoked") return "需要完成授权"; if (account.status === "degraded" || account.healthStatus === "degraded" || account.healthStatus === "unavailable") return account.lastErrorCode ?? "健康检查异常"; if (capabilityFreshness(account) === "未同步" || capabilityFreshness(account) === "已过期") return "能力快照需同步"; if (account.credentialStatus === "expiring" || capabilityFreshness(account) === "即将过期") return "授权或能力即将过期"; return "无待处理项"; }
function formatQuota(quota: MarketplaceAccountView["quota"]) { if (!quota) return "未采集"; return quota.windows.map((window) => { const scope = window.scope === "second" ? "/秒" : window.scope === "day" ? "/日" : ""; if (window.limit !== undefined && window.remaining !== undefined) return `${window.remaining}/${window.limit}${scope}`; if (window.limit !== undefined) return `${window.limit}${scope}`; if (window.remaining !== undefined) return `剩余 ${window.remaining}${scope}`; return `重置于 ${formatDate(window.resetAt ?? null)}`; }).join(" · "); }
