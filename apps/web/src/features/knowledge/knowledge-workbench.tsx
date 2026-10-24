"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen, FileUp, Plus, RefreshCw, Search } from "lucide-react";
import {
  KNOWLEDGE_TOPICS,
  KnowledgeFieldsSchema,
  KnowledgeHistorySchema,
  KnowledgeSearchResultSchema,
  KnowledgeWorkspaceSchema,
  type KnowledgeAction,
  type KnowledgeEntry,
  type KnowledgeFields,
  type KnowledgeHistory,
  type KnowledgeSearch,
  type KnowledgeSearchResult,
  type KnowledgeWorkspace,
} from "@yummyai/contracts/knowledge";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { KnowledgeVersionDiff } from "./knowledge-version-diff";
import { KnowledgeExpandedWorkbench } from "./knowledge-expanded-workbench";
import { KnowledgeEvidenceEditor } from "./knowledge-evidence-editor";
import "../order-centers/order-centers.css";
import "./knowledge.css";

const states = { draft: "草稿", in_review: "待审核", published: "已发布" };
const actions = {
  create: "新建",
  revise: "修订",
  submit: "提交审核",
  publish: "审核发布",
  reject: "退回修改",
  disable: "停用",
  archive: "归档",
};
const platforms = { all: "全部平台", amazon: "Amazon", etsy: "Etsy" };
const sourceTypes = { official: "官方资料", team: "团队 SOP", case: "复盘案例" };
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function empty(): KnowledgeFields {
  const due = new Date();
  due.setDate(due.getDate() + 90);
  return {
    title: "",
    summary: "",
    body: "",
    topic: "listing",
    platform: "all",
    market: "ALL",
    spuId: null,
    sourceType: "team",
    sourceLabel: "",
    sourceUrl: "",
    owner: "",
    verifiedOn: today(),
    reviewDueOn: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(due),
    tags: [],
  };
}
async function request(path: string, input?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/knowledge/${path}`, {
    method: input === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: input === undefined ? undefined : { "content-type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? "知识服务暂时不可用");
  return body;
}
type Command = { entry: KnowledgeEntry; action: Exclude<KnowledgeAction, "create" | "revise"> };
export function KnowledgeWorkbench() {
  const params = useSearchParams(),
    router = useRouter();
  const [data, setData] = useState<KnowledgeWorkspace | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0);
  const [tab, setTab] = useState<"library" | "search" | "imports" | "governance" | "chat">(
      params.get("tab") === "imports"
        ? "imports"
        : params.get("tab") === "governance"
          ? "governance"
          : params.get("tab") === "chat"
            ? "chat"
            : "library",
    ),
    [filter, setFilter] = useState(""),
    [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState(params.get("entry") ?? ""),
    [versionNumber, setVersionNumber] = useState(Number(params.get("version")) || 0);
  const [history, setHistory] = useState<KnowledgeHistory | null>(null),
    [historyError, setHistoryError] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; revision: number } | null>(null),
    [fields, setFields] = useState<KnowledgeFields>(empty),
    [initialFields, setInitialFields] = useState("");
  const [reason, setReason] = useState(""),
    [tags, setTags] = useState(""),
    [formError, setFormError] = useState("");
  const [command, setCommand] = useState<Command | null>(null),
    [commandReason, setCommandReason] = useState("");
  const [search, setSearch] = useState<KnowledgeSearch>({
    query: "",
    topic: "listing",
    platform: "all",
    market: "ALL",
    spuIds: [],
  });
  const [results, setResults] = useState<KnowledgeSearchResult | null>(null);
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const requestId = (key: string) => {
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() };
    return pending.current.requestId;
  };
  const selected = data?.entries.find((entry) => entry.id === selectedId);
  const revision = selected?.revision ?? 0;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    request("workspace", undefined, abort.signal)
      .then((raw) => {
        if (abort.signal.aborted) return;
        const next = KnowledgeWorkspaceSchema.parse(raw);
        setData(next);
        setSelectedId((id) => id || next.entries[0]?.id || "");
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [reload]);
  useEffect(() => {
    setSelectedId(params.get("entry") ?? "");
    setVersionNumber(Number(params.get("version")) || 0);
    if (params.get("entry")) setTab("library");
  }, [params]);
  useEffect(() => {
    const abort = new AbortController();
    setHistory(null);
    setHistoryError("");
    if (selectedId)
      request(`${selectedId}/history`, undefined, abort.signal)
        .then((raw) => {
          if (!abort.signal.aborted) setHistory(KnowledgeHistorySchema.parse(raw));
        })
        .catch((cause) => {
          if (!abort.signal.aborted)
            setHistoryError(cause instanceof Error ? cause.message : "历史读取失败");
        });
    return () => abort.abort();
  }, [selectedId, revision, reload]);
  const openEditor = useCallback((entry?: KnowledgeEntry) => {
    const next = entry
      ? KnowledgeFieldsSchema.parse(
          Object.fromEntries(
            [...Object.keys(empty()), "documentIds", "sourceSnapshotIds", "claims"].map((key) => [
              key,
              entry.latest[key as keyof KnowledgeFields],
            ]),
          ),
        )
      : empty();
    setFields(next);
    setInitialFields(JSON.stringify(next));
    setTags(next.tags.join(", "));
    setReason("");
    setFormError("");
    setEditing({ id: entry?.id ?? null, revision: entry?.revision ?? 0 });
  }, []);
  const openedRevision = useRef("");
  useEffect(() => {
    const sourceId = params.get("sourceSnapshot");
    const key = selected?.id + ":" + sourceId;
    if (!selected || params.get("revise") !== "1" || !sourceId || openedRevision.current === key)
      return;
    openedRevision.current = key;
    openEditor(selected);
    setFields((previous) => ({
      ...previous,
      sourceSnapshotIds: [...new Set([...(previous.sourceSnapshotIds ?? []), sourceId])],
    }));
    setNotice("本次来源证据已加入候选版本，请编辑正文、核对日期并保存草稿。");
    const consumed = new URLSearchParams(params.toString());
    consumed.delete("revise");
    consumed.delete("sourceSnapshot");
    router.replace("/knowledge?" + consumed.toString(), { scroll: false });
  }, [params, selected, openEditor, router]);
  useEffect(() => {
    const requested = params.get("tab");
    if (requested === "imports" || requested === "governance" || requested === "chat")
      setTab(requested);
    else if (params.get("entry")) {
      setTab("library");
      setSelectedId(params.get("entry") ?? "");
    }
  }, [params]);
  const setField = useCallback(
    <K extends keyof KnowledgeFields>(key: K, value: KnowledgeFields[K]) =>
      setFields((previous) => ({ ...previous, [key]: value })),
    [],
  );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    const parsed = KnowledgeFieldsSchema.safeParse({
      ...fields,
      tags: tags
        .split(/[,，]/)
        .map((value) => value.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "请核对填写内容");
      return;
    }
    if (!reason.trim() || !editing) {
      setFormError("请填写保存说明");
      return;
    }
    const payload = {
        fields: parsed.data,
        expectedRevision: editing.revision,
        reason: reason.trim(),
      },
      path = editing.id ? `${editing.id}/revise` : "create";
    setBusy(true);
    try {
      const saved = await request(path, {
        ...payload,
        requestId: requestId(JSON.stringify({ path, payload })),
      });
      setSelectedId(saved.id);
      setVersionNumber(saved.version);
      setEditing(null);
      pending.current = null;
      setNotice("草稿已保存，提交并审核发布后供 AI 使用");
      setReload((value) => value + 1);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const execute = async (event: FormEvent) => {
    event.preventDefault();
    if (!command || !commandReason.trim()) return;
    const path = `${command.entry.id}/${command.action}`,
      payload = {
        expectedRevision: command.entry.revision,
        version:
          command.action === "disable" ? command.entry.activeVersion : command.entry.latestVersion,
        reason: commandReason.trim(),
      };
    setBusy(true);
    setFormError("");
    try {
      await request(path, { ...payload, requestId: requestId(JSON.stringify({ path, payload })) });
      setNotice(`${actions[command.action]}已完成`);
      if (command.action === "archive") {
        setSelectedId("");
        setHistory(null);
      }
      setCommand(null);
      pending.current = null;
      setReload((value) => value + 1);
      setVersionNumber(0);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name) || file.size > 96 * 1024) {
      setFormError("请选择不超过 96 KB 的 Markdown 或文本文件");
      return;
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (content.length > 24000 || content.includes("\u0000"))
        throw new Error("文本过长或不是有效的文本文件");
      setField("body", content);
      if (!fields.title) setField("title", file.name.replace(/\.[^.]+$/, ""));
      if (!fields.sourceLabel) setField("sourceLabel", file.name);
      setFormError("");
    } catch (cause) {
      setFormError(
        cause instanceof TypeError
          ? "文件不是有效的 UTF-8 文本，请转换编码后再导入"
          : cause instanceof Error
            ? cause.message
            : "文件读取失败",
      );
    }
  };
  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResults(null);
    try {
      setResults(KnowledgeSearchResultSchema.parse(await request("search", search)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检索失败");
    } finally {
      setBusy(false);
    }
  };
  const visible = (data?.entries ?? []).filter(
    (entry) =>
      (status === "all" || status === "overdue"
        ? status !== "overdue" || (entry.active ?? entry.latest).reviewDueOn < today()
        : entry.state === status) &&
      [entry.latest.title, entry.latest.summary, entry.latest.sourceLabel, ...entry.latest.tags]
        .join(" ")
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const viewed =
    history?.versions.find((version) => version.version === versionNumber) ??
    (versionNumber ? undefined : (selected?.latest ?? history?.versions[0]));
  return (
    <main className="oc-page kb-page">
      <header className="kb-heading">
        <div>
          <h1>
            <BookOpen size={22} />
            运营知识库
          </h1>
          <p>维护团队经验与来源，让 AI 使用经过审核的运营知识。</p>
        </div>
        <div className="kb-actions">
          <button
            className="oc-button"
            disabled={loading || busy}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={14} />
            刷新
          </button>
          {data?.canManage && (
            <button className="oc-button primary" onClick={() => openEditor()}>
              <Plus size={14} />
              新建知识
            </button>
          )}
        </div>
      </header>
      <nav className="kb-tabs" aria-label="知识库视图">
        <button
          aria-current={tab === "imports" ? "page" : undefined}
          onClick={() => setTab("imports")}
        >
          资料导入
        </button>
        <button
          aria-current={tab === "governance" ? "page" : undefined}
          onClick={() => setTab("governance")}
        >
          治理中心
        </button>
        <button aria-current={tab === "chat" ? "page" : undefined} onClick={() => setTab("chat")}>
          知识对话
        </button>
        <button
          aria-current={tab === "library" ? "page" : undefined}
          onClick={() => setTab("library")}
        >
          知识管理
        </button>
        <button
          aria-current={tab === "search" ? "page" : undefined}
          onClick={() => setTab("search")}
        >
          检索验证
        </button>
      </nav>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="kb-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">正在读取知识…</p>}
      {data && (tab === "imports" || tab === "governance" || tab === "chat") && (
        <KnowledgeExpandedWorkbench
          view={tab}
          library={data}
          onChanged={() => setReload((v) => v + 1)}
        />
      )}
      {!loading && data && tab === "library" && (
        <>
          <div className="kb-summary">
            共 {data.entries.length} 条 · 待审核{" "}
            {data.entries.filter((e) => e.state === "in_review").length} 条 · 已启用{" "}
            {data.entries.filter((e) => e.activeVersion).length} 条
            {!data.canManage && " · 当前账号只读"}
          </div>
          <div className="kb-layout">
            <aside className="kb-list">
              <label>
                搜索知识
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="标题、标签或来源"
                />
              </label>
              <label>
                状态
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="all">全部状态</option>
                  <option value="draft">草稿</option>
                  <option value="in_review">待审核</option>
                  <option value="published">已发布</option>
                  <option value="overdue">需复查</option>
                </select>
              </label>
              {!visible.length && (
                <p className="kb-empty">
                  {data.entries.length
                    ? "没有符合筛选的知识"
                    : "尚无运营知识。新建或导入资料，再提交审核。"}
                </p>
              )}
              {visible.map((entry) => (
                <button
                  className="kb-row"
                  key={entry.id}
                  aria-pressed={selectedId === entry.id}
                  onClick={() => {
                    setSelectedId(entry.id);
                    setVersionNumber(0);
                  }}
                >
                  <strong>{entry.latest.title}</strong>
                  <span>
                    {KNOWLEDGE_TOPICS[entry.latest.topic]} · {platforms[entry.latest.platform]} ·{" "}
                    {entry.latest.market === "ALL" ? "全部站点" : entry.latest.market}
                  </span>
                  <small>
                    {states[entry.state]} · V{entry.latestVersion}
                    {entry.activeVersion && entry.activeVersion !== entry.latestVersion
                      ? ` · 启用 V${entry.activeVersion}`
                      : ""}
                    {(entry.active ?? entry.latest).reviewDueOn < today() ? " · 需复查" : ""}
                  </small>
                </button>
              ))}
            </aside>
            <section className="kb-detail" aria-label="知识详情">
              {historyError && <p role="alert">{historyError}</p>}
              {selectedId && !history && !historyError && <p role="status">正在读取版本…</p>}
              {!selectedId && <p className="kb-empty">选择一条知识，查看来源、正文和版本。</p>}
              {history && !!versionNumber && !viewed && <p role="alert">指定的知识版本不存在。</p>}
              {viewed && (
                <>
                  <div className="kb-detail-heading">
                    <h2>{viewed.title}</h2>
                    <label>
                      查看版本
                      <select
                        value={viewed.version}
                        onChange={(event) => setVersionNumber(Number(event.target.value))}
                      >
                        {history?.versions.map((version) => (
                          <option key={version.id} value={version.version}>
                            V{version.version}
                            {version.version === selected?.activeVersion ? " · 启用版本" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="kb-meta">
                    {KNOWLEDGE_TOPICS[viewed.topic]} · {platforms[viewed.platform]} ·{" "}
                    {viewed.market === "ALL" ? "全部站点" : viewed.market} ·{" "}
                    {viewed.spuId
                      ? (data.spus.find((spu) => spu.id === viewed.spuId)?.code ?? "指定商品")
                      : "全部商品"}
                  </p>
                  {selected && (
                    <p className="kb-policy">
                      {selected.activeVersion
                        ? `已启用 V${selected.activeVersion}。`
                        : "尚未启用，AI 不会使用这条知识。"}
                      {selected.activeVersion !== selected.latestVersion && selected.activeVersion
                        ? "最新草稿不会覆盖当前启用内容。"
                        : ""}
                      {viewed.reviewDueOn < today() ? "此版本已到复查期，检索将排除。" : ""}
                    </p>
                  )}
                  {!selected && (
                    <p className="kb-policy">此条不在活动知识列表中；历史版本仍可查看。</p>
                  )}
                  {!!viewed.summary && <p>{viewed.summary}</p>}
                  <p className="kb-body">{viewed.body}</p>
                  <dl className="kb-facts">
                    <div>
                      <dt>来源</dt>
                      <dd>
                        {sourceTypes[viewed.sourceType]} · {viewed.sourceLabel}
                        {viewed.sourceUrl && (
                          <>
                            <br />
                            <a href={viewed.sourceUrl} target="_blank" rel="noopener noreferrer">
                              查看原文
                            </a>
                          </>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>负责人</dt>
                      <dd>{viewed.owner}</dd>
                    </div>
                    <div>
                      <dt>核对日期</dt>
                      <dd>{viewed.verifiedOn}</dd>
                    </div>
                    <div>
                      <dt>复查日期</dt>
                      <dd>{viewed.reviewDueOn}</dd>
                    </div>
                  </dl>
                  {!!viewed.tags.length && (
                    <p className="kb-meta">标签：{viewed.tags.join(" · ")}</p>
                  )}
                  {selected && viewed.version === selected.latestVersion && history && (
                    <details className="kb-history">
                      <summary>预览版本差异</summary>
                      <KnowledgeVersionDiff
                        before={
                          selected.active && selected.active.version !== viewed.version
                            ? selected.active
                            : (history.versions.find((v) => v.version < viewed.version) ?? null)
                        }
                        after={viewed}
                        spus={data.spus}
                      />
                    </details>
                  )}
                  {selected && viewed.version !== selected.latestVersion && (
                    <p className="kb-policy">
                      正在查看历史版本。
                      <button className="oc-button" onClick={() => setVersionNumber(0)}>
                        查看最新版本
                      </button>
                    </p>
                  )}
                  {selected && viewed.version === selected.latestVersion && (
                    <div className="kb-actions">
                      {data.canManage && (
                        <button className="oc-button" onClick={() => openEditor(selected)}>
                          修订知识
                        </button>
                      )}
                      {(["submit", "publish", "reject", "disable", "archive"] as const)
                        .filter((action) =>
                          action === "submit"
                            ? data.canManage && selected.state === "draft"
                            : action === "publish" || action === "reject"
                              ? data.canPublish && selected.state === "in_review"
                              : action === "disable"
                                ? data.canPublish && !!selected.activeVersion
                                : data.canManage && (!selected.activeVersion || data.canPublish),
                        )
                        .map((action) => (
                          <button
                            className={`oc-button${action === "publish" ? " primary" : ""}`}
                            key={action}
                            onClick={() => {
                              setCommand({ entry: selected, action });
                              setCommandReason("");
                              setFormError("");
                            }}
                          >
                            {actions[action]}
                          </button>
                        ))}
                    </div>
                  )}
                  <details className="kb-history">
                    <summary>版本与审核记录</summary>
                    {history?.events.map((event) => (
                      <p key={event.id}>
                        V{event.version} · {actions[event.action]} ·{" "}
                        {new Date(event.createdAt).toLocaleString("zh-CN")}
                        <br />
                        {event.reason}
                      </p>
                    ))}
                  </details>
                </>
              )}
            </section>
          </div>
        </>
      )}
      {!loading && data && tab === "search" && (
        <section className="kb-search-section">
          <h2>检索验证</h2>
          <p className="kb-policy">
            当前使用关键词检索，只检索已启用且未到复查期的知识。这里验证检索范围和引用，不调用模型。
          </p>
          <form onSubmit={runSearch}>
            <fieldset disabled={busy}>
              <div className="kb-grid">
                <label>
                  主题
                  <select
                    value={search.topic}
                    onChange={(e) => {
                      setSearch({ ...search, topic: e.target.value as KnowledgeSearch["topic"] });
                      setResults(null);
                    }}
                  >
                    {Object.entries(KNOWLEDGE_TOPICS).map(([key, name]) => (
                      <option key={key} value={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  平台
                  <select
                    value={search.platform}
                    onChange={(e) => {
                      setSearch({
                        ...search,
                        platform: e.target.value as KnowledgeSearch["platform"],
                      });
                      setResults(null);
                    }}
                  >
                    {Object.entries(platforms).map(([key, name]) => (
                      <option key={key} value={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  站点
                  <input
                    value={search.market}
                    maxLength={3}
                    onChange={(e) => {
                      setSearch({ ...search, market: e.target.value.toUpperCase() });
                      setResults(null);
                    }}
                    aria-describedby="kb-market-help"
                  />
                </label>
                <label>
                  商品
                  <select
                    value={search.spuIds[0] ?? ""}
                    onChange={(e) => {
                      setSearch({ ...search, spuIds: e.target.value ? [e.target.value] : [] });
                      setResults(null);
                    }}
                  >
                    <option value="">全部商品的通用知识</option>
                    {data.spus.map((spu) => (
                      <option key={spu.id} value={spu.id}>
                        {spu.code} · {spu.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="kb-meta" id="kb-market-help">
                站点填 US、GB、CA 等两位代码；ALL 仅匹配通用站点知识。
              </p>
              <label>
                检索问题
                <input
                  value={search.query}
                  maxLength={300}
                  required
                  onChange={(e) => {
                    setSearch({ ...search, query: e.target.value });
                    setResults(null);
                  }}
                  placeholder="例如：定制抱枕的 Listing 文案"
                />
              </label>
              <button className="oc-button primary" type="submit">
                <Search size={14} />
                {busy ? "正在检索…" : "检索知识"}
              </button>
            </fieldset>
          </form>
          {results && (
            <div className="kb-search-results">
              <p className="kb-meta">
                关键词检索 · 检查 {results.scanned} 条范围内知识 · 命中 {results.references.length}{" "}
                条
              </p>
              {results.diagnostics.map((d) => (
                <p className="kb-policy" key={d}>
                  {d}
                </p>
              ))}
              {results.references.map((ref) => (
                <article key={ref.sourceId}>
                  <h3>
                    <Link href={ref.href}>
                      {ref.title} · V{ref.version}
                    </Link>
                  </h3>
                  <p className="kb-body">{ref.excerpt}</p>
                  <small>
                    来源：{ref.sourceLabel} · 核对 {ref.verifiedOn} · 复查 {ref.reviewDueOn}
                  </small>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      {editing && (
        <TaskDrawer
          title={editing.id ? "修订运营知识" : "新建运营知识"}
          description="保存后为草稿，提交并审核发布后供 AI 使用。"
          state={{
            dirty:
              JSON.stringify(fields) !== initialFields ||
              !!reason ||
              tags !== fields.tags.join(", "),
            busy,
            loading: false,
          }}
          onClose={() => setEditing(null)}
        >
          <form id="knowledge-edit-form" className="kb-form" onSubmit={save}>
            <fieldset disabled={busy}>
              <label>
                知识标题
                <input
                  required
                  value={fields.title}
                  maxLength={180}
                  onChange={(e) => setField("title", e.target.value)}
                />
              </label>
              <div className="kb-grid">
                <label>
                  主题
                  <select
                    value={fields.topic}
                    onChange={(e) => setField("topic", e.target.value as KnowledgeFields["topic"])}
                  >
                    {Object.entries(KNOWLEDGE_TOPICS).map(([key, name]) => (
                      <option value={key} key={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  适用平台
                  <select
                    value={fields.platform}
                    onChange={(e) =>
                      setField("platform", e.target.value as KnowledgeFields["platform"])
                    }
                  >
                    {Object.entries(platforms).map(([key, name]) => (
                      <option value={key} key={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  适用站点
                  <input
                    required
                    value={fields.market}
                    maxLength={3}
                    onChange={(e) => setField("market", e.target.value.toUpperCase())}
                  />
                </label>
                <label>
                  适用商品
                  <select
                    value={fields.spuId ?? ""}
                    onChange={(e) => setField("spuId", e.target.value || null)}
                  >
                    <option value="">全部商品</option>
                    {data?.spus.map((spu) => (
                      <option value={spu.id} key={spu.id}>
                        {spu.code} · {spu.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="kb-meta">
                站点使用 US、GB、CA 等代码；通用知识填 ALL。商品事实请在商品 SPU 中维护。
              </p>
              <label>
                摘要
                <textarea
                  aria-label="摘要"
                  value={fields.summary}
                  maxLength={1000}
                  rows={2}
                  onChange={(e) => setField("summary", e.target.value)}
                />
              </label>
              <label>
                知识正文
                <textarea
                  aria-label="知识正文"
                  required
                  value={fields.body}
                  maxLength={24000}
                  rows={12}
                  onChange={(e) => setField("body", e.target.value)}
                />
              </label>
              <label className="kb-import">
                <FileUp size={14} />
                导入 Markdown / 文本
                <input
                  type="file"
                  accept=".md,.txt,text/plain,text/markdown"
                  onChange={(e) => {
                    void importFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              <div className="kb-grid">
                <label>
                  来源类型
                  <select
                    value={fields.sourceType}
                    onChange={(e) =>
                      setField("sourceType", e.target.value as KnowledgeFields["sourceType"])
                    }
                  >
                    {Object.entries(sourceTypes).map(([key, name]) => (
                      <option value={key} key={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  来源名称
                  <input
                    required
                    value={fields.sourceLabel}
                    maxLength={240}
                    onChange={(e) => setField("sourceLabel", e.target.value)}
                  />
                </label>
              </div>
              <label>
                原文地址
                <input
                  type="url"
                  required={fields.sourceType === "official"}
                  value={fields.sourceUrl}
                  maxLength={2000}
                  onChange={(e) => setField("sourceUrl", e.target.value)}
                />
              </label>
              <div className="kb-grid">
                <label>
                  负责人
                  <input
                    required
                    value={fields.owner}
                    maxLength={100}
                    onChange={(e) => setField("owner", e.target.value)}
                  />
                </label>
                <label>
                  核对日期
                  <input
                    type="date"
                    required
                    value={fields.verifiedOn}
                    onChange={(e) => setField("verifiedOn", e.target.value)}
                  />
                </label>
                <label>
                  复查日期
                  <input
                    type="date"
                    required
                    min={fields.verifiedOn}
                    value={fields.reviewDueOn}
                    onChange={(e) => setField("reviewDueOn", e.target.value)}
                  />
                </label>
              </div>
              <label>
                标签
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="用逗号分隔，最多 12 个"
                />
              </label>
              <label>
                保存说明
                <textarea
                  aria-label="保存说明"
                  required
                  rows={2}
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <KnowledgeEvidenceEditor fields={fields} onChange={setFields} />
              {formError && (
                <p className="kb-error" role="alert">
                  {formError}
                </p>
              )}
              <TaskDrawerActions>
                <button
                  className="oc-button primary"
                  disabled={busy}
                  form="knowledge-edit-form"
                  type="submit"
                >
                  {busy ? "正在保存…" : "保存草稿"}
                </button>
              </TaskDrawerActions>
            </fieldset>
          </form>
        </TaskDrawer>
      )}
      {command && (
        <TaskDrawer
          title={actions[command.action]}
          description={`${command.entry.latest.title} · V${command.action === "disable" ? command.entry.activeVersion : command.entry.latestVersion}`}
          state={{ dirty: !!commandReason, busy, loading: false }}
          onClose={() => setCommand(null)}
        >
          <form id="knowledge-command-form" className="kb-form" onSubmit={execute}>
            <p className="kb-policy">
              {command.action === "publish"
                ? "发布是更新 AI 使用的知识卡。请核对本版正文、来源、适用范围、复查日期和以下差异。确认后，新检索可使用本版知识；已有任务保留原引用版本。"
                : command.action === "disable" || command.action === "archive"
                  ? "停止新任务使用，保留历史版本与任务引用。"
                  : "记录本次决定的依据。"}
            </p>
            {command.action === "publish" && (
              <KnowledgeVersionDiff
                before={
                  command.entry.active ??
                  history?.versions.find((v) => v.version < command.entry.latestVersion) ??
                  null
                }
                after={command.entry.latest}
                spus={data?.spus ?? []}
              />
            )}
            <label>
              操作说明
              <textarea
                aria-label="操作说明"
                required
                rows={4}
                maxLength={500}
                value={commandReason}
                disabled={busy}
                onChange={(e) => setCommandReason(e.target.value)}
              />
            </label>
            {formError && (
              <p role="alert" className="kb-error">
                {formError}
              </p>
            )}
            <TaskDrawerActions>
              <button
                className="oc-button primary"
                disabled={busy}
                form="knowledge-command-form"
                type="submit"
              >
                {busy ? "正在处理…" : `确认${actions[command.action]}`}
              </button>
            </TaskDrawerActions>
          </form>
        </TaskDrawer>
      )}
    </main>
  );
}
