"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Check,
  FileCheck,
  History,
  Link2,
  Pencil,
  RefreshCw,
  Save,
  Send,
  Square,
  Undo2,
} from "lucide-react";
import {
  AgentMethodHistorySchema,
  AgentMethodSourcesSchema,
  type AgentMethodDefinition,
  type AgentMethodHistory,
  type AgentMethodSourceChoice,
  type AgentMethodVersion,
} from "@yummyai/contracts/harness/methods";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { observeViewTransition } from "../navigation/view-transition";
import { methodRequest, methodAccessDenied } from "./method-api";
import { draftStatus, methodDifference, methodStatus, type MethodItem } from "./method-model";

type Pane = "overview" | "edit" | "review" | "history";
const knowledgeHref = (ref: { entryId: string; version: number }) =>
  `/knowledge?entry=${encodeURIComponent(ref.entryId)}&version=${ref.version}`;
function initialSources(item: MethodItem): AgentMethodSourceChoice[] {
  return (
    item.row?.latest.definition.knowledgeReferences.map((ref) => ({
      ...ref,
      usable:
        item.row!.latestAvailability.sourceStates.find(
          (source) => source.versionId === ref.versionId,
        )?.usable ?? false,
      issues: [],
    })) ?? []
  );
}
const stepLabels: Record<string, string> = {
  authorize_original_order: "核对原订单与当前权限",
  validate_pinned_recipe_rules_and_plan: "核对本单固定配方、规则与计划",
  execute_existing_bounded_steps: "执行已登记的制作步骤",
  preserve_original_response_and_cost: "保存原模型结果与费用依据",
  validate_private_proof: "核验私有待审稿",
  handoff_for_business_review: "交由业务审核",
  authorize_current_member: "检查当前成员权限",
  check_current_dependencies: "核对当前业务依据",
  prepare_evidence: "准备可引用的资料",
  checkpoint_response: "保存原始响应",
  validate_citations: "检查结果与引用",
  handoff_to_business_owner: "交回业务流程审核",
};
export function MethodPanel({
  item,
  canManage,
  canPublish,
  fresh,
  initialVersion,
  onClose,
  onDenied,
  onChanged,
}: {
  item: MethodItem;
  canManage: boolean;
  canPublish: boolean;
  fresh: boolean;
  initialVersion?: number;
  onClose: () => void;
  onDenied: (message: string) => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const row = item.row,
    [pane, setPane] = useState<Pane>(initialVersion ? "history" : "overview"),
    [notes, setNotes] = useState(row?.latest.definition.notes ?? ""),
    [selected, setSelected] = useState(initialSources(item)),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reviewed, setReviewed] = useState("");
  const [editRevision, setEditRevision] = useState(row?.revision ?? 0),
    mounted = useRef(true),
    keys = useRef(new Map<string, string>()),
    transition = useRef<ViewTransition | null>(null);
  const dirty =
    pane === "edit" &&
    (notes !== (row?.latest.definition.notes ?? "") ||
      JSON.stringify(selected.map((ref) => ref.versionId)) !==
        JSON.stringify(
          row?.latest.definition.knowledgeReferences.map((ref) => ref.versionId) ?? [],
        ) ||
      !!reason);
  const staleEdit = dirty && editRevision !== (row?.revision ?? 0),
    ticket = row
      ? `${row.revision}:${row.latest.checksum}:${row.active?.checksum ?? "builtin"}`
      : "";
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      transition.current?.skipTransition();
    };
  }, []);
  useEffect(() => {
    if (!dirty && !busy) {
      setNotes(row?.latest.definition.notes ?? "");
      setSelected(initialSources(item));
      setEditRevision(row?.revision ?? 0);
    }
  }, [row?.revision, dirty, busy, item, row]);
  useEffect(() => {
    if (!canManage && pane === "edit") {
      setPane("overview");
      setNotes(row?.latest.definition.notes ?? "");
      setSelected(initialSources(item));
      setReason("");
    }
  }, [canManage, pane, row, item]);
  function denied(cause: unknown) {
    if (methodAccessDenied(cause)) {
      transition.current?.skipTransition();
      onDenied(cause instanceof Error ? cause.message : "当前账号无法读取方法");
      return true;
    }
    return false;
  }
  function changePane(next: Pane) {
    if (busy) return;
    if (dirty && next !== "edit") {
      setError("请先保存或放弃当前修改");
      return;
    }
    setError("");
    morph(() => setPane(next));
  }
  function morph(change: () => void) {
    transition.current?.skipTransition();
    if (
      document.startViewTransition &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      transition.current = observeViewTransition(
        document.startViewTransition(() => flushSync(change)),
      );
    else change();
  }
  async function mutate(path: string, body: Record<string, unknown>, message: string) {
    if (!fresh || busy) return;
    setBusy(true);
    setError("");
    const signature = JSON.stringify({ path, body }),
      requestId = keys.current.get(signature) ?? crypto.randomUUID();
    keys.current.set(signature, requestId);
    try {
      await methodRequest(path, { ...body, requestId });
      if (!mounted.current) return;
      setReason("");
      setReviewed("");
      setPane("review");
      await onChanged(message);
    } catch (cause) {
      if (!mounted.current || denied(cause)) return;
      setError(cause instanceof Error ? cause.message : "操作失败，请重新读取当前版本");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function save() {
    if (!item.catalog || !reason.trim() || staleEdit) return;
    void mutate(
      "save",
      {
        methodKey: item.key,
        notes,
        knowledgeVersionIds: selected.map((ref) => ref.versionId),
        expectedRevision: editRevision,
        reason: reason.trim(),
      },
      "团队方法草稿已保存，尚未启用",
    );
  }
  function act(action: "submit" | "publish" | "reject" | "disable") {
    if (!row || !reason.trim() || (action === "publish" && reviewed !== ticket)) return;
    void mutate(
      `${row.id}/${action}`,
      {
        expectedRevision: row.revision,
        version: action === "disable" ? row.activeVersion : row.latestVersion,
        reason: reason.trim(),
        ...(action === "publish" ? { reviewedChecksum: row.latest.checksum } : {}),
      },
      action === "publish"
        ? "方法已发布，后续新任务使用此版本"
        : action === "disable"
          ? "方法已停用，旧选择不再继续执行"
          : action === "reject"
            ? "已退回草稿，原启用版本保持"
            : "已提交复核，当前使用版本保持",
    );
  }
  function discard() {
    setNotes(row?.latest.definition.notes ?? "");
    setSelected(initialSources(item));
    setEditRevision(row?.revision ?? 0);
    setReason("");
    setError("");
    setPane("overview");
  }
  const available = item.catalog ?? row?.latest.definition;
  return (
    <TaskDrawer
      title={item.label}
      description="团队版本与执行依据"
      recordKey={item.key}
      state={{ dirty, busy, loading: false }}
      onClose={onClose}
      className="method-drawer"
    >
      <div className="method-panel">
        <div className="method-actions">
          <button
            className="oc-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onChanged("");
              } finally {
                if (mounted.current) setBusy(false);
              }
            }}
          >
            <RefreshCw size={15} />
            重新读取当前版本
          </button>
        </div>
        <nav className="method-tabs" aria-label="方法详情视图">
          {(
            [
              ["overview", "当前状态"],
              ["edit", "团队说明"],
              ["review", "复核差异"],
              ["history", "版本记录"],
            ] as const
          )
            .filter(([key]) => key !== "edit" || (canManage && !!item.catalog))
            .map(([key, label]) => (
              <button
                key={key}
                aria-current={pane === key ? "page" : undefined}
                disabled={busy || (!row && (key === "review" || key === "history"))}
                onClick={() => changePane(key)}
              >
                {label}
              </button>
            ))}
        </nav>
        {error && (
          <p role="alert" className="oc-error">
            {error}
          </p>
        )}
        {!fresh && <p className="oc-error">当前权限与版本尚未重新核验，暂不能保存或发布</p>}
        {pane === "overview" && (
          <section className="method-pane" aria-label="方法当前状态">
            <div className="method-summary">
              <span className="method-status">{methodStatus(item)}</span>
              <span>
                {row?.activeVersion
                  ? `当前团队版本 v${row.activeVersion}`
                  : "当前没有启用的团队版本"}
              </span>
              <span>
                {draftStatus(row)}
                {row ? ` · v${row.latestVersion}` : ""}
              </span>
            </div>
            {!row?.adoptedAt && (
              <p className="oc-hint">当前沿用内置方法，保存和提交草稿不会启用团队版本</p>
            )}
            {!!row?.disabledAt && (
              <p className="oc-hint">重新启用须再次提交和复核，停用前的任务不会自动恢复</p>
            )}
            {row?.activeAvailability?.issues.map((issue) => (
              <p role="status" className="oc-error" key={issue}>
                {issue}
              </p>
            ))}
            <h3>当前团队补充说明</h3>
            <p className="method-prose">
              {row?.active?.definition.notes || "暂无已启用的团队补充说明"}
            </p>
            {!!row?.active && (
              <SourceLinks
                definition={row.active.definition}
                states={row.activeAvailability?.sourceStates}
              />
            )}
            {available && <ExecutionDetails definition={available} />}
            <div className="method-actions">
              {canManage && item.catalog && (
                <button className="oc-button" onClick={() => changePane("edit")}>
                  <Pencil size={15} />
                  {row ? "修订团队说明" : "创建团队草稿"}
                </button>
              )}
              {row && (
                <button className="oc-button" onClick={() => changePane("review")}>
                  <FileCheck size={15} />
                  复核最新版本
                </button>
              )}
            </div>
          </section>
        )}
        {pane === "edit" && (
          <section className="method-pane" aria-label="编辑团队方法">
            <p className="oc-hint">修改补充说明与通用知识引用，执行步骤和工具由已注册版本提供</p>
            {staleEdit && (
              <p role="alert" className="oc-error">
                服务端已有新修订，请保留必要内容后放弃修改并重新读取
              </p>
            )}
            <label className="method-field">
              团队补充说明
              <textarea
                aria-label="团队补充说明"
                maxLength={4000}
                rows={7}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                disabled={busy || !fresh}
              />
              <small>{notes.length} / 4000</small>
            </label>
            <SourcePicker
              selected={selected}
              onChange={(value, animate) =>
                animate ? morph(() => setSelected(value)) : setSelected(value)
              }
              disabled={busy || !fresh}
              onDenied={(cause) => {
                denied(cause);
              }}
            />
            <label className="method-field">
              变更原因
              <input
                aria-label="变更原因"
                maxLength={600}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={busy}
              />
            </label>
            <TaskDrawerActions>
              <button className="oc-button" disabled={busy} onClick={discard}>
                <Undo2 size={15} />
                放弃修改
              </button>
              <button
                className="oc-button primary"
                disabled={busy || !fresh || !reason.trim() || staleEdit}
                onClick={save}
              >
                <Save size={15} />
                保存草稿
              </button>
            </TaskDrawerActions>
          </section>
        )}
        {pane === "review" && row && (
          <section className="method-pane" aria-label="方法差异复核">
            <h3>
              最新团队版本 v{row.latestVersion} · {draftStatus(row)}
            </h3>
            <p className="oc-hint">
              对照当前启用版本{row.active ? ` v${row.activeVersion}` : "或内置默认"}
              ，发布只影响后续新任务
            </p>
            <MethodDiff previous={row.active?.definition ?? null} next={row.latest.definition} />
            {row.latestAvailability.issues.map((issue) => (
              <p role="alert" className="oc-error" key={issue}>
                {issue}
              </p>
            ))}
            {(canManage || canPublish) && (
              <>
                <label className="method-field">
                  操作原因
                  <input
                    aria-label="操作原因"
                    maxLength={600}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    disabled={busy}
                  />
                </label>
                {row.state === "in_review" && canPublish && (
                  <label className="method-check">
                    <input
                      type="checkbox"
                      checked={reviewed === ticket}
                      onChange={(event) => setReviewed(event.target.checked ? ticket : "")}
                      disabled={busy || !row.latestAvailability.eligible}
                    />
                    我已核对本版本说明和引用差异
                  </label>
                )}
                {row.activeVersion !== null && canPublish && (
                  <p className="oc-hint">停用会停止旧选择继续执行，已发生的模型费用仍保留</p>
                )}
                <TaskDrawerActions>
                  {canManage &&
                    row.state !== "in_review" &&
                    (row.state !== "published" || !!row.disabledAt) && (
                      <button
                        className="oc-button"
                        disabled={
                          busy || !fresh || !reason.trim() || !row.latestAvailability.eligible
                        }
                        onClick={() => act("submit")}
                      >
                        <Send size={15} />
                        提交复核
                      </button>
                    )}
                  {canPublish && row.state === "in_review" && (
                    <>
                      <button
                        className="oc-button"
                        disabled={busy || !fresh || !reason.trim()}
                        onClick={() => act("reject")}
                      >
                        退回草稿
                      </button>
                      <button
                        className="oc-button primary"
                        disabled={
                          busy ||
                          !fresh ||
                          !reason.trim() ||
                          reviewed !== ticket ||
                          !row.latestAvailability.eligible
                        }
                        onClick={() => act("publish")}
                      >
                        <Check size={15} />
                        发布此版本
                      </button>
                    </>
                  )}
                  {canPublish && row.activeVersion !== null && (
                    <button
                      className="oc-button danger"
                      disabled={busy || !fresh || !reason.trim()}
                      onClick={() => act("disable")}
                    >
                      <Square size={14} />
                      停用当前方法
                    </button>
                  )}
                </TaskDrawerActions>
              </>
            )}
          </section>
        )}
        {pane === "history" && row && (
          <MethodHistory id={row.id} initialVersion={initialVersion} onDenied={denied} />
        )}
      </div>
    </TaskDrawer>
  );
}
function SourceLinks({
  definition,
  states,
}: {
  definition: AgentMethodDefinition;
  states?: Array<{ versionId: string; usable: boolean }>;
}) {
  return (
    <section>
      <h3>固定知识来源</h3>
      {definition.knowledgeReferences.length ? (
        <ul className="method-source-list">
          {definition.knowledgeReferences.map((ref) => (
            <li key={ref.versionId}>
              <a href={knowledgeHref(ref)} target="_blank" rel="noreferrer">
                <Link2 size={14} />
                {ref.title} · v{ref.version}
              </a>
              {states?.find((source) => source.versionId === ref.versionId)?.usable === false && (
                <span className="oc-error">来源当前不可用</span>
              )}
              <small>
                {ref.sourceLabel} · 复核日 {ref.reviewDueOn}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="oc-hint">未绑定额外的方法知识来源</p>
      )}
    </section>
  );
}
function ExecutionDetails({
  definition,
}: {
  definition: Pick<AgentMethodDefinition, "steps" | "tools" | "instructions" | "executionContract">;
}) {
  return (
    <details className="method-details">
      <summary>固定执行步骤与能力</summary>
      <ol>
        {definition.steps.map((step) => (
          <li key={step}>{stepLabels[step] ?? step}</li>
        ))}
      </ol>
      <ul>
        {definition.tools.map((tool) => (
          <li key={tool.key}>
            {tool.label} ·{" "}
            {tool.effect === "external_request"
              ? "调用外部模型"
              : tool.effect === "read"
                ? "读取依据"
                : "交由业务模块处理"}
          </li>
        ))}
      </ul>
      <p className="oc-hint">注册版本 {definition.executionContract.skill.version}</p>
      <details>
        <summary>查看固定方法正文</summary>
        <pre>{definition.instructions}</pre>
      </details>
    </details>
  );
}
function MethodDiff({
  previous,
  next,
}: {
  previous: AgentMethodDefinition | null;
  next: AgentMethodDefinition;
}) {
  const diff = methodDifference(previous, next);
  return (
    <>
      <div className="method-diff">
        <section>
          <h4>当前说明</h4>
          <p className="method-prose">{previous?.notes || "无团队补充说明"}</p>
        </section>
        <section>
          <h4>本次说明{diff.notesChanged ? " · 已修改" : " · 未修改"}</h4>
          <p className="method-prose">{next.notes || "无团队补充说明"}</p>
        </section>
      </div>
      <p className="oc-hint">
        引用新增 {diff.added.length} 项 · 移除 {diff.removed.length} 项
        {diff.executionChanged ? " · 注册执行版本已变化" : ""}
      </p>
      <SourceLinks definition={next} />
      {!!diff.removed.length && (
        <p className="method-prose">
          本次移除：{diff.removed.map((ref) => `${ref.title} v${ref.version}`).join("、")}
        </p>
      )}
      <ExecutionDetails definition={next} />
    </>
  );
}
function SourcePicker({
  selected,
  onChange,
  disabled,
  onDenied,
}: {
  selected: AgentMethodSourceChoice[];
  onChange: (value: AgentMethodSourceChoice[], animate?: boolean) => void;
  disabled: boolean;
  onDenied: (cause: unknown) => void;
}) {
  const [query, setQuery] = useState(""),
    [choices, setChoices] = useState<AgentMethodSourceChoice[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0),
    abort = useRef<AbortController | null>(null);
  async function load(after?: string) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ query });
      if (after) params.set("after", after);
      const result = AgentMethodSourcesSchema.parse(
        await methodRequest("sources?" + params, undefined, controller.signal),
      );
      if (controller.signal.aborted || current !== generation.current) return;
      setChoices((old) => (after ? [...old, ...result.choices] : result.choices));
      setCursor(result.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted || current !== generation.current) return;
      onDenied(cause);
      setError(cause instanceof Error ? cause.message : "读取来源失败");
    } finally {
      if (!controller.signal.aborted && current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => {
      clearTimeout(timer);
      abort.current?.abort();
      generation.current++;
    };
  }, [query]);
  return (
    <section aria-label="选择方法知识来源">
      <h3>
        通用知识来源 <small>{selected.length} / 4</small>
      </h3>
      <p className="oc-hint">选择已经发布的通用资料，具体产品和店铺依据仍在业务任务中选择</p>
      {!!selected.length && (
        <ul className="method-source-list">
          {selected.map((ref) => (
            <li key={ref.versionId}>
              <span>
                {ref.title} · v{ref.version}
              </span>
              <button
                className="oc-button"
                disabled={disabled}
                aria-label={`移除来源 ${ref.title} v${ref.version}`}
                onClick={() =>
                  onChange(
                    selected.filter((source) => source.versionId !== ref.versionId),
                    true,
                  )
                }
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="method-field">
        搜索通用知识
        <input
          aria-label="搜索通用知识"
          value={query}
          maxLength={160}
          onChange={(event) => setQuery(event.target.value)}
          disabled={disabled}
        />
      </label>
      {error && (
        <p role="alert" className="oc-error">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="oc-hint">
          正在核验来源…
        </p>
      )}
      <div className="method-source-options">
        {choices.map((ref) => (
          <label key={ref.versionId} className="method-source-option">
            <input
              type="checkbox"
              aria-label={`选择 ${ref.title} v${ref.version}`}
              checked={selected.some((source) => source.versionId === ref.versionId)}
              disabled={
                disabled ||
                !ref.usable ||
                (selected.length >= 4 &&
                  !selected.some((source) => source.versionId === ref.versionId))
              }
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, ref]
                    : selected.filter((source) => source.versionId !== ref.versionId),
                )
              }
            />
            <span>
              {ref.title} · v{ref.version}
              <small>
                {ref.sourceLabel} · 复核日 {ref.reviewDueOn}
                {ref.issues.length ? " · " + ref.issues.join("，") : ""}
              </small>
            </span>
          </label>
        ))}
      </div>
      {!loading && !choices.length && !error && (
        <p className="oc-hint">没有匹配的已发布通用知识，可先前往运营知识库整理和发布</p>
      )}
      {cursor && (
        <button
          className="oc-button"
          disabled={loading || disabled}
          onClick={() => void load(cursor)}
        >
          读取更多来源
        </button>
      )}
    </section>
  );
}
function MethodHistory({
  id,
  initialVersion,
  onDenied,
}: {
  id: string;
  initialVersion?: number;
  onDenied: (cause: unknown) => boolean;
}) {
  const [history, setHistory] = useState<AgentMethodHistory | null>(null),
    [version, setVersion] = useState(initialVersion ?? 0),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void methodRequest(`${id}/history`, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setHistory(AgentMethodHistorySchema.parse(value));
      })
      .catch((cause) => {
        if (!controller.signal.aborted && !onDenied(cause))
          setError(cause instanceof Error ? cause.message : "读取历史失败");
      });
    return () => controller.abort();
  }, [id]);
  const selected: AgentMethodVersion | undefined = history?.versions.find(
    (item) => item.version === (version || history.versions[0]?.version),
  );
  return (
    <section className="method-pane" aria-label="方法版本记录">
      <h3>
        <History size={16} />
        不可变版本记录
      </h3>
      {error && (
        <p role="alert" className="oc-error">
          {error}
        </p>
      )}
      {!history && !error && <p role="status">正在读取版本记录…</p>}
      {history && (
        <>
          <label className="method-field">
            查看版本
            <select
              aria-label="查看方法版本"
              value={version || history.versions[0]?.version}
              onChange={(event) => setVersion(Number(event.target.value))}
            >
              {history.versions.map((item) => (
                <option key={item.id} value={item.version}>
                  v{item.version} · {item.reason}
                </option>
              ))}
            </select>
          </label>
          {!selected ? (
            <p className="oc-error">指定历史版本不可用</p>
          ) : (
            <>
              <p className="method-prose">{selected.definition.notes || "无团队补充说明"}</p>
              <SourceLinks definition={selected.definition} />
              <ExecutionDetails definition={selected.definition} />
              <ol className="method-events">
                {history.events
                  .filter((event) => event.version === selected.version)
                  .map((event) => (
                    <li key={event.id}>
                      <span>
                        {
                          (
                            {
                              create: "创建",
                              revise: "修订",
                              submit: "提交",
                              publish: "发布",
                              reject: "驳回",
                              disable: "停用",
                            } as const
                          )[event.action]
                        }
                      </span>
                      <time>
                        {new Date(event.createdAt).toLocaleString("zh-CN", {
                          timeZone: "Asia/Shanghai",
                          hour12: false,
                        })}{" "}
                        北京时间
                      </time>
                      <p>{event.reason}</p>
                    </li>
                  ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}
