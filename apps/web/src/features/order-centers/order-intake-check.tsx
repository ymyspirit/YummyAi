"use client";
import { useState } from "react";
import {
  OrderIntakeCheckViewSchema,
  type OrderIntakeCheck,
  type OrderWorkDetail,
  type OrderWorkDraft,
} from "@yummyai/contracts/order/workspace";
import { centerRequest, dateTime } from "./order-center-model";

const fieldStatus = {
  mapped: "已匹配",
  missing: "待补资料",
  conflict: "待确认",
  optional: "选填",
  inactive: "本单不适用",
};
export function OrderIntakeCheckPanel({
  detail,
  draft,
  disabled,
  editable,
  onChange,
}: {
  detail: OrderWorkDetail;
  draft: OrderWorkDraft;
  disabled: boolean;
  editable: boolean;
  onChange: (draft: OrderWorkDraft) => void;
}) {
  const [result, setResult] = useState<{ check: OrderIntakeCheck; input: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const input = JSON.stringify({
    expectedRevision: detail.line.revision,
    expectedSourceVersionId: detail.report?.versionId ?? null,
    draft,
  });
  const stale = !!result && (result.input !== input || disabled);
  async function check() {
    const checkedInput = input;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await centerRequest(
        `lines/${detail.line.id}/intake-check`,
        JSON.parse(checkedInput),
      );
      setResult({ check: OrderIntakeCheckViewSchema.parse(data), input: checkedInput });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "承接核对失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  const data = !stale ? result?.check : null;
  return (
    <section className="oc-section oc-intake" aria-label="定制订单承接核对">
      <div className="oc-section-heading">
        <strong>定制订单承接核对</strong>
        <button
          type="button"
          className="oc-button"
          disabled={disabled || busy}
          onClick={() => void check()}
        >
          {busy ? "正在核对…" : "核对当前需求"}
        </button>
      </div>
      <p className="oc-hint">
        核对封存配置、SKU 制作版本和买家字段。可先检查未保存的修改；保存审单和派单时服务端再次检查。
      </p>
      {error && <p role="alert">{error}</p>}
      {stale && <p role="status">需求或订单状态已变化，请重新核对。</p>}
      {data && (
        <>
          <p role="status" className="oc-hint">
            <strong>{data.ready ? "字段与版本核对通过" : "存在待补资料或待确认项"}</strong>
          </p>
          <p className="oc-hint">
            {data.basis === "sealed"
              ? `封存资料 V${data.package?.version} · 销售方案 V${data.package?.planRevision} · 核对时间 ${dateTime(data.package?.reviewedAt ?? "")}`
              : data.basis === "legacy_package"
                ? "历史资料包：缺少封存定制核对记录，按本单固定版本人工核对。"
                : data.basis === "manual"
                  ? "直接匹配制作依据：请人工核对平台实际配置。"
                  : "制作依据尚未匹配。"}
          </p>
          {!!data.issues.length && (
            <ul className="oc-intake-issues" aria-label="承接待办">
              {data.issues.map((issue, index) => (
                <li key={index}>
                  <strong>{issue.message}</strong>
                  <span>{issue.action}</span>
                </li>
              ))}
            </ul>
          )}
          {!!data.fields.length && (
            <div className="oc-intake-fields" aria-label="定制字段匹配">
              {data.fields.map((field) => (
                <div className="oc-intake-row" key={field.key}>
                  <span>
                    <strong>{field.label}</strong>
                    <small>
                      {field.required ? "本单必填" : "选填或条件字段"}
                      {field.type === "image" ? ` · 已选 ${field.imageCount} 张原图` : ""}
                    </small>
                  </span>
                  <span
                    className={`oc-badge ${field.status === "missing" || field.status === "conflict" ? "warning" : ""}`}
                  >
                    {fieldStatus[field.status]}
                  </span>
                </div>
              ))}
            </div>
          )}
          {editable && JSON.stringify(data.normalizedDraft) !== JSON.stringify(draft) && (
            <button
              type="button"
              className="oc-button"
              disabled={disabled || busy}
              onClick={() => onChange(data.normalizedDraft)}
            >
              应用唯一字段匹配
            </button>
          )}
          <ul className="oc-intake-notes">
            {data.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
          {data.package && (
            <details>
              <summary>查看本单固定版本引用</summary>
              <dl className="oc-template-versions">
                <dt>资料包</dt>
                <dd>{data.package.id}</dd>
                <dt>交付核对</dt>
                <dd>{data.package.reviewId ?? "历史记录缺失"}</dd>
                <dt>印花版本</dt>
                <dd>{draft.artworkVersionId ?? "未匹配"}</dd>
                <dt>规格版本</dt>
                <dd>{draft.specificationVersionId ?? "未匹配"}</dd>
              </dl>
            </details>
          )}
        </>
      )}
    </section>
  );
}
