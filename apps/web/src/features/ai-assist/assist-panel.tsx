"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { RefreshCw, ScanSearch, Sparkles } from "lucide-react";
import {
  AssistViewSchema,
  businessAssistSelection,
  type AssistDirection,
  type AssistKind,
  type AssistMatch,
  type AssistListingCopy,
  type AssistTemplateSlot,
  type AssistModel,
  type AssistView,
  type AssistBusinessSelection,
  type CreateAssist,
} from "@yummyai/contracts/ai/assist";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { useErpAccess } from "../identity/erp-access";
import type { AssistIntent } from "@yummyai/contracts/ai/assist-recovery";
import { ASSIST_INTENT_CLEAR_EVENT, prepareAssistIntent, recordAssistIntentRun, saveAssistIntent, useAssistIntentMarkers } from "./assist-request-intent";
import { AssistRequestRecovery } from "./assist-request-recovery";
import { AssistRequestError, assistApi, assistReadDenied, sameAssistInput, type AssistInput } from "./assist-client";
import { ListingSuggestions, TemplateSuggestions, type CopyField } from "./assist-business-results";
import "./assist.css";
import { MethodEvidence } from "./method-evidence";
import { ActionResults } from "./action-results";
import { useWorkflowReturn } from "../navigation/use-workflow-return";
import { workflowHref } from "../navigation/workflow-href";
import { InvocationEvidence } from "../execution/invocation-evidence";

const names = {
  knowledge_answer: "知识对话",
  creative: "创意 AI 分析",
  order_review: "订单 AI 预审",
  artwork_preflight: "生产稿 AI 预检",
  template_config: "PSD 模板配置助手",
  sku_package: "SKU 资料包助手",
  business_review: "经营 AI 分析",
  procurement_review: "采购 AI 分析",
  after_sales_review: "售后 AI 分析",
};
const statusNames = {
  queued: "排队中",
  running: "分析中",
  completed: "分析完成",
  failed: "分析失败",
  cancelled: "已取消",
};
export type DirectionField =
  | "prompt"
  | "negativePrompt"
  | "audience"
  | "occasion"
  | "style"
  | "fixedElements"
  | "imageInstructions"
  | "acceptance"
  | "customization";
const directionFields: Array<{ key: DirectionField; label: string }> = [
  { key: "prompt", label: "设计描述" },
  { key: "negativePrompt", label: "避免元素" },
  { key: "audience", label: "目标人群" },
  { key: "occasion", label: "使用场景" },
  { key: "style", label: "风格与配色" },
  { key: "fixedElements", label: "固定元素" },
  { key: "imageInstructions", label: "图片处理要求" },
  { key: "acceptance", label: "验收要求" },
  { key: "customization", label: "定制方式与字段" },
];
type HistoryRow = {
  id: string;
  status: AssistView["status"];
  modelLabel: string;
  createdAt: string;
};

function EvidenceImage({ image }: { image: AssistView["images"][number] }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return failed ? (
    <div className="ai-assist-image-error" role="alert">
      <span>图片暂不可用，资料过期或订单更新后需重新分析。</span>
      <button
        type="button"
        onClick={() => {
          setAttempt((value) => value + 1);
          setFailed(false);
        }}
      >
        重试加载图片
      </button>
    </div>
  ) : (
    <Image
      src={`${image.path}?previewAttempt=${attempt}`}
      alt={image.label}
      width={320}
      height={240}
      unoptimized
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function AssistPanel(props: Parameters<typeof AssistPanelContent>[0]) {
  const access = useErpAccess();
  if (!access.authority || !requiredAssistPermissions(props.kind, "read").every(bit => access.can(bit)))
    return <section className="ai-assist" aria-label={names[props.kind]}><p role="status">当前身份或分析读取权限尚未核对 原结果与填写已隐藏</p></section>;
  return <AssistPanelContent key={access.authority + ":" + props.kind + ":" + props.scope} {...props} />;
}
function AssistPanelContent({
  kind,
  scope,
  initialRunId,
  readOnly = false,
  externalAdoption = false,
  onRunChange,
  onReadDenied,
  input,
  disabledReason,
  onDirection,
  onMatch,
  onTemplateSlot,
  onListingCopy,
  onRestoreBusiness,
}: {
  kind: AssistKind;
  scope: string;
  initialRunId?: string;
  readOnly?: boolean;
  externalAdoption?: boolean;
  onRunChange?: (view: AssistView) => void;
  onReadDenied?: (message: string) => void;
  input: AssistInput | null;
  disabledReason?: string;
  onDirection?: (direction: AssistDirection, fields: DirectionField[]) => boolean | void;
  onMatch?: (match: AssistMatch) => boolean | void;
  onTemplateSlot?: (slot: AssistTemplateSlot) => boolean | void;
  onListingCopy?: (copy: AssistListingCopy, fields: CopyField[]) => boolean | void;
  onRestoreBusiness?: (selection: AssistBusinessSelection) => void;
}) {
  const access = useErpAccess(), authority = access.authority ?? "";
  const api = useCallback(<T,>(path: string, body?: unknown, signal?: AbortSignal) => assistApi<T>(path, body, signal, authority), [authority]);
  const intentState = useAssistIntentMarkers(access.preferenceScope, kind, scope);
  const canStart = requiredAssistPermissions(kind, "run").every(bit => access.can(bit));
  const [privateDenied, setPrivateDenied] = useState(false);
  const workflow = useWorkflowReturn();
  const search = useSearchParams();
  const linkedRunId = initialRunId ?? search?.get("assistRun") ?? null;
  const [models, setModels] = useState<AssistModel[]>([]),
    [modelId, setModelId] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]),
    [view, setView] = useState<AssistView | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<AssistDirection | null>(null),
    [fields, setFields] = useState<DirectionField[]>([]);
  const pending = useRef<{ input: CreateAssist; intent: AssistIntent } | null>(null), submitting = useRef(false), mounted = useRef(true), privateBlocked = useRef(false);
  const readEpoch = useRef(0),
    deniedCallback = useRef(onReadDenied);
  deniedCallback.current = onReadDenied;
  const clearDenied = useCallback((cause: unknown) => {
    if (!assistReadDenied(cause)) return false;
    privateBlocked.current = true;
    readEpoch.current++;
    setPrivateDenied(true);
    setView(null);
    setHistory([]);
    setSelected(null);
    setFields([]);
    setNotice("");
    setModels([]);
    setModelId("");
    pending.current = null;
    setError(cause.message);
    deniedCallback.current?.(cause.message);
    window.dispatchEvent(new Event("focus"));
    return true;
  }, []);
  useEffect(() => {
    const cleared = () => { clearDenied(new AssistRequestError(409, "正在退出或切换本人身份 原分析与填写已隐藏", "authority_changed")); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, cleared);
    return () => window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, cleared);
  }, [clearDenied]);
  const mountedScope = useRef(scope);
  mountedScope.current = scope;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (privateBlocked.current) return;
      const epoch = readEpoch.current;
      if (readOnly && linkedRunId) {
        const saved = AssistViewSchema.parse(
          await api(`runs/${linkedRunId}`, undefined, signal),
        );
        if (mountedScope.current !== scope || signal?.aborted || epoch !== readEpoch.current)
          return;
        if (saved.kind !== kind || saved.scope !== scope)
          throw new Error("该任务属于另一业务对象，请从 AI 任务工作台核对对应对象。");
        setView(saved);
        setHistory([
          {
            id: saved.id,
            status: saved.status,
            createdAt: saved.createdAt,
            modelLabel: saved.modelLabel,
          },
        ]);
        return;
      }
      const [available, rows] = await Promise.all([
        api<AssistModel[]>("models", undefined, signal),
        api<HistoryRow[]>(
          `runs?kind=${kind}&scope=${encodeURIComponent(scope)}`,
          undefined,
          signal,
        ),
      ]);
      if (mountedScope.current !== scope || signal?.aborted || epoch !== readEpoch.current) return;
      setModels(available);
      setModelId((id) => (available.some((m) => m.id === id) ? id : (available[0]?.id ?? "")));
      const runId = linkedRunId ?? rows[0]?.id;
      const saved = runId
        ? AssistViewSchema.parse(await api(`runs/${runId}`, undefined, signal))
        : null;
      if (mountedScope.current !== scope || signal?.aborted || epoch !== readEpoch.current) return;
      if (saved && (saved.kind !== kind || saved.scope !== scope))
        throw new Error("该任务属于另一业务对象，请从 AI 任务工作台核对对应对象。");
      setHistory(
        saved && !rows.some((row) => row.id === saved.id)
          ? [
              {
                id: saved.id,
                status: saved.status,
                modelLabel: saved.modelLabel,
                createdAt: saved.createdAt,
              },
              ...rows,
            ]
          : rows,
      );
      setView(saved);
    },
    [kind, scope, linkedRunId, readOnly, api],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setView(null);
    setSelected(null);
    setError("");
    void refresh(controller.signal)
      .catch((cause) => {
        if (!controller.signal.aborted && !clearDenied(cause))
          setError(cause instanceof Error ? cause.message : "分析记录读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, clearDenied]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readEpoch.current++; pending.current = null; }; }, []);
  const active = view?.status === "queued" || view?.status === "running";
  useEffect(() => {
    if (view) onRunChange?.(view);
  }, [view, onRunChange]);
  useEffect(() => {
    if (!view) return;
    let pendingRead: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      clearTimeout(timer);
      pendingRead?.abort();
      if (privateBlocked.current) return;
      const controller = new AbortController();
      pendingRead = controller;
      const epoch = readEpoch.current;
      try {
        const next = AssistViewSchema.parse(
          await api(`runs/${view.id}`, undefined, controller.signal),
        );
        if (
          controller.signal.aborted ||
          epoch !== readEpoch.current ||
          mountedScope.current !== scope
        )
          return;
        setView(next);
        setError("");
        timer = setTimeout(
          () => void poll(),
          ["queued", "running"].includes(next.status) ? 2500 : 30000,
        );
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          epoch === readEpoch.current &&
          mountedScope.current === scope
        ) {
          if (clearDenied(cause)) return;
          setError(cause instanceof Error ? cause.message : "状态读取失败，任务仍在后台运行");
          timer = setTimeout(() => void poll(), 10000);
        }
      }
    };
    const focus = () => {
      if (!document.hidden) void poll();
    };
    timer = setTimeout(() => void poll(), active ? 1500 : 30000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      pendingRead?.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [active, view?.id, clearDenied, scope, api]);
  const stale =
    !!view &&
    (view.stale || (!readOnly && (!sameAssistInput(view.request, input) || !!disabledReason)));
  async function start() {
    if (privateBlocked.current || readOnly || !canStart || !input || !modelId || busy || active || disabledReason || submitting.current || !intentState.ready || intentState.error || intentLocked || !access.preferenceScope) return;
    submitting.current = true;
    const epoch = readEpoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    setSelected(null);
    try {
      const original = await prepareAssistIntent({ ...input, modelId, requestId: crypto.randomUUID() }, access.preferenceScope, scope);
      if (!mounted.current || mountedScope.current !== scope || epoch !== readEpoch.current) return;
      saveAssistIntent(original.intent); pending.current = { input: structuredClone(original.request), intent: original.intent };
      const next = AssistViewSchema.parse(await api("runs", original.request));
      if (!mounted.current || mountedScope.current !== scope || epoch !== readEpoch.current) return;
      setView(next);
      try {
        recordAssistIntentRun(original.intent, next.id);
      } catch { setNotice("原任务已返回 但恢复标识更新失败 请记录实际任务 ID 不重复提交"); }
      pending.current = null;
      setHistory((rows) => [
        {
          id: next.id,
          status: next.status,
          modelLabel: next.modelLabel,
          createdAt: next.createdAt,
        },
        ...rows.filter((r) => r.id !== next.id),
      ]);
    } catch (cause) {
      if (epoch === readEpoch.current && mountedScope.current === scope && !clearDenied(cause))
        setError(cause instanceof Error ? cause.message : "发起分析失败");
    } finally {
      submitting.current = false;
      if (mounted.current && epoch === readEpoch.current) setBusy(false);
    }
  }
  const intentLocked = intentState.markers.length > 0 || intentState.allMarkers.some(item => item.kind === kind && item.runId === null);
  const model = models.find((m) => m.id === modelId);
  const sourceLabel = (id: string) => view?.sources.find((s) => s.id === id)?.label ?? id;
  if (privateDenied) return <section className="ai-assist" aria-label={names[kind]}><p role="status">当前分析读取权限已变化 原结果和填写已隐藏 重新核对权限后可只读恢复原回执</p></section>;
  return (
    <section className="ai-assist" aria-label={names[kind]}>
      <div className="ai-assist-heading">
        <h3>
          <ScanSearch size={16} />
          {names[kind]}
        </h3>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => {
            setError("");
            void refresh().catch((cause) => {
              if (!clearDenied(cause))
                setError(cause instanceof Error ? cause.message : "刷新失败");
            });
          }}
        >
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      <p className="ai-assist-muted">
        {kind === "knowledge_answer"
          ? "根据已发布的运营知识回答问题，列出引用、适用条件与资料缺口。"
          : kind === "business_review"
            ? "解释所选利润计算、成本结构与关联订单的当前进度，核对缺项后形成行动建议。"
            : kind === "procurement_review"
              ? "根据当前库存、规则、未收采购和有效报价提出补货核对建议。"
              : kind === "after_sales_review"
                ? "整理当前售后状态与问题说明，生成处理建议和可编辑的客服回复草稿。"
                : kind === "template_config"
                  ? "根据已解析的图层结构建议槽位分类、顾客字段与复用关系。确认配置后再创建模板版本。"
                  : kind === "sku_package"
                    ? "根据已批准的 SKU 配方、产品事实与当前授权套图拟定文案，选择字段填入 Listing 草稿。"
                    : kind === "creative"
                      ? "分析选中的研究快照与图片，提出 3 个原创方向。选择并核对需要填入需求单的字段。"
                      : kind === "order_review"
                        ? "核对已保存的订单信息；销售 SKU 已匹配时保留现有绑定，未匹配时建议印花和产品规格。"
                        : "对照订单需求检查当前已保存的生产稿。规则检查与 AI 视觉意见共同列出，正式审核仍按原流程执行。"}
      </p>
      {loading ? (
        <p role="status">正在读取分析配置…</p>
      ) : !readOnly && !models.length && !error ? (
        <p className="ai-assist-empty">
          尚未配置可用的分析模型。
          <Link href={workflowHref("/settings/ai", workflow.current)}>前往 AI 模型配置</Link>
          ，添加并启用文本模型后即可共用；分析图片时需支持图像输入。
        </p>
      ) : !readOnly ? (
        <div className="ai-assist-controls">
          <label>
            图文模型
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              disabled={busy || active || intentLocked}
            >
              <option value="" disabled>
                选择模型
              </option>
              {models.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.label} · {m.providerLabel}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            type="button"
            disabled={!canStart || !modelId || !input || !!disabledReason || active || busy || intentLocked || !intentState.ready || Boolean(intentState.error)}
            onClick={() => void start()}
          >
            <Sparkles size={14} />
            {busy ? "正在提交…" : active ? "后台分析中…" : view ? "重新分析" : "开始分析"}
          </button>
          {model && (
            <small>
              {model.maxTaskCostUsd === null
                ? "共用已保存的文本模型；价格未填写，费用以渠道账单为准。"
                : `单次预估上限 $${model.maxTaskCostUsd}。`}{" "}
              每次分析最多输出 6000 tokens；重新分析会调用渠道。
            </small>
          )}
        </div>
      ) : null}
      {disabledReason && <p className="ai-assist-muted">{disabledReason}</p>}
      {!readOnly && !canStart && <p className="ai-assist-muted">当前仅可读取原分析 没有本类任务的发起权限</p>}
      {model && (kind === "order_review" || kind === "artwork_preflight") && (
        <p className="ai-assist-muted">
          开始分析会将本单定制字段与选中的图片发送至“{model.providerLabel}”。
        </p>
      )}
      {model && ["business_review", "procurement_review", "after_sales_review"].includes(kind) && (
        <p className="ai-assist-muted">
          开始分析会将已核对的业务依据发送至“{model.providerLabel}”。
        </p>
      )}
      {error && (
        <p role="alert" className="ai-assist-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!readOnly && <><AssistRequestRecovery kind={kind} scope={scope} onRecovered={setView} onReadDenied={message => clearDenied(new AssistRequestError(403, message))} />
        {intentLocked && <p className="ai-assist-warning">原请求尚未明确结束核对 已锁定新提交 改模型或资料不会自动换编号 请只读恢复原回执</p>}
        {intentState.error && <p className="ai-assist-error" role="alert">{intentState.error}</p>}</>}
      {!!history.length && (
        <label className="ai-assist-history">
          分析记录
          <select
            value={view?.id ?? history[0]?.id}
            onChange={(e) => {
              const epoch = ++readEpoch.current;
              setSelected(null);
              setView(null);
              void api(`runs/${e.target.value}`)
                .then((data) => {
                  if (epoch === readEpoch.current && mountedScope.current === scope)
                    setView(AssistViewSchema.parse(data));
                })
                .catch((cause) => {
                  if (epoch === readEpoch.current && !clearDenied(cause))
                    setError(cause instanceof Error ? cause.message : "读取失败");
                });
            }}
          >
            {history.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.createdAt).toLocaleString("zh-CN")} · {r.modelLabel} ·{" "}
                {statusNames[r.id === view?.id ? view.status : r.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {view && (
        <div className="ai-assist-report">
          <div className="ai-assist-meta">
            <strong role="status">{statusNames[view.status]}</strong>
            <span>{view.modelLabel}</span>
            <span>
              {view.costUsd === null
                ? view.budgetState === "released"
                  ? "费用预留已释放"
                  : "费用待渠道确认"
                : `按配置估算 $${view.costUsd.toFixed(4)}`}
              {view.inputTokens !== null &&
                view.outputTokens !== null &&
                ` · ${view.inputTokens}/${view.outputTokens} tokens`}
            </span>
          </div>
          {active && (
            <p>
              任务在后台运行，可以离开此页，稍后查看记录。
              {!readOnly && view.status === "queued" && view.request && (
                <button
                  type="button"
                  disabled={busy || stale}
                  onClick={() => {
                    void refresh().catch(cause => { if (mounted.current && !clearDenied(cause)) setError("原排队状态暂不可读取 不重新发起或入队"); });
                  }}
                >
                  只读取原排队状态
                </button>
              )}
            </p>
          )}
          <InvocationEvidence key={view.id} entries={view.invocations} />
          <MethodEvidence selection={view.methodSelection} />
          {stale && (
            <p className="ai-assist-warning">
              当前资料、版本或草稿已变化；这份结果不可直接采用，请保存并根据当前资料重新分析。
            </p>
          )}
          {onRestoreBusiness &&
            view.request &&
            "expectedFingerprint" in view.request &&
            !view.stale && (
              <button
                type="button"
                onClick={() => {
                  const saved = view.request;
                  if (saved && "expectedFingerprint" in saved) {
                    onRestoreBusiness(businessAssistSelection(saved));
                  }
                }}
              >
                载入这次分析的选项
              </button>
            )}
          {view.error && (
            <p role="alert" className="ai-assist-error">
              {view.error}
            </p>
          )}
          {!!view.diagnostics.length && (
            <ul className="ai-assist-warning">
              {view.diagnostics.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {!!view.knowledge.length && (
            <details>
              <summary>本次使用的知识 · {view.knowledge.length} 条</summary>
              <ul className="ai-assist-findings">
                {view.knowledge.map((reference) => (
                  <li key={reference.sourceId}>
                    <Link href={reference.href}>
                      {reference.title} · V{reference.version}
                    </Link>
                    <p>{reference.excerpt}</p>
                    <small>
                      来源：{reference.sourceLabel} · 核对：{reference.verifiedOn} · 复查：
                      {reference.reviewDueOn}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!view.images.length && (
            <details open={kind === "artwork_preflight"}>
              <summary>本次实际分析图片 · {view.images.length} 张</summary>
              <div className="ai-assist-images">
                {view.images.map((image) => (
                  <figure key={`${view.id}:${image.sourceId}`}>
                    <EvidenceImage image={image} />
                    <figcaption>{image.label}</figcaption>
                  </figure>
                ))}
              </div>
            </details>
          )}
          {!!view.checks.length && (
            <details open>
              <summary>规则检查 · {view.checks.length} 项</summary>
              <ul className="ai-assist-findings">
                {view.checks.map((check, i) => (
                  <li key={i} data-severity={check.severity}>
                    <strong>
                      {
                        { info: "信息", warning: "提示", error: "问题", manual: "人工核对" }[
                          check.severity
                        ]
                      }
                    </strong>
                    <span>
                      {check.message}
                      {check.location && <small>位置：{check.location}</small>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {view.result && (
            <>
              <p>{view.result.summary}</p>
              <ActionResults key={`actions:${view.id}`} view={view} stale={stale} />
              {!!view.result.missingInformation.length && (
                <div className="ai-assist-warning">
                  <strong>待补资料</strong>
                  <ul>
                    {view.result.missingInformation.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {!!view.result.findings.length && (
                <details open>
                  <summary>AI 分析意见</summary>
                  <ul className="ai-assist-findings">
                    {view.result.findings.map((f, i) => (
                      <li data-severity={f.severity} key={i}>
                        <strong>
                          {{ fact: "资料观察", inference: "推测", recommendation: "建议" }[f.kind]}
                        </strong>
                        <div>
                          <b>{f.title}</b>
                          <p>{f.detail}</p>
                          {f.location && <small>位置：{f.location}</small>}
                          {f.evidence.map((e, j) => (
                            <small key={j}>
                              依据：{sourceLabel(e.sourceId)} — {e.detail}
                            </small>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {!!view.result.directions.length && (
                <div className="ai-assist-directions">
                  {view.result.directions.map((d, i) => (
                    <div key={i}>
                      <div>
                        <strong>
                          方向 {i + 1} · {d.title}
                        </strong>
                        <p>{d.rationale}</p>
                        <small>{d.requirements.style}</small>
                      </div>
                      {!externalAdoption && (
                        <button
                          type="button"
                          disabled={stale || !onDirection}
                          onClick={() => {
                            setSelected(structuredClone(d));
                            setFields([]);
                          }}
                        >
                          选择字段
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <TemplateSuggestions
                key={`template:${view.id}`}
                slots={view.result.templateSlots}
                stale={stale}
                onAdopt={onTemplateSlot}
                sourceLabel={sourceLabel}
              />
              {!externalAdoption && view.result.listingCopy && (
                <ListingSuggestions
                  key={`listing:${view.id}`}
                  copy={view.result.listingCopy}
                  stale={stale}
                  onAdopt={onListingCopy}
                  sourceLabel={sourceLabel}
                />
              )}
              {!!view.result.matches.length && (
                <div className="ai-assist-matches">
                  {view.result.matches.map((m, i) => (
                    <div key={i}>
                      <strong>
                        候选 {i + 1}：{sourceLabel(m.artworkVersionId)} +{" "}
                        {sourceLabel(m.specificationVersionId)}
                      </strong>
                      <p>{m.reason}</p>
                      {m.evidence.map((e, j) => (
                        <small key={j}>
                          依据：{sourceLabel(e.sourceId)} — {e.detail}
                        </small>
                      ))}
                      <button
                        type="button"
                        disabled={stale || !onMatch}
                        onClick={() => {
                          if (onMatch?.(m) === false) return;
                          setNotice("候选已填入订单草稿，请核对定制内容并保存。");
                        }}
                      >
                        填入匹配草稿
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {selected && !stale && (
            <div className="ai-assist-adoption">
              <h4>核对并采用：{selected.title}</h4>
              <p>
                仅替换勾选的字段；未勾选的现有内容保留。定制方式与字段一起替换，排版区域需在定制配置中重新确认。
              </p>
              {directionFields.map((f) => (
                <div key={f.key}>
                  <label className="ai-assist-checkbox">
                    <input
                      type="checkbox"
                      checked={fields.includes(f.key)}
                      onChange={(e) =>
                        setFields((values) =>
                          e.target.checked ? [...values, f.key] : values.filter((v) => v !== f.key),
                        )
                      }
                    />
                    {f.label}
                  </label>
                  {f.key === "customization" ? (
                    <p>
                      {selected.requirements.mode} ·{" "}
                      {selected.fields
                        .map(
                          (v) =>
                            `${v.label}（${v.type === "image" ? "图片" : "文字"}，${v.required ? "必填" : "可选"}）`,
                        )
                        .join("；") || "无定制字段"}
                    </p>
                  ) : (
                    <textarea
                      aria-label={`AI 建议${f.label}`}
                      rows={2}
                      value={
                        f.key === "prompt" || f.key === "negativePrompt"
                          ? selected[f.key]
                          : selected.requirements[f.key]
                      }
                      onChange={(e) => {
                        const value = e.target.value;
                        setSelected((d) =>
                          d
                            ? f.key === "prompt" || f.key === "negativePrompt"
                              ? { ...d, [f.key]: value }
                              : { ...d, requirements: { ...d.requirements, [f.key]: value } }
                            : null,
                        );
                      }}
                    />
                  )}
                </div>
              ))}
              <div className="ai-assist-controls">
                <button
                  className="primary"
                  type="button"
                  disabled={!fields.length || !onDirection}
                  onClick={() => {
                    if (onDirection?.(selected, fields) === false) return;
                    setSelected(null);
                    setNotice("所选内容已填入需求单，核对后保存项目即可。");
                  }}
                >
                  采用 {fields.length} 个字段
                </button>
                <button type="button" onClick={() => setSelected(null)}>
                  取消选择
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
