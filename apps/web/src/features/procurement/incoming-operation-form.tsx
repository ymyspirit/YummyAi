"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import type { IncomingArrivalLineView, IncomingCriterion, IncomingWorkspaceView } from "@yummyai/contracts/procurement/incoming";
import { PrepareIncomingCommandSchema, type IncomingCommandKind, type PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { compareStockQuantity, formatStockQuantity, subtractStockQuantity, sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { Field } from "../manual-operations/record-form";
import { formDate, formText, localDateTime, unitNames } from "../manual-operations/operation-types";
import { useFormEdits } from "../navigation/use-form-edits";
import { IncomingRequestError, incomingDenied } from "./incoming-api";
import { convertProcurementQuantity, type ProcurementUnit } from "@yummyai/contracts/procurement/measurement";
import { ProcurementMeasure, readProcurementQuantity } from "./procurement-cycle-form";

export const incomingActionNames: Record<IncomingCommandKind, string> = {
  publish_standard: "发布检验标准", record_arrival: "登记实际到货", record_inspection: "记录实际检验",
  review_inspection: "核准本次检验", post_inspection: "确认检验入账", return_rejected: "登记实际退回",
};
export const incomingStatusNames = { prepared: "待核对执行", succeeded: "实际操作已完成", rejected: "原填写不可用", cancelled: "准备已取消", expired: "原填写已到期" };
export type IncomingDraft = { id: string; kind: IncomingCommandKind; workspace: IncomingWorkspaceView; line?: IncomingArrivalLineView; postingId?: string };
type BuildInput = () => unknown;

export function IncomingOperationForm({ draft, unavailable, basisChanged, onPrepare, onClose }: {
  draft: IncomingDraft; unavailable: boolean; basisChanged: boolean;
  onPrepare(input: PrepareIncomingCommand): Promise<void>; onClose(): void;
}) {
  const [working, setWorking] = useState(false), [error, setError] = useState("");
  const [frozen, setFrozen] = useState<PrepareIncomingCommand | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const build = useRef<BuildInput | null>(null), submitted = useRef<PrepareIncomingCommand | null>(null), active = useRef(true), busy = useRef(false), edits = useFormEdits();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const close = () => { if (!working && (!edits.check() || window.confirm("放弃本页尚未保存的填写并返回批次记录？"))) onClose(); };
  return <form className="record-form incoming-form" ref={node => { edits.ref.current = node?.parentElement ?? null; }} onInput={() => edits.check()} onChange={() => edits.check()}
    onSubmit={async event => {
      event.preventDefault(); if (busy.current || unavailable || basisChanged) return;
      try {
        const original = frozen ?? PrepareIncomingCommandSchema.parse(build.current?.());
        submitted.current = original;
        busy.current = true; setWorking(true); setError("");
        await onPrepare(original);
      } catch (failure) {
        if (!active.current || incomingDenied(failure)) return;
        if (failure instanceof IncomingRequestError && (failure.status === 0 || failure.status >= 500)) {
          setFrozen(previous => previous ?? submitted.current);
        }
        setError(failure instanceof IncomingRequestError ? failure.message : "请核对必填字段、数量、日期和检验标准");
      } finally { busy.current = false; if (active.current) setWorking(false); }
    }}>
    <h3>{incomingActionNames[draft.kind]}</h3>
    <p className="record-help">先保存原填写 核对后再执行实际操作</p>
    {basisChanged && <p className="record-notice error" role="alert">业务依据已变化 你的填写已保留 请返回批次核对后再填写本次操作</p>}
    {error && <p className="record-notice error" role="alert">{error}</p>}
    {frozen && <p className="record-notice" role="status">保存结果待核对 已固定本次原填写 重试会使用同一笔提交</p>}
    <fieldset className="record-fields" disabled={working || unavailable || Boolean(frozen) || basisChanged}>
      <IncomingFields draft={draft} requestKey={requestKey} build={value => { build.current = value; }} />
    </fieldset>
    <footer><button type="button" disabled={working} onClick={close}>返回批次</button>
      <button type="submit" className="primary" disabled={working || unavailable || basisChanged}><Check size={14} />{working ? "正在保存原填写" : frozen ? "重试保存同一笔原提交" : "保存原填写并核对"}</button></footer>
  </form>;
}

function IncomingFields({ draft, requestKey, build }: { draft: IncomingDraft; requestKey: string; build(value: BuildInput): void }) {
  const props = { draft, requestKey, build };
  switch (draft.kind) {
    case "publish_standard": return <StandardFields {...props} />;
    case "record_arrival": return <ArrivalFields {...props} />;
    case "record_inspection": return <InspectionFields {...props} />;
    case "review_inspection": return <ReviewFields {...props} />;
    case "post_inspection": return <PostingFields {...props} />;
    case "return_rejected": return <ReturnFields {...props} />;
  }
}
type FieldsProps = { draft: IncomingDraft; requestKey: string; build(value: BuildInput): void };
const timeDefault = (draft: IncomingDraft) => localDateTime(new Date(draft.workspace.recordingTime));
const quantity = (form: FormData, name: string) => formText(form, name) || "0";
function useBuilder(build: FieldsProps["build"], value: (form: FormData) => unknown) {
  const ref = useRef<HTMLDivElement>(null);
  build(() => { const form = ref.current?.closest("form"); if (!form) throw new Error("Original form unavailable"); return value(new FormData(form)); });
  return ref;
}

type CriterionDraft = { id: string; code: string; label: string; kind: "numeric_range" | "one_of"; unit: string; minimum: string; maximum: string; values: string };
const newCriterion = (): CriterionDraft => ({ id: crypto.randomUUID(), code: "", label: "", kind: "numeric_range", unit: "", minimum: "", maximum: "", values: "" });
function StandardFields({ draft, requestKey, build }: FieldsProps) {
  const [stockId, setStockId] = useState(""), [code, setCode] = useState("");
  const [criteria, setCriteria] = useState<CriterionDraft[]>([newCriterion()]);
  const stock = draft.workspace.purchaseLines.filter((line, index, all) => all.findIndex(item => item.stockItemId === line.stockItemId) === index && draft.workspace.standardWritableStockItemIds.includes(line.stockItemId));
  const previous = draft.workspace.standards.filter(row => row.stockItemId === stockId && row.code === code.trim().toUpperCase()).sort((a, b) => b.version - a.version)[0];
  const ref = useBuilder(build, form => ({ kind: "publish_standard", targetId: stockId, input: { code: code.trim().toUpperCase(), stockItemId: stockId,
    expectedVersion: previous?.version ?? 0, title: formText(form, "standardTitle"), sourceReference: formText(form, "sourceReference"),
    criteria: criteria.map(row => row.kind === "numeric_range" ? { code: row.code.trim().toUpperCase(), label: row.label, kind: row.kind, unit: row.unit,
      minimum: row.minimum.trim() || null, maximum: row.maximum.trim() || null } : { code: row.code.trim().toUpperCase(), label: row.label, kind: row.kind,
      acceptedValues: row.values.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }), idempotencyKey: requestKey } }));
  const update = (id: string, patch: Partial<CriterionDraft>) => setCriteria(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
  return <div ref={ref}>
    <div className="record-grid"><Field label="原物料"><select required value={stockId} onChange={event => setStockId(event.target.value)}><option value="">请选择原物料</option>{stock.map(row => <option value={row.stockItemId} key={row.stockItemId}>{row.stockName} · {row.stockCode}</option>)}</select></Field>
      <Field label="标准编号"><input required maxLength={64} value={code} onChange={event => setCode(event.target.value)} /></Field></div>
    <p className="record-help">{previous ? `依据现有 v${previous.version} 发布下一版 原检验记录继续保留原标准` : "发布此物料与编号的第一版标准"}</p>
    <Field label="标准名称"><input name="standardTitle" required maxLength={160} /></Field>
    <Field label="实际标准来源与版本" help="填写已确认的供应商规格、样品或内部标准 不把参考资料写成工厂验收"><textarea name="sourceReference" required maxLength={2000} rows={2} /></Field>
    <div className="record-lines">{criteria.map((row, index) => <section className="record-line" key={row.id} aria-label={`检验项目 ${index + 1}`}>
      <header><strong>检验项目 {index + 1}</strong>{criteria.length > 1 && <button type="button" aria-label={`移除检验项目 ${index + 1}`} onClick={() => setCriteria(items => items.filter(item => item.id !== row.id))}><Trash2 size={14} />移除</button>}</header>
      <div className="record-grid"><Field label="项目编号"><input required maxLength={64} value={row.code} onChange={event => update(row.id, { code: event.target.value })} /></Field>
        <Field label="项目名称"><input required maxLength={120} value={row.label} onChange={event => update(row.id, { label: event.target.value })} /></Field>
        <Field label="判定方式"><select value={row.kind} onChange={event => update(row.id, { kind: event.target.value as CriterionDraft["kind"] })}><option value="numeric_range">测量范围</option><option value="one_of">符合指定观测值</option></select></Field></div>
      {row.kind === "numeric_range" ? <div className="record-grid"><Field label="测量单位"><input required maxLength={32} value={row.unit} onChange={event => update(row.id, { unit: event.target.value })} /></Field>
        <Field label="最小值" help="至少填写一个实际边界"><input inputMode="decimal" value={row.minimum} onChange={event => update(row.id, { minimum: event.target.value })} /></Field>
        <Field label="最大值"><input inputMode="decimal" value={row.maximum} onChange={event => update(row.id, { maximum: event.target.value })} /></Field></div>
        : <Field label="符合要求的观测值" help="每行填写一个实际允许值"><textarea required maxLength={3629} rows={3} value={row.values} onChange={event => update(row.id, { values: event.target.value })} /></Field>}
    </section>)}</div>
    <button type="button" disabled={criteria.length >= 40} onClick={() => setCriteria(rows => [...rows, newCriterion()])}><Plus size={14} />增加检验项目</button>
  </div>;
}

function ArrivalFields({ draft, requestKey, build }: FieldsProps) {
  const [code] = useState(() => `ARR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
  const [units, setUnits] = useState<Record<string, ProcurementUnit>>({}), [quantities, setQuantities] = useState<Record<string, string>>({}), [notice, setNotice] = useState("");
  const ref = useBuilder(build, form => ({ kind: "record_arrival", targetId: draft.workspace.purchaseOrderId, input: { code: formText(form, "arrivalCode").toUpperCase(),
    expectedPurchaseOrderVersion: draft.workspace.purchaseOrderVersion, arrivedAt: formDate(form, "arrivedAt"), externalReference: formText(form, "arrivalReference"),
    lines: draft.workspace.purchaseLines.filter((_, index) => formText(form, `quantity-${index}`)).map(line => {
      const index = draft.workspace.purchaseLines.indexOf(line), unit = units[line.lineKey] ?? line.unit, quantity = readProcurementQuantity(formText(form, `quantity-${index}`), unit);
      if (unit !== line.unit && !line.stockBasis) throw new Error("原采购未留存换算依据 仅能按原单位登记 请先核对");
      if (line.stockBasis) convertProcurementQuantity(quantity, unit, line.stockBasis.stockUnit);
      return { lineKey: line.lineKey, quantity, unit,
        holdingLocationId: formText(form, `holding-${index}`), lotCode: formText(form, `lot-${index}`), expiresAt: formText(form, `expiry-${index}`) ? formDate(form, `expiry-${index}`) : null };
    }), idempotencyKey: requestKey } }));
  return <div ref={ref}>
    <p className="record-help">采购 v{draft.workspace.purchaseOrderVersion} 到货先进入待检保管 实际接受入账后才增加可用库存</p>
    {notice && <p className="record-notice" role="status">{notice}</p>}
    <div className="record-grid"><Field label="到货记录编号"><input name="arrivalCode" required defaultValue={code} maxLength={64} /></Field>
      <Field label="实际到货时间"><input name="arrivedAt" required type="datetime-local" defaultValue={timeDefault(draft)} /></Field></div>
    <Field label="实际交接凭据"><input name="arrivalReference" required maxLength={2000} /></Field>
    {draft.workspace.purchaseLines.map((line, index) => {
      const unit = units[line.lineKey] ?? line.unit, options: ProcurementUnit[] = line.stockBasis && ["gram", "kilogram"].includes(line.unit) ? ["gram", "kilogram"] : [line.unit];
      let stockPreview = "";
      try { if (quantities[line.lineKey] && line.stockBasis) stockPreview = formatStockQuantity(convertProcurementQuantity(readProcurementQuantity(quantities[line.lineKey]!, unit), unit, line.stockBasis.stockUnit)) + " " + unitNames[line.stockBasis.stockUnit]; } catch { /* Shared validation runs before preparation. */ }
      return <section className="record-line" key={line.lineKey} aria-label={`实际到货 ${line.stockName}`}>
      <header><strong>{line.stockName}</strong><span>{line.stockCode} · {line.lineKey}</span></header>
      <ProcurementMeasure quantity={line.quantity} unit={line.unit} stockBasis={line.stockBasis} />
      <div className="record-grid"><Field label="实际到货单位" help={line.stockBasis ? "按原采购版本的换算依据核对" : "原换算依据未留存 只允许原单位"}><select value={unit} onChange={event => { setUnits(values => ({ ...values, [line.lineKey]: event.target.value as ProcurementUnit })); setQuantities(values => ({ ...values, [line.lineKey]: "" })); setNotice("实际到货单位已变化 已清空本次数量 请按实际单位重新填写"); }}>{options.map(value => <option value={value} key={value}>{unitNames[value]}</option>)}</select></Field><Field label={`本次数量 ${unitNames[unit]}`} help="实际到货数量 最多9位小数 未填写的明细不登记到货"><input name={`quantity-${index}`} type="text" inputMode="decimal" autoComplete="off" maxLength={41} value={quantities[line.lineKey] ?? ""} onChange={event => setQuantities(values => ({ ...values, [line.lineKey]: event.target.value }))} /></Field>
        <LocationField workspace={draft.workspace} name={`holding-${index}`} label="实际待检保管库位" required={false} /></div>
      <div className="record-grid"><Field label="供应商原批号" help="按交接凭据填写 保留原始大小写与中文"><input name={`lot-${index}`} maxLength={200} /></Field>
        <Field label="有效期限" help="无期限依据可留空"><input name={`expiry-${index}`} type="datetime-local" /></Field></div>
      {stockPreview && <p className="procurement-measure-check"><span>本次实际 {quantities[line.lineKey]} {unitNames[unit]}</span><span>对应库存 {stockPreview}</span></p>}
    </section>; })}
  </div>;
}

function InspectionFields({ draft, requestKey, build }: FieldsProps) {
  const line = draft.line!, [standardId, setStandardId] = useState("");
  const standards = draft.workspace.standards.filter(row => row.stockItemId === line.stockItemId && !draft.workspace.standards.some(other => other.stockItemId === row.stockItemId && other.code === row.code && other.version > row.version));
  const standard = standards.find(row => row.id === standardId), version = line.inspections[0]?.version ?? 0;
  const ref = useBuilder(build, form => ({ kind: "record_inspection", targetId: line.id, input: { expectedInspectionVersion: version, standardVersionId: standardId,
    acceptedQuantity: quantity(form, "accepted"), rejectedQuantity: quantity(form, "rejected"), sampleQuantity: formText(form, "sample"),
    rejectionReason: formText(form, "rejectionReason") || null, measuredAt: formDate(form, "measuredAt"), notes: formText(form, "inspectionNotes") || null,
    readings: (standard?.criteria ?? []).flatMap((criterion, index) => formText(form, `reading-${index}`) ? [{ criterionCode: criterion.code,
      value: formText(form, `reading-${index}`), unit: criterion.kind === "numeric_range" ? formText(form, `readingUnit-${index}`) || null : null }] : []), idempotencyKey: requestKey } }));
  return <div ref={ref}>
    <p className="record-help">{line.stockName} · 原批号 {line.supplierLotCode} · 待处置 {formatStockQuantity(line.quantities.pending)} {unitNames[line.unit]}</p>
    <Field label="实际使用的标准"><select required value={standardId} onChange={event => setStandardId(event.target.value)}><option value="">请选择已确认的标准版本</option>{standards.map(row => <option key={row.id} value={row.id}>{row.title} · {row.code} v{row.version}</option>)}</select></Field>
    {standard && <><p className="record-help">标准依据 {standard.sourceReference}</p><div className="record-lines">{standard.criteria.map((criterion, index) => <section className="record-line" key={`${standard.id}:${criterion.code}`}>
      <header><strong>{criterion.label}</strong><span>{criterion.code} · <CriterionDescription criterion={criterion} /></span></header>
      <div className="record-grid"><Field label="实际测量或观测值" help="缺失可先留空保存 缺项或无效测量不能作为接受入库依据"><input name={`reading-${index}`} maxLength={120} list={criterion.kind === "one_of" ? `observations-${draft.id}-${index}` : undefined} /></Field>
        {criterion.kind === "numeric_range" && <Field label="实际测量单位"><input name={`readingUnit-${index}`} maxLength={32} defaultValue={criterion.unit} /></Field>}</div>
      {criterion.kind === "one_of" && <datalist id={`observations-${draft.id}-${index}`}>{criterion.acceptedValues.map(value => <option value={value} key={value} />)}</datalist>}
    </section>)}</div></>}
    <div className="record-grid"><Field label={`本次检验接受数量 ${unitNames[line.unit]}`} help="本批实际单位 最多9位小数 留空代表0"><input name="accepted" type="text" inputMode="decimal" maxLength={41} /></Field>
      <Field label={`本次检验拒收数量 ${unitNames[line.unit]}`} help="本批实际单位 最多9位小数 留空代表0"><input name="rejected" type="text" inputMode="decimal" maxLength={41} /></Field>
      <Field label={`实际抽样数量 ${unitNames[line.unit]}`} help="本批实际单位"><input name="sample" type="text" inputMode="decimal" maxLength={41} required /></Field></div>
    <Field label="实际拒收原因" help="本次有拒收数量时必填"><textarea name="rejectionReason" maxLength={2000} rows={2} /></Field>
    <div className="record-grid"><Field label="实际测量时间"><input name="measuredAt" required type="datetime-local" defaultValue={timeDefault(draft)} /></Field>
      <Field label={version ? "本次复检原因" : "检验说明"}><textarea name="inspectionNotes" required={version > 0} maxLength={2000} rows={2} /></Field></div>
  </div>;
}

function ReviewFields({ draft, requestKey, build }: FieldsProps) {
  const line = draft.line!, inspection = line.inspections[0]!;
  const mayApprove = inspection.evaluation.complete && (compareStockQuantity(inspection.acceptedQuantity, 0) === 0 || inspection.evaluation.passed);
  const ref = useBuilder(build, form => ({ kind: "review_inspection", targetId: line.id, input: { expectedInspectionVersion: inspection.version, inspectionId: inspection.id,
    decision: formText(form, "decision"), reason: formText(form, "reviewReason"), idempotencyKey: requestKey } }));
  return <div ref={ref}>
    <p className="record-help">核对检验 v{inspection.version} 与其实际测量记录 核准后仍需单独确认实际入账</p>
    {!mayApprove && <p className="record-notice error">本次测量存在缺项或不满足接受条件 请拒绝本次检验并记录复检</p>}
    <Field label="本次核准决定"><select name="decision" required defaultValue=""><option value="">请选择实际核准决定</option><option value="approved" disabled={!mayApprove}>批准本次检验处置</option><option value="rejected">拒绝本次检验</option></select></Field>
    <Field label="核准依据"><textarea name="reviewReason" required maxLength={2000} rows={3} /></Field>
  </div>;
}

function PostingFields({ draft, requestKey, build }: FieldsProps) {
  const line = draft.line!, inspection = line.inspections[0]!, review = inspection.review!;
  const used = line.postings.filter(row => row.approvalId === review.id);
  const [accepted, setAccepted] = useState("");
  let accepts = false; try { accepts = compareStockQuantity(accepted || "0", 0) > 0; } catch { /* Local invalid quantity is checked before preparation. */ }
  const ref = useBuilder(build, form => ({ kind: "post_inspection", targetId: line.id, input: { expectedInspectionVersion: inspection.version, approvalId: review.id,
    acceptedQuantity: quantity(form, "accepted"), rejectedQuantity: quantity(form, "rejected"), rejectionLocationId: formText(form, "rejectionLocation") || null,
    ownershipConfirmation: form.get("ownership") === "on" ? "merchant_received" : null, postedAt: formDate(form, "postedAt"), idempotencyKey: requestKey } }));
  return <div ref={ref}>
    <p className="record-help">检验 v{inspection.version} 原核准剩余 接受 {formatStockQuantity(subtractStockQuantity(inspection.acceptedQuantity, sumStockQuantities(used.map(row => row.acceptedQuantity))))} · 拒收 {formatStockQuantity(subtractStockQuantity(inspection.rejectedQuantity, sumStockQuantities(used.map(row => row.rejectedQuantity))))} {unitNames[line.unit]}</p>
    <p className="record-help">接受部分增加可用库存 拒收部分继续单独保管 实际退回另行登记</p>
    <div className="record-grid"><Field label={`本次接受数量 ${unitNames[line.unit]}`} help="本批实际单位 最多9位小数 留空代表0"><input name="accepted" type="text" inputMode="decimal" maxLength={41} value={accepted} onChange={event => setAccepted(event.target.value)} /></Field>
      <Field label={`本次拒收数量 ${unitNames[line.unit]}`} help="本批实际单位 最多9位小数 留空代表0"><input name="rejected" type="text" inputMode="decimal" maxLength={41} /></Field>
      <LocationField workspace={draft.workspace} name="rejectionLocation" label="实际拒收保管库位" required={false} /></div>
    <label className="incoming-confirm"><input type="checkbox" name="ownership" required={accepts} disabled={!accepts} />确认本次接受物料已由商家实际接收并拥有</label>
    <Field label="实际入账时间"><input name="postedAt" required type="datetime-local" defaultValue={timeDefault(draft)} /></Field>
  </div>;
}

function ReturnFields({ draft, requestKey, build }: FieldsProps) {
  const line = draft.line!, posting = line.postings.find(row => row.id === draft.postingId)!;
  const remaining = subtractStockQuantity(posting.rejectedQuantity, sumStockQuantities(posting.returns.map(row => row.quantity)));
  const ref = useBuilder(build, form => ({ kind: "return_rejected", targetId: line.id, postingId: posting.id, input: { quantity: formText(form, "returnedQuantity"),
    returnedAt: formDate(form, "returnedAt"), externalReference: formText(form, "returnReference"), reason: formText(form, "returnReason"), idempotencyKey: requestKey } }));
  return <div ref={ref}>
    <p className="record-help">原拒收处置尚在保管 {formatStockQuantity(remaining)} {unitNames[line.unit]} 只登记已经实际交接的退回</p>
    <div className="record-grid"><Field label={`实际退回数量 ${unitNames[line.unit]}`} help="本批实际单位 最多9位小数"><input name="returnedQuantity" type="text" required inputMode="decimal" maxLength={41} /></Field>
      <Field label="实际退回时间"><input name="returnedAt" required type="datetime-local" defaultValue={timeDefault(draft)} /></Field></div>
    <Field label="实际交接凭据"><input name="returnReference" required maxLength={2000} /></Field>
    <Field label="实际退回原因"><textarea name="returnReason" required maxLength={2000} rows={2} /></Field>
  </div>;
}
function LocationField({ workspace, name, label, required }: { workspace: IncomingWorkspaceView; name: string; label: string; required: boolean }) {
  return <Field label={label}><select name={name} required={required} defaultValue=""><option value="">请选择实际库位</option>{workspace.locations.map(row => <option key={row.id} value={row.id}>{row.warehouseName} · {row.name} · {row.code}</option>)}</select></Field>;
}
export function CriterionDescription({ criterion }: { criterion: IncomingCriterion }) {
  return <>{criterion.kind === "numeric_range" ? `${criterion.minimum ?? "无下限"} 至 ${criterion.maximum ?? "无上限"} ${criterion.unit}` : criterion.acceptedValues.join(" / ")}</>;
}
