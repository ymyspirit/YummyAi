"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, FileSearch } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { AGENT_PLAN_CLEAR_EVENT, AgentPlanPreparationIntentSchema, type AgentPlanItemReceipt, type AgentPlanItemView, type AgentPlanPreparationIntent, type AgentPlanView } from "@yummyai/contracts/ai/agent-plan";
import type { AgentCommandOriginal } from "@yummyai/contracts/ai/agent-command";
import { useErpAccess } from "../identity/erp-access";
import { agentOperationName } from "./agent-operation-summary";
import { AgentPlanRequestError, agentPlanReadDenied, prepareAgentPlanItem, readAgentPlanItemReceipt } from "./agent-plan-client";
import { readAgentPlanPreparationIntents, saveAgentPlanPreparationIntent, updateAgentPlanPreparationIntent, useAgentPlanIntents } from "./agent-plan-intent";
import { AgentPlanClaims } from "./agent-plan-evidence";

const blockReasons = { missing_information: "提案缺少必要资料", permission_denied: "当前原领域权限不足", plan_stopped: "原计划已请求停止", input_unavailable: "原提案正文不可完整读取", expired: "原提案已到期", read_sources_changed: "原读取来源已变化 不能替换为今天的依据", planning_incomplete: "模型计划尚未完成" };
type Proposal = NonNullable<AgentPlanView["result"]>["proposals"][number];
const errorText = (failure: unknown) => failure instanceof AgentPlanRequestError ? failure.message : "原准备响应尚未核对 请只读取原回执 不换键或改正文";

export function AgentPlanItems({ run, onDenied }: { run: AgentPlanView; onDenied(): void }) {
  const access = useErpAccess(), intents = useAgentPlanIntents(access.preferenceScope);
  return <section className="ap-items" aria-label="逐项核对业务计划"><h3>逐项保存原准备并核对 · {run.items.length} 项</h3>
    <p className="al-warning">模型提案尚未通过原业务拥有者核验 保存只形成原准备 取得真实命令后还须逐笔明确确认执行 不自动执行下一项</p>
    <p className="al-muted">已取得原命令引用 {run.items.filter(item => item.agentCommandId !== null).length} 项 · 实际执行业务状态须进入各原操作读取 不以引用数量计算成功笔数</p>
    {!run.items.length && <p>尚无已登记提案 不根据模型步骤补造操作</p>}
    {intents.error && <p role="alert" className="al-error">{intents.error}</p>}
    <ol className="ap-item-list">{run.items.map(item => <PlanItem key={item.id + ":" + item.proposalChecksum} run={run} item={item}
      proposal={run.privateAvailable ? run.result?.proposals.find(value => value.id === item.id) : undefined} authority={access.authority ?? ""} canRun={access.can(Permission.WorkflowRun)}
      ownerScope={intents.ownerScope} storageReady={intents.ready} marker={intents.preparations.find(value => value.runId === run.id && value.itemId === item.id)} onDenied={onDenied} />)}</ol>
  </section>;
}
function PlanItem({ run, item, proposal, authority, canRun, ownerScope, storageReady, marker, onDenied }: {
  run: AgentPlanView; item: AgentPlanItemView; proposal?: Proposal; authority: string; canRun: boolean; ownerScope: string; storageReady: boolean; marker?: AgentPlanPreparationIntent; onDenied(): void;
}) {
  const router = useRouter(), searchParams = useSearchParams(), stamp = JSON.stringify([authority, run.id, run.requestId, run.revision, item.id, item.proposalChecksum]);
  const current = useRef(stamp); current.current = stamp;
  const alive = useRef(true), cleared = useRef(false), epoch = useRef(0), lock = useRef<symbol | null>(null), controller = useRef<AbortController | null>(null);
  const callback = useRef(onDenied); callback.current = onDenied;
  const [receipt, setReceipt] = useState<{ stamp: string; value: AgentPlanItemReceipt } | null>(null), [reading, setReading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [retryConfirmed, setRetryConfirmed] = useState(false);
  const valid = useCallback((token: number) => alive.current && !cleared.current && current.current === stamp && token === epoch.current, [stamp]);
  const load = useCallback(async () => {
    if (!authority || lock.current || cleared.current) return;
    const token = ++epoch.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort; setReading(true); setReceipt(null); setRetryConfirmed(false); setError("");
    try {
      const value = await readAgentPlanItemReceipt(run, item, authority, abort.signal);
      if (!valid(token) || abort.signal.aborted) return;
      const saved = ownerScope ? readAgentPlanPreparationIntents(ownerScope).find(candidate => candidate.runId === run.id && candidate.itemId === item.id) : undefined;
      if (saved && saved.proposalChecksum !== item.proposalChecksum) throw new AgentPlanRequestError(502, "原恢复标识对应另一份提案 不采用替代正文");
      if (saved && saved.state !== "known" && value.disposition === "known") updateAgentPlanPreparationIntent({ ...saved, state: "known" });
      setReceipt({ stamp, value });
    } catch (failure) { if (valid(token) && !abort.signal.aborted) { setError(errorText(failure)); if (agentPlanReadDenied(failure)) { setReceipt(null); callback.current(); } } }
    finally { if (valid(token)) setReading(false); }
  }, [authority, run, item, ownerScope, stamp, valid]);
  useLayoutEffect(() => { alive.current = true; setReceipt(null); setRetryConfirmed(false); setPending(false); lock.current = null;
    const clear = () => { cleared.current = true; epoch.current++; controller.current?.abort(); setReceipt(null); setRetryConfirmed(false); setPending(false); };
    window.addEventListener(AGENT_PLAN_CLEAR_EVENT, clear); return () => { alive.current = false; epoch.current++; controller.current?.abort(); window.removeEventListener(AGENT_PLAN_CLEAR_EVENT, clear); };
  }, [stamp]);
  useEffect(() => { if (storageReady) void load(); }, [load, storageReady]);
  const result = receipt?.stamp === stamp ? receipt.value : null;
  const knownId = result?.disposition === "known" ? result.agentCommandId : item.preparationState === "known" ? item.agentCommandId : null;
  const hasOriginal = run.privateAvailable && Date.parse(run.expiresAt) > Date.now() && proposal?.draft.original;
  const uncertain = Boolean(marker && marker.state !== "known" || item.preparationState === "requested_unknown" || result?.disposition === "unknown");
  const eligible = Boolean(hasOriginal && item.canPrepare && canRun && storageReady && marker?.state !== "known" && result && ["not_requested", "unknown"].includes(result.disposition) && !knownId);
  const needsRetry = uncertain || Boolean(marker);
  function operationHref(commandId: string) {
    const query = new URLSearchParams(searchParams.toString()); query.set("agentPlan", run.id); query.set("agentCommand", commandId);
    return "/ai-tasks?" + query.toString();
  }
  async function prepare() {
    if (!eligible || lock.current || reading || pending || !hasOriginal || !run.privateAvailable || Date.parse(run.expiresAt) <= Date.now() || needsRetry && !retryConfirmed || !result) return;
    const lease = Symbol("plan-item"); lock.current = lease; const token = epoch.current; setPending(true); setError(""); setRetryConfirmed(false);
    try {
      const stored = readAgentPlanPreparationIntents(ownerScope).find(value => value.runId === run.id && value.itemId === item.id);
      const saved = stored ?? saveAgentPlanPreparationIntent(AgentPlanPreparationIntentSchema.parse({ version: 1, ownerScope, runId: run.id, itemId: item.id, proposalChecksum: item.proposalChecksum, state: "prepared", createdAt: new Date().toISOString() }));
      if (saved.proposalChecksum !== item.proposalChecksum || saved.state === "known") throw new AgentPlanRequestError(409, "原准备已知或正文标识不同 请只读取原回执");
      const frozen = updateAgentPlanPreparationIntent({ ...saved, state: "unknown" });
      if (!valid(token)) return;
      const value = await prepareAgentPlanItem(run, item, authority);
      if (!valid(token)) return;
      setReceipt({ stamp, value });
      if (value.disposition === "known") { updateAgentPlanPreparationIntent({ ...frozen, state: "known" }); router.push(operationHref(value.agentCommandId!)); }
    } catch (failure) { if (valid(token)) { setReceipt(null); setError(errorText(failure)); if (agentPlanReadDenied(failure)) callback.current(); } }
    finally { if (lock.current === lease) { lock.current = null; if (valid(token)) setPending(false); } }
  }
  return <li className="ap-item" aria-label={"业务计划提案 " + (item.position + 1)}>
    <header><h4>{item.position + 1} · {proposal?.draft.label ?? "原提案正文当前不可读"}</h4><span className="al-badge">{knownId ? "原准备已知 尚须核对实际业务状态" : uncertain ? "原准备结果待核对" : "模型建议 尚未原业务核验"}</span></header>
    <dl className="al-pairs"><div><dt>原提案 ID</dt><dd><code>{item.id}</code></dd></div><div><dt>固定提案校验值</dt><dd><code>{item.proposalChecksum}</code></dd></div></dl>
    {proposal && <><h5>{agentOperationName(proposal.draft.capability.domain, proposal.draft.capability.kind)}</h5><p className="al-prose">{proposal.draft.reason}</p><AgentPlanClaims claims={proposal.draft.claims} />
      {proposal.draft.missingInformation.length > 0 && <section className="al-warning" aria-label="这项提案缺少的资料"><h5>缺少资料 不能保存原准备</h5><ul>{proposal.draft.missingInformation.map((missing, index) => <li key={index}>{missing}</li>)}</ul></section>}
      {proposal.draft.original && <ModelDraft original={proposal.draft.original} />}</>}
    {item.blockReason && <p className="al-warning">{blockReasons[item.blockReason]}</p>}
    {reading && <p role="status">正在只读核对这项原准备回执</p>}{pending && <p role="status">正在保存这项原准备 不执行业务</p>}{error && <p role="alert" className="al-error">{error}</p>}
    {result && <p>{({ not_requested: "尚未找到原准备登记 这不证明先前请求未提交", unknown: "原准备结果未知 不能视为失败", known: "已取得真实原命令引用 不等于业务已执行", blocked: "当前原准备被阻断 不发起替代提交" })[result.disposition]}</p>}
    {eligible && needsRetry && <label className="ap-retry"><input type="checkbox" checked={retryConfirmed} disabled={pending || reading} onChange={event => setRetryConfirmed(event.target.checked)} />已核对同一原提案 使用原键重试准备</label>}
    <div className="al-actions"><button type="button" disabled={reading || pending} onClick={() => void load()}><FileSearch size={14} />读取这项原准备回执</button>
      {knownId ? <Link href={operationHref(knownId)}>核对这项原操作<ArrowRight size={14} /></Link> : <button type="button" className="al-primary" disabled={!eligible || reading || pending || needsRetry && !retryConfirmed} onClick={() => void prepare()}>{needsRetry ? "使用原键重试准备" : "保存这项原准备并核对"}</button>}</div>
    {!canRun && <p className="al-muted">当前只能读取原提案和回执 没有工作流运行权限</p>}
    <p className="al-muted">任何原版本 目标或输入变更都需另行明确核对 不把提案自动改绑到最新业务依据</p>
  </li>;
}
const labels: Record<string, string> = { input: "模型建议输入", targetId: "建议固定目标", accountId: "建议广告账户", idempotencyKey: "本提案固定请求键", quantity: "建议数量", unit: "原文单位", currency: "原文币种", amountMinor: "金额 最小货币单位", unitCostMinor: "报价 最小货币单位", priceBasisQuantity: "计价数量", expectedVersion: "建议固定版本", expectedRevision: "建议固定修订", expectedFingerprint: "建议依据校验值", previewChecksum: "建议预览校验值", stockItemId: "货品 ID", supplierId: "供应商 ID", lines: "全部建议明细", items: "全部建议组项", name: "名称", code: "编号", notes: "补充说明", reason: "原因", manufacturing: "制造依据", capacityPlan: "产能计划" };
export function ModelDraft({ original }: { original: AgentCommandOriginal }) {
  return <details className="ap-draft"><summary>逐项核对模型建议输入 尚未原业务核验</summary><p className="al-warning">这是模型提案的只读原文 不是已保存业务原命令 缺失的单位 币种 来源或审批依据不得补猜</p>
    <dl className="al-pairs"><div><dt>建议业务类型</dt><dd>{agentOperationName(original.domain, original.command.kind)}</dd></div></dl><DraftObject value={original.command} />
    {original.domain === "finance" && <p>财务提案只可能登记内部事实 不发起银行转账或银行退款</p>}{original.domain === "production" && <p>生产提案仍需原审核文件 制造和产能门核验 不代表工厂接受或已经生产</p>}</details>;
}
function DraftObject({ value }: { value: object }) { return <dl className="al-pairs">{Object.entries(value).map(([key, entry]) => <div key={key}><dt>{labels[key] ?? key}</dt><dd><DraftValue value={entry} /></dd></div>)}</dl>; }
function DraftValue({ value }: { value: unknown }) {
  const [page, setPage] = useState(0);
  if (value === null || value === undefined) return <>原文未提供</>;
  if (typeof value === "boolean") return <>{value ? "是" : "否"}</>;
  if (typeof value === "number") return <>{String(value)}</>;
  if (typeof value === "string") { const size = 20_000, count = Math.max(1, Math.ceil(value.length / size)), selected = Math.min(page, count - 1); return <><span className="al-prose">{value.slice(selected * size, (selected + 1) * size) || "空文本"}</span>{count > 1 && <div className="al-actions"><button type="button" disabled={!selected} onClick={() => setPage(selected - 1)}>上一段文字</button><span>{selected + 1} / {count}</span><button type="button" disabled={selected + 1 >= count} onClick={() => setPage(selected + 1)}>下一段文字</button></div>}</>; }
  if (Array.isArray(value)) { const size = 25, count = Math.max(1, Math.ceil(value.length / size)), selected = Math.min(page, count - 1); return <>{!value.length ? "原文空列表" : <ol>{value.slice(selected * size, (selected + 1) * size).map((entry, index) => <li key={selected * size + index}><DraftValue value={entry} /></li>)}</ol>}{count > 1 && <div className="al-actions"><button type="button" disabled={!selected} onClick={() => setPage(selected - 1)}>上一段明细</button><span>{selected + 1} / {count} · 共 {value.length} 项</span><button type="button" disabled={selected + 1 >= count} onClick={() => setPage(selected + 1)}>下一段明细</button></div>}</>; }
  return <details><summary>核对原文字段</summary><DraftObject value={value as object} /></details>;
}
