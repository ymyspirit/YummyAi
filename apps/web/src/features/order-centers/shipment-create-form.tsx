"use client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { Box, ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_NATIVE_V4_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-native-v4";
import { ShipmentCreateWorkspaceSchema, type ShipmentCreateWorkspace } from "@yummyai/contracts/order/shipment";
import { useErpAccess } from "../identity/erp-access";
import { useAgentFulfillmentProposalHandoff, useAgentFulfillmentProposalInput } from "../ai-tasks/agent-fulfillment-proposal-handoff";
import { centerRequest, OrderCenterRequestError } from "./order-center-model";
import { FulfillmentCommandPrepareButton } from "./fulfillment-command-recovery";
import { ShipmentProductionFields, readShipmentProductionAllocations } from "./shipment-production-fields";
import {
  buildShipmentCreateContent, createShipmentCreateDraft, newShipmentCreatePackage, shipmentCreateBasisKey,
  shipmentCreateDraftIssues, shipmentCreatePackagePrefix, shipmentCreatePackingLines, shipmentCreateSelectionKey,
  ShipmentCreateValidationError, type ShipmentCreateDraft, type ShipmentCreatePackageDraft, type ShipmentCreateSuggestion,
} from "./shipment-create-model";
import "./shipment-create.css";

type Props = {
  orderId: string; lineId: string; refresh: string; disabled: boolean;
  onReading(value: boolean): void; onEditsChanged(): void;
  onSubmit(event: FormEvent<HTMLFormElement>, path: string, payload: Record<string, unknown>, success: string): Promise<void>;
};
type Identity = { authority: string | null; scope: string | null; orderId: string; lineId: string; purged: boolean; epoch: number };

/** The route line anchors the existing drawer; it never selects a packing line. */
export function ShipmentCreateForm(props: Props) {
  const access = useErpAccess(), handoff = useAgentFulfillmentProposalHandoff();
  const suggestion = useAgentFulfillmentProposalInput("shipment_create", props.orderId);
  const live = useRef<Identity>({ authority: access.authority, scope: access.preferenceScope, orderId: props.orderId, lineId: props.lineId, purged: false, epoch: 0 });
  live.current = { ...live.current, authority: access.authority, scope: access.preferenceScope, orderId: props.orderId, lineId: props.lineId };
  const reads = useRef(new Set<AbortController>()), [purged, setPurged] = useState(false);
  useLayoutEffect(() => {
    const clear = () => {
      live.current.purged = true; live.current.epoch++; for (const request of reads.current) request.abort(); reads.current.clear();
      setPurged(true); props.onReading(false);
    };
    const controllers = reads.current;
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.addEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, clear);
    return () => {
      live.current.epoch++; for (const request of controllers) request.abort(); controllers.clear();
      window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, clear);
    };
  }, [props.onReading]);
  if (purged || live.current.purged) return <section className="sc-create" aria-label="按包裹创建发货草稿"><p role="status">当前填写与装箱依据已清除 请从原订单重新进入核对</p></section>;
  return <ShipmentCreateContent key={JSON.stringify([access.authority, access.preferenceScope, props.orderId, props.lineId, handoff?.formKey])}
    {...props} identity={live} reads={reads} suggestion={suggestion} />;
}
function ShipmentCreateContent({ orderId, lineId, refresh, disabled, onReading, onEditsChanged, onSubmit, identity, reads, suggestion }: Props & {
  identity: RefObject<Identity>; reads: RefObject<Set<AbortController>>; suggestion: ShipmentCreateSuggestion | null;
}) {
  const access = useErpAccess(), handoff = useAgentFulfillmentProposalHandoff(), authority = access.authority, scope = access.preferenceScope;
  const canRead = !!authority && access.canTenant(Permission.OrderRead) && access.canTenant(Permission.OrderPiiRead);
  const canWrite = canRead && access.canTenant(Permission.OrderWrite);
  const [open, setOpen] = useState(!!suggestion), [reload, setReload] = useState(0), [reading, setReading] = useState(false),
    [workspace, setWorkspace] = useState<ShipmentCreateWorkspace | null>(null), [basis, setBasis] = useState<ShipmentCreateWorkspace | null>(null),
    [draft, setDraft] = useState<ShipmentCreateDraft | null>(() => createShipmentCreateDraft(suggestion)), [rechecked, setRechecked] = useState(0),
    [error, setError] = useState(""), [readFailed, setReadFailed] = useState(false), [denied, setDenied] = useState(false);
  const [removing, setRemoving] = useState<string[]>([]), removalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const alive = useRef(true), sequence = useRef(0), active = useRef<AbortController | null>(null), proof = useRef(false), submitting = useRef(false), nextKey = useRef(1_000);
  const live = useRef({ canRead, canWrite, disabled, handoffBlocked: !!handoff?.blocked });
  live.current = { canRead, canWrite, disabled, handoffBlocked: !!handoff?.blocked };
  const notified = useRef({ onReading, onEditsChanged }); notified.current = { onReading, onEditsChanged };
  const valid = (epoch: number) => alive.current && !identity.current.purged && identity.current.epoch === epoch && identity.current.authority === authority
    && identity.current.scope === scope && identity.current.orderId === orderId && identity.current.lineId === lineId;
  useLayoutEffect(() => {
    alive.current = true;
    const timers = removalTimers.current;
    return () => { alive.current = false; sequence.current++; proof.current = false; active.current?.abort();
      for (const timer of timers.values()) clearTimeout(timer); timers.clear(); notified.current.onReading(false); };
  }, []);
  useEffect(() => {
    if (!open || !canRead || !authority || identity.current.purged) return;
    const epoch = identity.current.epoch, request = ++sequence.current, abort = new AbortController(), controllers = reads.current;
    active.current?.abort(); active.current = abort; controllers.add(abort); proof.current = false;
    setReading(true); setReadFailed(false); setError(""); notified.current.onReading(true);
    const current = () => valid(epoch) && sequence.current === request && !abort.signal.aborted && live.current.canRead;
    void centerRequest(`orders/${orderId}/shipment-create-workspace`, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]), authority).then(raw => {
      if (!current()) return;
      const value = ShipmentCreateWorkspaceSchema.parse(raw);
      if (!current()) return;
      if (value.orderId !== orderId || value.contextAuthority !== authority || !value.lines.some(line => line.lineId === lineId))
        throw new OrderCenterRequestError(409, "当前本单装箱依据无法核对 请重新进入原订单", "authority_changed");
      setWorkspace(value); setBasis(previous => previous ?? value); setDraft(previous => previous ?? createShipmentCreateDraft(suggestion));
      proof.current = true; setDenied(false);
    }).catch(cause => {
      if (!current()) return;
      proof.current = false; setReadFailed(true);
      if (cause instanceof OrderCenterRequestError && ([401, 403, 404].includes(cause.status) || cause.status === 409 && cause.code === "authority_changed")) {
        setWorkspace(null); setBasis(null); setDraft(null); setDenied(true);
        setError("当前无法读取本单装箱依据 原填写与本人确认已清除 请核对当前权限后重新读取");
      } else setError("装箱依据暂时无法读取 当前填写保留 新提交暂停 请重新只读核对");
    }).finally(() => {
      controllers.delete(abort);
      if (valid(epoch) && sequence.current === request) { setReading(false); notified.current.onReading(false); }
    });
    return () => { sequence.current++; proof.current = false; abort.abort(); controllers.delete(abort); notified.current.onReading(false); };
    // Draft edits and a new object with the same pinned proposal must not restart this read.
  }, [open, canRead, authority, scope, orderId, lineId, refresh, reload, identity, reads]);
  useLayoutEffect(() => { notified.current.onEditsChanged(); }, [draft, rechecked]);
  const stale = !!workspace && !!basis && shipmentCreateBasisKey(workspace) !== shipmentCreateBasisKey(basis);
  const proposalSourceChanged = !!handoff && !!workspace && handoff.suggestion?.source.expectedSequence !== workspace.orderSequence;
  const unsupportedAsset = !!suggestion?.packages?.some(pkg => pkg.labelAssetId !== null && pkg.labelAssetId !== undefined);
  const locked = disabled || !canWrite || reading || readFailed || denied || !proof.current || !workspace?.canCreate || stale || removing.length > 0
    || !!handoff && (handoff.blocked || !suggestion || proposalSourceChanged) || unsupportedAsset;
  const problems = draft && workspace ? shipmentCreateDraftIssues(draft, workspace) : [];
  function changePackage(key: string, patch: Partial<ShipmentCreatePackageDraft>) {
    setDraft(previous => previous && ({ ...previous, packages: previous.packages.map(pkg => pkg.key === key ? { ...pkg, ...patch } : pkg) }));
  }
  function removeEntry(key: string, commit: (previous: ShipmentCreateDraft) => ShipmentCreateDraft) {
    if (locked || removalTimers.current.has(key) || identity.current.purged) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setDraft(previous => previous && commit(previous)); return; }
    const epoch = identity.current.epoch;
    setRemoving(previous => [...previous, key]);
    removalTimers.current.set(key, setTimeout(() => {
      removalTimers.current.delete(key);
      if (!valid(epoch)) return;
      setDraft(previous => previous && commit(previous)); setRemoving(previous => previous.filter(value => value !== key));
    }, 160));
  }
  function closeOrOpen(value: boolean) {
    if (identity.current.purged) return;
    if (!value) { sequence.current++; proof.current = false; active.current?.abort(); setReading(false); notified.current.onReading(false); }
    setOpen(value);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const epoch = identity.current.epoch;
    if (locked || submitting.current || !draft || !workspace || !basis || !valid(epoch) || !live.current.canWrite || live.current.disabled || live.current.handoffBlocked) return;
    const prepareOnly = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-agent-fulfillment-prepare") === "true";
    if (handoff && !prepareOnly) return;
    submitting.current = true; setError("");
    try {
      const form = new FormData(event.currentTarget), payload = buildShipmentCreateContent(draft, workspace, (key, id, quantity) =>
        readShipmentProductionAllocations(form, id, quantity, shipmentCreatePackagePrefix(key)));
      if (!valid(epoch) || !proof.current || live.current.disabled || !live.current.canWrite || live.current.handoffBlocked) return;
      await onSubmit(event, `lines/${lineId}/shipments`, payload, "本次包裹草稿已保存 尚需核对包裹并凭实际记录交运");
    } catch (cause) {
      if (valid(epoch)) setError(cause instanceof ShipmentCreateValidationError ? cause.message : "请完整核对每个包裹的商品 数量 生产来源和本人实物确认");
    } finally { submitting.current = false; }
  }
  const field = (pkg: ShipmentCreatePackageDraft, key: keyof Pick<ShipmentCreatePackageDraft, "packageReferenceId" | "trackingNumber" | "carrierCode" | "carrierName" | "carrierService" | "externalLabelId" | "labelCostMinor" | "labelCurrency" | "weightGrams" | "length" | "width" | "height">,
    title: string, options: { required?: boolean; maxLength?: number; pattern?: string; numeric?: boolean; min?: number } = {}) => <label>{title}<input
      name={shipmentCreatePackagePrefix(pkg.key) + key} required={options.required} maxLength={options.maxLength} pattern={options.pattern}
      type={options.numeric ? "number" : "text"} min={options.numeric ? options.min ?? 1 : undefined} step={options.numeric ? 1 : undefined}
      value={pkg[key]} onChange={event => changePackage(pkg.key, { [key]: event.target.value })} /></label>;
  return <details className="sc-create" open={open} onToggle={event => closeOrOpen(event.currentTarget.open)}>
    <summary><Box size={16} /><span>按包裹分配本次发货</span><ChevronDown size={15} className="sc-chevron" /></summary>
    <div className="sc-content" aria-busy={reading}>
      <p className="oc-hint">可将本单部分商品分装多个包裹 只建立待审核草稿 不代表已交运或平台已确认 整单单包裹流程仍在下方保留</p>
      {!canRead ? <p role="status" className="oc-notice">当前无法读取本单商品及生产来源 请核对订单和订单私文读取权限</p> : <>
        <button type="button" className="oc-text-button" disabled={reading || disabled} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />重新读取本单装箱依据</button>
        {reading && <p role="status">正在核对本单全部商品及装箱来源 当前填写保留 暂停提交</p>}
        {error && <p className="oc-error" role="alert">{error}</p>}
        {workspace && <p className="oc-hint">{workspace.orderNumber} · {workspace.lines.length} 项原商品 · 当前事件序号 {workspace.orderSequence}</p>}
        {workspace?.blockers.map(reason => <p className="oc-error" key={reason}>{reason}</p>)}
        {stale && <div className="oc-notice" role="alert"><p>订单数量 生产版本 质检或可发数量已变化 当前填写保留 请重新按实物核对 不自动改用新来源</p>
          <button type="button" className="oc-button" disabled={disabled || reading || !canWrite || proposalSourceChanged} onClick={() => {
            if (!workspace || !proof.current || identity.current.purged) return; setBasis(workspace); setRechecked(value => value + 1); setError("");
          }}>核对最新装箱依据</button></div>}
        {proposalSourceChanged && <p className="oc-error" role="alert">原提案的订单依据已变化 请返回原任务核对 本页不把今天的新来源当作原提案依据</p>}
        {unsupportedAsset && <p className="oc-error" role="alert">原建议包含面单资产 此处没有受权面单选择器 请先通过原资产流程核对 该资产未被丢弃 当前不能准备</p>}
        {draft && basis && workspace && !denied && <form aria-label="按包裹创建发货草稿" data-order-action="shipment-create" onSubmit={event => void submit(event)}>
          <fieldset className="sc-fields" disabled={locked}>
            <legend>本次发货信息</legend>
            <div className="sc-grid">
              <label>计划发货时间<input name="shipment-create-shipDate" type="datetime-local" step="0.001" required value={draft.shipDate} onChange={event => setDraft({ ...draft, shipDate: event.target.value })} /></label>
              <label>发出国代码<input name="shipment-create-country" pattern="[A-Z]{2}" maxLength={2} placeholder="例如 CN 或 US" required value={draft.shipFromCountryCode} onChange={event => setDraft({ ...draft, shipFromCountryCode: event.target.value })} /></label>
              <label>预计送达时间 选填<input name="shipment-create-estimated" type="datetime-local" step="0.001" value={draft.estimatedDeliveryAt} onChange={event => setDraft({ ...draft, estimatedDeliveryAt: event.target.value })} /></label>
              <label>承诺送达时间 选填<input name="shipment-create-promised" type="datetime-local" step="0.001" value={draft.promisedDeliveryAt} onChange={event => setDraft({ ...draft, promisedDeliveryAt: event.target.value })} /></label>
            </div><p className="oc-hint">时间按本机时区填写 预计和承诺送达不能早于发货时间</p>
            <ul className="sc-totals" aria-label="本次商品装箱合计">{workspace.lines.flatMap(item => {
              const total = draft.packages.flatMap(pkg => pkg.lines).filter(line => line.orderLineId === item.lineId)
                .reduce((sum, line) => sum + (Number.isSafeInteger(Number(line.quantity)) && Number(line.quantity) > 0 ? Number(line.quantity) : 0), 0);
              return total ? [<li key={item.lineId}><span>{item.title}</span><strong className={total > item.quantity ? "oc-error" : ""}>本次 {total} / 原数量 {item.quantity} 件</strong></li>] : [];
            })}</ul>
            {draft.packages.map((pkg, index) => {
              const lines = shipmentCreatePackingLines(pkg, workspace), uniqueLines = lines.filter((line, row) => lines.findIndex(other => other.lineId === line.lineId) === row);
              const prefix = shipmentCreatePackagePrefix(pkg.key);
              return <section className="sc-package" aria-label={"本次包裹 " + (index + 1)} key={pkg.key} data-leaving={removing.includes(pkg.key) || undefined}>
                <header><h4><Box size={15} />包裹 {index + 1}</h4><button type="button" className="oc-text-button" aria-label={"删除包裹 " + (index + 1)} disabled={draft.packages.length === 1}
                  onClick={() => removeEntry(pkg.key, previous => ({ ...previous, packages: previous.packages.filter(row => row.key !== pkg.key) }))}><Trash2 size={14} />删除包裹</button></header>
                <div className="sc-grid">
                  {field(pkg, "packageReferenceId", "包裹参考号", { required: true, maxLength: 160 })}
                  {field(pkg, "trackingNumber", "物流单号", { required: true, maxLength: 200 })}
                  {field(pkg, "carrierCode", "承运商代码", { required: true, maxLength: 80, pattern: "[A-Z0-9_:\\-]+" })}
                  {field(pkg, "carrierName", "承运商名称", { required: true, maxLength: 160 })}
                  {field(pkg, "carrierService", "物流服务", { required: true, maxLength: 160 })}
                </div>
                <div className="sc-lines">{pkg.lines.map((line, row) => {
                  const original = workspace.lines.find(item => item.lineId === line.orderLineId);
                  return <div className="sc-line" key={line.key} data-leaving={removing.includes(line.key) || undefined}>
                    <label>商品 {row + 1}<select name={prefix + line.key + "-line"} aria-label={`包裹 ${index + 1} 商品 ${row + 1}`} required value={line.orderLineId}
                      onChange={event => changePackage(pkg.key, { lines: pkg.lines.map(item => item.key === line.key ? { ...item, orderLineId: event.target.value, quantity: "", productionAllocations: undefined } : item) })}>
                      <option value="">选择本单商品</option>{line.orderLineId && !original && <option value={line.orderLineId}>原建议商品当前不可核对 请重新选择本单商品</option>}
                      {workspace.lines.map(item => <option value={item.lineId} key={item.lineId}>{item.title} · 原数量 {item.quantity}</option>)}
                    </select></label>
                    <label>装箱数量<input name={prefix + line.key + "-quantity"} aria-label={`包裹 ${index + 1} 商品 ${row + 1} 装箱数量`} type="number" min="1" max={original?.quantity ?? 100_000} step="1" required
                      value={line.quantity} onChange={event => changePackage(pkg.key, { lines: pkg.lines.map(item => item.key === line.key ? { ...item, quantity: event.target.value } : item) })} /></label>
                    <button type="button" className="oc-text-button" aria-label={`包裹 ${index + 1} 删除商品 ${row + 1}`} disabled={pkg.lines.length === 1}
                      onClick={() => removeEntry(line.key, previous => ({ ...previous, packages: previous.packages.map(item => item.key === pkg.key ? { ...item, lines: item.lines.filter(row => row.key !== line.key) } : item) }))}><Trash2 size={14} />删除商品</button>
                  </div>;
                })}</div>
                <button type="button" className="oc-text-button" aria-label={`包裹 ${index + 1} 新增商品`} disabled={pkg.lines.length >= workspace.lines.length}
                  onClick={() => changePackage(pkg.key, { lines: [...pkg.lines, { key: "line-" + nextKey.current++, orderLineId: "", quantity: "" }] })}><Plus size={14} />新增商品</button>
                {uniqueLines.length ? <ShipmentProductionFields sources={workspace.sources} lines={uniqueLines} disabled={locked} prefix={prefix} onEditsChanged={onEditsChanged}
                  resetKey={JSON.stringify([handoff?.formKey ?? "original", pkg.key, shipmentCreateSelectionKey(pkg), rechecked])}
                  initialAllocations={handoff ? pkg.lines.map(line => ({ lineId: line.orderLineId, productionAllocations: line.productionAllocations })) : undefined} />
                  : <p className="oc-hint">先选择本单商品和正整数装箱数量 再按实物分配生产来源</p>}
                <details className="sc-optional"><summary>补充面单 费用与包裹尺寸</summary><div className="sc-grid">
                  {field(pkg, "externalLabelId", "外部面单标识 选填", { maxLength: 300 })}
                  {field(pkg, "labelCostMinor", "面单费用 最小货币单位", { numeric: true, min: 0 })}
                  {field(pkg, "labelCurrency", "费用币种", { maxLength: 3, pattern: "[A-Z]{3}" })}
                  {field(pkg, "weightGrams", "重量 克", { numeric: true })}
                  {field(pkg, "length", "长 毫米", { numeric: true })}{field(pkg, "width", "宽 毫米", { numeric: true })}{field(pkg, "height", "高 毫米", { numeric: true })}
                </div><p className="oc-hint">费用与币种须一起填写 尺寸须填齐长宽高 面单资产需通过原受权资产流程核对 此处不接受手填资产编号</p></details>
              </section>;
            })}
            <button type="button" className="oc-button" disabled={draft.packages.length >= 100} onClick={() => setDraft({ ...draft, packages: [...draft.packages, newShipmentCreatePackage("package-" + nextKey.current++)] })}><Plus size={14} />新增包裹</button>
            {!!problems.length && <ul className="sc-problems" aria-label="本次装箱待补齐事项">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
            <div className="oc-action-row"><button type="submit" className="oc-button primary" disabled={!!handoff || problems.length > 0}>保存本次包裹草稿</button>
              <FulfillmentCommandPrepareButton disabled={locked || problems.length > 0} /></div>
            <p className="oc-hint">各包裹商品合计不得超过订单原数量 同一生产来源跨包裹合计不得超过当前可发数量 保存后仍须原包裹审核与实际交运</p>
          </fieldset>
        </form>}
      </>}
    </div>
  </details>;
}
