"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, CircleHelp, ExternalLink, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Settings2, Trash2 } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { publicModelConfigurationError, type ConfigurationSnapshot, type ConfiguredChannel, type ModelCatalogue, type ModelDefaults } from "@yummyai/contracts/ai/model-configuration";
import { StudioApiError, studioApi, studioReadDenied, useStudioAccessFence } from "./studio-api";
import { ModelRemovalDialog } from "./model-removal-dialog";
import { ModelSettingsChannelEditor } from "./model-settings-workbench-channel";
import { ModelSettingsDialog } from "./model-settings-workbench-dialog";
import { ModelSettingsPricingEditor } from "./model-settings-workbench-pricing";
import { capabilityLabels, channelSaveInput, defaultModelLabel, filterManagedModels, isDefaultModel, managedModels, modelSettingsTab, modelSettingsTabHref, pricingSummary, type ChannelDraft, type ManagedModel } from "./model-settings-presentation";
import "./model-settings-workbench.css";

const tabs = [{ key: "channels", name: "渠道连接" }, { key: "models", name: "模型库" }, { key: "defaults", name: "业务默认" }, { key: "usage", name: "用量与费用" }] as const;
type Tab = typeof tabs[number]["key"];
type Removal = { kind: "model"; model: ManagedModel } | { kind: "channel"; channel: ConfiguredChannel };
type Purpose = "order_review" | "artwork_preflight" | "agent_chat";
type PurposeDraft = Partial<Record<Purpose, string | null>>;
const purposeRows: Array<{ key: Purpose; label: string; detail: string }> = [
  { key: "order_review", label: "订单定制信息解析", detail: "读取定制字段和顾客图片 需要模型支持实际输入" },
  { key: "artwork_preflight", label: "生产稿 AI 预检", detail: "检查稿件与订单要求 实际审核仍在订单中进行" },
  { key: "agent_chat", label: "AI Agent 对话", detail: "用于新对话及协作任务 具体能力以实际执行为准" },
];
const baseRows: Array<{ key: keyof Omit<ModelDefaults, "purposeDefaults">; label: string; detail: string }> = [
  { key: "image", label: "图片生成与无人设计", detail: "用于新建创作 已保存工艺底稿和任务固定的模型优先" },
  { key: "text", label: "文本创作", detail: "同时作为未单独指定业务用途时的候选" },
  { key: "analysis", label: "其他业务分析", detail: "未指定独立用途时沿用此选择 可复用已保存文本模型" },
  { key: "video", label: "视频生成", detail: "用于新建视频任务" },
];
function purposeValues(defaults: ModelDefaults): PurposeDraft {
  return "purposeDefaults" in defaults && defaults.purposeDefaults && typeof defaults.purposeDefaults === "object"
    ? { ...defaults.purposeDefaults } as PurposeDraft : {};
}

export function ModelSettingsWorkbench({ revision, advanced, billing, onState }: {
  revision: number; advanced: ReactNode; billing: ReactNode; onState: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const fence = useStudioAccessFence("model-settings"), alive = useRef(true), sequence = useRef(0), busyRef = useRef(false);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const [tab, setTab] = useState<Tab>("channels"), [visited, setVisited] = useState<Set<Tab>>(() => new Set(["channels"]));
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>(), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [blocked, setBlocked] = useState(false), [cleared, setCleared] = useState(false);
  const [editor, setEditor] = useState<ConfiguredChannel | "new" | null>(null), [editorDirty, setEditorDirty] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null), [removalError, setRemovalError] = useState(""), [removalNotice, setRemovalNotice] = useState("");
  const [modelEdit, setModelEdit] = useState<ManagedModel | null>(null), [modelLabel, setModelLabel] = useState("");
  const modelEditCompleted = useRef(false);
  const [pricingEdit, setPricingEdit] = useState<ManagedModel | null>(null), [pricingDirty, setPricingDirty] = useState(false);
  const [query, setQuery] = useState(""), [capability, setCapability] = useState(""), [channelId, setChannelId] = useState("");
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null), [defaultsRevision, setDefaultsRevision] = useState(0), [defaultsDirty, setDefaultsDirty] = useState(false);
  const [purposes, setPurposes] = useState<PurposeDraft>({}), [purposeRevision, setPurposeRevision] = useState(0), [purposeDirty, setPurposeDirty] = useState(false);
  const defaultsDirtyRef = useRef(false), purposeDirtyRef = useRef(false), [advancedMounted, setAdvancedMounted] = useState(false);
  defaultsDirtyRef.current = defaultsDirty; purposeDirtyRef.current = purposeDirty;
  const id = useId(), available = fence.available && fence.can(Permission.ModelConfigure) && !cleared;
  const setEditorDirtyStable = useCallback((value: boolean) => setEditorDirty(value), []);
  const setPricingDirtyStable = useCallback((value: boolean) => setPricingDirty(value), []);
  const allModels = useMemo(() => snapshot ? managedModels(snapshot) : [], [snapshot]);
  const visibleModels = useMemo(() => filterManagedModels(allModels, query, capability, channelId), [allModels, query, capability, channelId]);
  const disabled = busy || loading || blocked || !available || !snapshot;
  useEffect(() => { onState({ dirty: editorDirty || defaultsDirty || purposeDirty || pricingDirty || !!modelEdit && modelLabel !== modelEdit.label, busy }); }, [editorDirty, defaultsDirty, purposeDirty, pricingDirty, modelEdit, modelLabel, busy, onState]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; readController.current?.abort(); writeController.current?.abort(); }; }, []);
  useEffect(() => {
    const location = () => { const value = modelSettingsTab(window.location.search, window.location.hash); setTab(value); setVisited(previous => new Set(previous).add(value)); };
    location(); window.addEventListener("hashchange", location); window.addEventListener("popstate", location);
    return () => { window.removeEventListener("hashchange", location); window.removeEventListener("popstate", location); };
  }, []);
  function accept(value: ConfigurationSnapshot) {
    setSnapshot(value);
    if (!defaultsDirtyRef.current) { setDefaults(value.defaults); setDefaultsRevision(value.defaultsRevision); }
    if (!purposeDirtyRef.current) { setPurposes(purposeValues(value.defaults)); setPurposeRevision(value.defaultsRevision); }
  }
  function deny() { setCleared(true); sequence.current++; readController.current?.abort(); writeController.current?.abort(); setSnapshot(undefined); setEditor(null); setEditorDirty(false); setRemoval(null); setModelEdit(null); setPricingEdit(null); setPricingDirty(false); setDefaults(null); setDefaultsDirty(false); setPurposes({}); setPurposeDirty(false); setQuery(""); setError("当前本人会话或配置权限已变化 旧配置与填写已隐藏"); }
  const reload = useCallback(async (showNotice = true) => {
    if (!fence.available || !fence.can(Permission.ModelConfigure) || busyRef.current || !alive.current) return;
    const ticket = ++sequence.current, controller = new AbortController(); readController.current?.abort(); readController.current = controller;
    setLoading(true); setError(""); if (!showNotice) setNotice(""); let context: ReturnType<typeof fence.capture>;
    try { context = fence.capture(controller.signal); } catch { if (alive.current) { setLoading(false); deny(); } return null; }
    const current = () => alive.current && ticket === sequence.current && context.isCurrent() && !context.signal.aborted;
    try { const value = await studioApi<ConfigurationSnapshot>("configuration", { operation: "configuration.get" }, "POST", controller.signal, context);
      if (current()) { setSnapshot(value); if (!defaultsDirtyRef.current) { setDefaults(value.defaults); setDefaultsRevision(value.defaultsRevision); }
        if (!purposeDirtyRef.current) { setPurposes(purposeValues(value.defaults)); setPurposeRevision(value.defaultsRevision); }
        setBlocked(false); setRemovalError(""); if (showNotice) setNotice("已读取最新配置 未启动模型调用"); return value; }
      return null;
    } catch (cause) { if (current()) { if (studioReadDenied(cause)) deny(); else { setSnapshot(undefined); setError("配置读取失败 请重新读取 当前未使用旧配置"); } } return null; }
    finally { if (current()) setLoading(false); }
  }, [fence]);
  // Capture only the authority-scoped methods; changing local UI state must not re-read configuration.
  const reloadRef = useRef(reload); reloadRef.current = reload;
  useEffect(() => { void reloadRef.current(false); }, [revision, fence.key]);

  async function mutate(input: Record<string, unknown>, success: string, onAccepted?: (value: ConfigurationSnapshot) => void) {
    if (disabled || busyRef.current) return false;
    busyRef.current = true; const ticket = ++sequence.current, controller = new AbortController(); readController.current?.abort(); writeController.current = controller;
    setBusy(true); setError(""); setNotice(""); let context: ReturnType<typeof fence.capture>;
    try { context = fence.capture(controller.signal); } catch { busyRef.current = false; if (alive.current) { setBusy(false); deny(); } return false; }
    const current = () => alive.current && ticket === sequence.current && context.isCurrent() && !context.signal.aborted;
    try { const value = await studioApi<ConfigurationSnapshot>("configuration", input, "POST", controller.signal, context);
      if (!current()) return false; onAccepted?.(value); accept(value); setBlocked(false); setNotice(success); window.dispatchEvent(new Event("yummyai.models.changed")); return true;
    } catch (cause) {
      if (current()) { if (studioReadDenied(cause)) deny(); else {
        const known = cause instanceof StudioApiError ? publicModelConfigurationError(cause.code, cause.status) : null;
        setBlocked(true); const message = known?.code === "model_configuration_revision_conflict" && !String(input.operation).endsWith("remove")
          ? "渠道或模型配置已变化 本次修改未提交 请读取最新配置后重新核对" : known?.message ?? "配置结果尚未核对 请读取原配置确认 未自动重试";
        setError(message); if (removal) setRemovalError(message);
      } } return false;
    } finally { busyRef.current = false; if (alive.current && context.isCurrent()) setBusy(false); }
  }
  async function discover(draft: ChannelDraft) {
    if (disabled || busyRef.current) return null;
    busyRef.current = true; const ticket = ++sequence.current, controller = new AbortController(); readController.current?.abort(); writeController.current = controller;
    setBusy(true); setError(""); let context: ReturnType<typeof fence.capture>;
    try { context = fence.capture(controller.signal); } catch { busyRef.current = false; if (alive.current) { setBusy(false); deny(); } return null; }
    try { const value = await studioApi<ModelCatalogue>("configuration", { operation: "channel.discover", ...(draft.id ? { id: draft.id } : {}), baseUrl: draft.baseUrl.trim(), ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}) }, "POST", controller.signal, context);
      if (!alive.current || ticket !== sequence.current || !context.isCurrent()) return null; return value;
    } catch (cause) { if (alive.current && context.isCurrent()) { if (studioReadDenied(cause)) deny(); else setError("模型目录读取失败 请核对接口地址 协议和密钥 也可手动添加模型"); } return null; }
    finally { busyRef.current = false; if (alive.current && context.isCurrent()) setBusy(false); }
  }
  function chooseTab(value: Tab) { setTab(value); setVisited(previous => new Set(previous).add(value)); window.history.replaceState(window.history.state, "", modelSettingsTabHref(window.location.href, value)); }
  async function reconcileRemoval() {
    if (!removal) return;
    const target = removal, value = await reloadRef.current(); if (!value) return;
    const channel = value.channels.find(item => item.id === (target.kind === "channel" ? target.channel.id : target.model.channel.id));
    const model = target.kind === "model" ? managedModels(value).find(item => item.id === target.model.id) : null;
    if (!channel || target.kind === "model" && !model) { setRemoval(null); setRemovalError(""); setNotice("已核对 原配置已不在当前可管理列表中 未再次删除"); return; }
    setRemoval(target.kind === "channel" ? { kind: "channel", channel } : { kind: "model", model: model! });
    setRemovalError(""); setRemovalNotice("已读取最新配置 该配置仍在 请重新确认删除");
  }
  async function confirmRemoval() {
    if (!snapshot || !removal) return;
    const currentChannel = snapshot.channels.find(channel => channel.id === (removal.kind === "channel" ? removal.channel.id : removal.model.channel.id));
    if (!currentChannel || removal.kind === "model" && !managedModels(snapshot).some(model => model.id === removal.model.id)) { setRemoval(null); setNotice("已核对 原配置已不在当前列表中 未重复删除"); return; }
    const input = removal.kind === "channel" ? { operation: "channel.remove", id: currentChannel.id, revision: currentChannel.revision }
      : { operation: "model.remove", channelId: currentChannel.id, modelId: removal.model.id, revision: currentChannel.revision };
    if (await mutate(input, "已删除配置 历史任务与文件保留")) { setRemoval(null); setRemovalError(""); }
  }
  function useDefaults(model: ManagedModel) { chooseTab("defaults"); setNotice(`在业务用途中选择 ${model.label} 保存后用于你的新任务`); }
  const tabButton = (value: Tab) => `${id}-${value}-tab`, tabPanel = (value: Tab) => `${id}-${value}-panel`;
  if (!available) return <section className="ai-settings-workbench"><p role="alert">{error || "当前本人身份或模型配置权限尚未核对 配置与填写已隐藏"}</p></section>;
  return <section className="ai-settings-workbench" aria-label="统一模型配置" aria-busy={busy || loading}>
    <div className="ai-settings-topline"><div className="ai-settings-summary"><span>{snapshot ? `${snapshot.channels.length} 个渠道` : "正在读取渠道"}</span><span>{snapshot ? `${allModels.length} 个已配置模型` : "正在读取模型"}</span><span>默认选择按本人保存</span></div>
      <button type="button" disabled={busy || loading} onClick={() => void reloadRef.current()}><RefreshCw size={15} />{loading ? "正在读取…" : blocked ? "读取原配置核对" : "刷新配置"}</button></div>
    <div role="tablist" aria-label="模型配置分区" className="ai-settings-tabs">{tabs.map((item, index) => <button key={item.key} id={tabButton(item.key)} role="tab" aria-selected={tab === item.key} aria-controls={tabPanel(item.key)}
      tabIndex={tab === item.key ? 0 : -1} type="button" onClick={() => chooseTab(item.key)} onKeyDown={event => { let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length; else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === "Home") next = 0; else if (event.key === "End") next = tabs.length - 1; else return;
        event.preventDefault(); const value = tabs[next]!.key; chooseTab(value); document.getElementById(tabButton(value))?.focus(); }}>{item.name}</button>)}</div>
    {error && <p role="alert" className="studio-alert">{error}</p>}{notice && <p role="status" className="ai-settings-notice">{notice}</p>}
    {blocked && <p className="ai-settings-warning">核对前暂不能再次保存 读取配置不会重试上次操作</p>}
    {!snapshot && !error && <div role="status" className="ai-settings-loading"><span /><span /><span />正在读取本人可管理的渠道与模型…</div>}
    <div role="tabpanel" id={tabPanel("channels")} aria-labelledby={tabButton("channels")} hidden={tab !== "channels"} className="ai-settings-panel">
      <div className="ai-settings-section-heading"><div><h2>连接一次 统一使用</h2><p>添加渠道后获取模型目录 再为订单 设计和 Agent 选择默认模型</p></div><button className="primary" type="button" disabled={disabled || !snapshot} onClick={() => { setError(""); setEditor("new"); }}><Plus size={16} />添加渠道</button></div>
      {snapshot && <div className="ai-settings-channel-list">{snapshot.channels.map(channel => { const editable = ["openai", "openai-compatible"].includes(channel.provider) && new Set(channel.models.map(model => model.name)).size === channel.models.length;
        return <article key={channel.id} className="ai-settings-channel-row"><div className="ai-settings-channel-identity"><strong>{channel.name}</strong><span className={channel.status === "enabled" ? "ai-settings-state" : "ai-settings-muted"}>{channel.status === "enabled" ? "已启用" : "已停用"}</span>
        <p>{channel.baseUrl}</p><small>{channel.models.length + channel.analysisModels.length} 个配置模型 · {channel.hasCredential ? "密钥已保存" : "尚无密钥"} · 能力未实测</small></div>
        <div className="ai-settings-row-actions"><button type="button" disabled={disabled || !editable} aria-label={`编辑渠道 ${channel.name}`} title={editable ? undefined : "此渠道类型或历史同名多用途配置请在高级兼容配置中核对"} onClick={() => { setError(""); setEditor(channel); }}><Pencil size={14} />编辑</button>
          <button type="button" disabled={disabled} onClick={() => void mutate({ operation: "channel.status", id: channel.id, revision: channel.revision, status: channel.status === "enabled" ? "disabled" : "enabled" }, channel.status === "enabled" ? "渠道已停用 历史任务与文件保留" : "渠道已启用 能力仍需在实际任务中验证")}>{channel.status === "enabled" ? "停用" : "启用"}</button>
          <details className="ai-settings-more"><summary aria-label={`更多渠道操作 ${channel.name}`}><MoreHorizontal size={18} /><span className="sr-only">更多操作</span></summary><div><button type="button" className="ai-settings-delete-action" disabled={disabled} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setRemovalError(""); setRemovalNotice(""); setRemoval({ kind: "channel", channel }); }}><Trash2 size={14} />删除渠道</button></div></details></div>{!editable && <p className="ai-settings-muted">此渠道类型或历史同名多用途配置请在高级兼容配置中核对 原模型保留</p>}</article>; })}
        {!snapshot.channels.length && <p className="ai-settings-empty">还没有渠道 点击添加渠道开始配置</p>}</div>}
      <details className="ai-settings-disclosure ai-settings-advanced" onToggle={event => { if (event.currentTarget.open) setAdvancedMounted(true); }}><summary><Settings2 size={16} />高级兼容配置</summary>
        <p className="ai-settings-muted">保留原画布配置和历史分析模型入口 两处共用同一份 ERP 配置 修改其他入口后请先读取最新配置</p>{advancedMounted && advanced}</details>
    </div>
    <div role="tabpanel" id={tabPanel("models")} aria-labelledby={tabButton("models")} hidden={tab !== "models"} className="ai-settings-panel">
      <div className="ai-settings-section-heading"><div><h2>模型库</h2><p>配置用途和实际能力分开显示 接口目录可见与保存成功均不代表已实测</p></div><button type="button" disabled={disabled} onClick={() => chooseTab("channels")}><Plus size={15} />从渠道添加模型</button></div>
      <div className="ai-settings-model-filters"><label className="ai-settings-search"><Search size={15} /><span className="sr-only">搜索模型或渠道</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型名称 model ID 或渠道" /></label>
        <label><span className="sr-only">筛选模型用途</span><select value={capability} onChange={event => setCapability(event.target.value)}><option value="">全部用途</option>{Object.entries(capabilityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label><span className="sr-only">筛选模型渠道</span><select value={channelId} onChange={event => setChannelId(event.target.value)}><option value="">全部渠道</option>{snapshot?.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label></div>
      {snapshot && <><p className="ai-settings-muted" role="status">显示 {visibleModels.length} / 共 {allModels.length} 个配置模型</p><div className="ai-settings-model-list">{visibleModels.map(model => <article key={model.id} className="ai-settings-model-row"><div className="ai-settings-model-identity"><div className="ai-settings-model-title"><strong>{model.label}</strong>{isDefaultModel(snapshot.defaults, model.id) && <span className="ai-settings-state"><Check size={12} />本人默认</span>}</div><code>{model.name}</code><small>{model.channel.name} · {capabilityLabels[model.capability]}（配置用途）</small></div>
        <div className="ai-settings-model-health"><span>{model.status === "enabled" && model.channel.status === "enabled" ? "已配置" : "已停用"}</span><small><CircleHelp size={13} />能力未实测</small>{["text", "analysis"].includes(model.capability) && <small>{pricingSummary(model.analysisPricing)}{model.analysisPricingInheritedFrom && " · 继承关联配置"}</small>}</div>
        <div className="ai-settings-row-actions"><button type="button" disabled={disabled || model.channel.status !== "enabled" || model.status !== "enabled"} onClick={() => useDefaults(model)}>设置用途</button>
          <button type="button" disabled={disabled} aria-label={`编辑模型 ${model.label}`} onClick={() => { setError(""); modelEditCompleted.current = false; setModelEdit(model); setModelLabel(model.label); }}><Pencil size={14} />编辑</button>
          <button type="button" disabled={disabled} onClick={() => void mutate({ operation: "model.status", channelId: model.channel.id, modelId: model.id, revision: model.channel.revision, status: model.status === "enabled" ? "disabled" : "enabled" }, model.status === "enabled" ? "模型已停用 历史任务与文件保留" : "模型已启用 能力仍未实测")}>{model.status === "enabled" ? "停用" : "启用"}</button>
          <details className="ai-settings-more"><summary aria-label={`更多模型操作 ${model.label}`}><MoreHorizontal size={18} /><span className="sr-only">更多操作</span></summary><div>{["text", "analysis"].includes(model.capability) && <button type="button" disabled={disabled} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setError(""); setPricingEdit(model); }}>价格与费用策略</button>}<button type="button" className="ai-settings-delete-action" disabled={disabled} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setRemovalError(""); setRemovalNotice(""); setRemoval({ kind: "model", model }); }}><Trash2 size={14} />删除模型</button></div></details></div></article>)}
        {!visibleModels.length && <p className="ai-settings-empty">{allModels.length ? "没有匹配的模型 请调整筛选条件" : "还没有配置模型 请先在渠道连接中获取并选择模型"}</p>}</div></>}
      <p className="ai-settings-workspace-links">在现有工作台用实际任务核验 <Link href="/ai-tasks">Agent 工作台<ExternalLink size={13} /></Link><Link href="/creative-designs/studio/image">图片工作台<ExternalLink size={13} /></Link></p>
    </div>
    <div role="tabpanel" id={tabPanel("defaults")} aria-labelledby={tabButton("defaults")} hidden={tab !== "defaults"} className="ai-settings-panel">
      <div className="ai-settings-section-heading"><div><h2>业务默认模型</h2><p>只保存到你的本人账户 用于后续新任务 原任务 工艺底稿和固定版本继续使用其已绑定模型</p></div></div>
      {snapshot && defaults && <>
        <form className="ai-settings-defaults-form" onSubmit={async event => { event.preventDefault(); if (purposeRevision !== snapshot.defaultsRevision) return;
          await mutate({ operation: "purpose-defaults.save", revision: purposeRevision, defaults: purposes }, "本人业务用途默认已保存 后续新任务将采用该选择", () => { purposeDirtyRef.current = false; setPurposeDirty(false); }); }}>
          <h3>订单与 Agent</h3>{purposeRows.map(row => <label key={row.key} className="ai-settings-default-row"><span><strong>{row.label}</strong><small>{row.detail}</small></span>
            <select value={purposes[row.key] ?? ""} disabled={disabled} onChange={event => { setPurposes(value => ({ ...value, [row.key]: event.target.value || null })); setPurposeDirty(true); }}>
              <option value="">沿用通用分析或文本默认</option>{snapshot.analysisModels.map(model => <option key={model.id} value={model.id}>{model.label} · {model.providerLabel}</option>)}</select></label>)}
          {purposeDirty && purposeRevision !== snapshot.defaultsRevision && <p role="alert" className="ai-settings-warning">默认配置已变化 当前填写未覆盖其他修改 <button type="button" onClick={() => { setPurposes(purposeValues(snapshot.defaults)); setPurposeRevision(snapshot.defaultsRevision); setPurposeDirty(false); }}>载入最新业务默认</button></p>}
          <div className="ai-settings-form-actions"><span>{purposeDirty ? "有未保存的业务用途选择" : "沿用通用默认时无需重复配置"}</span><button className="primary" type="submit" disabled={disabled || !purposeDirty || purposeRevision !== snapshot.defaultsRevision}>保存业务用途默认</button></div>
        </form>
        <form className="ai-settings-defaults-form" onSubmit={async event => { event.preventDefault(); if (defaultsRevision !== snapshot.defaultsRevision) return;
          await mutate({ operation: "defaults.save", revision: defaultsRevision, defaults }, "本人通用默认已保存 原任务的固定模型保持", () => { defaultsDirtyRef.current = false; setDefaultsDirty(false); }); }}>
          <h3>新建创作的通用默认</h3>{baseRows.map(row => { const options = row.key === "analysis" ? snapshot.analysisModels.map(model => ({ id: model.id, label: model.label }))
            : allModels.filter(model => model.capability === row.key && model.status === "enabled" && model.channel.status === "enabled");
            return <label key={row.key} className="ai-settings-default-row"><span><strong>{row.label}</strong><small>{row.detail}</small></span><select value={defaults[row.key] ?? ""} disabled={disabled} onChange={event => { setDefaults(value => value ? { ...value, [row.key]: event.target.value || null } : value); setDefaultsDirty(true); }}>
              <option value="">未指定 · 沿用业务现有选择</option>{options.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>; })}
          {defaultsDirty && defaultsRevision !== snapshot.defaultsRevision && <p role="alert" className="ai-settings-warning">默认配置已变化 当前填写未覆盖其他修改 <button type="button" onClick={() => { setDefaults(snapshot.defaults); setDefaultsRevision(snapshot.defaultsRevision); setDefaultsDirty(false); }}>载入最新通用默认</button></p>}
          <div className="ai-settings-form-actions"><span>{defaultsDirty ? "有未保存的通用默认选择" : `当前分析默认 ${defaultModelLabel(snapshot, snapshot.defaults.analysis ?? snapshot.defaults.text)}`}</span><button className="primary" type="submit" disabled={disabled || !defaultsDirty || defaultsRevision !== snapshot.defaultsRevision}>保存通用默认</button></div>
        </form>
      </>}
    </div>
    <div role="tabpanel" id={tabPanel("usage")} aria-labelledby={tabButton("usage")} hidden={tab !== "usage"} className="ai-settings-panel ai-settings-usage-panel">
      <div className="ai-settings-section-heading"><div><h2>用量与费用</h2><p>用量按真实接口回执记录 官方参考成本与渠道实际账单分别核对 缺失用量或未知价格保持未知</p></div><Link href="/model-billing">打开完整费用核对<ExternalLink size={14} /></Link></div>
      {visited.has("usage") && billing}
    </div>
    {editor && <ModelSettingsChannelEditor key={editor === "new" ? "new" : editor.id} channel={editor === "new" ? undefined : editor} currentChannel={editor === "new" ? undefined : snapshot?.channels.find(channel => channel.id === editor.id)} channels={snapshot?.channels}
      busy={busy || loading} blocked={blocked} error={error} onDirty={setEditorDirtyStable} onClose={() => { setEditor(null); setEditorDirty(false); }}
      onReconcile={() => void reloadRef.current()} onOpenExisting={channel => { setEditor(channel); setEditorDirty(false); setError(""); setNotice("已打开保存的渠道 请核对模型与协议 密钥保持隐藏"); }} onSave={draft => mutate(channelSaveInput(draft), "渠道与模型已保存 能力仍需在实际任务中验证")} onDiscover={discover} />}
    {pricingEdit && <ModelSettingsPricingEditor key={pricingEdit.id} model={pricingEdit} currentModel={allModels.find(model => model.id === pricingEdit.id)} catalogue={snapshot?.officialPriceCatalog}
      busy={busy || loading} blocked={blocked} error={error} onDirty={setPricingDirtyStable} onClose={() => { setPricingEdit(null); setPricingDirty(false); }} onReconcile={() => void reloadRef.current()}
      onSave={(pricing, pinnedRevision) => mutate({ operation: "model.analysis-pricing.save", channelId: pricingEdit.channel.id, modelId: pricingEdit.id, revision: pinnedRevision, pricing }, "费用策略已保存 旧调用回执与账单保持")}
      onOpenRelated={async relatedId => { const value = await reloadRef.current(); if (!value) return; const related = managedModels(value).find(model => model.id === relatedId);
        if (!related) { setError("关联分析模型当前不可访问 请保留现有策略并核对原配置"); return; } setError(""); setPricingDirty(false); setPricingEdit(related); }} />}
    {modelEdit && <ModelSettingsDialog title={`编辑模型 · ${modelEdit.label}`} description="调整显示名称 model ID 和原任务版本保持" busy={busy || loading} onClose={() => setModelEdit(null)}
      onBeforeClose={() => modelEditCompleted.current || modelLabel === modelEdit.label || window.confirm("有未保存的模型名称修改 确定放弃并关闭？")}>{close => <form onSubmit={async event => { event.preventDefault(); const current = allModels.find(model => model.id === modelEdit.id); if (!current || current.channel.revision !== modelEdit.channel.revision) return;
        if (await mutate({ operation: "model.update", channelId: modelEdit.channel.id, modelId: modelEdit.id, revision: modelEdit.channel.revision, label: modelLabel.trim() }, "模型显示名称已保存")) { modelEditCompleted.current = true; close(); } }}>
        <div className="ai-settings-dialog-body"><label>模型显示名称<input required maxLength={100} value={modelLabel} disabled={disabled} onChange={event => setModelLabel(event.target.value)} /></label><p className="ai-settings-muted">{modelEdit.channel.name} · {modelEdit.name}</p>{error && <p role="alert" className="studio-alert">{error}</p>}
          {allModels.find(model => model.id === modelEdit.id)?.channel.revision !== modelEdit.channel.revision && <p role="alert" className="ai-settings-warning">模型配置已变化 当前填写未覆盖原配置 <button type="button" disabled={busy || blocked} onClick={() => { const current = allModels.find(model => model.id === modelEdit.id); if (current) { setModelEdit(current); setModelLabel(current.label); } }}>载入最新模型名称</button></p>}</div>
        <footer className="ai-settings-dialog-footer">{blocked && <button type="button" disabled={busy || loading} onClick={() => void reloadRef.current()}>读取原配置核对</button>}<button type="button" disabled={busy || loading} onClick={close}>取消</button><button className="primary" type="submit" disabled={disabled || !modelLabel.trim() || modelLabel === modelEdit.label || allModels.find(model => model.id === modelEdit.id)?.channel.revision !== modelEdit.channel.revision}>保存显示名称</button></footer>
      </form>}</ModelSettingsDialog>}
    {removal?.kind === "model" && <ModelRemovalDialog label={removal.model.label} model={removal.model.name} channel={removal.model.channel.name} shared={removal.model.shared} busy={busy || loading}
      confirmationBlocked={blocked} rechecking={loading} error={removalError} notice={removalNotice} onConfirm={() => void confirmRemoval()} onCancel={() => { if (!busy) { setRemoval(null); setRemovalError(""); setRemovalNotice(""); } }} onReconcile={() => void reconcileRemoval()} />}
    {removal?.kind === "channel" && <ModelSettingsDialog title={`删除渠道“${removal.channel.name}”？`} description={`${removal.channel.name} · ${removal.channel.baseUrl}`} busy={busy || loading} onClose={() => setRemoval(null)}>{close => <>
      <div className="ai-settings-dialog-body"><p>将删除渠道保存的密钥 并移除以下模型配置 历史任务和生成文件保留 你的相关默认选择会清除</p>
        <ul className="ai-settings-removal-models">{[...removal.channel.models, ...removal.channel.analysisModels].map(model => <li key={model.id}>{model.name} · {model.label}</li>)}</ul>
        {!!removal.channel.dependentRoutes.length && <p className="ai-settings-warning">此渠道仍被 {removal.channel.dependentRoutes.length} 个业务路由使用 需先调整关联路由</p>}<p>如有排队或进行中的任务 需等待完成或取消后再删除</p>
        {(removalError || error) && <p role="alert" className="studio-alert">{removalError || error}</p>}{removalNotice && <p role="status">{removalNotice}</p>}{blocked && <p>核对前不能再次删除 读取配置不会重试删除</p>}</div>
      <footer className="ai-settings-dialog-footer"><button type="button" disabled={busy || loading} onClick={() => void reconcileRemoval()}><RefreshCw size={14} />读取原配置核对</button><button type="button" disabled={busy || loading} onClick={close}>取消</button>
        <button type="button" className="ai-settings-danger" disabled={busy || loading || blocked || !!removal.channel.dependentRoutes.length} onClick={() => void confirmRemoval()}><Trash2 size={14} />确认删除</button></footer>
    </>}</ModelSettingsDialog>}
  </section>;
}
