"use client";
import { ManufacturingDeliverySummary, manufacturingQuantityUnit } from "../manufacturing-recipes/manufacturing-delivery-summary";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  Download,
  Factory,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  FactoryWorkItemListSchema,
  FactoryWorkItemViewSchema,
  type FactoryWorkItemView,
} from "@yummyai/contracts/suppliers/factory-portal";
import "./factory-portal.css";
import { useFactoryViewTransition } from "./factory-view-transition";
import { FactoryPortalSessionViewSchema } from "@yummyai/contracts/suppliers/factory-quantity";

const states = {
  pending: "待接收",
  submitted: "已提交",
  received: "已接收",
  accepted: "已接受",
  rejected: "已拒收",
};
class PortalReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: "factory_authority_changed" | null = null,
  ) {
    super(message);
  }
}
async function request(path: string, signal?: AbortSignal, input?: unknown) {
  const response = await fetch(`/api/factory-portal/${path}`, {
    method: input === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: input === undefined ? undefined : { "content-type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new PortalReadError(
      response.status,
      typeof error?.message === "string" ? error.message : "当前资料暂时无法核对 请重试",
      error?.code === "factory_authority_changed" ? "factory_authority_changed" : null,
    );
  }
  return response.json() as Promise<unknown>;
}
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const portalDenied = (error: unknown) => error instanceof PortalReadError &&
  ([401, 403, 404].includes(error.status) || error.code === "factory_authority_changed");
type PortalSession = ReturnType<typeof FactoryPortalSessionViewSchema.parse>;
export function FactoryPortalClient() {
  const [items, setItems] = useState<FactoryWorkItemView[]>([]),
    [selection, setSelected] = useState<FactoryWorkItemView | null>(null),
    [target, setTarget] = useState<string | null>(null),
    [session, setSession] = useState<PortalSession | null>(null),
    [dataAuthority, setDataAuthority] = useState(""),
    [next, setNext] = useState<string | null>(null),
    [trail, setTrail] = useState<(string | undefined)[]>([undefined]),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [signedIn, setSignedIn] = useState<boolean | null>(null),
    [exitState, setExitState] = useState<"idle" | "pending" | "failed">("idle"),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0),
    [draftEpoch, setDraftEpoch] = useState(0);
  const generation = useRef(0),
    active = useRef<AbortController | null>(null),
    selectedId = useRef<string | null>(null),
    selectedButton = useRef<HTMLButtonElement | null>(null),
    mounted = useRef(true),
    leaving = useRef(false),
    currentSession = useRef<PortalSession | null>(null),
    { cancel } = useFactoryViewTransition();
  const clear = useCallback(() => {
    cancel();
    selectedId.current = null;
    selectedButton.current = null;
    setItems([]);
    setSelected(null);
    setTarget(null);
    setDataAuthority("");
    setNext(null);
    setDraftEpoch((value) => value + 1);
  }, [cancel]);
  const read = useCallback(async () => {
    if (leaving.current) return;
    const version = ++generation.current;
    active.current?.abort();
    const abort = new AbortController();
    active.current = abort;
    setLoading(true);
    setError("");
    try {
      const session = FactoryPortalSessionViewSchema.parse(await request("session", abort.signal));
      if (version !== generation.current) return;
      if (currentSession.current && currentSession.current.contextAuthority !== session.contextAuthority) clear();
      currentSession.current = session;
      setSession(session);
      setSignedIn(true);
      if (!session.canRead) {
        clear();
        setError("当前账户尚无有效工厂任务授权 请联系运营");
        return;
      }
      const params = new URLSearchParams({ status: filter, limit: "25" });
      if (query) params.set("q", query);
      if (trail.at(-1)) params.set("cursor", trail.at(-1)!);
      const list = FactoryWorkItemListSchema.parse(
        await request(`work-items?${params}`, abort.signal),
      );
      if (version !== generation.current) return;
      let detail: FactoryWorkItemView | null = null;
      const detailId = selectedId.current;
      if (detailId)
        detail = FactoryWorkItemViewSchema.parse(
          await request(`work-items/${detailId}`, abort.signal),
        );
      if (version !== generation.current) return;
      const after = FactoryPortalSessionViewSchema.parse(await request("session", abort.signal));
      if (version !== generation.current || detailId !== selectedId.current) return;
      if (after.contextAuthority !== session.contextAuthority || !after.canRead ||
        after.canRespond !== session.canRespond) {
        clear(); currentSession.current = after; setSession(after);
        setError("当前本人或协作权限已变化 旧资料和填写已隐藏 请重新读取");
        return;
      }
      if (detail && detail.id !== detailId) throw new PortalReadError(502, "任务详情与所选任务不一致 请重新读取");
      setItems(list.items);
      setNext(list.nextCursor);
      setSelected(detail);
      setDataAuthority(session.contextAuthority);
      if (detail && !detail.file) setDraftEpoch((value) => value + 1);
    } catch (reason) {
      if (abort.signal.aborted || version !== generation.current) return;
      if (portalDenied(reason)) {
        clear(); currentSession.current = null; setSession(null);
      }
      setError(reason instanceof Error ? reason.message : "当前状态无法核对");
      if (reason instanceof PortalReadError && reason.status === 401) setSignedIn(false);
    } finally {
      if (version === generation.current && mounted.current) setLoading(false);
    }
  }, [clear, filter, query, trail]);
  const deny = useCallback(() => {
    generation.current++; active.current?.abort(); clear(); currentSession.current = null; setSession(null);
    setLoading(false); setError("当前本人或任务授权已变化 私有资料和填写已清除 请重新读取");
    setReload(value => value + 1);
  }, [clear]);
  useEffect(() => {
    mounted.current = true;
    void read();
    const check = () => {
      if (document.visibilityState !== "hidden") void read();
    };
    const timer = window.setInterval(check, 30000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      mounted.current = false;
      generation.current++;
      active.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [read, reload]);
  function choose(id: string, button: HTMLButtonElement) {
    generation.current++;
    active.current?.abort();
    cancel();
    selectedButton.current = button;
    selectedId.current = id;
    setTarget(id);
    setSelected(null);
    setDraftEpoch((value) => value + 1);
    setReload((value) => value + 1);
  }
  function closeDetail() {
    generation.current++;
    active.current?.abort();
    cancel();
    selectedId.current = null;
    setTarget(null);
    setSelected(null);
    setLoading(false);
    setDraftEpoch((value) => value + 1);
    selectedButton.current?.focus({ preventScroll: true });
  }
  async function signOut() {
    if (exitState === "pending") return;
    leaving.current = true;
    generation.current++;
    active.current?.abort();
    clear();
    currentSession.current = null;
    setSession(null);
    setSignedIn(null);
    setLoading(false);
    setError("");
    setExitState("pending");
    try {
      const response = await fetch("/api/factory-auth/logout", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) throw Error();
      setSignedIn(false);
      setExitState("idle");
    } catch {
      setExitState("failed");
      setError("退出状态尚未确认 请重试退出");
    }
  }
  const visible = session?.canRead === true && dataAuthority === session.contextAuthority;
  const selected = visible && selection?.id === target && selectedId.current === target ? selection : null;
  const visibleItems = visible ? items : [];
  return (
    <main className="fp-shell">
      <header className="fp-header">
        <div className="fp-brand">
          <Factory size={24} />
          <div>
            <h1>工厂协作</h1>
            <p>核对分配文件 跟进制作回执</p>
          </div>
        </div>
        <div className="fp-actions">
          {signedIn && (
            <button type="button" onClick={() => void signOut()}>
              <LogOut size={16} />
              退出协作
            </button>
          )}
          <button
            type="button"
            disabled={loading || leaving.current}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="fp-alert">
          {error}
        </p>
      )}
      {exitState !== "idle" ? (
        <section className="fp-empty" aria-live="polite">
          <LogOut size={32} />
          <h2>{exitState === "pending" ? "正在退出协作账户" : "退出状态尚未确认"}</h2>
          <p>制作文件和任务详情已隐藏</p>
          {exitState === "failed" && (
            <button className="fp-primary" type="button" onClick={() => void signOut()}>
              重试退出
            </button>
          )}
        </section>
      ) : signedIn === false ? (
        <section className="fp-empty">
          <ShieldCheck size={32} />
          <h2>登录工厂协作账户</h2>
          <p>登录后查看运营分配给你的制作文件</p>
          <a className="fp-primary" href="/api/factory-auth/login">
            登录协作
          </a>
        </section>
      ) : (
        <>
          <form
            className="fp-filters"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              generation.current++;
              active.current?.abort();
              cancel();
              selectedId.current = null;
              setTarget(null);
              setSelected(null);
              setTrail([undefined]);
              setQuery(String(data.get("q") ?? "").trim());
              setFilter(String(data.get("status") ?? "all"));
              setReload((value) => value + 1);
            }}
          >
            <label>
              任务或工厂
              <input name="q" placeholder="输入任务编号或工厂名称" maxLength={100} />
            </label>
            <label>
              回执状态
              <select name="status" defaultValue="all">
                <option value="all">全部状态</option>
                {Object.entries(states).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={loading}>查询</button>
          </form>
          <div className={`fp-workspace${selected ? " has-detail" : ""}`}>
            <section aria-label="分配的工厂任务" className="fp-list">
              <div className="fp-list-head">
                <h2>我的制作任务</h2>
                <span>{loading ? "正在核对当前授权" : `本页 ${visibleItems.length} 项`}</span>
              </div>
              {!visibleItems.length && !loading ? (
                <p className="fp-empty-text">当前没有可读取的分配任务</p>
              ) : (
                <ul>
                  {visibleItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`fp-task ${selectedId.current === item.id ? "selected" : ""}`}
                        onClick={(event) => choose(item.id, event.currentTarget)}
                      >
                        <div>
                          <strong>{item.reference}</strong>
                          <span>{states[item.status]}</span>
                        </div>
                        <p>{item.factoryName}</p>
                        <p>
                          {item.manufacturing
                            ? `${item.manufacturing.quantity} ${manufacturingQuantityUnit(item.manufacturing.recipe?.unit)} · 预计 ${date(item.manufacturing.expectedCompletionAt)}`
                            : "制作资料当前不可用"}
                        </p>
                        {item.blockers.length > 0 && <small>{item.blockers.join("；")}</small>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="fp-pagination">
                <button
                  type="button"
                  disabled={loading || trail.length < 2}
                  onClick={() => {
                    generation.current++;
                    active.current?.abort();
                    cancel();
                    selectedId.current = null;
                    setTarget(null);
                    setSelected(null);
                    setTrail((value) => value.slice(0, -1));
                  }}
                >
                  <ChevronLeft size={15} />
                  上一页
                </button>
                <button
                  type="button"
                  disabled={loading || !next}
                  onClick={() => {
                    generation.current++;
                    active.current?.abort();
                    cancel();
                    selectedId.current = null;
                    setTarget(null);
                    setSelected(null);
                    setTrail((value) => [...value, next!]);
                  }}
                >
                  下一页
                </button>
              </div>
            </section>
            {selected && (
              <section
                className="fp-detail"
                aria-label="工厂任务详情"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    closeDetail();
                  }
                }}
              >
                <header>
                  <div>
                    <h2>{selected.reference}</h2>
                    <p>
                      {selected.factoryName} · {states[selected.status]}
                    </p>
                  </div>
                  <button type="button" onClick={closeDetail}>
                    关闭
                  </button>
                </header>
                {selected.blockers.length > 0 && (
                  <p role="status" className="fp-alert">
                    {selected.blockers.join("；")}
                  </p>
                )}
                {selected.manufacturing && (
                  <dl className="fp-facts">
                    <div>
                      <dt>制作数量</dt>
                      <dd>{selected.manufacturing.quantity} {manufacturingQuantityUnit(selected.manufacturing.recipe?.unit)}</dd>
                    </div>
                    <div>
                      <dt>主体最长边</dt>
                      <dd>{selected.manufacturing.sizeMm} mm</dd>
                    </div>
                    <div>
                      <dt>印制面数</dt>
                      <dd>{selected.manufacturing.sideMode === "single" ? "单面" : "双面"}</dd>
                    </div>
                    <div>
                      <dt>裁线最窄处</dt>
                      <dd>至少 {selected.manufacturing.minimumNeckMm} mm</dd>
                    </div>
                    <div>
                      <dt>预计完工</dt>
                      <dd>{date(selected.manufacturing.expectedCompletionAt)}</dd>
                    </div>
                    <div>
                      <dt>生产标准</dt>
                      <dd>{selected.manufacturing.factoryStandardId}</dd>
                    </div>
                  </dl>
                )}
                {selected.manufacturing && <ManufacturingDeliverySummary plan={selected.manufacturing.recipe} instructions={selected.manufacturing.instructions} />}
                {selected.file && (
                  <div className="fp-file">
                    <strong>本任务正式 JPG</strong>
                    <p className="fp-checksum">SHA-256 {selected.file.checksum}</p>
                    <p>
                      {(selected.file.byteSize / 1024 / 1024).toFixed(2)} MiB · 有效至{" "}
                      {date(selected.expiresAt)}
                    </p>
                    {!selected.blockers.length ? (
                      <a
                        className="fp-primary"
                        href={`/api/factory-portal/work-items/${selected.id}/file`}
                      >
                        <Download size={16} />
                        下载原制作文件
                      </a>
                    ) : (
                      <span>当前不能下载 请联系运营核对</span>
                    )}
                  </div>
                )}
                {session?.canRespond && selected.canRespond && selected.file ? (
                  <FactoryFeedbackForm
                    key={`${session.contextAuthority}:${selected.id}:${draftEpoch}`}
                    task={selected}
                    onChanged={() => setReload((value) => value + 1)}
                    onDenied={deny}
                  />
                ) : (
                  <p className="fp-note">当前任务没有可提交的回执操作</p>
                )}
                <section className="fp-receipts" aria-label="本任务回执">
                  <h3>回执记录</h3>
                  {selected.receipts.length ? (
                    selected.receipts.map((receipt) => (
                      <article key={receipt.id}>
                        <p>
                          <strong>{states[receipt.kind]}</strong> · {date(receipt.occurredAt)} ·{" "}
                          {receipt.origin === "factory" ? "工厂端回执" : "运营登记"}
                        </p>
                        <p>{receipt.note}</p>
                        <small>
                          依据 {receipt.reference}
                          {receipt.affectedQuantity !== null
                            ? ` · 涉及 ${receipt.affectedQuantity} 件`
                            : ""}
                        </small>
                      </article>
                    ))
                  ) : (
                    <p>尚无接收或接受记录</p>
                  )}
                  {selected.receiptsTruncated && <p>仅显示最近 1000 条 请联系运营核对更早历史</p>}
                </section>
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}
function FactoryFeedbackForm({
  task,
  onChanged,
  onDenied,
}: {
  task: FactoryWorkItemView;
  onChanged: () => void;
  onDenied: () => void;
}) {
  const [base, setBase] = useState(task.sequence),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    pending = useRef<Record<string, unknown> | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function send(input: Record<string, unknown>, form?: HTMLFormElement) {
    if (busy) return;
    pending.current = input;
    setBusy(true);
    setError("");
    try {
      await request(`work-items/${task.id}/feedback`, undefined, input);
      if (!alive.current) return;
      pending.current = null;
      form?.reset();
      onChanged();
    } catch (reason) {
      if (!alive.current) return;
      if (portalDenied(reason)) {
        onDenied();
        return;
      }
      if (reason instanceof PortalReadError && [400, 409].includes(reason.status))
        pending.current = null;
      setError(reason instanceof Error ? reason.message : "回执状态无法确认 请保留本次输入后重试");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form),
      kind = String(data.get("kind"));
    try {
      void send(
        {
          kind,
          expectedSequence: base,
          fileChecksum: task.file!.checksum,
          manufacturingChecksum: task.manufacturing?.recipe?.checksum,
          idempotencyKey: crypto.randomUUID(),
          reference: String(data.get("reference")),
          note: String(data.get("note")),
          occurredAt: new Date(String(data.get("at"))).toISOString(),
          confirmedFileVersion: data.get("confirmed") === "on",
          affectedQuantity: kind === "rejected" ? Number(data.get("quantity")) : null,
        },
        form,
      );
    } catch {
      setError("请核对实际发生时间");
    }
  }
  return (
    <form className="fp-feedback" aria-label="提交工厂回执" onSubmit={submit}>
      <h3>核对原文件并回复</h3>
      <p>接受文件后仍按运营确认的生产安排制作</p>
      <fieldset disabled={busy || pending.current !== null || base !== task.sequence}>
        <label>
          本次回复
          <select name="kind" defaultValue={task.status === "received" ? "accepted" : "received"}>
            {["pending", "submitted"].includes(task.status) && (
              <option value="received">已收到文件</option>
            )}
            {task.status === "received" && <option value="accepted">接受该版本文件</option>}
            <option value="rejected">拒收该版本文件</option>
          </select>
        </label>
        <label>
          实际发生时间
          <input name="at" type="datetime-local" required defaultValue={localNow()} />
        </label>
        <label>
          回执依据
          <input name="reference" required maxLength={200} placeholder="填写本次核对依据" />
        </label>
        <label>
          涉及数量（拒收时填写）
          <input
            name="quantity"
            type="number"
            min={1}
            max={task.manufacturing?.quantity ?? 1}
            defaultValue={task.manufacturing?.quantity ?? 1}
          />
        </label>
        <label className="fp-wide">
          回复说明
          <textarea name="note" required minLength={5} maxLength={2000} rows={3} />
        </label>
        <label className="fp-confirm fp-wide">
          <input name="confirmed" type="checkbox" required />
          {task.manufacturing?.recipe ? "我已核对本任务文件、制造清单校验值和制作数量" : "我已核对本任务文件校验值和制作数量"}
        </label>
        <button className="fp-primary" disabled={busy}>
          <Check size={15} />
          {busy ? "正在登记" : "提交回执"}
        </button>
      </fieldset>
      {pending.current && !busy && (
        <p role="status">
          上次回执结果尚未确认
          <button type="button" onClick={() => void send(pending.current!)}>
            重试原回执
          </button>
        </p>
      )}
      {base !== task.sequence && !pending.current && (
        <p role="status">
          回执已有更新 请核对记录后
          <button
            type="button"
            onClick={() => {
              setBase(task.sequence);
              setError("");
            }}
          >
            重新核对
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="fp-alert">
          {error}
        </p>
      )}
    </form>
  );
}
function localNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
