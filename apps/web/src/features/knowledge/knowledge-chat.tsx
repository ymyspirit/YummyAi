"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw, Send, Plus } from "lucide-react";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { AssistViewSchema, type AssistModel, type AssistView } from "@yummyai/contracts/ai/assist";
import {
  KnowledgeConversationSchema,
  type KnowledgeConversation,
  type KnowledgeGovernanceView,
} from "@yummyai/contracts/knowledge/governance";
import type { KnowledgeSearch, KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { assistApi, assistReadDenied, AssistRequestError } from "../ai-assist/assist-client";
import { AssistRequestRecovery } from "../ai-assist/assist-request-recovery";
import { ASSIST_INTENT_CLEAR_EVENT, prepareAssistIntent, readAssistIntents, saveAssistIntent, useAssistIntentMarkers } from "../ai-assist/assist-request-intent";
import { assertAssistEntryResponse, assistEntryVerification, recordAssistEntryRun, unverifiedAssistEntryIntents, type AssistEntryVerification } from "../ai-assist/assist-entry-recovery";
import { useErpAccess } from "../identity/erp-access";
import { governanceApi, knowledgeReadDenied } from "./knowledge-api";
import { KnowledgeScopeForm, KnowledgeAnswer } from "./knowledge-shared";
import "../ai-assist/assist-entry-recovery.css";

type Props = { data: KnowledgeGovernanceView; library: KnowledgeWorkspace };
const emptyScope = (): KnowledgeSearch => ({ query: "", topic: "all", platform: "all", market: "ALL", spuIds: [] });

export function KnowledgeChat(props: Props) {
  const access = useErpAccess(), owner = useRef(access.authority);
  if (!access.authority || owner.current !== access.authority || !requiredAssistPermissions("knowledge_answer", "read").every(bit => access.can(bit)))
    return <section className="kb-expanded" aria-label="知识对话"><p role="status">当前身份或知识读取权限尚未核对 原对话和填写已隐藏</p></section>;
  return <KnowledgeChatContent key={access.authority} {...props} authority={access.authority} preferenceScope={access.preferenceScope}
    canRun={requiredAssistPermissions("knowledge_answer", "run").every(bit => access.can(bit))} />;
}

function KnowledgeChatContent({ data, library, authority, preferenceScope, canRun }: Props & { authority: string; preferenceScope: string | null; canRun: boolean }) {
  const access = useErpAccess(), liveAuthority = useRef(access.authority);
  liveAuthority.current = access.authority;
  const intents = useAssistIntentMarkers(preferenceScope, "knowledge_answer");
  const [scope, setScope] = useState<KnowledgeSearch>(emptyScope);
  const [scopeId, setScopeId] = useState(() => crypto.randomUUID()),
    [question, setQuestion] = useState(""),
    [models, setModels] = useState<AssistModel[]>([]),
    [modelId, setModelId] = useState(""),
    [storeId, setStoreId] = useState("");
  const [views, setViews] = useState<AssistView[]>([]),
    [conversations, setConversations] = useState<KnowledgeConversation[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [denied, setDenied] = useState(false),
    [resumeUnavailable, setResumeUnavailable] = useState(false),
    [restoredPreviousId, setRestoredPreviousId] = useState<string | null>(null),
    [verified, setVerified] = useState<AssistEntryVerification[]>([]);
  const alive = useRef(true), blocked = useRef(false), sending = useRef(false), generation = useRef(0),
    currentScope = useRef(scopeId), loadEpoch = useRef(0), conversationEpoch = useRef(0),
    historyRead = useRef<AbortController | null>(null), configurationRead = useRef<AbortController | null>(null),
    refreshRead = useRef<AbortController | null>(null), recoverySequence = useRef(0),
    verifiedNow = useRef<AssistEntryVerification[]>([]), refresh = useRef<() => void>(() => {});
  const valid = useCallback(() => alive.current && !blocked.current && liveAuthority.current === authority, [authority]);
  const remember = useCallback((proofs: AssistEntryVerification[]) => {
    if (!proofs.length) return;
    const next = new Map(verifiedNow.current.map(proof => [proof.requestId, proof]));
    proofs.forEach(proof => next.set(proof.requestId, proof));
    verifiedNow.current = [...next.values()];
    setVerified(verifiedNow.current);
  }, []);
  const deny = useCallback(() => {
    blocked.current = true; generation.current++; loadEpoch.current++; conversationEpoch.current++; recoverySequence.current++;
    historyRead.current?.abort(); configurationRead.current?.abort(); refreshRead.current?.abort();
    setDenied(true); setViews([]); setConversations([]); setQuestion(""); setScope(emptyScope()); setStoreId(""); setModels([]); setModelId("");
    setError(""); setNotice(""); setResumeUnavailable(true); setRestoredPreviousId(null); verifiedNow.current = []; setVerified([]);
    window.dispatchEvent(new Event("focus"));
  }, []);
  const fail = useCallback((cause: unknown, fallback: string) => {
    if (assistReadDenied(cause) || knowledgeReadDenied(cause) || cause instanceof AssistRequestError && cause.status === 410) deny();
    else setError(cause instanceof Error ? cause.message : fallback);
  }, [deny]);
  useEffect(() => {
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, deny);
    return () => window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, deny);
  }, [deny]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; loadEpoch.current++; conversationEpoch.current++; recoverySequence.current++;
      historyRead.current?.abort(); configurationRead.current?.abort(); refreshRead.current?.abort(); };
  }, []);
  const reset = useCallback((clearInput = false) => {
    generation.current++; loadEpoch.current++; recoverySequence.current++; historyRead.current?.abort();
    const id = crypto.randomUUID(); currentScope.current = id; setScopeId(id); setViews([]); setError(""); setNotice(""); setResumeUnavailable(false); setRestoredPreviousId(null);
    if (clearInput) { setQuestion(""); setStoreId(""); }
  }, []);
  const load = useCallback(async (id: string, signal?: AbortSignal) => {
    if (!valid() || currentScope.current !== id) return [];
    historyRead.current?.abort();
    const abort = new AbortController(), token = ++loadEpoch.current;
    historyRead.current = abort;
    const combined = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
    const current = () => valid() && !combined.aborted && currentScope.current === id && loadEpoch.current === token;
    try {
      const rows = await assistApi<Array<{ id: string }>>("runs?kind=knowledge_answer&scope=" + encodeURIComponent("knowledge:" + id), undefined, combined, authority);
      const result: AssistView[] = [], proofs: AssistEntryVerification[] = [];
      for (const row of [...rows].reverse()) {
        if (!current()) return [];
        const view = AssistViewSchema.parse(await assistApi("runs/" + row.id, undefined, combined, authority));
        if (view.id !== row.id || view.kind !== "knowledge_answer" || view.scope !== "knowledge:" + id)
          throw new AssistRequestError(502, "原回答与实际对话范围不一致 未采用另一笔任务");
        const proof = await assistEntryVerification(view);
        if (!current()) return [];
        result.push(view); if (proof && view.status === "completed") proofs.push(proof);
      }
      if (current()) { setViews(result); remember(proofs); }
      return current() ? result : [];
    } catch (cause) { if (!current()) return []; fail(cause, "回答读取失败 请只读取原回执"); throw cause; }
  }, [authority, valid, remember, fail]);
  const readConversations = useCallback(async (signal?: AbortSignal) => {
    const token = ++conversationEpoch.current;
    const rows = KnowledgeConversationSchema.array().parse(await governanceApi("conversations", undefined, signal, authority));
    if (valid() && !signal?.aborted && token === conversationEpoch.current) setConversations(rows);
  }, [authority, valid]);
  useEffect(() => {
    const abort = new AbortController(); configurationRead.current = abort;
    void Promise.all([
      assistApi<AssistModel[]>("models", undefined, abort.signal, authority),
      governanceApi("conversations", undefined, abort.signal, authority),
    ]).then(([options, raw]) => {
      const rows = KnowledgeConversationSchema.array().parse(raw);
      if (valid() && !abort.signal.aborted) { setModels(options); setConversations(rows); }
    }).catch(cause => { if (valid() && !abort.signal.aborted) fail(cause, "对话配置暂不可读取"); });
    return () => abort.abort();
  }, [authority, fail, valid]);
  const running = views.some(view => ["queued", "running"].includes(view.status));
  useEffect(() => {
    if (!running) return;
    const abort = new AbortController(), timer = setInterval(() => {
      void load(scopeId, abort.signal).catch(() => { /* load reports only current reads. */ });
    }, 3000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [running, scopeId, load]);
  refresh.current = () => {
    if (!valid() || sending.current || busy || document.visibilityState !== "visible") return;
    refreshRead.current?.abort();
    const abort = new AbortController(); refreshRead.current = abort;
    void Promise.all([views.length ? load(currentScope.current, abort.signal) : Promise.resolve([]), readConversations(abort.signal)])
      .catch(cause => { if (valid() && !abort.signal.aborted) fail(cause, "回答与对话列表暂不可读取"); });
  };
  useEffect(() => {
    const check = () => refresh.current(), timer = setInterval(check, 30000);
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { clearInterval(timer); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid() || sending.current || busy || running || resumeUnavailable || !canRun || !question.trim() || !models.some(model => model.id === modelId) || !preferenceScope || !intents.ready || intents.error) return;
    sending.current = true; setBusy(true); setError(""); setNotice("");
    const token = generation.current, id = currentScope.current;
    const current = () => valid() && token === generation.current && id === currentScope.current;
    let registered = false;
    try {
      if (unverifiedAssistEntryIntents(readAssistIntents(intents.ownerScope), "knowledge_answer", verifiedNow.current).length)
        throw new AssistRequestError(409, "仍有本人的原知识请求未核对 请先只读取原回执 或明确确认另起任务的重复付费风险");
      const requestId = crypto.randomUUID(), previous = views.filter(view => view.status === "completed").at(-1);
      const original = await prepareAssistIntent({
        kind: "knowledge_answer", scopeId: id, search: { ...scope, query: question.trim() }, purpose: "dialogue",
        evidenceStoreId: storeId || null, previousRunId: previous?.id ?? restoredPreviousId, modelId, requestId,
      }, preferenceScope, "knowledge:" + id + ":request:" + requestId);
      if (!current()) return;
      if (unverifiedAssistEntryIntents(readAssistIntents(intents.ownerScope), "knowledge_answer", verifiedNow.current).length)
        throw new AssistRequestError(409, "原知识请求在准备期间发生变化 请先读取原回执 本次未重复发送");
      saveAssistIntent(original.intent);
      const value = await assistApi("runs", original.request, undefined, authority);
      if (!current()) return;
      const view = await assertAssistEntryResponse(value, original.request, "knowledge:" + id);
      if (!current()) return;
      registered = true;
      try { recordAssistEntryRun(original.intent, view.id); }
      catch { setNotice("原任务已登记 但本地任务 ID 未能更新 请只读取原回执 不再次提交"); }
      setViews(rows => [...rows.filter(row => row.id !== view.id), view]); setQuestion("");
      if (view.status === "completed") {
        const proof = await assistEntryVerification(view);
        if (!current()) return; if (proof) remember([proof]);
      }
      try { await Promise.all([load(id), readConversations()]); }
      catch (cause) { if (current()) fail(cause, "原任务已登记 后续读取未完成 请只读取原回执"); }
    } catch (cause) {
      if (current()) fail(cause, registered ? "原任务已登记 请只读取原回执" : "原知识请求结果尚未确认 请只读取原回执 不重复付费");
    } finally { sending.current = false; if (valid()) setBusy(false); }
  };
  const recovered = useCallback((view: AssistView) => {
    if (sending.current) return;
    const token = ++recoverySequence.current;
    void (async () => {
      if (!valid()) return;
      if (view.kind !== "knowledge_answer" || view.request && view.request.kind !== "knowledge_answer")
        throw new AssistRequestError(502, "原回执不是知识对话 未替换当前对话");
      const proof = await assistEntryVerification(view);
      if (!valid() || token !== recoverySequence.current) return;
      const original = view.request;
      if (!original || original.kind !== "knowledge_answer") {
        setNotice("原对话正文已不可用 只保留原回执 不从当前随机范围重建原对话");
        return;
      }
      generation.current++; loadEpoch.current++; historyRead.current?.abort();
      currentScope.current = original.scopeId; setScopeId(original.scopeId);
      setScope({ ...original.search, query: "" }); setStoreId(original.evidenceStoreId ?? ""); setModelId(original.modelId); setQuestion(""); setRestoredPreviousId(original.previousRunId); setResumeUnavailable(false);
      setViews(rows => view.scope === "knowledge:" + scopeId ? [...rows.filter(row => row.id !== view.id), view] : [view]);
      if (proof && view.status === "completed") remember([proof]);
      setNotice("已恢复实际原对话范围与前次任务依据 追问不使用刷新后的随机范围");
      setError("");
    })().catch(cause => { if (valid() && token === recoverySequence.current) fail(cause, "原知识回执暂不可恢复"); });
  }, [fail, remember, scopeId, valid]);
  const resume = async (id: string) => {
    if (!valid() || sending.current || busy || running) return;
    sending.current = true; setBusy(true); setError(""); setNotice("");
    const token = ++generation.current; recoverySequence.current++; loadEpoch.current++; historyRead.current?.abort();
    setResumeUnavailable(true); setViews([]); setQuestion(""); setScope(emptyScope()); setStoreId(""); setModelId(""); setRestoredPreviousId(null);
    currentScope.current = id; setScopeId(id);
    try {
      const rows = await load(id), original = rows.at(-1)?.request;
      if (valid() && token === generation.current && currentScope.current === id && original?.kind === "knowledge_answer" && original.scopeId === id) {
        setScope({ ...original.search, query: "" }); setStoreId(original.evidenceStoreId ?? ""); setModelId(original.modelId); setRestoredPreviousId(original.previousRunId); setResumeUnavailable(false);
      }
    } catch (cause) { if (valid() && token === generation.current && currentScope.current === id) fail(cause, "历史对话读取失败 请只读取原回执"); }
    finally { sending.current = false; if (valid()) setBusy(false); }
  };
  const model = models.find(item => item.id === modelId);
  const unresolved = unverifiedAssistEntryIntents(intents.markers, "knowledge_answer", verified);
  if (denied) return <section className="kb-expanded" aria-label="知识对话"><p role="status">当前知识读取权限已变化 原回答 范围和填写已隐藏 同一账号的纯 ID 标识保留供后续核对</p></section>;
  return (
    <section className="kb-expanded assist-entry-recovery" aria-label="知识对话">
      <div className="kb-section-toolbar">
        <p className="kb-meta">回答只使用本次范围内的有效已发布知识 出处与版本固定保留 产品事实和生产放行继续依照 ERP 与规则中心</p>
        <button className="oc-button" disabled={busy || running} onClick={() => reset()}><Plus size={14} />新对话</button>
      </div>
      <AssistRequestRecovery kind="knowledge_answer" onRecovered={recovered} onReadDenied={deny} />
      {resumeUnavailable && <div>
        <p className="kb-error" role="status">原对话依据尚未读取成功 新付费已锁定 不沿用上一段对话的范围或前次任务 请重新读取原对话 或明确新对话</p>
        <button type="button" className="oc-button" disabled={busy || running} onClick={() => void resume(currentScope.current)}><RefreshCw size={14} />重新读取原对话</button>
      </div>}
      {unresolved.length > 0 && <p className="kb-error" role="status">仍有 {unresolved.length} 笔原知识请求未核对 先读取原回执 不以切换模型 范围或新对话重复付费</p>}
      <fieldset disabled={busy || running}>
        <div className="kb-form">
          <div className="kb-form-grid">
            <label>已配置模型<select aria-label="已配置模型" value={modelId} onChange={event => setModelId(event.target.value)}>
              <option value="">选择模型</option>
              {modelId && !model && <option value={modelId} disabled>原模型当前不可选 请重新核对可用模型</option>}
              {models.map(item => <option key={item.id} value={item.id}>{item.label} · {item.model}</option>)}
            </select></label>
            <label>最近对话<select aria-label="最近对话" value={conversations.some(item => item.scopeId === scopeId) ? scopeId : ""}
              onChange={event => event.target.value && void resume(event.target.value)}>
              <option value="">选择历史对话</option>
              {conversations.map(item => <option key={item.scopeId} value={item.scopeId}>{item.question.slice(0, 70)} · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}</option>)}
            </select></label>
          </div>
          <KnowledgeScopeForm value={scope} onChange={value => { setScope(value); reset(); }} spus={library.spus} />
          {data.canReadAccount && <label>账户证据范围<select aria-label="账户证据范围" value={storeId} onChange={event => {
            setStoreId(event.target.value); reset();
            const store = data.stores.find(item => item.id === event.target.value);
            if (store) setScope(value => ({ ...value, platform: store.platform as KnowledgeSearch["platform"], market: value.market === "ALL" ? "US" : value.market }));
          }}>
            <option value="">仅运营知识卡</option>
            {data.stores.map(store => <option value={store.id} key={store.id}>附加脱敏证据：{store.name}</option>)}
          </select></label>}
          <p className="kb-meta">{model ? "单次任务预算上限 " + (model.maxTaskCostUsd === null ? "未配置" : "$" + model.maxTaskCostUsd) + " 发送问题才会调用模型" :
            "先选择已配置的分析模型 未配置时可使用检索验证查看知识覆盖"} 改变范围会开始新对话 原未确认请求仍需核对</p>
        </div>
      </fieldset>
      {error && <p className="kb-error" role="alert">{error}</p>}
      {notice && <p className="assist-entry-note" role="status">{notice}</p>}
      {!canRun && <p className="kb-meta">当前可读取原回答 发起新回答还需知识运行权限</p>}
      <div className="kb-chat-history">
        {!views.length ? <p className="kb-empty">暂无对话 可询问已有 SOP 运营方法或指定店铺的脱敏报告 缺少依据时会说明资料缺口</p> :
          views.map(view => <KnowledgeAnswer view={view} key={view.id} />)}
      </div>
      <form className="kb-form" onSubmit={send}>
        <label>问题或追问<textarea aria-label="问题或追问" value={question} maxLength={300} rows={3} required disabled={busy || running || !canRun}
          onChange={event => setQuestion(event.target.value)} placeholder="例如 客户照片不清晰时应该怎样处理" /></label>
        <div className="kb-inline-actions">
          <button className="oc-button primary" type="submit" disabled={busy || running || resumeUnavailable || !canRun || !model || !question.trim() || !intents.ready || Boolean(intents.error) || unresolved.length > 0}>
            <Send size={14} />{busy ? "正在提交…" : running ? "等待回答…" : "发送并检索知识"}
          </button>
          {views.length > 0 && <button type="button" className="oc-button" disabled={busy} onClick={() => refresh.current()}><RefreshCw size={14} />刷新回答</button>}
        </div>
      </form>
    </section>
  );
}
