"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import { AssistTaskBasisSchema, type AssistTaskBasis } from "@yummyai/contracts/ai/task-workspace";
import type { SalesPlanView } from "@yummyai/contracts/catalog/sales-plan";
import type {
  LaunchAdoptField,
  SalesPlanLaunch as LaunchData,
} from "@yummyai/contracts/catalog/sales-plan-launch";
import { AssistPanel } from "../ai-assist/assist-panel";
import { workflowHref } from "../navigation/workflow-href";
import { salesPlanRequest } from "./sales-plan-client";
import "./sales-plan-launch.css";
import { ProductVisualDelivery } from "./product-visual-delivery";
import { SalesPlanDelivery } from "./sales-plan-delivery";
import { SalesPlanAgent } from "./sales-plan-agent";

const labels: Record<LaunchAdoptField, string> = {
  audience: "目标人群",
  scenario: "使用场景",
  positioning: "设计定位",
  title: "标题",
  bullets: "五点描述",
  description: "商品描述",
  customInstructions: "定制说明",
};
const stageStatus = {
  ready: "已齐备",
  pending: "待处理",
  blocked: "待补齐",
  unavailable: "无权限",
};
const taskStatus = {
  queued: "排队中",
  running: "分析中",
  completed: "分析完成",
  failed: "分析失败",
  cancelled: "已取消",
};

export function SalesPlanLaunch({
  plan,
  disabledReason,
  canWrite,
  current,
  onAdopted,
}: {
  plan: SalesPlanView;
  disabledReason: string;
  canWrite: boolean;
  current: string;
  onAdopted: () => Promise<void>;
}) {
  const params = useSearchParams();
  const kind = params.get("kind") === "sku_package" ? "sku_package" : "creative";
  const runId = params.get("launchRun");
  const [data, setData] = useState<LaunchData | null>(null),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState(""),
    [basis, setBasis] = useState<AssistTaskBasis | null>(null),
    [view, setView] = useState<AssistView | null>(null);
  const [choice, setChoice] = useState(0),
    [selected, setSelected] = useState<LaunchAdoptField[]>([]);
  const pending = useRef<{ signature: string; key: string } | null>(null),
    lastRunStatus = useRef("");
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void salesPlanRequest<LaunchData>(`${plan.id}/launch`, undefined, abort.signal)
      .then((next) => {
        if (!abort.signal.aborted) setData(next);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          setData(null);
          setError(cause instanceof Error ? cause.message : "上新任务读取失败");
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [plan.id, plan.revision, reload]);
  useEffect(() => {
    setBasis(null);
    setView(null);
    setSelected([]);
    setChoice(0);
  }, [kind, plan.revision]);
  const onRunChange = useCallback((next: AssistView) => {
    setView(next);
    const query = new URLSearchParams(window.location.search);
    if (query.get("launchRun") !== next.id) {
      query.set("launchRun", next.id);
      history.replaceState(null, "", `/sales-plans?${query}`);
    }
    const status = `${next.id}:${next.status}`;
    if (lastRunStatus.current !== status) {
      lastRunStatus.current = status;
      setReload((value) => value + 1);
    }
  }, []);
  const loadedTask = data?.tasks.find((task) => task.id === runId && task.kind === kind);
  const latestTask = data?.tasks.find((task) => task.kind === kind);
  const selectedTask = loadedTask ?? (runId ? null : latestTask);
  const currentListingTask = data?.tasks.find((task) => task.kind === "sku_package");
  const scope =
    basis?.scope ??
    selectedTask?.scope ??
    (kind === "creative"
      ? `creative:${plan.id}`
      : (currentListingTask?.scope ?? `launch:${plan.id}`));
  function navigate(values: Record<string, string | null>) {
    const query = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value) query.set(key, value);
      else query.delete(key);
    }
    history.replaceState(null, "", `/sales-plans?${query}`);
    setBasis(null);
    setView(null);
    setSelected([]);
    setNotice("");
    setError("");
  }
  async function readBasis() {
    setBusy(true);
    setError("");
    setBasis(null);
    setNotice("");
    try {
      const next = AssistTaskBasisSchema.parse(
        await salesPlanRequest(`${plan.id}/launch/basis`, {
          kind,
          expectedRevision: plan.revision,
          taskGoal: goal,
        }),
      );
      const query = new URLSearchParams(window.location.search);
      query.delete("launchRun");
      query.delete("assistRun");
      history.replaceState(null, "", `/sales-plans?${query}`);
      setBasis(next);
      setView(null);
      setSelected([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分析依据读取失败");
    } finally {
      setBusy(false);
    }
  }
  const direction = view?.result?.directions[choice],
    copy = view?.result?.listingCopy;
  const candidates: Partial<Record<LaunchAdoptField, string | string[]>> =
    kind === "creative" && direction
      ? {
          audience: direction.requirements.audience,
          scenario: direction.requirements.occasion,
          positioning: `${direction.title}\n${direction.rationale}`,
        }
      : kind === "sku_package" && copy
        ? {
            title: copy.title,
            bullets: copy.bullets,
            description: copy.description,
            ...(plan.fields.mode === "custom" && plan.fields.customization.fields.length
              ? { customInstructions: copy.personalizationInstructions }
              : {}),
          }
        : {};
  const adopted = data?.adoptions.find((adoption) => adoption.runId === view?.id);
  const canAdopt =
    !!view &&
    view.status === "completed" &&
    !view.stale &&
    view.request?.salesPlan?.id === plan.id &&
    view.request.salesPlan.revision === plan.revision &&
    !disabledReason &&
    canWrite &&
    !busy;
  async function adopt() {
    if (!view || !canAdopt || !selected.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    const body = {
      kind,
      runId: view.id,
      directionIndex: choice,
      fields: selected,
      expectedRevision: plan.revision,
    };
    const signature = JSON.stringify(body),
      key = pending.current?.signature === signature ? pending.current.key : crypto.randomUUID();
    pending.current = { signature, key };
    try {
      const result = await salesPlanRequest<{ plan: SalesPlanView }>(`${plan.id}/launch/adopt`, {
        ...body,
        idempotencyKey: key,
      });
      await onAdopted();
      pending.current = null;
      setBasis(null);
      setSelected([]);
      setReload((value) => value + 1);
      setNotice(`已采纳所选字段并保存为方案第 ${result.plan.revision} 版。请继续核对设计与刊登。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "采纳未完成，当前选择已保留");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sl-workspace" aria-label="商品上新任务" aria-busy={loading || busy}>
      <div className="sl-heading">
        <div>
          <h2>商品上新任务</h2>
          <p>
            {plan.fields.marketplaceId} · {plan.fields.locale} · 方案 V{plan.revision}
          </p>
        </div>
        <button
          className="oc-button"
          disabled={loading || busy}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={14} />
          刷新进度
        </button>
      </div>
      {disabledReason && <p className="sp-hint">{disabledReason}</p>}
      {error && (
        <p className="oc-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="oc-notice" role="status">
          {notice}
        </p>
      )}
      {loading && !data && <p role="status">正在核对上新进度与任务记录…</p>}
      <SalesPlanAgent key={plan.id} plan={plan} disabledReason={disabledReason} canWrite={canWrite} onProgress={() => setReload(value => value + 1)} />
      {data && (
        <>
          <div className="sl-next" aria-label="下一步处理">
            <strong>
              {data.nextStage ? `下一步：${data.nextStage.label}` : "当前上新资料包已齐套"}
            </strong>
            <p>{data.nextStage?.detail ?? "各销售 SKU 对应当前审核版本的封存资料包。"}</p>
            {data.nextStage && (
              <Link
                className="oc-button"
                href={
                  data.nextStage.href.startsWith(`/sales-plans?plan=${plan.id}`)
                    ? data.nextStage.href
                    : workflowHref(data.nextStage.href, current)
                }
              >
                {data.nextStage.action}
              </Link>
            )}
          </div>
          <ol className="sl-stages">
            {data.stages.map((stage, index) => (
              <li key={stage.key} data-status={stage.status}>
                <div>
                  <strong>
                    {index + 1}. {stage.label}
                  </strong>
                  <span>{stageStatus[stage.status]}</span>
                </div>
                <p>{stage.detail}</p>
                <Link
                  href={
                    stage.href.startsWith(`/sales-plans?plan=${plan.id}`)
                      ? stage.href
                      : workflowHref(stage.href, current)
                  }
                >
                  {stage.action}
                </Link>
              </li>
            ))}
          </ol>
          <p className="sl-fees" aria-label="本方案分析费用">
            我的分析费用：按配置估算 ${data.fees.knownUsd.toFixed(4)}
            {data.fees.unknown > 0 && ` · ${data.fees.unknown} 次费用待确认`}
            {data.fees.active > 0 &&
              ` · ${data.fees.active} 个进行中任务${data.fees.activeUpperUsd === null ? "，上限待确认" : `，预估上限 $${data.fees.activeUpperUsd.toFixed(4)}`}`}
          </p>
          {data.diagnostics.map((message, index) => (
            <p className="sp-hint" key={index}>
              {message}
            </p>
          ))}
          <ProductVisualDelivery plan={plan} disabledReason={disabledReason} onAdopted={onAdopted} />
          <SalesPlanDelivery plan={plan} disabledReason={disabledReason} />
          <div className="sl-analysis-controls">
            <label>
              分析环节
              <select
                value={kind}
                disabled={busy}
                onChange={(event) =>
                  navigate({ kind: event.target.value, launchRun: null, assistRun: null })
                }
              >
                <option value="creative">原创方向</option>
                <option value="sku_package">Listing 文案与资料包</option>
              </select>
            </label>
            <label>
              本次分析重点
              <textarea
                value={goal}
                maxLength={2000}
                disabled={busy}
                onChange={(event) => {
                  setGoal(event.target.value);
                  setBasis(null);
                }}
                placeholder="例如：围绕宠物纪念场景提出原创方向，列明尚需验证的事实。"
              />
            </label>
            <button
              className="oc-button"
              disabled={busy || loading || !!disabledReason || !data.canAnalyze[kind]}
              onClick={() => void readBasis()}
            >
              读取上新依据
            </button>
          </div>
          {!data.canAnalyze[kind] && <p className="sp-hint">当前账号没有此分析环节的操作权限。</p>}
          {basis && (
            <div className="sl-basis" role="region" aria-label="上新分析依据">
              <h3>
                本次固定依据 ·{" "}
                {basis.rows.find((row) => row.label === "可用图片")?.value ?? "图片数量待核对"}
              </h3>
              <ul>
                {basis.sources.map((source) => (
                  <li key={source.id}>{source.label}</li>
                ))}
              </ul>
              {basis.checks.map((check, index) => (
                <p key={index}>{check.message}</p>
              ))}
              {basis.diagnostics.map((message, index) => (
                <p className="sp-hint" key={index}>
                  {message}
                </p>
              ))}
            </div>
          )}
          {(basis || selectedTask) && (
            <AssistPanel
              key={`${kind}:${scope}:${basis ? "current" : "history"}`}
              kind={kind}
              scope={scope}
              input={basis?.input ?? null}
              readOnly={!basis}
              externalAdoption
              initialRunId={basis ? undefined : selectedTask?.id}
              onRunChange={onRunChange}
              disabledReason={
                disabledReason || (!basis ? "读取当前上新依据后可以发起新分析。" : undefined)
              }
            />
          )}
          {runId && !loadedTask && !basis && !loading && (
            <p className="sp-hint">
              此记录不在当前可读历史中，请从下面的任务记录选择，或到 AI 任务工作台核对权限与原对象。
            </p>
          )}
          {adopted && (
            <p className="oc-notice">
              本次成果已采纳到方案 V{adopted.revision}：
              {adopted.fields.map((field) => labels[field]).join("、")}。
            </p>
          )}
          {Object.keys(candidates).length > 0 && (
            <section className="sl-adopt" aria-label="AI 成果差异与采纳">
              <h3>核对差异并选择采纳字段</h3>
              {kind === "creative" && (
                <label>
                  原创方向
                  <select
                    value={choice}
                    disabled={busy}
                    onChange={(event) => {
                      setChoice(Number(event.target.value));
                      setSelected([]);
                    }}
                  >
                    {view?.result?.directions.map((candidate, index) => (
                      <option key={index} value={index}>
                        {candidate.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="sl-diff">
                {Object.entries(candidates).map(([key, value]) => {
                  const field = key as LaunchAdoptField,
                    text = (v: unknown) => (Array.isArray(v) ? v.join("\n") : String(v ?? ""));
                  return (
                    <div className="sl-diff-row" key={field}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.includes(field)}
                          disabled={!canAdopt}
                          onChange={(event) =>
                            setSelected((values) =>
                              event.target.checked
                                ? [...values, field]
                                : values.filter((value) => value !== field),
                            )
                          }
                        />
                        {labels[field]}
                      </label>
                      <div>
                        <small>当前方案</small>
                        <pre>{text(plan.fields[field]) || "尚未填写"}</pre>
                      </div>
                      <div>
                        <small>本次 AI 建议</small>
                        <pre>{text(value) || "空内容，请核对"}</pre>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!!(kind === "creative" ? direction?.evidence.length : copy?.evidence.length) && (
                <details>
                  <summary>本建议引用依据</summary>
                  <ul>
                    {(kind === "creative" ? direction?.evidence : copy?.evidence)?.map(
                      (evidence, index) => (
                        <li key={index}>
                          {view?.sources.find((source) => source.id === evidence.sourceId)?.label ??
                            evidence.sourceId}
                          ：{evidence.detail}
                        </li>
                      ),
                    )}
                  </ul>
                </details>
              )}
              {!canAdopt && (
                <p className="sp-hint">
                  {!canWrite
                    ? "当前账号可以查看建议，采纳到销售方案需要商品编辑权限。"
                    : "只有当前方案版本的已完成分析可采纳；资料变化后需重新读取依据。"}
                </p>
              )}
              <button
                className="oc-button primary"
                disabled={!canAdopt || !selected.length}
                onClick={() => void adopt()}
              >
                {busy ? "正在保存…" : "采纳所选字段并保存"}
              </button>
            </section>
          )}
          <details className="sl-history" open>
            <summary>
              本方案分析记录 · {data.tasks.length}
              {data.hasMoreTasks ? "+" : ""}
            </summary>
            {!data.tasks.length ? (
              <p>尚无分析任务。读取依据后，选择模型并开始分析。</p>
            ) : (
              <ul>
                {data.tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() =>
                        navigate({ kind: task.kind, launchRun: task.id, assistRun: null })
                      }
                    >
                      {task.kind === "creative" ? "原创方向" : "Listing 文案"} ·{" "}
                      {taskStatus[task.status]} · {new Date(task.createdAt).toLocaleString("zh-CN")}
                    </button>
                    <span>
                      {task.modelLabel} ·{" "}
                      {task.costUsd === null ? "费用待确认" : `$${task.costUsd.toFixed(4)}`}
                      {task.stale ? " · 历史依据" : ""}
                      {data.adoptions.some((a) => a.runId === task.id) ? " · 已采纳" : ""}
                    </span>
                    {task.error && <p>{task.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </details>
          {data.packages.length > 0 && (
            <section aria-label="当前封存资料包">
              <h3>当前封存资料包</h3>
              <ul>
                {data.packages.map((pack) => (
                  <li key={pack.id}>
                    <Link href={workflowHref(`/product-development?sku=${pack.skuId}`, current)}>
                      {pack.skuCode} · 资料包 V{pack.version}
                    </Link>
                    <span>
                      {" "}
                      · {pack.platform} · {pack.marketplaceId}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
