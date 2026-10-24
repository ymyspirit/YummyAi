"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Check, ClipboardCheck, FileSearch, RefreshCw, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, type AgentFulfillmentCommandView, type AgentFulfillmentCommandWorkspace,
  type AgentFulfillmentCommandIntent } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { useErpAccess } from "../identity/erp-access";
import { TaskDrawer } from "../navigation/task-drawer";
import { actOnAgentFulfillmentCommand, readAgentFulfillmentCommandWorkspace, readAgentFulfillmentCommands, readAgentFulfillmentCommand,
  readAgentFulfillmentCommandReceipt, agentFulfillmentCommandDenied, agentFulfillmentCommandError } from "./agent-fulfillment-command-client";
import { useAgentFulfillmentCommandIntents, readAgentFulfillmentCommandIntents, recordAgentFulfillmentCommandIntent, forgetAgentFulfillmentCommandIntent } from "./agent-fulfillment-command-intent";
import { AgentFulfillmentCommandSummary, agentFulfillmentCommandNames, agentFulfillmentCommandStates } from "./agent-fulfillment-command-summary";
import "./agent-fulfillment-command.css";

function coordinate(value: string | null, all: string[]) {
  const parsed = EntityIdSchema.safeParse(value); return all.length === 1 && parsed.success ? parsed.data.toLowerCase() : null;
}
export function hasAgentFulfillmentCommandSelection(params: Pick<URLSearchParams, "get" | "getAll">) {
  return Boolean(coordinate(params.get("agentFulfillmentCommand"), params.getAll("agentFulfillmentCommand"))
    && coordinate(params.get("order"), params.getAll("order")));
}
export function AgentFulfillmentCommandWorkbench() {
  const access = useErpAccess(), identity = useRef({ authority: access.authority, scope: access.preferenceScope });
  identity.current = { authority: access.authority, scope: access.preferenceScope };
  return <FulfillmentWorkbench key={(access.authority ?? "") + ":" + (access.preferenceScope ?? "")} identity={identity} />;
}
function FulfillmentWorkbench({ identity }: { identity: RefObject<{ authority: string | null; scope: string | null }> }) {
  const access = useErpAccess(), params = useSearchParams(), router = useRouter(), authority = access.authority ?? "", scope = access.preferenceScope;
  const orderId = coordinate(params.get("order"), params.getAll("order")), selected = coordinate(params.get("agentFulfillmentCommand"), params.getAll("agentFulfillmentCommand"));
  const canRead = access.can(Permission.WorkflowRead) && access.canTenant(Permission.OrderRead) && access.canTenant(Permission.OrderPiiRead), canRun = access.can(Permission.WorkflowRun);
  const live = useRef({ authority, scope, selected, orderId, canRead, canRun }); live.current = { authority, scope, selected, orderId, canRead, canRun };
  const alive = useRef(true), purged = useRef(false), epoch = useRef(0), detailSeq = useRef(0), listSeq = useRef(0), workspaceSeq = useRef(0), navigationSeq = useRef(0);
  const detailRead = useRef<AbortController | null>(null), listRead = useRef<AbortController | null>(null), workspaceRead = useRef<AbortController | null>(null);
  const mutation = useRef<symbol | null>(null), receiptLock = useRef<symbol | null>(null), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intents = useAgentFulfillmentCommandIntents(scope), [workspace, setWorkspace] = useState<AgentFulfillmentCommandWorkspace | null>(null);
  const [items, setItems] = useState<AgentFulfillmentCommandView[]>([]), [view, setView] = useState<AgentFulfillmentCommandView | null>(null), viewRef = useRef<AgentFulfillmentCommandView | null>(null);
  const [workspaceError, setWorkspaceError] = useState(""), [error, setError] = useState(""), [receiptError, setReceiptError] = useState(""), [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false), [listing, setListing] = useState(false), [workspaceReading, setWorkspaceReading] = useState(false), [pending, setPending] = useState(false), [recovering, setRecovering] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [unknown, setUnknown] = useState(false), [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false), [truncated, setTruncated] = useState(false), [closing, setClosing] = useState(false);
  const valid = useCallback((token = epoch.current) => alive.current && !purged.current && token === epoch.current
    && identity.current.authority === authority && identity.current.scope === scope && live.current.authority === authority && live.current.scope === scope,
  [authority, identity, scope]);
  const readable = useCallback(() => valid() && live.current.canRead && !denied, [denied, valid]);
  const clearPrivate = useCallback(() => {
    epoch.current++; detailSeq.current++; listSeq.current++; workspaceSeq.current++;
    detailRead.current?.abort(); listRead.current?.abort(); workspaceRead.current?.abort();
    if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null;
    viewRef.current = null; setView(null); setItems([]); setWorkspace(null); setConfirmed(false); setClosing(false);
    setReading(false); setListing(false); setWorkspaceReading(false); setRecovering(false); setPending(false); setNotice("");
  }, []);
  const deny = useCallback(() => { clearPrivate(); setDenied(true); setError("当前原订单或资料权限已变化 原正文与确认已隐藏 请核对当前本人权限"); }, [clearPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { purged.current = true; clearPrivate(); setCleared(true); setError(""); setReceiptError(""); };
    window.addEventListener(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, clear); window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; detailSeq.current++; listSeq.current++; workspaceSeq.current++; detailRead.current?.abort(); listRead.current?.abort(); workspaceRead.current?.abort();
      if (closeTimer.current) clearTimeout(closeTimer.current); window.removeEventListener(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, clear); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, [clearPrivate]);
  const loadWorkspace = useCallback(async () => {
    if (!valid() || !live.current.canRead) return;
    const token = epoch.current, sequence = ++workspaceSeq.current, controller = new AbortController(); workspaceRead.current?.abort(); workspaceRead.current = controller;
    const isCurrent = () => valid(token) && sequence === workspaceSeq.current && !controller.signal.aborted;
    setWorkspaceReading(true); setWorkspaceError("");
    try { const value = await readAgentFulfillmentCommandWorkspace(authority, { signal: controller.signal, isCurrent }); if (isCurrent()) { setWorkspace(value); setDenied(false); } }
    catch (failure) { if (isCurrent()) { if (agentFulfillmentCommandDenied(failure)) deny(); else setWorkspaceError(agentFulfillmentCommandError(failure)); } }
    finally { if (isCurrent()) setWorkspaceReading(false); }
  }, [authority, deny, valid]);
  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  const loadList = useCallback(async () => {
    if (!readable() || !orderId) return;
    const token = epoch.current, sequence = ++listSeq.current, controller = new AbortController(); listRead.current?.abort(); listRead.current = controller;
    const isCurrent = () => valid(token) && sequence === listSeq.current && !controller.signal.aborted && live.current.orderId === orderId && live.current.canRead;
    setListing(true); setReceiptError("");
    try { const value = await readAgentFulfillmentCommands({ orderId }, authority, { signal: controller.signal, isCurrent }); if (isCurrent()) { setItems(value.items); setTruncated(value.truncated); } }
    catch (failure) { if (isCurrent()) { if (agentFulfillmentCommandDenied(failure)) deny(); else setReceiptError(agentFulfillmentCommandError(failure)); } }
    finally { if (isCurrent()) setListing(false); }
  }, [authority, deny, orderId, readable, valid]);
  useEffect(() => { setItems([]); setTruncated(false); void loadList(); return () => { listSeq.current++; listRead.current?.abort(); }; }, [loadList]);
  const loadDetail = useCallback(async () => {
    if (!readable() || !selected || !orderId || mutation.current) return;
    const token = epoch.current, sequence = ++detailSeq.current, controller = new AbortController(); detailRead.current?.abort(); detailRead.current = controller;
    const isCurrent = () => valid(token) && sequence === detailSeq.current && !controller.signal.aborted && live.current.selected === selected && live.current.orderId === orderId && live.current.canRead;
    setConfirmed(false); setReading(true); setError(""); setNotice("");
    viewRef.current = null; setView(null);
    try {
      const value = await readAgentFulfillmentCommand(selected, orderId, authority, { signal: controller.signal, isCurrent }); if (!isCurrent()) return;
      viewRef.current = value; setView(value); setUnknown(["executing"].includes(value.native.status));
      if (intents.ownerScope) {
        const marker = readAgentFulfillmentCommandIntents(intents.ownerScope).find(item => item.orderId === orderId && item.requestId === value.native.requestId && item.requestChecksum === value.native.requestChecksum);
        if (marker) recordAgentFulfillmentCommandIntent({ ...marker, id: value.native.id, state: "known" });
      }
    } catch (failure) { if (isCurrent()) { if (agentFulfillmentCommandDenied(failure)) deny(); else { setUnknown(true); setError(agentFulfillmentCommandError(failure)); } } }
    finally { if (isCurrent()) setReading(false); }
  }, [authority, deny, intents.ownerScope, orderId, readable, selected, valid]);
  useEffect(() => {
    detailSeq.current++; detailRead.current?.abort(); viewRef.current = null; setView(null); setConfirmed(false); setUnknown(false); setError(""); setClosing(false);
    if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null;
    void loadDetail(); return () => { detailSeq.current++; detailRead.current?.abort(); };
  }, [loadDetail]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine !== false && !mutation.current) { void loadWorkspace(); void loadList(); void loadDetail(); } };
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [loadDetail, loadList, loadWorkspace]);
  useEffect(() => {
    if (!view?.confirmationExpiresAt) return;
    const deadline = Math.min(Date.parse(view.confirmationExpiresAt), Date.parse(view.native.expiresAt)), token = epoch.current;
    const timer = setTimeout(() => {
      if (!valid(token) || viewRef.current?.native.id !== view.native.id) return;
      viewRef.current = null; setView(null); setConfirmed(false); setNotice("本次原确认已到期 请重新读取原提交再核对");
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [valid, view]);
  useEffect(() => {
    if (!view?.privateAvailable) return;
    const token = epoch.current, timer = setTimeout(() => { if (valid(token) && viewRef.current?.native.id === view.native.id) { viewRef.current = null; setView(null); setConfirmed(false); setNotice("原填写已到期 请只读核对原索引"); } }, Math.max(0, Date.parse(view.native.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [valid, view]);
  function navigate(commandId: string | null, originalOrder = orderId) {
    if (commandId !== null && (!readable() || !originalOrder || mutation.current)) return;
    navigationSeq.current++; detailSeq.current++; detailRead.current?.abort(); setConfirmed(false); setError(""); setNotice("");
    const query = new URLSearchParams(params.toString());
    if (commandId) { query.set("agentFulfillmentCommand", commandId); query.set("order", originalOrder!); }
    else query.delete("agentFulfillmentCommand");
    router.replace("/ai-tasks" + (query.size ? "?" + query : ""), { scroll: false });
  }
  function close() {
    if (mutation.current) return;
    navigationSeq.current++; detailSeq.current++; detailRead.current?.abort(); setConfirmed(false);
    if (!readable() || matchMedia("(prefers-reduced-motion: reduce)").matches) { viewRef.current = null; setView(null); navigate(null); return; }
    setClosing(true); closeTimer.current = setTimeout(() => { closeTimer.current = null; if (valid()) { viewRef.current = null; setView(null); navigate(null); } }, 140);
  }
  async function recover(marker: AgentFulfillmentCommandIntent) {
    if (!readable() || receiptLock.current || mutation.current) return;
    const token = epoch.current, lease = Symbol("fulfillment-receipt"); receiptLock.current = lease; setRecovering(true); setReceiptError("");
    const originalSelected = live.current.selected, originalOrder = live.current.orderId, navigation = navigationSeq.current;
    const options = { isCurrent: () => valid(token) && navigationSeq.current === navigation && live.current.canRead && live.current.selected === originalSelected && live.current.orderId === originalOrder };
    try {
      const value = await readAgentFulfillmentCommandReceipt(marker, authority, options); if (!options.isCurrent()) return;
      if (value.disposition === "known" && value.id) { recordAgentFulfillmentCommandIntent({ ...marker, id: value.id, state: "known" }); navigate(value.id, marker.orderId); }
      else setReceiptError("尚未找到本次原准备 不证明未提交 保留原编号继续只读核对 不换键重建");
    } catch (failure) { if (options.isCurrent()) { if (agentFulfillmentCommandDenied(failure)) deny(); else setReceiptError(agentFulfillmentCommandError(failure)); } }
    finally { if (receiptLock.current === lease) { receiptLock.current = null; if (valid(token)) { setRecovering(false); intents.reload(); } } }
  }
  async function act(action: "confirm" | "cancel" | "acknowledge") {
    const value = viewRef.current;
    if (!readable() || mutation.current || !value || value.native.id !== selected || value.native.orderId !== orderId || reading || unknown || closing) return;
    if (action === "confirm" && (!live.current.canRun || !confirmed || !value.canConfirm || !value.privateAvailable || !value.confirmationExpiresAt
      || Date.parse(value.confirmationExpiresAt) <= Date.now() || Date.parse(value.native.expiresAt) <= Date.now())
      || action === "cancel" && (!live.current.canRun || !value.canCancel) || action === "acknowledge" && !value.canAcknowledge) return;
    if (action === "cancel" && !window.confirm("只取消这笔未完成的原履约准备 不撤销已经发生的工厂 质检或交运事实")) return;
    const token = epoch.current, lease = Symbol("fulfillment-control"); mutation.current = lease; setPending(true); setError(""); setConfirmed(false);
    viewRef.current = null; setView(null);
    const options = { isCurrent: () => valid(token) && live.current.canRead && live.current.selected === value.native.id && live.current.orderId === value.native.orderId };
    try {
      const result = await actOnAgentFulfillmentCommand(value, action, authority, options); if (!options.isCurrent()) return;
      viewRef.current = result; setView(result); setUnknown(["executing", "uncertain"].includes(result.native.status));
      if (action === "acknowledge" && result.native.acknowledged && intents.ownerScope) {
        for (const marker of readAgentFulfillmentCommandIntents(intents.ownerScope)) if (marker.requestId === result.native.requestId && marker.requestChecksum === result.native.requestChecksum) forgetAgentFulfillmentCommandIntent(marker);
      }
      setNotice(action === "confirm" ? "已读取本次原处理响应 请核对实际状态与原回执" : action === "cancel" ? "已读取原取消结果 不撤销既有业务事实" : "原结果已核对 私有填写副本已清理");
    } catch (failure) { if (options.isCurrent()) { if (agentFulfillmentCommandDenied(failure)) deny(); else { setUnknown(true); setError(agentFulfillmentCommandError(failure)); } } }
    finally { if (mutation.current === lease) { mutation.current = null; if (valid(token)) { setPending(false); intents.reload(); void loadList(); } } }
  }
  const visible = readable() && view?.native.id === selected && view.native.orderId === orderId && view.contextAuthority === authority && (view.privateAvailable ? Date.parse(view.native.expiresAt) > Date.now() : true) ? view : null;
  const acknowledged = visible?.native.acknowledged === true;
  function release(marker: AgentFulfillmentCommandIntent) {
    if (!acknowledged || !visible || visible.native.id !== marker.id || visible.native.requestId !== marker.requestId || visible.native.requestChecksum !== marker.requestChecksum) return;
    try { forgetAgentFulfillmentCommandIntent(marker); intents.reload(); } catch (failure) { setReceiptError(agentFulfillmentCommandError(failure)); }
  }
  return <section className="afc-workbench" aria-label="原履约操作核对"><header><div><h2><ClipboardCheck size={17} aria-hidden="true" />原履约操作核对</h2>
    <p className="afc-muted">原表单保存准备 在此逐笔核对并明确执行 AI 建议仍需补齐原表单并由本人确认</p></div>
    <button type="button" disabled={!valid() || !canRead || workspaceReading || pending} onClick={() => void loadWorkspace()}><RefreshCw size={14} />重新读取履约操作能力</button></header>
    {cleared ? <p role="status">本人会话已清除 原正文与确认已隐藏 迟到响应不恢复标识</p> : !canRead ? <p role="status">需要工作流读取及订单和订单私有资料的租户范围读取权限 原请求标识保留 不发起新操作</p> : <>
      {workspaceReading && <p role="status">正在核对当前原履约操作能力</p>}{workspaceError && <p role="alert" className="afc-error">{workspaceError}</p>}
      {workspace && <details><summary>原操作目录 · 51 项</summary><p className="afc-muted">目录包含 37 类通用操作与 14 类履约操作 模型建议需经原表单补齐和本人核对</p><ul>{workspace.capabilities.filter(item => item.domain === "fulfillment").map(item => <li key={item.kind}>{item.label} · {item.available ? "可按原表单核对" : "当前不可准备"}</li>)}</ul></details>}
      <section aria-label="本人原履约准备恢复"><h3><FileSearch size={15} aria-hidden="true" />本人原履约准备恢复</h3><p className="afc-muted">刷新只读取原请求 不保存正文 确认凭据或业务请求键 未知时不重复准备</p>
        {intents.error && <p role="alert" className="afc-error">{intents.error}</p>}{!intents.ready && !intents.error && <p role="status">正在核对本人原标识</p>}
        <ul className="afc-intents">{intents.items.map(marker => <li className="afc-record" key={marker.requestId} aria-label={"原履约准备 " + marker.requestId}><p>原请求 <code>{marker.requestId}</code> · {marker.state === "known" ? "原提交已知 仍需核对" : "原准备结果待核对"}</p>
          <p><code>{marker.requestChecksum}</code></p><div className="afc-actions"><button type="button" disabled={!readable() || recovering || pending} onClick={() => void recover(marker)}>只读取原履约回执</button>
            {marker.id && <button type="button" disabled={!readable() || pending} onClick={() => navigate(marker.id, marker.orderId)}>读取原履约准备详情<ArrowRight size={13} /></button>}
            {acknowledged && visible && visible.native.id === marker.id && <button type="button" disabled={pending || reading} onClick={() => release(marker)}>结束本次已读履约核对</button>}</div></li>)}</ul>
        {intents.ready && !intents.items.length && <p className="afc-muted">当前会话没有待核对的原履约准备 请在原订单表单填写并选择只准备交接</p>}
        {receiptError && <p role="alert" className="afc-error">{receiptError}</p>}
      </section>
      {orderId && <section aria-label="本单已保存履约准备"><header><h3>本单已保存履约准备</h3><button type="button" disabled={!readable() || listing || pending} onClick={() => void loadList()}>只读核对本单原准备</button></header>
        {listing && <p role="status">正在读取本单原提交</p>}<ul className="afc-records">{items.filter(item => item.native.orderId === orderId).map(item => <li className="afc-record" key={item.native.id}><strong>{agentFulfillmentCommandNames[item.native.kind]}</strong><p>{agentFulfillmentCommandStates[item.native.status]}</p><button type="button" disabled={!readable() || pending} onClick={() => navigate(item.native.id)}>核对原履约提交 {item.native.id.slice(-6)}</button></li>)}</ul>
        {truncated && <p role="status">当前最多读取 100 项 不是完整历史 请保留原提交链接逐笔核对</p>}</section>}
    </>}
    {selected && orderId && <TaskDrawer title="核对原履约操作" description="完整原填写与实际回执逐项核对 关闭不取消原准备" recordKey={selected}
      className="afc-drawer" state={{ dirty: false, busy: pending, loading: reading }} onClose={close} closeLabel="关闭履约核对" contentUnavailable={!readable()}
      footer={<div className="afc-actions">{visible?.canCancel && <button type="button" disabled={pending || reading || unknown || !canRun} onClick={() => void act("cancel")}><X size={14} />取消这笔原履约准备</button>}
        {visible?.canAcknowledge && <button type="button" disabled={pending || reading || unknown} onClick={() => void act("acknowledge")}><Check size={14} />确认结果并清理原履约填写</button>}
        {visible?.canConfirm && <button type="button" className="afc-primary" disabled={!confirmed || pending || reading || unknown || !canRun} onClick={() => void act("confirm")}>{visible.confirmationDecision === "resume_original" ? "明确按原键恢复本次履约" : "确认执行这笔原履约"}</button>}</div>}>
      <section className="afc-review" aria-label="核对 Agent 原履约操作" data-closing={closing || undefined} aria-busy={pending || reading}><header><h3>{visible ? agentFulfillmentCommandNames[visible.native.kind] : "本人原履约操作"}</h3>
        <button type="button" disabled={!readable() || pending || reading || closing} onClick={() => void loadDetail()}><RefreshCw size={14} />重新读取原履约操作</button></header>
        <p>原提交 <code>{selected}</code></p>{reading && <p role="status">正在只读核对原文与当前确认依据</p>}{pending && <p role="status">正在处理原请求 等待实际回执 不重复发送</p>}
        {error && <p role="alert" className="afc-error">{error}</p>}{notice && <p role="status" className="afc-notice">{notice}</p>}
        {unknown && <p role="status" className="afc-notice">原处理结果尚待核对 只读取这笔原提交 不重发确认 不替换原键</p>}
        {visible && <><AgentFulfillmentCommandSummary value={visible} />{visible.canConfirm && <label className="afc-confirm"><input type="checkbox" checked={confirmed} disabled={pending || reading || unknown || !canRun || closing} onChange={event => setConfirmed(event.target.checked)} />
          {visible.confirmationDecision === "resume_original" ? "已只读核对原结果 明确使用同一原请求恢复 不建立第二笔履约操作" : "已核对原订单 原版本 全部填写与业务影响 明确执行这笔原履约"}</label>}
          {!canRun && <p className="afc-notice">当前只读取原请求 没有工作流运行权限 不确认执行或取消原准备</p>}
          <Link className="afc-handoff-link" href={"/orders?" + new URLSearchParams({ order: visible.native.orderId, line: visible.native.lineIds[0] ?? "", returnTo: "/ai-tasks?" + params.toString() })}>返回本单原业务核对<ArrowRight size={13} /></Link></>}
      </section>
    </TaskDrawer>}
    {selected && !orderId && <p role="alert" className="afc-error">原链接缺少同单依据 请从原订单或本人恢复标识进入 未读取其他订单</p>}
  </section>;
}
