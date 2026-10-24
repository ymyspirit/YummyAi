"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { ArrowRight, FileSearch, Play, RefreshCw, Square, Workflow, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import {
  AGENT_LOOP_VERSION, CreateAgentLoopSchema, defaultAgentLoopLimits,
  type AgentLoopIntent, type AgentLoopReceipt, type AgentLoopRunView, type AgentLoopWorkspace,
} from "@yummyai/contracts/ai/agent-loop";
import type { AgentReadToolKey } from "@yummyai/contracts/ai/agent-read";
import { useErpAccess } from "../identity/erp-access";
import { AgentReadiness, useAgentReadiness } from "./agent-readiness";
import {
  AgentLoopRequestError, agentLoopReadDenied, createAgentLoop,
  readAgentLoopReceipt, readAgentLoopRun, readAgentLoopWorkspace, stopAgentLoop,
} from "./agent-loop-client";
import {
  AGENT_LOOP_INTENT_CLEAR_EVENT, forgetAgentLoopIntent, prepareAgentLoopIntent, readAgentLoopIntents,
  saveAgentLoopIntent, updateAgentLoopIntent, useAgentLoopIntents,
} from "./agent-loop-intent";
import { AgentLoopRunEvidence, agentLoopStatusLabels, agentLoopToolLabels } from "./agent-loop-evidence";
import "./agent-loop.css";

const tools = ["orders.exceptions.page", "inventory.balances.page"] as const;
const active = (status: AgentLoopRunView["status"]) => ["queued", "running", "stopping"].includes(status);
const failureText = (failure: unknown) => failure instanceof AgentLoopRequestError ? failure.message : "原任务响应暂不可核对 请只读取原回执 不重复付费";
function parseCost(text: string) {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(text.trim())) return null;
  const [whole, fraction = ""] = text.trim().split("."), micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micro >= 1n && micro <= 100_000_000n ? Number(text.trim()) : null;
}
function selectRun(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("agentRun", id); else url.searchParams.delete("agentRun");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
export function AgentLoopWorkbench() {
  const access = useErpAccess();
  const identity = useRef({ authority: access.authority, scope: access.preferenceScope });
  identity.current = { authority: access.authority, scope: access.preferenceScope };
  if (!access.authority || !access.preferenceScope)
    return <section className="agent-loop" aria-label="有界 Agent 任务"><h2><Workflow size={17} />有界 Agent 任务</h2><p role="status">正在核对当前本人身份 暂不读取或启动任务</p></section>;
  return <AgentLoopContent key={access.preferenceScope + ":" + access.authority} identity={identity} />;
}
function AgentLoopContent({ identity }: { identity: RefObject<{ authority: string | null; scope: string | null }> }) {
  const access = useErpAccess(), authority = access.authority!, preferenceScope = access.preferenceScope!, parameters = useSearchParams();
  const canRead = access.can(Permission.WorkflowRead), canRun = access.can(Permission.WorkflowRun);
  const intents = useAgentLoopIntents(preferenceScope);
  const rawSelected = parameters.get("agentRun"), parsedSelected = z.uuidv7().safeParse(rawSelected);
  const selected = parameters.getAll("agentRun").length === 1 && parsedSelected.success ? parsedSelected.data.toLowerCase() : null;
  const alive = useRef(true), purged = useRef(false), epoch = useRef(0), current = useRef({ authority, preferenceScope, canRead, canRun, selected });
  current.current = { authority: access.authority ?? "", preferenceScope: access.preferenceScope ?? "", canRead, canRun, selected };
  const readBlocked = useRef(false), [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false);
  const workspaceSequence = useRef(0), workspaceController = useRef<AbortController | null>(null);
  const readSequence = useRef(0), readController = useRef<AbortController | null>(null), receiptSequence = useRef(0), receiptController = useRef<AbortController | null>(null), navigationSequence = useRef(0);
  const createLock = useRef(false), stopLock = useRef(false), runLoading = useRef(false);
  const [workspace, setWorkspace] = useState<AgentLoopWorkspace | null>(null), [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [goal, setGoal] = useState(""), [modelId, setModelId] = useState(""), [selectedTools, setTools] = useState<AgentReadToolKey[]>([]), [maxRows, setMaxRows] = useState("500"), [cap, setCap] = useState("");
  const [creating, setCreating] = useState(false), [createError, setCreateError] = useState("");
  const [run, setRun] = useState<AgentLoopRunView | null>(null), runRef = useRef<AgentLoopRunView | null>(null);
  const [runReading, setRunReading] = useState(false), [runError, setRunError] = useState(""), [idDraft, setIdDraft] = useState(rawSelected ?? "");
  const [receipt, setReceipt] = useState<AgentLoopReceipt | null>(null), [receiptReading, setReceiptReading] = useState<string | null>(null), [receiptError, setReceiptError] = useState("");
  const [stopping, setStopping] = useState<string | null>(null), [stopReceipt, setStopReceipt] = useState<AgentLoopReceipt | null>(null), [stopError, setStopError] = useState("");
  const ownerHash = useRef(intents.ownerScope); ownerHash.current = intents.ownerScope;
  const valid = useCallback((token = epoch.current) => alive.current && !purged.current && token === epoch.current && identity.current.authority === authority && identity.current.scope === preferenceScope && current.current.authority === authority && current.current.preferenceScope === preferenceScope, [authority, preferenceScope, identity]);
  const readable = useCallback(() => valid() && !readBlocked.current && current.current.canRead, [valid]);
  const clearPrivate = useCallback(() => {
    workspaceSequence.current++; readSequence.current++; receiptSequence.current++;
    workspaceController.current?.abort(); readController.current?.abort(); receiptController.current?.abort(); runLoading.current = false;
    setWorkspace(null); setRun(null); runRef.current = null; setReceipt(null); setGoal(""); setModelId(""); setTools([]); setCap(""); setIdDraft("");
    setCreating(false); setRunReading(false); setWorkspaceReading(false); setReceiptReading(null);
  }, []);
  const deny = useCallback(() => { readBlocked.current = true; clearPrivate(); setDenied(true); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; epoch.current++; clearPrivate(); setStopReceipt(null); setStopError(""); setCreateError(""); setReceiptError(""); setRunError(""); setCleared(true); };
    window.addEventListener(AGENT_LOOP_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; workspaceSequence.current++; readSequence.current++; receiptSequence.current++; workspaceController.current?.abort(); readController.current?.abort(); receiptController.current?.abort(); window.removeEventListener(AGENT_LOOP_INTENT_CLEAR_EVENT, clear); };
  }, [clearPrivate]);
  const reloadWorkspace = useCallback(async () => {
    if (!readable()) return;
    const sequence = ++workspaceSequence.current, token = epoch.current, controller = new AbortController();
    workspaceController.current?.abort(); workspaceController.current = controller; setWorkspaceReading(true); setWorkspaceError("");
    try {
      const result = await readAgentLoopWorkspace(authority, controller.signal);
      if (!controller.signal.aborted && sequence === workspaceSequence.current && valid(token) && readable()) setWorkspace(result);
    } catch (failure) {
      if (!controller.signal.aborted && sequence === workspaceSequence.current && valid(token)) {
        if (agentLoopReadDenied(failure)) deny(); else setWorkspaceError(failureText(failure));
      }
    } finally { if (sequence === workspaceSequence.current && valid(token)) setWorkspaceReading(false); }
  }, [authority, readable, valid, deny]);
  useEffect(() => { void reloadWorkspace(); }, [reloadWorkspace]);
  useEffect(() => {
    const refreshModels = () => { void reloadWorkspace(); };
    window.addEventListener("yummyai.models.changed", refreshModels);
    return () => window.removeEventListener("yummyai.models.changed", refreshModels);
  }, [reloadWorkspace]);
  const readiness = useAgentReadiness({ family: "loop", refreshKey: workspaceSequence.current, workspaceVersion: workspace?.version, enabled: canRead && !denied && !cleared && !workspaceReading && workspaceSequence.current > 0 });
  const remember = useCallback((value: AgentLoopRunView) => {
    if (!ownerHash.current) return;
    const marker = readAgentLoopIntents(ownerHash.current).find(item => item.requestId === value.requestId);
    if (!marker) return;
    if (marker.requestChecksum !== value.requestChecksum || marker.runId !== null && marker.runId !== value.id)
      throw new AgentLoopRequestError(502, "读取的任务与原请求摘要不一致 未采用替代任务");
    updateAgentLoopIntent({ ...marker, state: "known", runId: value.id });
  }, []);
  const loadRun = useCallback(async (id: string, background = false) => {
    if (!readable() || current.current.selected !== id || background && runLoading.current) return;
    const sequence = ++readSequence.current, token = epoch.current, controller = new AbortController();
    readController.current?.abort(); readController.current = controller; runLoading.current = true;
    if (!background) setRunReading(true); setRunError("");
    try {
      const value = await readAgentLoopRun(id, authority, controller.signal);
      if (controller.signal.aborted || sequence !== readSequence.current || !valid(token) || !readable() || current.current.selected !== id) return;
      remember(value);
      if (runRef.current?.id === id && runRef.current.revision > value.revision) return;
      runRef.current = value; setRun(value);
    } catch (failure) {
      if (controller.signal.aborted || sequence !== readSequence.current || !valid(token) || current.current.selected !== id) return;
      if (agentLoopReadDenied(failure) && (!(failure instanceof AgentLoopRequestError) || failure.status !== 404 || runRef.current?.id === id)) deny();
      else { setRunError(failureText(failure)); if (failure instanceof AgentLoopRequestError && failure.status === 404) { setRun(null); runRef.current = null; } }
    } finally { if (sequence === readSequence.current) { runLoading.current = false; if (valid(token)) setRunReading(false); } }
  }, [authority, readable, valid, deny, remember]);
  function openRun(id: string | null) {
    navigationSequence.current++; readSequence.current++; readController.current?.abort(); runLoading.current = false;
    setRun(null); runRef.current = null; setRunError(""); setRunReading(false);
    if (id && current.current.selected === id) void loadRun(id); else selectRun(id);
  }
  useEffect(() => {
    readSequence.current++; readController.current?.abort(); runLoading.current = false; setRun(null); runRef.current = null; setRunError(""); setRunReading(false); setStopReceipt(null); setStopError("");
    if (selected) { setIdDraft(selected); void loadRun(selected); }
  }, [selected, loadRun]);
  useEffect(() => {
    if (!selected || !run || run.id !== selected || !readable()) return;
    const refresh = () => { if (document.visibilityState === "visible") void loadRun(selected, true); };
    const timer = window.setInterval(refresh, active(run.status) ? 3000 : 30_000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [selected, run?.id, run?.status, loadRun, readable]);
  useEffect(() => {
    if (!run?.privateAvailable) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = Date.parse(run.expiresAt) - Date.now();
      if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return; }
      if (valid() && runRef.current?.id === run.id) {
      const value = { ...run, privateAvailable: false, goal: null, steps: [], collections: [], result: null };
      runRef.current = value; setRun(value);
    } };
    expire();
    return () => clearTimeout(timer);
  }, [run, valid]);
  const toolAvailable = (tool: AgentReadToolKey) => Boolean(workspace?.readWorkspace.tools.find(item => item.key === tool)?.available && access.canTenant(tool === "orders.exceptions.page" ? Permission.OrderRead : Permission.InventoryRead));
  const model = workspace?.models.find(item => item.id === modelId), rowOptions = [100, 500, 1000].filter(size => size <= (workspace?.limits.maxRows ?? 0));
  const hasMarkers = intents.markers.length > 0, locked = hasMarkers || !intents.ready || creating || !readable();
  const chosenRows = rowOptions.includes(Number(maxRows)) ? Number(maxRows) : rowOptions.filter(size => size <= 500).at(-1) ?? rowOptions[0];
  async function start() {
    if (createLock.current || !valid() || !readable() || !canRun || !workspace?.canStart || !readiness.canStart() || !intents.ready || hasMarkers) return;
    createLock.current = true; setCreating(true); setCreateError(""); const token = epoch.current, selectedAtStart = current.current.selected, navigationAtStart = navigationSequence.current;
    try {
      const cost = parseCost(cap);
      if (cost === null || !model || !chosenRows || !selectedTools.length || selectedTools.some(tool => !toolAvailable(tool)))
        throw new AgentLoopRequestError(400, "请明确选择当前可用模型 工具 记录数上限与有效美元费用上限");
      const defaults = defaultAgentLoopLimits(), limits = { ...defaults,
        maxModelTurns: Math.min(defaults.maxModelTurns, workspace.limits.maxModelTurns), maxToolCalls: Math.min(defaults.maxToolCalls, workspace.limits.maxToolCalls),
        maxRows: chosenRows, maxOutputTokens: Math.min(defaults.maxOutputTokens, workspace.limits.maxOutputTokens),
        maxPromptBytes: Math.min(defaults.maxPromptBytes, workspace.limits.maxPromptBytes), deadlineSeconds: Math.min(defaults.deadlineSeconds, workspace.limits.deadlineSeconds) };
      const parsed = CreateAgentLoopSchema.safeParse({ version: AGENT_LOOP_VERSION, requestId: crypto.randomUUID(), goal, modelId: model.id, allowedTools: selectedTools, limits, maxCostUsd: cost, executionContract: workspace.executionContract });
      if (!parsed.success) throw new AgentLoopRequestError(400, "请核对任务目标与执行边界 本次未发起付费任务");
      const prepared = await prepareAgentLoopIntent(parsed.data, preferenceScope);
      if (!valid(token) || !readable() || !current.current.canRun || !readiness.canStart()) return;
      saveAgentLoopIntent(prepared.intent);
      const marker = updateAgentLoopIntent({ ...prepared.intent, state: "unknown" });
      if (!valid(token) || !readable() || !current.current.canRun || !readiness.canStart()) return;
      const value = await createAgentLoop(prepared.input, authority);
      if (!valid(token) || !readable()) return;
      updateAgentLoopIntent({ ...marker, state: "known", runId: value.id });
      setGoal("");
      if (current.current.selected === selectedAtStart && navigationSequence.current === navigationAtStart) { setRun(value); runRef.current = value; selectRun(value.id); }
    } catch (failure) {
      if (valid(token)) { if (agentLoopReadDenied(failure)) deny(); setCreateError(failureText(failure)); }
    } finally { createLock.current = false; if (valid(token)) { setCreating(false); intents.reload(); } }
  }
  async function recover(marker: AgentLoopIntent) {
    if (!readable() || receiptReading) return;
    const sequence = ++receiptSequence.current, token = epoch.current, controller = new AbortController();
    receiptController.current?.abort(); receiptController.current = controller; setReceipt(null); setReceiptError(""); setReceiptReading(marker.requestId);
    try {
      const value = await readAgentLoopReceipt({ requestId: marker.requestId, requestChecksum: marker.requestChecksum }, authority, controller.signal);
      if (controller.signal.aborted || sequence !== receiptSequence.current || !valid(token) || !readable()) return;
      if (value.disposition === "known") {
        if (marker.runId && marker.runId !== value.runId) throw new AgentLoopRequestError(502, "原回执与已保存任务 ID 不一致 未采用替代任务");
        updateAgentLoopIntent({ ...marker, state: "known", runId: value.runId });
      }
      setReceipt(value);
    } catch (failure) { if (!controller.signal.aborted && sequence === receiptSequence.current && valid(token)) { if (agentLoopReadDenied(failure)) deny(); else setReceiptError(failureText(failure)); } }
    finally { if (sequence === receiptSequence.current && valid(token)) setReceiptReading(null); }
  }
  async function stop(id: string, requestId: string, expectedChecksum: string) {
    if (stopLock.current || !valid() || !current.current.canRun) return;
    stopLock.current = true; setStopping(id); setStopError(""); const token = epoch.current;
    try {
      const value = await stopAgentLoop(id, { version: AGENT_LOOP_VERSION, requestId }, authority);
      if (!valid(token)) return;
      if (value.requestChecksum !== expectedChecksum) throw new AgentLoopRequestError(502, "停止回执与原请求摘要不匹配 请只读取原回执");
      setStopReceipt(value);
      if (!value.privateAvailable) { setRun(null); runRef.current = null; }
      else if (readable() && current.current.selected === id) void loadRun(id);
    } catch (failure) { if (valid(token)) { if (agentLoopReadDenied(failure)) deny(); setStopError(failureText(failure)); } }
    finally { stopLock.current = false; if (valid(token)) setStopping(null); }
  }
  function newTask() {
    if (!valid() || !readable() || !canRun || creating || !intents.ready) return;
    if (intents.markers.length && !window.confirm("将清除这 " + intents.markers.length + " 个原请求恢复标识并允许另起新的付费任务\n" + intents.markers.map(item => item.requestId).join("\n") + "\n原任务可能仍在执行 这不会停止旧任务 新任务可能重复计费\n请确认已核对原请求并接受重复付费风险")) return;
    try { for (const marker of readAgentLoopIntents(intents.ownerScope)) forgetAgentLoopIntent(marker); setCreateError(""); setGoal(""); setModelId(""); setCap(""); setTools([]); setReceipt(null); intents.reload(); }
    catch (failure) { setCreateError(failureText(failure)); }
  }
  if (cleared) return <section className="agent-loop" aria-label="有界 Agent 任务"><h2><Workflow size={17} />有界 Agent 任务</h2><p role="status">本人会话已清除 原填写与读取已隐藏 请重新核对身份</p></section>;
  const visibleRun = readable() && run?.id === selected && run.contextAuthority === authority && run.allowedTools.every(tool => access.canTenant(tool === "orders.exceptions.page" ? Permission.OrderRead : Permission.InventoryRead)) ? run : null;
  const shownRun = visibleRun && Date.parse(visibleRun.expiresAt) <= Date.now() ? { ...visibleRun, privateAvailable: false, goal: null, steps: [], collections: [], result: null } : visibleRun;
  return <section className="agent-loop" aria-label="有界 Agent 任务">
    <header className="al-heading"><div><h2><Workflow size={18} />有界 Agent 任务</h2><p className="al-muted">围绕一个目标 由模型逐步选择原只读工具 有明确轮次 分页与费用上限</p></div>
      <button type="button" disabled={!readable() || workspaceReading || creating} onClick={() => void reloadWorkspace()}><RefreshCw size={14} />重新读取 Agent 契约</button></header>
    <p className="al-muted">当前接入订单异常与库存余额 只读取原业务 没有写入或采用操作 MCP 尚未连接</p>
    {workspaceReading && <p role="status">正在读取当前模型与执行边界</p>}{workspaceError && <p role="alert" className="al-error">{workspaceError}</p>}
    <AgentReadiness diagnostic={readiness} />
    {(!canRead || denied) && <p role="status" className="al-warning">当前 Agent 读取权限尚未核对或已变化 原目标 步骤与来源已隐藏 有原任务 ID 时仍可按当前运行权限停止后续步骤</p>}
    <section className="al-recovery" aria-label="本人 Agent 原请求恢复"><header><h3><FileSearch size={16} />本人 Agent 原请求恢复</h3><button type="button" disabled={creating || !canRun || !readable() || !intents.ready} onClick={newTask}>明确另起新的付费任务</button></header>
      <p className="al-muted">这里只保存本人请求 ID 与校验值 不保存目标 提示词 业务正文或分页游标 读取回执不会启动模型</p>
      {!intents.ready && !intents.error && <p role="status">正在核对本人原请求标识 新付费任务暂不可发起</p>}{intents.error && <p role="alert" className="al-error">{intents.error}</p>}
      {intents.ready && !hasMarkers && <p>当前会话没有待核对的 Agent 原请求标识</p>}
      {intents.markers.map(marker => <article className="al-intent" key={marker.requestId} aria-label={"原 Agent 请求 " + marker.requestId}><h4>原请求 <code>{marker.requestId}</code></h4>
        <p>{marker.state === "known" ? "已知原任务 仍须读取实际详情核对" : marker.state === "prepared" ? "原标识已保存 尚未确认任务登记" : "提交结果尚待核对"}</p>
        <dl className="al-pairs"><div><dt>原完整请求校验值</dt><dd><code>{marker.requestChecksum}</code></dd></div><div><dt>原任务 ID</dt><dd><code>{marker.runId ?? "尚未取得"}</code></dd></div></dl>
        <div className="al-actions"><button type="button" disabled={!readable() || Boolean(receiptReading) || creating} onClick={() => void recover(marker)}><FileSearch size={14} />只读取原请求回执</button>
          {marker.runId && <><button type="button" disabled={!readable() || creating} onClick={() => openRun(marker.runId)}>读取原任务详情<ArrowRight size={14} /></button>
            {shownRun?.id !== marker.runId && <button type="button" disabled={!canRun || Boolean(stopping) || creating} onClick={() => void stop(marker.runId!, marker.requestId, marker.requestChecksum)}><Square size={13} />停止后续步骤</button>}</>}</div>
      </article>)}
      {receiptReading && <p role="status">正在只读核对原请求回执</p>}{receiptError && <p role="alert" className="al-error">{receiptError}</p>}
      {receipt && <section aria-label="已找回的原 Agent 回执" className="al-receipt"><h4>原请求回执</h4><code>{receipt.requestId}</code>
        {receipt.disposition === "not_found" ? <p className="al-warning">原回执尚未找到 不等于原请求未提交 不重建正文 不自动换编号或再次付费 请继续核对</p> : <><p>原任务 <code>{receipt.runId}</code> · {agentLoopStatusLabels[receipt.status!]}</p>
          {!receipt.privateAvailable && <p>当前回执仅核对标识与状态 原私文不可读取 不重新启动任务</p>}
          <button type="button" disabled={!readable()} onClick={() => openRun(receipt.runId)}>读取原任务详情<ArrowRight size={14} /></button></>}
      </section>}
    </section>
    {stopping && <p role="status">正在请求停止后续步骤 在途模型调用仍可能返回并计费</p>}{stopError && <p role="alert" className="al-error">{stopError}</p>}
    {stopReceipt && <section aria-label="停止后续步骤原回执" className="al-receipt"><h4>已读取停止请求的原状态</h4><p>原任务 <code>{stopReceipt.runId}</code> · {agentLoopStatusLabels[stopReceipt.status!]}</p><p className="al-muted">这是当前任务的实际状态 不证明在途调用已取消 费用或预留额度以原任务后续凭据为准</p></section>}
    {canRead && !denied && <>
      <form className="al-composer" aria-label="新建有界 Agent 任务" onSubmit={event => { event.preventDefault(); void start(); }}>
        <h3>明确一个只读目标</h3><fieldset disabled={locked || !canRun || !workspace?.canStart || !readiness.canStart()}>
          <label>Agent 任务目标<textarea required minLength={2} maxLength={2000} rows={3} value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如核对当前待处理订单异常与库存缺项 并列明原来源" /></label>
          <div className="al-fields"><label>Agent 执行模型<select required value={modelId} onChange={event => setModelId(event.target.value)}><option value="">选择当前可用模型</option>{workspace?.models.map(item => <option value={item.id} key={item.id}>{item.label} · {item.providerLabel}</option>)}</select></label>
            <label>费用上限 USD<input required inputMode="decimal" value={cap} onChange={event => setCap(event.target.value)} placeholder="例如 0.10" /></label>
            <label>原记录数上限<select value={chosenRows ?? ""} onChange={event => setMaxRows(event.target.value)}>{!rowOptions.length && <option value="">当前没有可选上限</option>}{rowOptions.map(size => <option key={size} value={size}>{size} 条</option>)}</select></label></div>
          <div className="al-tool-options" role="group" aria-label="允许 Agent 使用的只读工具">{tools.map(tool => <label key={tool}><input type="checkbox" checked={selectedTools.includes(tool)} disabled={!toolAvailable(tool)} onChange={event => setTools(previous => event.target.checked ? [...previous, tool] : previous.filter(item => item !== tool))} />{agentLoopToolLabels[tool]}<small>{toolAvailable(tool) ? "当前租户范围可读" : "当前未获租户范围读取许可"}</small></label>)}</div>
          <p className="al-muted">费用上限支持最多 6 位小数 最小 USD 0.000001 当前模型与组织额度仍由服务器收紧</p>
          {workspace && <p className="al-muted">本次最多模型 {Math.min(defaultAgentLoopLimits().maxModelTurns, workspace.limits.maxModelTurns)} 轮 · 工具调用 {Math.min(defaultAgentLoopLimits().maxToolCalls, workspace.limits.maxToolCalls)} 次 · 原记录 {chosenRows ?? "尚未确定"} 条 · 执行期限 {Math.min(defaultAgentLoopLimits().deadlineSeconds, workspace.limits.deadlineSeconds)} 秒</p>}
          {model && <p className="al-muted">该模型原标定任务上限 {model.maxTaskCostUsd === null ? "未知 由服务器核对" : "USD " + model.maxTaskCostUsd}</p>}
          <button className="al-primary" disabled={!workspace || !model || !selectedTools.length || selectedTools.some(tool => !toolAvailable(tool)) || !chosenRows || parseCost(cap) === null || goal.trim().length < 2}><Play size={14} />{creating ? "正在登记原付费请求" : "登记并启动有界 Agent 任务"}</button>
        </fieldset>
        {hasMarkers && <p className="al-warning">本人仍有原请求待核对 包括已知但尚未读取的任务 改目标或模型不会绕过原请求保护</p>}
        {!canRun && <p className="al-muted">当前仅可读取原任务 没有运行权限 不发起新的付费任务</p>}
        {workspace && !rowOptions.length && <p className="al-warning">当前服务器上限不足以提供可选记录数 请重新核对执行策略</p>}
        {createError && <p role="alert" className="al-error">{createError}</p>}
      </form>
      <section className="al-history" aria-label="读取原 Agent 任务"><header><h3>读取原 Agent 任务</h3><span className="al-muted">按原 ID 读取 不重新执行</span></header>
        <form className="al-id-form" onSubmit={event => { event.preventDefault(); const parsed = z.uuidv7().safeParse(idDraft.trim()); if (parsed.success) openRun(parsed.data.toLowerCase()); else setRunError("请填写真实有效的 Agent 任务 ID"); }}><label>Agent 任务 ID<input value={idDraft} onChange={event => setIdDraft(event.target.value)} /></label><button disabled={runReading || !readable()}>按任务 ID 读取</button></form>
        {workspace && <details><summary>近期本人任务 · 已载入 {workspace.recent.length} 条{workspace.recentHasMore ? " 仍有更早任务" : ""}</summary><p className="al-muted">此处最多展示近期 {workspace.recentLimit} 条 不代表完整历史 更早任务可按原 ID 读取</p>
          <ul className="al-recent">{workspace.recent.map(item => <li key={item.id}><button type="button" onClick={() => openRun(item.id)}><span>{agentLoopStatusLabels[item.status]} · {item.createdAt}</span><code>{item.id}</code></button></li>)}</ul>{!workspace.recent.length && <p>当前没有近期本人任务</p>}</details>}
      </section>
    </>}
    {rawSelected && !selected && <p role="alert" className="al-error">网址中的 Agent 任务 ID 无效 未读取替代任务</p>}
    {selected && <section className="al-detail" aria-label="Agent 任务详情"><header><h3>原 Agent 任务详情</h3><div className="al-actions"><button type="button" disabled={!readable() || runReading} onClick={() => void loadRun(selected)}><RefreshCw size={14} />重新读取原 Agent 任务</button><button type="button" onClick={() => openRun(null)}><X size={14} />关闭 Agent 详情</button></div></header>
      <p>原任务 ID <code>{selected}</code></p><p className="al-muted">关闭只收起详情 不停止原任务 不清除原请求恢复标识</p>
      {runReading && <p role="status">正在读取原任务与执行凭据</p>}{runError && <p role="alert" className="al-error">{runError}</p>}
      {shownRun && <><div className="al-actions">{canRun && active(shownRun.status) && <button type="button" disabled={Boolean(stopping)} onClick={() => void stop(shownRun.id, shownRun.requestId, shownRun.requestChecksum)}><Square size={13} />停止后续步骤</button>}</div>
        {shownRun.stopRequestedAt && <p className="al-warning">已于 {shownRun.stopRequestedAt} 请求停止后续步骤 在途调用可能继续计费</p>}
        <AgentLoopRunEvidence run={shownRun} /></>}
      {!shownRun && !runReading && !runError && <p>原私文尚未读取或当前不可读取 请核对当前读取权限</p>}
    </section>}
    {workspace && readable() && <details className="al-contract"><summary>本次 Agent 契约与最大边界</summary><p>原执行器 <code>{workspace.executionContract.executorKey}</code></p><code>{workspace.executionContract.checksum}</code><p>服务器最大模型轮次 {workspace.limits.maxModelTurns} · 最大工具调用 {workspace.limits.maxToolCalls} · 最大原记录 {workspace.limits.maxRows}</p><p className="al-muted">模型作出读取计划后才显示实际步骤 不把尚未执行的计划写成完成事实</p></details>}
  </section>;
}
