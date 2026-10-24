"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  OrderWorkDetailViewSchema,
  type OrderWorkDetail,
} from "@yummyai/contracts/order/workspace";
import { centerRequest, dateTime } from "./order-center-model";
import type { OrderReviewState } from "./order-work-detail";

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
  const current = detail.line.platformShipByAt ?? null;
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
      setNotice("平台交期核对已记录，制作需求和内部计划保持独立。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "平台交期未保存，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="oc-section oc-platform-deadline">
      <summary>
        平台发货截止：{current ? dateTime(current) : "待核对"}
        {current && " · 人工核对"}
      </summary>
      <p>
        请在 Seller Central
        核对本件商品的最晚发货时间。报告导入不会推算该日期；内部计划时间单独保留。
      </p>
      {detail.line.platformDeadlineVerifiedAt && (
        <p>
          最近核对：{dateTime(detail.line.platformDeadlineVerifiedAt)}。依据保存在本件操作记录中。
        </p>
      )}
      {detail.line.sourceChanged && (
        <p className="oc-error">导入资料已更新，请重新核对平台交期。</p>
      )}
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
            。请先将站点显示时间换算到此时区；留空表示交期仍未知。
          </p>
          <button type="submit">{busy ? "保存中…" : "保存平台交期核对"}</button>
        </fieldset>
      </form>
      {error && (
        <p className="oc-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
function localTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
