"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ProductionFactoryChoiceSchema, type ProductionFactoryChoice } from "@yummyai/contracts/suppliers/factory-directory";
import type { NativeProductionFactoryQuery } from "@yummyai/contracts/order/native-production";
import { centerRequest, OrderCenterRequestError } from "./order-center-model";

export function ProductionFactorySelect({ lineId, renderId, nativeSource, quantity, disabled, onReady, onSelection }: { lineId: string; renderId?: string; nativeSource?: NativeProductionFactoryQuery; quantity?: number; disabled: boolean; onReady?(ready: boolean): void; onSelection?(choice: ProductionFactoryChoice | null): void }) {
  const [choices, setChoices] = useState<ProductionFactoryChoice[]>([]), [selected, setSelected] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const nativeParameters = nativeSource ? new URLSearchParams(Object.entries(nativeSource).filter(([, value]) => value !== undefined).map(([name, value]) => [name, String(value)])) : null;
  if (nativeParameters && quantity !== undefined) nativeParameters.set("quantity", String(quantity));
  const nativeQuery = nativeParameters?.toString() ?? null;
  const identity = `${lineId}:${nativeQuery ?? renderId}:${quantity ?? "ordered"}`, callback = useRef(onReady), abort = useRef<AbortController | null>(null), previous = useRef("");
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null), selectionCallback = useRef(onSelection); callback.current = onReady; selectionCallback.current = onSelection;
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden") setRefresh(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    if (previous.current !== identity) { setChoices([]); setSelected(""); setLoadedIdentity(null); }
    previous.current = identity; setLoading(true); setError("");
    const query = new URLSearchParams({ renderId: renderId ?? "" }); if (quantity !== undefined) query.set("quantity", String(quantity));
    const path = nativeQuery ? `native/lines/${lineId}/factories?${nativeQuery}` : `lines/${lineId}/factories?${query}`;
    void centerRequest(path, undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return; const rows = ProductionFactoryChoiceSchema.array().parse(value); setChoices(rows);
      setLoadedIdentity(identity);
      setSelected(current => rows.some(row => row.pin.capabilityVersionId === current && !row.blockers.length) ? current : "");
    }).catch(cause => { if (!controller.signal.aborted) {
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) { setChoices([]); setSelected(""); setLoadedIdentity(null); }
      setError(cause instanceof Error ? cause.message : "工厂选项读取失败");
    } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [identity, lineId, renderId, nativeQuery, quantity, refresh]);
  const current = loadedIdentity === identity ? choices : [], choice = current.find(choice => choice.pin.capabilityVersionId === selected);
  const ready = !disabled && !loading && !error && !!choice && !choice.blockers.length;
  useEffect(() => { callback.current?.(ready); }, [ready, identity]);
  useEffect(() => { selectionCallback.current?.(!error && choice && !choice.blockers.length ? choice : null); }, [error, identity, choice]);
  useEffect(() => () => { callback.current?.(false); selectionCallback.current?.(null); }, [identity]);
  return <div className="oc-factory-select" aria-busy={loading}><label>生产工厂<select aria-label="生产工厂" required name="capabilityVersionId" value={choice ? selected : ""} disabled={disabled || loading || !!error} onChange={event => setSelected(event.target.value)}><option value="">{loading ? "正在核对工厂能力…" : "选择具体工厂与能力"}</option>{current.map(choice => <option value={choice.pin.capabilityVersionId} key={choice.pin.capabilityVersionId} disabled={!!choice.blockers.length}>{choice.pin.factoryProfile.name} · {choice.pin.supplierName} · {choice.pin.capabilityProfile.name}{choice.blockers.length ? `（${choice.blockers.join("；")}）` : ""}</option>)}</select></label>
    <input type="hidden" name="supplierId" value={choice?.pin.supplierId ?? ""} /><input type="hidden" name="factoryId" value={choice?.pin.factoryId ?? ""} /><input type="hidden" name="factoryVersionId" value={choice?.pin.factoryVersionId ?? ""} />
    {error && <p role="alert" className="oc-error">{error}</p>}{!loading && !current.some(choice => !choice.blockers.length) && !error && <p className="oc-muted">暂无可承接本次数量的工厂 请核对工厂能力及整件生产条件</p>}
    {!loading && !current.some(choice => !choice.blockers.length) && !error && current.map(choice => <div key={choice.pin.capabilityVersionId} className="oc-factory-diagnostics"><strong>{choice.pin.factoryProfile.name} · {choice.pin.capabilityProfile.name}</strong><ul>{choice.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul><Link href={`/suppliers/${choice.pin.supplierId}/factories/${choice.pin.factoryId}#capability-${choice.pin.capabilityId}`}>配置此工厂能力</Link></div>)}
    <div className="oc-inline"><button type="button" className="oc-button" disabled={disabled || loading} onClick={() => setRefresh(value => value + 1)}>刷新工厂选项</button><Link href="/suppliers">管理供应商与工厂</Link></div>
    {choice?.pin.factoryProfile.productionAddress && <p className="oc-muted">生产地点：{[choice.pin.factoryProfile.productionAddress.countryCode, choice.pin.factoryProfile.productionAddress.province, choice.pin.factoryProfile.productionAddress.city, choice.pin.factoryProfile.productionAddress.district, choice.pin.factoryProfile.productionAddress.street].filter(Boolean).join(" · ")} · 资料 V{choice.pin.factoryVersionNumber}</p>}
  </div>;
}
