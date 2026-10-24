"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Check, ClipboardList, Plus, RefreshCw, X } from "lucide-react";
import {
  FactoryQuantityWorkspaceSchema, FactoryQuantityReportResultSchema,
  type FactoryQuantityWorkspace as Workspace, type FactoryQuantityReportResult,
} from "@yummyai/contracts/suppliers/factory-quantity";
import {
  FactoryQuantityForm, FactoryQuantityBasisSummary, FactoryQuantityOriginalSummary,
  FactoryQuantityReportSummary, type FactoryQuantityPending,
} from "./factory-quantity-form";
import "./factory-quantity.css";

class FactoryQuantityError extends Error {
  constructor(readonly status: number, message: string, readonly code: "factory_authority_changed" | null = null) { super(message); }
}
const denied = (error: unknown) => error instanceof FactoryQuantityError &&
  ([401, 403, 404].includes(error.status) || error.code === "factory_authority_changed");
const rejected = (error: unknown) => error instanceof FactoryQuantityError && !denied(error) &&
  [400, 409, 413, 415, 422].includes(error.status);
const errorMessage = (error: unknown) => error instanceof FactoryQuantityError ? error.message :
  "清点依据暂时无法核对 原报告未自动更改";

async function quantityRequest<S extends z.ZodType>(assignmentId: string, authority: string, schema: S,
  options: { signal?: AbortSignal; before?: string; pending?: FactoryQuantityPending } = {}): Promise<z.output<S>> {
  const query = new URLSearchParams({ limit: "20", ...(options.before ? { before: options.before } : {}) });
  let response: Response;
  try {
    response = await fetch("/api/factory-portal/work-items/" + assignmentId + "/quantity" +
      (options.pending ? "/reports" : "?" + query), {
      method: options.pending ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", ...(options.pending ? { "content-type": "application/json" } : {}) },
      ...(options.pending ? { body: JSON.stringify(options.pending.input) } : {}),
      signal: options.pending ? AbortSignal.timeout(70_000) :
        AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(25_000)]),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new FactoryQuantityError(0, options.pending ? "登记响应尚未确认 已保留完整原报告 请按原请求编号重试" : "清点读取中断 请重新读取");
  }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0, raw: unknown = null;
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > (response.ok ? 1_048_576 : 8_192)) { await reader.cancel(); throw new Error("size"); }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
      raw = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch {
    if (response.ok) throw new FactoryQuantityError(502, "完整清点回执无法核对 请保留原报告与请求编号");
  } finally { reader?.releaseLock(); }
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && raw.code === "factory_authority_changed" ? "factory_authority_changed" : null;
    const messages: Record<number, string> = {
      400: "请核对完整清点数量和凭据", 401: "工厂本人登录已失效 私有资料已清除",
      403: "当前任务授权已变化 私有资料已清除", 404: "此任务当前不可访问 私有资料已清除",
      409: "原文件 本人接受回执或清点依据已变化 不会替换本次原报告",
      413: "完整报告超过支持大小 未截断提交", 415: "报告格式未通过核对",
      422: "实际清点数量 时间或完整版本依据未通过核对",
    };
    throw new FactoryQuantityError(response.status, code ? "当前本人或任务授权已变化 私有资料已清除" :
      messages[response.status] ?? "清点服务结果尚未确认 请保留原报告后重试", code);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new FactoryQuantityError(502, "清点回执格式无法核对 未用旧资料补填");
  const value = parsed.data;
  if (!value || typeof value !== "object" || !("contextAuthority" in value) || value.contextAuthority !== authority ||
    !("assignmentId" in value) || value.assignmentId !== assignmentId)
    throw new FactoryQuantityError(409, "当前本人或任务授权已变化 私有资料已清除", "factory_authority_changed");
  return value;
}

type ReadState = { scope: string; value: Workspace | null; reading: boolean; error: string };
type Editor = { scope: string; basis: Workspace["basis"]; taskFingerprint: string };
type Saved = { scope: string; value: FactoryQuantityReportResult; basis: Workspace["basis"] };

export function FactoryQuantityWorkspace({ assignmentId, contextAuthority, canRespond, refresh, pending, onPendingChange, onDenied, onChanged }: {
  assignmentId: string;
  contextAuthority: string;
  canRespond: boolean;
  refresh: number;
  pending: FactoryQuantityPending | null;
  onPendingChange(value: FactoryQuantityPending | null): void;
  onDenied(): void;
  onChanged(): void;
}) {
  const scope = contextAuthority + ":" + assignmentId;
  const [read, setRead] = useState<ReadState | null>(null), [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null), [saved, setSaved] = useState<Saved | null>(null);
  const [open, setOpen] = useState(false), [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(""), [knownRejected, setKnownRejected] = useState(false);
  const [deniedScope, setDeniedScope] = useState("");
  const live = useRef({ scope, canRespond, pending }), alive = useRef(true), sequence = useRef(0);
  const controller = useRef<AbortController | null>(null), writeEpoch = useRef(0), sending = useRef<object | null>(null);
  const taskStamp = useRef<string | null>(null), closeTimer = useRef<number | null>(null);
  live.current = { scope, canRespond, pending };
  const deny = useCallback(() => {
    sequence.current++; writeEpoch.current++; controller.current?.abort(); sending.current = null;
    setDeniedScope(scope); setRead(null); setEditor(null); setSaved(null); setOpen(false);
    setBusy(false); setFailure(""); setKnownRejected(false); onDenied();
  }, [scope, onDenied]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; writeEpoch.current++; controller.current?.abort();
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); };
  }, []);
  useLayoutEffect(() => {
    sequence.current++; writeEpoch.current++; controller.current?.abort(); sending.current = null; taskStamp.current = null;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setRead(null); setEditor(null); setSaved(null); setOpen(false); setClosing(false);
    setBusy(false); setFailure(""); setKnownRejected(false); setDeniedScope("");
  }, [scope]);
  useEffect(() => {
    if (deniedScope === scope) return;
    const abort = new AbortController(), token = ++sequence.current;
    controller.current?.abort(); controller.current = abort;
    const valid = () => alive.current && !abort.signal.aborted && live.current.scope === scope && sequence.current === token;
    setRead(previous => ({ scope, value: previous?.scope === scope ? previous.value : null, reading: true, error: "" }));
    void quantityRequest(assignmentId, contextAuthority, FactoryQuantityWorkspaceSchema, { signal: abort.signal }).then(value => {
      if (!valid()) return;
      const original = live.current.pending;
      if (taskStamp.current !== null && taskStamp.current !== value.taskFingerprint ||
        original?.contextAuthority === contextAuthority && original.assignmentId === assignmentId && original.taskFingerprint !== value.taskFingerprint) { deny(); return; }
      taskStamp.current = value.taskFingerprint;
      setRead({ scope, value, reading: false, error: "" });
    }).catch(error => {
      if (!valid()) return;
      if (denied(error)) deny();
      else setRead(previous => ({ scope, value: previous?.scope === scope ? previous.value : null, reading: false, error: errorMessage(error) }));
    });
    return () => abort.abort();
  }, [assignmentId, contextAuthority, scope, refresh, reload, deniedScope, deny]);
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden") setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  const current = deniedScope !== scope && read?.scope === scope ? read : null, view = current?.value;
  const frozen = canRespond && pending?.contextAuthority === contextAuthority && pending.assignmentId === assignmentId ? pending : null;
  const editing = canRespond && editor?.scope === scope ? editor : null, receipt = saved?.scope === scope ? saved : null;
  const canStart = canRespond && view?.access.canReport === true && !current?.reading && !current?.error;

  function reveal() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setClosing(false); setFailure(""); setOpen(true);
    if (!frozen && !receipt && view && canStart) setEditor({ scope, basis: view.basis, taskFingerprint: view.taskFingerprint });
  }
  function close() {
    const finish = () => { if (!alive.current || live.current.scope !== scope) return; setOpen(false); setClosing(false);
      if (!live.current.pending) setEditor(null); };
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { setClosing(true); closeTimer.current = window.setTimeout(finish, 150); }
  }
  async function send(value: FactoryQuantityPending) {
    if (sending.current || live.current.scope !== scope || !live.current.canRespond || deniedScope === scope) return;
    const epoch = writeEpoch.current, ticket = {}; sending.current = ticket;
    onPendingChange(value); setBusy(true); setFailure(""); setKnownRejected(false);
    sequence.current++; controller.current?.abort();
    setRead(previous => previous?.scope === scope ? { ...previous, reading: false } : previous);
    const valid = () => alive.current && live.current.scope === scope && live.current.canRespond && epoch === writeEpoch.current;
    try {
      const result = await quantityRequest(assignmentId, contextAuthority, FactoryQuantityReportResultSchema, { pending: value });
      if (!valid()) return;
      if (result.taskFingerprint !== value.taskFingerprint) { deny(); return; }
      if (result.report.input.idempotencyKey.toLowerCase() !== value.input.idempotencyKey.toLowerCase())
        throw new FactoryQuantityError(502, "原请求与登记回执不一致 请保留原报告");
      setSaved({ scope, value: result, basis: value.basis }); setEditor(null); onPendingChange(null);
    } catch (error) {
      if (!valid()) return;
      if (denied(error)) deny(); else { setFailure(errorMessage(error)); setKnownRejected(rejected(error)); }
    } finally {
      if (sending.current === ticket) sending.current = null;
      if (valid()) setBusy(false);
    }
  }
  async function more() {
    if (!view?.nextCursor || current?.reading || busy) return;
    const abort = new AbortController(), token = ++sequence.current; controller.current?.abort(); controller.current = abort;
    const valid = () => alive.current && !abort.signal.aborted && live.current.scope === scope && sequence.current === token;
    setRead({ scope, value: view, reading: true, error: "" });
    try {
      const next = await quantityRequest(assignmentId, contextAuthority, FactoryQuantityWorkspaceSchema, { signal: abort.signal, before: view.nextCursor });
      if (!valid()) return;
      if (next.taskFingerprint !== view.taskFingerprint) { deny(); return; }
      const reports = [...new Map([...view.reports, ...next.reports].map(row => [row.reportId, row])).values()];
      setRead({ scope, value: { ...next, reports }, reading: false, error: "" });
    } catch (error) {
      if (valid()) { if (denied(error)) deny(); else setRead({ scope, value: view, reading: false, error: errorMessage(error) }); }
    }
  }
  if (deniedScope === scope) return null;
  return <section className="fq-workspace" aria-label="工厂实际清点">
    <header className="fq-header"><div><h3><ClipboardList size={17} aria-hidden="true" />实际清点报告</h3>
      <p>工厂本人登记 运营另行核准</p></div>
      <button type="button" disabled={current?.reading || busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新读取清点</button>
    </header>
    {current?.reading && <p role="status">正在核对本人任务与完整生产版本</p>}
    {current?.error && <p role="alert" className="fp-alert">{current.error} {view ? "下方是上次成功读取的依据" : ""}</p>}
    {view && <><FactoryQuantityBasisSummary basis={view.basis} />
      {view.basis.blockers.length > 0 && <ul className="fq-blockers">{view.basis.blockers.map((value, index) => <li key={index}>{value}</li>)}</ul>}
      {!canRespond && <p className="fq-hint">当前本人仅可读取 清点登记需要此任务的响应权限</p>}
      {canRespond && !view.access.canReport && <p className="fq-hint">当前不满足新报告条件 请先核对本人接受回执 原文件和完整制造依据</p>}
    </>}
    {!open && (frozen || receipt || canStart) && <button className="fp-primary" type="button" onClick={reveal}>
      <Plus size={15} aria-hidden="true" />{frozen ? "恢复原清点报告" : receipt ? "查看本次清点回执" : "登记实际清点"}
    </button>}
    {frozen && !open && <p role="status" className="fq-hint">原清点报告仍在本页保留 不会换请求编号或另建报告 请恢复后核对结果</p>}
    {open && <div className="fq-editor" data-closing={closing ? "true" : "false"} inert={closing} aria-disabled={closing}>
      {receipt ? <section aria-label="本次工厂清点回执">
        <h4 tabIndex={-1}>工厂清点报告已登记</h4>
        <p>{receipt.value.replayed ? "已读取同一原请求的既有报告 没有另建记录" : "以下是本次登记保存的原报告"}</p>
        <FactoryQuantityReportSummary report={receipt.value.report} unit={receipt.basis.unit} />
        <p>报告仍需运营核准 不表示已经批准停做或改变生产状态</p>
        <button className="fp-primary" type="button" onClick={() => { setSaved(null); setEditor(null); setOpen(false); setReload(value => value + 1); onChanged(); }}>
          <Check size={15} aria-hidden="true" />确认清点报告回执
        </button>
      </section> : frozen ? <>
        <FactoryQuantityOriginalSummary pending={frozen} />
        <p role="status">{busy ? "正在核对原报告登记结果" : "仅保留在当前页面 关闭任务详情再打开仍可恢复 整页刷新或换设备不保留此未确认填写"}</p>
        <div className="fq-actions">
          <button className="fp-primary" type="button" disabled={busy} onClick={() => void send(frozen)}><RefreshCw size={15} aria-hidden="true" />{busy ? "正在核对原报告" : "按原请求重试清点报告"}</button>
          <button type="button" onClick={close}><X size={15} aria-hidden="true" />关闭原报告</button>
        </div>
        {knownRejected && !busy && <button type="button" onClick={() => { onPendingChange(null); setEditor(null); setFailure(""); setKnownRejected(false); setOpen(false); setReload(value => value + 1); }}>
          原请求已被明确拒绝 重新读取后再填写
        </button>}
      </> : editing ? <FactoryQuantityForm basis={editing.basis} disabled={busy || !canRespond} onClose={close}
        onSubmit={input => void send({ assignmentId, contextAuthority, taskFingerprint: editing.taskFingerprint, basis: editing.basis, input })} /> : null}
      {failure && <p role="alert" className="fp-alert">{failure}</p>}
    </div>}
    {view && <section className="fq-history" aria-label="本任务清点报告历史">
      <h4>本任务清点报告历史</h4><p>已读取 {view.reports.length} 条{view.nextCursor ? " 还有更早记录" : " 本次读取已到末页"}</p>
      {view.reports.length ? <ol>{view.reports.map(report => <li key={report.reportId}>
        <FactoryQuantityReportSummary report={report} unit={view.basis.unit} />
        <p>{report.reviewedAt === null ? "尚未由运营核准" : "运营核准登记时间 " + report.reviewedAt}</p>
      </li>)}</ol> : <p>尚无工厂本人清点报告</p>}
      {view.nextCursor && <button type="button" disabled={current?.reading || busy} onClick={() => void more()}>读取更早清点报告</button>}
    </section>}
  </section>;
}
