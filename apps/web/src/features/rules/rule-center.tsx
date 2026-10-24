"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { RefreshCw, ArrowUpRight, Pencil } from "lucide-react";
import { RULE_CATEGORY_LABELS, RuleWorkspaceSchema, RuleHistorySchema, RuleFieldsSchema, canEditRuleText,
  type RuleWorkspace, type RuleRow, type RuleFields, type RuleHistory } from "@yummyai/contracts/rules";
import { TaskDrawer } from "../navigation/task-drawer";
import { dateTime } from "../order-centers/order-center-model";
import { RuleBrowser, ExecutionBadge, FactoryValues } from "./rule-browser";
import { ruleRequest as request } from "./rule-request";
import { PRODUCT_NAMES as productNames, EMPTY_RULE as empty, scopeLabel, statusLabel, configurationFor, configHref, type RuleSelection } from "./rule-center-model";
import "../order-centers/order-centers.css";
import "./rule-center.css";

export function RuleCenter() {
  const query = useSearchParams();
  const [data, setData] = useState<RuleWorkspace | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<RuleSelection | null>(null);
  const [saved, setSaved] = useState<{ id: string; version: number } | null>(null);
  const openedQuery = useRef<string | null>(null);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    void request("workspace", undefined, abort.signal).then(value => { if (!abort.signal.aborted) setData(RuleWorkspaceSchema.parse(value)); })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [reload]);
  useEffect(() => {
    const id = query.get("rule");
    if (id && data && openedQuery.current !== id) { openedQuery.current = id; if (data.rules.some(row => row.id === id)) setSelected({ id, version: Number(query.get("version")) || undefined }); else setError("该规则不可用或不属于当前组织"); }
  }, [data, query]);
  useEffect(() => {
    if (saved && data?.rules.some(row => row.id === saved.id && row.latestVersion === saved.version)) {
      setSelected({ id: saved.id, version: saved.version }); setSaved(null);
    }
  }, [data, saved]);
  async function initialize() {
    setBusy(true); setError("");
    try { const result = await request("initialize", {}); setNotice(`已登记 ${result.created} 条制作规范。`); setReload(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "登记失败"); } finally { setBusy(false); }
  }
  return <main className="oc-page oc-workbench rc-page">
    <header className="oc-header"><div><h1>规则中心</h1><p>先选商品或业务，再查看要求、修改配置。</p></div>
      <button className="oc-button" disabled={loading || busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />刷新</button>
    </header>
    {error && <p role="alert" className="oc-error">{error}</p>}{notice && <p role="status" className="oc-notice">{notice}</p>}
    {loading && !data && <p role="status" className="oc-hint">正在读取规则…</p>}
    {!loading && data && !data.rules.length && <div className="rc-empty"><h2>还没有登记规则</h2><p>先登记已确认的通用规范和抱枕标准，其他商品可继续添加专属要求。</p>{data.canManage && data.canPublish && <button className="oc-button primary" disabled={busy} onClick={() => void initialize()}>登记已确认的制作规范</button>}</div>}
    {data && <RuleBrowser data={data} loading={loading} initialView={query.get("scope") ?? "general"} onOpen={setSelected} />}
    {data && selected && (selected.id === "new" || data.rules.some(row => row.id === selected.id)) && <RuleDrawer
      key={selected.id + ":" + !!selected.edit + ":" + (data.rules.find(row => row.id === selected.id)?.revision ?? 0)}
      row={data.rules.find(row => row.id === selected.id) ?? null} data={data} selection={selected} onClose={() => setSelected(null)}
      onDone={(message, result) => { setSelected(null); setNotice(message); if (result) setSaved(result); setReload(value => value + 1); }} />}
  </main>;
}
function RuleDrawer({ row, data, selection, onClose, onDone }: { row: RuleRow | null; data: RuleWorkspace; selection: RuleSelection; onClose: () => void; onDone: (message: string, result?: { id: string; version: number }) => void }) {
  const editable = data.canManage && (!row || canEditRuleText(row));
  const [fields, setFields] = useState<RuleFields>(row ? RuleFieldsSchema.strip().parse(row.latest) : selection.fields ?? empty);
  const [editing, setEditing] = useState(!row || !!selection.edit && editable), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [reason, setReason] = useState(""), [history, setHistory] = useState<RuleHistory | null>(null), [loading, setLoading] = useState(!!row);
  const [versionNumber, setVersionNumber] = useState(selection.version ?? row?.latestVersion ?? 1);
  const config = row ? configurationFor(row) : null;
  const saveKeys = useRef(new Map<string, string>());
  useEffect(() => {
    if (!row) return; const abort = new AbortController();
    void request(`${row.id}/history`, undefined, abort.signal).then(value => { if (!abort.signal.aborted) setHistory(RuleHistorySchema.parse(value)); })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "历史读取失败"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [row]);
  const version = history?.versions.find(item => item.version === versionNumber) ?? (versionNumber === row?.latestVersion ? row.latest : null);
  function change<T extends keyof RuleFields>(key: T, value: RuleFields[T]) { setFields(current => ({ ...current, [key]: value })); setDirty(true); }
  async function act(action: "save" | "publish" | "disable") {
    const changeReason = reason.trim() || (action === "publish" && version ? "启用 V" + version.version + "：" + version.changeReason.slice(0, 560) : "");
    if (!changeReason) { setError("请填写变更说明"); return; }
    setBusy(true); setError("");
    try {
      if (action === "save") {
        const parsed = RuleFieldsSchema.safeParse(fields); if (!parsed.success) throw new Error("请完整填写规则名称、制作要求、依据和适用范围");
        const payload = { fields: parsed.data, expectedRevision: row?.revision ?? 0, changeReason };
        const signature = JSON.stringify(payload), key = saveKeys.current.get(signature) ?? crypto.randomUUID(); saveKeys.current.set(signature, key);
        const result = await request(row ? row.id + "/revise" : "create", { ...payload, idempotencyKey: key });
        setDirty(false); onDone("草稿已保存。请核对内容，再点击“启用 V" + result.version + "”。", result);
      } else if (row) {
        await request(row.id + "/" + action, { expectedRevision: row.revision, version: action === "publish" ? row.latestVersion : row.activeVersion, changeReason });
        setDirty(false); onDone(action === "publish" ? "已启用此版本，新任务将固定使用；历史任务保持原版本。" : "已停用，此后新任务不再绑定；历史记录和生产硬性校验仍保留。");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请核对后重试"); } finally { setBusy(false); }
  }
  const footer = <>
    {editing ? <button className="oc-button primary" disabled={busy || loading} onClick={() => void act("save")}>保存草稿</button> : row && data.canPublish ? <>
      {row.activeVersion !== row.latestVersion && <button className="oc-button primary" disabled={busy || loading || versionNumber !== row.latestVersion} onClick={() => void act("publish")}>启用 V{row.latestVersion}</button>}
    </> : null}
    {!editing && editable && <button className="oc-button" disabled={busy || loading} onClick={() => { setEditing(true); setReason(""); setError(""); }}><Pencil size={14} />编辑要求</button>}
  </>;
  return <TaskDrawer title={editing ? row ? "编辑要求" : "新增要求" : "规则详情"} description={row ? statusLabel(row) : "保存草稿 → 核对 → 启用"} recordKey={row?.id ?? "new"} state={{ dirty, busy, loading }} onClose={onClose} footer={footer} className="rc-drawer">
    {error && <p className="oc-error" role="alert">{error}</p>}
    {editing ? <div className="rc-form">
      <p className="rc-edit-guidance">填写实际要求，保存后会打开草稿供你核对。启用新版本后，才会用于之后派发的任务。</p>
      <label>规则名称<input value={fields.name} maxLength={120} onChange={event => change("name", event.target.value)} /></label>
      <label>制作要求 / 核验要求<textarea rows={7} maxLength={6000} value={fields.instructions} onChange={event => change("instructions", event.target.value)} /></label>
      <div className="rc-form-pair"><label>规则分类<select value={fields.category} onChange={event => change("category", event.target.value as RuleFields["category"])}>{Object.entries(RULE_CATEGORY_LABELS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>使用环节<select value={fields.appliesTo} onChange={event => change("appliesTo", event.target.value as RuleFields["appliesTo"])}><option value="order_design">订单制作</option><option value="operations">日常操作</option></select></label></div>
      <div className="rc-form-pair"><label>适用范围<select value={fields.scopeKind} onChange={event => { setFields(current => ({ ...current, scopeKind: event.target.value as RuleFields["scopeKind"], productType: event.target.value === "product_type" ? "shaped_pillow" : null, spuId: null })); setDirty(true); }}><option value="all">全部商品共用</option><option value="product_type">一个商品类型</option><option value="spu">一个指定商品 SPU</option></select></label>
        {fields.scopeKind === "product_type" && <label>商品类型<select value={fields.productType ?? ""} onChange={event => change("productType", event.target.value as RuleFields["productType"])}>{Object.entries(productNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>}
        {fields.scopeKind === "spu" && <label>指定 SPU<select value={fields.spuId ?? ""} onChange={event => change("spuId", event.target.value || null)}><option value="">请选择 SPU</option>{data.spus.map(spu => <option key={spu.id} value={spu.id}>{spu.code} · {spu.name}</option>)}</select></label>}</div>
      <p className="oc-hint">{fields.scopeKind === "all" ? "这是一条通用要求，修改会影响全部商品的新任务。" : "这条要求只用于所选范围，其他商品保持原要求。"}</p>
      <label>依据 / 来源<textarea rows={3} maxLength={1200} placeholder="工厂文档名称、确认日期、操作规范等" value={fields.source} onChange={event => change("source", event.target.value)} /></label>
      <p className="oc-hint">新增文字规则按人工核验执行。模型、工艺参数与自动步骤在对应配置中维护。</p>
    </div> : <>
      <div className="oc-actions"><label>查看版本 <select aria-label="查看规则版本" value={versionNumber} onChange={event => setVersionNumber(Number(event.target.value))}>{(history?.versions ?? (row ? [row.latest] : [])).map(item => <option key={item.id} value={item.version}>V{item.version}{row?.activeVersion === item.version ? " · 当前启用" : ""}</option>)}</select></label>
        {row && versionNumber === row.latestVersion && row.activeVersion !== row.latestVersion && <span className="rc-draft-label">草稿 · 核对后点击下方启用</span>}</div>
      {loading && <p role="status">正在读取版本历史…</p>}
      {!loading && !version && <p role="alert">此规则版本不可用。</p>}
      {version && <><h3>{version.name}</h3><div className="oc-actions"><ExecutionBadge version={version} /><span className="oc-hint">{scopeLabel(version, data)} · {RULE_CATEGORY_LABELS[version.category]}</span></div>
        <p className="rc-copy">{version.instructions}</p>
        {version.binding === "pillow_factory" && <section className="rc-factory"><h3>工厂交付参数</h3><FactoryValues data={data} /></section>}
        {config && row && <section className="rc-config-guide"><h3>如何修改</h3><p>{config.description}</p><Link className="oc-button" href={configHref(row, config.href)}>{config.label}<ArrowUpRight size={14} /></Link>
          {row.code === "system:pillow-model" && <Link className="oc-button" href={configHref(row, "/settings/ai")}>管理 AI 模型<ArrowUpRight size={14} /></Link>}</section>}
        {!editable && !config && <p className="rc-edit-guidance">{version.execution === "unavailable" ? "这项自动能力尚未接入，当前需要人工处理并复核。" : "这是系统自动执行的要求。可为商品新增人工核验要求；修改文字不会改变系统校验。"}</p>}
        <dl className="rc-details"><dt>执行说明</dt><dd>{version.executionLocation}</dd><dt>依据 / 来源</dt><dd>{version.source}</dd><dt>本次变更</dt><dd>{version.changeReason}</dd></dl>
      </>}
      {history && <details className="rc-history"><summary>查看变更记录（{history.events.length}）</summary><ol>{history.events.map((event, index) => <li key={index}><strong>{{ create: "登记", revise: "修订", publish: "启用", disable: "停用" }[event.action]} V{event.version}</strong><small>{dateTime(event.createdAt)}</small><p>{event.reason}</p></li>)}</ol></details>}
      {row && row.activeVersion !== null && data.canPublish && <details className="rc-state-actions"><summary>停用规则</summary><p>之后的新任务不再绑定该规则，已有任务与生产硬性校验保持不变。</p>
        <label className="rc-reason">停用原因<textarea rows={2} maxLength={600} value={reason} onChange={event => { setReason(event.target.value); setDirty(true); }} /></label>
        <button className="oc-button" disabled={busy || !reason.trim()} onClick={() => void act("disable")}>确认停用</button></details>}
    </>}
    {editing && <label className="rc-reason">变更说明<textarea rows={2} maxLength={600} placeholder="简要说明这次新增或修改了什么" value={reason} disabled={busy} onChange={event => { setReason(event.target.value); setDirty(true); }} /></label>}
  </TaskDrawer>;
}
