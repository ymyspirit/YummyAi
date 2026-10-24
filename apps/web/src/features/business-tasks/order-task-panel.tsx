"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import {
  OrderTaskViewSchema,
  type OrderTaskView,
} from "@yummyai/contracts/operations/business-task";
import { centerRequest } from "../order-centers/order-center-model";
import { BusinessTaskPanel, businessTaskLabels } from "./business-task-panel";
import { OrderLineResponsibilityPanel } from "./order-line-responsibility-panel";

export function OrderTaskPanel({
  lineId,
  refreshToken = 0,
  disabled = false,
  onChanged,
  onBusyChange,
  expanded = false,
}: {
  lineId: string;
  refreshToken?: number;
  disabled?: boolean;
  onChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
  expanded?: boolean;
}) {
  const [view, setView] = useState<OrderTaskView | null>(null),
    [open, setOpen] = useState(expanded),
    [loaded, setLoaded] = useState(expanded);
  const [loading, setLoading] = useState(false),
    [preparing, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0);
  const [responsibilityBusy, setResponsibilityBusy] = useState(false),
    busy = preparing || responsibilityBusy;
  const generation = useRef(0),
    currentLine = useRef(lineId);
  currentLine.current = lineId;
  const readState = useRef({ open, disabled, busy });
  readState.current = { open, disabled, busy };
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    setNotice("");
  }, [lineId]);
  useEffect(() => {
    const token = ++generation.current,
      abort = new AbortController();
    setView(null);
    setError("");
    if (!loaded) return () => abort.abort();
    let reading = false;
    const read = async () => {
      if (reading || document.visibilityState !== "visible") return;
      reading = true;
      setLoading(true);
      try {
        const next = OrderTaskViewSchema.parse(
          await centerRequest(`lines/${lineId}/task`, undefined, abort.signal),
        );
        if (!abort.signal.aborted && generation.current === token) {
          setView(next);
          setError("");
        }
      } catch {
        if (!abort.signal.aborted) {
          setView(null);
          setError("订单任务暂时无法读取，请重试。未读取的环节不会视为完成。");
        }
      } finally {
        reading = false;
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    void read();
    const poll = () => {
      const state = readState.current;
      if (state.open && !state.disabled && !state.busy) void read();
    };
    const timer = setInterval(poll, 30000);
    window.addEventListener("focus", poll);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener("focus", poll);
    };
  }, [lineId, loaded, refreshToken, reload]);

  async function prepare(group: OrderTaskView["groups"][number]) {
    if (busy || disabled || error || loading) return;
    const sourceLine = lineId;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const result = OrderTaskViewSchema.parse(
        await centerRequest(`lines/${lineId}/task/prepare-delivery`, {
          groupId: group.id,
          expectedFingerprint: group.fingerprint,
        }),
      );
      if (currentLine.current !== sourceLine) return;
      setView(result);
      setNotice("当前工厂交付包已准备，可打开原交付包上传并登记真实回执");
      onChanged?.();
    } catch (cause) {
      if (currentLine.current === sourceLine)
        setError(
          cause instanceof Error ? cause.message : "结果暂未确认，请重新读取本单任务核对交付包",
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="order-task-panel"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) setLoaded(true);
      }}
    >
      <summary>本单任务与执行依据{view ? ` / ${businessTaskLabels[view.task.state]}` : ""}</summary>
      <div className="order-task-toolbar">
        <span>审单 → 制作 → 工厂交付 → 实际发货</span>
        <button
          className="oc-button"
          disabled={busy || loading}
          onClick={() => setReload((value) => value + 1)}
          aria-label="刷新本单任务"
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      {error && (
        <p className="oc-error" role="alert">
          {error}
          <button
            className="oc-button"
            disabled={busy || disabled}
            onClick={() => setReload((value) => value + 1)}
          >
            重新读取本单任务
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="oc-notice">
          {notice}
        </p>
      )}
      {loading && !view && (
        <div role="status" className="order-task-loading">
          正在核对固定版本、制作结果与工厂任务…
        </div>
      )}
      {view && (
        <>
          <OrderLineResponsibilityPanel
            key={lineId}
            lineId={lineId}
            disabled={disabled || preparing}
            onBusyChange={setResponsibilityBusy}
          />
          <BusinessTaskPanel task={view.task} disabled={disabled || busy || !!error} />
          {view.groups.map((group) => (
            <section
              className="business-task-group"
              key={group.id}
              aria-label={`${group.label} 交付准备`}
            >
              <header>
                <strong>
                  {group.label} / {group.quantity} 件
                </strong>
                {group.package ? (
                  disabled || busy ? (
                    <span>当前操作完成后可打开交付包</span>
                  ) : (
                    <Link href={group.package.href}>打开当前交付包</Link>
                  )
                ) : (
                  <button
                    className="oc-button primary"
                    disabled={disabled || busy || loading || !!error || !group.canPrepare}
                    onClick={() => void prepare(group)}
                  >
                    {busy ? "正在准备" : "准备该工厂交付包"}
                  </button>
                )}
              </header>
              {group.blockers.map((blocker, index) => (
                <p key={index}>{blocker}</p>
              ))}
            </section>
          ))}
        </>
      )}
    </details>
  );
}
