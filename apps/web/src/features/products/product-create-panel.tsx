"use client";

import { BadgeCheck, CircleAlert, FileSearch2, LoaderCircle, Plus } from "lucide-react";
import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";

import { createProductPlan, type ProductCreateState } from "./product-actions";

const initialState: ProductCreateState = { message: "", status: "idle" };

export function ProductCreatePanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [state, action] = useActionState(createProductPlan, initialState);

  useEffect(() => {
    if (!state.planId) return;
    window.location.assign(`/products?plan=${encodeURIComponent(state.planId)}#product-detail`);
  }, [state.planId]);

  return (
    <details className="product-create-panel" open={defaultOpen || state.status === "error"}>
      <summary>
        <Plus aria-hidden="true" size={16} />
        新增产品
        <span>创建为“研究中”企划</span>
      </summary>
      <form action={action} className="product-create-form">
        <div className="product-create-fields">
          <label>
            <span>产品名称 *</span>
            <input
              aria-describedby={state.fieldErrors?.name ? "product-name-error" : undefined}
              aria-invalid={Boolean(state.fieldErrors?.name)}
              maxLength={200}
              name="name"
              placeholder="例如：定制姓名抱枕"
              required
            />
            {state.fieldErrors?.name ? <small id="product-name-error">{state.fieldErrors.name}</small> : null}
          </label>
          <label className="product-create-description">
            <span>产品描述</span>
            <textarea
              aria-describedby={state.fieldErrors?.description ? "product-description-error" : undefined}
              aria-invalid={Boolean(state.fieldErrors?.description)}
              maxLength={4000}
              name="description"
              placeholder="记录目标人群、使用场景和差异化方向"
              rows={3}
            />
            {state.fieldErrors?.description ? <small id="product-description-error">{state.fieldErrors.description}</small> : null}
          </label>
          <fieldset className="product-create-cost">
            <legend>目标成本</legend>
            <label>
              <span>金额</span>
              <input
                aria-describedby={state.fieldErrors?.targetCost ? "product-cost-error" : undefined}
                aria-invalid={Boolean(state.fieldErrors?.targetCost)}
                inputMode="decimal"
                min="0"
                name="targetCostAmount"
                placeholder="0.00"
                step="0.01"
                type="number"
              />
            </label>
            <label>
              <span>币种</span>
              <select defaultValue="USD" name="targetCostCurrency">
                <option value="USD">USD</option>
                <option value="CNY">CNY</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </label>
            {state.fieldErrors?.targetCost ? <small id="product-cost-error">{state.fieldErrors.targetCost}</small> : null}
          </fieldset>
          <label className="product-create-reports">
            <span>关联研究报告 ID</span>
            <textarea
              aria-describedby="product-report-help"
              aria-invalid={Boolean(state.fieldErrors?.sourceReportIds)}
              name="sourceReportIds"
              placeholder="每行填写一个已审批研究报告 UUID"
              rows={3}
            />
            <small id="product-report-help">
              {state.fieldErrors?.sourceReportIds ?? "可以稍后关联；进入已立项前必须至少有一份已审批报告。"}
            </small>
          </label>
        </div>
        <footer className="product-create-footer">
          <p>
            <FileSearch2 aria-hidden="true" size={15} />
            竞品证据仅作为研究来源，不会复制到可发布资产。
          </p>
          <ActionNotice state={state} />
          <CreateButton />
        </footer>
      </form>
    </details>
  );
}

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} type="submit">
      {pending ? <LoaderCircle aria-hidden="true" className="spin" size={15} /> : <Plus aria-hidden="true" size={15} />}
      {pending ? "正在创建" : "创建产品企划"}
    </button>
  );
}

function ActionNotice({ state }: { state: ProductCreateState }) {
  if (state.status === "idle") return null;
  return (
    <p className={`product-create-notice ${state.status}`} role="status">
      {state.status === "success" ? <BadgeCheck aria-hidden="true" size={14} /> : <CircleAlert aria-hidden="true" size={14} />}
      {state.message}
    </p>
  );
}
