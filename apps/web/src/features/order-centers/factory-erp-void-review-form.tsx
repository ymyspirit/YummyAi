"use client";

import { useState, type FormEvent } from "react";
import type { z } from "zod";
import { Check, X } from "lucide-react";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { ReviewFactoryErpVoidSchema, type FactoryErpVoidBasisSchema, type FactoryErpVoidObservationIdentity,
  type FactoryErpVoidObservationView, type FactoryErpVoidReviewResult, type FactoryErpVoidSummary, type ReviewFactoryErpVoid,
} from "@yummyai/contracts/order/factory-erp-void-review";
import type { FactoryErpEvidenceSource } from "@yummyai/contracts/order/factory-erp-source-pin";

export type FactoryErpVoidIntent = { bindingId: string; input: ReviewFactoryErpVoid; sent: boolean };
export type FactoryErpVoidSource = { source: FactoryErpEvidenceSource; rawStatus: string };
type Outcome = ReviewFactoryErpVoid["outcome"];
type Reason = ReviewFactoryErpVoid["reasonCode"];
export const factoryErpVoidOutcomeLabel: Record<Outcome, string> = {
  confirmed_active: "已核对 继续正常工厂跟进", confirmed_voided: "已核对工厂作废 仍需订单后续",
  export_record_incorrect: "已核对 原导出状态有误", followup_required: "仍待跟进 未解除待核对",
};
const reasonLabels: Record<Reason, string> = { factory_contact: "操作者已实际沟通工厂", corrected_export: "已核对有效更正导出行",
  conflicting_records: "记录之间仍有冲突", binding_mismatch: "绑定组不符 需要解除或更正", needs_factory_confirmation: "仍需工厂确认" };

export function FactoryErpVoidCounts({ value }: { value: FactoryErpVoidSummary }) {
  return <div className="fei-void-counts" aria-label="全部作废观察核对计数">
    <p>全部作废观察 {value.total} 条 · 待核对 {value.pending} 条 · 已核对但需订单后续 {value.requiresOrderHandling} 条</p>
    <p className="fei-hint">这是服务器按完整观察集合读取的计数 不是当前页统计 新作废观察仍需逐条核对</p>
  </div>;
}
function SourcePins({ value }: { value: FactoryErpEvidenceSource }) {
  return <dl className="fei-pairs"><div><dt>原导入 ID</dt><dd><code>{value.importId}</code></dd></div>
    <div><dt>原表行号</dt><dd>{value.rowNumber}</dd></div><div><dt>原字节校验值</dt><dd><code>{value.fileChecksum}</code></dd></div>
    <div><dt>固定预览校验值</dt><dd><code>{value.previewChecksum}</code></dd></div></dl>;
}
export function FactoryErpVoidObservationPins({ value }: { value: FactoryErpVoidObservationIdentity }) {
  return <div className="fei-void-pins"><dl className="fei-pairs">
    <div><dt>原作废观察 ID</dt><dd><code>{value.id}</code></dd></div><div><dt>原观察序号</dt><dd>{value.sequence}</dd></div>
    <div><dt>原行校验值</dt><dd><code>{value.rowChecksum}</code></dd></div><div><dt>原观察登记时间</dt><dd>{value.recordedAt}</dd></div>
  </dl><SourcePins value={value} /></div>;
}
export function FactoryErpVoidReviewReceipt({ value, historical = false }: { value: FactoryErpVoidReviewResult; historical?: boolean }) {
  return <section className="fei-receipt" aria-label={historical ? "工厂作废核对历史回执" : "工厂作废核对原回执"}>
    <h4 tabIndex={-1}>{historical ? "原工厂作废核对回执" : "工厂作废核对已登记"}</h4><p>{factoryErpVoidOutcomeLabel[value.outcome]} · {reasonLabels[value.reasonCode]}</p>
    <p>操作者人工声明 不是工厂 API 验真 原观察与订单 生产 质检 数量 库存 产能及物流事实未由此更改</p>
    <dl className="fei-pairs"><div><dt>实际核对 ID</dt><dd><code>{value.id}</code></dd></div>
      <div><dt>原绑定 ID</dt><dd><code>{value.bindingId}</code></dd></div><div><dt>该观察核对修订</dt><dd>{value.reviewRevision}</dd></div>
      <div><dt>前一核对凭据</dt><dd>{value.previousReviewId ? <code>{value.previousReviewId}</code> : "首次核对"}</dd></div>
      <div><dt>本次固定绑定修订</dt><dd>{value.originalBindingRevision}</dd></div><div><dt>完整原组校验值</dt><dd><code>{value.originalItemsChecksum}</code></dd></div>
      <div><dt>本次固定全部观察序号</dt><dd>{value.originalObservationSequence}</dd></div><div><dt>核对登记时间</dt><dd>{value.createdAt}</dd></div>
      <div><dt>原请求校验值</dt><dd><code>{value.requestChecksum}</code></dd></div></dl>
    <details className="fei-details"><summary>核对本次保存的准确作废来源</summary><FactoryErpVoidObservationPins value={value.observation} /></details>
    <details className="fei-details"><summary>核对本次明确采用的证据来源</summary><SourcePins value={value.source} /></details>
    {value.outcome === "confirmed_voided" && <p className="fei-void-warning">核对完成不等于订单已取消或工厂已停做 请在原订单流程处理真实后续</p>}
    {value.outcome === "followup_required" && <p className="fei-void-warning">本条仍待跟进 不解除待核对{value.reasonCode === "binding_mismatch" ? " 请另行解除或更正完整原组绑定" : ""}</p>}
    <p className="fei-hint">此为本次保存的不可变回执 当前情况需另行读取 不用今天状态改写原结果</p>
  </section>;
}
export function FactoryErpVoidRequestSummary({ value }: { value: FactoryErpVoidIntent }) {
  const input = value.input;
  return <section className="fei-review" aria-label="固定原工厂作废核对请求"><h4>核对固定原工厂作废请求</h4>
    <p>{factoryErpVoidOutcomeLabel[input.outcome]} · {reasonLabels[input.reasonCode]} · 操作者人工声明</p>
    <dl className="fei-pairs"><div><dt>原绑定 ID</dt><dd><code>{value.bindingId}</code></dd></div><div><dt>固定绑定修订</dt><dd>{input.expectedBindingRevision}</dd></div>
      <div><dt>完整原组校验值</dt><dd><code>{input.expectedItemsChecksum}</code></dd></div><div><dt>固定全部观察序号</dt><dd>{input.expectedObservationSequence}</dd></div>
      <div><dt>预期前一核对凭据</dt><dd>{input.expectedPreviousReviewId ? <code>{input.expectedPreviousReviewId}</code> : "尚无该观察的核对"}</dd></div>
      <div><dt>本次固定原请求编号</dt><dd><code>{input.idempotencyKey}</code></dd></div></dl>
    <h4>触发异常的原作废观察</h4><FactoryErpVoidObservationPins value={input.observation} />
    <h4>本次明确采用的有效证据来源</h4><SourcePins value={input.source} />
    <p>来源可以是原作废行或同编号有效新行 新来源不改写旧观察 不自动取消 停做 退款 返库或更改生产数量</p>
    <p className="fei-hint">{value.sent ? "原请求已发出 响应未知只能按固定正文和编号恢复 不自动重基" : "原请求尚未登记 请核对后明确确认"}</p>
  </section>;
}
export function FactoryErpVoidReviewForm({ basis, observation, source, disabled, onPrepare, onCancel }: {
  basis: z.infer<typeof FactoryErpVoidBasisSchema>; observation: FactoryErpVoidObservationView; source: FactoryErpVoidSource; disabled: boolean;
  onPrepare(value: FactoryErpVoidIntent): void; onCancel(): void;
}) {
  const [outcome, setOutcome] = useState<Outcome | "">(""), [reason, setReason] = useState<Reason | "">(""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState("");
  const followup = outcome === "followup_required", allowedReasons: Reason[] = followup ? ["conflicting_records", "binding_mismatch", "needs_factory_confirmation"] : ["factory_contact", "corrected_export"];
  const correctedMatches = reason !== "corrected_export" || (outcome === "confirmed_voided" ? source.rawStatus === "已作废" : ["已审核", "已出库"].includes(source.rawStatus));
  const ready = !!outcome && !!reason && allowedReasons.includes(reason) && correctedMatches && confirmed && basis.state === "active";
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || !ready) return;
    const { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt } = observation;
    const input = ReviewFactoryErpVoidSchema.safeParse({ expectedBindingRevision: basis.bindingRevision, expectedItemsChecksum: basis.itemsChecksum,
      expectedObservationSequence: basis.observationSequence, observation: { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt },
      expectedPreviousReviewId: observation.latestReview?.id ?? null, source: source.source, outcome, reasonCode: reason,
      provenance: "operator_attested", confirmed: true, idempotencyKey: createEntityId() });
    if (!input.success) { setError("原观察 关联修订或结论依据无法核对 未生成替代请求"); return; }
    onPrepare({ bindingId: basis.bindingId, input: input.data, sent: false });
  }
  return <form className="fei-form fei-void-form" aria-label="登记单条工厂作废核对" onSubmit={prepare}>
    <h4>明确核对这条原作废观察</h4><FactoryErpVoidObservationPins value={observation} />
    <p>已明确选择证据来源 原表第 {source.source.rowNumber} 行 · 原状态 {source.rawStatus}</p><SourcePins value={source.source} />
    <fieldset disabled={disabled || basis.state !== "active"}>
      <label>核对结论<select aria-label="核对结论" required value={outcome} onChange={event => { setOutcome(event.target.value as Outcome | ""); setReason(""); setConfirmed(false); }}>
        <option value="">请选择实际核对结论</option>{Object.entries(factoryErpVoidOutcomeLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>核对依据类型<select aria-label="核对依据类型" required value={reason} onChange={event => { setReason(event.target.value as Reason | ""); setConfirmed(false); }}>
        <option value="">明确选择实际依据</option>{allowedReasons.map(key => <option value={key} key={key}>{reasonLabels[key]}</option>)}
      </select></label>
      {!correctedMatches && <p role="alert" className="oc-delivery-error fei-wide">更正导出行状态与所选结论不符 请关闭填写并另行明确选择有效来源 不自动替换原行</p>}
      {reason === "factory_contact" && <p className="fei-hint fei-wide">仅在已经实际沟通后选择 此处记录人工核对声明 不冒充工厂系统认证 请勿录入私人聊天内容</p>}
      {reason === "binding_mismatch" && <p className="fei-void-warning fei-wide">绑定不符仍待跟进 请另走完整原组解除或更正 核对按钮不改绑定</p>}
      {outcome === "confirmed_voided" && <p className="fei-void-warning fei-wide">该结论不表示订单已取消或工厂已停做 后续仍使用原订单与生产凭据处理</p>}
      <label className="fei-check fei-wide"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对这条准确作废观察 完整原组和明确证据 并确认仅登记人工核对结论</label>
      <div className="fei-actions fei-wide"><button className="oc-button primary" type="submit" disabled={disabled || !ready}><Check size={14} aria-hidden="true" />固定原核对请求并复核</button>
        <button className="oc-button" type="button" onClick={onCancel}><X size={14} aria-hidden="true" />关闭未提交的作废核对</button></div>
    </fieldset>{error && <p role="alert" className="oc-delivery-error">{error}</p>}
  </form>;
}
