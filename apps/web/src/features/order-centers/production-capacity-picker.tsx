"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CalendarDays, RefreshCw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { FactoryCapacityWorkspaceSchema, FactoryCapacityPreviewInputSchema, FactoryCapacityPreviewItemSchema,
  FactoryCapacityPreviewSchema, ResolvedFactoryLocalTimeSchema, ProductionCapacityViewSchema,
  type FactoryCapacityWorkspace, type FactoryCapacityPreview, type FactoryCapacityPreviewInput, type ProductionCapacityView } from "@yummyai/contracts/suppliers/factory-capacity";
import { useErpAccess } from "../identity/erp-access";
import { capacityDenied, capacityError, capacityLocalInstant, capacityReason, capacityRecheck, capacityRequest, capacityUnitName } from "./production-capacity-api";
import "../manual-operations/factory-capacity.css";

export type ProductionCapacityDraft = { reference: string; factoryVersionId: string; capabilityVersionId: string; quantity: number; dueLocal: string };
export function readProductionCapacitySelection(form: FormData, reference: string, expected?: { factoryVersionId?: string; capabilityVersionId?: string; quantity?: number }) {
  let raw: unknown;
  try { raw = JSON.parse(String(form.get(`capacity-${reference}`) ?? "")); } catch { throw new Error("请先明确选择完整资源池日期 并核对本批产能与工厂当地完工时间"); }
  const value = FactoryCapacityPreviewItemSchema.parse(raw);
  if (value.reference !== reference || expected?.factoryVersionId && value.factoryVersionId !== expected.factoryVersionId
    || expected?.capabilityVersionId && value.capabilityVersionId !== expected.capabilityVersionId || expected?.quantity !== undefined && value.quantity !== expected.quantity)
    throw new Error("本次生产来源 数量或工厂固定版本已变化 请重新预览产能");
  return { expectedCompletionAt: value.expectedCompletionAt, capacityPlan: value.capacityPlan };
}
export function ProductionCapacityPicker({ factoryId, items, basisKey = "", disabled, onReady, onDenied }: {
  factoryId: string; items: ProductionCapacityDraft[]; basisKey?: string; disabled: boolean; onReady?(ready: boolean): void; onDenied?(): void;
}) {
  const access = useErpAccess(), canRead = access.canTenant(Permission.OrderRead);
  const sourceIdentity = JSON.stringify([access.preferenceScope, access.authority, factoryId, items, basisKey, canRead]);
  const readIdentity = JSON.stringify([access.preferenceScope, access.authority, factoryId, items.map(item => [item.factoryVersionId, item.capabilityVersionId]), canRead]);
  const [read, setRead] = useState<{ stamp: string; value: FactoryCapacityWorkspace | null; reading: boolean; error: string } | null>(null);
  const [selections, setSelections] = useState<{ stamp: string; dates: Record<string, string> }>({ stamp: "", dates: {} });
  const [prepared, setPrepared] = useState<{ stamp: string; input: FactoryCapacityPreviewInput; preview: FactoryCapacityPreview; zones: string[] } | null>(null);
  const [checking, setChecking] = useState(false), [error, setError] = useState(""), [reload, setReload] = useState(0), [denial, setDenial] = useState("");
  const dates = selections.stamp === readIdentity ? selections.dates : {};
  const stamp = JSON.stringify([sourceIdentity, dates, reload]);
  const current = useRef({ stamp, readIdentity, canRead }), active = useRef<AbortController | null>(null), sequence = useRef(0);
  const callback = useRef(onReady), denied = useRef(onDenied); current.current = { stamp, readIdentity, canRead }; callback.current = onReady; denied.current = onDenied;
  useEffect(() => { if (!canRead || denial === readIdentity) return;
    const controller = new AbortController(), valid = () => !controller.signal.aborted && current.current.readIdentity === readIdentity && current.current.canRead;
    setRead({ stamp: readIdentity, value: null, reading: true, error: "" });
    void capacityRequest(`factories/${factoryId}/capacity`, FactoryCapacityWorkspaceSchema, { authority: access.authority, localDevelopment: access.localDevelopment }, undefined, controller.signal).then(value => {
      if (!valid()) return; if (value.factoryId !== factoryId) throw new Error("parent"); setRead({ stamp: readIdentity, value, reading: false, error: "" });
    }).catch(failure => { if (valid()) { setRead({ stamp: readIdentity, value: null, reading: false, error: capacityError(failure) });
      if (capacityDenied(failure)) { setDenial(readIdentity); capacityRecheck(); denied.current?.(); } } });
    return () => controller.abort();
  }, [readIdentity, factoryId, canRead, denial, reload, access.authority, access.localDevelopment]);
  useLayoutEffect(() => { sequence.current++; active.current?.abort(); setPrepared(null); setChecking(false); setError(""); }, [stamp]);
  useEffect(() => { const check = () => { if (document.visibilityState !== "hidden") setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  useEffect(() => () => { sequence.current++; active.current?.abort(); callback.current?.(false); }, []);
  const validRead = canRead && denial !== readIdentity && read?.stamp === readIdentity ? read : null, workspace = validRead?.value;
  const eligible = items.map(item => ({ item, pools: workspace?.pools.filter(pool => ["active", "paused"].includes(pool.profile.status) && pool.profile.bindings.some(binding => binding.capabilityVersionId === item.capabilityVersionId)) ?? [] }));
  const complete = !!workspace && items.length > 0 && items.length <= 100 && eligible.every(({ item, pools }) => item.factoryVersionId && item.capabilityVersionId && Number.isSafeInteger(item.quantity) && item.quantity > 0
    && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.dueLocal) && pools.length > 0 && pools.every(pool => pool.profile.status === "active" && !!dates[`${item.reference}:${pool.id}`]));
  const result = canRead && denial !== readIdentity && prepared?.stamp === stamp ? prepared : null;
  const ready = !disabled && !!result?.preview.canReserve && result.preview.access.canWrite && !checking;
  useLayoutEffect(() => { callback.current?.(ready); }, [ready, stamp]);
  async function preview() {
    if (!complete || disabled || checking || !workspace) return;
    const controller = new AbortController(); active.current?.abort(); active.current = controller; const token = ++sequence.current;
    const valid = () => !controller.signal.aborted && current.current.stamp === stamp && current.current.canRead && sequence.current === token;
    setChecking(true); setError(""); setPrepared(null);
    try {
      const resolutions = new Map<string, ReturnType<typeof ResolvedFactoryLocalTimeSchema.parse>>();
      for (const item of items) {
        const key = `${item.factoryVersionId}:${item.dueLocal}`;
        if (!resolutions.has(key)) { const value = await capacityRequest(`factories/${factoryId}/capacity/resolve-time`, ResolvedFactoryLocalTimeSchema, access,
          { factoryVersionId: item.factoryVersionId, localDateTime: item.dueLocal }, controller.signal);
          if (!valid()) return; if (value.factoryId !== factoryId || value.factoryVersionId !== item.factoryVersionId || value.localDateTime !== item.dueLocal) throw new Error("time-parent"); resolutions.set(key, value); }
      }
      const input = FactoryCapacityPreviewInputSchema.parse({ items: eligible.map(({ item, pools }) => ({ reference: item.reference, factoryVersionId: item.factoryVersionId,
        capabilityVersionId: item.capabilityVersionId, quantity: item.quantity, expectedCompletionAt: resolutions.get(`${item.factoryVersionId}:${item.dueLocal}`)!.instant,
        capacityPlan: { allocations: pools.map(pool => ({ poolId: pool.id, poolVersionId: pool.versionId, localDate: dates[`${item.reference}:${pool.id}`] })) } })) });
      const value = await capacityRequest(`factories/${factoryId}/capacity-preview`, FactoryCapacityPreviewSchema, access, input, controller.signal);
      if (!valid()) return; if (value.factoryId !== factoryId || value.items.length !== input.items.length || value.items.some(row => !input.items.some(item => item.reference === row.reference && item.quantity === row.quantity && item.expectedCompletionAt === row.expectedCompletionAt))) throw new Error("preview-parent");
      setPrepared({ stamp, input, preview: value, zones: [...new Set([...resolutions.values()].map(value => value.timeZone))] });
    } catch (failure) { if (valid()) { setError(capacityError(failure)); if (capacityDenied(failure)) { setDenial(readIdentity); setRead(null); capacityRecheck(); denied.current?.(); } } }
    finally { if (valid()) setChecking(false); }
  }
  return <section className="pc-picker" aria-label="本次生产产能安排" aria-busy={checking || validRead?.reading}><h4><CalendarDays size={14} aria-hidden="true" /> 本次生产产能安排</h4>
    <p>逐项明确每个共享资源池的工厂当地日期 本批全部数量使用同一份安排 预览不保留额度 正式提交时会重新核对并原子预留</p>
    {!canRead || denial === readIdentity ? <p className="pc-error" role="status">当前工厂产能读取权限尚未核对 旧安排已隐藏</p> : <>
      {validRead?.reading && <p role="status">正在读取当前工厂资源池与当地日历</p>}{validRead?.error && <p className="pc-error" role="alert">{validRead.error}</p>}
      {eligible.map(({ item, pools }, index) => <div className="pc-item" key={item.reference}><strong>本批项目 {index + 1} · {item.quantity} 件</strong>
        <p>固定能力 <code>{item.capabilityVersionId}</code></p>{workspace && !pools.length && <p className="pc-error">未配置该固定能力的实际共享产能池 新预约受阻 不使用旧日产能参考值</p>}
        <div className="pc-allocations">{pools.map(pool => {
          const date = dates[`${item.reference}:${pool.id}`] ?? "", day = workspace?.calendar.find(day => day.poolId === pool.id && day.localDate === date);
          return <div className="pc-allocation" key={pool.id}><label>{pool.profile.name} 当地生产日期<input type="date" min="2000-01-01" max="2099-12-31" aria-label={`项目${index + 1} ${pool.profile.name}当地生产日期`} required value={date} disabled={disabled || checking || pool.profile.status !== "active"}
            onChange={event => setSelections({ stamp: readIdentity, dates: { ...dates, [`${item.reference}:${pool.id}`]: event.target.value } })} /></label>
            <div><p>{pool.timeZone} · 资源池 V{pool.versionNumber} · 每件 {pool.profile.bindings.find(binding => binding.capabilityVersionId === item.capabilityVersionId)?.unitsPerItem} {capacityUnitName(pool.unit)}</p>
              {pool.profile.status !== "active" && <p className="pc-error">绑定池已暂停 仍为本次必需资源 不能新预约</p>}{day ? <p>本次读取的当日额度 {day.capacityUnits === null ? "未知" : day.capacityUnits} · 可用 {day.capacityUnits === null ? "未确认" : `${day.availableUnits} ${capacityUnitName(pool.unit)}`}</p> : <p>选择日期后通过预览读取该日真实余额</p>}</div></div>;
        })}</div></div>)}
      {!items.every(item => item.dueLocal) && <p className="pc-note">请先填写工厂当地预计完成时间 服务端会按固定工厂时区解析 资源池生产日期须另行选择</p>}
      <div className="pc-actions"><button type="button" disabled={!complete || disabled || checking} onClick={() => void preview()}>{checking ? "正在核对本批实际产能" : "核对本批产能与当地完工时间"}</button>
        <button type="button" disabled={disabled || checking || validRead?.reading} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />重新读取可用资源池</button></div>
      {error && <p className="pc-error" role="alert">{error}</p>}
      {result && <section aria-label="本批产能核对结果"><p className={result.preview.canReserve ? "pc-note" : "pc-error"} role="status">{result.preview.canReserve ? "本次预览可预约 尚未占用产能" : "本次产能核对受阻 不能下达生产"} · 工厂时区 {result.zones.join(" / ")} · 读取时刻 {result.preview.recordedAt}</p>
        {result.preview.blockers.map(reason => <p className="pc-error" key={reason}>{capacityReason(reason)}</p>)}
        {result.preview.items.map((item, index) => <div className="pc-item" key={item.reference}><strong>项目 {index + 1} · {item.quantity} 件</strong><p>原工厂完工时刻 {item.expectedCompletionAt}</p>
          {item.blockers.map(reason => <p className="pc-error" key={reason}>{capacityReason(reason)}</p>)}
          {item.allocations.map(allocation => <div key={allocation.selection.poolId}><p>{allocation.poolName} · {allocation.selection.localDate} · {allocation.day.timeZone} · 本批需要 {allocation.requestedUnits} {capacityUnitName(allocation.day.unit)}</p>
            <p>当日额度 {allocation.day.capacityUnits === null ? "未知" : allocation.day.capacityUnits} · 原总预留 {allocation.day.allocatedUnits} · 已承诺 {allocation.day.committedUnits} · 已释放 {allocation.day.releasedUnits} · 可用 {allocation.day.capacityUnits === null ? "未确认" : allocation.day.availableUnits}</p>
            {allocation.day.blockers.map(reason => <p className="pc-error" key={reason}>{capacityReason(reason)}</p>)}</div>)}</div>)}
      </section>}
      {ready && result.input.items.map(item => <input key={item.reference} type="hidden" name={`capacity-${item.reference}`} value={JSON.stringify(item)} readOnly />)}
    </>}
  </section>;
}
export function ProductionCapacityReceipt({ productionOrderId, refresh = "", onDenied }: { productionOrderId: string; refresh?: string; onDenied?(): void }) {
  const access = useErpAccess(), allowed = access.canTenant(Permission.OrderRead);
  const stamp = JSON.stringify([access.authority, access.preferenceScope, productionOrderId, allowed, refresh]);
  const [snapshot, setSnapshot] = useState<{ stamp: string; value: ProductionCapacityView | null; error: string; reading: boolean } | null>(null), [reload, setReload] = useState(0);
  const current = useRef(stamp), callback = useRef(onDenied); current.current = stamp; callback.current = onDenied;
  useEffect(() => { if (!allowed) return;
    const controller = new AbortController(), valid = () => !controller.signal.aborted && current.current === stamp;
    setSnapshot({ stamp, value: null, reading: true, error: "" });
    void capacityRequest(`production-orders/${productionOrderId}/capacity`, ProductionCapacityViewSchema, { authority: access.authority, localDevelopment: access.localDevelopment }, undefined, controller.signal).then(value => {
      if (!valid()) return; if (value.productionOrderId !== productionOrderId) throw new Error("parent"); setSnapshot({ stamp, value, reading: false, error: "" });
    }).catch(failure => { if (valid()) { setSnapshot({ stamp, value: null, reading: false, error: capacityError(failure) }); if (capacityDenied(failure)) { capacityRecheck(); callback.current?.(); } } });
    return () => controller.abort();
  }, [stamp, allowed, productionOrderId, reload, access.authority, access.localDevelopment]);
  const read = allowed && snapshot?.stamp === stamp ? snapshot : null;
  return <section className="pc-receipt" aria-label="原生产产能预留与释放"><h4>原生产产能预留与释放</h4>
    {!allowed && <p>当前读取权限尚未核对 原产能预留已隐藏</p>}{read?.reading && <p role="status">正在读取原生产实际产能台账</p>}{read?.error && <p className="pc-error" role="alert">{read.error}</p>}
    <button className="oc-text-button" type="button" disabled={!allowed || read?.reading} onClick={() => setReload(value => value + 1)}>重新读取原产能台账</button>
    {read?.value?.status === "legacy_unreserved" && <p className="pc-note">历史生产没有固定产能预留 不能把当前资源池或旧日产能回填成原记录 新补做须另行核对实际资源池</p>}
    {read?.value?.reservations.map(row => <div className="pc-item" key={row.id}><p>{row.localDate} · {row.timeZone} · {row.quantity} 件 × 每件 {row.unitsPerItem} {capacityUnitName(row.unit)}</p>
      <p>原预留 {row.totalUnits} · 已承诺 {row.committedUnits} · 已释放 {row.releasedUnits} · 未承诺且未释放 {row.totalUnits - row.committedUnits - row.releasedUnits}</p>
      <p>原工作时段 {capacityLocalInstant(row.workStartsAt, row.timeZone)}–{capacityLocalInstant(row.workEndsAt, row.timeZone)}</p><p>固定资源池版本 <code>{row.poolVersionId}</code><br />原预留凭据 <code>{row.id}</code></p>
    </div>)}<p>停单申请不等于释放 仅实际台账中的释放记录减少占用 已承诺生产仍保留</p>
  </section>;
}
