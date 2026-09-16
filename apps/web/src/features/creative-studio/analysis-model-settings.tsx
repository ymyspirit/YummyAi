"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AssistModel } from "@yummyai/contracts/ai/assist";
import type { ConfigurationSnapshot, ConfiguredChannel } from "@yummyai/contracts/ai/model-configuration";
import { assistApi } from "../ai-assist/assist-client";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { studioApi } from "./studio-api";
import { ModelRemovalDialog } from "./model-removal-dialog";

export function AnalysisModelSettings({ revision }: { revision: number }) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<ConfigurationSnapshot>(), [models, setModels] = useState<AssistModel[]>([]);
  const [providerId, setProviderId] = useState(""), [name, setName] = useState(""), [label, setLabel] = useState("");
  const [inputPrice, setInputPrice] = useState(""), [outputPrice, setOutputPrice] = useState(""), [taskCap, setTaskCap] = useState("1");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [removal, setRemoval] = useState<{ model: AssistModel; channel: ConfiguredChannel } | null>(null), [removalError, setRemovalError] = useState("");
  const removing = useRef(false);
  useLeaveGuard(!!(name || label || inputPrice || outputPrice), busy);
  const reload = useCallback(async () => {
    setLoading(true); setError("");
    try { const [configuration, analysis] = await Promise.all([studioApi<ConfigurationSnapshot>("configuration", { operation: "configuration.get" }), assistApi<AssistModel[]>("models")]); setSnapshot(configuration); setModels(analysis); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "图文分析配置读取失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, revision, reload]);
  function requestRemoval(model: AssistModel) {
    if (busy || loading) return;
    const providerConfigId = snapshot?.analysisModels.find(item => item.id === model.id)?.providerConfigId;
    const channel = snapshot?.channels.find(item => item.id === providerConfigId);
    if (!channel) { setError("模型所属渠道信息已变化，请点击“刷新分析模型”后重试。"); return; }
    setRemovalError(""); setError(""); setNotice(""); setRemoval({ model, channel });
  }
  async function removeModel() {
    if (!removal || removing.current || busy) return;
    const { model, channel } = removal;
    removing.current = true; setRemovalError("");
    setBusy(true); setError(""); setNotice("");
    try {
      const configuration = await studioApi<ConfigurationSnapshot>("configuration", { operation: "model.remove", channelId: channel.id, modelId: model.id, revision: channel.revision });
      setSnapshot(configuration); setModels(items => items.filter(item => item.id !== model.id));
      setRemoval(null);
      setNotice("模型已删除，历史分析结果保留。");
      window.dispatchEvent(new Event("yummyai.models.changed"));
      await reload();
    } catch (cause) { setRemovalError(cause instanceof Error ? cause.message : "模型删除失败，请重试。"); }
    finally { removing.current = false; setBusy(false); }
  }
  return <details className="studio-settings-section" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>图文分析模型与费用设置</summary>
    <p>已保存的文本模型自动用于创意分析、订单预审、生产稿预检等业务助手，无需重复添加。图文任务需要模型支持图片输入和结构化输出；可在下方补充渠道价格和费用上限。</p>
    {error && <p role="alert" className="studio-alert">{error}</p>}{notice && <p role="status">{notice}</p>}{loading && <p role="status">正在读取分析模型…</p>}
    <div className="studio-actions"><button type="button" disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={14} />刷新分析模型</button></div>
    <div className="studio-record-list">{models.map(model => <div className="studio-record studio-analysis-model" key={model.id}><div><strong>{model.label}</strong><small>{model.model} · {model.providerLabel} · {model.maxTaskCostUsd === null ? "共用文本模型 · 费用以渠道账单为准" : `输入 $${model.inputUsdPerMillion}/百万 tokens · 输出 $${model.outputUsdPerMillion}/百万 tokens · 单次预估上限 $${model.maxTaskCostUsd}`}</small></div><button className="studio-model-delete" type="button" aria-label={`删除分析模型 ${model.label}`} disabled={busy || loading || !snapshot?.analysisModels.some(item => item.id === model.id)} onClick={() => requestRemoval(model)}><Trash2 size={14} />删除</button></div>)}</div>
    {removal && <ModelRemovalDialog label={removal.model.label} model={removal.model.model} channel={removal.channel.name} shared={removal.channel.models.some(item => item.id === removal.model.id)} busy={busy} error={removalError} onConfirm={() => void removeModel()} onCancel={() => { if (!removing.current) { setRemoval(null); setRemovalError(""); } }} />}
    {!loading && !error && !models.length && <p>尚未配置图文分析模型。</p>}
    <form onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); setNotice(""); void assistApi("models", { providerConfigId: providerId, model: name, label, inputUsdPerMillion: Number(inputPrice), outputUsdPerMillion: Number(outputPrice), maxTaskCostUsd: Number(taskCap) }).then(async () => { setName(""); setLabel(""); setInputPrice(""); setOutputPrice(""); setNotice("图文分析模型已保存，可在上方设置为默认业务分析模型。"); await reload(); window.dispatchEvent(new Event("yummyai.models.changed")); }).catch(cause => setError(cause instanceof Error ? cause.message : "保存失败")).finally(() => setBusy(false)); }}>
      <label>分析渠道<select required value={providerId} onChange={event => { setProviderId(event.target.value); setName(""); }}><option value="">选择已启用渠道</option>{snapshot?.channels.filter(channel => channel.status === "enabled" && ["openai", "openai-compatible"].includes(channel.provider)).map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
      <label>图文模型名称<input list="analysis-model-options" required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="选择已添加模型，或手动填写 model ID" /><datalist id="analysis-model-options">{snapshot?.channels.find(channel => channel.id === providerId)?.models.filter(model => model.capability === "text").map(model => <option key={model.id} value={model.name} />)}</datalist></label>
      <label>分析模型显示名称<input required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label>输入单价（美元/百万 tokens）<input required type="number" min="0" max="1000" step="any" value={inputPrice} onChange={event => setInputPrice(event.target.value)} placeholder="按渠道价格填写；免费模型填 0" /></label>
      <label>输出单价（美元/百万 tokens）<input required type="number" min="0" max="5000" step="any" value={outputPrice} onChange={event => setOutputPrice(event.target.value)} /></label>
      <label>单次预估费用上限（美元）<input required type="number" min="0.001" max="20" step="any" value={taskCap} onChange={event => setTaskCap(event.target.value)} /></label>
      <div className="studio-actions"><button className="primary" type="submit" disabled={busy || loading || !providerId}><Plus size={14} />添加图文分析模型</button></div>
    </form><p>费用按配置单价与返回用量估算，未返回用量时显示未知。订单分析内容保留 24 小时，研究分析内容保留 30 天。</p>
  </details>;
}
