"use client";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { observeViewTransition } from "../navigation/view-transition";
import { AlertCircle, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { FulfillmentAttentionQuerySchema, FulfillmentAttentionViewSchema, fulfillmentAttentionLabels,
  type FulfillmentAttentionItem, type FulfillmentAttentionView } from "@yummyai/contracts/operations/fulfillment-attention";
import "./fulfillment-attention.css";

export function FulfillmentAttention() {
  const params = useSearchParams();
  const query = FulfillmentAttentionQuerySchema.safeParse({ source: params.get("attention") ?? "all", page: params.get("attentionPage") ?? 1 });
  const { source, page } = query.success ? query.data : { source: "all" as const, page: 1 };
  const [data, setData] = useState<FulfillmentAttentionView | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const transition = useRef<ViewTransition | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    const change = (update: () => void) => {
      transition.current?.skipTransition();
      if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        transition.current = document.startViewTransition(() => { if (!abort.signal.aborted) flushSync(update); });
        observeViewTransition(transition.current);
      } else if (!abort.signal.aborted) update();
    };
    setLoading(true); setError(""); setData(null);
    void (async () => {
      try {
        const response = await fetch(`/api/dashboard/fulfillment-attention?source=${source}&page=${page}`, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error(response.status === 403 ? "当前成员无权查看此类履约待办" : response.status === 401 ? "登录已失效，请重新登录" : "履约待办暂时无法读取，请重试");
        const result = FulfillmentAttentionViewSchema.parse(await response.json());
        change(() => { setData(result); setLoading(false); });
      } catch (cause) {
        change(() => { setData(null); setLoading(false); setError(cause instanceof Error ? cause.message : "履约待办暂时无法读取，请重试"); });
      }
    })();
    return () => { abort.abort(); transition.current?.skipTransition(); };
  }, [source, page, refresh]);
  // Reading on focus/interval never dispatches business operations. Hidden tabs pause.
  useEffect(() => {
    const refreshVisible = () => { if (document.visibilityState === "visible") setRefresh(value => value + 1); };
    const timer = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshVisible); };
  }, []);
  function navigate(nextSource: string, nextPage = 1) {
    const next = new URLSearchParams(params); next.set("attention", nextSource);
    if (nextPage === 1) next.delete("attentionPage"); else next.set("attentionPage", String(nextPage));
    const commit = () => window.history.pushState(null, "", `?${next}#fulfillment-attention`);
    transition.current?.skipTransition();
    if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      transition.current = document.startViewTransition(() => flushSync(commit));
      observeViewTransition(transition.current);
    } else commit();
  }
  const restricted = data?.sources.filter(item => !item.available) ?? [];
  return <section className="fulfillment-attention" id="fulfillment-attention" aria-label="履约待办" aria-busy={loading}>
    <div className="fa-heading"><div><h3>履约待办</h3><p>当前未完成事项 · 优先处理异常，再核对交期</p></div><button type="button" aria-label="刷新履约待办" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />刷新</button></div>
    <div className="fa-filters" aria-label="履约待办分类">
      <button type="button" aria-pressed={source === "all"} disabled={loading} onClick={() => navigate("all")}>全部</button>
      {(data?.sources ?? Object.keys(fulfillmentAttentionLabels).map(key => ({ source: key as keyof typeof fulfillmentAttentionLabels, available: true, count: null }))).map(item => <button type="button" key={item.source} aria-pressed={source === item.source} disabled={loading || !item.available} onClick={() => navigate(item.source)}>{fulfillmentAttentionLabels[item.source]}<span>{item.available ? item.count ?? "—" : "无权限"}</span></button>)}
    </div>
    {loading ? <div className="fa-loading" role="status"><span>正在读取履约待办</span><i /><i /></div>
      : error ? <div className="fa-state fa-error" role="alert"><AlertCircle size={18} /><p>{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>重新读取</button></div>
      : data && <>
        {restricted.length > 0 && <p className="fa-scope">仅显示当前权限可见的事项；{restricted.map(item => fulfillmentAttentionLabels[item.source]).join("、")}未开放</p>}
        {data.items.length ? <ol className="fa-list">{data.items.map(item => <AttentionItem item={item} key={item.id} />)}</ol>
          : <div className="fa-state" role="status"><CheckCircle2 size={19} /><p>{page > 1 ? "这一页已无待办，可返回第一页查看最新记录" : data.sources.every(item => !item.available) ? "当前成员尚无履约待办查看权限" : "当前可见范围没有待处理的履约事项"}</p>{page > 1 && <button type="button" onClick={() => navigate(source)}>返回第一页</button>}</div>}
        <div className="fa-footer"><span>{data.total} 项 · 第 {data.page} 页 · {new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新</span><div><button type="button" aria-label="上一页履约待办" disabled={page <= 1} onClick={() => navigate(source, page - 1)}><ChevronLeft size={16} /></button><button type="button" aria-label="下一页履约待办" disabled={!data.hasMore} onClick={() => navigate(source, page + 1)}><ChevronRight size={16} /></button></div></div>
      </>}
  </section>;
}

function AttentionItem({ item }: { item: FulfillmentAttentionItem }) {
  return <li className="fa-item" data-priority={item.priority} style={{ viewTransitionName: `attention-${item.source}-${item.entityId}` }}>
    <div className="fa-item-main"><small>{fulfillmentAttentionLabels[item.source]} · {({ blocked: "需要处理", overdue: "超过预计交期", pending: "等待处理" })[item.priority]}</small><strong>{item.title}</strong><p>{item.reason}</p></div>
    <div className="fa-item-date">{item.dueAt ? <>预计完工<time dateTime={item.dueAt}>{formatDate(item.dueAt)}</time></> : <>最近更新<time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time></>}</div>
    <Link href={item.href}>{item.nextAction}<ArrowRight size={14} /></Link>
  </li>;
}
function formatDate(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); }
