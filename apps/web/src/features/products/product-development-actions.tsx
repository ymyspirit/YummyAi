"use client";

import { BadgeCheck, CircleAlert, FileCheck2, LoaderCircle, PackagePlus, Plus } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";

import {
  createProductSku,
  createProductSpu,
  transitionProductPlan,
  type ProductDevelopmentState,
} from "./product-actions";
import type { ProductPlanView } from "./product-editor";

const initialState: ProductDevelopmentState = { message: "", status: "idle" };

export function ProductDevelopmentActions({ plan }: { plan: ProductPlanView }) {
  if (!["researching", "pending_approval", "approved", "developing"].includes(plan.status)) return null;
  return (
    <section className="product-next-step" aria-labelledby="product-next-step-title">
      <header>
        <div><p className="section-code">NEXT CONTROLLED STEP</p><h2 id="product-next-step-title">推进产品开发</h2></div>
        <span>{nextStepLabel(plan)}</span>
      </header>
      {plan.status === "researching" ? <TransitionForm planId={plan.id} status="pending_approval" label="提交立项审核" /> : null}
      {plan.status === "pending_approval" ? (
        plan.sourceReportIds.length
          ? <TransitionForm planId={plan.id} status="approved" label="批准产品立项" />
          : <p className="product-gate-message"><CircleAlert size={15} />先关联至少一份真实分析报告，不能用研究条目 ID 代替报告 ID。</p>
      ) : null}
      {plan.status === "approved" && !plan.spu ? <SpuForm plan={plan} /> : null}
      {plan.status === "developing" && plan.spu ? <SkuForm plan={plan} /> : null}
      {plan.spu?.skus.length ? <Link className="product-design-link" href={`/design?sku=${encodeURIComponent(plan.spu.skus[0]!.id)}`}><PackagePlus size={15} />为 SKU 创建设计任务</Link> : null}
    </section>
  );
}

function TransitionForm({ label, planId, status }: { label: string; planId: string; status: "pending_approval" | "approved" }) {
  const [state, action] = useActionState(transitionProductPlan.bind(null, planId, status), initialState);
  useRefreshOnSuccess(state);
  return <form action={action} className="product-development-form compact"><p>{status === "approved" ? "批准会记录当前成员和时间，之后才能创建 SPU。" : "提交后进入人工立项审核，仍可退回研究中。"}</p><Notice state={state} /><SubmitButton icon={FileCheck2}>{label}</SubmitButton></form>;
}

function SpuForm({ plan }: { plan: ProductPlanView }) {
  const [state, action] = useActionState(createProductSpu.bind(null, plan.id), initialState);
  useRefreshOnSuccess(state);
  return <form action={action} className="product-development-form"><label><span>SPU 编码</span><input defaultValue={suggestCode(plan.name)} maxLength={80} name="code" required /></label><label><span>SPU 名称</span><input defaultValue={plan.name} maxLength={200} name="name" required /></label><Notice state={state} /><SubmitButton icon={PackagePlus}>创建 SPU</SubmitButton></form>;
}

function SkuForm({ plan }: { plan: ProductPlanView }) {
  const [state, action] = useActionState(createProductSku.bind(null, plan.id, plan.spu!.id), initialState);
  useRefreshOnSuccess(state);
  return <form action={action} className="product-development-form sku"><label><span>SKU 编码</span><input defaultValue={`${plan.spu!.code}-STD`} maxLength={100} name="code" required /></label><label><span>属性</span><input name="attributes" placeholder="size: 16x16, color: natural" /></label><label><span>单位成本</span><input min="0" name="unitCostAmount" placeholder="0.00" step="0.01" type="number" /></label><label><span>币种</span><select defaultValue={plan.targetCost?.currency ?? "USD"} name="unitCostCurrency"><option>USD</option><option>CNY</option><option>EUR</option><option>GBP</option></select></label><Notice state={state} /><SubmitButton icon={Plus}>创建 SKU</SubmitButton></form>;
}

function SubmitButton({ children, icon: Icon }: { children: React.ReactNode; icon: typeof Plus }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Icon size={15} />}{children}</button>;
}

function Notice({ state }: { state: ProductDevelopmentState }) {
  if (state.status === "idle") return null;
  return <p className={`product-development-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>;
}

function useRefreshOnSuccess(state: ProductDevelopmentState) {
  useEffect(() => { if (state.status === "success") window.location.reload(); }, [state.status]);
}

function suggestCode(name: string) {
  return name.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).toUpperCase() || "PRODUCT-SPU";
}

function nextStepLabel(plan: ProductPlanView) {
  if (plan.spu?.skus.length) return "DESIGN TASK";
  if (plan.spu) return "CREATE SKU";
  if (plan.status === "approved") return "CREATE SPU";
  if (plan.status === "pending_approval") return "APPROVAL";
  return "SUBMIT REVIEW";
}
