"use client";
import { useState, type ReactNode } from "react";
import { ClipboardCheck, FileSearch } from "lucide-react";
import type { AgentCommandDomainSchema, AgentCommandOwnerSnapshot, AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import type { z } from "zod";
import { FinanceCommandOriginalSummary, FinanceCommandResultSummary, financeCommandNames, OriginalRows } from "../finance/finance-command-summary";
import { AdCommandOriginalSummary, adCommandNames } from "../customer-intelligence/advertising-command-forms";
import { ProcurementOriginalSummary } from "../procurement/procurement-command-workbench";
import { procurementActionNames } from "../procurement/procurement-cycle-form";

export const agentOperationDomainNames: Record<z.infer<typeof AgentCommandDomainSchema>, string> = { procurement: "采购", incoming: "来料", production: "生产", finance: "财务", advertising: "广告" };
export const agentOperationStateNames: Record<AgentCommandView["state"], string> = {
  preparing: "正在核对原准备", prepared: "原命令已准备 尚未执行业务", executing: "正在核对执行回执", succeeded: "原业务结果已登记", cancelled: "原准备已取消",
  expired: "原填写已到期", rejected: "原业务未执行", unknown: "原执行结果未知", unavailable: "原业务资料当前不可读",
};
const incomingNames: Record<string, string> = { publish_standard: "发布来料检验标准", record_arrival: "登记实际到货", record_inspection: "登记来料检验", review_inspection: "审核来料处置", post_inspection: "登记实际入账", return_rejected: "登记拒收退回" };
const productionNames: Record<string, string> = { approved_design: "按已批准设计下达生产", reviewed_line: "按原订单行审核稿下达生产", reviewed_order: "按原整单审核稿下达生产" };
export function agentOperationName(domain: AgentCommandView["domain"], kind: string) {
  const names: Record<string, string> = domain === "finance" ? financeCommandNames : domain === "advertising" ? adCommandNames : domain === "procurement" ? procurementActionNames : domain === "incoming" ? incomingNames : productionNames;
  return names[kind] ?? "原业务操作 " + kind;
}
export function AgentOperationPair({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
export function AgentOperationNativeSummary({ snapshot }: { snapshot: AgentCommandOwnerSnapshot }) {
  const native = snapshot.native;
  const statusNames: Record<string, string> = { prepared: "原命令待执行", executing: "正在核对执行结果", succeeded: "原业务实际结果已登记", uncertain: "原执行结果待核对", rejected: "原业务未执行", cancelled: "原准备已取消", expired: "原填写已到期" };
  return <section className="ao-native" aria-label="原业务真实状态与回执"><h4><ClipboardCheck size={15} />原业务真实状态与回执</h4>
    <dl className="ao-pairs"><AgentOperationPair label="原业务归属">{agentOperationDomainNames[native.domain]}</AgentOperationPair><AgentOperationPair label="原命令 ID"><code>{native.view.id}</code></AgentOperationPair>
      <AgentOperationPair label="原命令状态">{statusNames[native.view.status] ?? native.view.status}</AgentOperationPair><AgentOperationPair label="原填写是否已确认清理">{native.view.acknowledged ? "已确认清理" : "尚未确认清理"}</AgentOperationPair>
      {native.domain === "advertising" && <AgentOperationPair label="原广告账户"><code>{native.view.accountId}</code></AgentOperationPair>}
      {native.domain === "production" ? <AgentOperationPair label="原生产订单"><code>{native.view.orderId}</code></AgentOperationPair> : <AgentOperationPair label="原业务目标"><code>{native.view.targetId ?? "新建范围"}</code></AgentOperationPair>}
    </dl>
    {native.domain === "finance" && native.view.result && <FinanceCommandResultSummary result={native.view.result} />}
    {native.domain === "production" && native.view.receipt && <><p className="ao-notice">原生产安排回执 引用以下真实 ID 不保证本次新建 不表示工厂接受 实际生产或发货</p><OriginalRows title="原回执生产安排" rows={native.view.receipt.productionOrderIds} render={value => <code>{value}</code>} /></>}
    {native.domain !== "finance" && native.domain !== "production" && native.view.result && <dl className="ao-pairs"><AgentOperationPair label="实际结果 ID"><code>{native.view.result.id}</code></AgentOperationPair>
      {"version" in native.view.result && <AgentOperationPair label="实际结果版本">{native.view.result.version ?? "此原回执不含版本"}</AgentOperationPair>}
      {"parentId" in native.view.result && <AgentOperationPair label="实际结果父记录"><code>{native.view.result.parentId ?? "无父记录"}</code></AgentOperationPair>}</dl>}
    {native.domain !== "production" && native.view.blockReason && <p className="ao-notice">{({ basis_changed: "原版本或业务依据已变化 原填写保持 不能自动换成最新版本执行", permission_denied: "当前域权限不足以执行这笔原提交", input_unavailable: "原填写暂不可读 不重建或执行替代正文", expired: "原填写已到期 既有业务事实仍保留" })[native.view.blockReason]}</p>}
    {native.domain === "production" && native.view.summary && <dl className="ao-pairs"><AgentOperationPair label="原订单编号">{native.view.summary.orderNumber}</AgentOperationPair><AgentOperationPair label="原组商品数／数量">{native.view.summary.lineCount}／{native.view.summary.quantity}</AgentOperationPair><AgentOperationPair label="原工厂">{native.view.summary.factoryName ?? "原摘要未保留"}</AgentOperationPair><AgentOperationPair label="原预计完成">{native.view.summary.expectedCompletionAt}</AgentOperationPair></dl>}
    <p className="ao-muted">这是这笔原命令的受权核对结果 与随后读取的当前余额 库存或履约进度分开</p>
  </section>;
}
export function AgentOperationOriginalSummary({ snapshot }: { snapshot: AgentCommandOwnerSnapshot }) {
  const original = snapshot.original;
  if (!original) return <p className="ao-notice">原完整填写当前不可读取 不根据模型摘要或今天的业务列表重建原文 不能确认执行</p>;
  return <section className="ao-original" aria-label="完整原业务填写核对"><h4><FileSearch size={15} />完整原业务填写核对</h4>
    <p className="ao-muted">只读展示原业务保存的正文 不替换版本 预览校验值 或幂等键 缺失单位和币种保持待核对</p>
    {original.domain === "finance" ? <FinanceCommandOriginalSummary original={original.command} /> : original.domain === "advertising" ? <AdCommandOriginalSummary original={original.command} /> :
      original.domain === "procurement" ? <ProcurementOriginalSummary original={original.command} basis={snapshot.native.domain === "procurement" ? snapshot.native.view.reviewBasis : null} /> :
        <><h5>{agentOperationName(original.domain, original.command.kind)}</h5><OriginalObject value={original.command.input} open />
          {original.domain === "incoming" && original.command.kind === "return_rejected" && <p>原拒收处置 ID <code>{original.command.postingId}</code></p>}
          {original.domain === "incoming" && ["record_inspection", "post_inspection", "return_rejected"].includes(original.command.kind) && <p className="ao-notice">原请求没有另附实际批次单位时 数量只显示原保存值 单位须核对原批次 不从当前物料资料猜测</p>}
          {original.domain === "production" && <p className="ao-notice">确认后可能建立真实生产安排 沿用原审核文件 制造版本 单位确认与产能计划 原组全部成功与已有安排以实际回执为准</p>}
        </>}
    {(original.domain === "finance" || original.domain === "advertising" || original.domain === "procurement") && <details><summary>逐项读取全部原保存字段</summary><OriginalObject value={original.command} open /></details>}
    {original.domain === "finance" && ["payment_record", "payment_adjustment_record", "payment_allocate", "allocation_release"].includes(original.command.kind) && <p className="ao-notice">这里只登记付款 退款或核销事实 不发起银行转账或银行退款</p>}
  </section>;
}
const fields: Record<string, string> = {
  kind: "原操作类型", targetId: "原固定目标", accountId: "原广告账户", input: "原完整填写", idempotencyKey: "原幂等请求键", code: "原编号", name: "原名称", title: "原标题", reasonCode: "原原因代码", reason: "原原因", notes: "原补充说明", instructions: "原生产要求",
  expectedVersion: "原固定前版", expectedRevision: "原固定修订", expectedProjectionVersion: "原固定投影版本", expectedRequisitionVersion: "原申请版本", expectedPurchaseOrderVersion: "原采购版本", expectedInspectionVersion: "原检验版本", expectedEditorVersionId: "原制作版本 ID", expectedSourceVersionId: "原来源版本 ID", expectedFingerprint: "原依据校验值", expectedNetAmountMinor: "固定原净额 最小货币单位", previewChecksum: "原预览校验值",
  lines: "原全部明细", items: "原全部组项", lineId: "原订单行 ID", orderLineId: "原订单行 ID", orderId: "原订单 ID", lineKey: "原明细标识", stockItemId: "原物料 ID", supplierId: "原供应商 ID", supplierIds: "原全部供应商 ID", quoteId: "原报价 ID", requisitionId: "原申请 ID",
  quantity: "原数量", unit: "原单位", unitCostMinor: "原报价 最小货币单位", priceBasisQuantity: "原计价数量", amountMinor: "原金额 最小货币单位", currency: "原币种", destinationLocationId: "原收货库位 ID", holdingLocationId: "原保管库位 ID", rejectionLocationId: "原拒收库位 ID", lotCode: "原批号", expiresAt: "原有效期限",
  arrivedAt: "实际到货时间", measuredAt: "实际测量时间", postedAt: "实际入账时间", returnedAt: "实际退回时间", externalReference: "原交接凭据", sampleQuantity: "原抽样数量", acceptedQuantity: "原接受数量", rejectedQuantity: "原拒收数量", rejectionReason: "原拒收原因", readings: "原全部测量值", criterionCode: "原检验项代码", value: "原测量值", decision: "原核准决定", ownershipConfirmation: "原实际拥有确认", sourceReference: "原标准来源", criteria: "原全部检验项", label: "原显示名称", type: "原类型", required: "原必需项", minimum: "原下限", maximum: "原上限", expected: "原要求值",
  factoryVersionId: "原工厂版本 ID", capabilityVersionId: "原工厂能力版本 ID", expectedCompletionAt: "原预计完成时间", fileId: "原生产文件 ID", fileChecksum: "原生产文件校验值", manufacturing: "原制造依据", manufacturingVersionId: "原制造版本 ID", manufacturingChecksum: "原制造校验值", confirmed: "原人工确认", confirmedUnit: "原确认单位", productionUnit: "原生产单位", manufacturingUnit: "原制造单位", capacityPlan: "原产能计划", allocations: "原全部分配", poolId: "原资源池 ID", poolVersionId: "原资源池版本 ID", localDate: "原工厂当地日期", artworkVersionId: "原制作版本 ID", editorVersionId: "原编辑版本 ID", designVersionId: "原设计版本 ID",
  files: "原全部来源文件", fileName: "原文件名", content: "原完整文件文本", expectedAt: "原预计到货时间", validUntil: "原有效期", responseDueAt: "原询价截止", minimumOrderQuantity: "原最低起订数量", leadTimeDays: "原交期天数", purpose: "原采购用途", issuedAt: "原开具时间", invoiceNumber: "原发票编号", invoicedQuantity: "本张开票数量", inputChecksum: "原输入校验值", sourceChecksum: "原来源校验值", revision: "原修订", checksum: "原校验值",
};
function OriginalText({ text }: { text: string }) {
  const [page, setPage] = useState(0), size = 20_000, pages = Math.max(1, Math.ceil(text.length / size)), selected = Math.min(page, pages - 1);
  return <><p className="ao-muted">完整原文 {text.length} 字符 · 本段 {selected + 1} / {pages} 不裁剪原保存正文</p>{pages > 1 && <nav className="ao-actions"><button type="button" disabled={!selected} onClick={() => setPage(selected - 1)}>上段原文本</button><button type="button" disabled={selected + 1 >= pages} onClick={() => setPage(selected + 1)}>下段原文本</button></nav>}<pre>{text.slice(selected * size, (selected + 1) * size)}</pre></>;
}
function OriginalValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <>原文未填写 不补默认值</>;
  if (typeof value === "boolean") return <>{value ? "是" : "否"}</>;
  if (typeof value === "string") return value.length > 2000 || value.includes("\n") ? <OriginalText text={value} /> : <span className="ao-preserve">{value === "" ? "原文为空" : value}</span>;
  if (typeof value === "number") return <>{String(value)}</>;
  if (Array.isArray(value)) return <OriginalRows title="完整原记录" rows={value} render={row => <OriginalValue value={row} />} />;
  if (typeof value === "object") return <OriginalObject value={value} />;
  return <>原值类型当前无法显示 请重新核对原凭据</>;
}
function OriginalObject({ value, open = false }: { value: object; open?: boolean }) {
  const [expanded, setExpanded] = useState(open), entries = Object.entries(value);
  const content = <dl className="ao-pairs">{entries.map(([key, item]) => <AgentOperationPair key={key} label={fields[key] ?? "原字段 " + key}><OriginalValue value={item} /></AgentOperationPair>)}</dl>;
  if (open) return content;
  return <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>原保存依据 · {entries.length} 项</summary>{expanded && content}</details>;
}
