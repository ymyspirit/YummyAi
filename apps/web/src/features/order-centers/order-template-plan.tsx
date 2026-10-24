"use client";
import { useState } from "react";
import {
  OrderTemplatePlanSchema,
  type OrderTemplatePlan,
} from "@yummyai/contracts/order/workspace";

export function OrderTemplatePlanPanel({
  id,
  revision,
  sourceVersionId,
  disabled,
}: {
  id: string;
  revision: number;
  sourceVersionId: string | null;
  disabled: boolean;
}) {
  const [plan, setPlan] = useState<OrderTemplatePlan | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const stale =
    disabled || plan?.revision !== revision || plan?.sourceVersionId !== sourceVersionId;
  async function check() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/order-centers/lines/${id}/template-plan`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "模板检查失败");
      setPlan(OrderTemplatePlanSchema.parse(data));
    } catch (cause) {
      setPlan(null);
      setError(cause instanceof Error ? cause.message : "模板检查失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ai-assist" aria-label="模板制图条件">
      <div className="ai-assist-heading">
        <h3>模板制图条件</h3>
        <button type="button" disabled={disabled || busy} onClick={() => void check()}>
          {busy ? "正在检查…" : "检查模板制图条件"}
        </button>
      </div>
      <p>
        绑定印花与产品规格、保存需求后检查。选择模板自动制图并确认推送，即按本单固定版本生成可编辑的生产稿。
      </p>
      {disabled && <p>请先保存当前改动并等待操作完成。</p>}
      {error && <p role="alert">{error}</p>}
      {plan &&
        (stale ? (
          <p role="status">需求已变化，请重新检查模板条件。</p>
        ) : (
          <>
            <strong role="status">
              {plan.ready ? "模板条件通过，等待确认推送" : "暂不能自动制图"}
            </strong>
            {!!plan.blockers.length && (
              <ul className="ai-assist-warning">
                {plan.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}
            <dl className="oc-template-versions">
              <dt>需求版本</dt>
              <dd>V{plan.revision}</dd>
              <dt>印花版本</dt>
              <dd>{plan.artworkVersionId ?? "未绑定"}</dd>
              <dt>产品规格版本</dt>
              <dd>{plan.specificationVersionId ?? "未绑定"}</dd>
              <dt>生产模板版本</dt>
              <dd>{plan.templateVersionId ?? "未绑定"}</dd>
            </dl>
            {plan.mappings.map((m) => (
              <div className="ai-assist-matches" key={m.fieldKey}>
                <strong>
                  {m.label} · {m.fieldKey}
                </strong>
                <p style={{ whiteSpace: "pre-wrap" }}>{m.value || "未填写"}</p>
                <small>定制区域：{m.region ?? "尚未配置"}</small>
              </div>
            ))}
            <ul>
              {plan.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </>
        ))}
    </section>
  );
}
