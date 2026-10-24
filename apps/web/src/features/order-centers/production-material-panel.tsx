"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Boxes, Check, ChevronDown, FileText, MinusCircle, PackagePlus, RefreshCw, RotateCcw, Undo2, X } from "lucide-react";
import { ProductionMaterialsWorkspaceSchema, type ProductionMaterialsWorkspace, type RecordProductionMaterial } from "@yummyai/contracts/order/material-execution";
import { MaterialCommandListSchema, MaterialCommandViewSchema, type MaterialCommandView } from "@yummyai/contracts/order/material-command";
import { compareStockQuantity, formatStockQuantity } from "@yummyai/contracts/inventory/quantity";
import { useErpAccess } from "../identity/erp-access";
import { Permission } from "@yummyai/authz/permissions";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { materialAuthorityChanged, materialRequest } from "./production-material-api";
import { materialKindNames, plannedMaterialLabel, type MaterialMode } from "./production-material-model";
import { ProductionMaterialForm } from "./production-material-form";
import { unitNames } from "../manual-operations/operation-types";
import { dateTime } from "./order-center-model";
import "./production-material-panel.css";

type Binding = { id: string; versionNumber: number; label: string };
type Loaded = { scope: string; view: ProductionMaterialsWorkspace | null; command: MaterialCommandView | null; checked: boolean; error: string; viewFailed: boolean };

export function ProductionMaterialPanel({ productionOrderId, bindings, currentBindingId, refresh, disabled, onEditsChanged, onBusyChange, onSaved }: {
  productionOrderId: string; bindings: Binding[]; currentBindingId: string | null; refresh: string; disabled: boolean;
  onEditsChanged(): void; onBusyChange(id: string, busy: boolean): void; onSaved(message: string): void;
}) {
  const access = useErpAccess(), identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const canRead = access.canTenant(Permission.OrderRead) && access.canTenant(Permission.InventoryRead);
  const [open, setOpen] = useState(false), [opened, setOpened] = useState(false), [binding, setBinding] = useState(currentBindingId ?? "");
  const scope = `${identity.authority}:${productionOrderId}:${binding}`;
  const [loaded, setLoaded] = useState<Loaded>({ scope: "", view: null, command: null, checked: false, error: "", viewFailed: false });
  const [reading, setReading] = useState(false), [working, setWorking] = useState(false), [reload, setReload] = useState(0), [notice, setNotice] = useState("");
  const [mode, setMode] = useState<MaterialMode | null>(null), [basis, setBasis] = useState<ProductionMaterialsWorkspace | null>(null), [resumeConfirmed, setResumeConfirmed] = useState(false);
  const transition = useOwnedViewTransition(), activeScope = useRef(scope), active = useRef(true), sending = useRef(false), ownSubmission = useRef<string | null>(null);
  activeScope.current = scope;
  const current = loaded.scope === scope ? loaded : null, view = current?.view, command = current?.command;
  const currentMode = basis?.bindingId === binding && basis.contextAuthority === view?.contextAuthority ? mode : null;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useLayoutEffect(() => { transition.cancel(); setMode(null); setBasis(null); setResumeConfirmed(false); setNotice(""); }, [scope, transition]);
  useEffect(() => { onBusyChange(productionOrderId, working || reading); return () => onBusyChange(productionOrderId, false); }, [working, reading, productionOrderId, onBusyChange]);
  useLayoutEffect(() => { onEditsChanged(); }, [mode, basis, command, onEditsChanged]);
  useEffect(() => { setResumeConfirmed(false); }, [command?.id]);
  useEffect(() => {
    const focus = () => { if (open && !sending.current) setReload(value => value + 1); };
    window.addEventListener("focus", focus); return () => window.removeEventListener("focus", focus);
  }, [open]);
  useEffect(() => {
    if (!opened || !canRead) return;
    const abort = new AbortController(), captured = scope;
    setReading(true);
    const query = binding ? "?bindingId=" + binding : "";
    void Promise.allSettled([materialRequest(`${productionOrderId}${query}`, ProductionMaterialsWorkspaceSchema, identity, undefined, abort.signal),
      materialRequest(`${productionOrderId}/commands`, MaterialCommandListSchema, identity, undefined, abort.signal)]).then(results => {
      if (abort.signal.aborted || activeScope.current !== captured) return;
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.some(materialAuthorityChanged)) {
        transition.cancel(); setMode(null); setBasis(null);
        setLoaded({ scope: captured, view: null, command: null, checked: false, viewFailed: true, error: "当前权限或原生产资料已变化 请重新核对" }); return;
      }
      const workspace = results[0].status === "fulfilled" ? results[0].value : null, commands = results[1].status === "fulfilled" ? results[1].value : null;
      if (workspace && (workspace.productionOrderId !== productionOrderId || binding && workspace.bindingId !== binding)) throw new Error("原制造依据不一致");
      if (!binding && workspace?.bindingId) setBinding(workspace.bindingId);
      setLoaded(previous => ({ scope: captured, view: workspace ?? (previous.scope === captured ? previous.view : null),
        command: commands ? commands.items[0] ?? null : previous.scope === captured ? previous.command : null,
        checked: Boolean(commands), viewFailed: !workspace, error: errors.map(message).join("；") }));
    }).catch(error => { if (!abort.signal.aborted && activeScope.current === captured) setLoaded(previous => ({ ...previous, scope: captured, checked: false, viewFailed: true, error: message(error) })); })
      .finally(() => { if (!abort.signal.aborted && activeScope.current === captured) setReading(false); });
    return () => abort.abort();
  }, [scope, opened, binding, productionOrderId, identity, refresh, reload, canRead, transition]);

  function begin(next: MaterialMode) {
    if (!view || reading || working || disabled || !current?.checked || command || !view.canWrite) return;
    if (mode && !window.confirm("切换物料操作会清空本表单未保存的填写 是否继续")) return;
    transition.change(() => { setMode(next); setBasis(view); setNotice(""); });
  }
  function denied(error: unknown) {
    if (materialAuthorityChanged(error)) { transition.cancel(); setMode(null); setBasis(null); setLoaded({ scope, view: null, command: null, checked: false, error: message(error), viewFailed: true }); }
    else setLoaded(previous => ({ ...previous, checked: false, error: message(error) }));
  }
  async function submit(input: RecordProductionMaterial) {
    if (sending.current || disabled || reading || !current?.checked || command) return;
    const captured = scope; sending.current = true; setWorking(true); ownSubmission.current = input.idempotencyKey;
    try {
      let result = await materialRequest(`${productionOrderId}/commands`, MaterialCommandViewSchema, identity, input);
      if (!active.current || activeScope.current !== captured) return;
      setLoaded(previous => ({ ...previous, command: result, checked: true, error: "" }));
      transition.change(() => { setMode(null); setBasis(null); });
      if (result.status === "prepared") result = await materialRequest(`${productionOrderId}/commands/${result.id}/execute`, MaterialCommandViewSchema, identity, {});
      if (!active.current || activeScope.current !== captured) return;
      setLoaded(previous => ({ ...previous, command: result, checked: true, error: "" }));
      if (result.status === "succeeded") { setNotice("本次实际物料记录已保存 请核对回执"); onSaved("本次物料记录与原回执已保存"); }
      setReload(value => value + 1);
    } catch (error) { if (active.current && activeScope.current === captured) { denied(error); setReload(value => value + 1); } }
    finally { sending.current = false; if (active.current) setWorking(false); }
  }
  async function act(action: "execute" | "cancel" | "acknowledge") {
    if (!command || sending.current || disabled || reading || !current?.checked) return;
    if (action === "execute" && (!resumeConfirmed || !view || view.bindingId !== command.bindingId || current.viewFailed)) return;
    const captured = scope; sending.current = true; setWorking(true);
    try {
      const result = await materialRequest(`${productionOrderId}/commands/${command.id}/${action}`, MaterialCommandViewSchema, identity, {});
      if (!active.current || activeScope.current !== captured) return;
      setLoaded(previous => ({ ...previous, command: result.acknowledged ? null : result, checked: true, error: "" })); setResumeConfirmed(false);
      if (result.acknowledged && ownSubmission.current === result.requestKey) { setMode(null); setBasis(null); ownSubmission.current = null; }
      if (result.status === "succeeded") { setNotice("已核对原物料记录 沿用同一回执"); onSaved("原物料提交结果已核对"); }
      setReload(value => value + 1);
    } catch (error) { if (active.current && activeScope.current === captured) denied(error); }
    finally { sending.current = false; if (active.current) setWorking(false); }
  }
  async function older() {
    if (!view?.nextCursor || reading || working || mode) return;
    const captured = scope; setReading(true);
    try {
      const page = await materialRequest(`${productionOrderId}?bindingId=${view.bindingId}&beforeId=${view.nextCursor}`, ProductionMaterialsWorkspaceSchema, identity);
      if (active.current && activeScope.current === captured && page.bindingId === view.bindingId) setLoaded(previous => ({ ...previous,
        view: { ...page, entries: [...new Map([...view.entries, ...page.entries].map(entry => [entry.id, entry])).values()] } }));
    } catch (error) { if (active.current && activeScope.current === captured) denied(error); }
    finally { if (active.current && activeScope.current === captured) setReading(false); }
  }
  const blocked = disabled || reading || working || !current?.checked || Boolean(command) || current?.viewFailed === true;
  return <section className="oc-material-panel" aria-label="原生产备料与实际耗用">
    <button type="button" className="oc-material-toggle" aria-expanded={open} aria-controls={`materials-${productionOrderId}`} onClick={() => transition.change(() => { setOpen(value => !value); setOpened(true); })}>
      <Boxes size={15} aria-hidden="true" /><strong>备料与实际耗用</strong><ChevronDown size={14} aria-hidden="true" className={open ? "is-open" : ""} />
    </button>
    <div id={`materials-${productionOrderId}`} className="oc-material-collapse" data-open={open} aria-hidden={!open} inert={!open}><div>
      {opened && <div className="oc-material-body" aria-busy={reading || working}>
        {!canRead ? <p className="oc-hint">读取本生产物料需要订单和库存的租户范围权限</p> : <>
          <div className="oc-material-tools"><label>制造依据<select aria-label="物料制造依据" value={binding} disabled={working || Boolean(mode)} onChange={event => setBinding(event.target.value)}>
            {!bindings.length && <option value={binding}>{binding ? "原生产固定制造依据" : "历史制造依据未固定"}</option>}{bindings.map(item => <option key={item.id} value={item.id}>生产 V{item.versionNumber} · {item.label}</option>)}
          </select></label><button className="oc-text-button" type="button" disabled={working || reading} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />重新核对物料</button></div>
          {reading && <p role="status" className="oc-hint">正在核对原BOM 库存与待确认提交</p>}
          {current?.error && <p role="alert" className="oc-error">{current.error}</p>}{notice && <p role="status" className="oc-notice">{notice}</p>}
          {view?.diagnostics.map(text => <p className="oc-hint" key={text}>{text}</p>)}
          {view && !view.currentBinding && view.bindingId && <p className="oc-hint">正在查看历史制造依据 已有记录可按原事实释放或更正</p>}
          {command && <section className="oc-material-command" aria-label="待确认物料提交">
            <strong>{({ prepared: "原物料提交待核对", succeeded: "实际物料已记录", rejected: "原提交需重新核对", cancelled: "原物料提交已取消", expired: "原物料提交已过期" })[command.status]}</strong>
            <p className="oc-hint">原请求 {command.requestKey} · {dateTime(command.createdAt)}</p>
            {command.input && <p>{materialKindNames[command.input.kind]} · {command.input.materialCode}{"quantity" in command.input ? ` · ${formatStockQuantity(command.input.quantity)}` : " · 原未用余量"}</p>}
            {command.input?.reason && <p className="oc-material-reason">{command.input.reason}</p>}
            {command.receipt && <p className="oc-notice">{materialKindNames[command.receipt.kind]} {formatStockQuantity(command.receipt.quantity)} {unitNames[command.receipt.unit]} · 回执 {command.receipt.id}</p>}
            {command.status === "prepared" && <p className="oc-hint">原填写已保存 执行或取消前请核对 读取到待核对状态不代表另一请求尚未提交</p>}
            {command.errorCode && <p className="oc-error">原生产状态 库存或填写依据已变化 请核对本次结果后重新填写</p>}
            {command.canExecute && command.bindingId !== view?.bindingId && <button type="button" className="oc-text-button" disabled={working} onClick={() => { setBinding(command.bindingId); setMode(null); setBasis(null); }}>查看原提交制造依据</button>}
            {command.canExecute && command.bindingId === view?.bindingId && <label className="oc-check"><input type="checkbox" checked={resumeConfirmed} onChange={event => setResumeConfirmed(event.target.checked)} disabled={working || reading} />已核对原填写与实际发生情况</label>}
            <div className="oc-actions">
              {command.canExecute && <button type="button" className="oc-button" disabled={disabled || working || reading || !current?.checked || !resumeConfirmed || command.bindingId !== view?.bindingId || current.viewFailed} onClick={() => void act("execute")}><RotateCcw size={13} aria-hidden="true" />按原填写记录</button>}
              {command.canCancel && <button type="button" className="oc-button" disabled={disabled || working || reading || !current?.checked} onClick={() => void act("cancel")}><X size={13} aria-hidden="true" />取消本次待确认记录</button>}
              {command.status !== "prepared" && <button type="button" className="oc-button" disabled={disabled || working || reading || !current?.checked} onClick={() => void act("acknowledge")}><Check size={13} aria-hidden="true" />已核对本次结果</button>}
            </div>
          </section>}
          {view?.lines.map(line => <section key={line.code} className="oc-material-line" aria-label={`物料 ${line.name}`}>
            <header><div><strong>{line.name}</strong><small>{line.code} · {line.responsibility === "merchant" ? "商家供料" : "工厂自备 · 手工报告"}</small></div></header>
            <dl className="oc-material-numbers"><div><dt>原计划</dt><dd>{plannedMaterialLabel(line.plannedNumerator, line.plannedDenominator, line.unit)}</dd></div>
              <div><dt>预留待用</dt><dd>{formatStockQuantity(line.outstandingReservedQuantity)} {unitNames[line.unit]}</dd></div><div><dt>{line.responsibility === "merchant" ? "实际净耗用" : "报告净数量"}</dt><dd>{formatStockQuantity(line.actualNetQuantity)} {unitNames[line.unit]}</dd></div></dl>
            {view.canWrite && view.currentBinding && <div className="oc-actions">{line.responsibility === "merchant" ? <>
              <button type="button" className="oc-button" disabled={blocked || ["completed", "cancel_requested", "cancelled", "failed"].includes(view.productionStatus)} onClick={() => begin({ kind: "reserve", materialCode: line.code })}><PackagePlus size={13} aria-hidden="true" />备料预留</button>
              <button type="button" className="oc-button" disabled={blocked} onClick={() => begin({ kind: "consume", materialCode: line.code })}><MinusCircle size={13} aria-hidden="true" />记录实际耗用</button>
            </> : <button type="button" className="oc-button" disabled={blocked} onClick={() => begin({ kind: "factory_report", materialCode: line.code })}><FileText size={13} aria-hidden="true" />登记工厂报告</button>}</div>}
          </section>)}
          {currentMode && basis && <div hidden={Boolean(command)} inert={Boolean(command)}><ProductionMaterialForm key={`${currentMode.kind}:${currentMode.materialCode}:${currentMode.originalEntryId ?? ""}:${currentMode.reservationEntryId ?? ""}`}
            basis={basis} current={view ?? null} mode={currentMode} disabled={blocked} refresh={`${refresh}:${reload}`} onEditsChanged={onEditsChanged} onSubmit={submit} onDenied={denied}
            onClose={() => { if (window.confirm("放弃本表单未保存的填写 是否继续")) transition.change(() => { setMode(null); setBasis(null); }); }}
            onRebase={() => { if (view && window.confirm("保留数量与说明并按当前依据重新核对 需要再次确认实际发生情况")) setBasis(view); }} /></div>}
          {view && <section className="oc-material-history" aria-label="实际物料历史"><h4>物料记录</h4>{!view.entries.length && <p className="oc-hint">尚未登记实际物料记录 原计划不代表已发生耗用</p>}
            {view.entries.map(entry => <article key={entry.id} className="oc-material-entry"><strong>{materialKindNames[entry.kind]} · {formatStockQuantity(entry.quantity)} {unitNames[entry.unit]}</strong>
              <small>{entry.materialCode} · {dateTime(entry.occurredAt)}{entry.warehouseName ? ` · ${entry.warehouseName} / ${entry.locationName}` : ""}{entry.lotCode ? ` · 批次 ${entry.lotCode}` : ""}</small>
              {entry.reason && <p className="oc-material-reason">{entry.reason}</p>}{entry.reportReference && <p className="oc-hint">工厂手工报告来源 {entry.reportReference}</p>}
              {view.canWrite && <div className="oc-actions">{entry.kind === "reserve" && compareStockQuantity(entry.remainingReservedQuantity ?? 0, 0) > 0 && <button className="oc-text-button" type="button" disabled={blocked} onClick={() => begin({ kind: "release", materialCode: entry.materialCode, originalEntryId: entry.id })}>释放原未用余量 {formatStockQuantity(entry.remainingReservedQuantity!)}</button>}
                {(entry.kind === "consume" || entry.kind === "factory_report") && compareStockQuantity(entry.correctableQuantity ?? 0, 0) > 0 && <button className="oc-text-button" type="button" disabled={blocked} onClick={() => begin({ kind: entry.kind === "consume" ? "return" : "factory_correction", materialCode: entry.materialCode, originalEntryId: entry.id })}><Undo2 size={12} aria-hidden="true" />{entry.kind === "consume" ? "登记原耗用实物退料" : "更正原报告"}</button>}</div>}
            </article>)}{view.nextCursor && <button type="button" className="oc-text-button" disabled={reading || working || Boolean(mode)} onClick={() => void older()}>读取更早物料记录</button>}
          </section>}
        </>}
      </div>}
    </div></div>
  </section>;
}
const message = (error: unknown) => error instanceof Error ? error.message : "物料记录暂时无法核对";
