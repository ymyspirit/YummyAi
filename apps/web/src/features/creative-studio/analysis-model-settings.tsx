"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import type { AssistModel } from "@yummyai/contracts/ai/assist";
import { publicModelConfigurationError, type ConfigurationSnapshot, type ConfiguredChannel } from "@yummyai/contracts/ai/model-configuration";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { assistApi, assistReadDenied } from "../ai-assist/assist-client";
import { useErpAccess } from "../identity/erp-access";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { StudioApiError, captureStudioContext, studioApi, studioScopeUnavailable } from "./studio-api";
import { ModelRemovalDialog } from "./model-removal-dialog";
import "./analysis-model-settings.css";

type AnalysisModelRemoval = { model: AssistModel; channel: ConfiguredChannel };
const analysisRemovalKey = (target: AnalysisModelRemoval) => JSON.stringify([target.channel.id, target.model.id]);
const unknownAnalysisRemoval = "模型删除结果尚未核对 请读取原配置确认 未自动重试";

export function AnalysisModelSettings({ revision }: { revision: number }) {
  const access = useErpAccess(), canConfigure = access.can(Permission.ModelConfigure);
  const identity = useRef({ authority: access.authority, owner: access.preferenceScope, canConfigure });
  identity.current = { authority: access.authority, owner: access.preferenceScope, canConfigure };
  if (!access.authority || !access.preferenceScope) return <section id="analysis-model-settings" className="studio-settings-section"><h2>图文分析模型与费用设置</h2><p role="status">当前本人身份尚未核对 分析配置与填写已隐藏</p></section>;
  if (!canConfigure) return <section id="analysis-model-settings" className="studio-settings-section"><h2>图文分析模型与费用设置</h2><p role="status">当前账号没有模型配置权限 不读取渠道或费用设置</p></section>;
  return <AnalysisModelSettingsContent key={access.preferenceScope + ":" + access.authority} authority={access.authority} owner={access.preferenceScope} localDevelopment={access.localDevelopment} identity={identity} revision={revision} />;
}

function AnalysisModelSettingsContent({ revision, authority, owner, localDevelopment, identity }: {
  revision: number; authority: string; owner: string; localDevelopment: boolean;
  identity: RefObject<{ authority: string | null; owner: string | null; canConfigure: boolean }>;
}) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<ConfigurationSnapshot>(), [models, setModels] = useState<AssistModel[]>([]);
  const [providerId, setProviderId] = useState(""), [name, setName] = useState(""), [label, setLabel] = useState("");
  const [inputPrice, setInputPrice] = useState(""), [outputPrice, setOutputPrice] = useState(""), [taskCap, setTaskCap] = useState("1");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [removal, setRemoval] = useState<AnalysisModelRemoval | null>(null), [removalError, setRemovalError] = useState(""), [removalNotice, setRemovalNotice] = useState(""), [rechecking, setRechecking] = useState(false);
  const removing = useRef(false), mutating = useRef(false), alive = useRef(true), epoch = useRef(0), readSequence = useRef(0), blockedRef = useRef(false);
  const removalSequence = useRef(0), reconciling = useRef(false), removalChecks = useRef(new Map<string, string>());
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const [blocked, setBlocked] = useState(false);
  const valid = useCallback((token = epoch.current) => alive.current && !blockedRef.current && epoch.current === token && identity.current.authority === authority && identity.current.owner === owner && identity.current.canConfigure, [authority, owner, identity]);
  const clearPrivate = useCallback(() => {
    blockedRef.current = true; epoch.current++; readSequence.current++; removalSequence.current++; removalChecks.current.clear(); readController.current?.abort(); writeController.current?.abort();
    setBlocked(true); setSnapshot(undefined); setModels([]); setRemoval(null); setProviderId(""); setName(""); setLabel(""); setInputPrice(""); setOutputPrice(""); setTaskCap("1"); setNotice(""); setRemovalError(""); setRemovalNotice(""); setRechecking(false); setBusy(false); setLoading(false);
  }, []);
  const deny = useCallback(() => { clearPrivate(); setError("当前模型配置权限已变化 旧配置与填写已隐藏 请重新核对本人权限"); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { clearPrivate(); setError("当前本人会话已清除 分析配置与填写已隐藏"); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; readSequence.current++; readController.current?.abort(); writeController.current?.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear); };
  }, [clearPrivate]);
  useLeaveGuard(!!(name || label || inputPrice || outputPrice), busy);
  const reload = useCallback(async () => {
    if (!valid() || reconciling.current) return;
    const token = epoch.current, sequence = ++readSequence.current, controller = new AbortController();
    readController.current?.abort(); readController.current = controller;
    setLoading(true); setError("");
    const current = () => valid(token) && !controller.signal.aborted && readSequence.current === sequence;
    try {
      const [configuration, analysis] = await Promise.all([
        studioApi<ConfigurationSnapshot>("configuration", { operation: "configuration.get" }, "POST", controller.signal, captureStudioContext({ authority, ownerScope: owner, localDevelopment }, controller.signal, current)),
        assistApi<AssistModel[]>("models", undefined, controller.signal, authority),
      ]);
      if (current()) { setSnapshot(configuration); setModels(analysis); }
    } catch (cause) {
      if (current()) { setSnapshot(undefined); setModels([]); if (assistReadDenied(cause) || studioScopeUnavailable(cause)) deny(); else setError("图文分析配置读取失败 请重新读取 未采用旧渠道或费用资料"); }
    } finally { if (current()) setLoading(false); }
  }, [authority, owner, localDevelopment, valid, deny]);
  useEffect(() => { if (open) void reload(); }, [open, revision, reload]);
  function requestRemoval(model: AssistModel) {
    if (!valid() || mutating.current || busy || loading) return;
    const providerConfigId = snapshot?.analysisModels.find(item => item.id === model.id)?.providerConfigId;
    const channel = snapshot?.channels.find(item => item.id === providerConfigId);
    if (!channel) { setError("模型所属渠道信息已变化，请点击“刷新分析模型”后重试。"); return; }
    const target = { model, channel };
    removalSequence.current++; setRemovalError(removalChecks.current.get(analysisRemovalKey(target)) ?? ""); setRemovalNotice(""); setError(""); setNotice(""); setRemoval(target);
  }
  async function removeModel() {
    if (!valid() || !removal || removing.current || mutating.current || busy || loading || removalChecks.current.has(analysisRemovalKey(removal))) return;
    const { model, channel } = removal;
    const token = epoch.current, selection = removalSequence.current, key = analysisRemovalKey(removal), controller = new AbortController(); writeController.current = controller;
    const current = () => valid(token) && !controller.signal.aborted && removalSequence.current === selection;
    removing.current = true; mutating.current = true; setRemovalError(""); setRemovalNotice("");
    setBusy(true); setError(""); setNotice("");
    try {
      const configuration = await studioApi<ConfigurationSnapshot>("configuration", { operation: "model.remove", channelId: channel.id, modelId: model.id, revision: channel.revision }, "POST", controller.signal, captureStudioContext({ authority, ownerScope: owner, localDevelopment }, controller.signal, current));
      if (!current()) return;
      setSnapshot(configuration); setModels(items => items.filter(item => item.id !== model.id));
      removalChecks.current.delete(key); setRemoval(null);
      setNotice("模型已删除，历史分析结果保留。");
      window.dispatchEvent(new Event("yummyai.models.changed"));
      await reload();
    } catch (cause) {
      if (current()) {
        const failure = cause instanceof StudioApiError ? publicModelConfigurationError(cause.code, cause.status) : null;
        if (failure) { removalChecks.current.set(key, failure.message); setRemovalError(failure.message); }
        else if (assistReadDenied(cause) || studioScopeUnavailable(cause)) deny();
        else { removalChecks.current.set(key, unknownAnalysisRemoval); setRemovalError(unknownAnalysisRemoval); }
      }
    }
    finally { removing.current = false; mutating.current = false; if (valid(token)) setBusy(false); }
  }
  async function reconcileRemoval() {
    if (!valid() || !removal || removing.current || mutating.current || busy || loading) return;
    const target = removal, token = epoch.current, selection = removalSequence.current, key = analysisRemovalKey(target), sequence = ++readSequence.current, controller = new AbortController();
    readController.current?.abort(); readController.current = controller;
    const current = () => valid(token) && !controller.signal.aborted && readSequence.current === sequence && removalSequence.current === selection;
    removing.current = true; mutating.current = true; reconciling.current = true; setBusy(true); setLoading(true); setRechecking(true); setRemovalNotice("");
    try {
      const configuration = await studioApi<ConfigurationSnapshot>("configuration", { operation: "configuration.get" }, "POST", controller.signal, captureStudioContext({ authority, ownerScope: owner, localDevelopment }, controller.signal, current));
      if (!current()) return;
      setSnapshot(configuration);
      const channel = configuration.channels.find(item => item.id === target.channel.id);
      const model = channel?.models.find(item => item.id === target.model.id) ?? channel?.analysisModels.find(item => item.id === target.model.id);
      setModels(items => items.flatMap(item => {
        const configured = configuration.analysisModels.find(candidate => candidate.id === item.id);
        return configured ? [{ ...item, label: configured.label, model: configured.model, providerLabel: configured.providerLabel }] : [];
      }));
      removalChecks.current.delete(key); setRemovalError("");
      if (!channel || !model) {
        setRemoval(null); setNotice("已核对 当前模型已不在可管理配置中 未再次执行删除");
        return;
      }
      setRemoval({ channel, model: { ...target.model, label: model.label, model: model.name, providerLabel: channel.name } });
      setRemovalNotice("已读取最新配置 该模型仍在 请重新确认删除");
    } catch (cause) {
      if (current()) {
        const failure = cause instanceof StudioApiError ? publicModelConfigurationError(cause.code, cause.status) : null;
        if (!failure && (assistReadDenied(cause) || studioScopeUnavailable(cause))) deny();
        else {
          const feedback = removalChecks.current.get(key) ?? failure?.message ?? unknownAnalysisRemoval;
          removalChecks.current.set(key, feedback); setRemovalError(`${feedback} 原配置读取失败 请重新核对`);
        }
      }
    } finally {
      removing.current = false; mutating.current = false; reconciling.current = false;
      if (valid(token)) { setBusy(false); setLoading(false); setRechecking(false); }
    }
  }
  async function addModel() {
    if (!valid() || mutating.current || busy || loading || !providerId || !snapshot?.channels.some(channel => channel.id === providerId && channel.status === "enabled" && ["openai", "openai-compatible"].includes(channel.provider))) return;
    const token = epoch.current; mutating.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await assistApi("models", { providerConfigId: providerId, model: name, label, inputUsdPerMillion: Number(inputPrice), outputUsdPerMillion: Number(outputPrice), maxTaskCostUsd: Number(taskCap) }, undefined, authority);
      if (!valid(token)) return;
      setName(""); setLabel(""); setInputPrice(""); setOutputPrice(""); setNotice("图文分析模型已保存 可重新读取 Agent 启动诊断 此处未验证模型连通或执行服务");
      await reload(); if (valid(token)) window.dispatchEvent(new Event("yummyai.models.changed"));
    } catch (cause) {
      if (valid(token)) { if (assistReadDenied(cause) || studioScopeUnavailable(cause)) deny(); else setError("保存结果尚未核对 请先刷新分析模型确认原配置 未自动重试"); }
    } finally { mutating.current = false; if (valid(token)) setBusy(false); }
  }
  const disabled = busy || loading || blocked;
  return <details id="analysis-model-settings" className="studio-settings-section studio-analysis-settings" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>图文分析模型与费用设置</summary>
    <p>已保存的文本模型自动用于创意分析、订单预审、生产稿预检等业务助手，无需重复添加。图文任务需要模型支持图片输入和结构化输出；可在下方补充渠道价格和费用上限。</p>
    {error && <p role="alert" className="studio-alert">{error}</p>}{notice && <p role="status">{notice}</p>}{loading && <p role="status">正在读取分析模型…</p>}
    <p>本区直接读取 ERP 配置 不依赖下方画布界面连接 仅配置与读取不会调用付费模型</p>
    <div className="studio-actions"><button type="button" disabled={disabled} onClick={() => void reload()}><RefreshCw size={14} />刷新分析模型</button></div>
    <div className="studio-record-list">{models.map(model => <div className="studio-record studio-analysis-model" key={model.id}><div><strong>{model.label}</strong><small>{model.model} · {model.providerLabel} · {model.maxTaskCostUsd === null ? "共用文本模型 · 费用以渠道账单为准" : `输入 $${model.inputUsdPerMillion}/百万 tokens · 输出 $${model.outputUsdPerMillion}/百万 tokens · 单次预估上限 $${model.maxTaskCostUsd}`}</small></div><button className="studio-model-delete" type="button" aria-label={`删除分析模型 ${model.label}`} disabled={busy || loading || !snapshot?.analysisModels.some(item => item.id === model.id)} onClick={() => requestRemoval(model)}><Trash2 size={14} />删除</button></div>)}</div>
    {removal && <ModelRemovalDialog label={removal.model.label} model={removal.model.model} channel={removal.channel.name} shared={removal.channel.models.some(item => item.id === removal.model.id)} busy={busy} rechecking={rechecking} confirmationBlocked={removalChecks.current.has(analysisRemovalKey(removal))} error={removalError} notice={removalNotice} onReconcile={() => void reconcileRemoval()} onConfirm={() => void removeModel()} onCancel={() => { if (!removing.current) { removalSequence.current++; setRemoval(null); setRemovalError(""); setRemovalNotice(""); } }} />}
    {!loading && !error && snapshot && !models.length && <p>尚未配置图文分析模型。</p>}
    {!loading && !error && snapshot && !snapshot.channels.some(channel => channel.status === "enabled" && ["openai", "openai-compatible"].includes(channel.provider)) && <p role="status">当前没有已启用的受支持分析渠道 需先在渠道配置界面完成配置 本区不会创建渠道或填入价格</p>}
    <form onSubmit={event => { event.preventDefault(); void addModel(); }}>
      <label>分析渠道<select required disabled={disabled} value={providerId} onChange={event => { setProviderId(event.target.value); setName(""); }}><option value="">选择已启用渠道</option>{snapshot?.channels.filter(channel => channel.status === "enabled" && ["openai", "openai-compatible"].includes(channel.provider)).map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
      <label>图文模型名称<input disabled={disabled} list="analysis-model-options" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="选择已添加模型，或手动填写 model ID" /><datalist id="analysis-model-options">{snapshot?.channels.find(channel => channel.id === providerId)?.models.filter(model => model.capability === "text").map(model => <option key={model.id} value={model.name} />)}</datalist></label>
      <label>分析模型显示名称<input disabled={disabled} required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label>输入单价（美元/百万 tokens）<input disabled={disabled} required type="number" min="0" max="1000" step="any" value={inputPrice} onChange={event => setInputPrice(event.target.value)} placeholder="按渠道价格填写；免费模型填 0" /></label>
      <label>输出单价（美元/百万 tokens）<input disabled={disabled} required type="number" min="0" max="5000" step="any" value={outputPrice} onChange={event => setOutputPrice(event.target.value)} /></label>
      <label>单次预估费用上限（美元）<input disabled={disabled} required type="number" min="0.001" max="20" step="any" value={taskCap} onChange={event => setTaskCap(event.target.value)} /></label>
      <div className="studio-actions"><button className="primary" type="submit" disabled={disabled || !providerId || !snapshot}><Plus size={14} />添加图文分析模型</button></div>
    </form><p>费用按配置单价与返回用量估算，未返回用量时显示未知。订单分析内容保留 24 小时，研究分析内容保留 30 天。</p>
  </details>;
}
