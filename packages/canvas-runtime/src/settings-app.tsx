import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Select, Tabs } from "antd";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { ChannelEditorDrawer, type SettingsChannel } from "upstream-channel-editor";
import { AppProviders } from "@/components/layout/app-providers";
import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, type ModelChannel } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ConfigurationSnapshot, ConfiguredChannel, ModelDefaults } from "@yummyai/contracts/ai/model-configuration";
import i18n from "@/i18n";
import { initialized, notify } from "./rpc";
import { isSavedSettingsChannel, settingsRequest } from "./settings-transport";
import { useStudioModels } from "./model-state";
import "antd/dist/reset.css";
import "@/styles/globals.css";
import "./erp.css";

const init = await initialized;
if (init.tool !== "settings") throw new Error("请从 ERP 模型配置页打开");
await i18n.changeLanguage("zh-CN");
useThemeStore.getState().setTheme(init.theme);
window.addEventListener("studio.theme", event => { const theme = (event as CustomEvent).detail.theme; if (theme === "light" || theme === "dark") useThemeStore.getState().setTheme(theme); });

function editable(channel: ConfiguredChannel): SettingsChannel {
  if (!["openai", "openai-compatible"].includes(channel.provider)) throw new Error("此渠道协议尚未接入编辑 请保留原配置");
  return { id: channel.id, name: channel.name, baseUrl: channel.baseUrl, apiKey: "", apiFormat: channel.provider === "openai" ? "responses" : "openai", models: channel.models.map(model => ({ name: model.name, capability: model.capability })) };
}
const protocolLabel = (provider: string) => provider === "openai" ? "Responses" : provider === "openai-compatible" ? "Chat Completions" : "其他协议";
type ManagedModel = { id: string; name: string; label: string; capability: "image" | "video" | "text" | "analysis" };
const capabilityLabel = { image: "图片", video: "视频", text: "文字 / 业务分析", analysis: "图文分析" };
function Settings() {
  const { message } = App.useApp();
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>(), [editing, setEditing] = useState<SettingsChannel | null>(null);
  const [defaults, setDefaults] = useState<ModelDefaults>(), [writing, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [catalogue, setCatalogue] = useState("");
  const busy = writing || loading;
  const [tab, setTab] = useState("channels"), [channelFilter, setChannelFilter] = useState("all"), [capabilityFilter, setCapabilityFilter] = useState("all"), [query, setQuery] = useState("");
  const [removal, setRemoval] = useState<{ channel: ConfiguredChannel; model?: ManagedModel } | null>(null), [removalError, setRemovalError] = useState("");
  const [addingModels, setAddingModels] = useState(false), [addingChannelId, setAddingChannelId] = useState<string>();
  const removing = useRef(false);
  const accept = useCallback((value: ConfigurationSnapshot) => { setSnapshot(value); setDefaults(value.defaults); setError(""); useStudioModels.setState({ status: "ready", error: "" }); }, []);
  const load = useCallback(async () => { setLoading(true); try { accept(await settingsRequest({ operation: "configuration.get" })); } catch (cause) { setError(cause instanceof Error ? cause.message : "配置读取失败"); } finally { setLoading(false); } }, [accept]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const update = (event: Event) => { const info = (event as CustomEvent).detail; setCatalogue(`渠道已返回 ${info.count} 个模型 · ${new Date(info.fetchedAt).toLocaleTimeString()}${info.skipped ? ` · ${info.skipped} 条格式不兼容记录未列入` : ""}`); };
    window.addEventListener("settings.catalogue", update);
    return () => window.removeEventListener("settings.catalogue", update);
  }, []);
  const defaultsDirty = !!snapshot && JSON.stringify(defaults) !== JSON.stringify(snapshot.defaults);
  useEffect(() => { const refresh = () => { if (!editing && !removal && !defaultsDirty && !busy) void load(); }; window.addEventListener("studio.refresh", refresh); return () => window.removeEventListener("studio.refresh", refresh); }, [editing, removal, defaultsDirty, busy, load]);
  useEffect(() => { notify("settings.preferences", { dirty: defaultsDirty, busy: writing }); }, [defaultsDirty, writing]);
  useEffect(() => { notify("settings.view", { tab, channelId: channelFilter }); }, [tab, channelFilter]);
  const channels = snapshot?.channels ?? [];
  useEffect(() => { if (snapshot && channelFilter !== "all" && !snapshot.channels.some(channel => channel.id === channelFilter)) setChannelFilter("all"); }, [snapshot, channelFilter]);
  const selectedChannel = channels.find(channel => channel.id === channelFilter);
  const managedModels = channels.flatMap(channel => [
    ...channel.models.map(model => ({ channel, model: model as ManagedModel })),
    ...(channel.analysisModels ?? []).map(model => ({ channel, model: { ...model, capability: "analysis" as const } })),
  ]);
  const visibleModels = managedModels.filter(({ channel, model }) => (channelFilter === "all" || channel.id === channelFilter)
    && (capabilityFilter === "all" || model.capability === capabilityFilter || (capabilityFilter === "analysis" && model.capability === "text"))
    && `${model.name} ${model.label} ${channel.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  const modelConfig = useMemo(() => {
    // This upstream projection supplies model names to the picker only; actual
    // transport protocol stays with the server channel and the editor above.
    const active: ModelChannel[] = snapshot?.channels.filter(channel => channel.status === "enabled" && ["openai", "openai-compatible"].includes(channel.provider)).map(channel => ({ ...editable(channel), apiFormat: "openai" })) ?? [];
    return { ...defaultConfig, channelMode: "remote" as const, channels: active, models: active.flatMap(channel => channel.models.map(model => `${channel.id}::${model.name}`)) };
  }, [snapshot]);
  async function saveChannel(draft: SettingsChannel) {
    const current = snapshot?.channels.find(channel => channel.id === draft.id);
    if (!["openai", "responses"].includes(draft.apiFormat)) throw new Error("请选择 Responses 或 Chat Completions 文本调用协议");
    if (current && editable(current).apiFormat !== draft.apiFormat) throw new Error("已有渠道的文本调用协议保持不变 其他协议请新建渠道");
    if (draft.models.some(model => !["image", "video", "text"].includes(model.capability))) throw new Error("所选模型包含尚未接入的音频用途，请移除或核对用途");
    const result = await settingsRequest({ operation: "channel.save", ...(current ? { id: current.id, revision: current.revision } : {}), name: draft.name, baseUrl: draft.baseUrl,
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}), textProtocol: draft.apiFormat === "responses" ? "responses" : "chat_completions",
      models: draft.models.map(model => { const previous = current?.models.find(item => item.name === model.name); return { ...(previous ? { id: previous.id, label: previous.label } : {}), name: model.name, capability: model.capability as "image" | "video" | "text" }; }),
    });
    accept(result); notify("settings.saved"); message.success("渠道与模型已保存，返回创作页面即可选择");
  }
  async function toggle(channel: ConfiguredChannel) {
    setBusy(true);
    try { accept(await settingsRequest({ operation: "channel.status", id: channel.id, revision: channel.revision, status: channel.status === "enabled" ? "disabled" : "enabled" })); notify("settings.saved"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "渠道状态修改失败"); }
    finally { setBusy(false); }
  }
  function requestRemoval(channel: ConfiguredChannel, model?: ManagedModel) {
    setRemovalError(""); setRemoval({ channel, model });
  }
  async function confirmRemoval() {
    if (!removal || removing.current) return;
    removing.current = true; setBusy(true); setRemovalError("");
    const { channel, model } = removal;
    try {
      accept(await settingsRequest(model
        ? { operation: "model.remove", channelId: channel.id, modelId: model.id, revision: channel.revision }
        : { operation: "channel.remove", id: channel.id, revision: channel.revision }));
      if (!model && channelFilter === channel.id) setChannelFilter("all");
      setRemoval(null); notify("settings.saved"); message.success(model ? "模型已删除，历史任务和生成文件保留" : "渠道及其模型配置已删除，历史任务和生成文件保留");
    } catch (cause) { setRemovalError(cause instanceof Error ? cause.message : "删除失败，请重试"); }
    finally { removing.current = false; setBusy(false); }
  }
  function addModels() {
    const channel = selectedChannel ?? (channels.length === 1 ? channels[0] : undefined);
    if (channel && ["openai", "openai-compatible"].includes(channel.provider)) { setCatalogue(""); setEditing(editable(channel)); }
    else { setAddingChannelId(undefined); setAddingModels(true); }
  }
  async function saveDefaults() {
    if (!snapshot || !defaults) return;
    setBusy(true);
    try { accept(await settingsRequest({ operation: "defaults.save", revision: snapshot.defaultsRevision, defaults })); notify("settings.saved"); message.success("默认模型已保存，新创作会优先使用；当前草稿选择继续保留"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "默认模型保存失败"); }
    finally { setBusy(false); }
  }
  return <div className="settings-shell">
    <div className="settings-toolbar"><p>渠道管理接口和密钥，模型管理可用能力，默认模型按当前用户保存。</p><Button disabled={busy || !!editing || !!removal || defaultsDirty} icon={<RefreshCw size={14} />} onClick={() => void load()}>刷新配置</Button></div>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {!snapshot && <p role="status">{busy ? "正在读取配置…" : "配置暂时无法读取，请点击刷新配置重试。"}</p>}
    {snapshot && <Tabs activeKey={tab} onChange={setTab} items={[
      { key: "channels", label: "渠道管理", children: <>
        <div className="settings-toolbar"><p>已配置 {channels.length} 个渠道 · 停用可恢复，删除会移除该渠道的密钥和模型配置。</p><Button type="primary" disabled={busy || defaultsDirty} icon={<Plus size={14} />} onClick={() => { setCatalogue(""); setEditing({ id: "new-channel", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "", apiFormat: "responses", models: [] }); }}>添加渠道</Button></div>
        {!channels.length && <p className="settings-empty">先添加 OpenAI 渠道，在编辑窗口中获取并选择模型。</p>}
        {channels.map(channel => <section className="settings-channel" key={channel.id} aria-label={channel.name}>
          <div className="settings-channel-header"><div><strong>{channel.name}</strong><p>{channel.baseUrl} · {protocolLabel(channel.provider)} · {channel.status === "enabled" ? "已启用" : "已停用"} · {channel.models.length} 个创作模型{channel.analysisModels?.length ? ` · ${channel.analysisModels.length} 个独立分析模型` : ""} · 凭据已保存</p></div><div className="settings-buttons"><Button disabled={busy || defaultsDirty || !["openai", "openai-compatible"].includes(channel.provider)} onClick={() => { setCatalogue(""); setEditing(editable(channel)); }}>编辑渠道</Button><Button onClick={() => { setChannelFilter(channel.id); setCapabilityFilter("all"); setQuery(""); setTab("models"); }}>查看模型</Button><Button disabled={busy || defaultsDirty} onClick={() => void toggle(channel)}>{channel.status === "enabled" ? "停用" : "启用"}</Button><Button danger icon={<Trash2 size={13} />} aria-label={`删除渠道 ${channel.name}`} disabled={busy || defaultsDirty} onClick={() => requestRemoval(channel)}>删除</Button></div></div>
        </section>)}
      </> },
      { key: "models", label: "模型管理", children: <>
        <div className="settings-toolbar"><p>共 {managedModels.length} 个模型 · 显示 {visibleModels.length} 个。文本模型可供业务分析共用。</p><Button type="primary" icon={<Plus size={14} />} disabled={busy || defaultsDirty || !channels.length} onClick={addModels}>添加模型</Button></div>
        <div className="settings-model-filters">
          <Select virtual={false} aria-label="筛选模型渠道" value={channelFilter} options={[{ value: "all", label: "全部渠道" }, ...channels.map(channel => ({ value: channel.id, label: `${channel.name}${channel.status === "disabled" ? "（已停用）" : ""}` }))]} onChange={setChannelFilter} />
          <Select virtual={false} aria-label="筛选模型用途" value={capabilityFilter} options={[{ value: "all", label: "全部用途" }, ...Object.entries(capabilityLabel).map(([value, label]) => ({ value, label }))]} onChange={setCapabilityFilter} />
          <Input aria-label="搜索模型" placeholder="搜索模型名称、ID 或渠道" allowClear value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="settings-model-list">{visibleModels.map(({ channel, model }) => <div className="settings-model-row" key={model.id}><div><strong>{model.name}</strong><p>{channel.name} · {capabilityLabel[model.capability]}{channel.status === "disabled" ? " · 渠道已停用" : ""}{Object.values(snapshot.defaults).includes(model.id) ? " · 我的默认模型" : ""}</p></div><Button danger size="small" icon={<Trash2 size={13} />} aria-label={`删除模型 ${model.name}`} disabled={busy || defaultsDirty || !!editing} onClick={() => requestRemoval(channel, model)}>删除</Button></div>)}</div>
        {!visibleModels.length && <p className="settings-empty">{managedModels.length ? "没有符合筛选条件的模型。" : "尚未添加模型，请先添加渠道，再选择模型。"}</p>}
        <p>图文分析的单价和费用上限可在下方“图文分析模型与费用设置”中补充。</p>
      </> },
      { key: "defaults", label: "默认模型", children: <><p>按当前 ERP 用户保存。当前画布和未提交的提示词继续保留。</p><div className="settings-defaults" inert={busy}>
        {(["image", "video", "text"] as const).map(capability => {
          const channel = snapshot.channels.find(channel => channel.status === "enabled" && channel.models.some(model => model.id === defaults?.[capability] && model.capability === capability));
          const selected = channel?.models.find(model => model.id === defaults?.[capability]);
          return <div key={capability}><label>{ { image: "默认图片模型", video: "默认视频模型", text: "默认文字模型" }[capability]}</label><div className="settings-buttons"><ModelPicker config={modelConfig} capability={capability} value={channel && selected ? `${channel.id}::${selected.name}` : ""} placeholder={defaults?.[capability] ? "原默认模型不可用，请重新选择" : "未指定默认模型"} fullWidth onChange={value => { const [id, ...parts] = value.split("::"); const name = parts.join("::"); const model = snapshot.channels.find(channel => channel.id === id)?.models.find(model => model.name === name && model.capability === capability); if (model && defaults) setDefaults({ ...defaults, [capability]: model.id }); }} /><Button disabled={!defaults?.[capability]} onClick={() => defaults && setDefaults({ ...defaults, [capability]: null })}>清除</Button></div></div>;
        })}
        <div><label htmlFor="analysis-default">默认业务分析模型</label><div className="settings-buttons"><Select id="analysis-default" className="settings-analysis-select" allowClear value={snapshot.analysisModels.some(model => model.id === defaults?.analysis) ? defaults?.analysis : undefined} placeholder={defaults?.analysis ? "原默认模型不可用，请重新选择" : "跟随默认文本模型"} options={snapshot.analysisModels.map(model => ({ value: model.id, label: `${model.label} · ${model.providerLabel}` }))} onChange={id => defaults && setDefaults({ ...defaults, analysis: id ?? null })} /><Button disabled={!defaults?.analysis} onClick={() => defaults && setDefaults({ ...defaults, analysis: null })}>清除</Button></div></div>
      </div><Button aria-label="保存默认模型" type="primary" loading={busy} disabled={!defaultsDirty} onClick={() => void saveDefaults()}>保存默认模型</Button></> },
    ]} />}
    {catalogue && tab !== "defaults" && <p role="status" className="settings-catalogue">{catalogue}。目录信息不代表已验证生成能力。</p>}
    <Modal open={!!removal} title={removal ? `删除${removal.model ? "模型" : "渠道"}“${removal.model?.name ?? removal.channel.name}”？` : "删除配置"}
      okText={busy ? "正在删除…" : "确认删除"} cancelText="取消" confirmLoading={busy} okButtonProps={{ "aria-label": busy ? "正在删除" : "确认删除", danger: true, disabled: busy || (!removal?.model && !!removal?.channel.dependentRoutes?.length) }}
      cancelButtonProps={{ disabled: busy }} closable={!busy} keyboard={!busy} maskClosable={!busy} onCancel={() => { if (!removing.current) setRemoval(null); }} onOk={() => void confirmRemoval()}>
      {removal && <div className="settings-removal-content">
        <p>{removal.channel.name} · {removal.channel.baseUrl}</p>
        {removal.model ? <p>删除后不能再为新任务选择此模型。{removal.model.capability === "text" ? "此文本模型也会从业务分析助手中移除。" : ""}</p> : <>
          <p>将删除该渠道保存的密钥，并移除以下 {removal.channel.models.length + (removal.channel.analysisModels?.length ?? 0)} 个模型配置：</p>
          <ul className="settings-removal-models">{[...removal.channel.models, ...(removal.channel.analysisModels ?? []).map(model => ({ ...model, capability: "analysis" as const }))].map(model => <li key={model.id}>{model.name} · {capabilityLabel[model.capability]}</li>)}</ul>
          {!removal.channel.models.length && !removal.channel.analysisModels?.length && <p>该渠道没有模型，可直接删除。</p>}
          {!!removal.channel.dependentRoutes?.length && <p role="alert" className="settings-error">请先调整仍引用此渠道的业务路由：{removal.channel.dependentRoutes.map(route => route.label).join("、")}</p>}
        </>}
        <p>历史任务和生成文件保留。受影响的个人默认模型会清除。如有排队或进行中的任务，需等待完成或取消任务后再删除。</p>
        {removalError && <p role="alert" className="settings-error">{removalError}</p>}
      </div>}
    </Modal>
    <Modal open={addingModels} title="选择模型所属渠道" okText="继续添加模型" cancelText="取消" okButtonProps={{ disabled: !addingChannelId }} onCancel={() => setAddingModels(false)} onOk={() => { const channel = channels.find(item => item.id === addingChannelId); if (channel) { setEditing(editable(channel)); setAddingModels(false); } }}>
      <p>每个模型使用所属渠道的接口和密钥。</p><Select className="settings-analysis-select" aria-label="模型所属渠道" placeholder="选择渠道" value={addingChannelId} onChange={setAddingChannelId} options={channels.filter(channel => ["openai", "openai-compatible"].includes(channel.provider)).map(channel => ({ value: channel.id, label: channel.name }))} />
    </Modal>
    <ChannelEditorDrawer open={!!editing} channel={editing} onSave={saveChannel} onClose={() => setEditing(null)} />
    {editing && !isSavedSettingsChannel(editing.id) && <span className="sr-only">新渠道尚未保存</span>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<AppProviders><Settings /></AppProviders>);
notify("studio.loaded");
