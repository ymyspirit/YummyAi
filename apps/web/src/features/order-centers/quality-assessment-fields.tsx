"use client";
import { useState } from "react";
import { flushSync } from "react-dom";
import { QualityAssessmentSchema, evaluateQualityAssessment, type QualityCriterionResult, type QualityStandardBasis } from "@yummyai/contracts/order/quality-assessment";
import { RecordQualityInspectionInputSchema } from "@yummyai/contracts/order/production";
import { cancelViewTransitions, observeViewTransition } from "../navigation/view-transition";
import { FulfillmentCommandPrepareButton } from "./fulfillment-command-recovery";
import { useAgentFulfillmentProposalHandoff, agentFulfillmentProposalLocalTime } from "../ai-tasks/agent-fulfillment-proposal-handoff";

type Standard = QualityStandardBasis & { id: string; name: string; versionNumber: number };
export type QualityRating = { score: string; outcome: string };
type Rating = QualityRating;

export function readQualityAssessmentForm(form: FormData) {
  const assessment = QualityAssessmentSchema.parse(JSON.parse(String(form.get("qualityAssessment") || "null")));
  const defects = RecordQualityInspectionInputSchema.shape.defects.parse(JSON.parse(String(form.get("qualityDefects") || "[]")));
  const scoreBps = Number(form.get("score")), result = String(form.get("result"));
  if (!Number.isInteger(scoreBps) || scoreBps < 0 || scoreBps > 10_000 || !["passed", "failed"].includes(result))
    throw new Error("请完成全部质检项目");
  return { assessment, scoreBps, result: result as "passed" | "failed", defects };
}

/** Replacing an original basis requires an explicit restart of all checks. */
export function QualityAssessmentFields({
  standards, projectionVersion, pins, passOnly = false, disabled, submitLabel, allowAgentPrepare = false, suggestion,
}: {
  standards: Standard[]; projectionVersion?: number; pins?: unknown;
  passOnly?: boolean; disabled: boolean; submitLabel: string; allowAgentPrepare?: boolean;
  suggestion?: { qualityStandardVersionId?: string; assessment?: unknown; inspectedAt?: string; expectedProductionProjectionVersion?: number } | null;
}) {
  const proposalHandoff = useAgentFulfillmentProposalHandoff(), parsedSuggestion = QualityAssessmentSchema.safeParse(suggestion?.assessment);
  const [standardId, setStandardId] = useState(() => { const id = suggestion?.qualityStandardVersionId; return id && standards.some(value => value.id === id) ? id : ""; }),
    [ratings, setRatings] = useState<Record<string, Rating>>(() => parsedSuggestion.success ? Object.fromEntries(parsedSuggestion.data.criterionResults.map(value => [value.code,
      { score: String(value.scoreBps / 100), outcome: value.passed ? "passed" : "failed" }])) : {});
  const [manualHold, setManualHold] = useState(false);
  const [severity, setSeverity] = useState(""), [responsibility, setResponsibility] = useState("");
  const [disposition, setDisposition] = useState(""), [note, setNote] = useState("");
  const currentPins = JSON.stringify(pins ?? null);
  const [originalProjection, setOriginalProjection] = useState(suggestion?.expectedProductionProjectionVersion ?? projectionVersion), [originalPins, setOriginalPins] = useState(currentPins);
  const basisChanged = originalProjection !== projectionVersion || originalPins !== currentPins;
  const standard = standards.find(row => row.id === standardId);
  const results: QualityCriterionResult[] = standard?.criteria.flatMap(criterion => {
    const rating = ratings[criterion.code];
    return rating?.score.trim() && ["passed", "failed"].includes(rating.outcome)
      ? [{ code: criterion.code, scoreBps: Math.round(Number(rating.score) * 100), passed: rating.outcome === "passed", evidenceAssetIds: [] }] : [];
  }) ?? [];
  const rawEvaluation = standard ? evaluateQualityAssessment(standard, results) : null;
  const failedCodes = results.filter(result => !result.passed).map(result => result.code);
  const needsDefects = !passOnly && (manualHold || failedCodes.length > 0 || rawEvaluation?.result === "failed");
  const parsedDefects = RecordQualityInspectionInputSchema.shape.defects.safeParse(needsDefects
    ? (failedCodes.length ? failedCodes : ["MANUAL_QC"]).map(code => ({ code, severity, responsibility, disposition, note, evidenceAssetIds: [] })) : []);
  const defects = parsedDefects.success ? parsedDefects.data : [];
  const evaluation = standard ? evaluateQualityAssessment(standard, results, defects) : null;
  const complete = evaluation?.scoreBps !== null && evaluation?.scoreBps !== undefined && !evaluation.problems.length;
  const failed = complete && evaluation?.result === "failed";
  const transition = (update: () => void) => {
    if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cancelViewTransitions(); observeViewTransition(document.startViewTransition(() => flushSync(update)));
    } else update();
  };
  const changeStandard = (id: string) => {
    if (id === standardId) return;
    transition(() => {
      setStandardId(id); setRatings({}); setManualHold(false); setSeverity(""); setResponsibility(""); setDisposition(""); setNote("");
    });
  };
  return <fieldset className="oc-quality-fields" disabled={disabled}>
    <legend>{passOnly ? "本单全部商品逐项质检" : "逐项质检"}</legend>
    {proposalHandoff && <p className="oc-hint oc-full-field">以下建议须逐项按实物核对 不把模型分数当作实际质检 本人确认不预选</p>}
    {basisChanged && <div className="oc-error oc-full-field" role="alert">
      <p>生产依据已更新 当前填写仍按原记录保留 请核对新记录后重新检查</p>
      <button type="button" className="oc-button" onClick={() => transition(() => {
        setOriginalProjection(projectionVersion); setOriginalPins(currentPins); setRatings({}); setManualHold(false);
        setSeverity(""); setResponsibility(""); setDisposition(""); setNote("");
      })}>核对新记录并重新逐项检查</button>
    </div>}
    <label className="oc-full-field">{passOnly ? "整单质检标准" : "检验标准"}
      <select required value={standardId} onChange={event => changeStandard(event.target.value)}>
        <option value="">选择适用的标准</option>
        {standards.map(row => <option key={row.id} value={row.id}>{row.name} V{row.versionNumber} · 最低 {row.minimumScoreBps / 100} 分</option>)}
      </select>
    </label>
    <input type="hidden" name="standard" value={standardId} />
    <input type="hidden" name="qualityProjection" value={originalProjection ?? ""} />
    <input type="hidden" name="qualityPins" value={originalPins} />
    <input type="hidden" name="qualityAssessment" value={complete ? JSON.stringify({ formatVersion: 2, criterionResults: results }) : ""} />
    <input type="hidden" name="qualityDefects" value={JSON.stringify(defects)} />
    <input type="hidden" name="score" value={complete ? evaluation!.scoreBps! : ""} />
    <input type="hidden" name="result" value={complete ? evaluation!.result! : ""} />
    {standard && !standard.criteria.length && <p className="oc-error oc-full-field" role="alert">尚未读取此标准的核验项目 请重新核对资料</p>}
    {standard && <QualityCriterionFields standard={standard} ratings={ratings} onChange={(code, patch) => {
      const update = () => setRatings(current => ({ ...current, [code]: { ...(current[code] ?? { score: "", outcome: "" }), ...patch } }));
      if (patch.outcome !== undefined) transition(update); else update();
    }} />}
    {!passOnly && <label className="oc-check oc-full-field"><input type="checkbox" checked={manualHold} onChange={event => {
      const checked = event.target.checked; transition(() => setManualHold(checked));
    }} />另有缺陷需要登记</label>}
    {needsDefects && <fieldset className="oc-quality-check" aria-label="本次缺陷处理">
      <legend>本次缺陷处理</legend>
      <p className="oc-hint oc-full-field">以下处理适用于本次全部未通过项目 请按实际检查结果选择</p>
      <label>缺陷严重度<select aria-label="缺陷严重度" required value={severity} onChange={event => setSeverity(event.target.value)}>
        <option value="">请选择</option><option value="minor">轻微</option><option value="major">重大</option><option value="critical">严重</option>
      </select></label>
      <label>责任归属<select aria-label="责任归属" required value={responsibility} onChange={event => setResponsibility(event.target.value)}>
        <option value="">请选择</option><option value="supplier">供应商</option><option value="internal">内部</option><option value="carrier">承运商</option><option value="customer">客户</option><option value="unknown">尚未确定</option>
      </select></label>
      <label>处理方式<select aria-label="处理方式" required value={disposition} onChange={event => setDisposition(event.target.value)}>
        <option value="">请选择</option><option value="accept">按实际情况接受</option><option value="rework">返工</option><option value="remake">补做</option><option value="reship">补发</option><option value="refund">退款</option><option value="cancel">取消</option>
      </select></label>
      <label className="oc-full-field">不合格说明<textarea required value={note} maxLength={2000} onChange={event => setNote(event.target.value)} /></label>
    </fieldset>}
    <p className={"oc-quality-decision oc-full-field" + (failed ? " oc-error" : "")} role="status">
      {complete ? "加权得分 " + evaluation!.scoreBps! / 100 + " 分 · " + (needsDefects && !parsedDefects.success ? "待明确缺陷处理" : failed ? "未通过" : "符合所选标准") : "完成全部项目后计算总分 不默认核验通过"}
    </p>
    {passOnly && (failed || failedCodes.length > 0) && <p className="oc-error oc-full-field" role="alert">本单尚有不合格项目 请在商品记录中登记缺陷和处理结果</p>}
    <label>{passOnly ? "整单质检时间" : "检验时间"}<input required type="datetime-local" name="time" defaultValue={agentFulfillmentProposalLocalTime(suggestion?.inspectedAt)} /></label>
    {passOnly && <label className="oc-check oc-full-field"><input required type="checkbox" />已逐项核对本单全部商品 均符合所选标准</label>}
    <button className="oc-button primary" disabled={disabled || !!proposalHandoff || basisChanged || !complete || !parsedDefects.success || (passOnly && (!!failed || failedCodes.length > 0))}>{submitLabel}</button>
    {allowAgentPrepare && <FulfillmentCommandPrepareButton disabled={disabled || basisChanged || !complete || !parsedDefects.success || (passOnly && (!!failed || failedCodes.length > 0))} />}
  </fieldset>;
}

export function QualityCriterionFields({ standard, ratings, onChange }: {
  standard: QualityStandardBasis & { id: string }; ratings: Record<string, QualityRating>; onChange(code: string, patch: Partial<QualityRating>): void;
}) {
  return <>{standard.criteria.map(criterion => {
    const rating = ratings[criterion.code] ?? { score: "", outcome: "" };
    return <fieldset className="oc-quality-check" key={standard.id + ":" + criterion.code} aria-label={"核验项目 " + criterion.label}>
      <legend>{criterion.label}</legend>
      <p className="oc-hint oc-full-field">权重 {criterion.weightBps / 100}%{criterion.blocking ? " · 未通过会阻断放行" : " · 计入总分"}</p>
      <label>{criterion.label} 得分<input aria-label={criterion.label + " 得分"} type="number" min={0} max={100} step="0.01" required value={rating.score}
        onChange={event => onChange(criterion.code, { score: event.target.value })} /></label>
      <label>{criterion.label} 核验结果<select aria-label={criterion.label + " 核验结果"} required value={rating.outcome}
        onChange={event => onChange(criterion.code, { outcome: event.target.value })}>
        <option value="">尚未核验</option><option value="passed">通过</option><option value="failed">未通过</option>
      </select></label>
    </fieldset>;
  })}</>;
}
