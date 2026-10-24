"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CalendarDays, Plus, RefreshCw, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { FactoryCapacityWorkspaceSchema, FactoryCapacityHistorySchema, type FactoryCapacityWorkspace as Workspace,
  type FactoryCapacityPoolView, type FactoryCapacityDay } from "@yummyai/contracts/suppliers/factory-capacity";
import type { FactoryCapabilityView, FactoryView } from "@yummyai/contracts/suppliers/factory-directory";
import { useErpAccess } from "../identity/erp-access";
import { capacityDenied, capacityError, capacityLocalInstant, capacityReason, capacityRequest, capacityUnitName } from "../order-centers/production-capacity-api";
import { FactoryCapacityForm } from "./factory-capacity-form";
import "./factory-capacity.css";

const statusNames = { draft: "草稿", active: "启用", paused: "暂停", archived: "归档" };
export function CapacityDay({ day }: { day: FactoryCapacityDay }) {
  return <li className="fc-day"><strong>{day.localDate}<small> · {day.timeZone}</small></strong><div>
    <p>当日额度 {day.capacityUnits === null ? "未知" : day.capacityUnits} · 原总预留 {day.allocatedUnits} · 已承诺 {day.committedUnits} · 已释放 {day.releasedUnits}</p>
    <p>净占用 {day.allocatedUnits - day.releasedUnits} · 可用 {day.capacityUnits === null ? "未确认" : `${day.availableUnits} ${capacityUnitName(day.unit)}`}{day.blockers.length ? " · 当前不可新预约" : ""}</p>
    <p>{day.intervals.length ? day.intervals.map(interval => `${capacityLocalInstant(interval.start, day.timeZone)}–${capacityLocalInstant(interval.end, day.timeZone)}`).join(" / ") : "该日无工作区间"}{day.cutoffAt ? ` · 截单 ${capacityLocalInstant(day.cutoffAt, day.timeZone)}` : " · 未设置截单时间"}</p>
    {day.blockers.map(reason => <p className="fc-error" key={reason}>{capacityReason(reason)}</p>)}
  </div></li>;
}
function PoolProfile({ pool }: { pool: FactoryCapacityPoolView }) {
  return <div><p>{pool.code} · {pool.timeZone} · {capacityUnitName(pool.unit)} · {statusNames[pool.profile.status]} · V{pool.versionNumber}</p>
    <p>每日额度 {pool.profile.dailyCapacityUnits === null ? "未知" : pool.profile.dailyCapacityUnits} · 截单 {pool.profile.cutoffTime ?? "未设置"}</p>
    <p>实际依据 {pool.profile.evidenceReference || "未确认"}</p><p>固定版本 <code>{pool.versionId}</code> · 工厂资料版本 <code>{pool.factoryVersionId}</code></p>
    <details><summary>完整工作规则与能力用量</summary>{pool.profile.weekly.map(day => <p key={day.weekday}>周{["一", "二", "三", "四", "五", "六", "日"][day.weekday - 1]} {day.intervals.length ? day.intervals.map(interval => `${interval.start}–${interval.end}`).join(" / ") : "不安排工作"}</p>)}
      {pool.profile.exceptions.map(day => <p key={day.localDate}>{day.localDate} 例外额度 {day.capacityUnits} · {day.intervals.length ? day.intervals.map(interval => `${interval.start}–${interval.end}`).join(" / ") : "闭厂"}</p>)}
      {pool.profile.bindings.map(binding => <p key={binding.capabilityVersionId}>能力版本 <code>{binding.capabilityVersionId}</code> · 每件 {binding.unitsPerItem} {capacityUnitName(pool.unit)}</p>)}
      <p>{pool.profile.notes || "无补充备注"}</p></details></div>;
}
export function FactoryCapacityWorkspace({ factory, capabilities, canWrite, onDenied }: { factory: FactoryView; capabilities: FactoryCapabilityView[]; canWrite: boolean; onDenied(): void }) {
  const access = useErpAccess(), canRead = access.canTenant(Permission.OrderRead), writeCeiling = access.canTenant(Permission.OrderWrite);
  const stamp = JSON.stringify([access.authority, access.preferenceScope, factory.id, factory.versionId, canRead, writeCeiling, canWrite]);
  const [read, setRead] = useState<{ stamp: string; value: Workspace | null; reading: boolean; error: string } | null>(null), [reload, setReload] = useState(0);
  const [range, setRange] = useState({ from: "", days: "14" }), [query, setQuery] = useState(""), [selectedPool, setSelectedPool] = useState("");
  const [editor, setEditor] = useState<{ stamp: string; value: FactoryCapacityPoolView | "new" } | null>(null), [notice, setNotice] = useState("");
  const [historyPool, setHistoryPool] = useState(""), [historyReload, setHistoryReload] = useState(0), [history, setHistory] = useState<{ stamp: string; poolId: string; value: ReturnType<typeof FactoryCapacityHistorySchema.parse> | null; reading: boolean; error: string } | null>(null);
  const historySequence = useRef(0), historyController = useRef<AbortController | null>(null);
  const live = useRef({ stamp, canRead }), denied = useRef(onDenied); live.current = { stamp, canRead }; denied.current = onDenied;
  useLayoutEffect(() => { historySequence.current++; historyController.current?.abort(); setRead(null); setEditor(null); setHistory(null); setHistoryPool(""); setSelectedPool(""); setNotice(""); setQuery(""); setRange({ from: "", days: "14" }); }, [stamp]);
  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController(), valid = () => !controller.signal.aborted && live.current.stamp === stamp && live.current.canRead;
    setRead({ stamp, value: null, reading: true, error: "" });
    void capacityRequest(`factories/${factory.id}/capacity${query ? `?${query}` : ""}`, FactoryCapacityWorkspaceSchema, { authority: access.authority, localDevelopment: access.localDevelopment }, undefined, controller.signal).then(value => {
      if (!valid()) return; if (value.factoryId !== factory.id) throw new Error("parent");
      setRead({ stamp, value, reading: false, error: "" }); setRange(current => ({ from: current.from || value.from, days: String(value.days) }));
      setSelectedPool(current => value.pools.some(pool => pool.id === current) ? current : value.pools[0]?.id ?? "");
    }).catch(failure => { if (valid()) { setRead({ stamp, value: null, reading: false, error: capacityError(failure) }); if (capacityDenied(failure)) denied.current(); } });
    return () => controller.abort();
  }, [stamp, canRead, factory.id, query, reload, access.authority, access.localDevelopment]);
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden") setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  useEffect(() => {
    if (!historyPool || !canRead) return;
    const controller = new AbortController(), token = ++historySequence.current;
    historyController.current?.abort(); historyController.current = controller;
    const valid = () => !controller.signal.aborted && historySequence.current === token && live.current.stamp === stamp && live.current.canRead;
    setHistory({ stamp, poolId: historyPool, value: null, reading: true, error: "" });
    void capacityRequest(`factories/${factory.id}/capacity-pools/${historyPool}/history`, FactoryCapacityHistorySchema, { authority: access.authority, localDevelopment: access.localDevelopment }, undefined, controller.signal).then(value => {
      if (!valid()) return; if (value.factoryId !== factory.id || value.poolId !== historyPool) throw new Error("parent");
      setHistory({ stamp, poolId: historyPool, value, reading: false, error: "" });
    }).catch(failure => { if (valid()) { setHistory({ stamp, poolId: historyPool, value: null, reading: false, error: capacityError(failure) }); if (capacityDenied(failure)) denied.current(); } });
    return () => controller.abort();
  }, [historyPool, historyReload, stamp, canRead, factory.id, access.authority, access.localDevelopment]);
  const current = canRead && read?.stamp === stamp ? read : null, view = current?.value;
  const writable = !!view && canWrite && writeCeiling && view.access.canWrite;
  const editing = canRead && canWrite && writeCeiling && view?.access.canWrite !== false && editor?.stamp === stamp ? editor : null;
  const activeHistory = canRead && history?.stamp === stamp && history.poolId === historyPool ? history : null;
  const pool = view?.pools.find(row => row.id === selectedPool);
  return <section className="fc-workspace" aria-label="工厂日历与共享产能" aria-busy={current?.reading ?? false}><header><h3><CalendarDays size={15} aria-hidden="true" /> 工厂日历与共享产能</h3><div className="fc-actions">
    {writable && <button className="primary" type="button" onClick={() => setEditor({ stamp, value: "new" })}><Plus size={14} aria-hidden="true" />新增共享产能池</button>}
    <button type="button" disabled={!canRead || current?.reading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新读取工厂产能</button></div></header>
    <p>资源池在不同产品能力之间共享余额 预览不占用 真实下达才预留 日历采用工厂当地日期 不按浏览器时区换日</p>
    {!factory.profile.timeZone && <p className="fc-note">工厂时区尚未确认 请先在工厂资料登记实际 IANA 时区 不能用浏览器时区生成日历</p>}
    {!canRead && <p role="status">当前读取权限尚未核对 私有工厂产能已隐藏</p>}{current?.reading && <p role="status">正在读取工厂当地日历与实际产能台账</p>}
    {current?.error && <p role="alert" className="fc-error">{current.error}</p>}{notice && <p role="status" className="fc-note">{notice}</p>}
    {view && <><form className="fc-grid" aria-label="查询工厂当地日历" onSubmit={event => { event.preventDefault(); setQuery(new URLSearchParams({ ...(range.from ? { from: range.from } : {}), days: range.days }).toString()); setReload(value => value + 1); }}>
      <label>工厂当地起始日期<input type="date" min="2000-01-01" max="2099-12-31" required value={range.from} onChange={event => setRange(value => ({ ...value, from: event.target.value }))} /></label><label>读取天数<input type="number" min={1} max={31} required value={range.days} onChange={event => setRange(value => ({ ...value, days: event.target.value }))} /></label>
      <button type="submit">读取此日期范围</button></form><p>本次读取 {view.from} 起 {view.days} 天 · 读取时刻 {view.recordedAt} · 当前读取结果不锁定后续余额</p>
      {!view.pools.length && <p className="fc-note">尚无可核对的共享产能池 新生产安排当前受阻 旧日产能参考值不会自动成为可预约额度</p>}
      <ul className="fc-list">{view.pools.map(row => <li key={row.id}><header><strong>{row.profile.name}</strong><div className="fc-actions"><button type="button" onClick={() => setSelectedPool(row.id)}>查看此池日历</button>
        <button type="button" onClick={() => { historySequence.current++; historyController.current?.abort(); setHistory(null); setHistoryPool(row.id); setHistoryReload(value => value + 1); }}>读取此池历史</button>{writable && <button type="button" onClick={() => setEditor({ stamp, value: row })}>修订产能池</button>}</div></header><PoolProfile pool={row} /></li>)}</ul>
      {pool && <section aria-label="所选资源池当地日历"><label>查看资源池<select value={selectedPool} onChange={event => setSelectedPool(event.target.value)}>{view.pools.map(row => <option key={row.id} value={row.id}>{row.profile.name} · {row.timeZone}</option>)}</select></label>
        <ul className="fc-list">{view.calendar.filter(day => day.poolId === pool.id).map(day => <CapacityDay key={day.localDate} day={day} />)}</ul>
        {!view.calendar.some(day => day.poolId === pool.id) && <p className="fc-note">所选资源池尚无可读取日历 不能以零余额或旧日期代替</p>}</section>}
    </>}
    {activeHistory && <section aria-label="共享产能池版本历史"><header><h3>共享产能池版本历史</h3><button type="button" onClick={() => { historySequence.current++; historyController.current?.abort(); setHistoryPool(""); setHistory(null); }}><X size={14} aria-hidden="true" />关闭产能池历史</button></header>
      {activeHistory.reading && <p role="status">正在读取原资源池全部版本</p>}{activeHistory.error && <p role="alert" className="fc-error">{activeHistory.error}</p>}
      {activeHistory.value?.versions.map(row => <details key={row.versionId}><summary>{row.profile.name} · V{row.versionNumber} · {statusNames[row.profile.status]}</summary><PoolProfile pool={row} /></details>)}</section>}
    {editing && <FactoryCapacityForm key={`${stamp}:${editing.value === "new" ? "new" : editing.value.versionId}`} factory={factory} capabilities={capabilities} identity={access} record={editing.value === "new" ? undefined : editing.value}
      onClose={() => setEditor(null)} onDenied={() => { setEditor(null); setRead(null); denied.current(); }} onSaved={value => { if (live.current.stamp !== stamp) return; setEditor(null); setNotice(`产能池 V${value.versionNumber} 已登记 正在重新读取实际日历`); setReload(value => value + 1); }} />}
  </section>;
}
