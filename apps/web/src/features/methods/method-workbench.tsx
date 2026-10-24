"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { RefreshCw, Search, BookOpen, ArrowUpRight } from "lucide-react";
import {
  AgentMethodWorkspaceSchema,
  type AgentMethodWorkspace,
} from "@yummyai/contracts/harness/methods";
import { methodRequest, methodAccessDenied } from "./method-api";
import { methodItems, methodStatus, draftStatus } from "./method-model";
import { MethodPanel } from "./method-panel";
import { observeViewTransition } from "../navigation/view-transition";
import "../order-centers/order-centers.css";
import "./methods.css";

export function MethodWorkbench() {
  const query = useSearchParams(),
    [data, setData] = useState<AgentMethodWorkspace | null>(null),
    [loading, setLoading] = useState(true),
    [fresh, setFresh] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState<string | null>(null);
  const epoch = useRef(0),
    sequence = useRef(0),
    controller = useRef<AbortController | null>(null),
    opened = useRef<string | null>(null),
    transition = useRef<ViewTransition | null>(null);
  const deny = useCallback((message: string) => {
    epoch.current++;
    transition.current?.skipTransition();
    controller.current?.abort();
    setData(null);
    setSelected(null);
    setSearch("");
    setFilter("all");
    setFresh(false);
    setNotice("");
    setError(message);
    setLoading(false);
  }, []);
  const load = useCallback(
    async (foreground = true) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const generation = epoch.current,
        request = ++sequence.current;
      if (foreground) setLoading(true);
      try {
        const value = AgentMethodWorkspaceSchema.parse(
          await methodRequest("workspace", undefined, abort.signal),
        );
        if (generation !== epoch.current || request !== sequence.current || abort.signal.aborted)
          return;
        setData(value);
        setFresh(true);
        setError("");
      } catch (cause) {
        if (abort.signal.aborted || generation !== epoch.current || request !== sequence.current)
          return;
        if (methodAccessDenied(cause)) {
          deny(cause instanceof Error ? cause.message : "当前账号无法读取方法库");
          return;
        }
        setFresh(false);
        setError(cause instanceof Error ? cause.message : "读取方法失败");
      } finally {
        if (generation === epoch.current && request === sequence.current && !abort.signal.aborted)
          setLoading(false);
      }
    },
    [deny],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load(false);
    }, 30000);
    const focus = () => {
      if (!document.hidden) void load(false);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      epoch.current++;
      transition.current?.skipTransition();
      controller.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [load]);
  useEffect(() => {
    const key = query.get("method");
    if (!data || !key || opened.current === key) return;
    opened.current = key;
    if (methodItems(data).some((item) => item.key === key)) setSelected(key);
    else setError("指定方法不在当前组织可读的目录中");
  }, [data, query]);
  const items = data ? methodItems(data) : [],
    visible = items.filter(
      (item) =>
        (item.label + " " + item.key).toLowerCase().includes(search.toLowerCase()) &&
        (filter === "all" ||
          filter === methodStatus(item) ||
          (filter === "review" && item.row?.state === "in_review")),
    );
  const item = items.find((value) => value.key === selected);
  function changeFilter(value: string) {
    transition.current?.skipTransition();
    const change = () => setFilter(value);
    if (
      document.startViewTransition &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      transition.current = observeViewTransition(
        document.startViewTransition(() => flushSync(change)),
      );
    else change();
  }
  return (
    <main className="oc-page oc-workbench method-page">
      <header className="oc-header">
        <div>
          <h1>方法库</h1>
          <p>核对团队说明、引用依据和使用版本</p>
        </div>
        <div className="method-actions">
          <Link className="oc-button" href="/knowledge">
            <BookOpen size={15} />
            运营知识库
          </Link>
          <button className="oc-button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} />
            重新读取
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="oc-error">
          {error}
          {data && !fresh && " · 当前内容尚未重新核验，写入已暂停"}
        </p>
      )}
      {notice && (
        <p role="status" className="oc-notice">
          {notice}
        </p>
      )}
      {loading && !data && (
        <div role="status" className="method-skeleton">
          <span />
          <span />
          <span />
          正在读取方法和发布版本…
        </div>
      )}
      {data && (
        <>
          <div className="method-toolbar">
            <label className="method-search">
              <Search size={15} />
              <span className="sr-only">搜索方法</span>
              <input
                aria-label="搜索方法"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索名称"
              />
            </label>
            <label>
              查看状态
              <select
                aria-label="查看方法状态"
                value={filter}
                onChange={(event) => changeFilter(event.target.value)}
              >
                <option value="all">全部方法</option>
                <option value="review">待审核</option>
                {["内置默认", "已启用", "已停用", "来源待复核", "版本不受支持"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <span className="method-count">
              显示 {visible.length} / {items.length} 种方法
            </span>
          </div>
          {!visible.length ? (
            <p className="oc-empty">没有匹配的方法，请调整名称或状态</p>
          ) : (
            <table className="method-table">
              <thead>
                <tr>
                  <th>方法</th>
                  <th>当前使用</th>
                  <th>最新团队版本</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((value) => (
                  <tr key={value.key}>
                    <td>
                      <button className="method-name" onClick={() => setSelected(value.key)}>
                        {value.label}
                      </button>
                      <p>
                        {value.catalog
                          ? `${value.catalog.steps.length} 个固定步骤`
                          : "历史执行版本"}
                      </p>
                    </td>
                    <td>
                      <span
                        className={`method-status ${methodStatus(value) === "已启用" ? "is-active" : ""}`}
                      >
                        {methodStatus(value)}
                      </span>
                      <p>
                        {value.row?.activeVersion
                          ? `团队版本 v${value.row.activeVersion}`
                          : value.row?.adoptedAt
                            ? "新任务已停止使用"
                            : "尚未采用团队版本"}
                      </p>
                    </td>
                    <td>
                      <span>{draftStatus(value.row)}</span>
                      <p>{value.row ? `v${value.row.latestVersion}` : "可查看后创建草稿"}</p>
                    </td>
                    <td>
                      <button
                        aria-label={`查看${value.label}`}
                        className="oc-button"
                        onClick={() => setSelected(value.key)}
                      >
                        查看
                        <ArrowUpRight size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="oc-hint method-caption">
            保存草稿不会启用方法 · 发布影响新任务 · 制作审核和生产放行仍由业务流程完成
          </p>
        </>
      )}
      {data && item && (
        <MethodPanel
          key={item.key}
          item={item}
          canManage={data.canManage}
          canPublish={data.canPublish}
          fresh={fresh}
          initialVersion={Number(query.get("version")) || undefined}
          onClose={() => setSelected(null)}
          onDenied={deny}
          onChanged={async (message) => {
            setNotice(message);
            await load();
          }}
        />
      )}
    </main>
  );
}
