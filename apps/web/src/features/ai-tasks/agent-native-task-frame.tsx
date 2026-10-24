"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { ArrowRight, FileSearch, Play, RefreshCw, Square, Workflow } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import type { AgentCommandV2Key } from "@yummyai/contracts/ai/agent-command-v2-discovery";
import { useErpAccess } from "../identity/erp-access";
import { AgentReadiness, useAgentReadiness } from "./agent-readiness";
import { NativeTaskBindings, NativeTaskEvidence, nativeTaskStatusLabels, nativeTaskReadChoices } from "./agent-native-reader-registry";
import { nativeTaskErrorText, nativeTaskCommandChoices, type NativeTaskAdapter, type NativeTaskBinding, type NativeTaskReceipt, type NativeTaskView, type NativeTaskWorkspace, type NativeTaskIntent } from "./agent-native-task-adapter";
import "./agent-native-task-frame.css";
import "./agent-fulfillment.css";
import "./agent-plan.css";
import "./agent-tool-browser.css";
import "./agent-resource.css";
import "./agent-native-v2.css";

type Identity = { authority: string | null; scope: string | null };
const active = (status: NativeTaskView["status"]) => ["queued", "running", "stopping"].includes(status);
const domainNames: Record<string, string> = { procurement: "采购", incoming: "来料", production: "生产", finance: "财务", advertising: "广告", fulfillment:"履约" };
const failureText = nativeTaskErrorText;
function costValue(text: string) {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(text.trim())) return null;
  const [whole, fraction = ""] = text.trim().split("."), micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micro >= 1n && micro <= 100_000_000n ? Number(text.trim()) : null;
}
function selectRun(id: string | null, key: NativeTaskAdapter["urlKey"]) {
  const url = new URL(window.location.href); if (id) url.searchParams.set(key, id); else url.searchParams.delete(key);
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
function hidePrivate(value: NativeTaskView): NativeTaskView { return { ...value, privateAvailable: false, goal: null, contextText: null, bindings: [], allowedCommands:[], steps: [], definitions: [], observations: [], result: null, readContracts: null }; }
export function AgentNativeTaskFrame({ adapter }: { adapter: NativeTaskAdapter }) {
  const access = useErpAccess(), identity = useRef<Identity>({ authority: access.authority, scope: access.preferenceScope }); identity.current = { authority: access.authority, scope: access.preferenceScope };
  if (!access.authority || !access.preferenceScope) return <section className="agent-plan agent-native-v2 agent-native-task-frame" aria-label={adapter.text("十一类原生工具模型任务")}><h2><Workflow size={17} />{adapter.text("十一类原生工具模型任务")}</h2><p role="status">正在核对当前本人身份 暂不读取或启动任务</p></section>;
  return <NativeContent key={adapter.version + ":" + access.preferenceScope + ":" + access.authority} identity={identity} adapter={adapter} />;
}
function NativeContent({ identity, adapter }: { identity: RefObject<Identity>; adapter: NativeTaskAdapter }) {
  const access = useErpAccess(), authority = access.authority!, preferenceScope = access.preferenceScope!, params = useSearchParams();
  const canRead = access.can(Permission.WorkflowRead), canRun = access.can(Permission.WorkflowRun), intents = adapter.useIntents(preferenceScope);
  const rawSelected = params.get(adapter.urlKey), parsedId = z.uuidv7().safeParse(rawSelected), selected = params.getAll(adapter.urlKey).length === 1 && parsedId.success ? parsedId.data.toLowerCase() : null;
  const alive = useRef(true), purged = useRef(false), epoch = useRef(0), readBlocked = useRef(false), navigation = useRef(0), createLock = useRef(false), stopLock = useRef(false);
  const workspaceSequence = useRef(0), runSequence = useRef(0), receiptSequence = useRef(0), workspaceController = useRef<AbortController | null>(null), runController = useRef<AbortController | null>(null), receiptController = useRef<AbortController | null>(null), runLoading = useRef(false);
  const current = useRef({ authority, preferenceScope, canRead, canRun, selected }); current.current = { authority: access.authority ?? "", preferenceScope: access.preferenceScope ?? "", canRead, canRun, selected };
  const [workspace, setWorkspace] = useState<NativeTaskWorkspace | null>(null), [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [goal, setGoal] = useState(""), [contextText, setContextText] = useState(""), [modelId, setModelId] = useState(""), [cap, setCap] = useState(""), [maxRows, setMaxRows] = useState("5000"), [maxModelTurns, setMaxModelTurns] = useState("32"), [bindings, setBindings] = useState<NativeTaskBinding[]>([]), [commands, setCommands] = useState<AgentCommandV2Key[]>([]);
  const [formRevision, setFormRevision] = useState(0), [bindingsUpdating, setBindingsUpdating] = useState(false), bindingsBusy = useRef(false);
  const bindingsPending = useCallback((pending: boolean) => { bindingsBusy.current = pending; setBindingsUpdating(pending); }, []);
  const [creating, setCreating] = useState(false), [createError, setCreateError] = useState(""), [run, setRun] = useState<NativeTaskView | null>(null), runRef = useRef<NativeTaskView | null>(null);
  const [runReading, setRunReading] = useState(false), [runError, setRunError] = useState(""), [idDraft, setIdDraft] = useState(rawSelected ?? ""), [receipt, setReceipt] = useState<NativeTaskReceipt | null>(null), [receiptReading, setReceiptReading] = useState<string | null>(null), [receiptError, setReceiptError] = useState("");
  const [stopping, setStopping] = useState<string | null>(null), [stopReceipt, setStopReceipt] = useState<NativeTaskReceipt | null>(null), [stopError, setStopError] = useState(""), [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false);
  const valid = useCallback((token = epoch.current) => alive.current && !purged.current && token === epoch.current && identity.current.authority === authority && identity.current.scope === preferenceScope && current.current.authority === authority && current.current.preferenceScope === preferenceScope, [authority, preferenceScope, identity]);
  const readable = useCallback(() => valid() && !readBlocked.current && current.current.canRead, [valid]);
  const clearPrivate = useCallback(() => {
    workspaceSequence.current++; runSequence.current++; receiptSequence.current++; workspaceController.current?.abort(); runController.current?.abort(); receiptController.current?.abort(); runLoading.current = false;
    setWorkspace(null); setRun(null); runRef.current = null; setReceipt(null); setGoal(""); setContextText(""); setModelId(""); setCap(""); setBindings([]); setCommands([]); setIdDraft("");
    setWorkspaceReading(false); setRunReading(false); setReceiptReading(null); setCreating(false);
  }, []);
  const deny = useCallback(() => { readBlocked.current = true; clearPrivate(); setDenied(true); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; epoch.current++; clearPrivate(); setStopReceipt(null); setStopError(""); setCreateError(""); setRunError(""); setReceiptError(""); setCleared(true); };
    window.addEventListener(adapter.clearEvent, clear);
    return () => { alive.current = false; epoch.current++; workspaceSequence.current++; runSequence.current++; receiptSequence.current++; workspaceController.current?.abort(); runController.current?.abort(); receiptController.current?.abort(); window.removeEventListener(adapter.clearEvent, clear); };
  }, [clearPrivate, adapter.clearEvent]);
  const reloadWorkspace = useCallback(async () => {
    if (!readable()) return; const token = epoch.current, sequence = ++workspaceSequence.current, abort = new AbortController(); workspaceController.current?.abort(); workspaceController.current = abort; setWorkspaceReading(true); setWorkspaceError("");
    try { const value = await adapter.readWorkspace(authority, abort.signal); if (valid(token) && !abort.signal.aborted && sequence === workspaceSequence.current && readable()) setWorkspace(value); }
    catch (failure) { if (valid(token) && !abort.signal.aborted && sequence === workspaceSequence.current) { if (adapter.readDenied(failure)) deny(); else setWorkspaceError(failureText(failure)); } }
    finally { if (valid(token) && sequence === workspaceSequence.current) setWorkspaceReading(false); }
  }, [authority, valid, readable, deny, adapter]);
  useEffect(() => { void reloadWorkspace(); }, [reloadWorkspace]);
  useEffect(() => {
    const refreshModels = () => { void reloadWorkspace(); };
    window.addEventListener("yummyai.models.changed", refreshModels);
    return () => window.removeEventListener("yummyai.models.changed", refreshModels);
  }, [reloadWorkspace]);
  const readiness = useAgentReadiness({ family: adapter.readinessFamily, refreshKey: workspaceSequence.current, workspaceVersion: workspace?.version, enabled: canRead && !denied && !cleared && !workspaceReading && workspaceSequence.current > 0 });
  const loadRun = useCallback(async (id: string) => {
    if (!readable() || runLoading.current) return;
    const token = epoch.current, sequence = ++runSequence.current, abort = new AbortController(); runController.current?.abort(); runController.current = abort; runLoading.current = true; setRunReading(true); setRunError("");
    try {
      const value = await adapter.readRun(id, authority, abort.signal);
      if (!valid(token) || !readable() || abort.signal.aborted || sequence !== runSequence.current || current.current.selected !== id) return;
      if (intents.ownerScope) {
        const marker = adapter.readIntents(intents.ownerScope).find(item => item.requestId === value.requestId);
        if (marker && (marker.requestChecksum !== value.requestChecksum || marker.runId && marker.runId !== value.id)) throw new adapter.RequestError(502, "原任务与保存的请求摘要不一致 不读取替代任务");
        if (marker && marker.state !== "known") adapter.updateIntent({ ...marker, runId: value.id, state: "known" });
      }
      setRun(value); runRef.current = value;
    } catch (failure) { if (valid(token) && !abort.signal.aborted && sequence === runSequence.current && current.current.selected === id) {
      if (adapter.readDenied(failure) && (failure.status !== 404 || runRef.current?.id === id)) deny(); else { setRun(null); runRef.current = null; setRunError(failureText(failure)); }
    } } finally { if (sequence === runSequence.current) { runLoading.current = false; if (valid(token)) setRunReading(false); } }
  }, [authority, valid, readable, deny, intents.ownerScope, adapter]);
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
    navigation.current++; runSequence.current++; runController.current?.abort(); runLoading.current = false; setRun(null); runRef.current = null; selectRun(parsed.data.toLowerCase(), adapter.urlKey); setIdDraft(parsed.data.toLowerCase());
    if (current.current.selected === parsed.data.toLowerCase()) void loadRun(parsed.data.toLowerCase());
  }
  const bindingAvailable = (binding: NativeTaskBinding) => Boolean(workspace && nativeTaskReadChoices(workspace).some(item => item.key === binding.tool && item.available));
  const model = workspace?.models.find(item => item.id === modelId), rowOptions = [...new Set([100, 500, 1000, 2000, 5000, 10000, ...(workspace ? [workspace.limits.maxRows] : [])])].filter(value => value <= (workspace?.limits.maxRows ?? 0)).sort((a, b) => a - b);
  const chosenRows = rowOptions.includes(Number(maxRows)) ? Number(maxRows) : rowOptions.filter(value => value <= 5000).at(-1) ?? rowOptions[0], hasMarkers = intents.markers.length > 0;
  const chosenTurns = workspace && /^\d+$/.test(maxModelTurns) && Number.isInteger(Number(maxModelTurns)) && Number(maxModelTurns) >= 2 && Number(maxModelTurns) <= workspace.limits.maxModelTurns ? Number(maxModelTurns) : null;
  const locked = hasMarkers || !intents.ready || creating || !readable();
  async function start() {
    if (createLock.current || bindingsBusy.current || !readable() || !canRun || !workspace?.canStart || !readiness.canStart() || !intents.ready || hasMarkers) return;
    const token = epoch.current, selectedAtStart = current.current.selected, navAtStart = navigation.current; createLock.current = true; setCreating(true); setCreateError("");
    try {
      const cost = costValue(cap);
      if (chosenTurns === null) throw new adapter.RequestError(400, "请核对本次模型轮数上限 必须为 2 至服务器上限之间的整数");
      if (cost === null || !model || !chosenRows || !bindings.length || bindings.some(binding => !bindingAvailable(binding)) || commands.some(command => !nativeTaskCommandChoices(workspace).some(item => item.available && item.domain === command.domain && item.kind === command.kind))) throw new adapter.RequestError(400, "请明确选择可用模型 工具与有效预算 不发送替代范围");
      if (model.maxTaskCostUsd !== null && cost > model.maxTaskCostUsd) throw new adapter.RequestError(400, "费用上限超过所选原模型允许的任务上限 请重新核对");
      const defaults = adapter.defaults(), limits = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, Math.min(value, workspace.limits[key as keyof typeof defaults])])) as typeof defaults; limits.maxRows = chosenRows; limits.maxModelTurns = chosenTurns;
      const parsed = adapter.createSchema.safeParse({ version: adapter.version, requestId: crypto.randomUUID(), goal, contextText, modelId: model.id, bindings, allowedCommands: commands, limits, maxCostUsd: cost, executionContract: workspace.executionContract });
      if (!parsed.success) throw new adapter.RequestError(400, "原目标或固定范围未通过校验 本次未发起付费任务");
      const prepared = await adapter.prepareIntent(parsed.data, preferenceScope); if (!valid(token) || !readable() || !current.current.canRun || !readiness.canStart()) return;
      adapter.saveIntent(prepared.intent); const marker = adapter.updateIntent({ ...prepared.intent, state: "unknown" }); if (!valid(token) || !readable() || !current.current.canRun || !readiness.canStart()) return;
      const value = await adapter.create(prepared.input, authority); if (!valid(token) || !readable()) return;
      adapter.updateIntent({ ...marker, state: "known", runId: value.id }); setGoal(""); setContextText(""); setBindings([]); setCommands([]); setFormRevision(value => value + 1);
      if (current.current.selected === selectedAtStart && navigation.current === navAtStart) { setRun(value); runRef.current = value; selectRun(value.id, adapter.urlKey); }
    } catch (failure) { if (valid(token)) { if (adapter.readDenied(failure)) deny(); setCreateError(failureText(failure)); } }
    finally { createLock.current = false; if (valid(token)) { setCreating(false); intents.reload(); } }
  }
  async function recover(marker: NativeTaskIntent) {
    if (!readable() || receiptReading) return;
    const sequence = ++receiptSequence.current, token = epoch.current, abort = new AbortController(); receiptController.current?.abort(); receiptController.current = abort; setReceipt(null); setReceiptError(""); setReceiptReading(marker.requestId);
    try { const value = await adapter.readReceipt({ requestId: marker.requestId, requestChecksum: marker.requestChecksum }, authority, abort.signal); if (!valid(token) || !readable() || abort.signal.aborted || sequence !== receiptSequence.current) return;
      if (value.disposition === "known") { if (marker.runId && marker.runId !== value.runId) throw new adapter.RequestError(502, "原回执与已保存任务 ID 不一致"); adapter.updateIntent({ ...marker, runId: value.runId, state: "known" }); } setReceipt(value);
    } catch (failure) { if (valid(token) && !abort.signal.aborted && sequence === receiptSequence.current) { if (adapter.readDenied(failure)) deny(); else setReceiptError(failureText(failure)); } }
    finally { if (valid(token) && sequence === receiptSequence.current) setReceiptReading(null); }
  }
  async function stop(id: string, requestId: string, checksum: string) {
    if (stopLock.current || !valid() || !current.current.canRun) return; stopLock.current = true; setStopping(id); setStopError(""); const token = epoch.current;
    try { const value = await adapter.stop(id, requestId, authority); if (!valid(token)) return;
      if (value.requestChecksum !== checksum) throw new adapter.RequestError(502, "原停止回执与请求摘要不一致 请只读核对"); setStopReceipt(value);
      if (!value.privateAvailable) { setRun(null); runRef.current = null; } else if (readable() && current.current.selected === id) void loadRun(id);
    } catch (failure) { if (valid(token)) { if (adapter.readDenied(failure)) deny(); setStopError(failureText(failure)); } } finally { stopLock.current = false; if (valid(token)) setStopping(null); }
  }
  function newTask() {
    if (!readable() || !canRun || creating || !intents.ready) return;
    if (intents.markers.length && !window.confirm("将清除这 " + intents.markers.length + " 个原请求恢复标识并允许另起新的付费任务\n" + intents.markers.map(marker => marker.requestId).join("\n") + "\n原任务可能仍在执行 此操作不会停止旧任务或撤销业务原准备 新任务可能重复计费\n请确认已核对原请求并接受重复付费风险")) return;
    try { for (const marker of adapter.readIntents(intents.ownerScope)) adapter.forgetIntent(marker); setGoal(""); setContextText(""); setModelId(""); setCap(""); setMaxModelTurns(String(Math.min(32, workspace?.limits.maxModelTurns ?? 32))); setMaxRows("5000"); setBindings([]); setCommands([]); setFormRevision(value => value + 1); setCreateError(""); setReceipt(null); intents.reload(); }
    catch (failure) { setCreateError(failureText(failure)); }
  }
  if (cleared) return <section className="agent-plan agent-native-v2 agent-native-task-frame" aria-label={adapter.text("十一类原生工具模型任务")}><h2>{adapter.text("十一类原生工具模型任务")}</h2><p role="status">当前本人会话已清除 私有目标和来源已隐藏 迟到响应不重建原请求标识</p></section>;
  const visible = readable() && run?.id === selected ? run : null, shown = visible?.privateAvailable && Date.parse(visible.expiresAt) <= Date.now() ? hidePrivate(visible) : visible;
  return <section className="agent-plan agent-native-v2 agent-native-task-frame" aria-label={adapter.text("十一类原生工具模型任务")}><header className="al-heading"><div><h2><Workflow size={18} />{adapter.text("十一类原生工具模型任务")}</h2><p className="al-muted">{adapter.text("独立 v2 可选择十一类原读取及真实对象 按需加载定义 保留旧 v1 与原业务历史")}</p></div><button type="button" disabled={!readable() || workspaceReading || creating} onClick={() => void reloadWorkspace()}><RefreshCw size={14} />重新读取原生模型契约</button></header>
    <p className="al-muted">模型只读取固定范围并生成提案 完成即结算模型阶段 原准备与具体执行都需逐项人工操作 当前客户端连接状态另行核验</p>
    {workspaceReading && <p role="status">正在读取当前模型 工具与执行边界</p>}{workspaceError && <p className="al-error" role="alert">{workspaceError}</p>}{(!canRead || denied) && <p className="al-warning" role="status">当前原生工具任务读取权限尚未核对或已变化 私文已隐藏 已知原任务 ID 仍可按当前运行权限停止后续步骤</p>}
    <AgentReadiness diagnostic={readiness} />
    <section className="al-recovery" aria-label={adapter.text("本人十一类工具任务恢复")}><header><h3><FileSearch size={16} />{adapter.text("本人十一类工具任务恢复")}</h3><button type="button" disabled={!readable() || !canRun || creating || !intents.ready} onClick={newTask}>明确另起新的付费任务</button></header><p className="al-muted">只保存七项本人请求标识 不保存目标 正文 对象名称或游标 读取回执不调用模型</p>
      {!intents.ready && !intents.error && <p role="status">正在核对本人原请求标识</p>}{intents.error && <p className="al-error" role="alert">{intents.error}</p>}{intents.ready && !hasMarkers && <p>当前会话没有待核对的原生工具请求标识</p>}
      {intents.markers.map(marker => <article className="al-intent" key={marker.requestId} aria-label={adapter.text("十一类工具原请求 ") + marker.requestId}><h4>原请求 <code>{marker.requestId}</code></h4><p>{marker.state === "known" ? "原任务已知 仍须读取详情核对" : "原提交结果尚待核对 不重复发起付费任务"}</p><dl className="al-pairs"><div><dt>原完整请求校验</dt><dd><code>{marker.requestChecksum}</code></dd></div><div><dt>原任务 ID</dt><dd><code>{marker.runId ?? "尚未取得"}</code></dd></div></dl><div className="al-actions"><button type="button" disabled={!readable() || Boolean(receiptReading) || creating} onClick={() => void recover(marker)}><FileSearch size={14} />只读取原请求回执</button>{marker.runId && <><button type="button" disabled={!readable() || creating} onClick={() => openRun(marker.runId)}>读取原任务详情<ArrowRight size={14} /></button><button type="button" disabled={!canRun || Boolean(stopping) || creating} onClick={() => void stop(marker.runId!, marker.requestId, marker.requestChecksum)}><Square size={13} />停止后续步骤</button></>}</div></article>)}
      {intents.preparations.length > 0 && <details><summary>逐项原准备恢复 · {intents.preparations.length} 项</summary><ul>{intents.preparations.map(marker => <li key={marker.runId + ":" + marker.itemId}><code>{marker.itemId}</code> · {marker.state === "known" ? "原准备回执已知" : "原准备结果待核对"}<button type="button" disabled={!readable() || creating} onClick={() => openRun(marker.runId)}>读取原任务并恢复这项准备</button></li>)}</ul></details>}
      {receiptReading && <p role="status">正在只读核对原请求回执</p>}{receiptError && <p className="al-error" role="alert">{receiptError}</p>}{receipt && <section className="al-receipt" aria-label={adapter.text("已找回的十一类工具回执")}><h4>原请求回执</h4><code>{receipt.requestId}</code>{receipt.disposition === "not_found" ? <p className="al-warning">原回执尚未找到 不等于原请求未提交 不重建正文 不换编号再次付费</p> : <><p>原任务 <code>{receipt.runId}</code> · {nativeTaskStatusLabels[receipt.status!]}</p>{!receipt.privateAvailable && <p>当前仅核对标识与状态 原私文不可读取</p>}<button type="button" disabled={!readable()} onClick={() => openRun(receipt.runId)}>读取原任务详情<ArrowRight size={14} /></button></>}</section>}
    </section>
    {readable() && <details className="an-composer" open={!hasMarkers && !selected}><summary>{adapter.text("启动新的十一类原生工具模型任务")}</summary><form aria-label={adapter.text("启动十一类原生工具模型任务")} onSubmit={event => { event.preventDefault(); void start(); }}><fieldset disabled={locked || !canRun || !workspace?.canStart || !readiness.canStart()}>
      <label>本次任务目标<textarea required minLength={2} maxLength={4000} rows={3} aria-label="本次任务目标" value={goal} onChange={event => setGoal(event.target.value)} /></label><label>用户补充资料 未经事实核验<textarea maxLength={16000} rows={2} aria-label="用户补充资料 未经事实核验" value={contextText} onChange={event => setContextText(event.target.value)} /></label>
      <div className="al-fields"><label>本次原生任务模型<select required aria-label="本次原生任务模型" value={modelId} onChange={event => setModelId(event.target.value)}><option value="">明确选择当前模型</option>{workspace?.models.map(item => <option key={item.id} value={item.id}>{item.label} · {item.providerLabel}</option>)}</select></label><label>美元费用上限<input required inputMode="decimal" aria-label="美元费用上限" value={cap} onChange={event => setCap(event.target.value)} /></label><label>本次原记录上限<select aria-label="本次原记录上限" value={chosenRows ?? ""} onChange={event => setMaxRows(event.target.value)}>{rowOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>本次模型轮数上限<input required type="number" min={2} max={workspace?.limits.maxModelTurns} step={1} aria-label="本次模型轮数上限" value={maxModelTurns} onChange={event => setMaxModelTurns(event.target.value)} /></label></div>
      <p className="al-muted">按需加载定义 选择读取及完成结论都各占一轮模型决策 多个固定范围或命令类型可能触及轮数上限 所选范围不保证全部读取完成</p>
      {model && <p className="al-muted">原输入报价 {model.inputUsdPerMillion === null ? "未知" : "USD " + model.inputUsdPerMillion} / 百万 token · 原输出报价 {model.outputUsdPerMillion === null ? "未知" : "USD " + model.outputUsdPerMillion} / 百万 token · 原模型单任务上限 {model.maxTaskCostUsd === null ? "未提供 服务端再次核对" : "USD " + model.maxTaskCostUsd}</p>}
      {workspace && <NativeTaskBindings adapter={adapter} key={formRevision} workspace={workspace} authority={authority} value={bindings} disabled={locked || !canRun} onChange={setBindings} onDenied={deny} onPendingChange={bindingsPending} />}
      <details className="ap-command-picker"><summary>可选原业务提案范围 · 已选 {commands.length} 项</summary><p className="al-muted">不勾选时只读取并形成结论 勾选仅允许模型提出原准备建议 不自动准备或执行 仅按需加载选中定义</p>{adapter.commandDomains.map(domain => <fieldset key={domain}><legend>{domainNames[domain]}</legend><div className="ap-command-options">{(workspace ? nativeTaskCommandChoices(workspace) : []).filter(item => item.domain === domain).map(item => { const chosen = commands.some(value => value.domain === item.domain && value.kind === item.kind); return <label key={item.kind}><input type="checkbox" aria-label={item.label} checked={chosen} disabled={!item.available && !chosen} onChange={event => { const value = adapter.commandKeySchema.safeParse({ domain: item.domain, kind: item.kind }); if (value.success) setCommands(previous => event.target.checked ? [...previous, value.data] : previous.filter(command => agentPlanCommandKey(command) !== agentPlanCommandKey(value.data))); }} />{item.label}{!item.available && <small>当前不可准备</small>}</label>; })}</div></fieldset>)}</details>
      {workspace && <p className="al-muted">本次最多模型 {chosenTurns ?? "请核对"} 轮 · 服务器允许最多 {workspace.limits.maxModelTurns} 轮 · 工具 {Math.min(adapter.defaults().maxToolCalls, workspace.limits.maxToolCalls)} 次 · 原记录 {chosenRows ?? "尚未确定"} 条 · 提案 {Math.min(adapter.defaults().maxProposals, workspace.limits.maxProposals)} 项 · 本次已固定 {bindings.length} 个范围 最多 16 个 同类可选多个真实对象</p>}
      <button type="submit" className="al-primary" disabled={locked || bindingsUpdating || !canRun || !workspace?.canStart || !readiness.canStart() || !bindings.length}><Play size={14} />启动新的付费原生工具任务</button>
    </fieldset></form></details>}
    {creating && <p role="status">正在提交原生工具任务 原请求已固定 不重复发送</p>}{createError && <p className="al-error" role="alert">{createError}</p>}
    {readable() && <section className="al-history" aria-label={adapter.text("十一类工具原任务读取")}><h3>{adapter.text("读取十一类工具原任务")}</h3><form className="al-id-form" onSubmit={event => { event.preventDefault(); openRun(idDraft.trim()); }}><label>{adapter.text("十一类工具任务 ID")}<input aria-label={adapter.text("十一类工具任务 ID")} value={idDraft} onChange={event => setIdDraft(event.target.value)} /></label><button type="submit" disabled={creating || runReading}><FileSearch size={14} />按原 ID 读取任务</button></form>
      {workspace && <details><summary>近期本人原任务 · {workspace.recent.length} 条{workspace.recentHasMore ? " · 还有更早记录" : ""}</summary><p className="al-muted">近期最多 {workspace.recentLimit} 条 不冒称完整历史 更早任务可按原 ID 或纯标量恢复标识读取</p><ul className="al-recent">{workspace.recent.map(item => <li key={item.id}><button type="button" disabled={creating} onClick={() => openRun(item.id)}><span>{nativeTaskStatusLabels[item.status]} · {item.createdAt}</span><code>{item.id}</code></button></li>)}</ul>{!workspace.recent.length && <p>近期没有返回本人任务</p>}</details>}
      {selected && <button type="button" disabled={runReading || creating} onClick={() => void loadRun(selected)}><RefreshCw size={14} />只重新读取原任务</button>}{runReading && <p role="status">正在读取原任务 不启动模型</p>}{runError && <p className="al-error" role="alert">{runError}</p>}
      {shown && <><div className="al-actions">{canRun && active(shown.status) && <button type="button" disabled={Boolean(stopping)} onClick={() => void stop(shown.id, shown.requestId, shown.requestChecksum)}><Square size={13} />停止后续步骤</button>}</div><NativeTaskEvidence adapter={adapter} key={shown.id} run={shown} onDenied={deny} /></>}
    </section>}
    {stopping && <p role="status">正在请求停止后续步骤 在途调用仍可能记费</p>}{stopError && <p className="al-error" role="alert">{stopError}</p>}{stopReceipt && <section className="al-receipt" aria-label={adapter.text("十一类工具停止回执")}><h4>原停止控制回执</h4><code>{stopReceipt.runId}</code><p>{nativeTaskStatusLabels[stopReceipt.status!]} · 不证明在途模型已免除费用或业务原准备已撤销</p></section>}
  </section>;
}
