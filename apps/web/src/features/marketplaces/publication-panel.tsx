"use client";

import type {
  MarketplaceAccountView,
  MarketplacePublicationEventView,
  MarketplacePublicationRequestView,
} from "@yummyai/contracts";
import type { ListingVariant } from "@yummyai/platform-rules";
import {
  BadgeCheck,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Play,
  RefreshCw,
  Send,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  continueMarketplacePublication,
  createMarketplacePublication,
  type MarketplaceActionState,
} from "./marketplace-actions";

export type PublicationWorkspaceView = MarketplacePublicationRequestView & {
  events: MarketplacePublicationEventView[];
};

const initialState: MarketplaceActionState = { message: "", status: "idle" };
const terminalStatuses = new Set([
  "validation_passed",
  "validation_failed",
  "draft_created",
  "published",
  "publication_failed",
  "deactivated",
  "reconciliation_required",
  "cancelled",
  "failed",
]);

export function PublicationPanel({
  accounts,
  error,
  listing,
  publications,
}: {
  accounts: MarketplaceAccountView[];
  error?: string;
  listing: {
    id: string;
    platform: "amazon" | "etsy";
    status: "draft" | "in_review" | "approved" | "archived";
    validationBlockers: number;
    variants: ListingVariant[];
    versionId: string;
  };
  publications: PublicationWorkspaceView[];
}) {
  const router = useRouter();
  const eligibleAccounts = accounts.filter((account) => account.platform === listing.platform && account.status === "active");
  const [accountId, setAccountId] = useState(eligibleAccounts[0]?.id ?? "");
  const selectedAccount = eligibleAccounts.find((account) => account.id === accountId) ?? eligibleAccounts[0];
  const [marketplaceId, setMarketplaceId] = useState(selectedAccount?.marketplaceIds[0] ?? "");
  const [state, action] = useActionState(
    createMarketplacePublication.bind(null, listing.id, listing.versionId, listing.platform),
    initialState,
  );
  const hasRunningRequest = publications.some((publication) => !terminalStatuses.has(publication.current.status));

  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);

  useEffect(() => {
    if (!hasRunningRequest) return;
    const timer = window.setInterval(() => router.refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [hasRunningRequest, router]);

  const lockedReason = listing.status !== "approved"
    ? "当前 Listing 版本尚未审批。"
    : listing.validationBlockers > 0
      ? "当前 Listing 仍有阻断项。"
      : eligibleAccounts.length === 0
        ? "没有健康且已同步能力的同平台店铺。"
        : undefined;

  return (
    <section className="publication-panel" aria-labelledby="publication-title">
      <header className="publication-panel-header">
        <div><p className="section-code">MARKETPLACE EXECUTION</p><h2 id="publication-title">发布控制</h2></div>
        <button aria-label="刷新发布状态" className="publication-refresh" onClick={() => router.refresh()} title="刷新发布状态" type="button"><RefreshCw size={16} /></button>
      </header>

      <form action={action} className="publication-launch">
        <label>
          <span>目标店铺</span>
          <select
            disabled={Boolean(lockedReason)}
            name="accountId"
            onChange={(event) => {
              setAccountId(event.target.value);
              const next = eligibleAccounts.find((account) => account.id === event.target.value);
              setMarketplaceId(next?.marketplaceIds[0] ?? "");
            }}
            value={selectedAccount?.id ?? ""}
          >
            {eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
          </select>
        </label>
        <label>
          <span>Marketplace</span>
          <select disabled={Boolean(lockedReason)} name="marketplaceId" onChange={(event) => setMarketplaceId(event.target.value)} value={marketplaceId}>
            {(selectedAccount?.marketplaceIds ?? []).map((marketplace) => <option key={marketplace} value={marketplace}>{marketplace}</option>)}
          </select>
        </label>
        {listing.platform === "amazon" && (
          <label>
            <span>SKU</span>
            <select disabled={Boolean(lockedReason)} name="variantSkuId" required>
              {listing.variants.map((variant) => <option key={variant.skuId} value={variant.skuId}>{variant.skuCode}</option>)}
            </select>
          </label>
        )}
        <PublishSubmit disabled={Boolean(lockedReason)} platform={listing.platform} />
      </form>
      {(lockedReason || error) && <p className="publication-lock"><CircleAlert size={14} />{error ?? lockedReason}</p>}
      <ActionNotice state={state} />

      <div className="publication-ledger">
        <div className="publication-ledger-heading">
          <div><p className="section-code">IMMUTABLE REQUESTS</p><h3>发布记录</h3></div>
          <span>{publications.length} REQUESTS</span>
        </div>
        {publications.length === 0 ? (
          <div className="publication-empty"><Clock3 size={22} /><strong>暂无发布请求</strong><span>审批版本后从上方发起第一个平台动作。</span></div>
        ) : publications.map((publication) => (
          <PublicationRecord
            account={accounts.find((account) => account.id === publication.accountId)}
            key={publication.id}
            listingId={listing.id}
            publication={publication}
            hasChild={publications.some((candidate) => candidate.parentRequestId === publication.id)}
          />
        ))}
      </div>
    </section>
  );
}

function PublicationRecord({
  account,
  hasChild,
  listingId,
  publication,
}: {
  account?: MarketplaceAccountView;
  hasChild: boolean;
  listingId: string;
  publication: PublicationWorkspaceView;
}) {
  const canContinue = !hasChild && (
    (publication.action === "amazon_validation_preview" && publication.current.status === "validation_passed") ||
    (publication.action === "etsy_create_draft" && publication.current.status === "draft_created")
  );
  return (
    <article className="publication-record">
      <header>
        <div><span className={`publication-platform ${publication.platform}`}>{publication.platform === "amazon" ? "AMZ" : "ETSY"}</span><div><h4>{actionLabel(publication.action)}</h4><p>{account?.displayName ?? "未知店铺"} · {publication.marketplaceId}</p></div></div>
        <PublicationStatusBadge status={publication.current.status} />
      </header>
      <PublicationTrack publication={publication} />
      <dl className="publication-facts">
        <Fact label="请求 ID" value={publication.id.slice(0, 13)} />
        <Fact label="外部 Listing" value={publication.current.externalListingId ?? publication.sourceExternalListingId ?? "—"} />
        <Fact label="外部状态" value={publication.current.externalState ?? "—"} />
        <Fact label="提交时间" value={formatDate(publication.createdAt)} />
      </dl>
      <div className="publication-record-footer">
        <details>
          <summary>事件证据 · {publication.events.length}</summary>
          <ol className="publication-events">
            {publication.events.map((event) => (
              <li key={event.id}><span className={`event-dot ${event.status}`} /><time>{formatDate(event.occurredAt)}</time><strong>{statusLabel(event.status)}</strong><em>{event.code ?? event.externalState ?? "—"}</em></li>
            ))}
          </ol>
        </details>
        {canContinue && <ContinuePublication listingId={listingId} publication={publication} />}
      </div>
      {publication.current.message && <p className="publication-diagnostic"><CircleAlert size={14} />{publication.current.message}</p>}
    </article>
  );
}

function ContinuePublication({ listingId, publication }: { listingId: string; publication: PublicationWorkspaceView }) {
  const router = useRouter();
  const [state, action] = useActionState(
    continueMarketplacePublication.bind(null, listingId, publication.id),
    initialState,
  );
  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [router, state.status]);
  return (
    <form action={action} className="publication-continue">
      <ActionNotice state={state} />
      <ContinueSubmit platform={publication.platform} />
    </form>
  );
}

function PublicationTrack({ publication }: { publication: PublicationWorkspaceView }) {
  const steps = milestones(publication.action);
  const seen = new Set(publication.events.map((event) => event.status));
  const firstPending = steps.findIndex((step) => !step.statuses.some((status) => seen.has(status)));
  return (
    <ol className={`publication-track steps-${steps.length}`} aria-label={`${actionLabel(publication.action)}状态轨道`}>
      {steps.map((step, index) => {
        const done = step.statuses.some((status) => seen.has(status));
        return <li className={done ? "done" : index === firstPending ? "current" : "pending"} key={step.label}><span>{done ? <BadgeCheck size={14} /> : index + 1}</span><b>{step.label}</b></li>;
      })}
    </ol>
  );
}

function PublishSubmit({ disabled, platform }: { disabled: boolean; platform: "amazon" | "etsy" }) {
  const { pending } = useFormStatus();
  return <button disabled={disabled || pending} type="submit">{pending ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{platform === "amazon" ? "运行校验预览" : "创建 Etsy 草稿"}</button>;
}

function ContinueSubmit({ platform }: { platform: "amazon" | "etsy" }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{platform === "amazon" ? "提交到 Amazon" : "配置并激活"}</button>;
}

function PublicationStatusBadge({ status }: { status: MarketplacePublicationEventView["status"] }) {
  const failed = ["validation_failed", "publication_failed", "reconciliation_required", "failed"].includes(status);
  const completed = ["validation_passed", "draft_created", "published"].includes(status);
  const tone = status === "cancelled" ? "cancelled" : failed ? "failed" : completed ? "complete" : "running";
  return <span className={`publication-status ${tone}`}>{statusLabel(status)}</span>;
}

function ActionNotice({ state }: { state: MarketplaceActionState }) {
  if (state.status === "idle") return null;
  return <p className={`publication-action-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd title={value}>{value}</dd></div>;
}

function milestones(action: MarketplacePublicationRequestView["action"]): Array<{
  label: string;
  statuses: MarketplacePublicationEventView["status"][];
}> {
  if (action === "amazon_validation_preview") return [
    { label: "排队", statuses: ["scheduled", "queued"] }, { label: "校验", statuses: ["processing", "retry_pending"] }, { label: "结果", statuses: ["validation_passed", "validation_failed"] },
  ];
  if (action === "amazon_submit") return [
    { label: "排队", statuses: ["scheduled", "queued"] }, { label: "提交", statuses: ["submission_accepted"] }, { label: "同步", statuses: ["sync_pending"] }, { label: "发布", statuses: ["published"] },
  ];
  if (action === "etsy_create_draft") return [
    { label: "排队", statuses: ["scheduled", "queued"] }, { label: "创建", statuses: ["processing", "retry_pending"] }, { label: "草稿", statuses: ["draft_created"] },
  ];
  return [
    { label: "排队", statuses: ["scheduled", "queued"] }, { label: "配置", statuses: ["configuration_applied"] }, { label: "媒体", statuses: ["media_uploaded"] }, { label: "激活", statuses: ["activation_accepted"] }, { label: "发布", statuses: ["published"] },
  ];
}

function actionLabel(action: MarketplacePublicationRequestView["action"]): string {
  return ({ amazon_submit: "Amazon 正式提交", amazon_validation_preview: "Amazon 校验预览", etsy_activate: "Etsy 配置与激活", etsy_create_draft: "Etsy 草稿创建" })[action];
}

function statusLabel(status: MarketplacePublicationEventView["status"]): string {
  return ({
    activation_accepted: "已接受激活", configuration_applied: "配置已写入", deactivated: "已下架", draft_created: "草稿已创建",
    failed: "失败", media_uploaded: "媒体已上传", processing: "处理中", publication_failed: "发布失败", published: "已发布",
    cancelled: "已取消", queued: "已排队", reconciliation_required: "需要对账", retry_pending: "等待重试", scheduled: "已计划", submission_accepted: "提交已接受",
    sync_pending: "等待同步", validation_failed: "校验未通过", validation_passed: "校验通过",
  })[status];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
