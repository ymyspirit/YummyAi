"use client";
import { useState } from "react";
import { CheckCheck, ChevronLeft, ChevronRight, Database, ListChecks, ReceiptText } from "lucide-react";
import type { AgentLoopCollection, AgentLoopRunView, AgentLoopStepView } from "@yummyai/contracts/ai/agent-loop";
import { AgentBalanceRows, AgentExceptionRows } from "./agent-read-tools";

export const agentLoopToolLabels = { "orders.exceptions.page": "订单异常", "inventory.balances.page": "库存余额" };
export const agentLoopStatusLabels: Record<AgentLoopRunView["status"], string> = {
  queued: "排队中", running: "正在执行", stopping: "正在停止后续步骤", completed: "已完成", partial: "部分完成",
  failed: "执行失败", uncertain: "提交结果不确定", stopped: "已停止后续步骤", expired: "私有内容已到期",
};
const phaseLabels: Record<AgentLoopStepView["phase"], string> = {
  preparing: "准备中", submitted: "已提交 等待原响应", response_ready: "已收到原响应", completed: "本步已完成", failed: "本步失败", uncertain: "本步提交结果不确定",
};
const fieldLabels: Record<string, string> = {
  total: "原集合总数", category: "异常类别", status: "原状态", eventMissing: "原事件是否缺失", sequence: "异常序号",
  orderSequence: "订单序号", openedAt: "异常发生时间", resolvedAt: "异常解决时间", unit: "库存单位",
  physicalQuantity: "实物数量", reservedQuantity: "已预留数量", availableQuantity: "可用数量", inTransitQuantity: "在途数量",
  providerQuantity: "服务商数量", virtualQuantity: "虚拟数量", projectionVersion: "原投影版本", updatedAt: "原更新时间",
};
function Value({ value }: { value: string | number | boolean | null }) {
  return <>{value === null ? "原值未知" : typeof value === "boolean" ? value ? "是" : "否" : String(value)}</>;
}
export function AgentLoopCostEvidence({ cost }: { cost: AgentLoopRunView["cost"] }) {
  return <section className="al-cost" aria-label="Agent 任务费用依据"><h4><ReceiptText size={15} />费用与额度</h4>
    <dl className="al-pairs"><div><dt>本任务实际费用上限</dt><dd>USD {cost.capUsd}</dd></div>
      <div><dt>已知模型费用</dt><dd>USD {cost.knownCostUsd}</dd></div><div><dt>当前保留额度</dt><dd>USD {cost.reservedUsd}</dd></div>
      <div><dt>费用覆盖</dt><dd>{{ known: "已知费用", partial: "部分费用已知", unknown: "费用尚不确定" }[cost.coverage]}</dd></div>
      <div><dt>已登记模型轮次</dt><dd>{cost.modelTurns}</dd></div></dl>
    <p className="al-muted">任务活跃时按全额上限保留额度 已知费用包含在这份额度内 两者不能相加作为总费用</p>
    {cost.coverage !== "known" && <p className="al-warning">在途或未核定的模型调用仍可能计费 停止后续步骤不证明已免除费用或释放全部额度</p>}
  </section>;
}
export function AgentLoopStepEvidence({ step }: { step: AgentLoopStepView }) {
  return <li className="al-step" id={"agent-step-" + step.id} aria-label={"第 " + step.sequence + " 步"}>
    <header><h4>{step.sequence} · {step.kind === "model" ? "模型决策" : "读取原业务"}{step.tool ? " · " + agentLoopToolLabels[step.tool] : ""}</h4><span className="al-badge" data-state={step.phase}>{phaseLabels[step.phase]}</span></header>
    <p>{step.label || "本步没有另存说明"}</p>
    <p className="al-muted">{{ not_submitted: "尚未提交", submitted: "已向原执行方提交", received: "已收到原执行方响应" }[step.submissionState]} · 创建 {step.createdAt} · {step.completedAt ? "完成 " + step.completedAt : "尚无完成时间"}</p>
    {step.kind === "model" && <p>原输入 token {step.inputTokens ?? "未知"} · 原输出 token {step.outputTokens ?? "未知"} · 本步费用 {step.costUsd === null ? "未知" : "USD " + step.costUsd}</p>}
    {step.errorCode && <p className="al-warning">原执行错误代码 <code>{step.errorCode}</code> 请核对原任务 不自动重发本步</p>}
    <details><summary>本步原执行凭据</summary><dl className="al-pairs"><div><dt>原步骤 ID</dt><dd><code>{step.id}</code></dd></div>
      <div><dt>原输入校验值</dt><dd><code>{step.inputChecksum}</code></dd></div><div><dt>原输出校验值</dt><dd><code>{step.outputChecksum ?? "尚无原输出"}</code></dd></div>
      <div><dt>提供方原请求 ID</dt><dd><code>{step.providerRequestId ?? "未记录"}</code></dd></div></dl></details>
  </li>;
}
export function AgentLoopCollectionEvidence({ collection }: { collection: AgentLoopCollection }) {
  const [page, setPage] = useState(0), size = 25, maxPage = Math.max(0, Math.ceil(collection.rows.length / size) - 1), index = Math.min(page, maxPage);
  const start = index * size, rows = collection.rows.slice(start, start + size), label = agentLoopToolLabels[collection.tool];
  return <section className="al-collection" aria-label={label + "原集合 " + collection.stepId}>
    <header><h4><Database size={15} />{label}原读取集合</h4><span className="al-badge" data-state={collection.complete ? "completed" : "partial"}>{collection.complete ? "该集合已完整读取" : "该集合尚未完整读取"}</span></header>
    <p>已读取 {collection.readCount} / {collection.total} · 核对于 {collection.checkedAt}</p>
    {!collection.complete && <p className="al-warning">{collection.limitReason === "row_limit" ? "已达到本任务记录数上限" : "已达到本任务工具调用上限"} 未读记录不纳入完整性或全量结论</p>}
    <dl className="al-pairs">{collection.tool === "orders.exceptions.page" ? <><div><dt>原异常范围</dt><dd>{{ all: "全部状态", open: "待处理", resolved: "已解决" }[collection.query.status]}</dd></div><div><dt>原订单筛选</dt><dd><code>{collection.query.orderId ?? "未限定单个订单"}</code></dd></div></> :
      <><div><dt>原货品筛选</dt><dd><code>{collection.query.stockItemId ?? "未限定单个货品"}</code></dd></div><div><dt>原库位筛选</dt><dd><code>{collection.query.locationId ?? "未限定单个库位"}</code></dd></div></>}
    </dl>
    <details><summary>查看已保存的 {collection.rows.length} 条来源与校验值</summary>
      <p className="al-muted">以下只分段展示本任务已保存的原记录 不触发新的工具读取 不代表补齐未读记录</p>
      {collection.rows.length > 0 && <div className="al-actions" aria-label={label + "原记录展示分页"}><span>显示 {start + 1}–{Math.min(start + size, collection.rows.length)} / 已保存 {collection.rows.length}</span>
        <button type="button" disabled={index === 0} onClick={() => setPage(index - 1)}><ChevronLeft size={14} />上一段原记录</button>
        <button type="button" disabled={index >= maxPage} onClick={() => setPage(index + 1)}>下一段原记录<ChevronRight size={14} /></button></div>}
      {collection.tool === "orders.exceptions.page" ? <AgentExceptionRows items={collection.rows.slice(start, start + size).map(row => row.data)} /> :
        <AgentBalanceRows items={collection.rows.slice(start, start + size).map(row => row.data)} />}
      {rows.length === 0 && <p>本次原集合没有符合筛选的记录</p>}
      <details><summary>本段来源身份与校验值</summary><dl className="al-pairs">{rows.map(row => <div key={row.sourceId} id={"agent-source-" + collection.stepId + "-" + row.sourceId}><dt><code>{row.sourceId}</code></dt><dd><code>{row.sourceChecksum}</code></dd></div>)}</dl></details>
    </details>
    <details><summary>原集合固定依据</summary><dl className="al-pairs"><div><dt>原读取步骤</dt><dd><a href={"#agent-step-" + collection.stepId}>{collection.stepId}</a></dd></div><div><dt>原查询校验值</dt><dd><code>{collection.queryChecksum}</code></dd></div>
      <div><dt>原集合版本校验值</dt><dd><code>{collection.collectionFingerprint}</code></dd></div></dl></details>
  </section>;
}
export function AgentLoopRunEvidence({ run }: { run: AgentLoopRunView }) {
  return <section className="al-evidence" aria-label="Agent 原执行依据">
    <header><h3><ListChecks size={17} />原执行步骤与结果</h3><span className="al-badge" data-state={run.status}>{agentLoopStatusLabels[run.status]}</span></header>
    <p>已登记工具调用 {run.toolCalls} 次 · 已观察原记录 {run.observedRows} 条</p><p className="al-muted">这份原任务记录更新于 {run.updatedAt}</p>
    <p className="al-muted">每次模型决策与原工具调用分别记录 当前观察计数不证明分页完成 完整性以各原集合为准</p>
    <AgentLoopCostEvidence cost={run.cost} />
    {!run.privateAvailable ? <p className="al-warning">原私有内容已不可用 仅核对任务标识 状态与原费用 不重新读取业务正文或自动付费重跑</p> : <>
      <section aria-label="Agent 任务目标"><h4>原任务目标</h4><p className="al-prose">{run.goal ?? "原目标未保留"}</p><p>原模型 {run.modelLabel}</p></section>
      <section aria-label="Agent 执行步骤"><h4>全部已登记步骤 · {run.steps.length} 步</h4>
        {run.steps.length ? <ol className="al-steps">{run.steps.map(step => <AgentLoopStepEvidence key={step.id} step={step} />)}</ol> : <p>尚无已登记步骤 不推断模型已提交或资料已读取</p>}
      </section>
      <section aria-label="Agent 原读取集合"><h4>已落存的原读取集合 · {run.collections.length} 组</h4>
        {run.collections.map(collection => <AgentLoopCollectionEvidence key={collection.stepId + ":" + collection.queryChecksum} collection={collection} />)}
        {!run.collections.length && <p>尚无落存的原集合 在途分页只显示上方观察计数</p>}
      </section>
      <section aria-label="Agent 核对结果"><h4><CheckCheck size={15} />字段核对与业务复核</h4>
        <p>{{ pending: "字段与集合版本尚未完成核对", field_values_and_collection_versions: "已核对所引字段值与原集合版本", not_adopted: "未采用为已核对结论" }[run.verification]}</p>
        <p className="al-warning">核对只覆盖列明的字段与集合版本 摘要和处理建议仍需业务人员复核 没有登记订单或库存写入</p>
        {run.result ? <><p className="al-prose">{run.result.summary}</p><h5>原引用字段 · {run.result.claims.length} 项</h5>
          <ol className="al-claims">{run.result.claims.map((claim, index) => <li key={claim.stepId + ":" + claim.sourceId + ":" + claim.field + ":" + index}>
            <p><strong>{fieldLabels[claim.field]}</strong> <Value value={claim.value} /></p>
            <details><summary>{claim.sourceId === "$collection" ? "原集合层级引用" : "原记录字段引用"}</summary><dl className="al-pairs"><div><dt>来源步骤</dt><dd><a href={"#agent-step-" + claim.stepId}>{claim.stepId}</a></dd></div>
              <div><dt>原来源 ID</dt><dd><code>{claim.sourceId === "$collection" ? "该步骤的原集合" : claim.sourceId}</code></dd></div><div><dt>原字段</dt><dd><code>{claim.field}</code></dd></div><div><dt>原来源校验值</dt><dd><code>{claim.sourceChecksum}</code></dd></div></dl></details>
          </li>)}</ol>{!run.result.claims.length && <p>原结果没有字段引用 不补造数值证明</p>}
          <h5>原结果缺少的资料</h5>{run.result.missingInformation.length ? <ul>{run.result.missingInformation.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>原结果未另列缺项 不等同于业务事实全部完备</p>}
        </> : <p>尚无落存的原结果 不从步骤或状态拼造完成结论</p>}
      </section>
    </>}
    <details><summary>原任务身份与执行边界</summary><dl className="al-pairs"><div><dt>原任务 ID</dt><dd><code>{run.id}</code></dd></div><div><dt>原请求 ID</dt><dd><code>{run.requestId}</code></dd></div><div><dt>原完整请求校验值</dt><dd><code>{run.requestChecksum}</code></dd></div>
      <div><dt>原记录版本</dt><dd>{run.revision}</dd></div><div><dt>本次允许读取</dt><dd>{run.allowedTools.map(tool => agentLoopToolLabels[tool]).join(" / ")}</dd></div><div><dt>模型轮次上限</dt><dd>{run.limits.maxModelTurns}</dd></div>
      <div><dt>工具调用上限</dt><dd>{run.limits.maxToolCalls}</dd></div><div><dt>原记录数上限</dt><dd>{run.limits.maxRows}</dd></div><div><dt>原执行器版本</dt><dd><code>{run.executionContract.executorKey}</code></dd></div><div><dt>原执行契约校验值</dt><dd><code>{run.executionContract.checksum}</code></dd></div>
      <div><dt>原截止时间</dt><dd>{run.deadlineAt}</dd></div><div><dt>原私文期限</dt><dd>{run.expiresAt}</dd></div></dl></details>
    {run.errorCode && <p className="al-warning">原任务错误代码 <code>{run.errorCode}</code> 请核对实际步骤和原回执</p>}
  </section>;
}
