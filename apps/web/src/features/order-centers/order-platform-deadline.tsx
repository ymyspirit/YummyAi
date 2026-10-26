"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Clock3 } from "lucide-react";
import {
  OrderWorkDetailViewSchema,
  type OrderWorkDetail,
} from "@yummyai/contracts/order/workspace";
import { centerRequest, dateTime } from "./order-center-model";
import type { OrderReviewState } from "./order-work-detail";
import { orderPlatformShippingView } from "./order-auto-basis-model";
import { OrderDeadlineSummary } from "./order-deadline-summary";

export function OrderPlatformDeadline({
  detail,
  disabled,
  onChanged,
  onStateChange,
}: {
  detail: OrderWorkDetail;
  disabled: boolean;
  onChanged: (next: OrderWorkDetail) => void;
  onStateChange: (state: OrderReviewState) => void;
}) {
  const deadline = orderPlatformShippingView(detail.line, detail.shippingTime);
  const current = deadline.at;
  const [shipBy, setShipBy] = useState(localTime(current));
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const requests = useRef(new Map<string, string>());
  const dirty = shipBy !== localTime(current) || !!reference.trim();
  useEffect(() => {
    onStateChange({ dirty, busy, loading: false });
  }, [dirty, busy, onStateChange]);
  useEffect(() => {
    setShipBy(localTime(current));
    setReference("");
  }, [detail.line.id, current]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        expectedProjectionVersion: detail.line.projectionVersion,
        shipByAt: shipBy ? new Date(shipBy).toISOString() : null,
        evidenceReference: reference.trim(),
      };
      const signature = JSON.stringify(payload),
        key = requests.current.get(signature) ?? crypto.randomUUID();
      requests.current.set(signature, key);
      const next = OrderWorkDetailViewSchema.parse(
        await centerRequest(`lines/${detail.line.id}/platform-deadline`, {
          ...payload,
          idempotencyKey: key,
        }),
      );
      setReference("");
      onChanged(next);
      setNotice("平台交期核对已记录 本单制作需求仍需单独保存");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "平台交期未保存，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="oc-section oc-platform-deadline" aria-label="本单平台发货截止">
      <header className="oc-platform-heading"><Clock3 size={17} /><strong>平台最晚发货</strong><small>外部工厂履约依据</small></header>
      <OrderDeadlineSummary row={detail.line} shippingTime={detail.shippingTime} includeInternal={false} />
      <p className="oc-hint">以平台截止跟进工厂排产与发货 不按工厂状态或人工内部计划推算交期</p>
      {deadline.sourceLabel === "人工核对记录" && detail.line.platformDeadlineVerifiedAt && (
        <p className="oc-hint">人工核对时间 {dateTime(detail.line.platformDeadlineVerifiedAt)} 依据保存在本件操作记录中</p>
      )}
      {!current && <p className="oc-deadline-missing">尚未取得平台最晚发货时间 请核对原始未发货报告 平台同步或 Seller Central 原始记录</p>}
      {detail.line.sourceChanged && (
        <p className="oc-error">导入资料已更新，请重新核对平台交期。</p>
      )}
      <details className="oc-platform-editor">
        <summary>人工补录或更正平台截止{dirty && <small>有未保存修改</small>}</summary>
        <p className="oc-hint">请根据 Seller Central 原始记录填写并保留核对依据 不会自动填写未知时间</p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={disabled || busy || !!detail.line.archivedAt} className="oc-form-grid">
          <label>
            平台最晚发货时间
            <input
              type="datetime-local"
              value={shipBy}
              onChange={(event) => setShipBy(event.target.value)}
            />
          </label>
          <label>
            平台交期核对依据
            <input
              required
              maxLength={1000}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="例如：Seller Central 订单详情，核对日期和站点时区"
            />
          </label>
          <p>
            输入时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}
            。请先将站点显示时间换算到此时区 留空保存表示平台截止仍未知 不回退到旧日期
          </p>
          <button type="submit">{busy ? "保存中…" : "保存平台交期核对"}</button>
        </fieldset>
      </form>
      </details>
      {error && (
        <p className="oc-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
function localTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
