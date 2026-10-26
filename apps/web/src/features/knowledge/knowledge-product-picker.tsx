"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import type { KnowledgeProductOptions } from "@yummyai/contracts/knowledge";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { useErpAccess } from "../identity/erp-access";
import { knowledgeReadDenied } from "./knowledge-api";
import { readKnowledgeProductOptions } from "./knowledge-product-options-client";
import "./knowledge-product-picker.css";

export function KnowledgeProductPicker({ authority, value, enabled, disabled = false, onChange, onDenied }: {
  authority: string; value: string; enabled: boolean; disabled?: boolean;
  onChange(value: string): void; onDenied(): void;
}) {
  const access = useErpAccess(), allowed = enabled && access.can(Permission.ProductRead);
  const [query, setQuery] = useState(""), [requested, setRequested] = useState(""), [reload, setReload] = useState(0);
  const [snapshot, setSnapshot] = useState<{ stamp: string; data: KnowledgeProductOptions | null; reading: boolean; error: string } | null>(null);
  const [cleared, setCleared] = useState(false);
  const stamp = JSON.stringify([authority, allowed, requested, reload]);
  const live = useRef({ authority: access.authority, allowed, stamp, query: query.trim(), value });
  live.current = { authority: access.authority, allowed, stamp, query: query.trim(), value };
  const callbacks = useRef({ change: onChange, denied: onDenied }); callbacks.current = { change: onChange, denied: onDenied };
  const alive = useRef(true), purged = useRef(false), sequence = useRef(0), active = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => {
      purged.current = true; sequence.current++; active.current?.abort(); setSnapshot(null); setQuery(""); setRequested(""); setCleared(true);
      callbacks.current.change("");
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; sequence.current++; active.current?.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, []);
  useLayoutEffect(() => {
    if (!allowed || access.authority !== authority) {
      sequence.current++; active.current?.abort(); setSnapshot(null); setQuery(""); setRequested("");
      if (live.current.value) callbacks.current.change("");
    }
  }, [allowed, access.authority, authority]);
  useEffect(() => {
    const token = ++sequence.current, abort = new AbortController(); active.current = abort;
    const valid = () => alive.current && !purged.current && !abort.signal.aborted && token === sequence.current &&
      live.current.authority === authority && live.current.allowed && live.current.stamp === stamp && live.current.query === requested;
    if (!allowed || purged.current || live.current.authority !== authority) return () => abort.abort();
    setSnapshot({ stamp, data: null, reading: true, error: "" });
    void readKnowledgeProductOptions(requested, authority, abort.signal).then(data => {
      if (valid()) setSnapshot({ stamp, data, reading: false, error: "" });
    }).catch(failure => {
      if (!valid()) return;
      setSnapshot({ stamp, data: null, reading: false, error: knowledgeReadDenied(failure)
        ? "当前产品读取权限已变化 原候选已隐藏" : "产品候选暂不可读取 请重新搜索或读取" });
      callbacks.current.change("");
      if (knowledgeReadDenied(failure)) callbacks.current.denied();
    });
    return () => { abort.abort(); sequence.current++; };
  }, [allowed, authority, requested, reload, stamp]);
  const pending = query.trim() !== requested;
  const saved = !cleared && !purged.current && allowed && access.authority === authority && !pending && snapshot?.stamp === stamp ? snapshot : null;
  const data = saved?.data, selected = data?.items.find(item => item.id === value);
  const waiting = allowed && !pending && !!saved?.reading && active.current?.signal.aborted !== true;
  function search() {
    if (disabled || waiting || !allowed || purged.current || live.current.authority !== authority) return;
    callbacks.current.change(""); setRequested(query.trim()); setReload(previous => previous + 1);
  }
  return <section className="kb-product-picker" aria-label="知识产品选择">
    <div className="kb-product-picker-fields">
      <label><span><Search size={13} aria-hidden="true" />搜索当前可读产品</span>
        <input aria-label="搜索知识产品" maxLength={200} value={query} disabled={disabled || !allowed || cleared}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); search(); } }}
          onChange={event => { sequence.current++; active.current?.abort(); callbacks.current.change(""); setQuery(event.target.value); }} />
      </label>
      <button type="button" disabled={disabled || !allowed || cleared || waiting} onClick={search}><RefreshCw size={14} aria-hidden="true" />读取产品候选</button>
      <label>知识产品范围
        <select aria-label="知识产品范围" value={selected ? selected.id : ""} disabled={disabled || cleared}
          onChange={event => {
            if (disabled || purged.current || live.current.authority !== authority) return;
            const id = event.target.value;
            if (!id || allowed && saved?.data?.items.some(item => item.id === id)) callbacks.current.change(id);
          }}>
          <option value="">通用知识（不限定产品）</option>
          {data?.items.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
        </select>
      </label>
    </div>
    {cleared ? <p role="status">当前本人会话已清除 原产品候选已隐藏</p> : <>
      <p className="kb-product-picker-note">{selected ? `本次读取通用知识与 ${selected.code} · ${selected.name} 的产品知识` : "当前只读取通用知识 选择一个产品后加入该产品知识 不自动选择全部产品"}</p>
      {!allowed && <p className="kb-product-picker-note">当前未读取产品候选 仍可按原权限核对通用知识</p>}
      {pending && <p role="status">产品搜索词已改变 请读取新的候选 原选择与结果已清除</p>}
      {waiting && <p role="status">正在核对当前本人可读的产品候选</p>}
      {saved?.error && <p role="alert" className="kb-error">{saved.error}</p>}
      {data && <p className="kb-product-picker-note">本次返回 {data.items.length} 个产品候选 · 上限 {data.limit}{data.hasMore ? " · 还有匹配产品 请缩小搜索范围" : " · 本次匹配候选已读完"} 不代表全部历史产品</p>}
    </>}
  </section>;
}
