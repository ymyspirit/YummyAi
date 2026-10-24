"use client";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import {
  AGENT_RESOURCES_VERSION, type AgentResourceKey, type AgentResourceCandidatesQuery, type AgentResourceResult,
} from "@yummyai/contracts/ai/agent-resources";
import { OrderWorkflowStateSchema, type ListOrdersInput } from "@yummyai/contracts/order/order";
import { AgentResourceObjectPicker, type ResourceCandidate } from "./agent-resource-object-picker";

const workflowNames: Record<string, string> = { pending: "待处理", awaiting_customization: "待定制资料", awaiting_design: "待设计", awaiting_customer_approval: "待客户核准", awaiting_routing: "待分配", in_production: "生产中", awaiting_quality_control: "待质检", awaiting_shipment: "待发货", shipped: "已发货", completed: "已完成" };
/** Only a real owner candidate can supply a business ID or its pinned revision. */
export function agentResourceCandidateInput(tool: AgentResourceKey, candidate: ResourceCandidate, accountId: string | null, recipeId: string | null = null): unknown | null {
  if (candidate.kind !== "object") return null;
  switch (tool) {
    case "research.evidence": return candidate.versionId ? { researchItemId: candidate.id, snapshotId: candidate.versionId, studyRevisionId: null } : null;
    case "catalog.sku": return { skuId: candidate.id, recipeId };
    case "listing.version": return candidate.versionId ? { listingId: candidate.id, versionId: candidate.versionId } : null;
    case "orders.order": return candidate.revision !== null && candidate.revision > 0 ? { orderId: candidate.id, expectedSequence: candidate.revision } : null;
    case "finance.profit_run": return { runId: candidate.id };
    case "advertising.analysis": return accountId ? { accountId, analysisId: candidate.id } : null;
  }
}
export function AgentResourceInputs({ tool, authority, enabled, result, onChange, onDenied }: {
  tool: AgentResourceKey; authority: string; enabled: boolean; result: AgentResourceResult | null;
  onChange(input: unknown | null): void; onDenied(): void;
}) {
  const [q, setQ] = useState(""), [platform, setPlatform] = useState<"amazon" | "etsy" | "">(""), [workflow, setWorkflow] = useState<ListOrdersInput["workflowState"] | "">(""), [side, setSide] = useState<ListOrdersInput["sideState"] | "">("");
  const [selected, setSelected] = useState<ResourceCandidate | null>(null), [account, setAccount] = useState<ResourceCandidate | null>(null), [recipeId, setRecipeId] = useState<string | null>(null);
  const [recipeChoice, setRecipeChoice] = useState<{ skuId: string; id: string; version: number; status: string } | null>(null);
  useEffect(() => {
    if (result?.tool === "catalog.sku" && result.data.skuId === selected?.id && result.data.recipe) setRecipeChoice({ skuId: result.data.skuId, id: result.data.recipe.id, version: result.data.recipe.version, status: result.data.recipe.status });
  }, [result, selected?.id]);
  function invalidate() { onChange(null); setSelected(null); setRecipeId(null); setRecipeChoice(null); }
  let query: AgentResourceCandidatesQuery;
  switch (tool) {
    case "research.evidence": query = { version: AGENT_RESOURCES_VERSION, tool, q }; break;
    case "catalog.sku": case "listing.version": query = { version: AGENT_RESOURCES_VERSION, tool, q, page: 1, pageSize: 25 }; break;
    case "orders.order": query = { version: AGENT_RESOURCES_VERSION, tool, filters: { limit: 25, ...(platform ? { platform } : {}), ...(workflow ? { workflowState: workflow } : {}), ...(side ? { sideState: side } : {}) } }; break;
    case "finance.profit_run": query = { version: AGENT_RESOURCES_VERSION, tool }; break;
    case "advertising.analysis": query = { version: AGENT_RESOURCES_VERSION, tool, accountId: account?.id ?? null, cursor: null, pageSize: 25 }; break;
  }
  function select(candidate: ResourceCandidate | null) {
    invalidate();
    if (candidate?.kind === "account") { setAccount(candidate); return; }
    setSelected(candidate); if (candidate) onChange(agentResourceCandidateInput(tool, candidate, account?.id ?? null));
  }
  const knownRecipe = recipeChoice?.skuId === selected?.id ? recipeChoice : null;
  return <section className="ar-inputs" aria-label="所选资源严格输入">
    {(tool === "research.evidence" || tool === "catalog.sku" || tool === "listing.version") && <label><span><Search size={13} aria-hidden="true" />搜索原业务对象</span><input maxLength={200} aria-label="搜索原业务对象" value={q} disabled={!enabled} onChange={event => { invalidate(); setQ(event.target.value); }} /></label>}
    {tool === "orders.order" && <div className="ar-fields"><label>订单平台<select aria-label="订单平台" value={platform} disabled={!enabled} onChange={event => { invalidate(); setPlatform(event.target.value as typeof platform); }}><option value="">原服务允许的平台</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label><label>订单工作状态<select aria-label="订单工作状态" value={workflow} disabled={!enabled} onChange={event => { invalidate(); setWorkflow(event.target.value as typeof workflow); }}><option value="">全部工作状态</option>{OrderWorkflowStateSchema.options.map(value => <option key={value} value={value}>{workflowNames[value]}</option>)}</select></label><label>订单附加状态<select aria-label="订单附加状态" value={side} disabled={!enabled} onChange={event => { invalidate(); setSide(event.target.value as typeof side); }}><option value="">不限</option><option value="none">没有附加状态</option><option value="on_hold">暂停</option><option value="cancelled">取消</option></select></label></div>}
    {tool === "finance.profit_run" && <p className="ar-muted">从原财务拥有者返回的近期计算中选择 当前上限 100 项 不代表全部财务历史</p>}
    {tool === "advertising.analysis" && account && <div className="ar-actions"><p>已选真实账户 {account.label} <code>{account.id}</code></p><button type="button" onClick={() => { invalidate(); setAccount(null); }}>返回账户候选</button></div>}
    <AgentResourceObjectPicker query={query} authority={authority} enabled={enabled} disabled={false} selected={selected} onSelect={select} onDenied={onDenied} />
    {tool === "research.evidence" && <p className="ar-notice">本次只读候选固定的原捕获快照 不包含研究结论 studyRevisionId 明确为空 候选修订数字不是研究结论 UUID</p>}
    {tool === "listing.version" && <p className="ar-muted">采用所选候选的原版本 ID 不自动换成今天的新版本 读取原稿不等于刊登审核或平台发布</p>}
    {tool === "orders.order" && <p className="ar-muted">采用原候选的实际事件修订 版本变化时重新选择 不自动提升 expectedSequence 本次不读取客户原文或完整地址</p>}
    {tool === "catalog.sku" && <><label>SKU 配方版本<select aria-label="SKU 配方版本" disabled={!enabled || !selected} value={recipeId ?? ""} onChange={event => { const value = event.target.value || null; if (value && value !== knownRecipe?.id) return; setRecipeId(value); onChange(selected ? agentResourceCandidateInput(tool, selected, null, value) : null); }}><option value="">原服务当前配方 以实际读取结果为准</option>{knownRecipe && <option value={knownRecipe.id}>已读原配方 v{knownRecipe.version} · {knownRecipe.status} · {knownRecipe.id}</option>}</select></label><p className="ar-muted">首次 recipeId 为空 表示读取原当前配方 取得真实结果后可明确固定其中的配方版本 不输入或猜造配方 ID</p></>}
    {selected && agentResourceCandidateInput(tool, selected, account?.id ?? null, recipeId) === null && <p className="ar-error">原候选未提供此读取所需的固定版本或修订 暂不能读取 请重新核对原对象</p>}
  </section>;
}
