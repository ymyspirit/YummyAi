"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { AgentResourceCandidateSchema, AgentResourceCandidates, AgentResourceCandidatesQuery } from "@yummyai/contracts/ai/agent-resources";
import type { z } from "zod";
import { useErpAccess } from "../identity/erp-access";
import { AgentResourceRequestError, agentResourceReadDenied, readAgentResourceCandidates } from "./agent-resource-client";

export type ResourceCandidate = z.infer<typeof AgentResourceCandidateSchema>;
type SavedPage = { query: AgentResourceCandidatesQuery; value: AgentResourceCandidates };
export function AgentResourceObjectPicker({ query, authority, enabled, disabled, selected, onSelect, onDenied }: {
  query: AgentResourceCandidatesQuery; authority: string; enabled: boolean; disabled: boolean;
  selected: ResourceCandidate | null; onSelect(value: ResourceCandidate | null): void; onDenied(): void;
}) {
  const access = useErpAccess(), stamp = canonicalJson({ authority, query }), current = useRef({ stamp, authority: access.authority, enabled });
  current.current = { stamp, authority: access.authority, enabled };
  const callback = useRef({ onSelect, onDenied }); callback.current = { onSelect, onDenied };
  const initial = useRef(query); initial.current = query;
  const alive = useRef(true), sequence = useRef(0), controller = useRef<AbortController | null>(null), lock = useRef(false);
  const [snapshot, setSnapshot] = useState<{ stamp: string; pages: SavedPage[]; index: number } | null>(null), [reading, setReading] = useState(false), [error, setError] = useState("");
  const valid = useCallback((token: number) => alive.current && token === sequence.current && current.current.stamp === stamp && current.current.authority === authority && current.current.enabled, [stamp, authority]);
  const read = useCallback(async (input: AgentResourceCandidatesQuery, previous: SavedPage[]) => {
    if (lock.current || !current.current.enabled) return; lock.current = true;
    const token = ++sequence.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort; setReading(true); setError("");
    try {
      const value = await readAgentResourceCandidates(input, authority, abort.signal); if (!valid(token) || abort.signal.aborted) return;
      if (previous.some(page => canonicalJson(page.query) === canonicalJson(input))) throw new AgentResourceRequestError(502, "原候选续页重复 请从首页重新读取");
      setSnapshot({ stamp, pages: [...previous, { query: input, value }], index: previous.length });
    } catch (failure) { if (valid(token) && !abort.signal.aborted) { setError(failure instanceof AgentResourceRequestError ? failure.message : "原候选暂不可读取 请重新读取"); if (agentResourceReadDenied(failure)) { setSnapshot(null); callback.current.onDenied(); } } }
    finally { if (token === sequence.current) { lock.current = false; if (valid(token)) setReading(false); } }
  }, [authority, stamp, valid]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    sequence.current++; controller.current?.abort(); lock.current = false; setSnapshot(null); setReading(false); setError("");
    if (!enabled) return;
    const timer = setTimeout(() => void read(initial.current, []), 250);
    return () => { clearTimeout(timer); sequence.current++; controller.current?.abort(); lock.current = false; };
  }, [stamp, enabled, read]);
  const saved = enabled && access.authority === authority && snapshot?.stamp === stamp ? snapshot : null, page = saved?.pages[saved.index], last = saved?.pages.at(-1);
  let next: AgentResourceCandidatesQuery | null = null;
  if (last && (last.query.tool === "catalog.sku" || last.query.tool === "listing.version") && last.value.coverage.hasMore === true) next = { ...last.query, page: last.query.page + 1 };
  else if (last?.query.tool === "advertising.analysis" && last.query.accountId && last.value.coverage.nextCursor) next = { ...last.query, cursor: last.value.coverage.nextCursor };
  const accounts = query.tool === "advertising.analysis" && query.accountId === null, label = accounts ? "选择真实广告账户" : "选择原业务对象";
  return <section className="ar-object-picker" aria-label={accounts ? "原广告账户候选" : "原业务对象候选"} aria-busy={reading}>
    <header><h4>{accounts ? "先选择当前可读账户" : "从原拥有者候选选择"}</h4><button type="button" disabled={!enabled || disabled || reading} onClick={() => { callback.current.onSelect(null); sequence.current++; controller.current?.abort(); lock.current = false; setSnapshot(null); void read(initial.current, []); }}><RefreshCw size={14} />重新读取原候选</button></header>
    <label>{label}<select aria-label={label} value={selected?.id ?? ""} disabled={!enabled || disabled || reading || !page?.value.items.length} onChange={event => callback.current.onSelect(page?.value.items.find(item => item.id === event.target.value) ?? null)}><option value="">{reading ? "正在读取原候选" : "请选择真实原对象"}</option>{page?.value.items.map(item => <option key={item.id} value={item.id}>{item.label} · {item.detail}</option>)}</select></label>
    {reading && <p role="status">正在读取当前本人可访问的原候选</p>}{!enabled && <p>当前工具不可读取 尚未加载原候选</p>}{error && <p role="alert" className="ar-error">{error}</p>}
    {page && <><p className="ar-muted">本页 {page.value.coverage.returned} 项 · 原服务报告总数 {page.value.coverage.total ?? "未知"} · 当前候选始终为有界范围 不称全量</p><p className="ar-muted">{page.value.coverage.limitation}</p>{!page.value.items.length && <p>{next ? "本页没有可选原对象 可继续下一页" : "本次未返回可选原对象 不以空页判断全部历史不存在"}</p>}
      {(saved.pages.length > 1 || next) && <div className="ar-actions" aria-label="原候选分页"><span>已读候选页 {saved.index + 1} / {saved.pages.length}</span><button type="button" disabled={disabled || reading || saved.index === 0} onClick={() => { callback.current.onSelect(null); setSnapshot({ ...saved, index: saved.index - 1 }); }}><ChevronLeft size={14} />上一候选页</button><button type="button" disabled={disabled || reading || saved.index + 1 === saved.pages.length && !next} onClick={() => { callback.current.onSelect(null); if (saved.index + 1 < saved.pages.length) setSnapshot({ ...saved, index: saved.index + 1 }); else if (next) void read(next, saved.pages); }}>下一候选页<ChevronRight size={14} /></button></div>}
    </>}
    {selected && page?.value.items.some(item => item.id === selected.id) && <dl className="ar-pairs"><div><dt>已选原对象</dt><dd>{selected.label}<code>{selected.id}</code></dd></div><div><dt>原候选固定版本</dt><dd><code>{selected.versionId ?? "未提供版本 ID"}</code> · 修订 {selected.revision ?? "未提供"}</dd></div></dl>}
  </section>;
}
