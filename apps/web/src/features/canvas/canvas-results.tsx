"use client";
import type { CanvasResultView } from "@yummyai/contracts/pod/canvas-bridge";
import { ExternalLink, FileImage, ScanSearch, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
export const RESULT_STATUS = { pending_review: "待审核", adapting: "处理中", approved: "已通过", rejected: "已退回" } as const;
export function CanvasResults({ results, selected, disabled, onSelection, onOpenProduction }: {
  results: CanvasResultView[]; selected: string[]; disabled: boolean; onSelection: (ids: string[]) => void; onOpenProduction?: (projectId: string, name: string) => void;
}) {
  const [preview, setPreview] = useState<CanvasResultView | null>(null);
  const [failed, setFailed] = useState<Record<string, boolean>>({}), [attempt, setAttempt] = useState<Record<string, number>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (preview) dialog.current?.showModal(); }, [preview]);
  return <>
    <div className="canvas-result-grid">{results.map((result) => <article key={result.versionId} className={`canvas-result ${selected.includes(result.versionId) ? "selected" : ""}`}>
      <button type="button" className="canvas-result-image" aria-label={failed[result.versionId] ? `重试预览 ${result.name}` : `放大 ${result.name}`} onClick={() => {
        if (failed[result.versionId]) setAttempt((current) => ({ ...current, [result.versionId]: (current[result.versionId] ?? 0) + 1 })); else setPreview(result);
      }}>
        {/* Private authenticated preview must not enter Next's public image cache. */}
        <img src={`${result.previewPath}${attempt[result.versionId] ? `?retry=${attempt[result.versionId]}` : ""}`} alt={result.name} loading="lazy" style={failed[result.versionId] ? { visibility: "hidden" } : undefined}
          onError={() => setFailed((current) => ({ ...current, [result.versionId]: true }))} onLoad={() => setFailed((current) => current[result.versionId] ? { ...current, [result.versionId]: false } : current)} />
        <span><ScanSearch size={16} />{failed[result.versionId] ? "预览加载失败，点击重试" : "放大查看"}</span>
      </button>
      <div className="canvas-result-body"><label className="canvas-check"><input type="checkbox" aria-label={`选择方案 ${result.name}`} checked={selected.includes(result.versionId)} disabled={disabled || result.status === "rejected" || result.status === "adapting"}
        onChange={(event) => onSelection(event.target.checked ? [...selected, result.versionId] : selected.filter((id) => id !== result.versionId))} /><b>{result.name}</b></label>
        <div className="canvas-result-meta"><span className={`canvas-badge ${result.status}`}>{RESULT_STATUS[result.status]}</span><small>{result.width && result.height ? `${result.width} × ${result.height} px` : "尺寸待检查"}</small></div>
        {result.rejectionReason ? <p className="canvas-rejection">退回原因：{result.rejectionReason}</p> : null}
        {result.productionProjects.map((project) => onOpenProduction
          ? <button type="button" className="canvas-production-link" key={project.id} disabled={disabled} onClick={() => onOpenProduction(project.id, result.name)}><FileImage size={14} /><span>打开生产稿<small>{project.templateName}</small></span></button>
          : <Link className="canvas-production-link" key={project.id} href={`/pod-workbench/production-editor?projectId=${project.id}`}><ExternalLink size={14} /><span>打开生产稿<small>{project.templateName}</small></span></Link>)}
      </div>
    </article>)}</div>
    <dialog ref={dialog} className="canvas-preview-dialog" onClose={() => setPreview(null)}>
      {preview ? <><header><div><strong>{preview.name}</strong><small>{RESULT_STATUS[preview.status]} · {preview.width} × {preview.height} px · 缩略预览</small></div><button type="button" aria-label="关闭方案预览" onClick={() => dialog.current?.close()}><X size={20} /></button></header>
        <img src={preview.previewPath} alt={`${preview.name} 放大预览`} /></> : null}
    </dialog>
  </>;
}
