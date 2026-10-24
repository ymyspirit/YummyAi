"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AllocateQualityScrapInputSchema, type AllocateQualityScrapInput, type QualityScrapBasis } from "@yummyai/contracts/order/quality-scrap";
import { formFingerprint } from "../navigation/use-form-edits";

type Row = { key: number; qualityGroupId: string; sourceQuantityReviewId: string; quantity: string };
type LotScope = QualityScrapBasis["lots"][number]["scope"];
export const qualityScrapLotScopeLabel = (scope: LotScope) => ({
  groupable: "可明确归属原失败组", before_root: "原根检验前已排除 不再扣减实物组",
  ambiguous: "来源时序有歧义 暂不能归属", no_root: "尚无可固定的原根检验",
})[scope];
function localDateTime(value?: string) {
  const date = value ? new Date(value) : new Date(), pad = (part: number) => String(part).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") + "T" +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(":") + "." + String(date.getMilliseconds()).padStart(3, "0");
}
function count(value: string) {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 6 || Number(value) > 100_000) throw new Error("本次归属数量须为 1 至 100000 的整数");
  return Number(value);
}
function allocationProblem(rows: Row[], basis: QualityScrapBasis) {
  const groups = new Map<string, number>(), lots = new Map<string, number>(), pairs = new Set<string>();
  let total = 0;
  for (const row of rows) {
    const group = basis.groups.find(value => value.qualityGroupId === row.qualityGroupId);
    const lot = basis.lots.find(value => value.sourceQuantityReviewId === row.sourceQuantityReviewId);
    if (!group || !lot) return "请逐行明确选择原失败实物组与实际新增报废批次";
    if (!group.active || group.result !== "failed" || group.allocationBlockers.length || group.maxAllocatableQuantity < 1) return "所选原组当前不能新增报废归属 请核对其阻断依据";
    if (lot.scope !== "groupable" || lot.remainingQuantity < 1) return "所选报废批次不能再扣减原实物组 请核对原批次范围与剩余额度";
    const pair = row.qualityGroupId + ":" + row.sourceQuantityReviewId;
    if (pairs.has(pair)) return "同一原组与同一新增报废批次只能登记一行 请合并本次实际数量";
    pairs.add(pair);
    let quantity: number;
    try { quantity = count(row.quantity); } catch { return "请为每一行填写 1 至 100000 的实际归属整数数量"; }
    total += quantity;
    if (total > basis.unassignedQuantity) return "本次合计超过原核准中尚未归属的实际报废数量";
    groups.set(row.qualityGroupId, (groups.get(row.qualityGroupId) ?? 0) + quantity);
    lots.set(row.sourceQuantityReviewId, (lots.get(row.sourceQuantityReviewId) ?? 0) + quantity);
    if (groups.get(row.qualityGroupId)! > group.maxAllocatableQuantity) return "本次多行合计超过所选失败组可归属上限";
    if (lots.get(row.sourceQuantityReviewId)! > lot.remainingQuantity) return "本次多行合计超过所选新增报废批次的未归属数量";
  }
  return "";
}
export function QualityScrapForm({ basis, current, busy, disabled, frozen, failure, knownRejected, onSubmit, onRetry, onClose, onDiscard }: {
  basis: QualityScrapBasis; current: QualityScrapBasis | null; busy: boolean; disabled: boolean;
  frozen: AllocateQualityScrapInput | null; failure: string; knownRejected: boolean;
  onSubmit(input: AllocateQualityScrapInput, form: HTMLFormElement, fingerprint: string): void;
  onRetry(): void; onClose(): void; onDiscard(): void;
}) {
  const [rows, setRows] = useState<Row[]>(() => frozen ? frozen.allocations.map((row, index) => ({ ...row, key: index + 1, quantity: String(row.quantity) }))
    : [{ key: 1, qualityGroupId: "", sourceQuantityReviewId: "", quantity: "" }]);
  const nextRow = useRef(rows.length + 1);
  const [removing, setRemoving] = useState<number | null>(null), removeTimer = useRef<number | null>(null);
  useEffect(() => () => { if (removeTimer.current !== null) window.clearTimeout(removeTimer.current); }, []);
  const [at, setAt] = useState(() => localDateTime(frozen?.occurredAt)), [evidence, setEvidence] = useState(frozen?.evidenceCode ?? ""),
    [assets, setAssets] = useState(frozen?.evidenceAssetIds.join("\n") ?? ""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState("");
  const stale = !current || current.productionVersionId !== basis.productionVersionId || current.projectionVersion !== basis.projectionVersion ||
    current.rootInspectionId !== basis.rootInspectionId || current.quantityReviewId !== basis.quantityReviewId ||
    current.scrapReviewId !== basis.scrapReviewId || current.fingerprint !== basis.fingerprint;
  const unavailable = basis.actualScrappedQuantity === null || !basis.rootInspectionId || !basis.quantityReviewId || !!basis.blockers.length;
  const problem = allocationProblem(rows, basis);
  const hasDraft = rows.some(row => row.qualityGroupId || row.sourceQuantityReviewId || row.quantity);
  function change(key: number, patch: Partial<Row>) { setRows(values => values.map(row => row.key === key ? { ...row, ...patch } : row)); setConfirmed(false); setError(""); }
  function remove(key: number) {
    if (removing !== null || busy || disabled || frozen || stale || rows.length < 2) return;
    setConfirmed(false);
    const finish = () => { setRows(values => values.filter(value => value.key !== key)); setRemoving(null); };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { setRemoving(key); removeTimer.current = window.setTimeout(finish, 150); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || disabled || stale || unavailable || frozen || removing !== null || !confirmed || problem) return;
    try {
      const date = new Date(at); if (!at || !Number.isFinite(date.getTime())) throw new Error("请填写实际报废归属发生时间");
      const input = AllocateQualityScrapInputSchema.parse({
        idempotencyKey: crypto.randomUUID(), productionVersionId: basis.productionVersionId, expectedProductionProjectionVersion: basis.projectionVersion,
        expectedRootInspectionId: basis.rootInspectionId, expectedQuantityReviewId: basis.quantityReviewId, expectedScrapReviewId: basis.scrapReviewId,
        expectedBasisFingerprint: basis.fingerprint, physicalSegregationConfirmed: confirmed, occurredAt: date.toISOString(),
        evidenceCode: evidence, evidenceAssetIds: assets.split(/\s+/).map(value => value.trim()).filter(Boolean),
        allocations: rows.map(row => ({ qualityGroupId: row.qualityGroupId, sourceQuantityReviewId: row.sourceQuantityReviewId, quantity: count(row.quantity) })),
      });
      onSubmit(input, event.currentTarget, formFingerprint(event.currentTarget));
    } catch (cause) { setError(cause instanceof Error && cause.name !== "ZodError" ? cause.message : "请核对完整归属行 凭证编号和真实附件 ID"); }
  }
  return <form aria-label="登记失败组报废归属" onSubmit={submit}>
    <p>本次仅明确已核准报废实物的原组归属 不改变原核准报废总量 不释放产能 不扣减或返还物料</p>
    <p>原生产版本 <code>{basis.productionVersionId}</code> · 固定依据 V{basis.projectionVersion}<br />
      原根检验 <code>{basis.rootInspectionId ?? "尚未固定"}</code> · 原数量核准 <code>{basis.quantityReviewId ?? "尚未核准"}</code></p>
    {stale && !frozen && <p className="qs-error" role="alert">原生产 数量核准或报废归属已变化 填写已保留 请关闭后重新读取 不自动替换原依据</p>}
    {unavailable && <p className="qs-error" role="alert">原核准报废数量或归属依据尚未具备 请先核对原数量凭证与阻断原因</p>}
    {basis.blockers.map(value => <p key={value} className="qs-error">{value}</p>)}
    {(failure || error) && <p className="qs-error" role="alert">{failure || error}</p>}
    {frozen && <div className="qs-note" role="status"><p>已保留本次完整原请求与原编号 同页重试不会另建归属 关闭填写窗后仍可从本生产记录恢复 离开或刷新页面不保证保留</p>
      <p>原请求编号 <code>{frozen.idempotencyKey}</code><br />原发生时间 {frozen.occurredAt}<br />
        原归属核准 <code>{frozen.expectedScrapReviewId ?? "尚无"}</code><br />原依据指纹 <code>{frozen.expectedBasisFingerprint}</code></p></div>}
    <fieldset className="qs-fields" disabled={busy} inert={!!frozen || disabled || stale || unavailable} aria-disabled={!!frozen || disabled || stale || unavailable}>
      {rows.map((row, index) => {
        const group = basis.groups.find(value => value.qualityGroupId === row.qualityGroupId);
        const lot = basis.lots.find(value => value.sourceQuantityReviewId === row.sourceQuantityReviewId);
        return <fieldset className={"qs-allocation" + (removing === row.key ? " qs-exiting" : "")} inert={removing === row.key} key={row.key} aria-label={"报废归属明细 " + (index + 1)}>
          <legend>报废归属明细 {index + 1}</legend>
          <div className="qs-field-grid">
            <label>原失败实物组<select aria-label="原失败实物组" required value={row.qualityGroupId} onChange={event => change(row.key, { qualityGroupId: event.target.value })}>
              <option value="">明确选择原实物组</option>{basis.groups.map(value => <option key={value.qualityGroupId} value={value.qualityGroupId}
                disabled={!value.active || value.result !== "failed" || value.maxAllocatableQuantity < 1 || !!value.allocationBlockers.length}>
                {value.label} · {value.active ? "活动组" : "已退休原组"} · 本次读取可归属 {value.maxAllocatableQuantity} · {value.qualityGroupId.slice(-8)}
              </option>)}
            </select></label>
            <label>新增报废批次<select aria-label="新增报废批次" required value={row.sourceQuantityReviewId} onChange={event => change(row.key, { sourceQuantityReviewId: event.target.value })}>
              <option value="">明确选择实际新增批次</option>{basis.lots.map(value => <option key={value.sourceQuantityReviewId} value={value.sourceQuantityReviewId}
                disabled={value.scope !== "groupable" || value.remainingQuantity < 1}>
                {value.sourceQuantityReviewId.slice(-8)} · 新增 {value.quantity} · 未归属 {value.remainingQuantity} · {qualityScrapLotScopeLabel(value.scope)}
              </option>)}
            </select></label>
            <label>本次归属数量<input aria-label="本次归属数量" required type="number" min={1} step={1}
              max={group && lot ? Math.min(group.maxAllocatableQuantity, lot.remainingQuantity, 100_000) : 100_000}
              value={row.quantity} onChange={event => change(row.key, { quantity: event.target.value })} /><small>原生产计数单位 可以只归属本批中的部分数量</small></label>
            {rows.length > 1 && <button type="button" disabled={removing !== null} onClick={() => remove(row.key)}><Trash2 size={14} aria-hidden="true" />移除此归属行</button>}
          </div>
          {group && <p>原组数量 {group.quantity} · 已归属报废 {group.scrappedQuantity} · 本次读取可归属上限 {group.maxAllocatableQuantity}<br />
            原组 <code>{group.qualityGroupId}</code> · 原检验 <code>{group.inspectionId}</code> · 原检验登记 {group.inspectionRecordedAt}</p>}
          {group?.allocationBlockers.map(value => <p key={value} className="qs-error">{value}</p>)}
          {lot && <p>新增报废 {lot.quantity} · 已归属 {lot.allocatedQuantity} · 未归属 {lot.remainingQuantity} · {qualityScrapLotScopeLabel(lot.scope)}<br />
            原数量核准 <code>{lot.sourceQuantityReviewId}</code> · 原数量报告 <code>{lot.reportId}</code><br />实际清点 {lot.observedAt} · 核准发生 {lot.reviewedAt}</p>}
        </fieldset>;
      })}
      <button type="button" disabled={rows.length >= 100 || removing !== null} onClick={() => { const key = nextRow.current++; setRows(values => [...values, { key, qualityGroupId: "", sourceQuantityReviewId: "", quantity: "" }]); setConfirmed(false); }}><Plus size={14} aria-hidden="true" />增加报废归属行</button>
      {hasDraft && problem && <p className="qs-error" role="status">{problem}</p>}
      <div className="qs-field-grid">
        <label>实际归属时间（本机当地时间）<input name="occurredAt" required type="datetime-local" step="0.001" value={at} onChange={event => setAt(event.target.value)} /></label>
        <label>报废归属凭证编号<input name="evidenceCode" required maxLength={160} pattern={"[A-Z0-9_:\\-]+"} value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
        <label className="qs-full">报废归属附件 ID（可选）<textarea name="evidenceAssetIds" rows={2} value={assets} onChange={event => setAssets(event.target.value)} placeholder="仅填写已有且有权读取的真实附件 ID 每行一个" /></label>
      </div>
      <label className="qs-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已逐件核对原失败组与新增报废批次 实物已隔离 各行没有重复 不把未通过检验自动当作实际报废</label>
    </fieldset>
    <p>报废归属 不等于库存处置 原产能与物料事实保持原记录 后续复检和补做须另行明确登记</p>
    <footer><button data-record-cancel type="button" disabled={busy} onClick={onClose}>返回报废归属记录</button>
      {frozen ? <><button className="primary" type="button" disabled={busy || disabled} onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />按原请求重试归属</button>
        {knownRejected && <button data-record-cancel type="button" disabled={busy} onClick={onDiscard}>结束已拒绝归属请求并重新读取</button>}</>
        : <button className="primary" disabled={busy || disabled || stale || unavailable || removing !== null || !confirmed || !!problem}><Check size={14} aria-hidden="true" />登记本次报废归属</button>}
    </footer>
  </form>;
}
