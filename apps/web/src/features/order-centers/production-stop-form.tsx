"use client";
import { useState, type FormEvent } from "react";
import { Check, RefreshCw } from "lucide-react";
import { ProductionQuantityReportInputSchema, ProductionQuantityReviewInputSchema,
  type ProductionQuantityBasis, type ProductionQuantityReportInput, type ProductionQuantityReviewInput,
  type ProductionQuantityReportView, type ProductionPhysicalQuantities } from "@yummyai/contracts/order/production-quantity";

export type ProductionStopIntent = { kind: "report"; input: ProductionQuantityReportInput } | { kind: "review"; input: ProductionQuantityReviewInput };
export type ProductionStopEditor = { basis: ProductionQuantityBasis; kind: "report" } | { basis: ProductionQuantityBasis; kind: "review"; report: ProductionQuantityReportView };
export const physicalQuantityLabels: Record<keyof ProductionPhysicalQuantities, string> = {
  unstartedQuantity: "未开工数量", inProcessQuantity: "在制数量", completedQuantity: "已完工数量（含已交运）", scrappedQuantity: "实际报废数量",
};
export const productionQuantityUnit = (unit: ProductionQuantityBasis["unit"]) => unit === "each" ? "件" : unit === "pair" ? "双" : unit === "set" ? "套" : "原单位待核对";
export function PhysicalQuantities({ quantities, unit }: { quantities: ProductionPhysicalQuantities | null; unit: ProductionQuantityBasis["unit"] }) {
  return <dl className="ps-pairs">{(Object.keys(physicalQuantityLabels) as Array<keyof ProductionPhysicalQuantities>).map(key => <div key={key}><dt>{physicalQuantityLabels[key]}</dt><dd>{quantities?.[key] === null || quantities?.[key] === undefined ? "未知 尚未清点" : `${quantities[key]} ${productionQuantityUnit(unit)}`}</dd></div>)}</dl>;
}
const localDateTime = (value?: string) => { const now = value ? new Date(value) : new Date(), pad = (value: number) => String(value).padStart(2, "0");
  return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-") + "T" + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join(":") + "." + String(now.getMilliseconds()).padStart(3, "0"); };
function instant(value: string) { const date = new Date(value); if (!value || !Number.isFinite(date.getTime())) throw new Error("请填写实际发生时间"); return date.toISOString(); }
function count(value: string, nullable = false) {
  if (nullable && value === "") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 6 || Number(value) > 100_000) throw new Error("数量须为 0 至 100000 的整数 未知数量请留空");
  return Number(value);
}
export function ProductionStopForm({ editor, current, busy, disabled, frozen, failure, knownRejected, onSubmit, onRetry, onClose, onDiscard }: {
  editor: ProductionStopEditor; current: ProductionQuantityBasis | null; busy: boolean; disabled: boolean;
  frozen: ProductionStopIntent | null; failure: string; knownRejected: boolean;
  onSubmit(intent: ProductionStopIntent): void; onRetry(): void; onClose(): void; onDiscard(): void;
}) {
  const { basis } = editor, review = editor.kind === "review" ? editor.report : null;
  const [quantities, setQuantities] = useState<Record<keyof ProductionPhysicalQuantities, string>>(() => Object.fromEntries((Object.keys(physicalQuantityLabels) as Array<keyof ProductionPhysicalQuantities>).map(key => [key, frozen?.kind === "report" ? frozen.input.quantities[key]?.toString() ?? "" : ""])) as Record<keyof ProductionPhysicalQuantities, string>);
  const [at, setAt] = useState(() => localDateTime(frozen ? frozen.kind === "report" ? frozen.input.observedAt : frozen.input.occurredAt : undefined)),
    [evidence, setEvidence] = useState(frozen?.input.evidenceCode ?? ""), [assets, setAssets] = useState(frozen?.kind === "report" ? frozen.input.evidenceAssetIds.join("\n") : "");
  const [delta, setDelta] = useState(frozen?.kind === "review" ? String(frozen.input.stoppedDelta) : ""), [allPools, setAllPools] = useState(frozen?.kind === "review" ? frozen.input.unstartedAcrossAllPoolsConfirmed : false), [confirmed, setConfirmed] = useState(false), [error, setError] = useState("");
  const stale = !current || current.productionVersionId !== basis.productionVersionId || current.projectionVersion !== basis.projectionVersion || current.reviewId !== basis.reviewId || current.fingerprint !== basis.fingerprint;
  const reportQuantities = review?.input.quantities, allKnown = !!reportQuantities && Object.values(reportQuantities).every(value => value !== null);
  const reportTotal = allKnown ? Object.values(reportQuantities!).reduce<number>((sum, value) => sum + value!, 0) : null;
  const reportStale = !!review && (review.productionVersionId !== basis.productionVersionId || review.previousReviewId !== basis.reviewId || review.basisFingerprint !== basis.fingerprint);
  const reviewProblem = review ? !allKnown ? "这份报告含未知数量 请先登记完整实物清点报告再核准"
    : reportStale ? "这份报告的原核准记录或生产依据已变化 请另行登记实际清点 不能替换原报告"
      : reportTotal! + basis.cumulativeStoppedQuantity !== basis.quantity ? "这份报告的四项数量与此前已核准停做量未覆盖原数量"
        : reportQuantities!.completedQuantity! < basis.completedLowerBound ? "报告已完工数量低于真实质检或装箱分配下界 请重新核对实物来源"
          : delta && Number(delta) > reportQuantities!.unstartedQuantity! ? "新增停做不能超过这份报告的未开工数量" : "" : "";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || disabled || stale || frozen || !confirmed || reviewProblem) return;
    try {
      const common = { idempotencyKey: crypto.randomUUID(), expectedProductionProjectionVersion: basis.projectionVersion,
        expectedReviewId: basis.reviewId, expectedBasisFingerprint: basis.fingerprint, evidenceCode: evidence };
      if (review) onSubmit({ kind: "review", input: ProductionQuantityReviewInputSchema.parse({ ...common, reportId: review.id,
        stoppedDelta: count(delta), unstartedAcrossAllPoolsConfirmed: allPools, occurredAt: instant(at) }) });
      else onSubmit({ kind: "report", input: ProductionQuantityReportInputSchema.parse({ ...common, productionVersionId: basis.productionVersionId,
        observedAt: instant(at), quantities: Object.fromEntries((Object.keys(quantities) as Array<keyof ProductionPhysicalQuantities>).map(key => [key, count(quantities[key], true)])),
        evidenceAssetIds: assets.split(/\s+/).map(value => value.trim()).filter(Boolean) }) });
    } catch (cause) { setError(cause instanceof Error && cause.name !== "ZodError" ? cause.message : "请核对完整数量 凭证编号与真实附件 ID"); }
  }
  return <form aria-label={review ? "核准本次新增停做" : "登记实际生产数量"} onSubmit={submit}>
    <p>原生产数量 {basis.quantity} {productionQuantityUnit(basis.unit)} · 此前已核准停做 {basis.cumulativeStoppedQuantity} {productionQuantityUnit(basis.unit)}</p>
    <p>原生产版本 <code>{basis.productionVersionId}</code> · 本次固定生产依据 V{basis.projectionVersion}</p>
    {stale && !frozen && <p className="ps-error" role="alert">当前生产 数量或权限依据已变化 填写已保留 请关闭后重新读取 不自动替换原依据</p>}
    {(failure || error) && <p className="ps-error" role="alert">{failure || error}</p>}
    {frozen && <div className="ps-note"><p>已保留本次完整原请求和原编号 本页重试不会另建提交 关闭填写窗后仍可从本生产记录恢复 离开或刷新页面不保证保留</p>
      <p>原请求编号 <code>{frozen.input.idempotencyKey}</code><br />原发生时间 {frozen.kind === "report" ? frozen.input.observedAt : frozen.input.occurredAt}<br />原核准 <code>{frozen.input.expectedReviewId ?? "尚无"}</code><br />原依据指纹 <code>{frozen.input.expectedBasisFingerprint}</code></p></div>}
    {review && <section aria-label="本次核准所用原报告"><p>原数量报告 <code>{review.id}</code> · 清点时间 {review.input.observedAt}</p><PhysicalQuantities quantities={review.input.quantities} unit={basis.unit} />
      <p>已完工包含已交运 不另加交运数量 报废必须是实际处置记录 不能把未通过质检当成报废</p></section>}
    {reviewProblem && <p role="alert" className="ps-error">{reviewProblem}</p>}
    <fieldset disabled={busy} inert={!!frozen || disabled || stale} aria-disabled={!!frozen || disabled || stale}>
      <div className="ps-field-grid">{!review && (Object.keys(physicalQuantityLabels) as Array<keyof ProductionPhysicalQuantities>).map(key => <label key={key}>{physicalQuantityLabels[key]}<input type="number" min={0} max={100_000} step={1} name={key} value={quantities[key]} placeholder="未知时留空" onChange={event => { setQuantities(value => ({ ...value, [key]: event.target.value })); setConfirmed(false); }} /><small>{productionQuantityUnit(basis.unit)} · 留空明确记为未知 不补成 0</small></label>)}
        {review && <label className="ps-full">本次新增停做数量<input required type="number" min={0} max={reportQuantities?.unstartedQuantity ?? 100_000} step={1} name="stoppedDelta" value={delta} onChange={event => { setDelta(event.target.value); setAllPools(false); setConfirmed(false); }} /><small>填写 0 可以核准后续清点 不增加停做数量 正数仅适用于全部绑定工序均未投入的实物</small></label>}
        <label>{review ? "实际核准时间（本机当地时间）" : "实际清点时间（本机当地时间）"}<input required type="datetime-local" step="0.001" name="occurredAt" value={at} onChange={event => setAt(event.target.value)} /></label>
        <label>数量凭证编号<input required name="evidenceCode" maxLength={160} pattern={"[A-Z0-9_:\\-]+"} placeholder="例如 FACTORY_COUNT_001" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
        {!review && <label className="ps-full">数量凭证附件 ID（可选）<textarea name="evidenceAssetIds" rows={2} value={assets} onChange={event => setAssets(event.target.value)} placeholder="仅填写已有且有权读取的实际附件 ID 每行一个" /></label>}
      </div>
      {!review && <p>四项数量互斥 已完工包含已交运 留空可以先保存报告 核准前须全部清点清楚 数量报告本身不释放产能</p>}
      {review && <label className="ps-check"><input type="checkbox" required={Number(delta) > 0} checked={allPools} onChange={event => setAllPools(event.target.checked)} />已逐件核对新增停做实物在全部绑定资源池和工序均未投入 不能只按单个工序比例释放</label>}
      <label className="ps-check"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{review ? "已核对原报告 全部数量 原核准与本次新增停做依据" : "已按实际实物登记四项数量 未清点处保留未知 已完工没有重复加上已交运"}</label>
    </fieldset>
    <footer><button data-record-cancel type="button" disabled={busy} onClick={onClose}>返回数量记录</button>
      {frozen ? <><button className="primary" type="button" disabled={busy} onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />按原请求重试核对</button>{knownRejected && <button data-record-cancel type="button" disabled={busy} onClick={onDiscard}>结束已拒绝请求并重新读取</button>}</>
        : <button className="primary" disabled={busy || disabled || stale || !confirmed || !!reviewProblem}><Check size={14} aria-hidden="true" />{review ? "核准本次新增停做" : "保存本次数量报告"}</button>}</footer>
  </form>;
}
