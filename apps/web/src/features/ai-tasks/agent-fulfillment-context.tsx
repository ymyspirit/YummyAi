"use client";
import Link from "next/link";
import { Search, Pin, FileCode2 } from "lucide-react";
import type { AgentFulfillmentCandidates } from "@yummyai/contracts/ai/agent-fulfillment";
import { OrderWorkflowStateSchema, OrderSideStateSchema } from "@yummyai/contracts/order/order";
import type { AgentFulfillmentCandidatesQuery, AgentFulfillmentDefinition } from "./agent-fulfillment-client";

export type AgentFulfillmentSelection = { orderId: string; expectedSequence: number; label: string | null; lineId: string | null };
const workflowLabels: Record<string, string> = {
  pending: "待处理", awaiting_customization: "待补定制资料", awaiting_design: "待制图", awaiting_customer_approval: "待客户确认",
  awaiting_routing: "待安排工厂", in_production: "生产中", awaiting_quality_control: "待质检", awaiting_shipment: "待发货", shipped: "原订单已发货", completed: "原订单已完成",
};
type Props = {
  pinned: boolean; selection: AgentFulfillmentSelection | null; filters: AgentFulfillmentCandidatesQuery["filters"];
  candidates: AgentFulfillmentCandidates | null; reading: boolean; error: string; enabled: boolean;
  onFiltersChange(value: AgentFulfillmentCandidatesQuery["filters"]): void;
  onRead(): void; onSelect(value: AgentFulfillmentSelection | null): void;
};
export function AgentFulfillmentContext({ pinned, selection, filters, candidates, reading, error, enabled, onFiltersChange, onRead, onSelect }: Props) {
  return <section className="af-context" aria-label="本单履约读取范围">
    <h3><Pin size={15} />本次原订单与事件修订</h3>
    {!pinned && <><div className="af-fields">
      <label>订单平台<select aria-label="履约候选订单平台" disabled={!enabled} value={filters.platform ?? ""} onChange={event => onFiltersChange({ ...filters, platform: event.target.value ? event.target.value as "amazon" | "etsy" : undefined })}><option value="">当前受权平台</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label>
      <label>原订单工作状态<select aria-label="履约候选订单工作状态" disabled={!enabled} value={filters.workflowState ?? ""} onChange={event => onFiltersChange({ ...filters, workflowState: event.target.value ? event.target.value as NonNullable<typeof filters.workflowState> : undefined })}><option value="">全部工作状态</option>{OrderWorkflowStateSchema.options.map(value => <option key={value} value={value}>{workflowLabels[value]}</option>)}</select></label>
      <label>原订单附加状态<select aria-label="履约候选订单附加状态" disabled={!enabled} value={filters.sideState ?? ""} onChange={event => onFiltersChange({ ...filters, sideState: event.target.value ? event.target.value as NonNullable<typeof filters.sideState> : undefined })}><option value="">全部附加状态</option><option value="none">没有附加状态</option>{OrderSideStateSchema.options.map(value => <option key={value} value={value}>{value === "on_hold" ? "已暂停" : "已取消"}</option>)}</select></label>
    </div><button type="button" disabled={!enabled || reading} onClick={onRead}><Search size={14} />{reading ? "正在读取原订单候选" : "读取真实订单候选"}</button>
      {candidates && <><p className="af-muted">{candidates.coverage.limitation} · 本次返回 {candidates.coverage.returned} 项{candidates.coverage.total === null ? " · 总数未知" : ` · 原服务计数 ${candidates.coverage.total}`} · {candidates.coverage.hasMore ? "还有未返回候选 可调整原筛选条件" : "当前候选已返回 不称订单历史全量"}</p>
        <label>选择原订单<select aria-label="选择履约原订单" disabled={!enabled || reading} value={selection?.orderId ?? ""} onChange={event => { const candidate = candidates.items.find(item => item.id === event.target.value); onSelect(candidate ? { orderId: candidate.id, expectedSequence: candidate.expectedSequence, label: candidate.label, lineId: candidate.lineId } : null); }}><option value="">从实际候选选择订单</option>{candidates.items.map(item => <option key={item.id} value={item.id}>{item.label} · 修订 {item.expectedSequence}</option>)}</select></label>
        {!candidates.items.length && <p role="status">本次原筛选没有返回订单 不使用手填编号代替真实候选</p>}<Link href="/orders">未找到本单时 从原订单工作区选择并核对</Link></>}
    </>}
    {error && <p className="af-error" role="alert">{error}</p>}
    {selection ? <div className="af-selection"><strong>{selection.label ?? "来自当前订单页面"}</strong><dl className="af-pairs"><div><dt>本次原订单 ID</dt><dd><code>{selection.orderId}</code></dd></div><div><dt>固定事件修订</dt><dd>{selection.expectedSequence}</dd></div></dl><p className="af-muted">{pinned ? "仅核对当前单 不自动读取来源" : "仅核对所选订单 不把其它受权订单混入本次来源"} · 更换订单或修订后清空已读页 不用新版本替代原依据</p></div> : !reading && <p className="af-muted">先选择真实订单 再分别读取生产 发货和物流依据</p>}
  </section>;
}
export function AgentFulfillmentDefinitionView({ definition }: { definition: AgentFulfillmentDefinition }) {
  return <details className="af-definition"><summary><FileCode2 size={14} />核对本次只读工具定义</summary><p>{definition.label} · 只读取原拥有者履约投影</p><ul>{definition.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
    <details><summary>严格输入字段</summary><pre tabIndex={0}>{JSON.stringify(definition.inputSchema, null, 2)}</pre></details><details><summary>严格返回字段</summary><pre tabIndex={0}>{JSON.stringify(definition.outputSchema, null, 2)}</pre></details><p>定义校验值 <code>{definition.definitionChecksum}</code></p>
  </details>;
}
