"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileSearch, RefreshCw } from "lucide-react";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { AssistKindSchema, type AssistKind, type AssistView } from "@yummyai/contracts/ai/assist";
import { ASSIST_TASKS } from "@yummyai/contracts/ai/task-workspace";
import { assistRequestRecoveryText, type AssistIntent, type AssistReceiptView } from "@yummyai/contracts/ai/assist-recovery";
import { useErpAccess } from "../identity/erp-access";
import { assistApi, assistReadDenied, AssistRequestError } from "./assist-client";
import { ASSIST_INTENT_CLEAR_EVENT, assistIntentHash, forgetAssistIntent, recordAssistIntentRun, useAssistIntentMarkers } from "./assist-request-intent";
import "./assist.css";

export function AssistRequestRecovery({ kind, scope, onRecovered, onReadDenied }: { kind?: AssistKind; scope?: string;
  onRecovered?(view: AssistView): void; onReadDenied?(message: string): void }) {
  const access = useErpAccess(), intents = useAssistIntentMarkers(access.preferenceScope, kind, scope);
  const permissionKey = AssistKindSchema.options.filter(item => requiredAssistPermissions(item, "read").every(bit => access.can(bit))).join(",");
  const identity = useRef(access.authority), owner = useRef(access.authority), alive = useRef(true), blocked = useRef(false), permitted = useRef(false);
  identity.current = access.authority;
  const allowed = Boolean(access.authority && owner.current === access.authority && (kind ? permissionKey.split(",").includes(kind) : permissionKey));
  permitted.current = allowed;
  const [denied, setDenied] = useState(false);
  const valid = useCallback((authority: string) => alive.current && !blocked.current && permitted.current && identity.current === authority && owner.current === authority, []);
  const deny = useCallback(() => { blocked.current = true; setDenied(true); onReadDenied?.("当前分析读取权限已变化 原结果与填写已隐藏"); window.dispatchEvent(new Event("focus")); }, [onReadDenied]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, deny); return () => window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, deny); }, [deny]);
  if (!allowed || denied) return <section className="ai-request-recovery" aria-label="本人 AI 原请求恢复"><p role="status">当前身份或读取权限尚未核对 原分析正文已隐藏 纯 ID 标识不授予读取权限</p></section>;
  const markers = intents.markers.filter(item => permissionKey.split(",").includes(item.kind));
  return <section className="ai-request-recovery" aria-label="本人 AI 原请求恢复"><h3><FileSearch size={15} />本人 AI 原请求恢复</h3>
    <p className="ai-assist-muted">只保存原请求 ID 和摘要 不保存提示词 业务正文或密钥 读取原回执不会调用模型或重新入队</p>
    {!intents.ready && <p role="status">正在核对本人原请求标识</p>}{intents.error && <p role="alert" className="ai-assist-error">{intents.error}</p>}
    {intents.ready && !markers.length && !intents.error && <p className="ai-assist-muted">当前标签页没有可核对的原意图 这不是没有服务器历史的证明</p>}
    {markers.map(value => <OriginalRequest key={value.requestId} value={value} authority={access.authority!} expectedScope={scope} canRun={requiredAssistPermissions(value.kind, "run").every(bit => access.can(bit))} valid={valid} deny={deny} onRecovered={onRecovered} />)}
  </section>;
}
function OriginalRequest({ value, authority, expectedScope, canRun, valid, deny, onRecovered }: { value: AssistIntent; authority: string; expectedScope?: string; canRun: boolean;
  valid(authority: string): boolean; deny(): void; onRecovered?(view: AssistView): void }) {
  const [receipt, setReceipt] = useState<AssistReceiptView | null>(null), [error, setError] = useState(""), [reading, setReading] = useState(false);
  const request = useRef<AbortController | null>(null), sequence = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; request.current?.abort(); }; }, []);
  async function read() {
    if (!valid(authority) || reading) return; const token = ++sequence.current; request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    const current = () => alive.current && !abort.signal.aborted && token === sequence.current && valid(authority);
    setReading(true); setError("");
    try {
      const next = await assistApi<AssistReceiptView>("receipts?" + new URLSearchParams({ requestId: value.requestId, requestChecksum: value.requestChecksum }), undefined, abort.signal, authority);
      if (!current()) return;
      if (next.requestId !== value.requestId || next.requestChecksum !== value.requestChecksum || next.run && (next.run.kind !== value.kind || value.runId && next.run.id !== value.runId || expectedScope !== undefined && next.run.scope !== expectedScope))
        throw new AssistRequestError(502, "原回执身份或摘要不一致 未采用另一笔任务");
      if (next.run?.request && await assistIntentHash(assistRequestRecoveryText(next.run.request)) !== value.requestChecksum)
        throw new AssistRequestError(502, "原请求正文与已保存摘要不一致 未采用替代结果");
      if (!current()) return;
      if (next.run) { try { recordAssistIntentRun(value, next.run.id); } catch { setError("原任务已找回 但本地标识更新失败 请记录实际 ID 不要再次提交"); } }
      setReceipt(next); if (next.run) onRecovered?.(next.run);
    } catch (failure) { if (current()) { if (assistReadDenied(failure)) { setReceipt(null); deny(); }
      else setError(failure instanceof AssistRequestError ? failure.message : "原回执暂不可读取 不重发付费请求"); } }
    finally { if (current()) setReading(false); }
  }
  function unlock() {
    if (!valid(authority) || !canRun || reading || !window.confirm("原请求可能已经登记或产生费用 另起任务可能重复付费 这里只解除本地锁 不会取消原任务 是否明确继续")) return;
    try { forgetAssistIntent(value); } catch (failure) { setError(failure instanceof AssistRequestError ? failure.message : "原意图未能解除 不发起新任务"); }
  }
  return <article className="ai-request-row" aria-label={"原 AI 请求 " + value.requestId}><p>原请求 <code>{value.requestId}</code> · {ASSIST_TASKS.find(task => task.kind === value.kind)?.label ?? "原分析任务"}</p>
    <details><summary>原请求摘要</summary><code>{value.requestChecksum}</code>{value.runId && <p>已知原任务 <code>{value.runId}</code></p>}</details>
    <div className="ai-assist-controls"><button type="button" disabled={reading} onClick={() => void read()}><RefreshCw size={14} />只读取原请求回执</button>
      <button type="button" disabled={reading || !canRun} onClick={unlock}>明确开始新的付费任务</button></div>
    {reading && <p role="status">正在核对当前本人原回执</p>}{error && <p className="ai-assist-error" role="alert">{error}</p>}
    {receipt?.state === "not_found" && <p className="ai-assist-warning">原回执尚未找到 不等于未提交 不从当前资料重建原正文 不自动换编号或再次发送 请继续核对</p>}
    {receipt?.run && <section aria-label="已找回的原 AI 回执"><p>原任务 <code>{receipt.run.id}</code> · {{ queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消" }[receipt.run.status]}</p>
      <p>模型 {receipt.run.modelLabel} · 创建 {receipt.run.createdAt}</p>{!receipt.run.request && <p className="ai-assist-warning">原内容已不可用 仅保留已核对的任务标识与状态 不重新运行</p>}
      {receipt.run.error && <p>{receipt.run.error}</p>}<Link href={"/ai-tasks?" + new URLSearchParams({ run: receipt.run.id })}>读取原任务详情</Link>
    </section>}
  </article>;
}
