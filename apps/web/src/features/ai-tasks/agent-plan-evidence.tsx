"use client";
import { CheckCheck, ListChecks } from "lucide-react";
import type { AgentPlanView } from "@yummyai/contracts/ai/agent-plan";
import { AgentLoopCollectionEvidence, AgentLoopCostEvidence, AgentLoopStepEvidence, agentLoopStatusLabels } from "./agent-loop-evidence";

export const agentPlanStatusLabels: Record<AgentPlanView["status"], string> = { ...agentLoopStatusLabels, completed: "模型计划已生成", partial: "模型计划部分完成", stopped: "已停止模型后续步骤", uncertain: "模型提交结果不确定" };

type PlanClaim = NonNullable<AgentPlanView["result"]>["claims"][number];
const fields: Record<PlanClaim["field"], string> = {
  total: "原集合总数", category: "异常类别", status: "原状态", eventMissing: "原事件缺失", sequence: "异常序号", orderSequence: "订单序号",
  openedAt: "异常发生时间", resolvedAt: "异常解决时间", unit: "库存单位", physicalQuantity: "实物数量", reservedQuantity: "预留数量",
  availableQuantity: "可用数量", inTransitQuantity: "在途数量", providerQuantity: "服务商数量", virtualQuantity: "虚拟数量", projectionVersion: "原投影版本", updatedAt: "原更新时间",
};
export function AgentPlanClaims({ claims }: { claims: PlanClaim[] }) {
  return <section aria-label="计划引用字段"><h5>引用字段与原来源 · {claims.length} 项</h5>{claims.length ? <ol className="al-claims">{claims.map((claim, index) => <li key={claim.stepId + ":" + claim.sourceId + ":" + claim.field + ":" + index}>
    <p><strong>{fields[claim.field]}</strong><span>{claim.value === null ? "原值未知" : typeof claim.value === "boolean" ? claim.value ? "是" : "否" : String(claim.value)}</span></p>
    <details><summary>核对这项原引用</summary><dl className="al-pairs"><div><dt>原读取步骤</dt><dd><a href={"#agent-step-" + claim.stepId}>{claim.stepId}</a></dd></div>
      <div><dt>原来源</dt><dd><code>{claim.sourceId === "$collection" ? "该步骤的原集合" : claim.sourceId}</code></dd></div><div><dt>原字段</dt><dd><code>{claim.field}</code></dd></div>
      <div><dt>原来源校验值</dt><dd><code>{claim.sourceChecksum}</code></dd></div></dl></details>
  </li>)}</ol> : <p>没有原字段引用 不补造数值或业务正确性证明</p>}</section>;
}
export function AgentPlanEvidence({ run }: { run: AgentPlanView }) {
  return <section className="al-evidence" aria-label="业务计划原观察与费用"><header><h3><ListChecks size={17} />原观察与计划依据</h3><span className="al-badge" data-state={run.status}>{agentPlanStatusLabels[run.status]}</span></header>
    <p>已登记工具调用 {run.toolCalls} 次 · 已观察 {run.observedRows} 条原记录 · 原记录更新于 {run.updatedAt}</p>
    <p className="al-muted">观察计数不证明分页完整 只有各原集合标明完整才覆盖对应查询范围 模型完成不等于业务已准备或执行</p>
    <AgentLoopCostEvidence cost={run.cost} />
    <p className="al-muted">模型完成后不等待人工处理 下方保存原准备不会重启本次模型计划 原业务影响仍须逐项核对确认</p>
    {!run.privateAvailable ? <p className="al-warning">原私文不可读取或已到期 仅保留标识 状态和费用 不重建目标或重新付费生成</p> : <>
      <section aria-label="业务计划原目标"><h4>原目标与用户补充资料</h4><p className="al-prose">{run.goal ?? "原目标未保留"}</p><p>原模型 {run.modelLabel}</p>
        <details><summary>用户提供的补充资料 尚未核验</summary><p className="al-prose">{run.contextText || "未提供额外资料"}</p><p className="al-warning">补充资料是用户声明 不作为服务器已经核验的业务事实</p></details></section>
      <section aria-label="业务计划实际步骤"><h4>全部已登记步骤 · {run.steps.length} 步</h4>{run.steps.length ? <ol className="al-steps">{run.steps.map(step => <AgentLoopStepEvidence key={step.id} step={step} />)}</ol> : <p>尚无已登记步骤 不推断模型已调用或业务资料已读取</p>}</section>
      <section aria-label="业务计划原集合"><h4>已保存的原读取集合 · {run.collections.length} 组</h4>{run.collections.map(collection => <AgentLoopCollectionEvidence key={collection.stepId + ":" + collection.queryChecksum} collection={collection} />)}
        {!run.collections.length && <p>尚无保存的原集合 在途分页只显示观察计数</p>}</section>
      <section aria-label="模型业务计划结论"><h4><CheckCheck size={15} />模型计划与核对范围</h4><p>{{ pending: "尚未完成引用核对", cited_fields_and_collection_versions_only: "只核对已引用字段与集合版本", not_adopted: "未采用为已核对结论" }[run.verification]}</p>
        <p className="al-warning">计划是未经原业务拥有者核验的建议 不构成审批 采购最优性 金额正确性或业务执行承诺</p>
        {run.result ? <><p className="al-prose">{run.result.summary}</p><AgentPlanClaims claims={run.result.claims} /><h5>模型列出的整体缺项</h5>{run.result.missingInformation.length ? <ul>{run.result.missingInformation.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>未另列整体缺项 不表示各提案已通过原业务校验</p>}</> : <p>尚无已保存计划 不从步骤或状态拼造提案</p>}
      </section>
    </>}
    <details><summary>原计划身份与执行边界</summary><dl className="al-pairs"><div><dt>原计划 ID</dt><dd><code>{run.id}</code></dd></div><div><dt>原请求 ID</dt><dd><code>{run.requestId}</code></dd></div>
      <div><dt>原完整请求校验值</dt><dd><code>{run.requestChecksum}</code></dd></div><div><dt>原记录修订</dt><dd>{run.revision}</dd></div><div><dt>最多模型轮次／提案</dt><dd>{run.limits.maxModelTurns}／{run.limits.maxProposals}</dd></div>
      <div><dt>原执行器</dt><dd><code>{run.executionContract.executorKey}</code></dd></div><div><dt>原执行契约校验值</dt><dd><code>{run.executionContract.checksum}</code></dd></div><div><dt>原截止时间</dt><dd>{run.deadlineAt}</dd></div><div><dt>原私文保留至</dt><dd>{run.expiresAt}</dd></div></dl></details>
    {run.errorCode && <p className="al-warning">原计划错误代码 <code>{run.errorCode}</code> 请读取原步骤与回执 不自动重发</p>}
  </section>;
}
