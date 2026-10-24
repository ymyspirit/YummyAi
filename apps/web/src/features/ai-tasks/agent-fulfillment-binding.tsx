"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  AGENT_FULFILLMENT_VERSION, AGENT_FULFILLMENT_TOOL,
  type AgentFulfillmentCandidates, type AgentFulfillmentKind, type AgentFulfillmentWorkspace,
} from "@yummyai/contracts/ai/agent-fulfillment";
import { AGENT_NATIVE_V3_CLEAR_EVENT, AgentNativeV3BindingSchema, type AgentNativeV3Binding } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_NATIVE_V4_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-native-v4";
import { useErpAccess } from "../identity/erp-access";
import { AgentFulfillmentContext, type AgentFulfillmentSelection } from "./agent-fulfillment-context";
import {
  AgentFulfillmentRequestError, agentFulfillmentKindLabels, agentFulfillmentReadDenied, readAgentFulfillmentCandidates,
  type AgentFulfillmentCandidatesQuery,
} from "./agent-fulfillment-client";

type Binding = Extract<AgentNativeV3Binding, { tool: "orders.fulfillment" }>;
type Props = { workspace: AgentFulfillmentWorkspace; authority: string; enabled: boolean; onChange(value: Binding | null): void; onDenied(): void };
export function AgentFulfillmentBinding({ workspace, authority, enabled, onChange, onDenied }: Props) {
  const access = useErpAccess(), current = useRef({ authority: access.authority, enabled, onChange, onDenied });
  current.current = { authority: access.authority, enabled, onChange, onDenied };
  const alive = useRef(true), cleared = useRef(false), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const [filters, setFilters] = useState<AgentFulfillmentCandidatesQuery["filters"]>({ limit: 50 });
  const [candidates, setCandidates] = useState<AgentFulfillmentCandidates | null>(null), [selection, setSelection] = useState<AgentFulfillmentSelection | null>(null);
  const [kind, setKind] = useState<AgentFulfillmentKind>("production"), [reading, setReading] = useState(false), [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const sameAuthority = access.authority === authority && workspace.contextAuthority === authority && workspace.definition.contextAuthority === authority;
  const allowed = sameAuthority && !denied && !cleared.current && workspace.definition.available;
  const valid = useCallback((token: number) => alive.current && !cleared.current && sequence.current === token && current.current.authority === authority, [authority]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { cleared.current = true; sequence.current++; controller.current?.abort(); setCandidates(null); setSelection(null); setReading(false); setError(""); current.current.onChange(null); };
    window.addEventListener(AGENT_NATIVE_V3_CLEAR_EVENT, clear);
    window.addEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, clear);
    return () => { alive.current = false; sequence.current++; controller.current?.abort(); window.removeEventListener(AGENT_NATIVE_V3_CLEAR_EVENT, clear); window.removeEventListener(AGENT_NATIVE_V4_CLEAR_EVENT,clear); };
  }, [authority]);
  function emit(value: AgentFulfillmentSelection | null, nextKind: AgentFulfillmentKind) {
    current.current.onChange(null);
    if (!allowed || !current.current.enabled || !valid(sequence.current) || !value || !workspace.sourcePermissions[nextKind]) return;
    const parsed = AgentNativeV3BindingSchema.safeParse({ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId: value.orderId, expectedSequence: value.expectedSequence, kind: nextKind } });
    if (parsed.success && parsed.data.tool === AGENT_FULFILLMENT_TOOL) current.current.onChange(parsed.data);
  }
  function changeFilters(value: AgentFulfillmentCandidatesQuery["filters"]) {
    sequence.current++; controller.current?.abort(); current.current.onChange(null); setFilters(value); setCandidates(null); setSelection(null); setReading(false); setError("");
  }
  async function read() {
    if (!allowed || !current.current.enabled || !valid(sequence.current)) return;
    const token = ++sequence.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    current.current.onChange(null); setCandidates(null); setSelection(null); setReading(true); setError("");
    try {
      const value = await readAgentFulfillmentCandidates({ version: AGENT_FULFILLMENT_VERSION, filters }, authority, abort.signal);
      if (valid(token) && !abort.signal.aborted) setCandidates(value);
    } catch (failure) {
      if (!valid(token) || abort.signal.aborted) return;
      if (agentFulfillmentReadDenied(failure)) { setCandidates(null); setSelection(null); setDenied(true); current.current.onChange(null); current.current.onDenied(); }
      else setError(failure instanceof AgentFulfillmentRequestError ? failure.message : "原订单候选暂不可核对 不使用替代编号");
    } finally { if (valid(token)) setReading(false); }
  }
  if (!allowed) return <p className="al-warning" role="status">当前原订单履约读取权限尚未核对或已变化 已隐藏旧候选与选择</p>;
  return <div className="agent-fulfillment native-fulfillment-binding">
    <AgentFulfillmentContext pinned={false} selection={selection} filters={filters} candidates={candidates} reading={reading} error={error} enabled={enabled && !reading}
      onFiltersChange={changeFilters} onRead={() => void read()} onSelect={value => { if (allowed && valid(sequence.current)) { setSelection(value); emit(value, kind); } }} />
    <label>本单履约来源<select aria-label="本单履约来源" disabled={!enabled || reading} value={kind} onChange={event => { const value = event.target.value as AgentFulfillmentKind; setKind(value); emit(selection, value); }}>
      {Object.entries(agentFulfillmentKindLabels).map(([value, label]) => <option key={value} value={value} disabled={!workspace.sourcePermissions[value as AgentFulfillmentKind]}>{label}{!workspace.sourcePermissions[value as AgentFulfillmentKind] ? " · 当前不可读取" : ""}</option>)}
    </select></label>
    {!workspace.sourcePermissions[kind] && <p className="al-warning">当前没有这类原来源读取权限 请明确选择另一受权来源 不把缺权限当作没有记录</p>}
    {!workspace.sourcePermissions.factory && <p className="al-muted">工厂文件来源的读取权限不足 生产来源中该部分会保持不可读 不推断工厂状态</p>}
    <p className="al-muted">同一真实订单可分别加入生产 发货和物流三个来源范围 仍为同一个履约工具 每类来源按原索引串行读取 读尽索引也不证明业务事实完整 不预留产能 不记录发货</p>
  </div>;
}
