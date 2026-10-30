"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus, RefreshCw, Search, X } from "lucide-react";
import { ModelNameSchema, type ConfiguredChannel, type ModelCatalogue } from "@yummyai/contracts/ai/model-configuration";
import { ModelSettingsDialog } from "./model-settings-workbench-dialog";
import { capabilityLabels, channelDraft, channelDraftProblem, filteredCatalogue, suggestedChannelName, suggestedModelLabel, type ChannelDraft, type ModelCapability } from "./model-settings-presentation";

export function ModelSettingsChannelEditor({ channel, currentChannel, channels = [], busy, blocked, error, onClose, onDirty, onSave, onDiscover, onReconcile, onOpenExisting }: {
  channel?: ConfiguredChannel; currentChannel?: ConfiguredChannel; channels?: ConfiguredChannel[]; busy: boolean; blocked: boolean; error: string;
  onClose: () => void; onDirty: (dirty: boolean) => void; onSave: (draft: ChannelDraft) => Promise<boolean>;
  onDiscover: (draft: ChannelDraft) => Promise<ModelCatalogue | null>; onReconcile: () => void; onOpenExisting?: (channel: ConfiguredChannel) => void;
}) {
  const [draft, setDraft] = useState(() => channelDraft(channel)), [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [query, setQuery] = useState(""), [manual, setManual] = useState(""), [manualCapability, setManualCapability] = useState<ModelCapability>("text");
  const [localError, setLocalError] = useState(""), [dirty, setDirty] = useState(false), autoName = useRef(!channel), completed = useRef(false);
  const listId = useId(), results = useMemo(() => filteredCatalogue(catalogue?.models ?? [], query), [catalogue, query]);
  const visibleResults = results.slice(0, 100), selected = new Set(draft.models.map(model => model.name));
  const removedExisting = channel?.models.filter(model => !draft.models.some(item => item.id === model.id)).length ?? 0;
  const existingNew = !draft.id ? channels.find(item => item.name === draft.name.trim()) : undefined;
  const stale = !!draft.id && (!currentChannel || currentChannel.revision !== draft.revision), problem = channelDraftProblem(draft) ?? (existingNew ? "渠道名称已存在 请打开原渠道核对或使用其他名称" : null);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  function update(part: Partial<ChannelDraft>) { setDraft(value => ({ ...value, ...part })); setDirty(true); setLocalError(""); }
  function add(names: string[]) {
    const fresh = names.filter(name => !selected.has(name));
    if (draft.models.length + fresh.length > 200) { setLocalError("每个渠道最多保存 200 个模型 请缩小筛选后再选择"); return; }
    update({ models: [...draft.models, ...fresh.map(name => ({ name, capability: "text" as const, label: suggestedModelLabel(draft.name, name) }))] });
  }
  async function discover() {
    setLocalError("");
    const value = await onDiscover(draft);
    if (value) { setCatalogue(value); setQuery(""); }
  }
  function manualAdd() {
    const parsed = ModelNameSchema.safeParse(manual);
    if (!parsed.success) { setLocalError("填写有效 model ID 可包含字母 数字 点 下划线 斜线 冒号和连字符"); return; }
    if (selected.has(parsed.data)) { setLocalError("这个模型已在已选列表中"); return; }
    if (draft.models.length >= 200) { setLocalError("每个渠道最多保存 200 个模型"); return; }
    update({ models: [...draft.models, { name: parsed.data, capability: manualCapability, label: suggestedModelLabel(draft.name, parsed.data) }] }); setManual("");
  }
  return <ModelSettingsDialog wide title={channel ? `编辑渠道 · ${channel.name}` : "添加模型渠道"}
    description="连接渠道并选择模型 保存后由画布和业务任务共用" busy={busy} onClose={onClose}
    onBeforeClose={() => completed.current || !dirty || window.confirm("有未保存的渠道修改 确定放弃并关闭？")}>
    {close => <form className="ai-settings-channel-form" onSubmit={async event => { event.preventDefault(); if (problem || blocked || stale) return;
      if (await onSave(draft)) { completed.current = true; setDirty(false); onDirty(false); close(); } }}>
      <div className="ai-settings-dialog-body">
        <div className="ai-settings-field-grid">
          <label>渠道名称<input required maxLength={80} value={draft.name} disabled={busy || blocked} onChange={event => { autoName.current = false; update({ name: event.target.value }); }} placeholder="例如 团队模型渠道" /></label>
          <label>接口地址<input required type="url" maxLength={2000} value={draft.baseUrl} disabled={busy || blocked} onChange={event => { const baseUrl = event.target.value;
            update({ baseUrl, ...(autoName.current ? { name: suggestedChannelName(baseUrl) } : {}) }); setCatalogue(null); }} placeholder="https://api.example.com/v1" autoComplete="off" /></label>
          <label>API Key{channel && <span className="ai-settings-field-note">留空保留已保存密钥</span>}<input type="password" required={!channel} maxLength={8192} value={draft.apiKey} disabled={busy || blocked}
            onChange={event => { update({ apiKey: event.target.value }); setCatalogue(null); }} placeholder={channel ? "已保存密钥 填写新值才更换" : "输入此渠道的 API Key"} autoComplete="new-password" /></label>
          <label>文本接口协议<select value={draft.textProtocol} disabled={busy || blocked} onChange={event => update({ textProtocol: event.target.value as ChannelDraft["textProtocol"] })}>
            <option value="responses">Responses</option><option value="chat_completions">Chat Completions</option></select><span className="ai-settings-field-note">按渠道提供的协议选择 生成图片使用其图片接口</span></label>
        </div>
        <section className="ai-settings-directory" aria-label="渠道模型目录">
          <div className="ai-settings-section-heading"><div><h3>选择模型</h3><p>目录可读取代表接口已响应 模型能力仍需在实际任务中验证</p></div>
            <button type="button" disabled={busy || blocked || !draft.baseUrl || !draft.apiKey && !channel} onClick={() => void discover()}><RefreshCw size={15} />{busy ? "正在读取…" : "获取模型目录"}</button></div>
          {catalogue && <><div className="ai-settings-directory-tools"><label className="ai-settings-search"><Search size={15} /><span className="sr-only">搜索目录模型</span>
            <input value={query} disabled={busy || blocked} placeholder="搜索 model ID" aria-controls={listId} onChange={event => setQuery(event.target.value)} /></label>
            <div className="ai-settings-row-actions"><button type="button" disabled={busy || blocked || !results.some(name => !selected.has(name))} onClick={() => add(results)}>选择当前筛选模型</button>
              <button type="button" disabled={busy || blocked || !results.some(name => selected.has(name))} onClick={() => update({ models: draft.models.filter(model => !results.includes(model.name)) })}>清除当前筛选选择</button></div></div>
            <p role="status" className="ai-settings-muted">已发现 {catalogue.models.length} 个模型 · 筛选 {results.length} 个 · 已选 {draft.models.length} 个</p>
            <div id={listId} className="ai-settings-catalogue-list">{visibleResults.map(name => <label key={name} className="ai-settings-catalogue-option"><input type="checkbox" disabled={busy || blocked} checked={selected.has(name)}
              onChange={event => event.target.checked ? add([name]) : update({ models: draft.models.filter(model => model.name !== name) })} /><span>{name}</span>{selected.has(name) && <Check size={14} />}</label>)}
              {!results.length && <p>没有匹配的目录模型 请调整搜索条件</p>}</div>
            {results.length > visibleResults.length && <p className="ai-settings-muted">当前显示前 100 项 可搜索精确名称或批量选择当前筛选结果</p>}
            {catalogue.skipped > 0 && <p className="ai-settings-muted">已跳过 {catalogue.skipped} 个格式不支持的目录条目</p>}</>}
          {!catalogue && <p className="ai-settings-empty">点击获取模型目录后搜索并选择 接口不支持目录时可手动添加</p>}
        </section>
        <details className="ai-settings-disclosure"><summary><ChevronDown size={15} />高级 · 手动添加模型</summary><div className="ai-settings-manual-fields">
          <label>model ID<input maxLength={120} value={manual} disabled={busy || blocked} onChange={event => setManual(event.target.value)} placeholder="填写渠道提供的精确 model ID" /></label>
          <label>配置用途<select value={manualCapability} disabled={busy || blocked} onChange={event => setManualCapability(event.target.value as ModelCapability)}><option value="text">文本任务</option><option value="image">图片生成</option><option value="video">视频生成</option></select></label>
          <button type="button" disabled={busy || blocked || !manual.trim()} onClick={manualAdd}><Plus size={15} />手动添加模型</button></div></details>
        <section aria-label="已选渠道模型"><div className="ai-settings-section-heading"><div><h3>已选模型 {draft.models.length}</h3><p>用途是保存的配置声明 不代表图片理解 结构化输出或工具调用已实测</p></div></div>
          {draft.models.length ? <div className="ai-settings-selected-list">{draft.models.map(model => <div key={model.name} className="ai-settings-selected-row"><div className="ai-settings-model-identity"><strong>{model.name}</strong><span>能力未实测</span></div>
            <label><span className="sr-only">{model.name} 显示名称</span><input required maxLength={100} value={model.label} disabled={busy || blocked} onChange={event => update({ models: draft.models.map(item => item.name === model.name ? { ...item, label: event.target.value } : item) })} /></label>
            <label><span className="sr-only">{model.name} 配置用途</span><select value={model.capability} disabled={busy || blocked} onChange={event => update({ models: draft.models.map(item => item.name === model.name ? { ...item, capability: event.target.value as ModelCapability } : item) })}>
              {(["text", "image", "video"] as const).map(capability => <option key={capability} value={capability}>{capabilityLabels[capability]}</option>)}</select></label>
            <button type="button" className="ai-settings-icon-button" aria-label={`移出已选模型 ${model.name}`} disabled={busy || blocked} onClick={() => update({ models: draft.models.filter(item => item.name !== model.name) })}><X size={16} /></button></div>)}</div>
            : <p className="ai-settings-empty">还未选择模型 可以先保存渠道 后续再添加模型</p>}
        </section>
        {stale && <div role="alert" className="ai-settings-warning">渠道版本已变化 当前填写未覆盖原配置 {currentChannel && <button type="button" disabled={busy || blocked} onClick={() => { setDraft(channelDraft(currentChannel)); setDirty(false); setCatalogue(null); setLocalError(""); }}>载入最新渠道并放弃当前填写</button>}</div>}
        {existingNew && <div role="alert" className="ai-settings-warning"><p>已读取到同名渠道 当前填写没有再次创建渠道 请核对已保存的配置 密钥内容不会回传显示</p>
          {onOpenExisting && <button type="button" disabled={busy || blocked} onClick={() => onOpenExisting(existingNew)}>放弃当前填写 打开已保存渠道核对</button>}</div>}
        {(error || localError) && <p role="alert" className="studio-alert">{localError || error}</p>}
        {removedExisting > 0 && <p className="ai-settings-warning">保存将移出 {removedExisting} 个原配置模型 历史任务和文件保留 有进行中任务时服务端会拒绝此修改</p>}
        {blocked && <p className="ai-settings-warning">上次保存结果待核对 读取最新配置后再决定下一步</p>}
      </div>
      <footer className="ai-settings-dialog-footer"><span role="status" className="ai-settings-form-hint">{problem ? `还需${problem}` : "保存配置不会启动生成任务"}</span>
        {blocked && <button type="button" disabled={busy} onClick={onReconcile}><RefreshCw size={15} />读取原配置核对</button>}
        <button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || blocked || stale || !!problem}>{busy ? "正在保存…" : "保存渠道与模型"}</button></footer>
    </form>}
  </ModelSettingsDialog>;
}
