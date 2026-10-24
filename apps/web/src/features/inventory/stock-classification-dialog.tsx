"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { InventoryMaterialKind, InventoryStockClassificationHistory, InventoryStockItemView } from "@yummyai/contracts/inventory";
import { loadStockClassificationHistory } from "../manual-operations/operation-actions";
import { Field, RecordDialog, RecordForm } from "../manual-operations/record-form";
import { formText, materialKindNames } from "../manual-operations/operation-types";
import "./stock-classification.css";

export function StockClassificationDialog({ stock, onClose, onSaved }: {
  stock: InventoryStockItemView; onClose: () => void; onSaved: (stock: Record<string, unknown>) => void;
}) {
  const [history, setHistory] = useState<InventoryStockClassificationHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [denied, setDenied] = useState(false), [closing, setClosing] = useState(false);
  const generation = useRef(0), closingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = useCallback(async (beforeVersion?: number) => {
    const token = ++generation.current; setLoading(true); setError(null);
    let result: Awaited<ReturnType<typeof loadStockClassificationHistory>>;
    try { result = await loadStockClassificationHistory(stock.id, beforeVersion); }
    catch {
      if (generation.current === token) { setLoading(false); setError("分类记录连接中断，填写会保留，请重新读取后再保存"); }
      return;
    }
    if (generation.current !== token) return;
    setLoading(false); setError(result.error); setDenied(result.denied);
    if (result.denied) { setHistory(null); return; }
    if (result.data) setHistory(previous => beforeVersion && previous ? { ...result.data!, items: [...previous.items, ...result.data!.items].filter((row, index, rows) => rows.findIndex(other => other.id === row.id) === index) } : result.data);
  }, [stock.id]);
  useEffect(() => {
    void reload(); const focus = () => { void reload(); }; window.addEventListener("focus", focus);
    return () => { generation.current++; window.removeEventListener("focus", focus); if (closingTimer.current) clearTimeout(closingTimer.current); };
  }, [reload]);
  const leave = (saved?: Record<string, unknown>) => {
    if (closingTimer.current) return;
    setClosing(true);
    const done = () => { if (saved) onSaved(saved); else onClose(); };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) done();
    else closingTimer.current = setTimeout(done, 140);
  };
  return <RecordDialog title={`物料分类 · ${stock.name}`} onClose={() => leave()} protectEdits={!denied && history?.canClassify !== false}>
    <div className="stock-classification-panel" data-closing={closing || undefined}>
      <div className="stock-classification-summary"><p>{stock.code}<span>{!history ? "读取中" : history.stockItem.classification ? `${materialKindNames[history.stockItem.classification.kind]} · v${history.stockItem.classification.versionNumber}` : "待分类"}</span></p><button type="button" disabled={loading || closing} onClick={() => { void reload(); }}><RefreshCw size={14} />重新读取</button></div>
      {loading && !history && <p className="record-help" role="status">正在读取分类记录</p>}
      {error && <p className="record-notice error" role="alert">{error}</p>}
      {denied && <p className="record-help">当前无法访问此物料，已清除本次分类填写</p>}
      {history && !denied && <>
        {history.canClassify ? <ClassificationForm stock={history.stockItem} unavailable={loading || Boolean(error) || closing} onClose={() => leave()} onSaved={value => leave(value)}
          onDenied={() => { generation.current++; setHistory(null); setDenied(true); setLoading(false); setError("当前分类访问权限或会话已变化，已清除本次填写，请重新读取后核对历史"); }} /> : <p className="record-help stock-classification-readonly">当前只有分类读取权限</p>}
        <section className="stock-classification-history" aria-label="分类历史"><h3>分类历史</h3>
          {history.items.length ? <ol>{history.items.map(item => <li key={item.id}><div><strong>{materialKindNames[item.kind]}</strong><span>v{item.versionNumber} · {new Date(item.recordedAt).toLocaleString("zh-CN", { hour12: false })}</span></div><p>{item.reason}</p></li>)}</ol> : <p className="record-help">尚无分类依据，旧记录保持待分类</p>}
          {history.nextVersion && <button type="button" disabled={loading || closing} onClick={() => { void reload(history.nextVersion!); }}>{loading ? "正在读取" : "读取更早记录"}</button>}
        </section>
      </>}
    </div>
  </RecordDialog>;
}

function ClassificationForm({ stock, unavailable, onClose, onSaved, onDenied }: {
  stock: InventoryStockItemView; unavailable: boolean; onClose: () => void; onSaved: (stock: Record<string, unknown>) => void; onDenied: () => void;
}) {
  const [kind, setKind] = useState<InventoryMaterialKind | "">(stock.classification?.kind ?? "");
  const [reason, setReason] = useState("");
  const [basis, setBasis] = useState(stock.classification?.versionNumber ?? 0);
  const latest = stock.classification?.versionNumber ?? 0, changed = latest !== basis;
  return <RecordForm operation="stock.classify" id={stock.id} onCancel={onClose} onSaved={onSaved} onDenied={onDenied} submitLabel="保存分类" submitDisabled={unavailable || changed}
    description="分类会保存为新版本，原物料、单位和库存历史保持。分类不代表检验、生产或放行通过。"
    build={form => ({ kind: formText(form, "kind"), reason: formText(form, "reason"), expectedVersion: basis })}>
    {changed && <div className="record-notice error" role="status">当前分类已更新，你的填写已保留<button type="button" onClick={() => setBasis(latest)} disabled={unavailable}>核对后采用 v{latest} 为依据</button></div>}
    <Field label="物料分类"><select name="kind" value={kind} onChange={event => setKind(event.target.value as InventoryMaterialKind)} required disabled={unavailable}><option value="">请选择分类</option>{Object.entries(materialKindNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    <Field label="分类说明" help="填写实际判断依据或更正原因，请勿填写密码、密钥或买家资料"><textarea name="reason" value={reason} onChange={event => setReason(event.target.value)} required maxLength={1000} rows={3} disabled={unavailable} /></Field>
  </RecordForm>;
}
