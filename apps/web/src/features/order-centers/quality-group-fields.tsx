"use client";
import { Plus, Trash2 } from "lucide-react";
import type { QualityPhysicalGroupInput } from "@yummyai/contracts/order/quality-groups";
import type { QualityStandardBasis } from "@yummyai/contracts/order/quality-assessment";
import { QualityCriterionFields, type QualityRating } from "./quality-assessment-fields";

type Defect = { key: string; code: string; severity: string; responsibility: string; disposition: string; note: string };
export type QualityGroupDraft = { key: string; label: string; quantity: string; ratings: Record<string, QualityRating>; defects: Defect[] };
export type GroupStandard = QualityStandardBasis & { id: string; name: string; versionNumber: number };
export const blankQualityGroup = (key = "group-1"): QualityGroupDraft => ({ key, label: "", quantity: "", ratings: {}, defects: [] });

export function readQualityGroupDrafts(groups: QualityGroupDraft[], standard: GroupStandard): QualityPhysicalGroupInput[] {
  return groups.map(group => ({ key: group.key, label: group.label, quantity: Number(group.quantity),
    criterionResults: standard.criteria.flatMap(criterion => {
      const rating = group.ratings[criterion.code];
      return rating?.score.trim() && ["passed", "failed"].includes(rating.outcome)
        ? [{ code: criterion.code, scoreBps: Math.round(Number(rating.score) * 100), passed: rating.outcome === "passed", evidenceAssetIds: [] }] : [];
    }),
    defects: group.defects.map(defect => ({ code: defect.code, severity: defect.severity as QualityPhysicalGroupInput["defects"][number]["severity"],
      responsibility: defect.responsibility as QualityPhysicalGroupInput["defects"][number]["responsibility"], disposition: defect.disposition as QualityPhysicalGroupInput["defects"][number]["disposition"],
      note: defect.note, evidenceAssetIds: [] })),
  }));
}

export function QualityGroupFields({ group, index, standard, removable, onChange, onRemove }: {
  group: QualityGroupDraft; index: number; standard: GroupStandard; removable: boolean;
  onChange(update: (current: QualityGroupDraft) => QualityGroupDraft, animate?: boolean): void; onRemove(): void;
}) {
  const changeDefect = (key: string, patch: Partial<Defect>) => onChange(current => ({ ...current, defects: current.defects.map(defect => defect.key === key ? { ...defect, ...patch } : defect) }));
  return <fieldset className="oc-quality-physical-group" aria-label={"实物组 " + (index + 1)}>
    <legend>实物组 {index + 1}</legend>
    <div className="oc-group-heading"><p className="oc-hint">同一组内实物具有相同检查结论和缺陷组合</p>
      {removable && <button type="button" className="oc-text-button" aria-label={"移除实物组 " + (index + 1)} onClick={onRemove}><Trash2 size={14} aria-hidden="true" />移除组</button>}</div>
    <div className="oc-group-grid">
      <label>隔离位置标识<input required value={group.label} maxLength={160} placeholder="例如 检验框 A" onChange={event => { const value = event.target.value; onChange(current => ({ ...current, label: value })); }} /></label>
      <label>本组实物数量<input required type="number" min={1} max={100_000} step={1} value={group.quantity} onChange={event => { const value = event.target.value; onChange(current => ({ ...current, quantity: value })); }} /></label>
    </div>
    <QualityCriterionFields standard={standard} ratings={group.ratings} onChange={(code, patch) => onChange(current => ({ ...current, ratings: { ...current.ratings, [code]: { ...(current.ratings[code] ?? { score: "", outcome: "" }), ...patch } } }))} />
    <div className="oc-group-heading"><h5>本组缺陷</h5><button type="button" className="oc-text-button" disabled={group.defects.length >= 200} onClick={() => {
      const key = crypto.randomUUID(); onChange(current => ({ ...current,
        defects: [...current.defects, { key, code: "", severity: "", responsibility: "", disposition: "", note: "" }] }), true);
    }}><Plus size={14} aria-hidden="true" />增加缺陷</button></div>
    {!group.defects.length && <p className="oc-hint">尚未登记缺陷 有未通过项目时须明确记录</p>}
    {group.defects.map((defect, position) => <fieldset className="oc-group-defect" key={defect.key} aria-label={"缺陷 " + (position + 1)}>
      <legend>缺陷 {position + 1} · 影响本组 {group.quantity || "未填"} 件</legend>
      <div className="oc-group-grid">
        <label>缺陷项目<select aria-label="缺陷项目" required value={defect.code} onChange={event => changeDefect(defect.key, { code: event.target.value })}>
          <option value="">选择实际缺陷</option>{standard.criteria.map(criterion => <option key={criterion.code} value={criterion.code}>{criterion.label}</option>)}<option value="MANUAL_QC">其他缺陷</option>
        </select></label>
        <label>缺陷严重度<select aria-label="缺陷严重度" required value={defect.severity} onChange={event => changeDefect(defect.key, { severity: event.target.value })}>
          <option value="">请选择</option><option value="minor">轻微</option><option value="major">重大</option><option value="critical">严重</option>
        </select></label>
        <label>责任归属<select aria-label="责任归属" required value={defect.responsibility} onChange={event => changeDefect(defect.key, { responsibility: event.target.value })}>
          <option value="">请选择</option><option value="supplier">供应商</option><option value="internal">内部</option><option value="carrier">承运商</option><option value="customer">客户</option><option value="unknown">尚未确定</option>
        </select></label>
        <label>处理方式<select aria-label="处理方式" required value={defect.disposition} onChange={event => changeDefect(defect.key, { disposition: event.target.value })}>
          <option value="">请选择</option><option value="accept">按实际情况接受</option><option value="rework">返工</option><option value="remake">补做</option><option value="reship">补发</option><option value="refund">退款</option><option value="cancel">取消</option><option value="scrap">报废</option>
        </select></label>
      </div>
      <label>缺陷说明<textarea required maxLength={2000} value={defect.note} onChange={event => changeDefect(defect.key, { note: event.target.value })} /></label>
      <button type="button" className="oc-text-button" onClick={() => onChange(current => ({ ...current, defects: current.defects.filter(item => item.key !== defect.key) }), true)}><Trash2 size={14} aria-hidden="true" />移除此缺陷</button>
    </fieldset>)}
  </fieldset>;
}
