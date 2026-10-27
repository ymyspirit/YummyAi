"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Palette, X } from "lucide-react";
import { orderRequirementDraftInput, type OrderRequirementInterpretation, type OrderRequirementSource } from "@yummyai/contracts/order/requirement-interpretation";
import type { OrderIntakeCheck, OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { pillowCropSubject } from "@yummyai/contracts/order/production-requirements";
import { orderRequirementContextCurrent, orderRequirementField, orderRequirementTextGroups, orderRequirementWithStyle, orderRequirementWithText } from "./order-requirements-model";

type TextGroup = ReturnType<typeof orderRequirementTextGroups>[number];
function TextRequirement({ group, draft, disabled, onChange, onPending, readOnly = false }: {
  group: TextGroup; draft: OrderWorkDraft; disabled: boolean; onChange: (draft: OrderWorkDraft) => void;
  onPending: (key: string, pending: boolean) => void;
  readOnly?: boolean;
}) {
  const [font, setFont] = useState(""), [color, setColor] = useState(""), [error, setError] = useState("");
  const pending = !!font || !!color;
  const key = group.source.sourceFieldKey;
  useEffect(() => { if (!group.needsPrinting) { setFont(""); setColor(""); setError(""); } }, [group.needsPrinting]);
  useEffect(() => { onPending(key, pending); return () => onPending(key, false); }, [key, pending, onPending]);
  function apply() {
    if (disabled || readOnly) return;
    try { onChange(orderRequirementWithStyle(draft, key, font, color)); setFont(""); setColor(""); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "本组样式未能填写 请核对后重试"); }
  }
  return <fieldset className="oc-requirement-text" disabled={disabled} data-review-field={group.field?.key ?? key}>
    <legend>{group.source.label || "印字内容"}</legend>
    {group.included ? readOnly ? group.text.trim() ? <p className="oc-requirement-original">{group.text}</p> : null
      : <label>印字内容<textarea aria-label={`印字内容 ${group.source.label}`} rows={2} value={group.text}
        onChange={event => onChange(orderRequirementWithText(draft, group.source, event.target.value))} /></label>
      : <><p className="oc-requirement-original">{group.text || "未填写文字"}</p><p className="oc-hint">这段原文未纳入当前草稿 请在原始字段详情核对</p></>}
    {!group.needsPrinting ? <p className="oc-requirement-empty" role="status">无需印字</p> : <>
      <dl><div><dt>字体</dt><dd>{group.legacyFont ? <>历史字体值 {group.legacyFont} · 待核对</> : group.font || "未提供字体"}</dd></div><div><dt>文字颜色</dt><dd>
        {group.colorHex ? <><span className="oc-requirement-swatch" style={{ backgroundColor: group.colorHex }} aria-hidden="true" />{group.colorLabel && group.colorLabel !== group.colorHex ? `${group.colorLabel} · ` : ""}{group.colorHex}</>
          : group.legacyColor ? <>历史色值 {group.legacyColor} · 待核对</>
          : <>{group.colorLabel ? `${group.colorLabel} · ` : ""}未提供真实色值</>}
      </dd></div></dl>
      {(group.legacyFont || group.legacyColor) && <p className="oc-hint">历史值可能由旧解析继承 尚未确认属于本组文字 {readOnly ? "请回订单制作需求核对" : "请在下方核对后明确采用本组样式"}</p>}
      {group.included && !readOnly && <details className="oc-requirement-style"><summary><Palette size={14} />调整本组字体与颜色</summary>
        <p className="oc-hint">仅作用于这段文字 留空保留原要求 需要实际色值 不会默认黑色</p>
        <div className="oc-requirement-style-fields"><label>指定字体<input aria-label={`指定字体 ${group.source.label}`} maxLength={500} value={font} onChange={event => { setFont(event.target.value); setError(""); }} /></label>
          <label>实际色值<input aria-label={`实际色值 ${group.source.label}`} placeholder="#RRGGBB" maxLength={7} value={color} aria-invalid={!!color && !/^#[a-fA-F0-9]{6}$/.test(color.trim())} onChange={event => { setColor(event.target.value); setError(""); }} /></label></div>
        {error && <p className="oc-error" role="alert">{error}</p>}
        <div className="oc-actions"><button type="button" className="oc-button" disabled={!pending} onClick={apply}><Check size={14} />采用本组样式</button>
          <button type="button" className="oc-button" disabled={!pending} onClick={() => { setFont(""); setColor(""); setError(""); }}><X size={14} />取消调整</button></div>
      </details>}
    </>}
  </fieldset>;
}

export function OrderRequirementsView({ detail, draft, check, disabled, onChange, onPending, children, readOnly = false }: {
  detail: OrderWorkDetail; draft: OrderWorkDraft; check: OrderIntakeCheck | null; disabled: boolean;
  onChange: (draft: OrderWorkDraft) => void; onPending: (pending: boolean) => void; children?: ReactNode;
  readOnly?: boolean;
}) {
  const [verified, setVerified] = useState<OrderRequirementInterpretation | null>(null);
  const [verifiedInput, setVerifiedInput] = useState("");
  const edits = useRef(new Set<string>());
  const pendingCallback = useRef(onPending); pendingCallback.current = onPending;
  const reportPending = useCallback((key: string, pending: boolean) => {
    if (pending) edits.current.add(key); else edits.current.delete(key);
    pendingCallback.current(edits.current.size > 0);
  }, []);
  useEffect(() => () => pendingCallback.current(false), []);
  const input = orderRequirementDraftInput(draft);
  const candidate = check?.requirements ?? detail.requirementInterpretation ?? null;
  const context = candidate && orderRequirementContextCurrent(candidate, detail, draft);
  useEffect(() => {
    if (!candidate || !context) return;
    let active = true;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)).then(buffer => {
      const hash = [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (active && hash === candidate.basis.draftChecksum) { setVerified(candidate); setVerifiedInput(input); }
    }).catch(() => { /* A failed digest cannot validate a new mapping. Original source remains visible. */ });
    return () => { active = false; };
  }, [candidate, context, input]);
  // Previous source grouping may steady the view while typing, but it never authorizes a save.
  const mapping = verified && orderRequirementContextCurrent(verified, detail, draft) ? verified : null;
  const sources: readonly OrderRequirementSource[] = mapping?.sources ?? detail.requirementSources ?? [];
  const groups = orderRequirementTextGroups(sources, draft);
  const options = sources.filter(source => !["text", "font", "color", "notes", "image"].includes(source.role));
  const notes = sources.filter(source => source.role === "notes");
  const fields = detail.catalog?.artworks.find(row => row.id === draft.artworkVersionId)?.customization.fields ?? [];
  function value(source: OrderRequirementSource) { return orderRequirementField(draft, source.sourceFieldKey)?.value ?? source.value; }
  function optionValue(source: OrderRequirementSource) {
    const text = value(source), subject = source.role === "crop" ? pillowCropSubject(text) : null;
    if (subject) return { head: "头部", body: "全身", half_body: "半身" }[subject];
    const target = mapping?.coverage.find(row => row.sourceFieldKey === source.sourceFieldKey)?.targetFieldKey;
    const field = fields.find(row => row.key === target || row.key === orderRequirementField(draft, source.sourceFieldKey)?.key);
    return field?.type === "single_choice" ? field.options.find(row => row.value === text)?.label ?? text : text;
  }
  return <>
    {!sources.length ? <p className="oc-hint" role="status">正在整理原始定制要求 原字段完整保留在详情中</p> : <>
      {!!groups.length && <section className="oc-requirement-texts" aria-label="分组印字要求">{groups.map(group => <TextRequirement key={group.source.sourceFieldKey} group={group} draft={draft} disabled={disabled}
        onChange={onChange} onPending={reportPending} readOnly={readOnly} />)}</section>}
      {!groups.some(group => group.needsPrinting) && !groups.length && <p className="oc-hint">当前没有已识别的印字内容 其他定制选项与原始字段仍保留</p>}
      {!!options.length && <dl className="oc-requirement-options">{options.map(source => <div key={source.sourceFieldKey} data-review-field={orderRequirementField(draft, source.sourceFieldKey)?.key ?? source.sourceFieldKey} tabIndex={-1}>
        <dt>{source.label || "定制选项"}</dt><dd>{optionValue(source) || "未填写"}</dd></div>)}</dl>}
      {!!notes.length && <section className="oc-requirement-notes" aria-label="顾客备注原文">{notes.map(source => <div key={source.sourceFieldKey} data-review-field={orderRequirementField(draft, source.sourceFieldKey)?.key ?? source.sourceFieldKey} tabIndex={-1}><strong>{source.label || "顾客备注"}</strong>
        <p>{value(source) || "未填写（选填）"}</p></div>)}</section>}
    </>}
    {children}
    {verifiedInput === input && !!mapping?.unresolved.length && <div className="oc-requirement-unresolved" aria-label="定制要求待核对"><strong>需要核对的原始要求</strong><ul>{mapping.unresolved.map((row, index) => <li key={`${row.code}:${index}`}>{row.message}</li>)}</ul></div>}
  </>;
}
