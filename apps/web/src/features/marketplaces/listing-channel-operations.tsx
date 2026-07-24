"use client";

import type {
  ListingReplicationView,
  MarketplaceAccountView,
  MarketplaceAutomationRuleView,
  MarketplaceAutomationRunView,
  MarketplaceListingSyncAction,
  MarketplaceListingSyncRequestView,
  MarketplacePublicationRequestView,
} from "@yummyai/contracts";
import type { ListingVariant } from "@yummyai/platform-rules";
import { BadgeCheck, CircleAlert, CopyPlus, LoaderCircle, RefreshCw, SlidersHorizontal, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  createListingReplication,
  createMarketplaceAutomationRule,
  createMarketplaceListingSync,
  setMarketplaceAutomationEnabled,
  type MarketplaceActionState,
} from "./marketplace-actions";

export type AutomationWorkspaceView = MarketplaceAutomationRuleView & { runs: MarketplaceAutomationRunView[] };
const initialState: MarketplaceActionState = { message: "", status: "idle" };
const syncActionOptions: ReadonlyArray<{ label: string; value: MarketplaceListingSyncAction }> = [
  { value: "read", label: "读取价格与库存" },
  { value: "read_full_content", label: "读取完整内容" },
  { value: "push_price_inventory", label: "写入批准价格与库存" },
  { value: "push_full_content", label: "写入完整批准内容" },
];

export function ListingChannelOperations({ accounts, automations, error, listing, publications, replications, syncs }: {
  accounts: MarketplaceAccountView[];
  automations: AutomationWorkspaceView[];
  error?: string;
  listing: { id: string; locale: string; marketplaceId?: string; platform: "amazon" | "etsy"; status: string; variants: ListingVariant[]; versionId: string };
  publications: MarketplacePublicationRequestView[];
  replications: ListingReplicationView[];
  syncs: MarketplaceListingSyncRequestView[];
}) {
  const router = useRouter();
  const platformAccounts = accounts.filter((account) => account.platform === listing.platform && account.status === "active");
  const published = publications.filter((request) => request.current.status === "published" && ["amazon_submit", "amazon_feed_submit", "etsy_activate"].includes(request.action));
  const targetMarketplaces = [...new Set(platformAccounts.flatMap((account) => account.marketplaceIds))];
  const relevantRules = automations.filter((rule) => !rule.conditions.listingId || rule.conditions.listingId === listing.id);
  const [replicationState, replicate] = useActionState(createListingReplication.bind(null, listing.id, listing.versionId), initialState);
  const [syncState, sync] = useActionState(createMarketplaceListingSync.bind(null, listing.id, listing.versionId), initialState);
  const [automationState, createRule] = useActionState(createMarketplaceAutomationRule.bind(null, listing.id), initialState);
  const [sourceId, setSourceId] = useState(published[0]?.id ?? "");
  const source = published.find((request) => request.id === sourceId) ?? published[0];
  const [ruleAction, setRuleAction] = useState<"queue_publication" | "queue_listing_sync">("queue_publication");
  const [ruleAccountId, setRuleAccountId] = useState(platformAccounts[0]?.id ?? "");
  const ruleAccount = platformAccounts.find((account) => account.id === ruleAccountId) ?? platformAccounts[0];
  const rulePublished = published.filter((request) => request.accountId === ruleAccount?.id);
  const busy = syncs.some((request) => ["queued", "processing", "retry_pending"].includes(request.current.status));

  useEffect(() => {
    if ([replicationState, syncState, automationState].some((state) => state.status === "success")) router.refresh();
  }, [automationState, replicationState, router, syncState]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => router.refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [busy, router]);

  return <section className="channel-operations" aria-labelledby="channel-operations-title">
    <header className="channel-operations-header">
      <div><p className="section-code">CHANNEL ORCHESTRATION</p><h2 id="channel-operations-title">站点与在线 Listing 编排</h2></div>
      <button aria-label="刷新编排状态" onClick={() => router.refresh()} title="刷新编排状态" type="button"><RefreshCw size={16} /></button>
    </header>
    {error ? <p className="channel-error"><CircleAlert size={14} />{error}</p> : null}

    <OperationBand icon={<CopyPlus size={17} />} code="SITE REPLICA" title="多站点复制" count={`${replications.length} COPIES`}>
      <form action={replicate} className="channel-form replica-form">
        <label><span>目标站点</span><select name="targetMarketplaceId" required defaultValue={targetMarketplaces.find((id) => id !== listing.marketplaceId) ?? targetMarketplaces[0] ?? ""}>{targetMarketplaces.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
        <label><span>目标语言</span><input name="targetLocale" required defaultValue={listing.locale} placeholder="en-US" /></label>
        <label><span>本地化标题（可选）</span><input name="title" placeholder="留空则沿用批准标题" /></label>
        <SubmitButton disabled={listing.status !== "approved" || targetMarketplaces.length === 0} label="创建站点草稿" />
      </form>
      <Notice state={replicationState} />
      <div className="channel-ledger">{replications.length ? replications.map((item) => <div className="channel-row" key={item.id}><strong>{item.targetMarketplaceId}</strong><span>{item.targetLocale}</span><code>{item.targetListingId.slice(0, 13)}</code><Status label="草稿已创建" tone="complete" /></div>) : <Empty text="尚未创建站点副本；副本始终从当前批准版本生成。" />}</div>
    </OperationBand>

    <OperationBand icon={<SlidersHorizontal size={17} />} code="ONLINE RECONCILIATION" title="在线 Listing 同步" count={`${syncs.length} REQUESTS`}>
      <form action={sync} className="channel-form sync-form">
        <label><span>已发布 Listing</span><select name="sourcePublicationRequestId" required value={source?.id ?? ""} onChange={(event) => setSourceId(event.target.value)}>{published.map((request) => <option key={request.id} value={request.id}>{request.marketplaceId} · {request.current.externalListingId ?? request.id.slice(0, 8)}</option>)}</select></label>
        <input name="accountId" type="hidden" value={source?.accountId ?? ""} />
        <label><span>动作</span><select name="action" defaultValue="read">{syncActionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <SubmitButton disabled={!source} label="排队执行" />
      </form>
      <Notice state={syncState} />
      <div className="channel-ledger">{syncs.length ? syncs.map((item) => <div className="channel-row" key={item.id}><strong>{syncActionLabel(item.action)}</strong><span>{item.marketplaceId} · {item.externalListingId}</span><code>{formatDate(item.createdAt)}</code><Status label={syncStatus(item.current.status)} tone={syncTone(item.current.status)} /></div>) : <Empty text="没有同步记录；需要先通过官方发布流程取得在线 Listing。" />}</div>
    </OperationBand>

    <OperationBand icon={<Workflow size={17} />} code="APPROVAL TRIGGERS" title="自动化规则" count={`${relevantRules.length} RULES`}>
      <form action={createRule} className="channel-form automation-form">
        <label><span>规则名</span><input name="name" required placeholder="批准后进入美国站预检" /></label>
        <label><span>动作</span><select name="actionType" value={ruleAction} onChange={(event) => setRuleAction(event.target.value as typeof ruleAction)}><option value="queue_publication">发布预检 / 草稿</option><option value="queue_listing_sync">在线价格库存同步</option></select></label>
        <label><span>店铺</span><select name="accountId" required value={ruleAccount?.id ?? ""} onChange={(event) => setRuleAccountId(event.target.value)}>{platformAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
        {ruleAction === "queue_publication" ? <>
          <label><span>Marketplace</span><select name="marketplaceId" required>{(ruleAccount?.marketplaceIds ?? []).map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          {listing.platform === "amazon" ? <label><span>SKU</span><select name="variantSkuId" required>{listing.variants.map((variant) => <option key={variant.skuId} value={variant.skuId}>{variant.skuCode}</option>)}</select></label> : null}
        </> : <>
          <label><span>在线 Listing</span><select name="sourcePublicationRequestId" required>{rulePublished.map((request) => <option key={request.id} value={request.id}>{request.marketplaceId} · {request.current.externalListingId}</option>)}</select></label>
          <label><span>同步动作</span><select name="syncAction">{syncActionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        </>}
        <label><span>最低完整度</span><input min="0" max="100" name="minimumCompleteness" type="number" defaultValue="100" /></label>
        <label className="channel-check"><input name="enabled" type="checkbox" /><span>创建后启用</span></label>
        <SubmitButton disabled={!ruleAccount || (ruleAction === "queue_listing_sync" && !rulePublished.length)} label="保存规则" />
      </form>
      <Notice state={automationState} />
      <div className="channel-ledger">{relevantRules.length ? relevantRules.map((rule) => <AutomationRow key={rule.id} listingId={listing.id} rule={rule} />) : <Empty text="暂无规则；规则默认可保持停用，确认条件后再启用。" />}</div>
    </OperationBand>
  </section>;
}

function AutomationRow({ listingId, rule }: { listingId: string; rule: AutomationWorkspaceView }) {
  const [state, action] = useActionState(setMarketplaceAutomationEnabled.bind(null, listingId, rule.id, !rule.enabled), initialState);
  const latest = rule.runs[0];
  return <div className="channel-row automation-row"><strong>{rule.name}</strong><span>{rule.action.type === "queue_publication" ? "发布预检 / 草稿" : syncActionLabel(rule.action.action)} · ≥ {rule.conditions.minimumCompleteness}%</span><code>{latest ? `${runLabel(latest.status)} · ${formatDate(latest.occurredAt)}` : "尚未触发"}</code><form action={action}><button className={rule.enabled ? "rule-on" : "rule-off"} type="submit">{rule.enabled ? "已启用" : "已停用"}</button></form><Notice state={state} /></div>;
}

function OperationBand({ children, code, count, icon, title }: { children: React.ReactNode; code: string; count: string; icon: React.ReactNode; title: string }) { return <section className="operation-band"><header><span>{icon}</span><div><p className="section-code">{code}</p><h3>{title}</h3></div><b>{count}</b></header>{children}</section>; }
function SubmitButton({ disabled, label }: { disabled?: boolean; label: string }) { const { pending } = useFormStatus(); return <button disabled={disabled || pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <BadgeCheck size={15} />}{label}</button>; }
function Notice({ state }: { state: MarketplaceActionState }) { if (state.status === "idle") return null; return <p className={`channel-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={13} /> : <CircleAlert size={13} />}{state.message}</p>; }
function Empty({ text }: { text: string }) { return <p className="channel-empty">{text}</p>; }
function Status({ label, tone }: { label: string; tone: string }) { return <em className={`channel-status ${tone}`}>{label}</em>; }
function syncActionLabel(action: MarketplaceListingSyncAction) { return syncActionOptions.find((option) => option.value === action)?.label ?? action; }
function syncStatus(status: MarketplaceListingSyncRequestView["current"]["status"]) { return ({ queued: "已排队", processing: "处理中", completed: "一致", drift_detected: "发现差异", retry_pending: "等待重试", reconciliation_required: "需要对账", failed: "失败" })[status]; }
function syncTone(status: MarketplaceListingSyncRequestView["current"]["status"]) { return ["completed"].includes(status) ? "complete" : ["queued", "processing", "retry_pending"].includes(status) ? "running" : "failed"; }
function runLabel(status: MarketplaceAutomationRunView["status"]) { return ({ enqueued: "已入队", failed: "失败", skipped: "已跳过" })[status]; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
