"use client";

import type { MarketplaceAccountView, MarketplacePublicationBatchView } from "@yummyai/contracts";
import {
  Ban,
  CalendarClock,
  Check,
  CircleAlert,
  Layers3,
  LoaderCircle,
  Play,
  RefreshCw,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  cancelMarketplacePublicationBatch,
  continueMarketplacePublicationBatch,
  createMarketplacePublicationBatch,
  type MarketplaceActionState,
} from "./marketplace-actions";

export interface PublicationBatchCandidate {
  id: string;
  listingId: string;
  listingVersionId: string;
  platform: "amazon" | "etsy";
  skuCode?: string;
  spuCode: string;
  title: string;
  variantSkuId?: string;
  versionNumber: number;
}

const initialState: MarketplaceActionState = { message: "", status: "idle" };
const pollingStatuses = new Set(["queued", "processing"]);

export function PublicationBatchWorkspace({
  accounts,
  batches,
  candidates,
  error,
}: {
  accounts: MarketplaceAccountView[];
  batches: MarketplacePublicationBatchView[];
  candidates: PublicationBatchCandidate[];
  error?: string;
}) {
  const router = useRouter();
  const eligibleAccounts = useMemo(() => accounts.filter((account) =>
    account.status === "active" &&
    account.healthStatus === "healthy" &&
    ["valid", "expiring"].includes(account.credentialStatus) &&
    account.capabilities.includes("listing_write") &&
    candidates.some((candidate) => candidate.platform === account.platform),
  ), [accounts, candidates]);
  const [accountId, setAccountId] = useState(eligibleAccounts[0]?.id ?? "");
  const selectedAccount = eligibleAccounts.find((account) => account.id === accountId) ?? eligibleAccounts[0];
  const [marketplaceId, setMarketplaceId] = useState(selectedAccount?.marketplaceIds[0] ?? "");
  const [scheduledFor, setScheduledFor] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [state, action] = useActionState(createMarketplacePublicationBatch, initialState);
  const visibleCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.platform === selectedAccount?.platform),
    [candidates, selectedAccount?.platform],
  );

  useEffect(() => {
    if (state.status !== "success") return;
    setSelected(new Set());
    router.refresh();
  }, [router, state.status]);

  useEffect(() => {
    if (!batches.some((batch) => pollingStatuses.has(batch.status))) return;
    const timer = window.setInterval(() => router.refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [batches, router]);

  const lockedReason = eligibleAccounts.length === 0
    ? "没有健康且具备 listing_write 权限的店铺。"
    : visibleCandidates.length < 2
      ? "同一平台至少需要 2 个已审批发布目标。"
      : undefined;

  return (
    <section className="batch-workspace" aria-labelledby="batch-workspace-title">
      <header className="batch-workspace-header">
        <div>
          <p className="section-code">BATCH EXECUTION</p>
          <h2 id="batch-workspace-title">批量发布</h2>
          <p>一次固定 2–100 个审批版本，预检通过后再进入平台发布。</p>
        </div>
        <button aria-label="刷新批次状态" onClick={() => router.refresh()} title="刷新批次状态" type="button">
          <RefreshCw size={16} />
        </button>
      </header>

      <form action={action} className="batch-launch">
        <div className="batch-controls">
          <label>
            <span>目标店铺</span>
            <select
              disabled={Boolean(lockedReason)}
              name="accountId"
              onChange={(event) => {
                const next = eligibleAccounts.find((account) => account.id === event.target.value);
                setAccountId(event.target.value);
                setMarketplaceId(next?.marketplaceIds[0] ?? "");
                setSelected(new Set());
              }}
              value={selectedAccount?.id ?? ""}
            >
              {eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName} · {platformLabel(account.platform)}</option>)}
            </select>
          </label>
          <label>
            <span>Marketplace</span>
            <select disabled={Boolean(lockedReason)} name="marketplaceId" onChange={(event) => setMarketplaceId(event.target.value)} value={marketplaceId}>
              {(selectedAccount?.marketplaceIds ?? []).map((marketplace) => <option key={marketplace} value={marketplace}>{marketplace}</option>)}
            </select>
          </label>
          <label>
            <span>计划时间（可选）</span>
            <input
              disabled={Boolean(lockedReason)}
              onInput={(event) => setScheduledFor(event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : "")}
              type="datetime-local"
            />
            <input name="scheduledFor" type="hidden" value={scheduledFor} />
          </label>
          <div className="batch-selection-count" aria-live="polite">
            <Layers3 size={17} />
            <span>已选择</span>
            <strong>{selected.size}</strong>
            <b>/ 100</b>
          </div>
        </div>

        <div className="batch-candidate-list" aria-label="可批量发布目标">
          <div className="batch-candidate-heading">
            <span>选择</span><span>审批版本</span><span>发布目标</span><span>平台</span>
          </div>
          {visibleCandidates.map((candidate) => {
            const checked = selected.has(candidate.id);
            return (
              <label className={`batch-candidate ${checked ? "selected" : ""}`} key={candidate.id}>
                <input
                  checked={checked}
                  disabled={Boolean(lockedReason) || (!checked && selected.size >= 100)}
                  name="selectedItems"
                  onChange={(event) => setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(candidate.id);
                    else next.delete(candidate.id);
                    return next;
                  })}
                  type="checkbox"
                  value={JSON.stringify({
                    listingId: candidate.listingId,
                    listingVersionId: candidate.listingVersionId,
                    ...(candidate.variantSkuId ? { variantSkuId: candidate.variantSkuId } : {}),
                  })}
                />
                <span className="batch-check" aria-hidden="true">{checked ? <Check size={14} /> : null}</span>
                <span className="batch-candidate-version"><strong>{candidate.spuCode}</strong><code>V{candidate.versionNumber} · {candidate.listingId.slice(0, 12)}</code></span>
                <span className="batch-candidate-target"><strong>{candidate.skuCode ?? candidate.title}</strong><small>{candidate.title}</small></span>
                <span className={`publication-platform ${candidate.platform}`}>{platformLabel(candidate.platform)}</span>
              </label>
            );
          })}
          {visibleCandidates.length === 0 ? <BatchEmpty message="当前店铺没有可组批的审批版本。" /> : null}
        </div>

        <footer className="batch-launch-footer">
          <div>
            {lockedReason ? <InlineNotice message={lockedReason} status="error" /> : null}
            {error ? <InlineNotice message={error} status="error" /> : null}
            <ActionNotice state={state} />
          </div>
          <BatchCreateSubmit disabled={Boolean(lockedReason) || selected.size < 2} scheduled={Boolean(scheduledFor)} />
        </footer>
      </form>

      <div className="batch-ledger">
        <header>
          <div><p className="section-code">IMMUTABLE BATCHES</p><h3>批次记录</h3></div>
          <span>{batches.length} BATCHES</span>
        </header>
        {batches.length === 0
          ? <BatchEmpty message="尚无批量发布；从上方选择至少两个发布目标。" />
          : batches.map((batch) => <BatchRecord batches={batches} batch={batch} key={batch.id} />)}
      </div>
    </section>
  );
}

function BatchRecord({ batch, batches }: { batch: MarketplacePublicationBatchView; batches: MarketplacePublicationBatchView[] }) {
  const accountContinuationExists = batches.some((candidate) => candidate.parentBatchId === batch.id);
  const canContinue = batch.action === "initial" && batch.status === "ready_to_continue" && !accountContinuationExists;
  const canCancel = batch.status === "queued" || batch.status === "scheduled";
  return (
    <article className="batch-record">
      <header>
        <div className="batch-record-identity">
          <span className={`publication-platform ${batch.platform}`}>{platformLabel(batch.platform)}</span>
          <div><h4>{batch.action === "initial" ? "批量预检 / 草稿" : "批量发布"}</h4><p>{batch.marketplaceId} · {batch.id.slice(0, 13)}</p></div>
        </div>
        <BatchStatus status={batch.status} />
      </header>
      <dl className="batch-count-strip">
        <BatchCount label="总数" value={batch.counts.total} />
        <BatchCount label="等待" value={batch.counts.waiting} />
        <BatchCount label="成功" value={batch.counts.succeeded} />
        <BatchCount label="失败" value={batch.counts.failed} />
        <BatchCount label="需对账" value={batch.counts.reconciliationRequired} />
        <BatchCount label="已取消" value={batch.counts.cancelled} />
      </dl>
      <div className="batch-item-list">
        {batch.items.map((item) => (
          <div className="batch-item" key={item.id}>
            <span className={`batch-item-state ${statusTone(item.current.status)}`} />
            <div><strong>{item.targetLabel ?? item.listingId.slice(0, 13)}</strong><small>{item.listingId.slice(0, 13)} · {actionLabel(item.action)}</small></div>
            <code>{item.current.externalState ?? item.current.status}</code>
            <span>{item.current.message ?? formatDate(item.createdAt)}</span>
          </div>
        ))}
      </div>
      <footer>
        <span><CalendarClock size={14} />{batch.scheduledFor ? `计划 ${formatDate(batch.scheduledFor)}` : `创建 ${formatDate(batch.createdAt)}`}</span>
        <div>
          {canContinue ? <ContinueBatch batch={batch} /> : null}
          {canCancel ? <CancelBatch batch={batch} /> : null}
        </div>
      </footer>
    </article>
  );
}

function ContinueBatch({ batch }: { batch: MarketplacePublicationBatchView }) {
  const [state, action] = useActionState(continueMarketplacePublicationBatch.bind(null, batch.id), initialState);
  const router = useRouter();
  useEffect(() => { if (state.status === "success") router.refresh(); }, [router, state.status]);
  return <form action={action} className="batch-inline-action"><ActionNotice state={state} /><BatchContinueSubmit platform={batch.platform} /></form>;
}

function CancelBatch({ batch }: { batch: MarketplacePublicationBatchView }) {
  const [state, action] = useActionState(cancelMarketplacePublicationBatch.bind(null, batch.id), initialState);
  const router = useRouter();
  useEffect(() => { if (state.status === "success") router.refresh(); }, [router, state.status]);
  return (
    <form action={action} className="batch-inline-action batch-cancel-action">
      <ActionNotice state={state} />
      <input aria-label="取消原因" defaultValue="运营计划调整" name="reason" required />
      <BatchCancelSubmit />
    </form>
  );
}

function BatchCreateSubmit({ disabled, scheduled }: { disabled: boolean; scheduled: boolean }) {
  const { pending } = useFormStatus();
  return <button disabled={disabled || pending} type="submit">{pending ? <LoaderCircle className="spin" size={16} /> : scheduled ? <CalendarClock size={16} /> : <Play size={16} />}{pending ? "正在创建" : scheduled ? "计划批次" : "创建批次"}</button>;
}

function BatchContinueSubmit({ platform }: { platform: "amazon" | "etsy" }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{pending ? "正在排队" : platform === "amazon" ? "提交 JSON Feed" : "激活 Etsy 刊登"}</button>;
}

function BatchCancelSubmit() {
  const { pending } = useFormStatus();
  return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Ban size={15} />}{pending ? "正在取消" : "取消批次"}</button>;
}

function BatchCount({ label, value }: { label: string; value: number }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function BatchStatus({ status }: { status: MarketplacePublicationBatchView["status"] }) {
  return <span className={`batch-status ${statusTone(status)}`}>{batchStatusLabel(status)}</span>;
}

function ActionNotice({ state }: { state: MarketplaceActionState }) {
  return state.status === "idle" ? null : <InlineNotice message={state.message} status={state.status} />;
}

function InlineNotice({ message, status }: { message: string; status: "success" | "error" }) {
  return <p className={`batch-notice ${status}`} role="status">{status === "error" ? <CircleAlert size={14} /> : <Check size={14} />}{message}</p>;
}

function BatchEmpty({ message }: { message: string }) {
  return <div className="batch-empty"><Layers3 size={23} /><strong>{message}</strong></div>;
}

function statusTone(status: string): "complete" | "failed" | "running" | "neutral" {
  if (["completed", "ready_to_continue", "published", "validation_passed", "draft_created"].includes(status)) return "complete";
  if (["failed", "partial", "reconciliation_required", "publication_failed", "validation_failed"].includes(status)) return "failed";
  if (["queued", "scheduled", "processing", "retry_pending", "sync_pending", "submission_accepted"].includes(status)) return "running";
  return "neutral";
}

function batchStatusLabel(status: MarketplacePublicationBatchView["status"]): string {
  return ({
    cancelled: "已取消",
    completed: "已完成",
    failed: "失败",
    partial: "部分失败",
    processing: "处理中",
    queued: "已排队",
    ready_to_continue: "可继续",
    reconciliation_required: "需要对账",
    scheduled: "已计划",
  })[status];
}

function actionLabel(action: MarketplacePublicationBatchView["items"][number]["action"]): string {
  return ({
    amazon_feed_submit: "JSON Feed",
    amazon_submit: "Amazon 提交",
    amazon_validation_preview: "Amazon 预检",
    etsy_activate: "Etsy 激活",
    etsy_create_draft: "Etsy 草稿",
  })[action];
}

function platformLabel(platform: "amazon" | "etsy"): string {
  return platform === "amazon" ? "AMZ" : "ETSY";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
