"use client";

import { BadgeCheck, CircleAlert, FileSearch2, LoaderCircle, Plus } from "lucide-react";
import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";

import { createDesignTask, type DesignActionState } from "./design-actions";

export interface DesignSkuOption { id: string; code: string; productName: string; }
export interface DesignResearchSample { id: string; shopName?: string | null; title: string; }

const initialState: DesignActionState = { message: "", status: "idle" };

export function DesignCreatePanel({ initialSkuId, researchSample, skus }: { initialSkuId?: string; researchSample?: DesignResearchSample; skus: DesignSkuOption[] }) {
  const [state, action] = useActionState(createDesignTask, initialState);
  useEffect(() => { if (state.taskId) window.location.assign(`/design?task=${encodeURIComponent(state.taskId)}`); }, [state.taskId]);
  const sampleTitle = researchSample ? `${shortTitle(researchSample.title)} · 原创图案与生产校样` : "";
  const sampleBrief = researchSample ? `研究来源：${researchSample.title}（${researchSample.shopName ?? "店铺未识别"}）。仅参考公开市场需求，不复制竞品图片或文案。请建立原创构图，明确印刷区域、出血、分辨率、颜色模式、字体授权、定制安全区及生产文件规格。研究条目 ID：${researchSample.id}` : "";
  return <details className="design-create-panel" open={!skus.length}><summary><Plus size={16} />创建设计任务<span>{skus.length} 个可用 SKU</span></summary><form action={action} className="design-create-form">
    {researchSample ? <aside className="design-research-trace"><FileSearch2 size={17} /><div><strong>当前研究样例</strong><span>{researchSample.title}</span><code>{researchSample.id}</code></div><b>RESEARCH ONLY</b></aside> : null}
    {skus.length ? <div className="design-create-fields"><label><span>关联 SKU *</span><select defaultValue={initialSkuId && skus.some((sku) => sku.id === initialSkuId) ? initialSkuId : skus[0]!.id} name="skuId">{skus.map((sku) => <option key={sku.id} value={sku.id}>{sku.code} · {sku.productName}</option>)}</select></label><label><span>截止时间</span><input name="dueAt" type="datetime-local" /></label><label className="design-task-title"><span>任务标题 *</span><input defaultValue={sampleTitle} maxLength={200} name="title" required /></label><label className="design-task-brief"><span>设计要求 *</span><textarea defaultValue={sampleBrief} maxLength={8000} name="brief" required rows={6} /></label></div> : <p className="design-create-blocked"><CircleAlert size={15} />还没有可用 SKU。请先在产品目录完成立项并创建 SPU/SKU。</p>}
    <footer><ActionNotice state={state} />{skus.length ? <SubmitButton /> : <a href="/products">返回产品开发</a>}</footer>
  </form></details>;
}

function SubmitButton() { const { pending } = useFormStatus(); return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{pending ? "正在创建" : "创建设计任务"}</button>; }
function ActionNotice({ state }: { state: DesignActionState }) { if (state.status === "idle") return null; return <p className={`design-action-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>; }
function shortTitle(value: string) { return value.length > 48 ? `${value.slice(0, 48)}…` : value; }
