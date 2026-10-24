"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { ArrowRight, FileSearch, Play, RefreshCw, Square, Workflow } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import {
  AGENT_NATIVE_VERSION, CreateAgentNativeSchema, defaultAgentNativeLimits,
  type AgentNativeBinding, type AgentNativeIntent, type AgentNativeReceipt, type AgentNativeView, type AgentNativeWorkspace,
} from "@yummyai/contracts/ai/agent-native";
import { AgentPlanCommandKeySchema, agentPlanCommandKey, type AgentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import type { AgentToolKey } from "@yummyai/contracts/ai/agent-tools";
import { KNOWLEDGE_TOPICS, type KnowledgeSearch } from "@yummyai/contracts/knowledge";
import { useErpAccess } from "../identity/erp-access";
import { AgentReadiness, useAgentReadiness } from "./agent-readiness";
import { AgentToolObjectPicker, type AgentToolCreativeScope } from "./agent-tool-object-picker";
import { AgentNativeEvidence, agentNativeStatusLabels } from "./agent-native-evidence";
import { AgentNativeRequestError, agentNativeReadDenied, readAgentNativeWorkspace, readAgentNativeRun, readAgentNativeReceipt, createAgentNative, stopAgentNative } from "./agent-native-client";
import { AGENT_NATIVE_CLEAR_EVENT, forgetAgentNativeIntent, prepareAgentNativeIntent, readAgentNativeIntents, saveAgentNativeIntent, updateAgentNativeIntent, useAgentNativeIntents } from "./agent-native-intent";
import "./agent-plan.css";
import "./agent-native.css";

type Identity = { authority: string | null; scope: string | null };
type ScopeDraft = { status: "open" | "resolved" | "all"; topic: KnowledgeSearch["topic"]; platform: KnowledgeSearch["platform"]; market: string; creativeScope: AgentToolCreativeScope; ownerId: string; factoryId: string; from: string; days: string };
const blankScope = (): ScopeDraft => ({ status: "open", topic: "all", platform: "all", market: "ALL", creativeScope: "design_batch", ownerId: "", factoryId: "", from: "", days: "14" });
const active = (status: AgentNativeView["status"]) => ["queued", "running", "stopping"].includes(status);
const domainNames: Record<string, string> = { procurement: "采购", incoming: "来料", production: "生产", finance: "财务", advertising: "广告" };
const failureText = (failure: unknown) => failure instanceof AgentNativeRequestError ? failure.message : "原响应暂不可核对 请读取原回执 不另起付费请求";
function costValue(text: string) {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(text.trim())) return null;
  const [whole, fraction = ""] = text.trim().split("."), micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micro >= 1n && micro <= 100_000_000n ? Number(text.trim()) : null;
}
function selectRun(id: string | null) {
  const url = new URL(window.location.href); if (id) url.searchParams.set("agentNative", id); else url.searchParams.delete("agentNative");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
function hidePrivate(value: AgentNativeView): AgentNativeView { return { ...value, privateAvailable: false, goal: null, contextText: null, bindings: [], steps: [], definitions: [], observations: [], result: null }; }
export function AgentNativeWorkbench() {
  const access = useErpAccess(), identity = useRef<Identity>({ authority: access.authority, scope: access.preferenceScope }); identity.current = { authority: access.authority, scope: access.preferenceScope };
  if (!access.authority || !access.preferenceScope) return <section className="agent-plan agent-native" aria-label="原生工具模型任务"><h2><Workflow size={17} />原生工具模型任务</h2><p role="status">正在核对当前本人身份 暂不读取或启动任务</p></section>;
  return <NativeContent key={access.preferenceScope + ":" + access.authority} identity={identity} />;
}
function NativeContent({ identity }: { identity: RefObject<Identity> }) {
  const access = useErpAccess(), authority = access.authority!, preferenceScope = access.preferenceScope!, params = useSearchParams();
  const canRead = access.can(Permission.WorkflowRead), canRun = access.can(Permission.WorkflowRun), intents = useAgentNativeIntents(preferenceScope);
  const rawSelected = params.get("agentNative"), parsedId = z.uuidv7().safeParse(rawSelected), selected = params.getAll("agentNative").length === 1 && parsedId.success ? parsedId.data.toLowerCase() : null;
  const alive = useRef(true), purged = useRef(false), epoch = useRef(0), readBlocked = useRef(false), navigation = useRef(0), createLock = useRef(false), stopLock = useRef(false);
  const workspaceSequence = useRef(0), runSequence = useRef(0), receiptSequence = useRef(0), workspaceController = useRef<AbortController | null>(null), runController = useRef<AbortController | null>(null), receiptController = useRef<AbortController | null>(null), runLoading = useRef(false);
  const current = useRef({ authority, preferenceScope, canRead, canRun, selected }); current.current = { authority: access.authority ?? "", preferenceScope: access.preferenceScope ?? "", canRead, canRun, selected };
  const [workspace, setWorkspace] = useState<AgentNativeWorkspace | null>(null), [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [goal, setGoal] = useState(""), [contextText, setContextText] = useState(""), [modelId, setModelId] = useState(""), [cap, setCap] = useState(""), [maxRows, setMaxRows] = useState("2000"), [maxModelTurns, setMaxModelTurns] = useState("12"), [tools, setTools] = useState<AgentToolKey[]>([]), [commands, setCommands] = useState<AgentPlanCommandKey[]>([]), [scope, setScope] = useState<ScopeDraft>(blankScope);
  const [creating, setCreating] = useState(false), [createError, setCreateError] = useState(""), [run, setRun] = useState<AgentNativeView | null>(null), runRef = useRef<AgentNativeView | null>(null);
  const [runReading, setRunReading] = useState(false), [runError, setRunError] = useState(""), [idDraft, setIdDraft] = useState(rawSelected ?? ""), [receipt, setReceipt] = useState<AgentNativeReceipt | null>(null), [receiptReading, setReceiptReading] = useState<string | null>(null), [receiptError, setReceiptError] = useState("");
  const [stopping, setStopping] = useState<string | null>(null), [stopReceipt, setStopReceipt] = useState<AgentNativeReceipt | null>(null), [stopError, setStopError] = useState(""), [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false);
  const valid = useCallback((token = epoch.current) => alive.current && !purged.current && token === epoch.current && identity.current.authority === authority && identity.current.scope === preferenceScope && current.current.authority === authority && current.current.preferenceScope === preferenceScope, [authority, preferenceScope, identity]);
  const readable = useCallback(() => valid() && !readBlocked.current && current.current.canRead, [valid]);
  const clearPrivate = useCallback(() => {
    workspaceSequence.current++; runSequence.current++; receiptSequence.current++; workspaceController.current?.abort(); runController.current?.abort(); receiptController.current?.abort(); runLoading.current = false;
    setWorkspace(null); setRun(null); runRef.current = null; setReceipt(null); setGoal(""); setContextText(""); setModelId(""); setCap(""); setTools([]); setCommands([]); setScope(blankScope()); setIdDraft("");
    setWorkspaceReading(false); setRunReading(false); setReceiptReading(null); setCreating(false);
  }, []);
  const deny = useCallback(() => { readBlocked.current = true; clearPrivate(); setDenied(true); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; epoch.current++; clearPrivate(); setStopReceipt(null); setStopError(""); setCreateError(""); setRunError(""); setReceiptError(""); setCleared(true); };
    window.addEventListener(AGENT_NATIVE_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; workspaceSequence.current++; runSequence.current++; receiptSequence.current++; workspaceController.current?.abort(); runController.current?.abort(); receiptController.current?.abort(); window.removeEventListener(AGENT_NATIVE_CLEAR_EVENT, clear); };
  }, [clearPrivate]);
  const reloadWorkspace = useCallback(async () => {
    if (!readable()) return; const token = epoch.current, sequence = ++workspaceSequence.current, abort = new AbortController(); workspaceController.current?.abort(); workspaceController.current = abort; setWorkspaceReading(true); setWorkspaceError("");
    try { const value = await readAgentNativeWorkspace(authority, abort.signal); if (valid(token) && !abort.signal.aborted && sequence === workspaceSequence.current && readable()) setWorkspace(value); }
    catch (failure) { if (valid(token) && !abort.signal.aborted && sequence === workspaceSequence.current) { if (agentNativeReadDenied(failure)) deny(); else setWorkspaceError(failureText(failure)); } }
    finally { if (valid(token) && sequence === workspaceSequence.current) setWorkspaceReading(false); }
  }, [authority, valid, readable, deny]);
  useEffect(() => { void reloadWorkspace(); }, [reloadWorkspace]);
  useEffect(() => {
    const refreshModels = () => { void reloadWorkspace(); };
    window.addEventListener("yummyai.models.changed", refreshModels);
    return () => window.removeEventListener("yummyai.models.changed", refreshModels);
  }, [reloadWorkspace]);
  const readiness = useAgentReadiness({ family: "native_v1", refreshKey: workspaceSequence.current, workspaceVersion: workspace?.version, enabled: canRead && !denied && !cleared && !workspaceReading && workspaceSequence.current > 0 });
  const loadRun = useCallback(async (id: string) => {
    if (!readable() || runLoading.current) return;
    const token = epoch.current, sequence = ++runSequence.current, abort = new AbortController(); runController.current?.abort(); runController.current = abort; runLoading.current = true; setRunReading(true); setRunError("");
    try {
      const value = await readAgentNativeRun(id, authority, abort.signal);
      if (!valid(token) || !readable() || abort.signal.aborted || sequence !== runSequence.current || current.current.selected !== id) return;
      if (intents.ownerScope) {
        const marker = readAgentNativeIntents(intents.ownerScope).find(item => item.requestId === value.requestId);
        if (marker && (marker.requestChecksum !== value.requestChecksum || marker.runId && marker.runId !== value.id)) throw new AgentNativeRequestError(502, "原任务与保存的请求摘要不一致 不读取替代任务");
        if (marker && marker.state !== "known") updateAgentNativeIntent({ ...marker, runId: value.id, state: "known" });
      }
      setRun(value); runRef.current = value;
    } catch (failure) { if (valid(token) && !abort.signal.aborted && sequence === runSequence.current && current.current.selected === id) {
      if (agentNativeReadDenied(failure) && (failure.status !== 404 || runRef.current?.id === id)) deny(); else { setRun(null); runRef.current = null; setRunError(failureText(failure)); }
    } } finally { if (sequence === runSequence.current) { runLoading.current = false; if (valid(token)) setRunReading(false); } }
  }, [authority, valid, readable, deny, intents.ownerScope]);
  useEffect(() => {
    navigation.current++; runSequence.current++; runController.current?.abort(); runLoading.current = false; setRun(null); runRef.current = null; setRunError(""); setIdDraft(selected ?? "");
    if (selected) void loadRun(selected);
    return () => { runSequence.current++; runController.current?.abort(); runLoading.current = false; };
  }, [selected, loadRun]);
  useEffect(() => {
    if (!run || !active(run.status) || !readable()) return;
    const timer = setInterval(() => { if (current.current.selected === run.id) void loadRun(run.id); }, 3000); return () => clearInterval(timer);
  }, [run, readable, loadRun]);
  useEffect(() => {
    if (!run?.privateAvailable) return;
    const timer = setTimeout(() => { if (runRef.current?.id === run.id) { const hidden = hidePrivate(runRef.current); runRef.current = hidden; setRun(hidden); } }, Math.max(0, Math.min(2_147_483_647, Date.parse(run.expiresAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [run]);
  useEffect(() => {
    const refresh = () => { if (readable()) { void reloadWorkspace(); if (current.current.selected) void loadRun(current.current.selected); } };
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); };
  }, [readable, reloadWorkspace, loadRun]);
  function openRun(value: string | null) {
    const parsed = z.uuidv7().safeParse(value); if (!parsed.success || !readable()) { setRunError("请填写真实有效的原任务 ID"); return; }
    navigation.current++; runSequence.current++; runController.current?.abort(); runLoading.current = false; setRun(null); runRef.current = null; selectRun(parsed.data.toLowerCase()); setIdDraft(parsed.data.toLowerCase());
    if (current.current.selected === parsed.data.toLowerCase()) void loadRun(parsed.data.toLowerCase());
  }
  const toolAvailable = (tool: AgentToolKey) => Boolean(workspace?.toolWorkspace.tools.some(item => item.key === tool && item.available)) &&
    (tool === "orders.exceptions.page" || tool === "factory.capacity" ? access.canTenant(Permission.OrderRead) : tool === "inventory.balances.page" ? access.canTenant(Permission.InventoryRead) : tool === "creative.history" ? access.can(Permission.DesignRead) : canRead);
  const model = workspace?.models.find(item => item.id === modelId), rowOptions = [...new Set([100, 500, 1000, 2000, 5000, 10000, ...(workspace ? [workspace.limits.maxRows] : [])])].filter(value => value <= (workspace?.limits.maxRows ?? 0)).sort((a, b) => a - b);
  const chosenRows = rowOptions.includes(Number(maxRows)) ? Number(maxRows) : rowOptions.filter(value => value <= 2000).at(-1) ?? rowOptions[0], hasMarkers = intents.markers.length > 0;
  const chosenTurns = workspace && /^\d+$/.test(maxModelTurns) && Number.isInteger(Number(maxModelTurns)) && Number(maxModelTurns) >= 2 && Number(maxModelTurns) <= workspace.limits.maxModelTurns ? Number(maxModelTurns) : null;
  const locked = hasMarkers || !intents.ready || creating || !readable();
  async function start() {
    if (createLock.current || !readable() || !canRun || !workspace?.canStart || !readiness.canStart() || !intents.ready || hasMarkers) return;
    const token = epoch.current, selectedAtStart = current.current.selected, navAtStart = navigation.current; createLock.current = true; setCreating(true); setCreateError("");
    try {
      const cost = costValue(cap);
      if (chosenTurns === null) throw new AgentNativeRequestError(400, "请核对本次模型轮数上限 必须为 2 至服务器上限之间的整数");
      if (cost === null || !model || !chosenRows || !tools.length || tools.some(tool => !toolAvailable(tool)) || commands.some(command => !workspace.toolWorkspace.commands.some(item => item.available && item.domain === command.domain && item.kind === command.kind))) throw new AgentNativeRequestError(400, "请明确选择可用模型 工具与有效预算 不发送替代范围");
      if (model.maxTaskCostUsd !== null && cost > model.maxTaskCostUsd) throw new AgentNativeRequestError(400, "费用上限超过所选原模型允许的任务上限 请重新核对");
      if (tools.includes("creative.history") && !scope.ownerId || tools.includes("factory.capacity") && (!scope.factoryId || !scope.from)) throw new AgentNativeRequestError(400, "请从真实候选选择原对象 并明确工厂当地起始日期");
      const bindings = tools.map((tool): AgentNativeBinding => {
        switch (tool) {
          case "orders.exceptions.page": return { tool, scope: { status: scope.status } };
          case "inventory.balances.page": return { tool, scope: {} };
          case "knowledge.search": return { tool, scope: { topic: scope.topic, platform: scope.platform, market: scope.market, spuIds: [] } };
          case "creative.history": return { tool, scope: { scope: scope.creativeScope, ownerId: scope.ownerId } };
          case "factory.capacity": return { tool, scope: { factoryId: scope.factoryId, query: { from: scope.from, days: Number(scope.days) } } };
        }
      });
      const defaults = defaultAgentNativeLimits(), limits = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Math.min(value, workspace.limits[key as keyof typeof defaults])])) as typeof defaults; limits.maxRows = chosenRows; limits.maxModelTurns = chosenTurns;
      const parsed = CreateAgentNativeSchema.safeParse({ version: AGENT_NATIVE_VERSION, requestId: crypto.randomUUID(), goal, contextText, modelId: model.id, bindings, allowedCommands: commands, limits, maxCostUsd: cost, executionContract: workspace.executionContract });
      if (!parsed.success) throw new AgentNativeRequestError(400, "原目标或固定范围未通过校验 本次未发起付费任务");
      const prepared = await prepareAgentNativeIntent(parsed.data, preferenceScope); if (!valid(token) || !readable() || !current.current.canRun || !readiness.canStart()) return;
      saveAgentNativeIntent(prepared.intent); const marker = updateAgentNativeIntent({ ...prepared.intent, state: "unknown" }); if (!valid(token) || !readable() || !current.current.canRun || !readiness.canStart()) return;
      const value = await createAgentNative(prepared.input, authority); if (!valid(token) || !readable()) return;
      updateAgentNativeIntent({ ...marker, state: "known", runId: value.id }); setGoal(""); setContextText("");
      if (current.current.selected === selectedAtStart && navigation.current === navAtStart) { setRun(value); runRef.current = value; selectRun(value.id); }
    } catch (failure) { if (valid(token)) { if (agentNativeReadDenied(failure)) deny(); setCreateError(failureText(failure)); } }
    finally { createLock.current = false; if (valid(token)) { setCreating(false); intents.reload(); } }
  }
  async function recover(marker: AgentNativeIntent) {
    if (!readable() || receiptReading) return;
    const sequence = ++receiptSequence.current, token = epoch.current, abort = new AbortController(); receiptController.current?.abort(); receiptController.current = abort; setReceipt(null); setReceiptError(""); setReceiptReading(marker.requestId);
    try { const value = await readAgentNativeReceipt({ requestId: marker.requestId, requestChecksum: marker.requestChecksum }, authority, abort.signal); if (!valid(token) || !readable() || abort.signal.aborted || sequence !== receiptSequence.current) return;
      if (value.disposition === "known") { if (marker.runId && marker.runId !== value.runId) throw new AgentNativeRequestError(502, "原回执与已保存任务 ID 不一致"); updateAgentNativeIntent({ ...marker, runId: value.runId, state: "known" }); } setReceipt(value);
    } catch (failure) { if (valid(token) && !abort.signal.aborted && sequence === receiptSequence.current) { if (agentNativeReadDenied(failure)) deny(); else setReceiptError(failureText(failure)); } }
    finally { if (valid(token) && sequence === receiptSequence.current) setReceiptReading(null); }
  }
  async function stop(id: string, requestId: string, checksum: string) {
    if (stopLock.current || !valid() || !current.current.canRun) return; stopLock.current = true; setStopping(id); setStopError(""); const token = epoch.current;
    try { const value = await stopAgentNative(id, { version: AGENT_NATIVE_VERSION, requestId }, authority); if (!valid(token)) return;
      if (value.requestChecksum !== checksum) throw new AgentNativeRequestError(502, "原停止回执与请求摘要不一致 请只读核对"); setStopReceipt(value);
      if (!value.privateAvailable) { setRun(null); runRef.current = null; } else if (readable() && current.current.selected === id) void loadRun(id);
    } catch (failure) { if (valid(token)) { if (agentNativeReadDenied(failure)) deny(); setStopError(failureText(failure)); } } finally { stopLock.current = false; if (valid(token)) setStopping(null); }
  }
  function newTask() {
    if (!readable() || !canRun || creating || !intents.ready) return;
    if (intents.markers.length && !window.confirm("将清除这 " + intents.markers.length + " 个原请求恢复标识并允许另起新的付费任务\n" + intents.markers.map(marker => marker.requestId).join("\n") + "\n原任务可能仍在执行 此操作不会停止旧任务或撤销业务原准备 新任务可能重复计费\n请确认已核对原请求并接受重复付费风险")) return;
    try { for (const marker of readAgentNativeIntents(intents.ownerScope)) forgetAgentNativeIntent(marker); setGoal(""); setContextText(""); setModelId(""); setCap(""); setMaxModelTurns(String(Math.min(12, workspace?.limits.maxModelTurns ?? 12))); setTools([]); setCommands([]); setScope(blankScope()); setCreateError(""); setReceipt(null); intents.reload(); }
    catch (failure) { setCreateError(failureText(failure)); }
  }
  if (cleared) return <section className="agent-plan agent-native" aria-label="原生工具模型任务"><h2>原生工具模型任务</h2><p role="status">当前本人会话已清除 私有目标和来源已隐藏 迟到响应不重建原请求标识</p></section>;
  const visible = readable() && run?.id === selected ? run : null, shown = visible?.privateAvailable && Date.parse(visible.expiresAt) <= Date.now() ? hidePrivate(visible) : visible;
  return <section className="agent-plan agent-native" aria-label="原生工具模型任务"><header className="al-heading"><div><h2><Workflow size={18} />原生工具模型任务</h2><p className="al-muted">独立新版本 可使用五类原生读取 按需加载定义 不改旧循环与旧业务计划历史</p></div><button type="button" disabled={!readable() || workspaceReading || creating} onClick={() => void reloadWorkspace()}><RefreshCw size={14} />重新读取原生模型契约</button></header>
    <p className="al-muted">模型只读取并生成提案 完成即结算模型阶段 不自动准备或执行业务 MCP 尚未连接</p>
    {workspaceReading && <p role="status">正在读取当前模型 工具与执行边界</p>}{workspaceError && <p className="al-error" role="alert">{workspaceError}</p>}{(!canRead || denied) && <p className="al-warning" role="status">当前原生工具任务读取权限尚未核对或已变化 私文已隐藏 已知原任务 ID 仍可按当前运行权限停止后续步骤</p>}
    <AgentReadiness diagnostic={readiness} />
    <section className="al-recovery" aria-label="本人原生工具任务恢复"><header><h3><FileSearch size={16} />本人原生工具任务恢复</h3><button type="button" disabled={!readable() || !canRun || creating || !intents.ready} onClick={newTask}>明确另起新的付费任务</button></header><p className="al-muted">只保存七项本人请求标识 不保存目标 正文 对象名称或游标 读取回执不调用模型</p>
      {!intents.ready && !intents.error && <p role="status">正在核对本人原请求标识</p>}{intents.error && <p className="al-error" role="alert">{intents.error}</p>}{intents.ready && !hasMarkers && <p>当前会话没有待核对的原生工具请求标识</p>}
      {intents.markers.map(marker => <article className="al-intent" key={marker.requestId} aria-label={"原生工具原请求 " + marker.requestId}><h4>原请求 <code>{marker.requestId}</code></h4><p>{marker.state === "known" ? "原任务已知 仍须读取详情核对" : "原提交结果尚待核对 不重复发起付费任务"}</p><dl className="al-pairs"><div><dt>原完整请求校验</dt><dd><code>{marker.requestChecksum}</code></dd></div><div><dt>原任务 ID</dt><dd><code>{marker.runId ?? "尚未取得"}</code></dd></div></dl><div className="al-actions"><button type="button" disabled={!readable() || Boolean(receiptReading) || creating} onClick={() => void recover(marker)}><FileSearch size={14} />只读取原请求回执</button>{marker.runId && <><button type="button" disabled={!readable() || creating} onClick={() => openRun(marker.runId)}>读取原任务详情<ArrowRight size={14} /></button><button type="button" disabled={!canRun || Boolean(stopping) || creating} onClick={() => void stop(marker.runId!, marker.requestId, marker.requestChecksum)}><Square size={13} />停止后续步骤</button></>}</div></article>)}
      {intents.preparations.length > 0 && <details><summary>逐项原准备恢复 · {intents.preparations.length} 项</summary><ul>{intents.preparations.map(marker => <li key={marker.runId + ":" + marker.itemId}><code>{marker.itemId}</code> · {marker.state === "known" ? "原准备回执已知" : "原准备结果待核对"}<button type="button" disabled={!readable() || creating} onClick={() => openRun(marker.runId)}>读取原任务并恢复这项准备</button></li>)}</ul></details>}
      {receiptReading && <p role="status">正在只读核对原请求回执</p>}{receiptError && <p className="al-error" role="alert">{receiptError}</p>}{receipt && <section className="al-receipt" aria-label="已找回的原生工具回执"><h4>原请求回执</h4><code>{receipt.requestId}</code>{receipt.disposition === "not_found" ? <p className="al-warning">原回执尚未找到 不等于原请求未提交 不重建正文 不换编号再次付费</p> : <><p>原任务 <code>{receipt.runId}</code> · {agentNativeStatusLabels[receipt.status!]}</p>{!receipt.privateAvailable && <p>当前仅核对标识与状态 原私文不可读取</p>}<button type="button" disabled={!readable()} onClick={() => openRun(receipt.runId)}>读取原任务详情<ArrowRight size={14} /></button></>}</section>}
    </section>
    {readable() && <details className="an-composer" open={!hasMarkers && !selected}><summary>启动新的原生工具模型任务</summary><form aria-label="启动原生工具模型任务" onSubmit={event => { event.preventDefault(); void start(); }}><fieldset disabled={locked || !canRun || !workspace?.canStart || !readiness.canStart()}>
      <label>本次任务目标<textarea required minLength={2} maxLength={4000} rows={3} aria-label="本次任务目标" value={goal} onChange={event => setGoal(event.target.value)} /></label><label>用户补充资料 未经事实核验<textarea maxLength={16000} rows={2} aria-label="用户补充资料 未经事实核验" value={contextText} onChange={event => setContextText(event.target.value)} /></label>
      <div className="al-fields"><label>本次原生任务模型<select required aria-label="本次原生任务模型" value={modelId} onChange={event => setModelId(event.target.value)}><option value="">明确选择当前模型</option>{workspace?.models.map(item => <option key={item.id} value={item.id}>{item.label} · {item.providerLabel}</option>)}</select></label><label>美元费用上限<input required inputMode="decimal" aria-label="美元费用上限" value={cap} onChange={event => setCap(event.target.value)} /></label><label>本次原记录上限<select aria-label="本次原记录上限" value={chosenRows ?? ""} onChange={event => setMaxRows(event.target.value)}>{rowOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>本次模型轮数上限<input required type="number" min={2} max={workspace?.limits.maxModelTurns} step={1} aria-label="本次模型轮数上限" value={maxModelTurns} onChange={event => setMaxModelTurns(event.target.value)} /></label></div>
      <p className="al-muted">按需加载定义 选择读取及完成结论都各占一轮模型决策 多个固定范围或命令类型可能触及轮数上限 所选范围不保证全部读取完成</p>
      {model && <p className="al-muted">原输入报价 {model.inputUsdPerMillion === null ? "未知" : "USD " + model.inputUsdPerMillion} / 百万 token · 原输出报价 {model.outputUsdPerMillion === null ? "未知" : "USD " + model.outputUsdPerMillion} / 百万 token · 原模型单任务上限 {model.maxTaskCostUsd === null ? "未提供 服务端再次核对" : "USD " + model.maxTaskCostUsd}</p>}
      <fieldset className="an-tool-options"><legend>明确允许的原生读取工具</legend>{workspace?.toolWorkspace.tools.map(item => <label key={item.key}><input type="checkbox" aria-label={item.label} checked={tools.includes(item.key)} disabled={!toolAvailable(item.key) && !tools.includes(item.key)} onChange={event => setTools(previous => event.target.checked ? [...previous, item.key] : previous.filter(value => value !== item.key))} />{item.label}<small>{toolAvailable(item.key) ? "按所选固定范围读取" : "当前读取权限不足"}</small></label>)}</fieldset>
      {tools.includes("orders.exceptions.page") && <label>原订单异常范围<select aria-label="原订单异常范围" value={scope.status} onChange={event => setScope(value => ({ ...value, status: event.target.value as ScopeDraft["status"] }))}><option value="open">当前租户待处理异常</option><option value="resolved">当前租户已解决异常</option><option value="all">当前租户全部异常状态</option></select></label>}
      {tools.includes("inventory.balances.page") && <p className="al-muted">库存使用当前受权租户集合 不手填虚构货品或库位 ID 由服务端串行读取并核对完整性</p>}
      {tools.includes("knowledge.search") && <section aria-label="本次知识固定范围"><div className="al-fields"><label>知识主题<select aria-label="知识主题" value={scope.topic} onChange={event => setScope(value => ({ ...value, topic: event.target.value as ScopeDraft["topic"] }))}><option value="all">全部主题</option>{Object.entries(KNOWLEDGE_TOPICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>知识平台<select aria-label="知识平台" value={scope.platform} onChange={event => setScope(value => ({ ...value, platform: event.target.value as ScopeDraft["platform"] }))}><option value="all">通用知识</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label><label>知识站点<input required pattern="ALL|[A-Z]{2}" aria-label="知识站点" value={scope.market} onChange={event => setScope(value => ({ ...value, market: event.target.value.toUpperCase() }))} /></label></div><p className="al-muted">关键词由模型选择 通用知识及 ALL 仅指原通用资料 不等于跨平台或跨站点全集 检索最多返回六个排序候选</p></section>}
      {tools.includes("creative.history") && <section aria-label="本次创意固定对象"><label>创意执行范围<select aria-label="创意执行范围" value={scope.creativeScope} onChange={event => setScope(value => ({ ...value, creativeScope: event.target.value as AgentToolCreativeScope, ownerId: "" }))}><option value="design_batch">批量设计</option><option value="inspection">PSD 模板检查</option><option value="mockup_batch">批量套图</option></select></label><div className="agent-tool-browser"><AgentToolObjectPicker key={scope.creativeScope} kind="creative" scope={scope.creativeScope} authority={authority} value={scope.ownerId} disabled={locked} enabled={toolAvailable("creative.history")} onChange={ownerId => setScope(value => ({ ...value, ownerId }))} onDenied={deny} /></div><p className="al-muted">只从原对象近期有界候选选择 工作台生成任务尚未接入本选择器 不以项目 ID 代替任务 ID</p></section>}
      {tools.includes("factory.capacity") && <section aria-label="本次工厂固定窗口"><div className="agent-tool-browser"><AgentToolObjectPicker kind="factory" authority={authority} value={scope.factoryId} disabled={locked} enabled={toolAvailable("factory.capacity")} onChange={factoryId => setScope(value => ({ ...value, factoryId }))} onDenied={deny} /></div><div className="al-fields"><label>工厂当地起始日期<input required type="date" aria-label="工厂当地起始日期" value={scope.from} onChange={event => setScope(value => ({ ...value, from: event.target.value }))} /></label><label>产能读取天数<input required type="number" min={1} max={31} step={1} aria-label="产能读取天数" value={scope.days} onChange={event => setScope(value => ({ ...value, days: event.target.value }))} /></label></div><p className="al-muted">明确按所选工厂时区填写日期 不自动使用浏览器当天 日期窗口出生后固定 本次读取不预留产能</p></section>}
      <details className="ap-command-picker"><summary>可选原业务提案范围 · 已选 {commands.length} 项</summary><p className="al-muted">不勾选时只读取并形成结论 勾选仅允许模型提出原准备建议 不自动准备或执行 仅按需加载选中定义</p>{["procurement", "incoming", "production", "finance", "advertising"].map(domain => <fieldset key={domain}><legend>{domainNames[domain]}</legend><div className="ap-command-options">{workspace?.toolWorkspace.commands.filter(item => item.domain === domain).map(item => { const chosen = commands.some(value => value.domain === item.domain && value.kind === item.kind); return <label key={item.kind}><input type="checkbox" aria-label={item.label} checked={chosen} disabled={!item.available && !chosen} onChange={event => { const value = AgentPlanCommandKeySchema.safeParse({ domain: item.domain, kind: item.kind }); if (value.success) setCommands(previous => event.target.checked ? [...previous, value.data] : previous.filter(command => agentPlanCommandKey(command) !== agentPlanCommandKey(value.data))); }} />{item.label}{!item.available && <small>当前不可准备</small>}</label>; })}</div></fieldset>)}</details>
      {workspace && <p className="al-muted">本次最多模型 {chosenTurns ?? "请核对"} 轮 · 服务器允许最多 {workspace.limits.maxModelTurns} 轮 · 工具 {Math.min(defaultAgentNativeLimits().maxToolCalls, workspace.limits.maxToolCalls)} 次 · 原记录 {chosenRows ?? "尚未确定"} 条 · 提案 {Math.min(defaultAgentNativeLimits().maxProposals, workspace.limits.maxProposals)} 项 · 本次每类工具一个范围 原历史最多八个范围仍完整保留</p>}
      <button type="submit" className="al-primary" disabled={locked || !canRun || !workspace?.canStart || !readiness.canStart() || !tools.length}><Play size={14} />启动新的付费原生工具任务</button>
    </fieldset></form></details>}
    {creating && <p role="status">正在提交原生工具任务 原请求已固定 不重复发送</p>}{createError && <p className="al-error" role="alert">{createError}</p>}
    {readable() && <section className="al-history" aria-label="原生工具原任务读取"><h3>读取原生工具原任务</h3><form className="al-id-form" onSubmit={event => { event.preventDefault(); openRun(idDraft.trim()); }}><label>原生工具任务 ID<input aria-label="原生工具任务 ID" value={idDraft} onChange={event => setIdDraft(event.target.value)} /></label><button type="submit" disabled={creating || runReading}><FileSearch size={14} />按原 ID 读取任务</button></form>
      {workspace && <details><summary>近期本人原任务 · {workspace.recent.length} 条{workspace.recentHasMore ? " · 还有更早记录" : ""}</summary><p className="al-muted">近期最多 {workspace.recentLimit} 条 不冒称完整历史 更早任务可按原 ID 或纯标量恢复标识读取</p><ul className="al-recent">{workspace.recent.map(item => <li key={item.id}><button type="button" disabled={creating} onClick={() => openRun(item.id)}><span>{agentNativeStatusLabels[item.status]} · {item.createdAt}</span><code>{item.id}</code></button></li>)}</ul>{!workspace.recent.length && <p>近期没有返回本人任务</p>}</details>}
      {selected && <button type="button" disabled={runReading || creating} onClick={() => void loadRun(selected)}><RefreshCw size={14} />只重新读取原任务</button>}{runReading && <p role="status">正在读取原任务 不启动模型</p>}{runError && <p className="al-error" role="alert">{runError}</p>}
      {shown && <><div className="al-actions">{canRun && active(shown.status) && <button type="button" disabled={Boolean(stopping)} onClick={() => void stop(shown.id, shown.requestId, shown.requestChecksum)}><Square size={13} />停止后续步骤</button>}</div><AgentNativeEvidence key={shown.id} run={shown} onDenied={deny} /></>}
    </section>}
    {stopping && <p role="status">正在请求停止后续步骤 在途调用仍可能记费</p>}{stopError && <p className="al-error" role="alert">{stopError}</p>}{stopReceipt && <section className="al-receipt" aria-label="原生工具停止回执"><h4>原停止控制回执</h4><code>{stopReceipt.runId}</code><p>{agentNativeStatusLabels[stopReceipt.status!]} · 不证明在途模型已免除费用或业务原准备已撤销</p></section>}
  </section>;
}
