"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import { ProductionMaterialReceiptSchema, ProductionMaterialStockOptionsSchema, ProductionMaterialReservationOptionsSchema,
  type ProductionMaterialsWorkspace, type RecordProductionMaterial } from "@yummyai/contracts/order/material-execution";
import { formatStockQuantity } from "@yummyai/contracts/inventory/quantity";
import type { z } from "zod";
import { useErpAccess } from "../identity/erp-access";
import { materialRequest, materialAuthorityChanged } from "./production-material-api";
import { buildMaterialInput, emptyMaterialDraft, materialBasisStamp, materialKindNames, type MaterialDraft, type MaterialMode } from "./production-material-model";
import { unitNames } from "../manual-operations/operation-types";

type StockPage = z.infer<typeof ProductionMaterialStockOptionsSchema>;
type ReservationPage = z.infer<typeof ProductionMaterialReservationOptionsSchema>;
type Options = { scope: string; stock: StockPage | null; reservations: ReservationPage | null; original: z.infer<typeof ProductionMaterialReceiptSchema> | null; checked: boolean; error: string };
const localTime = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

export function ProductionMaterialForm({ basis, current, mode, disabled, refresh, onEditsChanged, onSubmit, onClose, onRebase, onDenied }: {
  basis: ProductionMaterialsWorkspace; current: ProductionMaterialsWorkspace | null; mode: MaterialMode; disabled: boolean; refresh: string;
  onEditsChanged(): void; onSubmit(input: RecordProductionMaterial): Promise<void>; onClose(): void; onRebase(): void; onDenied(error: unknown): void;
}) {
  const access = useErpAccess(), identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const [draft, setDraft] = useState<MaterialDraft>(() => ({ ...emptyMaterialDraft(), occurredAt: localTime(), reservation: mode.reservationEntryId ?? "" }));
  const [options, setOptions] = useState<Options>({ scope: "", stock: null, reservations: null, original: null, checked: false, error: "" });
  const [reading, setReading] = useState(false), [reload, setReload] = useState(0), [error, setError] = useState("");
  const stamp = materialBasisStamp(basis), scope = `${identity.authority}:${basis.productionOrderId}:${stamp}:${mode.kind}:${mode.materialCode}:${mode.originalEntryId ?? ""}`;
  const latest = useRef(scope), draftRef = useRef(draft), denied = useRef(onDenied), sequence = useRef(0);
  latest.current = scope; draftRef.current = draft; denied.current = onDenied;
  const values = options.scope === scope ? options : null, line = basis.lines.find(row => row.code === mode.materialCode);
  const stale = !current || !current.canWrite || materialBasisStamp(current) !== stamp;
  const merchantInput = mode.kind === "reserve" || mode.kind === "consume";
  useLayoutEffect(() => { onEditsChanged(); }, [draft, options, onEditsChanged]);
  useEffect(() => { setDraft(previous => ({ ...previous, confirmed: false })); }, [stamp]);
  useEffect(() => {
    const abort = new AbortController(), captured = scope, generation = ++sequence.current;
    setReading(true);
    const query = new URLSearchParams({ bindingId: basis.bindingId ?? "", materialCode: mode.materialCode });
    const stockQuery = new URLSearchParams(query), reserveQuery = new URLSearchParams(query);
    if (draftRef.current.dimension) stockQuery.set("selected", draftRef.current.dimension);
    if (draftRef.current.reservation) reserveQuery.set("selected", draftRef.current.reservation);
    void Promise.all([
      merchantInput ? materialRequest(`${basis.productionOrderId}/stock-options?${stockQuery}`, ProductionMaterialStockOptionsSchema, identity, undefined, abort.signal) : null,
      mode.kind === "consume" ? materialRequest(`${basis.productionOrderId}/reservation-options?${reserveQuery}`, ProductionMaterialReservationOptionsSchema, identity, undefined, abort.signal) : null,
      mode.originalEntryId ? materialRequest(`${basis.productionOrderId}/entries/${mode.originalEntryId}`, ProductionMaterialReceiptSchema, identity, undefined, abort.signal) : null,
    ]).then(([stock, reservations, original]) => {
      if (abort.signal.aborted || latest.current !== captured || sequence.current !== generation) return;
      if ([stock, reservations].some(page => page && (page.productionOrderId !== basis.productionOrderId || page.bindingId !== basis.bindingId || page.materialCode !== mode.materialCode)) ||
        original && (original.id !== mode.originalEntryId || original.productionOrderId !== basis.productionOrderId || original.bindingId !== basis.bindingId || original.materialCode !== mode.materialCode)) throw new Error("原物料来源不一致 请重新核对");
      setOptions({ scope: captured, stock, reservations, original, checked: true, error: "" });
    }).catch(cause => {
      if (abort.signal.aborted || latest.current !== captured || sequence.current !== generation) return;
      setOptions({ scope: captured, stock: null, reservations: null, original: null, checked: false, error: cause instanceof Error ? cause.message : "库位与原记录暂时无法核对" });
      if (materialAuthorityChanged(cause)) denied.current(cause);
    }).finally(() => { if (!abort.signal.aborted && latest.current === captured && sequence.current === generation) setReading(false); });
    return () => { abort.abort(); sequence.current++; };
  }, [scope, identity, basis.bindingId, basis.productionOrderId, mode.kind, mode.materialCode, mode.originalEntryId, merchantInput, refresh, reload]);
  const stocks = merge(values?.stock?.items ?? [], values?.stock?.selected ?? [], row => row.dimensionKey);
  const reservations = merge(values?.reservations?.items ?? [], values?.reservations?.selected ?? [], row => row.entryId);
  const workingBasis = values?.original ? { ...basis, entries: [...basis.entries.filter(row => row.id !== values.original!.id), values.original] } : basis;
  let validation = "";
  try { buildMaterialInput(workingBasis, mode, draft, stocks, reservations, "material-preview"); }
  catch (cause) { validation = cause instanceof Error && cause.name !== "ZodError" ? cause.message : "请核对数量 时间与来源"; }
  function change<K extends keyof MaterialDraft>(key: K, value: MaterialDraft[K]) { setError(""); setDraft(previous => ({ ...previous, [key]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || reading || stale || !values?.checked) return;
    try { await onSubmit(buildMaterialInput(workingBasis, mode, draft, stocks, reservations, crypto.randomUUID())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "物料提交暂时无法确认"); }
  }
  async function more(kind: "stock" | "reservations") {
    const page = kind === "stock" ? values?.stock : values?.reservations;
    if (!page?.nextCursor || reading || !values?.checked) return;
    const captured = scope, generation = sequence.current;
    setReading(true);
    try {
      const query = new URLSearchParams({ bindingId: basis.bindingId!, materialCode: mode.materialCode, after: page.nextCursor });
      if (kind === "stock") {
        const next = await materialRequest(`${basis.productionOrderId}/stock-options?${query}`, ProductionMaterialStockOptionsSchema, identity);
        if (latest.current === captured && sequence.current === generation) setOptions(previous => ({ ...previous, stock: { ...next, selected: previous.stock?.selected ?? [], items: merge(previous.stock?.items ?? [], next.items, row => row.dimensionKey) } }));
      } else {
        const next = await materialRequest(`${basis.productionOrderId}/reservation-options?${query}`, ProductionMaterialReservationOptionsSchema, identity);
        if (latest.current === captured && sequence.current === generation) setOptions(previous => ({ ...previous, reservations: { ...next, selected: previous.reservations?.selected ?? [], items: merge(previous.reservations?.items ?? [], next.items, row => row.entryId) } }));
      }
    } catch (cause) {
      if (latest.current === captured && sequence.current === generation) {
        setOptions(previous => ({ ...previous, checked: false, error: cause instanceof Error ? cause.message : "更多库位暂时无法核对" }));
        if (materialAuthorityChanged(cause)) denied.current(cause);
      }
    } finally { if (latest.current === captured && sequence.current === generation) setReading(false); }
  }
  const original = values?.original, reservation = reservations.find(row => row.entryId === draft.reservation);
  const originalDescription = original ? [original.warehouseName, original.locationName, original.lotCode && `批次 ${original.lotCode}`].filter(Boolean).join(" / ") : "";
  return <form className="oc-material-form" aria-label={materialKindNames[mode.kind]} onSubmit={event => void submit(event)}>
    <header><div><strong>{materialKindNames[mode.kind]} · {line?.name}</strong><small>数量单位 {line ? unitNames[line.unit] : "待核对"}</small></div>
      <button type="button" className="oc-text-button" disabled={disabled} onClick={onClose} aria-label="关闭物料表单"><X size={14} aria-hidden="true" /></button></header>
    {stale && <div className="oc-material-alert" role="alert"><span>原BOM 生产状态或物料余量已变化 当前填写已保留</span><button className="oc-text-button" type="button" disabled={disabled || reading} onClick={onRebase}><RefreshCw size={13} aria-hidden="true" />按当前依据重新核对</button></div>}
    {values?.error && <p className="oc-error" role="alert">{values.error}</p>}{reading && <p className="oc-hint" role="status">正在核对原库位 批次与记录余量</p>}
    <fieldset disabled={disabled || reading}>
      {mode.kind === "consume" && <label>耗用来源<select aria-label="耗用来源" name="materialReservation" value={draft.reservation} onChange={event => change("reservation", event.target.value)}>
        <option value="">从未预留可用库存领用</option>{draft.reservation && !reservation && <option value={draft.reservation}>原预留当前不可用 请重新选择</option>}
        {reservations.map(row => <option key={row.entryId} value={row.entryId} disabled={!row.dimensionActive}>{row.warehouseName} / {row.locationName}{row.lotCode ? ` / ${row.lotCode}` : ""} · 原预留余量 {formatStockQuantity(row.remainingQuantity)} · {row.entryId.slice(-8)}{!row.dimensionActive ? " · 库位已停用" : ""}</option>)}
      </select>{reservation && <small>{reservation.warehouseName} / {reservation.locationName}{reservation.lotCode ? ` / 批次 ${reservation.lotCode}` : " / 无批次"} · 原预留余量 {formatStockQuantity(reservation.remainingQuantity)} {unitNames[reservation.unit]}</small>}
        {values?.reservations?.nextCursor && <button type="button" className="oc-text-button" onClick={() => void more("reservations")}>读取更多原预留</button>}</label>}
      {merchantInput && !draft.reservation && <label>库位与批次<select aria-label="库位与批次" name="materialDimension" value={draft.dimension} onChange={event => change("dimension", event.target.value)}>
        <option value="">选择原BOM物料的可用库位</option>{draft.dimension && !stocks.some(row => row.dimensionKey === draft.dimension) && <option value={draft.dimension}>原库位当前不可用 请重新选择</option>}
        {stocks.map(row => <option key={row.dimensionKey} value={row.dimensionKey}>{row.warehouseName} / {row.locationName}{row.lotCode ? ` / ${row.lotCode}` : " / 无批次"} · 可用 {formatStockQuantity(row.availableQuantity)} {unitNames[row.unit]}</option>)}
      </select>{stocks.filter(row => row.dimensionKey === draft.dimension).map(row => <small key={row.dimensionKey}>{row.warehouseName} / {row.locationName}{row.lotCode ? ` / 批次 ${row.lotCode}` : " / 无批次"} · 可用 {formatStockQuantity(row.availableQuantity)} {unitNames[row.unit]}</small>)}
        {values?.stock?.nextCursor && <button type="button" className="oc-text-button" onClick={() => void more("stock")}>读取更多库位批次</button>}
        {values?.checked && !stocks.length && <small>原物料当前没有可用库位 请先核对库存登记</small>}</label>}
      {original && <div className="oc-material-origin"><strong>原记录 {original.id}</strong><span>{originalDescription || "工厂手工报告"}</span>
        <span>{mode.kind === "release" ? "可释放未用预留" : "可更正余量"} {formatStockQuantity((mode.kind === "release" ? original.remainingReservedQuantity : original.correctableQuantity) ?? 0)} {unitNames[original.unit]}</span></div>}
      <div className="oc-material-form-grid">{mode.kind !== "release" && <label>{mode.kind === "factory_correction" ? "原报告减少数量" : "本次数量"}<input name="materialQuantity" inputMode="decimal" required autoComplete="off" maxLength={40} value={draft.quantity} onChange={event => change("quantity", event.target.value)} placeholder="最多9位小数" /></label>}
        <label>实际发生时间<input name="materialOccurredAt" type="datetime-local" required value={draft.occurredAt} onChange={event => change("occurredAt", event.target.value)} /></label></div>
      {mode.kind === "factory_report" && <label>工厂报告来源<input name="materialReport" required maxLength={200} value={draft.reportReference} onChange={event => change("reportReference", event.target.value)} placeholder="报告编号或可追溯的人工记录" /><small>登记工厂自备物料的手工报告 数量不计入商家库存 成本另行核对</small></label>}
      <label>原因或说明<textarea name="materialReason" maxLength={1000} rows={2} value={draft.reason} onChange={event => change("reason", event.target.value)} placeholder="更正 补记或超计划须说明原因 至少10个字" /></label>
      {["consume", "return", "factory_report"].includes(mode.kind) && <label className="oc-material-confirm"><input name="materialConfirmed" type="checkbox" checked={draft.confirmed} onChange={event => change("confirmed", event.target.checked)} />{mode.kind === "return" ? "已确认实物实际退回原库位与原批次" : mode.kind === "factory_report" ? "已核对工厂原报告与实际发生数量" : "已确认本次实际领用数量与原库位批次"}</label>}
      {mode.kind === "release" && <p className="oc-hint">释放原记录全部未用余量 此操作不登记实物退料</p>}
    </fieldset>
    {(error || validation) && <p className={error ? "oc-error" : "oc-hint"} role={error ? "alert" : undefined}>{error || validation}</p>}
    <div className="oc-actions"><button className="oc-button primary" disabled={disabled || reading || stale || !values?.checked || Boolean(validation)}><Check size={13} aria-hidden="true" />{materialKindNames[mode.kind]}</button>
      <button type="button" className="oc-text-button" disabled={disabled || reading} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />重新核对来源 保留填写</button></div>
  </form>;
}
function merge<T>(first: T[], second: T[], key: (row: T) => string) { return [...new Map([...first, ...second].map(row => [key(row), row])).values()]; }
