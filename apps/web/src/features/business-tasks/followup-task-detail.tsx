"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import {
  FollowupDetailViewSchema,
  FollowupResponsibilityInputSchema,
  FollowupResponsibilityViewSchema,
  type FollowupSource,
} from "@yummyai/contracts/operations/followup";
import {
  ResponsibilityPanel,
  type ResponsibilitySaveInput,
} from "../responsibility/responsibility-panel";
import { BusinessTaskSourcePicker, type BusinessTaskSource } from "./business-task-source-picker";
import {
  followupNames,
  followupRequest,
  FollowupRequestError,
  followupStatus,
  followupContext,
} from "./followup-request";
import { label } from "../order-centers/order-center-model";
import { OrderExceptionPanel } from "../order-centers/order-exception-panel";
import type { OrderReviewState } from "../order-centers/order-work-detail";
const reasons = [
  { value: "initial_assignment", label: "首次安排" },
  { value: "handoff", label: "责任交接" },
  { value: "deadline_update", label: "调整内部截止" },
  { value: "correction", label: "纠正安排" },
];
export function FollowupTaskDetail({
  source,
  id,
  reload,
  onChangeSource,
  onBusyChange,
}: {
  source: FollowupSource;
  id: string;
  reload: number;
  onChangeSource(value: BusinessTaskSource): void;
  onBusyChange(busy: boolean): void;
}) {
  const params = useSearchParams(),
    back = new URLSearchParams(params.toString());
  back.delete("target");
  const [view, setView] = useState<ReturnType<typeof FollowupDetailViewSchema.parse>>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [editing, setEditing] = useState(false),
    [resuming, setResuming] = useState(false);
  const [operationsState, setOperationsState] = useState<OrderReviewState>({
      dirty: false,
      busy: false,
      loading: false,
    }),
    [operationsStamp, setOperationsStamp] = useState(0);
  const operationsChanged = useCallback(() => setOperationsStamp((value) => value + 1), []),
    operationsBusy = operationsState.dirty || operationsState.busy;
  const busy = editing || resuming || operationsBusy;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const read = useCallback(
    async (q: string, signal: AbortSignal) => {
      try {
        const value = FollowupDetailViewSchema.parse(
          await followupRequest(source, `${id}${q ? "?q=" + encodeURIComponent(q) : ""}`, signal),
        );
        if (!signal.aborted) {
          setView(value);
          setError("");
        }
        return value.responsibility;
      } catch (cause) {
        if (
          !signal.aborted &&
          cause instanceof FollowupRequestError &&
          [401, 403, 404].includes(cause.status)
        )
          setView(undefined);
        throw cause;
      }
    },
    [source, id],
  );
  const save = useCallback(
    async (input: ResponsibilitySaveInput) => {
      const value = FollowupResponsibilityViewSchema.parse(
        await followupRequest(
          source,
          `${id}/responsibility`,
          undefined,
          FollowupResponsibilityInputSchema.parse(input),
        ),
      );
      setView((current) => (current ? { ...current, responsibility: value } : current));
      return { status: "success" as const, message: "跟进安排已保存", data: value };
    },
    [source, id],
  );
  async function resume() {
    if (!view || busy) return;
    setResuming(true);
    setError("");
    setNotice("");
    const value = view.responsibility;
    try {
      const updated = FollowupResponsibilityViewSchema.parse(
        await followupRequest(source, `${id}/resume`, undefined, {
          expectedRevision: value.revision,
          expectedSourceChecksum: value.sourceChecksum,
          assignedUserId: value.assignedUserId,
          dueAt: value.dueAt,
          escalationUserId: value.escalationUserId,
          escalationDelayMinutes: value.escalationDelayMinutes,
          reason: "correction",
        }),
      );
      setView((current) => (current ? { ...current, responsibility: updated } : current));
      setNotice("已按当前业务依据重新启用提醒");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提醒未恢复 请载入最新记录");
    } finally {
      setResuming(false);
    }
  }
  const original =
    view?.item.source === "procurement_order"
      ? `/procurement?order=${id}`
      : view?.item.parentLineId
        ? `/${source === "after_sales_case" ? "after-sales" : "orders"}?line=${view.item.parentLineId}${source === "after_sales_case" ? "&case=" + id : "&exception=" + id}`
        : null;
  return (
    <section className="order-task-detail" aria-label={followupNames[source] + "任务详情"}>
      <div className="order-task-detail-heading">
        <Link
          className="wi-open"
          href={`/business-tasks?${back}`}
          aria-disabled={busy}
          onClick={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <ArrowLeft size={14} />
          返回业务待办
        </Link>
        <BusinessTaskSourcePicker value={source} disabled={busy} onChange={onChangeSource} />
      </div>
      {view && (
        <div className="business-followup-context">
          <h2>{view.item.title}</h2>
          <p>
            {view.item.label} · {label(followupContext(source, view.item.contextLabel))} ·{" "}
            {followupStatus(source, view.item.status)}
          </p>
          {!view.item.available && <p role="status">原业务资料不可用 请核对资料保留期与当前状态</p>}
          {original ? (
            <Link
              className="wi-open"
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
              href={`${original}&returnTo=${encodeURIComponent("/business-tasks?" + params)}`}
            >
              {source === "order_exception" ? "打开原订单处理异常" : "打开原业务继续处理"}
              <ArrowUpRight size={14} />
            </Link>
          ) : (
            <p>原订单商品入口缺失 请在订单中心核对</p>
          )}
          {view.responsibility.canResume && (
            <button className="wi-open" disabled={busy} onClick={() => void resume()}>
              <RefreshCw size={14} />
              按当前依据重新启用提醒
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {source === "order_exception" && view?.item.parentOrderId && view.item.available && (
        <OrderExceptionPanel
          key={view.item.parentOrderId}
          orderId={view.item.parentOrderId}
          focusId={id}
          refreshToken={reload}
          disabled={editing || resuming}
          onChanged={operationsChanged}
          onStateChange={setOperationsState}
        />
      )}
      <ResponsibilityPanel
        key={`${source}:${id}:${reload}:${resuming}:${operationsStamp}`}
        recordKey={`${source}:${id}`}
        revision={view?.responsibility.revision ?? 0}
        disabled={resuming || operationsBusy}
        read={read}
        save={save}
        onBusyChange={setEditing}
        reasonOptions={reasons}
        title={followupNames[source] + "安排"}
        drawerTitle={"安排" + followupNames[source]}
        regionLabel={followupNames[source] + "责任与时限"}
      />
    </section>
  );
}
