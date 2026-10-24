"use client";

import type { ProductionEditorPreflight } from "@yummyai/contracts/pod/production-editor";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import type { ProductionEditorFocus } from "../production-editor/production-editor-workspace";
import { artworkIssueGuidance } from "./order-artwork-issue-guidance";

export function OrderArtworkChecks({ check, editor, disabled, onResolve }: {
  check: ProductionEditorPreflight | null | undefined;
  editor: ProductionEditorDetailView;
  disabled: boolean;
  onResolve: (focus: ProductionEditorFocus) => void;
}) {
  const repairs = check?.issues.filter(issue => issue.severity === "error").length ?? 0;
  const confirmations = check?.issues.filter(issue => issue.severity === "manual").length ?? 0;
  return <section className="oc-artwork-check" aria-label="文件检查">
    <h3>文件检查</h3>
    {check && <p>输出尺寸 {check.widthPx} × {check.heightPx} px · {editor.version.document.exportBackground === "white" ? "白底" : "透明背景"}</p>}
    <p className={check?.productionReady ? "oc-hint" : "oc-error"}>
      {check?.productionReady ? "文件检查通过，请核对图案、尺寸与客户要求。"
        : !check ? "生成当前版本预览后显示检查结果。"
          : repairs + confirmations ? `需处理 ${repairs + confirmations} 项：${repairs} 项需修复、${confirmations} 项待确认。`
            : "检查尚未通过，但未返回具体原因。请重新生成当前版本待审稿，再查看检查结果。"}
    </p>
    {([
      { severity: "error", label: "需修复", action: "去修复" },
      { severity: "manual", label: "待人工确认", action: "去核对" },
      { severity: "warning", label: "工艺提醒（不阻止审核）", action: "" },
    ] as const).map(group => {
      const issues = check?.issues.filter(issue => issue.severity === group.severity) ?? [];
      if (!issues.length) return null;
      return <section key={group.severity} className="oc-artwork-issues" aria-label={group.label}>
        <h4>{group.label} · {issues.length} 项</h4>
        <ul>{issues.map((issue, index) => {
          const guidance = artworkIssueGuidance(issue);
          const layer = editor.version.document.layers.find(layer => layer.id === issue.layerId);
          return <li key={`${issue.code}:${index}`} data-severity={issue.severity}>
            <div className="oc-artwork-issue-heading"><strong>{guidance.title}</strong>
              {group.action && <button type="button" className="oc-button" disabled={disabled}
                aria-label={`${group.action}：${guidance.title}`}
                onClick={() => onResolve({ inspector: guidance.inspector, layerId: issue.layerId, versionId: editor.version.id })}>{group.action}</button>}
            </div>
            {layer && <small>涉及图层：{layer.name || "未命名图层"}</small>}
            <p>{issue.message}</p>
            <p><b>处理方法：</b>{guidance.instruction}</p>
            <small>处理位置：{guidance.location}</small>
          </li>;
        })}</ul>
      </section>;
    })}
    {repairs + confirmations > 0 && <p className="oc-hint">修复并核实后，在编辑器点击“检查生产参数”，再“生成原尺寸待审稿”，返回此处复核新版本。确认项须实际核验后填写。</p>}
  </section>;
}
