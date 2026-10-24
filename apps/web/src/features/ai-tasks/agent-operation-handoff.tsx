"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, FileSearch } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { AGENT_COMMAND_VERSION, type AgentCommandOwnerReference, type AgentCommandReceipt } from "@yummyai/contracts/ai/agent-command";
import { useErpAccess } from "../identity/erp-access";
import {
  AGENT_OPERATION_CLEAR_EVENT, adoptAgentOperation, agentOperationDenied, agentOperationError, prepareAgentOperationIntent,
  readAgentOperationReceipt, saveAgentOperationIntent, updateAgentOperationIntent, useAgentOperationIntents,
} from "./agent-operation-client";
import "./agent-operation.css";

export function AgentOperationHandoff({ reference, disabled = false, onDenied }: { reference: AgentCommandOwnerReference; disabled?: boolean; onDenied?(message: string): void }) {
  const access = useErpAccess(), router = useRouter(), intents = useAgentOperationIntents(access.preferenceScope);
  const stamp = JSON.stringify([access.authority, access.preferenceScope, reference]), current = useRef(stamp); current.current = stamp;
  const live = useRef(true), cleared = useRef(false), epoch = useRef(0), lock = useRef<symbol | null>(null);
  const deniedCallback = useRef(onDenied); deniedCallback.current = onDenied;
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [known, setKnown] = useState<{ stamp: string; id: string } | null>(null), [receipt, setReceipt] = useState<{ stamp: string; value: AgentCommandReceipt } | null>(null);
  const allowed = Boolean(access.authority && access.preferenceScope && access.can(Permission.WorkflowRead) && access.can(Permission.WorkflowRun));
  const authority = access.authority, preferenceScope = access.preferenceScope;
  const valid = (token: number) => live.current && !cleared.current && token === epoch.current && current.current === stamp;
  useLayoutEffect(() => { epoch.current++; setKnown(null); setReceipt(null); setError(""); setPending(false); lock.current = null; }, [stamp]);
  useLayoutEffect(() => { live.current = true; const clear = () => { cleared.current = true; epoch.current++; setKnown(null); setReceipt(null); setError(""); setPending(false); };
    window.addEventListener(AGENT_OPERATION_CLEAR_EVENT, clear); return () => { live.current = false; epoch.current++; window.removeEventListener(AGENT_OPERATION_CLEAR_EVENT, clear); }; }, []);
  function deny(failure: unknown) {
    setKnown(null); setReceipt(null); deniedCallback.current?.(agentOperationError(failure)); window.dispatchEvent(new Event("focus"));
  }
  async function handoff() {
    if (!allowed || !authority || !preferenceScope || lock.current || disabled || !intents.ready || cleared.current) return;
    const lease = Symbol("agent-handoff"); lock.current = lease; setPending(true); setError(""); const token = epoch.current;
    try {
      const prepared = await prepareAgentOperationIntent({ version: AGENT_COMMAND_VERSION, requestId: crypto.randomUUID(), reference }, preferenceScope);
      if (!valid(token)) return;
      saveAgentOperationIntent(prepared.intent); const marker = updateAgentOperationIntent({ ...prepared.intent, state: "unknown" });
      if (!valid(token)) return;
      const value = await adoptAgentOperation(prepared.input, authority);
      if (!valid(token)) return;
      updateAgentOperationIntent({ ...marker, state: "known", id: value.id }); setKnown({ stamp, id: value.id });
      router.push("/ai-tasks?" + new URLSearchParams({ agentCommand: value.id }));
    } catch (failure) { if (valid(token)) { setError(agentOperationError(failure)); if (agentOperationDenied(failure)) deny(failure); } }
    finally { if (lock.current === lease) { lock.current = null; if (valid(token)) { setPending(false); intents.reload(); } } }
  }
  async function recover() {
    if (!authority || !allowed || lock.current || cleared.current) return;
    const marker = intents.markers.find(value => value.state !== "known"); if (!marker) return;
    const lease = Symbol("agent-handoff-receipt"); lock.current = lease; setPending(true); setError(""); const token = epoch.current;
    try {
      const value = await readAgentOperationReceipt({ requestId: marker.requestId, requestChecksum: marker.requestChecksum }, authority);
      if (!valid(token)) return;
      if (value.disposition === "known") updateAgentOperationIntent({ ...marker, state: "known", id: value.id });
      setReceipt({ stamp, value });
    } catch (failure) { if (valid(token)) { setError(agentOperationError(failure)); if (agentOperationDenied(failure)) deny(failure); } }
    finally { if (lock.current === lease) { lock.current = null; if (valid(token)) { setPending(false); intents.reload(); } } }
  }
  if (!allowed || cleared.current) return null;
  const unknown = intents.markers.some(value => value.state !== "known"), result = receipt?.stamp === stamp ? receipt.value : null;
  const knownId = known?.stamp === stamp ? known.id : result?.ownerCommandId === reference.commandId ? result.id : null;
  return <aside className="agent-operation-handoff" aria-label="交接原业务准备到 AI 工作台">
    <button type="button" disabled={disabled || pending || !intents.ready || unknown || Boolean(knownId)} onClick={() => void handoff()}><ArrowRight size={14} />{pending ? "正在核对原交接" : "交给AI工作台核对"}</button>
    <p>只交接这笔已准备的原命令引用 此按钮不执行业务 AI 工作台仍须逐笔明确确认</p>
    {unknown && <><p role="status">本人有原交接结果未知 请只读取原回执 不再次交接或另建请求</p><button type="button" disabled={pending} onClick={() => void recover()}><FileSearch size={14} />只读取原交接回执</button></>}
    {result?.disposition === "not_found" && <p role="status">尚未找到原回执 不等于未登记 请继续核对原请求 不自动重发</p>}
    {result?.ownerCommandId && <p>找回的原业务命令 <code>{result.ownerCommandId}</code>{result.ownerCommandId !== reference.commandId ? " 与当前命令不同 请按原 ID 分别核对" : ""}</p>}
    {(knownId || result?.id) && <Link href={"/ai-tasks?" + new URLSearchParams({ agentCommand: knownId ?? result!.id! })}>到AI工作台核对原操作</Link>}
    {(error || intents.error) && <p className="ao-error" role="alert">{error || intents.error}</p>}
  </aside>;
}
