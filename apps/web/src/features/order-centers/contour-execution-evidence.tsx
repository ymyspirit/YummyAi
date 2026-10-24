import type { PillowContourEvidence } from "@yummyai/contracts/pod/design-automation";
import "./contour-execution-evidence.css";

const checkLabels: Record<string, string> = {
  pillow_subject_alpha32: "可见主体测量",
  pillow_actual_subject_resolution: "主体实际分辨率",
  pillow_independent_bounded_contour: "独立裁线与缝边范围",
  pillow_factory_contour_union: "裁线闭合与底部凸框",
  pillow_contour_generation: "裁线生成",
  pillow_visual_review: "原图与稿件目视核对",
  pillow_finished_narrow_parts: "成品细窄部位核对",
  pillow_factory_acceptance: "工厂验收",
};
const resultLabels = { passed: "通过", failed: "需修正", manual: "待人工核对" } as const;

export function ContourExecutionEvidence({ evidence }: { evidence: PillowContourEvidence }) {
  return <details className="oc-contour-evidence" aria-label="裁线执行证据">
    <summary>裁线执行证据 · {evidence.status === "passed" ? "技术检查通过" : "需人工处理"} · {evidence.attempts.length} 次检查</summary>
    <p className="oc-hint">锁定图案保持不变，输入与输出素材校验和一致。技术检查不代表人工审核或生产批准。</p>
    {evidence.status === "needs_attention" && <p className="oc-error">允许的修正方案已用尽。请接管核对独立裁线，已完成素材仍保留。</p>}
    <ol aria-label="裁线检查与修正记录">{evidence.attempts.map((attempt, index) => <li key={attempt.roundingPx}>
      <strong>{index === 0 ? "初次检查" : `第 ${index} 次修正`} · 圆滑余量 {attempt.roundingPx} px · {attempt.technicalPassed ? "技术检查通过" : "技术检查未通过"}</strong>
      <dl className="oc-contour-checks">{attempt.checks.map((check, checkIndex) => <div key={`${check.code}-${checkIndex}`}>
        <dt>{Object.hasOwn(checkLabels, check.code) ? checkLabels[check.code] : "其他检查项（请人工核对）"}</dt>
        <dd className={check.status === "failed" ? "oc-error" : "oc-hint"}>{resultLabels[check.status]}</dd>
      </div>)}</dl>
    </li>)}</ol>
    <p className="oc-hint">仍需运营对照原图核验、核对工厂要求并审核稿件，之后才能正式导出及下达生产。</p>
    <dl className="oc-contour-trace">
      <dt>执行版本</dt><dd>{evidence.workflowVersion}</dd>
      <dt>锁定素材</dt><dd>{evidence.sourceAssetId}</dd>
      <dt>输入 SHA-256</dt><dd>{evidence.sourceChecksum}</dd>
      <dt>输出 SHA-256</dt><dd>{evidence.outputChecksum}</dd>
    </dl>
  </details>;
}
