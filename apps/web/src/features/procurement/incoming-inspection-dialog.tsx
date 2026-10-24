"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ClipboardCheck, PackageCheck, RefreshCw, RotateCcw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { IncomingWorkspaceViewSchema, IncomingLineWorkspaceViewSchema, type IncomingWorkspaceView, type IncomingArrivalLineView } from "@yummyai/contracts/procurement/incoming";
import { IncomingCommandViewSchema, IncomingOrderCommandsSchema, type IncomingCommandView, type IncomingCommandKind, type PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { compareStockQuantity, formatStockQuantity, subtractStockQuantity, sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { RecordDialog } from "../manual-operations/record-form";
import { AgentOperationHandoff } from "../ai-tasks/agent-operation-handoff";
import { unitNames } from "../manual-operations/operation-types";
import { IncomingRequestError, incomingDenied, incomingRequest } from "./incoming-api";
import { IncomingOperationForm, incomingActionNames, incomingStatusNames, type IncomingDraft } from "./incoming-operation-form";
import { IncomingOriginalSummary, incomingTime } from "./incoming-original-summary";
import "./incoming-inspection.css";

type Loaded = { scope: string; view: IncomingWorkspaceView; pending: IncomingCommandView[]; nextCursor: string | null; extraLine: IncomingArrivalLineView | null };
export function IncomingInspectionDialog({ purchaseOrderId, onClose, onChanged, onLegacyReceipt }: {
  purchaseOrderId: string; onClose(): void; onChanged(): void; onLegacyReceipt(): void;
}) {
  const access = useErpAccess(), identity = useMemo(() => ({ authority: access.authority, localDevelopment: access.localDevelopment }), [access.authority, access.localDevelopment]);
  const scope = `${identity.authority}:${purchaseOrderId}`, canRead = access.can(Permission.ProcurementRead) && access.can(Permission.InventoryRead);
  const [loaded, setLoaded] = useState<Loaded | null>(null), [draft, setDraft] = useState<IncomingDraft | null>(null), [command, setCommand] = useState<IncomingCommandView | null>(null);
  const [reading, setReading] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState(""), [denied, setDenied] = useState(false), [unconfirmed, setUnconfirmed] = useState(false), [closing, setClosing] = useState(false);
  const transition = useOwnedViewTransition(), epoch = useRef(0), readToken = useRef(0), mounted = useRef(true), busy = useRef(false), activeScope = useRef(scope);
  const draftRef = useRef(draft), commandRef = useRef(command), attempted = useRef<PrepareIncomingCommand | null>(null), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeScope.current = scope; draftRef.current = draft; commandRef.current = command;
  const current = loaded?.scope === scope ? loaded : null;
  const valid = (captured: number, capturedScope: string) => mounted.current && epoch.current === captured && activeScope.current === capturedScope;
  const revoke = useCallback(() => {
    epoch.current++; readToken.current++; transition.cancel(); busy.current = false; attempted.current = null;
    setLoaded(null); setDraft(null); setCommand(null); setReading(false); setWorking(false); setUnconfirmed(false); setDenied(true);
    setError("当前访问权限或会话已变化 已清除本页私有填写 请重新读取");
  }, [transition]);
  const reload = useCallback(async (before?: string, allowBusy = false) => {
    if (busy.current && !allowBusy) return;
    const captured = epoch.current, capturedScope = scope, token = ++readToken.current;
    setReading(true);
    try {
      const editing = draftRef.current, selected = commandRef.current;
      const extraId = editing?.line?.id ?? (selected && !["publish_standard", "record_arrival"].includes(selected.kind) ? selected.targetId : undefined);
      const [view, originals, extra] = await Promise.all([
        incomingRequest(`orders/${purchaseOrderId}`, IncomingWorkspaceViewSchema, identity),
        incomingRequest(`orders/${purchaseOrderId}/commands${before ? "?before=" + before : ""}`, IncomingOrderCommandsSchema, identity),
        extraId ? incomingRequest(`lines/${extraId}`, IncomingLineWorkspaceViewSchema, identity) : Promise.resolve(null),
      ]);
      if (!mounted.current || epoch.current !== captured || activeScope.current !== capturedScope || readToken.current !== token) return;
      if (view.purchaseOrderId !== purchaseOrderId || originals.purchaseOrderId !== purchaseOrderId) throw new Error("Original purchase differs");
      const pending = originals.items;
      setLoaded(previous => ({ scope: capturedScope, view, extraLine: extra?.line ?? null,
        pending: before && previous?.scope === capturedScope ? [...new Map([...previous.pending, ...pending].map(row => [row.id, row])).values()] : pending, nextCursor: originals.nextCursor }));
      setError(""); setDenied(false);
      if (selected) {
        const actual = await incomingRequest(`commands/${selected.id}`, IncomingCommandViewSchema, identity);
        if (!mounted.current || epoch.current !== captured || activeScope.current !== capturedScope || readToken.current !== token) return;
        setCommand(actual); setUnconfirmed(false);
      } else if (attempted.current) {
        const original = attempted.current;
        const recovered = pending.find(row => row.original?.input.idempotencyKey === original.input.idempotencyKey && row.kind === original.kind && row.targetId === original.targetId);
        if (recovered) transition.change(() => { setCommand(recovered); setDraft(null); setUnconfirmed(false); });
      }
    } catch (failure) {
      if (mounted.current && epoch.current === captured && activeScope.current === capturedScope && readToken.current === token) {
        if (incomingDenied(failure)) revoke(); else setError(failure instanceof Error ? failure.message : "暂时无法读取来料记录 你的填写会保留");
      }
    } finally { if (mounted.current && epoch.current === captured && activeScope.current === capturedScope && readToken.current === token) setReading(false); }
  }, [scope, purchaseOrderId, identity, transition, revoke]);
  useLayoutEffect(() => {
    epoch.current++; readToken.current++; transition.cancel(); attempted.current = null; busy.current = false;
    setLoaded(null); setDraft(null); setCommand(null); setDenied(false); setError(""); setWorking(false); setReading(false); setUnconfirmed(false);
  }, [scope, transition]);
  useEffect(() => { mounted.current = true; if (canRead) void reload(); return () => { mounted.current = false; epoch.current++; readToken.current++; if (closeTimer.current) clearTimeout(closeTimer.current); }; }, [reload, canRead]);
  useEffect(() => {
    const check = () => { if (document.visibilityState === "visible" && canRead) void reload(); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [reload, canRead]);
  const leave = () => {
    if (working || busy.current || closing) return;
    setClosing(true); readToken.current++; transition.cancel();
    closeTimer.current = setTimeout(onClose, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
  };
  function begin(kind: IncomingCommandKind, line?: IncomingArrivalLineView, postingId?: string) {
    if (!current || reading || working || closing || error) return;
    const targetId = kind === "record_arrival" ? purchaseOrderId : line?.id;
    const existing = current.pending.find(row => row.kind === kind && row.targetId === targetId);
    transition.change(() => { attempted.current = null; setCommand(existing ?? null); setDraft(existing ? null : { id: crypto.randomUUID(), kind, workspace: current.view, line, postingId }); setUnconfirmed(false); });
  }
  async function prepare(original: PrepareIncomingCommand) {
    if (busy.current || !current || closing) throw new IncomingRequestError(423, "请等待当前记录读取或操作完成 再保存本次原填写");
    const captured = epoch.current, capturedScope = scope; busy.current = true; setWorking(true); attempted.current = original;
    try {
      const result = await incomingRequest("commands", IncomingCommandViewSchema, identity, original);
      if (valid(captured, capturedScope)) transition.change(() => { setCommand(result); setDraft(null); setLoaded(previous => previous && ({ ...previous, pending: [...previous.pending.filter(row => row.id !== result.id), ...(result.acknowledged ? [] : [result])] })); setError(""); });
    } catch (failure) { if (valid(captured, capturedScope) && incomingDenied(failure)) revoke(); throw failure; }
    finally { if (valid(captured, capturedScope)) { busy.current = false; setWorking(false); } }
  }
  async function apply(action: "execute" | "cancel" | "acknowledge") {
    if (!command || busy.current || reading || closing || unconfirmed) return;
    const captured = epoch.current, capturedScope = scope, original = command; busy.current = true; setWorking(true); setError("");
    try {
      const result = await incomingRequest(`commands/${original.id}/${action}`, IncomingCommandViewSchema, identity, {});
      if (!valid(captured, capturedScope)) return;
      setCommand(action === "acknowledge" ? null : result); commandRef.current = action === "acknowledge" ? null : result;
      attempted.current = null;
      if (result.status === "succeeded") onChanged();
      // The business transaction is settled; its following read may be slow or
      // unavailable. Closing now only abandons that read, never a pending write.
      busy.current = false; setWorking(false);
      await reload(undefined, true);
    } catch (failure) {
      if (valid(captured, capturedScope)) {
        if (incomingDenied(failure)) revoke();
        else { setUnconfirmed(true); setError(failure instanceof Error ? failure.message : "结果尚未确认 请重新读取原提交"); }
      }
    } finally { if (valid(captured, capturedScope)) { busy.current = false; setWorking(false); } }
  }
  const view = current?.view;
  const actualLine = draft?.line && (current?.extraLine?.id === draft.line.id ? current.extraLine : view?.arrivals.flatMap(row => row.lines).find(row => row.id === draft.line!.id));
  const currentActionAvailable = !draft || !view ? false : draft.kind === "record_arrival" ? view.canRecordArrival : draft.kind === "publish_standard" ? view.canPublishStandard
    : draft.kind === "record_inspection" ? actualLine?.canInspect : draft.kind === "review_inspection" ? actualLine?.canReview : draft.kind === "post_inspection" ? actualLine?.canPost : actualLine?.canReturn;
  const basisChanged = Boolean(draft && view && (!currentActionAvailable || draft.workspace.purchaseOrderVersion !== view.purchaseOrderVersion ||
    JSON.stringify(draft.workspace.standards.map(row => row.id)) !== JSON.stringify(view.standards.map(row => row.id)) ||
    draft.line && actualLine && (draft.line.inspections[0]?.id !== actualLine.inspections[0]?.id || JSON.stringify(draft.line.quantities) !== JSON.stringify(actualLine.quantities))));
  return <RecordDialog title="来料检验与入账" onClose={leave} protectEdits={Boolean(draft)}>
    <div className={`incoming-workspace${closing ? " is-closing" : ""}`} aria-busy={reading || working}>
      <div className="incoming-toolbar"><div><strong>{view?.purchaseOrderCode ?? "原采购单"}</strong>{view && <span>采购 v{view.purchaseOrderVersion} · 到货保管 → 实际检验 → 核准 → 入账</span>}</div>
        <button type="button" disabled={reading || working || closing} onClick={() => void reload()}><RefreshCw size={14} className={reading ? "is-spinning" : ""} />{reading ? "正在读取" : "重新读取记录"}</button></div>
      {!canRead && <p className="record-help">当前没有来料记录所需的采购与库存读取权限</p>}
      {error && <p className="record-notice error" role="alert">{error}</p>}
      {denied && <p className="record-help">私有填写已清除 请重新登录或核对当前权限</p>}
      {canRead && !view && !error && <p className="record-help" role="status">正在读取原采购与来料记录</p>}
      {canRead && current && view && !denied && <>
        <section className="incoming-pending" aria-label="待核对的原提交"><h3>待核对的原提交 <span>{current.pending.length}{current.nextCursor ? "+" : ""}</span></h3>
          {current.pending.length ? <ul>{current.pending.map(row => <li key={row.id}><div><strong>{incomingActionNames[row.kind]}</strong><span>{incomingStatusNames[row.status]} · {incomingTime(row.createdAt)}</span></div>
            <button type="button" disabled={working || reading || Boolean(draft) || closing} onClick={() => { transition.change(() => { setCommand(row); commandRef.current = row; setUnconfirmed(false); }); commandRef.current = row; void reload(); }}>恢复原提交</button></li>)}</ul> : <p className="record-help">当前没有待核对的原提交</p>}
          {current.nextCursor && <button type="button" disabled={reading || working || Boolean(draft) || closing} onClick={() => void reload(current.nextCursor!)}>读取更早的原提交</button>}
        </section>
        {command ? <CommandReview command={command} workspace={view} blocked={reading || working || closing || Boolean(error) || unconfirmed} onApply={apply} onBack={() => transition.change(() => setCommand(null))} onAccessDenied={revoke} />
          : draft ? <IncomingOperationForm key={draft.id} draft={draft} unavailable={reading || closing || Boolean(error)} basisChanged={basisChanged} onPrepare={prepare} onClose={() => transition.change(() => { setDraft(null); attempted.current = null; })} />
            : <div className="incoming-toolbar incoming-actions"><div>
              {view.canRecordArrival && <button className="primary" disabled={reading || working || closing || Boolean(error)} type="button" onClick={() => begin("record_arrival")}><PackageCheck size={15} />登记实际到货</button>}
              {view.canPublishStandard && <button disabled={reading || working || closing || Boolean(error)} type="button" onClick={() => begin("publish_standard")}><ClipboardCheck size={15} />发布检验标准</button>}
              {!view.canRecordArrival && !view.canPublishStandard && <p className="record-help">当前只显示已保存的来料记录</p>}
            </div></div>}
        {view.receivingPolicy === null && <p className="record-notice">原采购单未声明来料检验流程 旧记录保留原收货历史{view.arrivals.length === 0 && !draft && !command && <button type="button" disabled={reading || working || closing || Boolean(error)} onClick={onLegacyReceipt}>沿用旧单收货</button>}</p>}
        <section className="incoming-history" aria-label="实际到货与检验记录"><h3>实际到货与检验记录</h3>
          {!view.arrivals.length && <p className="record-help">尚未登记实际到货 不会预先增加可用库存</p>}
          {view.arrivals.map(arrival => <section className="incoming-arrival" key={arrival.id}>
            <header><strong>{arrival.code}</strong><span>{incomingTime(arrival.arrivedAt)}</span><p>{arrival.externalReference}</p></header>
            {arrival.lines.map(line => <IncomingLine key={line.id} line={line} standards={view.standards} blocked={Boolean(draft || command || error) || reading || working || closing} onAction={begin} />)}
          </section>)}
          {current.extraLine && !view.arrivals.some(row => row.lines.some(line => line.id === current.extraLine!.id)) && <IncomingLine line={current.extraLine} standards={view.standards} blocked={Boolean(draft || command || error) || reading || working || closing} onAction={begin} />}
          {view.truncated && <p className="record-notice">当前显示最近 50 批到货 较早批次的未确认原提交可从上方恢复</p>}
        </section>
      </>}
    </div>
  </RecordDialog>;
}

function CommandReview({ command, workspace, blocked, onApply, onBack, onAccessDenied }: { command: IncomingCommandView; workspace: IncomingWorkspaceView; blocked: boolean; onApply(action: "execute" | "cancel" | "acknowledge"): Promise<void>; onBack(): void; onAccessDenied(): void }) {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [command.id, command.status, command.blockReason, blocked]);
  const reasons = { basis_changed: "原业务依据或剩余数量已变化 原填写保持 请核对后取消并重新填写", permission_denied: "当前权限不足以执行原提交 可读取结果或取消准备", input_unavailable: "原填写暂时不可用 已停止执行 请重新读取或取消这笔准备", expired: "原填写已到期 已停止执行 已完成的业务事实仍然保留" };
  return <section className="incoming-command" aria-label="核对原提交"><header><h3>{incomingActionNames[command.kind]}</h3><strong>{incomingStatusNames[command.status]}</strong></header>
    <p>{command.targetLabel}{command.targetDetail && <span> · {command.targetDetail}</span>}</p>
    <p className="record-help">原提交保存于 {incomingTime(command.createdAt)} · 填写副本保留至 {incomingTime(command.expiresAt)}</p>
    {command.original ? <IncomingOriginalSummary original={command.original} workspace={workspace} /> : <p className="record-help">{command.status === "prepared" ? "原填写暂时不可读 这笔准备仍保留" : "原填写副本已清除或不可用 业务结果引用继续保留"}</p>}
    {command.blockReason && <p className="record-notice error">{reasons[command.blockReason]}</p>}
    {command.status === "succeeded" && <p className="record-notice success">实际业务结果已保存 读取与重试不会再次入账 可在下方批次记录核对</p>}
    {command.status === "prepared" && command.original && <AgentOperationHandoff reference={{ domain: "incoming", commandId: command.id, accountId: null }} disabled={blocked} onDenied={onAccessDenied} />}
    {command.canExecute && <label className="incoming-confirm"><input type="checkbox" checked={confirmed} disabled={blocked} onChange={event => setConfirmed(event.target.checked)} />我已核对原填写与本次实际业务依据</label>}
    <footer><button type="button" disabled={blocked} onClick={onBack}>返回批次</button>
      {command.canCancel && <button type="button" disabled={blocked} onClick={() => void onApply("cancel")}><RotateCcw size={14} />取消这笔准备</button>}
      {command.canExecute && <button className="primary" type="button" disabled={blocked || !confirmed} onClick={() => void onApply("execute")}><Check size={14} />确认执行原提交</button>}
      {command.status !== "prepared" && !command.acknowledged && <button className="primary" type="button" disabled={blocked} onClick={() => void onApply("acknowledge")}>确认结果并清除填写副本</button>}
    </footer>
  </section>;
}

function IncomingLine({ line, standards, blocked, onAction }: { line: IncomingArrivalLineView; standards: IncomingWorkspaceView["standards"]; blocked: boolean; onAction(kind: IncomingCommandKind, line: IncomingArrivalLineView, postingId?: string): void }) {
  const [open, setOpen] = useState(false), transition = useOwnedViewTransition();
  const unit = unitNames[line.unit], resultNames = { pass: "符合", fail: "不符合", missing: "缺测量", invalid: "无效测量" };
  return <article className="incoming-line" aria-label={`来料批次 ${line.stockName} ${line.supplierLotCode}`}>
    <button type="button" className="incoming-line-toggle" onClick={() => transition.change(() => setOpen(value => !value))} aria-expanded={open} aria-controls={`incoming-line-${line.id}`}><div><strong>{line.stockName} · {line.stockCode}</strong><span>原批号 {line.supplierLotCode} · {line.holdingLocationName}</span></div><ChevronDown size={15} className={open ? "is-open" : ""} /></button>
    <p className="record-help">本批实际到货与处置单位 {unit} 库存按原采购版本固定的换算依据入账</p>
    <dl className="incoming-quantities"><div><dt>实到</dt><dd>{formatStockQuantity(line.quantities.arrived)} {unit}</dd></div><div><dt>待处置</dt><dd>{formatStockQuantity(line.quantities.pending)} {unit}</dd></div><div><dt>已接受</dt><dd>{formatStockQuantity(line.quantities.accepted)} {unit}</dd></div><div><dt>拒收保管</dt><dd>{formatStockQuantity(line.quantities.rejectedHeld)} {unit}</dd></div><div><dt>实际退回</dt><dd>{formatStockQuantity(line.quantities.returned)} {unit}</dd></div></dl>
    <div className="record-toolbar incoming-line-actions">
      {line.canInspect && <button type="button" disabled={blocked} onClick={() => onAction("record_inspection", line)}>{line.inspections.length ? "记录本次复检" : "记录实际检验"}</button>}
      {line.canReview && <button type="button" disabled={blocked} onClick={() => onAction("review_inspection", line)}>核准本次检验</button>}
      {line.canPost && <button type="button" disabled={blocked} onClick={() => onAction("post_inspection", line)}>确认检验入账</button>}
    </div>
    <div className="incoming-collapse" data-open={open} id={`incoming-line-${line.id}`} aria-hidden={!open} inert={!open}><div><div className="incoming-detail">
      {line.expiresAt && <p className="record-help">有效期限 {incomingTime(line.expiresAt)}</p>}
      {!line.inspections.length && <p className="record-help">尚无实际检验记录</p>}
      {line.inspections.map(inspection => {
        const standard = standards.find(row => row.id === inspection.standardVersionId);
        return <section className="incoming-inspection" key={inspection.id}><header><strong>检验 v{inspection.version}</strong><span>{incomingTime(inspection.measuredAt)} · 抽样 {formatStockQuantity(inspection.sampleQuantity)} {unit}</span></header>
          <p>{standard ? `${standard.title} · ${standard.code} v${standard.version}` : "检验已固定原标准版本"}</p>
          {standard && <p className="record-help">原标准来源 {standard.sourceReference}</p>}
          <ul>{inspection.evaluation.items.map(item => { const reading = inspection.readings.find(row => row.criterionCode === item.code); return <li key={item.code} data-result={item.result}><strong>{standard?.criteria.find(row => row.code === item.code)?.label ?? item.code}</strong><span>{reading ? `${reading.value} ${reading.unit ?? ""}` : "未提供"}</span><span>{resultNames[item.result]}</span></li>; })}</ul>
          <p>本次检验 接受 {formatStockQuantity(inspection.acceptedQuantity)} · 拒收 {formatStockQuantity(inspection.rejectedQuantity)} {unit}</p>
          {inspection.rejectionReason && <p>拒收原因 {inspection.rejectionReason}</p>}{inspection.notes && <p>说明 {inspection.notes}</p>}
          {inspection.review ? <p className="record-help">核准 {inspection.review.decision === "approved" ? "批准本次处置" : "拒绝本次检验"} · {inspection.review.reason}</p> : <p className="record-help">尚未核准</p>}
        </section>;
      })}
      {line.postings.map(posting => {
        const held = subtractStockQuantity(posting.rejectedQuantity, sumStockQuantities(posting.returns.map(row => row.quantity)));
        return <section className="incoming-posting" key={posting.id}><header><strong>实际入账处置</strong><span>{incomingTime(posting.postedAt)}</span></header><p>接受 {formatStockQuantity(posting.acceptedQuantity)} · 拒收 {formatStockQuantity(posting.rejectedQuantity)} {unit}</p>
          {posting.merchantOwnershipConfirmed && <p className="record-help">已确认商家实际接收并拥有接受部分</p>}
          {posting.returns.map(row => <p key={row.id}>实际退回 {formatStockQuantity(row.quantity)} {unit} · {incomingTime(row.returnedAt)} · {row.externalReference} · {row.reason}</p>)}
          {line.canReturn && compareStockQuantity(held, 0) > 0 && <button type="button" disabled={blocked} onClick={() => onAction("return_rejected", line, posting.id)}>登记实际退回 · 尚余 {formatStockQuantity(held)} {unit}</button>}
        </section>;
      })}
    </div></div></div>
  </article>;
}
