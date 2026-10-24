"use client";

import { ClipboardCheck, FileSearch } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentFulfillmentCommandView } from "@yummyai/contracts/ai/agent-fulfillment-command";
import type { FulfillmentCommandKind, FulfillmentCommandView } from "@yummyai/contracts/order/fulfillment-command";
import { FulfillmentCommandReceiptSummary } from "../order-centers/fulfillment-command-recovery";
import { OriginalRows } from "../finance/finance-command-summary";

export const agentFulfillmentCommandNames: Record<FulfillmentCommandKind, string> = {
  delivery_create: "准备原工厂交付包", delivery_feedback: "登记原工厂回执", production_milestone: "登记原生产进度",
  quality_inspection: "登记原生产质检", quality_group_inspection: "登记原实物分组质检", production_recovery: "登记原补做或恢复",
  whole_production_milestone: "登记原整单生产进度", whole_quality_inspection: "登记原整单质检", shipment_create: "建立原发货单",
  whole_shipment_create: "建立原整单包裹", shipment_version: "保存原包裹新版本", shipment_review: "审核原包裹版本",
  shipment_dispatch: "登记原实际交运", shipment_platform_confirmation: "登记原平台人工确认",
};
export const agentFulfillmentCommandStates: Record<FulfillmentCommandView["status"], string> = {
  prepared: "原填写已准备 尚未执行", executing: "原执行正在核对", uncertain: "原执行结果未知 请先只读核对", succeeded: "已取得原业务回执",
  rejected: "本次未完成 请核对原结果", cancelled: "原准备已取消", expired: "原填写已到期", acknowledged: "原结果已核对 私有副本已清理",
};
export function AgentFulfillmentPair({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
const labels: Record<string, string> = {
  requestId: "原协调请求编号", targetId: "固定原对象", packageId: "固定原交付包", versionId: "固定原包裹版本", kind: "原操作", input: "原填写",
  idempotencyKey: "原业务请求键", externalEventId: "原进度事件键", orderId: "原订单", orderLineId: "原商品行", lineId: "原商品行",
  productionOrderId: "原生产单", originalProductionOrderId: "原生产单", productionVersionId: "固定原生产版本", items: "原全部明细", packages: "原全部包裹",
  expectedProjectionVersion: "原进度版本", expectedProductionProjectionVersion: "原生产进度版本", expectedSequence: "原回执序号",
  expectedVersion: "原包裹版本号", expectedCurrentVersion: "原包裹当前版本号", expectedRootInspectionId: "原首次质检", parentGroupId: "原上级实物组",
  supplierId: "原供应商", factoryId: "原工厂", factoryVersionId: "原工厂版本", capabilityVersionId: "原工厂能力版本", type: "原处理类型",
  quantity: "原数量", unit: "原单位", remakeQuantity: "原补做数量", affectedQuantity: "原涉及数量", acceptedQuantity: "原接受数量", rejectedQuantity: "原拒收数量",
  qualityGroupId: "原实物组", groupId: "原实物组", groupIds: "原全部实物组", qualityStandardVersionId: "原质检标准版本", groups: "原实物分组",
  reason: "原原因与说明", reasonCode: "原原因代码", note: "原补充说明", reference: "原凭证", evidenceReference: "原核对凭证", evidence: "原实际依据",
  occurredAt: "原实际发生时间", inspectedAt: "原实际检验时间", confirmedAt: "原实际核对时间", expectedCompletionAt: "原预计完成时间", shipDate: "原计划发货时间",
  fileChecksum: "原文件校验值", productionUnit: "原生产单位", manufacturingUnit: "原制造单位", confirmedUnit: "原人工确认单位",
  manufacturing: "原固定制造依据", manufacturingVersionId: "原制造版本", manufacturingChecksum: "原制造校验值", capacityPlan: "原产能安排",
  allocations: "原全部产能分配", poolId: "原资源池", poolVersionId: "原资源池版本", localDate: "原工厂当地日期", code: "原记录代码", label: "原名称",
  evidenceAssetIds: "原依据文件编号", assetIds: "原依据文件编号", segregationConfirmed: "原实物隔离确认", physicalSelectionConfirmed: "原实物取用确认",
  reviewedArtwork: "原审核稿依据", artworkVersionId: "原审核稿版本", editorVersionId: "原制作版本", checksum: "原校验值", confirmed: "原人工确认",
  decision: "原审核决定", assessment: "原逐项质检结果", criterionResults: "原全部检验项", ratings: "原逐项评分", defects: "原缺陷", defectId: "原缺陷编号",
  result: "原检验结果", passed: "原是否通过", scoreBps: "原评分 万分位", formatVersion: "原记录格式版本", minimum: "原下限", maximum: "原上限",
  trackingNumber: "原物流单号", carrier: "原承运商", carrierCode: "原承运商代码", shippingService: "原物流服务", trackingUrl: "原物流引用",
  cost: "原费用记录", amountMinor: "原金额 最小货币单位", currency: "原币种", basis: "原费用依据类型", contentChecksum: "原内容校验值",
};
function FieldValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <>原文未提供 不补默认值</>;
  if (typeof value === "boolean") return <>{value ? "是" : "否"}</>;
  if (typeof value === "string" || typeof value === "number") return <span className="afc-preserve">{value === "" ? "原文为空" : String(value)}</span>;
  if (Array.isArray(value)) return <OriginalRows title="全部原记录" rows={value} render={item => <FieldValue value={item} />} />;
  if (typeof value === "object") return <dl className="afc-pairs">{Object.entries(value).map(([key, item]) => <AgentFulfillmentPair key={key} label={labels[key] ?? "原保存字段 " + key}><FieldValue value={item} /></AgentFulfillmentPair>)}</dl>;
  return <>原值当前不可核对</>;
}
export function AgentFulfillmentCommandSummary({ value }: { value: AgentFulfillmentCommandView }) {
  const native = value.native;
  return <>
    <section className="afc-section" aria-label="原履约真实状态与回执"><h4><ClipboardCheck size={15} aria-hidden="true" />原履约真实状态与回执</h4>
      <dl className="afc-pairs"><AgentFulfillmentPair label="原操作">{agentFulfillmentCommandNames[native.kind]}</AgentFulfillmentPair>
        <AgentFulfillmentPair label="原状态">{agentFulfillmentCommandStates[native.status]}</AgentFulfillmentPair>
        <AgentFulfillmentPair label="原订单"><code>{native.orderId}</code></AgentFulfillmentPair><AgentFulfillmentPair label="原固定对象"><code>{native.targetId}</code></AgentFulfillmentPair>
        <AgentFulfillmentPair label="原提交编号"><code>{native.id}</code></AgentFulfillmentPair><AgentFulfillmentPair label="原请求编号"><code>{native.requestId}</code></AgentFulfillmentPair>
        <AgentFulfillmentPair label="完整原请求校验值"><code>{native.requestChecksum}</code></AgentFulfillmentPair><AgentFulfillmentPair label="原填写保留至">{native.expiresAt}</AgentFulfillmentPair>
      </dl>
      {native.summary && <p>{native.summary.orderNumber} · {native.summary.lineCount} 个商品 · {native.summary.label}</p>}
      <details><summary>固定原商品范围 · {native.lineIds.length} 项</summary><ul>{native.lineIds.map(line => <li key={line}><code>{line}</code></li>)}</ul></details>
      {native.errorCode && <p className="afc-notice">{native.errorCode === "superseded" ? "原依据已被后续处理替代 请核对原单 不换版本执行" : native.errorCode === "source_unavailable" ? "原依据当前不可读或已到期 不从今天的资料补原文" : native.errorCode === "forbidden" ? "当前原业务权限不足" : "本次结果需按原请求继续核对 不建立替代操作"}</p>}
      {native.receipt && <FulfillmentCommandReceiptSummary value={native} />}
    </section>
    <section className="afc-section" aria-label="完整原履约填写核对"><h4><FileSearch size={15} aria-hidden="true" />完整原履约填写核对</h4>
      {value.original ? <><p className="afc-muted">以下为原业务拥有者保存的完整填写 保留原版本 数量 单位与人工核对依据 模型不会替代本次确认</p>
        <FieldValue value={value.original} /><p className="afc-notice">此处只登记原业务事实 不代表工厂实际接单 生产或平台已经接受发送 实际结果以原回执为准</p></>
        : <p className="afc-notice">原完整填写当前不可读或已清理 只保留原编号与状态 不允许根据摘要重建执行</p>}
    </section>
  </>;
}
