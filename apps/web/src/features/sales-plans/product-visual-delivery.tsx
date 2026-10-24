"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import type { SalesPlanView } from "@yummyai/contracts/catalog/sales-plan";
import {
  VISUAL_SLOTS,
  type ProductVisualWorkspace,
  type ProductVisualTask,
  type VisualSlotKey,
} from "@yummyai/contracts/catalog/product-visuals";
import { salesPlanRequest } from "./sales-plan-client";
import "./product-visual-delivery.css";

const status: Record<string, string> = {
  queued: "排队中",
  running: "制作中",
  completed: "制作完成",
  failed: "制作失败",
  pending_review: "待审核",
  approved: "已审核",
  rejected: "已退回",
};
const checkLabels = {
  identity: "主体身份与图案一致",
  shape: "轮廓和比例一致",
  facts: "材质、数量和文字符合事实",
  sides: "单双面及背面展示正确",
};
type Checks = Record<keyof typeof checkLabels, boolean>;
const emptyChecks: Checks = { identity: false, shape: false, facts: false, sides: false };
const failureReason: Record<string, string> = {
  studio_generation_failed: "模型返回失败或结果不确定",
  studio_submission_interrupted: "渠道提交中断，费用待核对",
  studio_visual_source_changed: "固定的商品或规格依据已变化",
  studio_reference_changed: "授权参考素材已变化",
  studio_provider_unavailable: "模型渠道配置已变化或不可用",
  studio_access_changed: "执行权限已变化",
  studio_result_scan_failed: "结果文件检查未通过",
  studio_provider_invalid_result: "返回的图片无法完整读取",
};

export function ProductVisualDelivery({
  plan,
  disabledReason,
  onAdopted,
}: {
  plan: SalesPlanView;
  disabledReason: string;
  onAdopted: () => Promise<void>;
}) {
  const [data, setData] = useState<ProductVisualWorkspace | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [groupId, setGroupId] = useState(""),
    [sample, setSample] = useState(""),
    [attestation, setAttestation] = useState("");
  const [direction, setDirection] = useState(plan.fields.positioning),
    [callUsd, setCallUsd] = useState(""),
    [totalUsd, setTotalUsd] = useState(""),
    [budgetAttested, setBudgetAttested] = useState(false);
  const [model, setModel] = useState(""),
    [size, setSize] = useState("2048x2048"),
    [artwork, setArtwork] = useState(""),
    [prompts, setPrompts] = useState<Partial<Record<VisualSlotKey, string>>>({});
  const [checks, setChecks] = useState<Record<string, Checks>>({}),
    [reasons, setReasons] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Partial<Record<VisualSlotKey, string>>>({}),
    [useSampleAsMain, setUseSampleAsMain] = useState(false);
  const [previewFailed, setPreviewFailed] = useState<Record<string, boolean>>({}),
    [previewAttempt, setPreviewAttempt] = useState<Record<string, number>>({});
  const pending = useRef(new Map<string, { signature: string; key: string }>());
  const currentPlan = useRef(plan.id);
  currentPlan.current = plan.id;
  const read = useCallback(async () => {
    const next = await salesPlanRequest<ProductVisualWorkspace>(`${plan.id}/launch/visuals`);
    if (currentPlan.current === plan.id) {
      setData(next);
      setError("");
    }
  }, [plan.id]);
  useEffect(() => {
    setData(null);
    void read().catch((c) => setError(c instanceof Error ? c.message : "视觉交付读取失败"));
  }, [read, plan.revision]);
  useEffect(() => {
    setGroupId("");
    setSelected({});
    setArtwork("");
    setUseSampleAsMain(false);
    setBudgetAttested(false);
    setSample("");
    setAttestation("");
    setDirection(plan.fields.positioning);
    pending.current.clear();
  }, [plan.id]);
  useEffect(() => {
    if (!data?.projects.some((p) => p.tasks.some((t) => ["queued", "running"].includes(t.status))))
      return;
    const timer = setTimeout(() => {
      void read().catch((c) => setError(c instanceof Error ? c.message : "进度读取失败，请重试"));
    }, 2500);
    return () => clearTimeout(timer);
  }, [data, read]);
  const project = data?.projects.find((p) => p.id === groupId) ?? data?.projects[0];
  const stale = project?.stale ?? false;
  const disabled = busy || !!disabledReason;
  function key(action: string, value: unknown) {
    const signature = JSON.stringify(value),
      prior = pending.current.get(action);
    if (prior?.signature === signature) return prior.key;
    const next = { signature, key: crypto.randomUUID() };
    pending.current.set(action, next);
    return next.key;
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成，请重试");
    } finally {
      setBusy(false);
    }
  }
  function prepare() {
    void run(async () => {
      const payload = {
        expectedRevision: plan.revision,
        sampleAssetId: sample,
        referenceAssetIds: [],
        sampleAttestation: attestation,
        direction,
        modelId: model,
        size,
        callCeilingUsd: Number(callUsd),
        totalBudgetUsd: Number(totalUsd),
        budgetAttested,
      };
      const result = await salesPlanRequest<{ groupId: string }>(
        `${plan.id}/launch/visuals/prepare`,
        { ...payload, requestId: key("prepare", payload) },
      );
      pending.current.delete("prepare");
      setGroupId(result.groupId);
      setSelected({});
      setArtwork("");
      setUseSampleAsMain(false);
      await read();
      setNotice("视觉需求已固定。准备和读取进度不调用模型。");
    });
  }
  function generate(slotKey: VisualSlotKey) {
    if (!project) return;
    void run(async () => {
      const payload = {
        modelId: project.snapshot.modelId,
        slotKey,
        ...(slotKey !== "artwork" ? { artworkVersionId: artwork } : {}),
        prompt: prompts[slotKey] ?? "",
        size: project.snapshot.size,
        quality: "high",
      };
      const action = `${project.id}:${slotKey}`;
      await salesPlanRequest(`${plan.id}/launch/visuals/${project.id}/generate`, {
        ...payload,
        requestId: key(action, payload),
      });
      pending.current.delete(action);
      await read();
      setNotice(
        `${VISUAL_SLOTS.find((s) => s.key === slotKey)!.label}已提交。刷新只读取同一任务。`,
      );
    });
  }
  function collect() {
    if (!project) return;
    void run(async () => {
      await salesPlanRequest(`${plan.id}/launch/visuals/${project.id}/collect`, {});
      await read();
      setNotice("已完成结果已登记为待审核方案，没有新增模型调用。");
    });
  }
  function review(task: ProductVisualTask, decision: "approve" | "reject") {
    if (!project || !task.result) return;
    void run(async () => {
      await salesPlanRequest(`${plan.id}/launch/visuals/${project.id}/review`, {
        versionId: task.result!.versionId,
        decision,
        checks: checks[task.result!.versionId] ?? emptyChecks,
        reason: reasons[task.result!.versionId] ?? "",
      });
      await read();
      setNotice(decision === "approve" ? "该图片版本审核通过。" : "已退回该版本，原因和原图保留。");
    });
  }
  function adopt() {
    if (!project) return;
    void run(async () => {
      const payload = {
        expectedRevision: plan.revision,
        versionIds: [selected.scene, selected.detail, selected.customization].filter(Boolean),
        useSampleAsMain,
      };
      await salesPlanRequest(`${plan.id}/launch/visuals/${project.id}/adopt`, {
        ...payload,
        idempotencyKey: key("adopt", { groupId: project.id, ...payload }),
      });
      pending.current.delete("adopt");
      await onAdopted();
      await read();
      setNotice("已采纳到销售方案新版本。请同步刊登草稿后，在原刊登编辑器完成审核。");
    });
  }
  function syncDraft() {
    void run(async () => {
      const detail = await salesPlanRequest<{
        listings: Array<{
          versionId: string;
          marketplaceId: string;
          locale: string;
          status: string;
        }>;
      }>(plan.id);
      const listing = detail.listings.find(
        (l) =>
          l.marketplaceId === plan.fields.marketplaceId &&
          l.locale === plan.fields.locale &&
          l.status !== "archived",
      );
      const payload = {
        expectedRevision: plan.revision,
        expectedListingVersionId: listing?.versionId ?? null,
      };
      await salesPlanRequest(`${plan.id}/draft`, {
        ...payload,
        idempotencyKey: key("draft", payload),
      });
      pending.current.delete("draft");
      await onAdopted();
      setNotice("图片已同步至新的刊登草稿版本，请进入刊登编辑器核对并审核。");
    });
  }
  const readyToAdopt =
    !!project &&
    ["scene", "detail", "customization"].every((s) =>
      project.tasks.some(
        (t) =>
          t.slotKey === s &&
          !!t.result &&
          t.result.versionId === selected[s as VisualSlotKey] &&
          t.result.status === "approved" &&
          t.controlledReview &&
          !t.technicalIssues.length,
      ),
    ) &&
    project.tasks.some(
      (t) =>
        t.slotKey === "artwork" &&
        t.result?.status === "approved" &&
        t.controlledReview &&
        !t.technicalIssues.length,
    );
  return (
    <section className="pv-workspace" id="product-visuals" aria-label="抱枕图稿与套图交付">
      <div className="sl-heading">
        <div>
          <h3>抱枕图稿与套图交付</h3>
          <p>固定样品与商品事实，逐张制作、审核，再采纳刊登配图。</p>
        </div>
        <button
          className="oc-button"
          disabled={disabled}
          onClick={() => {
            void run(read);
          }}
        >
          <RefreshCw size={14} />
          刷新视觉进度
        </button>
      </div>
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
      {!data && !error && <p role="status">正在读取抱枕规格与视觉交付…</p>}
      {data && (
        <>
          {data.blockers.map((b) => (
            <p className="sp-hint" key={b}>
              {b}
            </p>
          ))}
          {data.sourceSummary.length > 0 && (
            <details className="pv-basis">
              <summary>本方案固定商品事实</summary>
              <ul>
                {data.sourceSummary.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <p>工厂规格在原工艺底稿维护。这里的图稿候选需要进入生产编辑器继续核对尺寸和裁线。</p>
            </details>
          )}
          {data.permissions.create && !data.blockers.length && (
            <details className="pv-prepare" open={!data.projects.length}>
              <summary>准备新的视觉交付</summary>
              <fieldset disabled={disabled}>
                <div className="pv-fields">
                  <label>
                    真实样品图
                    <select value={sample} onChange={(e) => setSample(e.target.value)}>
                      <option value="">选择已审核的授权实拍素材</option>
                      {data.references.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.fileName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    样品核对依据
                    <input
                      value={attestation}
                      maxLength={500}
                      onChange={(e) => setAttestation(e.target.value)}
                      placeholder="样品对应的款式、轮廓和单双面依据"
                    />
                  </label>
                  <label className="pv-full">
                    设计需求
                    <textarea
                      value={direction}
                      maxLength={2000}
                      onChange={(e) => setDirection(e.target.value)}
                    />
                  </label>
                  <label>
                    图像模型
                    <select
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        setBudgetAttested(false);
                      }}
                    >
                      <option value="">选择已配置模型</option>
                      {data.models.map((m) => (
                        <option value={m.id} key={m.id}>
                          {m.providerLabel} / {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    请求图片尺寸
                    <select
                      value={size}
                      onChange={(e) => {
                        setSize(e.target.value);
                        setBudgetAttested(false);
                      }}
                    >
                      {["2048x2048", "1024x1024", "1536x1024", "1024x1536"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    单次预算占用（USD）
                    <input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={callUsd}
                      onChange={(e) => {
                        setCallUsd(e.target.value);
                        setBudgetAttested(false);
                      }}
                    />
                  </label>
                  <label>
                    本交付总预算（USD）
                    <input
                      type="number"
                      min="0.000001"
                      step="0.000001"
                      value={totalUsd}
                      onChange={(e) => setTotalUsd(e.target.value)}
                    />
                  </label>
                </div>
                <label className="pv-check">
                  <input
                    type="checkbox"
                    checked={budgetAttested}
                    onChange={(e) => setBudgetAttested(e.target.checked)}
                  />
                  已核对所选模型与参数的渠道费用，单次费用不超过填写的预算占用
                </label>
                <p className="sp-hint">
                  一次提交制作一张图；每槽位最多四次尝试。调用后实际账单未知时保留预算占用，失败不会自动重新收费。
                </p>
                <button
                  className="oc-button"
                  disabled={
                    !sample ||
                    !model ||
                    !attestation.trim() ||
                    !direction.trim() ||
                    !budgetAttested ||
                    !callUsd ||
                    !totalUsd
                  }
                  onClick={prepare}
                >
                  固定视觉需求
                </button>
              </fieldset>
            </details>
          )}
          {data.projects.length > 0 && (
            <label className="pv-history">
              视觉交付记录
              <select
                value={project?.id ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  setGroupId(e.target.value);
                  setSelected({});
                  setArtwork("");
                  setUseSampleAsMain(false);
                }}
              >
                {data.projects.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} · 方案 V{p.snapshot.salesPlanRevision}
                    {p.adoptedRevision
                      ? ` · 已采纳 V${p.adoptedRevision}`
                      : p.stale
                        ? " · 历史依据"
                        : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {project && (
            <>
              <p className="pv-budget" aria-label="视觉交付预算">
                预算占用 ${project.budget.occupiedUsd.toFixed(4)} / $
                {project.snapshot.totalBudgetUsd.toFixed(4)} · 剩余 $
                {project.budget.remainingUsd.toFixed(4)} · 实际账单待确认
              </p>
              {project.adoptedRevision ? (
                <p className="oc-notice">
                  已采纳到方案 V{project.adoptedRevision}。
                  <button
                    className="oc-button"
                    disabled={disabled || !data.permissions.sync}
                    onClick={syncDraft}
                  >
                    同步刊登草稿
                  </button>{" "}
                  <Link href="/listings">进入刊登编辑器</Link>
                </p>
              ) : (
                stale && (
                  <p className="oc-error">
                    本交付的商品、方案或规格已变化，原图和审核历史保留。请准备新交付后继续。
                  </p>
                )
              )}
              <p className="sp-hint">
                固定模型：{project.snapshot.providerModel} · 请求尺寸 {project.snapshot.size} ·
                high；实际返回像素以技术检查为准。
              </p>
              <fieldset className="pv-model-controls" disabled={disabled || stale}>
                <label>
                  套图使用的已审核图稿
                  <select value={artwork} onChange={(e) => setArtwork(e.target.value)}>
                    <option value="">先制作并审核图稿，再明确选择版本</option>
                    {project.tasks
                      .filter(
                        (t) =>
                          t.slotKey === "artwork" &&
                          t.result?.status === "approved" &&
                          t.controlledReview &&
                          !t.technicalIssues.length,
                      )
                      .map((t, index) => (
                        <option key={t.id} value={t.result!.versionId}>
                          图稿候选 {index + 1} · {t.result!.width}×{t.result!.height} ·{" "}
                          {t.result!.versionId.slice(-8)}
                        </option>
                      ))}
                  </select>
                </label>
              </fieldset>
              {project.tasks.some(
                (t) => t.status === "completed" && !t.result && !t.technicalIssues.length,
              ) && (
                <button
                  className="oc-button"
                  disabled={disabled || !data.permissions.create}
                  onClick={collect}
                >
                  读取已完成结果
                </button>
              )}
              <div className="pv-slots">
                {VISUAL_SLOTS.map((slot) => {
                  const tasks = project.tasks.filter((t) => t.slotKey === slot.key),
                    active = tasks.some((t) => ["queued", "running"].includes(t.status));
                  return (
                    <section className="pv-slot" key={slot.key} aria-label={slot.label}>
                      <h4>{slot.label}</h4>
                      <p className="sp-hint">{slot.instructions}</p>
                      <label>
                        本张调整要求
                        <textarea
                          value={prompts[slot.key] ?? ""}
                          maxLength={1500}
                          disabled={disabled || stale}
                          onChange={(e) =>
                            setPrompts((p) => ({ ...p, [slot.key]: e.target.value }))
                          }
                        />
                      </label>
                      <button
                        className="oc-button"
                        disabled={
                          disabled ||
                          stale ||
                          !data.permissions.create ||
                          active ||
                          tasks.length >= 4 ||
                          project.budget.remainingUsd + 0.0000001 <
                            project.snapshot.callCeilingUsd ||
                          (slot.key !== "artwork" && !artwork)
                        }
                        onClick={() => generate(slot.key)}
                      >
                        {tasks.length ? "生成新候选" : "生成一张候选"} · 占用 $
                        {project.snapshot.callCeilingUsd.toFixed(4)}
                      </button>
                      {!tasks.length && (
                        <p className="sp-hint">
                          尚无候选；
                          {slot.key === "artwork"
                            ? "核对模型与预算后提交。"
                            : "先审核并选择图稿版本。"}
                        </p>
                      )}
                      {tasks.map((task) => {
                        const result = task.result,
                          versionChecks = result
                            ? (checks[result.versionId] ?? emptyChecks)
                            : emptyChecks;
                        return (
                          <article className="pv-result" key={task.id}>
                            <p>
                              <strong>
                                {status[result?.status ?? task.status] ?? task.status}
                              </strong>{" "}
                              · {task.model}
                            </p>
                            {task.error && (
                              <p className="oc-error">
                                本次制作未完成（
                                {failureReason[task.error] ?? "请核对模型渠道或资料"}
                                ），原结果保留；请核对渠道或资料后明确提交新尝试。
                              </p>
                            )}
                            {task.technicalIssues.map((i) => (
                              <p className="oc-error" key={i}>
                                {i}
                              </p>
                            ))}
                            {result && (
                              <>
                                <a href={result.previewPath} target="_blank" rel="noreferrer">
                                  <img
                                    src={`${result.previewPath}${previewAttempt[result.versionId] ? `?retry=${previewAttempt[result.versionId]}` : ""}`}
                                    alt={`${slot.label}候选，${result.width ?? "未知"}×${result.height ?? "未知"}像素`}
                                    width={240}
                                    height={180}
                                    loading="lazy"
                                    style={
                                      previewFailed[result.versionId]
                                        ? { visibility: "hidden" }
                                        : undefined
                                    }
                                    onError={() =>
                                      setPreviewFailed((f) => ({ ...f, [result.versionId]: true }))
                                    }
                                    onLoad={() =>
                                      setPreviewFailed((f) => ({ ...f, [result.versionId]: false }))
                                    }
                                  />
                                </a>
                                {previewFailed[result.versionId] && (
                                  <button
                                    className="oc-button"
                                    onClick={() =>
                                      setPreviewAttempt((a) => ({
                                        ...a,
                                        [result.versionId]: (a[result.versionId] ?? 0) + 1,
                                      }))
                                    }
                                  >
                                    预览加载失败，点击重试
                                  </button>
                                )}
                                <p>
                                  {result.width}×{result.height} px · {result.versionId}
                                </p>
                                {(result.status === "pending_review" ||
                                  (result.status === "approved" && !task.controlledReview)) &&
                                  data.permissions.review && (
                                    <fieldset disabled={disabled || stale}>
                                      {Object.entries(checkLabels).map(([k, text]) => (
                                        <label className="pv-check" key={k}>
                                          <input
                                            type="checkbox"
                                            checked={versionChecks[k as keyof Checks]}
                                            onChange={(e) =>
                                              setChecks((c) => ({
                                                ...c,
                                                [result.versionId]: {
                                                  ...(c[result.versionId] ?? emptyChecks),
                                                  [k]: e.target.checked,
                                                },
                                              }))
                                            }
                                          />
                                          {text}
                                        </label>
                                      ))}
                                      <label>
                                        退回原因
                                        <input
                                          value={reasons[result.versionId] ?? ""}
                                          maxLength={1000}
                                          onChange={(e) =>
                                            setReasons((r) => ({
                                              ...r,
                                              [result.versionId]: e.target.value,
                                            }))
                                          }
                                        />
                                      </label>
                                      <div className="pv-actions">
                                        <button
                                          className="oc-button"
                                          disabled={
                                            task.technicalIssues.length > 0 ||
                                            previewFailed[result.versionId] ||
                                            Object.values(versionChecks).some((v) => !v)
                                          }
                                          onClick={() => review(task, "approve")}
                                        >
                                          通过此版本
                                        </button>
                                        <button
                                          className="oc-button"
                                          disabled={
                                            result.status !== "pending_review" ||
                                            !reasons[result.versionId]?.trim()
                                          }
                                          onClick={() => review(task, "reject")}
                                        >
                                          退回此版本
                                        </button>
                                      </div>
                                    </fieldset>
                                  )}
                                {result.rejectionReason && (
                                  <p className="sp-hint">退回原因：{result.rejectionReason}</p>
                                )}
                                {result.status === "approved" &&
                                  task.controlledReview &&
                                  slot.key === "artwork" && (
                                    <Link
                                      href={`/creative-designs/canvas?brief=${task.projectId}&tab=review&returnTo=${encodeURIComponent(`/sales-plans?plan=${plan.id}&view=tasks#product-visuals`)}`}
                                    >
                                      打开图稿项目
                                    </Link>
                                  )}
                                {result.status === "approved" &&
                                  task.controlledReview &&
                                  !task.technicalIssues.length &&
                                  slot.key !== "artwork" && (
                                    <label className="pv-check">
                                      <input
                                        type="radio"
                                        name={`visual-${project.id}-${slot.key}`}
                                        checked={selected[slot.key] === result.versionId}
                                        disabled={disabled || stale}
                                        onChange={() =>
                                          setSelected((s) => ({
                                            ...s,
                                            [slot.key]: result.versionId,
                                          }))
                                        }
                                      />
                                      选为本槽位刊登配图
                                    </label>
                                  )}
                              </>
                            )}
                          </article>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
              {!project.adoptedRevision && (
                <fieldset
                  className="pv-adopt"
                  disabled={disabled || stale || !data.permissions.adopt}
                >
                  <p>每个套图槽位选择一个已审核版本，采纳后创建销售方案新版本。</p>
                  <label className="pv-check">
                    <input
                      type="checkbox"
                      checked={useSampleAsMain}
                      onChange={(e) => setUseSampleAsMain(e.target.checked)}
                    />
                    明确使用本次核对的真实样品图作为主图
                  </label>
                  <button className="oc-button" disabled={!readyToAdopt} onClick={adopt}>
                    采纳三个套图槽位
                  </button>
                </fieldset>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
