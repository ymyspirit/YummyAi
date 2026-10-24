"use client";

import { useEffect, useRef, useState,useId,type MouseEvent } from "react";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { DesignAgentViewSchema, type DesignAgentRunView, type OrderDesignRestoreResponse } from "@yummyai/contracts/order/design-agent";
import { centerRequest, dateTime } from "./order-center-model";
import { ContourExecutionEvidence } from "./contour-execution-evidence";
import { OrderDesignResponseRecoveryForm } from "./order-design-response-recovery";
import { MethodEvidence } from "../ai-assist/method-evidence";
import {observeViewTransition} from "../navigation/view-transition";
import { designAgentRecoveryGuidance } from "./order-design-recovery-model";

const ruleVerificationLabels = { automatic: "系统自动核验", manual: "需人工核验", unavailable: "尚未接入" } as const;

const statusLabels: Record<string, string> = {
  queued: "排队中", running: "制作中", awaiting_review: "稿件待审核", needs_attention: "需要处理", cancelled: "已停止自动制作",
  pending: "待执行", completed: "已完成", failed: "未完成", uncertain: "结果待核实", skipped: "无需执行",
};

// These are public diagnostic codes from the planner and order-design executor.
// Never show an unknown raw code/message: it may contain provider or order data.
const errorLabels: Record<string, string> = {
  agent_method_unavailable: "本次固定的方法、来源或当前权限不可用。请核对后恢复；原任务保留原版本。",
  agent_model_cost_report_invalid: "模型已返回，但费用报告无效。原预留和调用依据已保留，请核对费用后处理。",
  agent_model_cost_conflict: "同一原调用返回了不同费用。原报告保持不变，请核对提供方账单。",
  agent_model_original_budget_exceeded: "已发生费用与下一次调用预留超过本单固定额度，后续模型请求已停止。请核对费用后修订派发或接管。",
  agent_model_call_identity_invalid: "原调用与费用依据不一致，制作已停止。请核对原任务。",
  agent_completion_invalid: "原始制作交接校验未通过。请核对待审稿和文件版本后处理。",
  agent_proof_storage_invalid: "待审稿保存后回读不一致。制作已停止，请核验原始文件。",
  agent_rule_conflict: "固定规则与本单工艺配方不一致，尚未开始模型制作。请核对下方规则和底稿版本，修订需求后重新派发。",
  order_image_transfer_not_allowed: "尚未授权所选提供方处理订单图片。请核对通用底稿配方，或接管制作。",
  model_route_missing: "配方未指定图像模型。请补齐通用底稿配置后重新核对派发。",
  model_call_limit_exceeded: "预计模型调用次数超过该配方上限。请核对图片数量与配方额度。",
  model_price_missing: "缺少每次模型调用的预估费用，暂不能开始付费步骤。",
  model_budget_missing: "缺少本单模型费用上限，暂不能开始付费步骤。",
  model_budget_exceeded: "预计模型费用超过本单上限。请核对图片数量和配方额度。",
  pillow_image_count_invalid: "来图抱枕需要一张明确绑定的买家原图。请核对订单图片用途。",
  pillow_subject_missing: "尚未确定保留头部还是全身。请核对订单制作参数。",
  unexpected_pillow_subject: "固定模板流程收到不适用的抱枕主体参数。请核对配方与订单。",
  agent_pillow_subject_prompt_invalid: "半身裁切的提示词版本未正确固定，请核对订单计划后重新派发。",
  pillow_model_unverified: "新版抱枕配方的图像模型尚未核验，不能开始制作。请核对已配置的 gpt-image-2.5 路由。",
  pillow_model_mismatch: "新版抱枕配方要求 gpt-image-2.5，当前固定模型不匹配。请核对并审核新底稿后重新派发。",
  pillow_runtime_unavailable: "超分运行环境尚未就绪，模型制作未开始。请管理员核对已固定的工具与模型文件。",
  pillow_runtime_mismatch: "超分工具或模型文件与底稿固定版本不一致，模型制作未开始。请恢复匹配的环境，或审核新底稿后重新派发。",
  agent_membership_unavailable: "原派发成员的执行权限已不可用。请核对账号权限后处理任务。",
  agent_requester_mismatch: "任务执行身份与原派发成员不一致。请管理员核对任务。",
  agent_source_expired: "订单原始资料已过期或匿名化，不能继续自动制作。",
  agent_order_unavailable: "订单已暂停、归档或取消，自动制作已停止。",
  agent_work_changed: "制作需求或制图状态已变化。请核对最新订单版本。",
  agent_source_changed: "订单来源资料或审核版本已变化。请重新核对制作需求。",
  agent_source_unavailable: "已固定的原始素材暂时不可用。请核对订单资料。",
  agent_snapshot_invalid: "已固定的任务资料校验未通过。请管理员核对，勿重复提交模型。",
  agent_model_unavailable: "已固定的图像模型不可用。请核对模型配置，或接管制作。",
  agent_model_budget_unavailable: "模型授权、计价或本单额度尚未满足要求。请核对配方。",
  agent_model_monthly_budget_exceeded: "当前模型月度预算不足，付费步骤未继续提交。",
  agent_model_task_budget_exceeded: "当前任务的模型费用额度不足，付费步骤未继续提交。",
  agent_model_configuration_changed: "已固定的模型或提供方配置发生变化，尚未提交本次模型请求。请核对配置后处理任务。",
  agent_model_cancelled_before_submission: "模型请求提交前任务已停止或失效，本次请求未发送给提供方。",
  agent_model_preparation_failed: "模型请求准备失败，本次请求尚未提交。请核对模型配置与输入素材。",
  agent_model_invalid_output: "模型返回的结果不符合图片处理要求。请核对提供方结果与费用后接管，勿直接重复提交。",
  agent_model_submission_unknown: "模型请求结果或费用待核实，不会自动再次付费提交。核实后可导入原结果继续；没有可信原结果时接管。",
  agent_model_response_uncheckpointed: "模型已返回，但原始结果未能完整保存。不会再次提交模型请求，核实后可导入相同原结果继续；无法核实时接管。",
  agent_model_response_processing_failed: "模型原始结果已保存，后续图片检查或整理失败。可恢复并复用已保存结果，最多重试三次，不会再次调用模型。",
  agent_model_response_checkpoint_invalid: "已保存的模型原始结果校验未通过，制作已停止。请管理员核对固定结果，不会重新提交模型。",
  agent_project_unavailable: "已关联的生产项目不可用。请核对项目状态。",
  agent_editor_changed: "生产文件已有新版本。请核对当前稿件后处理任务。",
  agent_editor_checksum_invalid: "生产文件完整性校验未通过。请管理员核对已保存版本。",
  agent_asset_unavailable: "任务使用的素材不可用。请核对原图与授权素材。",
  agent_asset_checksum_invalid: "素材完整性校验未通过。请核对原件，勿直接重复提交模型。",
  agent_asset_version_invalid: "素材版本与已固定任务不一致。请核对任务来源。",
  agent_asset_domain_invalid: "素材不属于获准使用的资源范围，不能用于生产。",
  agent_asset_size_invalid: "素材文件大小不符合处理要求。请接管并核对文件。",
  agent_asset_invalid: "素材格式或图片尺寸无法处理。请接管并核对原图。",
  agent_scan_unavailable: "素材安全检查未通过或扫描服务不可用。请核对扫描结果。",
  agent_scan_rejected: "素材被安全扫描拒绝，不会登记为可用图片或自动重试。请管理员核对扫描报告。",
  agent_asset_storage_unavailable: "私有素材存储暂时不可用。已固定的模型结果会保留，请核对存储服务后恢复处理。",
  agent_asset_preview_failed: "素材预览生成失败，已固定的模型结果会保留。请核对图片处理服务后恢复，无需重新调用模型。",
  agent_alpha_missing: "处理后的图片未保留所需透明区域。请核对抠图结果后接管。",
  agent_product_incompatible: "该产品不支持所选自动制作流程。请核对工艺与配方。",
  agent_contour_source_invalid: "缺少可用于轮廓提取的透明主体图片。请先核对抠图结果。",
  agent_contour_too_large: "轮廓采样超出处理范围。请接管并核对图稿尺寸。",
  agent_contour_workflow_invalid: "任务固定的裁线流程版本不受支持，已停止制作。请核对底稿与任务版本后接管。",
  agent_contour_artwork_changed: "裁线处理发现锁定图案发生变化，结果未提交。请接管核对原始素材和当前稿件。",
  agent_contour_attempt_invalid: "裁线修正记录不符合已固定的次数或参数范围，已停止制作。请接管核对检查记录。",
  agent_contour_result_missing: "裁线流程未返回完整检查结果，未继续制作。请核对执行记录后接管，保留已完成素材。",
  agent_template_invalid: "已固定的通用底稿或素材范围不符合要求。请核对底稿。",
  agent_template_changed: "通用底稿与任务固定版本不一致，请核对历史版本；已完成的素材仍保留。",
  agent_template_review_required: "新版抱枕配方所用底稿尚未审核。请保存并审核底稿新版本，再重新派发。",
  agent_pillow_factory_mismatch: "新版抱枕配方要求已确认的工厂 JPG 标准。请核对并审核工艺底稿后重新派发。",
  agent_pillow_factory_pin_invalid: "任务固定的抱枕工厂标准不完整或不一致，不能继续。请核对底稿与任务版本。",
  agent_pillow_pipeline_invalid: "任务固定的新版抱枕配方不完整，不能继续。请核对尺寸、制作流程和版本，勿重复提交模型。",
  agent_pillow_model_mismatch: "任务固定的图像模型不符合新版抱枕配方要求，尚未继续调用。请核对 gpt-image-2.5 路由与提供方。",
  agent_pillow_runtime_unavailable: "当前制作服务未接入已固定的超分工具。请管理员核对运行环境，保留已完成素材后继续。",
  agent_pillow_source_resolution_too_low: "主体实际像素过低，一次 4 倍补强仍不足以满足订单尺寸。请核对更清晰的原图或人工处理，不会缩小订单尺寸或修改 DPI 通过。",
  agent_pillow_upscale_dimensions_invalid: "超分结果的实际像素或主体分辨率未达到要求，不能送审。原抠图已保留，请核对补强结果。",
  agent_pillow_geometry_invalid: "裁线在允许的圆滑范围内仍未通过检查。已锁定图案保持不变，请接管核对独立裁线。",
  agent_upscale_platform_unsupported: "当前服务系统不支持本配方固定的超分工具，请管理员配置支持的制作环境。",
  agent_upscale_runtime_unconfigured: "尚未配置已固定的超分工具目录，请管理员完成制作服务配置。",
  agent_upscale_runtime_unavailable: "已固定的超分工具暂时无法读取，请管理员核对安装与读取权限。已完成素材仍保留。",
  agent_upscale_runtime_integrity_failed: "超分工具或模型文件校验失败，不能继续运行。请管理员恢复已固定的可信文件。",
  agent_upscale_runtime_changed: "超分工具或模型文件已变化，不能用于当前固定任务。请管理员恢复匹配版本，已完成素材仍保留。",
  agent_upscale_policy_unsupported: "当前制作服务不支持任务固定的补强参数，不能擅自更换工具或模型。请管理员核对版本。",
  agent_upscale_input_invalid: "抠图素材的格式、尺寸或透明通道不符合补强要求。原素材已保留，请核对后接管处理。",
  agent_upscale_alpha_empty: "抠图素材中没有可用的透明主体，不能补强。请核对模型抠图结果。",
  agent_upscale_output_invalid: "超分输出未通过文件检查，不能送审。已完成的模型素材仍保留，请核对本机补强结果。",
  agent_upscale_busy: "本机超分资源繁忙。资源释放后可恢复可重试步骤，已完成的模型素材会继续复用。",
  agent_upscale_timeout: "本机超分处理超时。请核对显卡与运行环境，再恢复可重试步骤；已完成模型素材会继续复用。",
  agent_upscale_process_failed: "本机超分进程未完成。请核对显卡与运行环境，再恢复可重试步骤；已完成模型素材会继续复用。",
  agent_upscale_execution_failed: "本机超分执行失败，已有抠图素材仍保留。请管理员核对环境后，再决定恢复或接管。",
  agent_upscale_cancelled: "本次超分已停止，已完成的模型素材仍保留。请刷新任务状态后决定后续处理。",
  agent_upscale_cleanup_failed: "超分临时文件清理未完成，任务已停止。请管理员完成清理并核对结果后继续。",
  agent_upscale_cleanup_invalid: "超分临时目录校验未通过，任务已停止。请管理员核对临时目录，勿手工删除未知文件。",
  agent_recipe_missing: "底稿尚未配置自动制图配方。请核对通用底稿版本。",
  agent_recipe_product_mismatch: "自动配方与订单产品或来图方式不匹配。请核对通用底稿和订单参数。",
  agent_inputs_require_manual: "定制信息、图片用途或排版规则需要人工核对。请检查订单需求与底稿后接管处理。",
  agent_step_dependency_invalid: "前置步骤结果不完整或已变化。请核对已完成素材。",
  agent_retry_exhausted: "可重试步骤已达到重试次数上限。请接管处理。",
  agent_claim_lost: "任务执行权已变化。请刷新核对最新状态。",
  agent_quality_failed: "自动检查发现需要修正的问题，请查看下方检查结果。",
  agent_quality_evidence_failed: "素材来源、文字或图片技术检查未通过，请人工核对。",
  agent_execution_failed: "该步骤执行失败。请核对已完成结果，再决定恢复或接管。",
  agent_revision_changed: "任务状态已有更新。请刷新后再操作。",
  agent_command_conflict: "该操作请求与先前内容不一致。请刷新核对任务状态。",
  agent_resume_not_safe: "当前任务不能直接恢复。请核对不确定的模型结果后接管。",
  agent_run_not_found: "自动制图任务已不可用。请刷新订单记录。",
  agent_work_not_found: "订单制作任务已不可用。请刷新订单记录。",
  agent_manual_takeover: "已停止自动制作，保留已完成结果供人工接管。",
  agent_response_recovery_not_safe: "当前步骤不符合原结果恢复条件。请刷新状态，核对已保存结果或接管制作。",
  agent_response_identity_mismatch: "所选步骤或请求编号与当前任务不一致，结果未导入。请刷新后核对。",
  agent_response_checksum_mismatch: "文件与本任务已收到的原结果校验值不一致，结果未导入。请选择未经修改的原返回文件。",
  agent_response_cleanup_pending: "恢复结果的保存状态尚未核实。请刷新进度并由管理员核对私有文件清理，勿重复提交模型。",
};

export function designAgentErrorMessage(code: string): string {
  return Object.hasOwn(errorLabels, code) ? errorLabels[code]! : "任务遇到未识别的问题。请刷新核对；仍无法处理时，请联系管理员或接管制作。";
}

export function designAgentBillingNotice(costStatus: DesignAgentRunView["costStatus"], steps: ReadonlyArray<{ status: DesignAgentRunView["steps"][number]["status"] }>): string | null {
  if (costStatus !== "unknown") return null;
  return steps.some(step => step.status === "uncertain")
    ? "模型请求结果待核实，实际费用也未知，保留已占用额度。"
    : "提供方实际账单尚未确认，保留已占用额度。";
}

/** Only transient GET failures retry. A POST is never replayed here. */
export function designAgentReadRetryDelay(cause: unknown, failures: number): number | null {
  const status = cause && typeof cause === "object" && "status" in cause ? cause.status : undefined;
  const transient = cause instanceof TypeError || status === 408 || status === 429 || typeof status === "number" && status >= 500 && status < 600;
  if (!transient || !Number.isInteger(failures) || failures < 1 || failures > 3) return null;
  return [2500, 5000, 10_000][failures - 1]!;
}

export function designAgentActivity(status: DesignAgentRunView["status"] | null) {
  const polling = status === "queued" || status === "running";
  return { polling, manualEditsBlocked: polling || status === "needs_attention" };
}

export function OrderDesignAgentPanel({ workItemId, refreshKey, disabled, onChanged, onStateChange,financialOnly=false }: {
  workItemId: string; refreshKey: number; disabled: boolean; onChanged: () => void;
  financialOnly?:boolean;
  onStateChange: (state: { busy: boolean; blocked: boolean; checking: boolean }) => void;
}) {
  const [run, setRun] = useState<DesignAgentRunView | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const requestKeys = useRef(new Map<string, string>());
  const epoch = useRef(0);
  const callbacks = useRef({ onChanged, onStateChange }); callbacks.current = { onChanged, onStateChange };
  const previousOutput = useRef<string | null>(null);
  const notifyAfterRead = useRef(false);
  const costTransition=useRef<ViewTransition|null>(null),costTransitionName=`order-cost-${useId().replace(/[^a-zA-Z0-9_-]/g,"")}`;
  const { manualEditsBlocked: blocked } = designAgentActivity(run?.status ?? null);
  const checking = loading || !!error;

  useEffect(() => { callbacks.current.onStateChange({ busy, blocked, checking }); }, [busy, blocked, checking]);
  useEffect(() => () => callbacks.current.onStateChange({ busy: false, blocked: false, checking: false }), []);
  useEffect(() => {
    const abort = new AbortController();
    const current = ++epoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let readRevision = 0;
    setLoading(true); setError("");
    async function read() {
      if (abort.signal.aborted || current !== epoch.current) return;
      clearTimeout(timer);
      const revision=++readRevision;
      try {
        const next = DesignAgentViewSchema.parse(await centerRequest(`lines/${workItemId}/design-agent${financialOnly?"?view=financial":""}`, undefined, abort.signal)).run;
        if (abort.signal.aborted || current !== epoch.current || revision!==readRevision) return;
        costTransition.current?.skipTransition();setRun(next); setError(""); failures = 0;
        const output = next ? `${next.id}:${next.projectId}:${next.currentEditorVersionId}:${next.status}:${next.privateEvidenceState??"available"}` : null;
        const { polling } = designAgentActivity(next?.status ?? null);
        if (!polling && (notifyAfterRead.current || previousOutput.current !== output)) callbacks.current.onChanged();
        notifyAfterRead.current = false;
        previousOutput.current = output;
        if (polling) timer = setTimeout(() => void read(), 2500);
        else if(next)timer=setTimeout(()=>void read(),30_000);
      } catch (cause) {
        if (!abort.signal.aborted && current === epoch.current && revision===readRevision) {
          costTransition.current?.skipTransition();setRun(null);
          const delay = designAgentReadRetryDelay(cause, ++failures);
          setError(delay === null ? "制图进度暂时无法读取，当前状态尚未核对。请刷新进度后再编辑或审核。" : `制图进度暂时无法读取，${delay / 1000} 秒后重试（${failures}/3）。当前状态尚未核对。`);
          if (delay !== null) timer = setTimeout(() => void read(), delay);
        }
      } finally { if (!abort.signal.aborted && current === epoch.current && revision===readRevision) setLoading(false); }
    }
    void read();
    const refresh=()=>{if(document.visibilityState==="visible")void read();};
    window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",refresh);
    return () => { abort.abort(); clearTimeout(timer);costTransition.current?.skipTransition();window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",refresh); };
  }, [workItemId, refreshKey, reload,financialOnly]);

  function toggleCostEvidence(event:MouseEvent<HTMLDetailsElement>){
    const element=event.currentTarget,summary=element.querySelector(":scope > summary");
    if(!(event.target instanceof Node)||!summary?.contains(event.target)||typeof document.startViewTransition!=="function"||window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
    event.preventDefault();costTransition.current?.skipTransition();const open=!element.open;
    costTransition.current=observeViewTransition(document.startViewTransition(()=>{if(element.isConnected)element.open=open;}));
  }

  async function act(action: "resume" | "takeover" | "restore-response", restored?: Omit<OrderDesignRestoreResponse, "idempotencyKey">) {
    if (!run || disabled || busy || checking) return;
    const payload = restored ?? { runId: run.id, expectedRevision: run.revision };
    const signature = JSON.stringify({ action, ...payload });
    const idempotencyKey = requestKeys.current.get(signature) ?? crypto.randomUUID();
    requestKeys.current.set(signature, idempotencyKey);
    ++epoch.current;
    setBusy(true); setError(""); setNotice("");
    try {
      await centerRequest(`lines/${workItemId}/design-agent/${action}`, { ...payload, idempotencyKey });
      setNotice(action === "takeover" ? "已停止自动制作并保留完成的素材，可以接着手工修改。" : action === "restore-response"
        ? "原结果已进入私有检查点，将从该步骤继续检查和制图，尚未通过质量检查或人工审核。未知费用仍保留额度。"
        : "已请求恢复，完成的步骤将保留。结果待核实的模型调用不会自动重发。");
      callbacks.current.onChanged();
    } catch (cause) { setError(cause instanceof Error ? /^agent_[a-z0-9_]+$/.test(cause.message) ? designAgentErrorMessage(cause.message) : cause.message : "操作未完成，请刷新核对任务状态"); }
    finally { setBusy(false); setReload(value => value + 1); }
  }

  return <section className="oc-section oc-design-agent" aria-label="无人设计进度" aria-busy={busy || loading}>
    <div className="oc-actions"><h3>{financialOnly?"制作与费用记录":"无人设计"}</h3><button type="button" className="oc-button" disabled={busy || loading} onClick={() => { notifyAfterRead.current = true; setReload(value => value + 1); }}><RefreshCw size={14} />刷新进度</button></div>
    {error && <p role="alert" className="oc-error">{error}</p>}
    {notice && <p role="status" className="oc-notice">{notice}</p>}
    {loading && !run ? <p className="oc-hint">正在读取制图任务…</p> : !run ? <p className="oc-hint">{error ? "尚无法确认自动制图任务状态。请刷新进度。" : financialOnly?"尚无独立的自动制图费用记录。":"暂无自动制图任务。使用已配置自动制图的工艺底稿，审单并派发后开始执行。"}</p> : <>
      <p><strong>{statusLabels[run.status] ?? "状态待核对"}</strong><span className="oc-hint"> · 更新于 {dateTime(run.updatedAt)}</span></p>
      {run.privateEvidenceState==="expired"?<p className="oc-hint">订单私有资料已到期 历史方法和产物交接不再展示</p>:financialOnly||run.privateEvidenceOmitted?<p className="oc-hint">当前仅显示制作状态与费用依据。</p>:<>
        <MethodEvidence selection={run.methodSnapshot?.methodSelection} />
        {run.completion?<p className="oc-hint" aria-label="原始制作交接">已核验 {run.completion.evidence.proofs.reduce((count,proof)=>count+proof.files.length,0)} 份原尺寸待审稿 · 交由业务审核</p>:run.status==="awaiting_review"?<p className="oc-hint">历史任务未记录产物交接凭据</p>:null}
      </>}
      {!financialOnly&&!run.privateEvidenceOmitted&&<RecoveryProgress run={run} />}
      <p className="oc-hint">{run.costStatus === "not_required" ? "此任务无需模型调用。" : <>
        配置估算：{run.estimatedCostUsd === null ? "未知" : `${run.estimatedCostUsd.toLocaleString("zh-CN", { maximumFractionDigits: 6 })} USD`}；
        实际费用：{run.actualCostUsd === null ? "尚无完整费用依据" : `${run.actualCostUsd.toLocaleString("zh-CN", { maximumFractionDigits: 8 })} USD`}。
        {designAgentBillingNotice(run.costStatus, run.steps)}
      </>}</p>
      {!!run.modelCalls?.length&&<details key={run.id} className="oc-section oc-model-costs" aria-label="原调用费用依据" style={{viewTransitionName:costTransitionName}} onClick={toggleCostEvidence}><summary>原调用费用依据 · {run.modelCalls.length} 次</summary>
        <p className="oc-hint">模型服务报告与预算占用分别保留，仍需核对提供方账单。此处不包含原图或提示词。</p>
        {run.modelCallsTruncated&&<p className="oc-hint">仅显示最近 1000 次调用；费用汇总仍使用完整账本。</p>}
        <ul>{run.modelCalls.map(call=><li key={call.id}>
          <strong>{call.costReportState==="reported"?`${Number(call.reportedCostUsd).toLocaleString("zh-CN",{maximumFractionDigits:8})} USD`:call.costReportState==="pending"?run.status==="running"?"等待模型响应":"模型结果待核对":call.costReportState==="invalid"?"费用报告需核对":"模型未报告费用"}</strong>
          <span className="oc-hint"> · 提交于 {dateTime(call.submittedAt)}{call.receivedAt?` · 返回于 ${dateTime(call.receivedAt)}`:""} · 记录 {call.id.slice(-8)}</span>
          <p className="oc-hint">{call.budgetState==="released"?"预算预留已释放":call.budgetState==="reserved"?"当前预算预留":"已计入预算"}：{call.budgetAmountUsd} USD</p>
        </li>)}</ul>
      </details>}
      {!financialOnly&&!run.privateEvidenceOmitted&&<>
      {run.status === "queued" && <p className="oc-hint">原制作任务已保存 正在等待执行 尚未代表后台已开始处理 关闭页面不会取消原任务</p>}
      {run.status === "running" && <p className="oc-hint">后台正在处理，关闭页面不会停止任务。需要修改稿件时，请先接管。</p>}
      <details className="oc-section"><summary>本任务使用的规则 · {run.ruleSnapshot ? `${run.ruleSnapshot.rules.length} 条` : "历史任务未记录"}</summary>
        {run.ruleSnapshot ? <><p className="oc-hint">固定于 {dateTime(run.ruleSnapshot.capturedAt)}。以下内容来自派发时的版本，后续规则变更不会覆盖。</p>
          {run.ruleSnapshot.rules.length === 0 && <p className="oc-hint">派发时没有匹配的启用规则；仍执行工艺底稿中的预检。</p>}
          <p className="oc-hint">核验方式说明系统能力；本单是否已执行或通过，以步骤和检查结果为准。</p>
          {run.ruleSnapshot.rules.map(rule => <div key={rule.id}><p><strong>{rule.name} · V{rule.version}</strong> · 核验方式：{ruleVerificationLabels[rule.execution]} · <Link href={`/settings/rules?rule=${rule.ruleId}&version=${rule.version}`}>查看规则依据</Link></p><p className="oc-hint">{rule.instructions}</p></div>)}</>
          : <p className="oc-hint">此历史任务没有规则中心快照，不能用当前规则补记；原工艺与文件版本记录仍保留。</p>}
      </details>
      {run.status === "awaiting_review" && <p className="oc-notice">制作步骤已完成，请核对原图、稿件和预检结果，再进行正式审核。</p>}
      {run.status === "needs_attention" && <p className="oc-notice">自动制作已暂停。请核对下面未完成的步骤；需要人工修改或审核时，请先接管。接管会保留已完成的素材和版本。</p>}
      {run.errorCode && run.status !== "cancelled" && <p className="oc-error" role="status">处理原因：{designAgentErrorMessage(run.errorCode)}</p>}
      <ol className="oc-agent-steps">{run.steps.map(step => <li key={step.id}>
        <div><strong>{step.key === "review_required" ? "交付待核对稿件" : step.label}</strong><span>{step.key === "review_required" && step.status === "completed" ? "待人工核对" : statusLabels[step.status] ?? "状态待核对"}</span></div>
        {step.status === "uncertain" && <p className="oc-hint">模型请求可能已执行或计费，不能直接重新提交。可核实原结果时从原检查点继续；无法核实时接管处理。</p>}
        {step.status === "failed" && <p className="oc-hint">该步骤没有完成，已成功的步骤仍然保留。</p>}
        {step.errorCode && <p className="oc-hint">{designAgentErrorMessage(step.errorCode)}</p>}
        {step.key === "optimize_contour" && step.contourEvidence && <ContourExecutionEvidence evidence={step.contourEvidence} />}
        {step.responseRecovery && <details aria-label="人工恢复记录"><summary>人工核实并导入原结果 · {dateTime(step.responseRecovery.verifiedAt)}</summary>
          <p className="oc-hint">提供方记录：{step.responseRecovery.providerReference}</p><p className="oc-hint">核对依据：{step.responseRecovery.verificationNote}</p>
          <p className="oc-hint">由操作人确认，未自动查询提供方；结果导入不代表质量、账单或生产批准。</p>
        </details>}
        {step.completedAt && <small className="oc-hint">{dateTime(step.completedAt)}</small>}
      </li>)}</ol>
      {run.qualityDiagnostics.length > 0 && <div aria-label="自动制图检查结果">
        <strong>检查结果</strong>
        <ul>{run.qualityDiagnostics.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity === "error" ? "oc-error" : "oc-hint"}>
          {issue.severity === "error" ? "需修正" : issue.severity === "manual" ? "待人工核对" : "提醒"}：{issue.message}
        </li>)}</ul>
      </div>}
      {run.responseRecoveryBlockedCode && <p className="oc-hint">原结果恢复暂不可用：{designAgentErrorMessage(run.responseRecoveryBlockedCode)}</p>}
      {run.responseRecoveryTarget && <OrderDesignResponseRecoveryForm key={`${run.id}:${run.revision}`} run={run}
        disabled={disabled || busy || checking} onRestore={input => act("restore-response", input)} />}
      <div className="oc-actions">
        {run.canResume && <button type="button" className="oc-button" disabled={disabled || busy || checking} onClick={() => void act("resume")}>恢复可重试步骤</button>}
        {run.canTakeOver && <button type="button" className="oc-button" disabled={disabled || busy || checking} onClick={() => void act("takeover")}>停止自动制作并接管</button>}
      </div>
      {disabled && <p className="oc-hint">先保存当前修改或等待正在提交的操作完成，再处理制图任务。</p>}
      </>}
    </>}
  </section>;
}

function RecoveryProgress({ run }: { run: DesignAgentRunView }) {
  const progress = designAgentRecoveryGuidance(run);
  return <div className="oc-agent-recovery-progress" aria-label="制图衔接与恢复">
    <p className="oc-hint">已完成 {progress.completedCount}/{progress.totalCount} 步{progress.lastCompleted ? ` · 最近完成：${progress.lastCompleted.label}` : ""}
      {progress.blockedStep ? ` · 当前步骤：${progress.blockedStep.label}` : ""}</p>
    <p>{progress.nextAction}</p>
    {run.projectId && <Link href={`/pod-workbench/production-editor?projectId=${run.projectId}`}>查看当前稿件与保留素材</Link>}
  </div>;
}
