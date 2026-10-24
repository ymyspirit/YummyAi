"use client";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { FactoryDirectorySchema } from "@yummyai/contracts/suppliers/factory-directory";
import { loadFactoryDirectory } from "../manual-operations/operation-actions";
import { useErpAccess } from "../identity/erp-access";
import { AgentToolRequestError, agentToolReadDenied, readAgentToolObjects } from "./agent-tool-client";

export type AgentToolCreativeScope = "design_batch" | "inspection" | "mockup_batch";
type Choice = { id: string; label: string };
type Common = { authority: string; value: string; disabled: boolean; enabled?: boolean; onChange(value: string): void; onDenied(): void };
type Props = Common & ({ kind: "factory" } | { kind: "creative"; scope: AgentToolCreativeScope });
export function AgentToolObjectPicker(props: Props) {
  const access = useErpAccess(), authority = props.authority;
  const allowed = props.enabled !== false && (props.kind !== "factory" || access.canTenant(Permission.OrderRead));
  const stamp = JSON.stringify([authority, props.kind, props.kind === "creative" ? props.scope : null, allowed]);
  const current = useRef({ stamp, authority: access.authority, allowed });
  current.current = { stamp, authority: access.authority, allowed };
  const callbacks = useRef({ change: props.onChange, denied: props.onDenied }); callbacks.current = { change: props.onChange, denied: props.onDenied };
  const sequence = useRef(0), alive = useRef(true), [reload, setReload] = useState(0), [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<{ stamp: string; rows: Choice[]; limit: number; error: string; reading: boolean } | null>(null);
  const kind = props.kind, scope = props.kind === "creative" ? props.scope : null;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; };
  }, []);
  useEffect(() => {
    const token = ++sequence.current, abort = new AbortController();
    const valid = () => alive.current && !abort.signal.aborted && token === sequence.current && current.current.stamp === stamp && current.current.authority === authority && current.current.allowed;
    if (!current.current.allowed) return () => abort.abort();
    setSnapshot({ stamp, rows: [], limit: 0, error: "", reading: true });
    void (async () => {
      try {
        let rows: Choice[], limit: number;
        if (kind === "creative" && scope) {
          const result = await readAgentToolObjects(scope, authority, abort.signal);
          rows = result.items; limit = result.limit;
        } else {
          // This existing server action keeps the current personal ERP identity.
          // Its transport cannot be aborted, so both generation and response authority are checked below.
          const result = await loadFactoryDirectory();
          if (!valid()) return;
          if (!result.data) {
            if (result.denied || result.statusCode && [401, 403, 404].includes(result.statusCode))
              throw new AgentToolRequestError(result.statusCode ?? 403, "当前工厂目录不可读取", result.denied && result.statusCode === 409 ? "authority_changed" : null);
            throw new AgentToolRequestError(result.statusCode ?? 502, "工厂目录暂不可读取 请重新读取或从原供应商目录核对");
          }
          const parsed = FactoryDirectorySchema.safeParse(result.data);
          if (!parsed.success) throw new AgentToolRequestError(502, "原工厂目录格式无法核对");
          if (parsed.data.contextAuthority !== authority)
            throw new AgentToolRequestError(409, "当前工厂目录权限已变化", "authority_changed");
          if (!parsed.data.access.canRead) throw new AgentToolRequestError(403, "当前没有工厂目录读取权限");
          rows = parsed.data.factories.map(factory => ({ id: factory.id,
            label: `${factory.profile.name} · ${factory.code} · ${{ draft: "草稿", active: "启用", suspended: "暂停", archived: "归档" }[factory.profile.status]} · ${factory.profile.timeZone ?? "时区未知"}` }));
          limit = 500;
        }
        if (valid()) setSnapshot({ stamp, rows, limit, error: "", reading: false });
      } catch (failure) {
        if (!valid()) return;
        setSnapshot({ stamp, rows: [], limit: 0, reading: false, error: agentToolReadDenied(failure) ? "当前对象读取权限已变化 原候选已隐藏" : "原对象候选暂不可读取 请重新读取 不填写替代 ID" });
        if (agentToolReadDenied(failure)) callbacks.current.denied();
      }
    })();
    return () => { abort.abort(); sequence.current++; };
  }, [stamp, authority, kind, scope, reload]);
  const saved = snapshot?.stamp === stamp && current.current.authority === authority && current.current.allowed ? snapshot : null;
  const choices = (saved?.rows ?? []).filter(row => (row.label + " " + row.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const label = kind === "factory" ? "选择真实工厂" : "选择已有创意对象";
  const waiting = allowed && (!saved || saved.reading);
  return <section className="atb-object-picker" aria-label={kind === "factory" ? "真实工厂选择" : "已有创意对象选择"}>
    <header><h4>{kind === "factory" ? "原工厂目录" : "原执行对象"}</h4><button type="button" disabled={props.disabled || waiting || !allowed} onClick={() => { callbacks.current.change(""); setQuery(""); setReload(value => value + 1); }}><RefreshCw size={14} />重新读取对象</button></header>
    <div className="atb-fields"><label><span><Search size={13} aria-hidden="true" />搜索已读对象</span><input aria-label="搜索已读对象" value={query} disabled={props.disabled || waiting || !allowed} onChange={event => { callbacks.current.change(""); setQuery(event.target.value); }} /></label>
      <label>{label}<select aria-label={label} value={props.value} disabled={props.disabled || waiting || !choices.length || !allowed} onChange={event => {
        if (saved?.rows.some(row => row.id === event.target.value)) callbacks.current.change(event.target.value);
        else callbacks.current.change("");
      }}><option value="">{waiting ? "正在读取原对象" : "请选择已读取的原对象"}</option>{choices.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label></div>
    {waiting && <p role="status" className="atb-muted">正在读取当前本人可访问的原对象</p>}
    {!allowed && <p className="atb-muted">当前工具或原对象读取权限不足 尚未读取候选</p>}
    {saved?.error && <p role="alert" className="atb-error">{saved.error}</p>}
    {saved && !saved.reading && !saved.error && <p className="atb-muted">已读取 {saved.rows.length} 个原对象 · 当前搜索显示 {choices.length} 个{kind === "creative" ? ` · 近期有界列表 上限 ${saved.limit} 不代表全部历史对象` : " · 原目录支持最多 500 个工厂 超出时需到供应商原目录核对"}</p>}
    {saved && !saved.reading && !saved.error && !saved.rows.length && <p>当前没有返回可选择的原对象 请先到原业务工作区核对</p>}
    {props.value && saved?.rows.some(row => row.id === props.value) && <p className="atb-muted">已选原对象 ID <code>{props.value}</code></p>}
  </section>;
}
