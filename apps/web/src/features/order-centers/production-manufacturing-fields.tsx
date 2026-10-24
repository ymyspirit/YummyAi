"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import { ProductionManufacturingOptionsSchema, ProductionManufacturingSelectionSchema, type ProductionManufacturingOptions } from "@yummyai/contracts/order/production-manufacturing";
import { centerRequest, OrderCenterRequestError } from "./order-center-model";
import "./production-manufacturing-fields.css";

const unit = { each: "件", pair: "双", set: "套" };
export function ProductionManufacturingFields({ lineId, originalProductionOrderId, nativeSpecificationVersionId, prefix = "manufacturing", disabled = false, refresh = "", onReadinessChange }: {
  lineId: string; originalProductionOrderId?: string; nativeSpecificationVersionId?: string; prefix?: string; disabled?: boolean; refresh?: string; onReadinessChange?(ready: boolean): void;
}) {
  const [view, setView] = useState<ProductionManufacturingOptions | null>(null), [selected, setSelected] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [reading, setReading] = useState(true), [readFailed, setReadFailed] = useState(false), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const abort = useRef<AbortController | null>(null), identity = `${lineId}:${originalProductionOrderId ?? "reviewed"}:${nativeSpecificationVersionId ?? "pinned"}`;
  const previous = useRef<{ identity: string; view: ProductionManufacturingOptions } | null>(null);
  const selection = useRef("");
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const readinessCallback = useRef(onReadinessChange); readinessCallback.current = onReadinessChange;
  const clear = () => { previous.current = null; selection.current = ""; setView(null); setSelected(""); setConfirmed(false); };
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden") setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [identity]);
  useEffect(() => {
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    if (previous.current?.identity !== identity) clear();
    setReading(true); setReadFailed(false); setError("");
    const params = new URLSearchParams(); if (originalProductionOrderId) params.set("originalProductionOrderId", originalProductionOrderId); if (nativeSpecificationVersionId) params.set("nativeSpecificationVersionId", nativeSpecificationVersionId);
    const query = params.size ? `?${params}` : "";
    void centerRequest(`lines/${lineId}/manufacturing${query}`, undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const next = ProductionManufacturingOptionsSchema.parse(value), old = previous.current?.view;
      if (old && (old.contextAuthority !== next.contextAuthority || JSON.stringify(old.source) !== JSON.stringify(next.source) || selection.current && !next.items.some(item => item.versionId === selection.current))) {
        selection.current = ""; setSelected(""); setConfirmed(false);
        setError("制作来源 权限或可选版本已变化 请重新选择并核对");
      }
      previous.current = { identity, view: next }; setLoadedIdentity(identity); setView(next);
    }).catch(cause => { if (!controller.signal.aborted) {
      setReadFailed(true);
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) clear();
      setError(cause instanceof OrderCenterRequestError && [401, 403].includes(cause.status) ? "当前权限不可读取制作依据 请重新登录或联系商品负责人" : cause instanceof Error ? cause.message : "制造依据读取失败 请重新核对");
    } }).finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => { controller.abort(); abort.current?.abort(); };
  }, [identity, lineId, originalProductionOrderId, nativeSpecificationVersionId, reload, refresh]);
  async function more() {
    if (!view?.nextCursor || reading) return;
    const snapshot = view, controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    setReading(true); setReadFailed(false); setError("");
    const query = new URLSearchParams({ after: view.nextCursor }); if (originalProductionOrderId) query.set("originalProductionOrderId", originalProductionOrderId);
    if (nativeSpecificationVersionId) query.set("nativeSpecificationVersionId", nativeSpecificationVersionId);
    try {
      const next = ProductionManufacturingOptionsSchema.parse(await centerRequest(`lines/${lineId}/manufacturing?${query}`, undefined, controller.signal));
      if (controller.signal.aborted) return;
      if (next.contextAuthority !== snapshot.contextAuthority || next.source?.specificationVersionId !== snapshot.source?.specificationVersionId) {
        clear(); setReadFailed(true); setError("制作来源或权限已变化 请重新核对"); return;
      }
      const combined = { ...next, items: [...new Map([...snapshot.items, ...next.items].map(item => [item.versionId, item])).values()] };
      previous.current = { identity, view: combined }; setView(combined);
    } catch (cause) { if (!controller.signal.aborted) {
      setReadFailed(true);
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) clear();
      setError(cause instanceof Error ? cause.message : "制造依据读取失败");
    } }
    finally { if (!controller.signal.aborted) setReading(false); }
  }
  const current = loadedIdentity === identity ? view : null;
  const choice = current?.items.find(item => item.versionId === selected), unavailable = reading || readFailed || !current;
  const ready = !disabled && !unavailable && !!choice && confirmed;
  useEffect(() => { readinessCallback.current?.(ready); }, [ready, identity]);
  useEffect(() => () => { readinessCallback.current?.(false); }, [identity]);
  return <fieldset className="oc-manufacturing-fields" disabled={disabled} aria-label="本次制造依据" aria-busy={reading}>
    <legend><ClipboardCheck size={15} aria-hidden="true" />本次制造依据</legend>
    {reading && <p role="status" className="oc-hint">正在核对原规格和已批准制造版本</p>}
    {error && <p role="alert" className="oc-error">{error}</p>}
    {readFailed && current && <p className="oc-hint">已保留本次选择 重新核对成功前不能提交</p>}
    {current?.source && <p className="oc-manufacturing-source">原规格 V{current.source.versionNumber} · {current.source.name}<small>每份 {current.source.packageQuantity} 件 · {current.source.packageContents}</small></p>}
    {current?.diagnostics.map(message => <p className="oc-hint" key={message}>{message}</p>)}
    <label>制造版本<select name={`${prefix}.version`} aria-label="制造版本" required disabled={unavailable} value={current ? selected : ""} onChange={event => { selection.current = event.target.value; setSelected(event.target.value); setConfirmed(false); }}>
      <option value="">明确选择已批准版本</option>{current?.items.map(item => <option key={item.versionId} value={item.versionId}>{item.code} · V{item.versionNumber} · {item.name} · 每批 {item.outputQuantity} {unit[item.outputUnit]}</option>)}</select></label>
    {choice && <p className="oc-hint">本次数量按销售 SKU 的{unit[choice.outputUnit]}数记录 部件和耗材另按已批准 BOM 计算</p>}
    <label className="oc-check"><input name={`${prefix}.confirmed`} type="checkbox" required disabled={unavailable} checked={!!current && confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对原规格 每份内容与件数 制造产出单位和本次订购数量一致</label>
    <div className="oc-action-row"><button className="oc-text-button" type="button" disabled={disabled || reading} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />重新核对制造依据</button>
      {current?.nextCursor && <button className="oc-text-button" type="button" disabled={reading || readFailed} onClick={() => void more()}>读取更多已批准版本</button>}
      {current?.source && <Link href={`/manufacturing-recipes?spuId=${current.source.spuId}`}>查看制造模板</Link>}</div>
  </fieldset>;
}

export function readProductionManufacturingSelection(form: FormData, prefix = "manufacturing") {
  const result = ProductionManufacturingSelectionSchema.safeParse({ versionId: form.get(`${prefix}.version`), orderUnitConfirmed: form.get(`${prefix}.confirmed`) === "on" });
  if (!result.success) throw new Error("请选择已批准制造版本 并核对原规格及销售 SKU 数量单位");
  return result.data;
}
