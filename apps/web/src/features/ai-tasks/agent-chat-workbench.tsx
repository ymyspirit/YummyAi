"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import {
  agentChatAssistRequest,
  CreateAgentChatTurnSchema,
  type AgentChatEvent,
  type AgentChatWorkspace,
} from "@yummyai/contracts/ai/agent-chat";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import { useErpAccess } from "../identity/erp-access";
import { assistReadDenied, AssistRequestError } from "../ai-assist/assist-client";
import { AssistRequestRecovery } from "../ai-assist/assist-request-recovery";
import {
  ASSIST_INTENT_CLEAR_EVENT,
  prepareAssistIntent,
  readAssistIntents,
  saveAssistIntent,
  useAssistIntentMarkers,
} from "../ai-assist/assist-request-intent";
import {
  assertAssistEntryResponse,
  recordAssistEntryRun,
} from "../ai-assist/assist-entry-recovery";
import { AgentChatSurface, type AgentChatMessage } from "./agent-chat-surface";
import {
  createAgentChatTurn,
  readAgentChatHistory,
  readAgentChatWorkspace,
  streamAgentChatRun,
} from "./agent-chat-client";
import { exactAgentChatProduct, restoredAgentChatProduct } from "./agent-chat-product-scope";

const isActive = (view: AssistView) => view.status === "queued" || view.status === "running";
const failureText = (failure: unknown) =>
  failure instanceof AssistRequestError
    ? failure.message
    : "原任务响应暂不可核对 请只读取原任务 不重新发送";
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export function AgentChatWorkbench() {
  const access = useErpAccess();
  if (
    !access.authority ||
    !access.preferenceScope ||
    !requiredAssistPermissions("knowledge_answer", "read").every((bit) => access.can(bit))
  )
    return (
      <section className="agent-chat-unavailable" aria-label="AI Agent 对话">
        <p role="status">当前身份或对话读取权限尚未核对 原对话与填写已隐藏</p>
      </section>
    );
  return (
    <AgentChatContent
      key={access.authority + ":" + access.preferenceScope}
      authority={access.authority}
      preferenceScope={access.preferenceScope}
    />
  );
}

function AnswerSources({ view }: { view: AssistView }) {
  return (
    <>
      {Boolean(view.result?.missingInformation.length) && (
        <div className="agent-chat-missing">
          <strong>还需要补充</strong>
          <ul>
            {view.result!.missingInformation.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {Boolean(view.knowledge.length) && (
        <details className="agent-chat-sources">
          <summary>知识依据 · {view.knowledge.length} 条</summary>
          <ul>
            {view.knowledge.map((reference) => (
              <li key={reference.sourceId + reference.versionId}>
                <a
                  href={
                    "/knowledge?" +
                    new URLSearchParams({ entry: reference.entryId, version: reference.versionId })
                  }
                >
                  {reference.title} · V{reference.version}
                </a>
                <p>{reference.excerpt}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {view.stale && <p className="agent-chat-muted">本轮固定依据需要重新核对</p>}
    </>
  );
}

function AgentChatContent({
  authority,
  preferenceScope,
}: {
  authority: string;
  preferenceScope: string;
}) {
  const access = useErpAccess(),
    router = useRouter(),
    search = useSearchParams();
  const parsedScope = z.uuid().safeParse(search.get("chat"));
  const linked =
    search.getAll("chat").length === 1 && parsedScope.success
      ? parsedScope.data.toLowerCase()
      : null;
  const invalidLink = search.has("chat") && !linked;
  const [newScope, setNewScope] = useState(() => crypto.randomUUID());
  const scope = linked ?? newScope;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const liveAuthority = useRef(access.authority);
  liveAuthority.current = access.authority;
  const canRead = requiredAssistPermissions("knowledge_answer", "read").every((bit) =>
    access.can(bit),
  );
  const canRun = requiredAssistPermissions("knowledge_answer", "run").every((bit) =>
    access.can(bit),
  );
  const liveRead = useRef(canRead);
  liveRead.current = canRead;
  const alive = useRef(true),
    blocked = useRef(false),
    epoch = useRef(0),
    generation = useRef(0);
  const workspaceRead = useRef<AbortController | null>(null),
    historyRead = useRef<AbortController | null>(null),
    streamRead = useRef<AbortController | null>(null);
  const workspaceSequence = useRef(0),
    historySequence = useRef(0),
    streamSequence = useRef(0),
    submitLock = useRef(false);
  const loadedSelection = useRef("");
  const [workspace, setWorkspace] = useState<AgentChatWorkspace | null>(null),
    [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [views, setViews] = useState<AssistView[]>([]),
    viewsRef = useRef<AssistView[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false),
    [historyHasMore, setHistoryHasMore] = useState(false);
  const [draft, setDraft] = useState(""),
    draftRef = useRef("");
  draftRef.current = draft;
  const drafts = useRef(new Map<string, string>());
  const productDrafts = useRef(new Map<string, { id: string; manual: boolean }>());
  const [productId, setProductId] = useState("");
  const [productManual, setProductManual] = useState(false);
  const [productEditing, setProductEditing] = useState(false);
  const [productBlocked, setProductBlocked] = useState("");
  const [historyReady, setHistoryReady] = useState(!linked);
  const [modelId, setModelId] = useState(""),
    [creating, setCreating] = useState(false),
    [error, setError] = useState("");
  const [denied, setDenied] = useState(false),
    [statusText, setStatusText] = useState("");
  const [partial, setPartial] = useState<{ id: string; text: string } | null>(null);
  const [connection, setConnection] = useState<
    "idle" | "connecting" | "streaming" | "reconnecting"
  >("idle");
  const intents = useAssistIntentMarkers(preferenceScope, "knowledge_answer");
  const valid = useCallback(
    (token = epoch.current) =>
      alive.current &&
      !blocked.current &&
      token === epoch.current &&
      liveAuthority.current === authority &&
      liveRead.current,
    [authority],
  );
  const adoptViews = useCallback((next: AssistView[]) => {
    viewsRef.current = next;
    setViews(next);
  }, []);
  const deny = useCallback(() => {
    blocked.current = true;
    epoch.current++;
    generation.current++;
    workspaceSequence.current++;
    historySequence.current++;
    streamSequence.current++;
    workspaceRead.current?.abort();
    historyRead.current?.abort();
    streamRead.current?.abort();
    setWorkspace(null);
    adoptViews([]);
    setDraft("");
    draftRef.current = "";
    drafts.current.clear();
    productDrafts.current.clear();
    setProductId("");
    setProductManual(false);
    setProductEditing(false);
    setProductBlocked("");
    setHistoryReady(false);
    setModelId("");
    setPartial(null);
    setStatusText("");
    setError("");
    setCreating(false);
    setConnection("idle");
    setDenied(true);
    window.dispatchEvent(new Event("focus"));
  }, [adoptViews]);
  const fail = useCallback(
    (failure: unknown) => {
      if (assistReadDenied(failure)) deny();
      else setError(failureText(failure));
    },
    [deny],
  );
  useLayoutEffect(() => {
    alive.current = true;
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, deny);
    return () => {
      alive.current = false;
      epoch.current++;
      generation.current++;
      workspaceRead.current?.abort();
      historyRead.current?.abort();
      streamRead.current?.abort();
      window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, deny);
    };
  }, [deny]);
  useEffect(() => {
    if (!canRead) deny();
  }, [canRead, deny]);

  const loadWorkspace = useCallback(async () => {
    if (!valid()) return;
    const token = epoch.current,
      sequence = ++workspaceSequence.current,
      abort = new AbortController();
    workspaceRead.current?.abort();
    workspaceRead.current = abort;
    setWorkspaceLoading(true);
    try {
      const next = await readAgentChatWorkspace(authority, abort.signal);
      if (!valid(token) || abort.signal.aborted || sequence !== workspaceSequence.current) return;
      setWorkspace(next);
      setModelId((current) =>
        next.models.some((model) => model.id === current) ? current : (next.models[0]?.id ?? ""),
      );
    } catch (failure) {
      if (valid(token) && !abort.signal.aborted && sequence === workspaceSequence.current)
        fail(failure);
    } finally {
      if (valid(token) && sequence === workspaceSequence.current) setWorkspaceLoading(false);
    }
  }, [authority, valid, fail]);
  useEffect(() => {
    void loadWorkspace();
    const changed = () => {
      void loadWorkspace();
    };
    window.addEventListener("yummyai.models.changed", changed);
    return () => window.removeEventListener("yummyai.models.changed", changed);
  }, [loadWorkspace]);

  const observe = useCallback(
    async (view: AssistView, execute: boolean) => {
      if (
        !valid() ||
        view.request?.kind !== "knowledge_answer" ||
        view.scope !== "knowledge:" + scopeRef.current
      )
        return;
      const id = scopeRef.current,
        token = epoch.current,
        currentGeneration = generation.current,
        sequence = ++streamSequence.current,
        abort = new AbortController();
      streamRead.current?.abort();
      streamRead.current = abort;
      setPartial({ id: view.id, text: "" });
      setConnection(execute ? "connecting" : "reconnecting");
      const current = () =>
        valid(token) &&
        !abort.signal.aborted &&
        id === scopeRef.current &&
        currentGeneration === generation.current &&
        sequence === streamSequence.current;
      try {
        await streamAgentChatRun(
          view.id,
          { requestId: view.request.requestId, inputFingerprint: view.inputFingerprint },
          authority,
          execute,
          abort.signal,
          async (event: AgentChatEvent) => {
            if (!current()) return;
            if (event.type === "status") {
              setStatusText(event.text);
              return;
            }
            if (event.type === "text_delta") {
              setConnection("streaming");
              setPartial((previous) =>
                previous?.id === view.id
                  ? { id: view.id, text: previous.text + event.text }
                  : { id: view.id, text: event.text },
              );
              return;
            }
            if (event.type === "error") {
              setError("当前连接无法核对最终结果 原任务可能仍在完成 请只读取原任务");
              return;
            }
            const checked = await assertAssistEntryResponse(
              event.run,
              view.request!,
              "knowledge:" + id,
            );
            if (!current()) return;
            adoptViews([...viewsRef.current.filter((row) => row.id !== checked.id), checked]);
            setPartial(null);
            setStatusText("");
            if (checked.status !== "completed")
              setError(checked.error ?? "本轮任务需要处理 请核对原回执");
            void loadWorkspace();
          },
        );
      } catch (failure) {
        if (current()) fail(failure);
      } finally {
        if (current()) {
          setConnection("idle");
          streamRead.current = null;
        }
      }
    },
    [authority, valid, fail, adoptViews, loadWorkspace],
  );

  const loadHistory = useCallback(
    async (id: string, reconnect = true) => {
      if (!valid() || id !== scopeRef.current) return;
      const sequence = ++historySequence.current,
        token = epoch.current,
        currentGeneration = generation.current,
        abort = new AbortController();
      historyRead.current?.abort();
      historyRead.current = abort;
      setHistoryLoading(true);
      const current = () =>
        valid(token) &&
        !abort.signal.aborted &&
        sequence === historySequence.current &&
        currentGeneration === generation.current &&
        id === scopeRef.current;
      try {
        const result = await readAgentChatHistory(id, authority, abort.signal);
        if (!current()) return;
        adoptViews(result.turns);
        const product = restoredAgentChatProduct(result.turns);
        setProductId(product.id);
        setProductManual(true);
        setProductEditing(false);
        setProductBlocked(product.blockedReason);
        setHistoryReady(true);
        setHistoryHasMore(result.hasMore);
        setError("");
        const active = result.turns.findLast(isActive);
        if (active && reconnect) void observe(active, false);
      } catch (failure) {
        if (current()) fail(failure);
      } finally {
        if (current()) setHistoryLoading(false);
      }
    },
    [authority, valid, fail, adoptViews, observe],
  );

  useEffect(() => {
    const selection = JSON.stringify([scope, invalidLink]);
    if (loadedSelection.current === selection) return;
    loadedSelection.current = selection;
    generation.current++;
    historySequence.current++;
    streamSequence.current++;
    historyRead.current?.abort();
    streamRead.current?.abort();
    adoptViews([]);
    setPartial(null);
    setStatusText("");
    setError("");
    setConnection("idle");
    setHistoryHasMore(false);
    setDraft(drafts.current.get(scope) ?? "");
    const productDraft = productDrafts.current.get(scope);
    setProductId(productDraft?.id ?? "");
    setProductManual(productDraft?.manual ?? false);
    setProductEditing(false);
    setProductBlocked("");
    setHistoryReady(!linked);
    if (linked && !invalidLink) void loadHistory(linked);
    else setHistoryLoading(false);
  }, [scope, linked, invalidLink, adoptViews, loadHistory]);

  useEffect(() => {
    if (!historyReady || historyLoading || views.length || creating || productManual) return;
    const product = exactAgentChatProduct(
      draft,
      workspace?.products ?? [],
      workspace?.productsHasMore,
    );
    setProductId(product?.id ?? "");
  }, [
    draft,
    workspace?.products,
    workspace?.productsHasMore,
    historyReady,
    historyLoading,
    views.length,
    creating,
    productManual,
  ]);

  const sending = creating || views.some(isActive);
  const unresolved = intents.markers.filter((marker) => marker.runId === null);
  async function send() {
    if (
      !valid() ||
      submitLock.current ||
      sending ||
      !canRun ||
      invalidLink ||
      historyLoading ||
      !historyReady ||
      productBlocked ||
      !intents.ready ||
      intents.error ||
      !draft.trim() ||
      !workspace?.models.some((model) => model.id === modelId) ||
      unresolved.length
    )
      return;
    submitLock.current = true;
    setCreating(true);
    setError("");
    const id = scopeRef.current,
      token = epoch.current,
      currentGeneration = generation.current;
    const current = () =>
      valid(token) && id === scopeRef.current && currentGeneration === generation.current;
    try {
      const turn = CreateAgentChatTurnSchema.parse({
        requestId: crypto.randomUUID(),
        scopeId: id,
        previousRunId:
          viewsRef.current.filter((view) => view.status === "completed").at(-1)?.id ?? null,
        modelId,
        message: draft.trim(),
        spuIds: (() => {
          const inferred =
            !viewsRef.current.length && !productManual
              ? exactAgentChatProduct(draft, workspace.products ?? [], workspace.productsHasMore)
              : null;
          const selectedProduct =
            !viewsRef.current.length && !productManual ? (inferred?.id ?? "") : productId;
          return selectedProduct ? [selectedProduct] : [];
        })(),
      });
      const original = await prepareAssistIntent(
        agentChatAssistRequest(turn),
        preferenceScope,
        "knowledge:" + id + ":request:" + turn.requestId,
      );
      if (!current()) return;
      if (
        readAssistIntents(intents.ownerScope).some(
          (marker) => marker.kind === "knowledge_answer" && marker.runId === null,
        )
      )
        throw new AssistRequestError(409, "仍有原知识请求未核对 请只读取原请求回执");
      saveAssistIntent(original.intent);
      const raw = await createAgentChatTurn(turn, authority);
      if (!current()) return;
      const view = await assertAssistEntryResponse(raw, original.request, "knowledge:" + id);
      if (!current()) return;
      try {
        recordAssistEntryRun(original.intent, view.id);
      } catch {
        setError("原任务已登记 但本地标识未能更新 请只读取原回执 不再次发送");
      }
      adoptViews([...viewsRef.current.filter((row) => row.id !== view.id), view]);
      if (view.request?.kind === "knowledge_answer") {
        setProductId(view.request.search.spuIds[0] ?? "");
        setProductManual(true);
        setProductEditing(false);
      }
      setDraft("");
      draftRef.current = "";
      drafts.current.delete(id);
      router.replace("/ai-tasks?chat=" + id);
      if (isActive(view)) void observe(view, true);
      void loadWorkspace();
    } catch (failure) {
      if (current()) fail(failure);
    } finally {
      submitLock.current = false;
      if (current()) setCreating(false);
    }
  }

  function choose(id: string | null) {
    if (!valid() || sending) return;
    drafts.current.set(scopeRef.current, draftRef.current);
    productDrafts.current.set(scopeRef.current, { id: productId, manual: productManual });
    if (id) router.replace("/ai-tasks?chat=" + id);
    else {
      setNewScope(crypto.randomUUID());
      router.replace("/ai-tasks");
    }
  }

  const recover = useCallback(
    (view: AssistView) => {
      if (!valid() || submitLock.current || view.request?.kind !== "knowledge_answer") return;
      drafts.current.set(scopeRef.current, draftRef.current);
      setError("");
      router.replace("/ai-tasks?chat=" + view.request.scopeId);
      if (view.request.scopeId === scopeRef.current) {
        adoptViews([...viewsRef.current.filter((row) => row.id !== view.id), view]);
        const product = restoredAgentChatProduct([
          ...viewsRef.current.filter((row) => row.id !== view.id),
          view,
        ]);
        setProductId(product.id);
        setProductManual(true);
        setProductEditing(false);
        setProductBlocked(product.blockedReason);
        setHistoryReady(true);
        if (isActive(view)) void observe(view, false);
      }
    },
    [valid, router, adoptViews, observe],
  );

  if (denied)
    return (
      <section className="agent-chat-unavailable" aria-label="AI Agent 对话">
        <p role="status">当前身份或对话权限已变化 原回答与填写已隐藏 请重新核对本人会话</p>
      </section>
    );
  const messages: AgentChatMessage[] = views.flatMap((view) => {
    const request = view.request;
    const question =
      request?.taskGoal ||
      (request?.kind === "knowledge_answer" ? request.search.query : "原提问内容已不可用");
    const text =
      partial?.id === view.id
        ? partial.text
        : (view.result?.summary ??
          (view.status === "failed"
            ? (view.error ?? "本轮任务需要处理")
            : view.status === "cancelled"
              ? "本轮任务已取消"
              : view.status === "completed"
                ? "原回答正文已不可用 当前仅保留原任务回执"
                : ""));
    return [
      { id: view.id + ":question", role: "user", text: question, state: "complete" },
      {
        id: view.id,
        role: "assistant",
        text,
        state: isActive(view)
          ? "streaming"
          : view.status === "failed"
            ? "failed"
            : view.status === "cancelled"
              ? "stopped"
              : "complete",
        steps:
          statusText && partial?.id === view.id
            ? [{ id: view.id + ":status", label: statusText, state: "running" }]
            : undefined,
        usage: !isActive(view)
          ? {
              inputTokens: view.inputTokens,
              outputTokens: view.outputTokens,
              totalTokens:
                view.tokenUsage?.totalTokens ??
                (view.inputTokens !== null && view.outputTokens !== null
                  ? view.inputTokens + view.outputTokens
                  : null),
              costUsd: view.costUsd === null ? null : view.costUsd.toFixed(8),
            }
          : undefined,
        footer: view.result ? <AnswerSources view={view} /> : undefined,
      },
    ];
  });
  const model = workspace?.models.find((item) => item.id === modelId);
  const product = workspace?.products?.find((item) => item.id === productId);
  const productFixed = views.length > 0;
  const productLabel = product?.name ?? (productId ? "原对话固定商品" : "通用知识");
  const supportsStreaming =
    workspace?.streamingModelIds === undefined
      ? null
      : workspace.streamingModelIds.includes(modelId);
  return (
    <AgentChatSurface
      history={(workspace?.conversations ?? []).map((item) => ({
        id: item.scopeId,
        title: item.question.slice(0, 70),
        detail: date(item.updatedAt) + " · " + item.modelLabel,
        active: item.scopeId === scope && views.some(isActive),
      }))}
      historyLoading={workspaceLoading}
      selectedId={linked}
      onSelect={(id) => choose(id)}
      onNew={() => choose(null)}
      messages={messages}
      messagesLoading={historyLoading}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => void send()}
      busy={sending}
      canSend={
        canRun &&
        !invalidLink &&
        !historyLoading &&
        historyReady &&
        !productBlocked &&
        intents.ready &&
        !intents.error &&
        !unresolved.length &&
        Boolean(model)
      }
      connection={connection}
      models={(workspace?.models ?? []).map((item) => ({
        id: item.id,
        label:
          item.label +
          (workspace?.streamingModelIds === undefined
            ? " · 输出方式待核对"
            : workspace.streamingModelIds.includes(item.id)
              ? " · 流式"
              : " · 完整回复"),
      }))}
      modelId={modelId}
      onModelChange={setModelId}
      modelDisabled={workspaceLoading}
      stopLabel="停止接收"
      onStop={
        streamRead.current
          ? () => {
              streamSequence.current++;
              streamRead.current?.abort();
              streamRead.current = null;
              setConnection("idle");
              setError("已停止接收 任务仍会在后台完成并记录费用 可点击读取原任务核对结果");
            }
          : undefined
      }
      onRetryRead={() => {
        setError("");
        void Promise.all([
          loadWorkspace(),
          viewsRef.current.length || linked ? loadHistory(scopeRef.current) : Promise.resolve(),
        ]);
      }}
      error={
        invalidLink
          ? "对话链接无效 请从对话记录选择原任务 或新建对话"
          : error ||
            intents.error ||
            productBlocked ||
            (unresolved.length ? "仍有原请求结果未核对 请展开原请求恢复后读取回执" : "")
      }
      notice={
        <>
          {!canRun
            ? "当前账号可以读取对话 发起新对话需要运行权限"
            : "知识 工艺与运营问答 · 支持在同一对话里继续追问"}
          {!workspaceLoading && !workspace?.models.length && (
            <>
              {" "}
              · 尚未读取到可用模型 <a href="/settings/ai">配置模型</a>
            </>
          )}
          {historyHasMore && <p>当前显示最近 40 轮 原历史继续保留</p>}
        </>
      }
      configuration={
        <div className="agent-chat-config">
          <p>
            {productId
              ? "检索适用商品及通用的已发布知识"
              : "当前仅检索通用已发布知识 选择商品后可加入该商品的专属资料"}{" "}
            回答保留固定版本与引用
          </p>
          <p>
            {model?.maxTaskCostUsd === null
              ? "无费用上限 实际用量按原回执记录"
              : model
                ? "单任务费用上限 USD " + model.maxTaskCostUsd
                : "请先选择可用模型"}
          </p>
          <p>停止接收仅关闭当前连接 后台任务继续完成并记录费用</p>
        </div>
      }
      contextControl={
        <>
          <div className="agent-chat-product-context">
            <span>
              适用商品 <strong>{productLabel}</strong>
            </span>
            {productFixed ? (
              <small>本对话已固定</small>
            ) : (
              <button
                type="button"
                disabled={sending || historyLoading || !historyReady}
                aria-expanded={productEditing}
                onClick={() => setProductEditing((value) => !value)}
              >
                {productEditing ? "收起" : "修改"}
              </button>
            )}
            {!productFixed && !productManual && productId && <small>已按商品名称匹配</small>}
          </div>
          <div
            className="agent-chat-product-picker"
            data-open={productEditing && !productFixed}
            aria-hidden={!productEditing || productFixed}
          >
            <div>
              <label>
                选择适用商品
                <select
                  aria-label="适用商品"
                  value={productId}
                  disabled={productFixed || sending || historyLoading || !historyReady}
                  onChange={(event) => {
                    setProductId(event.target.value);
                    setProductManual(true);
                    setProductEditing(false);
                  }}
                >
                  <option value="">通用知识</option>
                  {(workspace?.products ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.code}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {workspace?.productsHasMore && !productFixed && (
            <p className="agent-chat-scope-note">
              仅列出前 40 个商品 未列出的商品请到<a href="/knowledge">知识库高级商品查找</a>
            </p>
          )}
          {supportsStreaming === false && model && (
            <p className="agent-chat-scope-note">当前模型返回完整回复 生成结束后显示内容</p>
          )}
          {supportsStreaming === null && model && (
            <p className="agent-chat-scope-note">当前模型的输出方式尚未读取</p>
          )}
        </>
      }
      recovery={
        <details className="agent-chat-recovery" open={unresolved.length > 0 || undefined}>
          <summary>原请求恢复{unresolved.length ? " · 有待核对请求" : ""}</summary>
          <AssistRequestRecovery
            kind="knowledge_answer"
            onRecovered={recover}
            onReadDenied={deny}
          />
        </details>
      }
      composerHint="Enter 发送 · Shift + Enter 换行 · 每轮记录实际用量"
      examples={["异形抱枕的生产文件有哪些要求", "审单时需要核对哪些定制信息"]}
    />
  );
}
