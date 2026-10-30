"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { AnalysisModelPricingSchema, type AnalysisModelPricing } from "@yummyai/contracts/ai/model-pricing-policy";
import type { OfficialApiPriceCatalog } from "@yummyai/contracts/ai/official-model-pricing";
import { ModelSettingsDialog } from "./model-settings-workbench-dialog";
import { officialTextRate, type ManagedModel } from "./model-settings-presentation";

type PricingDraft = { input: string; output: string; cap: string; limited: boolean };
const values = (model: ManagedModel): PricingDraft => ({ input: model.analysisPricing?.inputUsdPerMillion?.toString() ?? "", output: model.analysisPricing?.outputUsdPerMillion?.toString() ?? "", cap: model.analysisPricing?.maxTaskCostUsd?.toString() ?? "", limited: model.analysisPricing?.maxTaskCostUsd !== undefined && model.analysisPricing.maxTaskCostUsd !== null });
const nullableNumber = (value: string) => value.trim() ? Number(value) : null;

export function ModelSettingsPricingEditor({ model, currentModel, catalogue, busy, blocked, error, onClose, onDirty, onSave, onReconcile, onOpenRelated }: {
  model: ManagedModel; currentModel?: ManagedModel; catalogue?: OfficialApiPriceCatalog; busy: boolean; blocked: boolean; error: string;
  onClose: () => void; onDirty: (value: boolean) => void;
  onSave: (pricing: AnalysisModelPricing, revision: string) => Promise<boolean>; onReconcile: () => void; onOpenRelated: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => values(model)), [revision, setRevision] = useState(model.channel.revision);
  const original = useRef(values(model)), completed = useRef(false), dirty = JSON.stringify(draft) !== JSON.stringify(original.current);
  const official = officialTextRate(catalogue, model.name), inheritedFrom = currentModel?.analysisPricingInheritedFrom ?? model.analysisPricingInheritedFrom;
  const stale = !currentModel || currentModel.channel.revision !== revision;
  const parsed = useMemo(() => AnalysisModelPricingSchema.safeParse({ inputUsdPerMillion: nullableNumber(draft.input), outputUsdPerMillion: nullableNumber(draft.output), maxTaskCostUsd: draft.limited ? nullableNumber(draft.cap) : null }), [draft]);
  const incompleteLimit = draft.limited && (!draft.cap.trim() || !draft.input.trim() || !draft.output.trim());
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  return <ModelSettingsDialog title={`价格与费用策略 · ${model.label}`} description={`${model.channel.name} · ${model.name}`} busy={busy} onClose={onClose}
    onBeforeClose={() => completed.current || !dirty || window.confirm("有未保存的费用设置 确定放弃并关闭？")}>{close => <form onSubmit={async event => { event.preventDefault();
      if (!parsed.success || incompleteLimit || blocked || stale) return;
      if (await onSave(parsed.data, revision)) { completed.current = true; onDirty(false); close(); }
    }}><div className="ai-settings-dialog-body">
      <fieldset className="ai-settings-cost-policy"><legend>单次费用策略</legend>
        <label><input type="radio" name="model-cost-policy" checked={!draft.limited} disabled={busy || blocked} onChange={() => setDraft(value => ({ ...value, limited: false }))} /><span><strong>不限额 记录真实用量</strong><small>不设置人为费用上限 按接口回执累计 tokens 和费用</small></span></label>
        <label><input type="radio" name="model-cost-policy" checked={draft.limited} disabled={busy || blocked} onChange={() => setDraft(value => ({ ...value, limited: true }))} /><span><strong>设置单次费用上限</strong><small>需要完整报价才能估算 原有任务的固定费用策略保留</small></span></label>
      </fieldset>
      {draft.limited && <label className="ai-settings-cap-field">单次费用上限（美元）<input type="number" required min="0" step="any" value={draft.cap} disabled={busy || blocked} onChange={event => setDraft(value => ({ ...value, cap: event.target.value }))} placeholder="填写正数 不再固定限制 20 美元" /></label>}
      <section className="ai-settings-official-price" aria-label="本模型官方参考价格"><h3>官方参考价格</h3>{official && catalogue ? <>
        <p>输入 ${official.inputUsdPerMillion} · 输出 ${official.outputUsdPerMillion} / 百万 tokens</p><small>版本 {catalogue.version} · 核价日期 {catalogue.checkedAt.slice(0, 10)}</small>
        <p><a href={official.sourceUrl} target="_blank" rel="noopener noreferrer">查看官方价格来源<ExternalLink size={13} /></a></p>
        <button type="button" disabled={busy || blocked} onClick={() => setDraft(value => ({ ...value, input: official.inputUsdPerMillion, output: official.outputUsdPerMillion }))}>用官方价作为估算报价</button>
        <p className="ai-settings-muted">此操作只填写估算报价 渠道实际收费仍在费用核对中单独记录</p>
      </> : <p>待核价 当前 model ID 没有精确对应的官方价格 仍可保存不限额策略并记录真实用量</p>}</section>
      <details className="ai-settings-disclosure" open={draft.limited || undefined}><summary>高级 · 渠道估算报价</summary><div className="ai-settings-field-grid">
        <label>输入单价（美元/百万 tokens）<input type="number" min="0" max="1000" step="any" value={draft.input} disabled={busy || blocked} onChange={event => setDraft(value => ({ ...value, input: event.target.value }))} placeholder="留空表示未知 0 只用于已确认免费" /></label>
        <label>输出单价（美元/百万 tokens）<input type="number" min="0" max="5000" step="any" value={draft.output} disabled={busy || blocked} onChange={event => setDraft(value => ({ ...value, output: event.target.value }))} placeholder="留空表示未知" /></label></div></details>
      {inheritedFrom && <div className="ai-settings-warning"><p>当前报价或限额继承自关联分析配置 修改前请先核对原配置</p><button type="button" disabled={busy} onClick={() => {
        if (dirty && !window.confirm("切换至关联分析模型将放弃本窗口未保存的费用填写 是否继续？")) return; void onOpenRelated(inheritedFrom);
      }}>核对关联分析模型</button></div>}
      {stale && <div role="alert" className="ai-settings-warning">渠道或模型配置已变化 当前填写未覆盖原配置 {currentModel && <button type="button" disabled={busy || blocked} onClick={() => { const next = values(currentModel); original.current = next; setDraft(next); setRevision(currentModel.channel.revision); }}>载入最新费用设置</button>}</div>}
      {error && <p role="alert" className="studio-alert">{error}</p>}
      {incompleteLimit && <p role="status" className="ai-settings-warning">设置费用上限还需完整的输入报价 输出报价和正数费用上限 可选择不限额并记录用量</p>}
      {!parsed.success && !incompleteLimit && <p role="alert" className="studio-alert">费用格式无效 请核对单价与费用上限</p>}
      <p className="ai-settings-muted">保存只影响后续新任务 旧账单与调用时固定的报价版本保留 缺失用量和未知价格不会记成免费</p>
    </div><footer className="ai-settings-dialog-footer">{blocked && <button type="button" disabled={busy} onClick={onReconcile}><RefreshCw size={14} />读取原配置核对</button>}
      <button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="primary" disabled={busy || blocked || stale || !dirty || !parsed.success || incompleteLimit}>保存费用策略</button></footer></form>}</ModelSettingsDialog>;
}
