"use client";

import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ProductionEditorWorkspace, type ProductionEditorNavigationState } from "./production-editor-workspace";
import type { ProductionKind } from "./production-editor-model";
import "./production-editor.css";

export function ProductionEditorSession({ title, subtitle, returnLabel, projectId, reportLineId, kind, context, onClose }: {
  title: string; subtitle: string; returnLabel: string; projectId?: string; reportLineId?: string;
  kind?: ProductionKind; context?: ReactNode; onClose: () => void;
}) {
  const [navigation, setNavigation] = useState<ProductionEditorNavigationState>({ dirty: false, busy: false });
  const current = useRef(navigation); current.current = navigation;
  const close = useRef(onClose); close.current = onClose;
  const heading = useRef<HTMLHeadingElement>(null);
  const back = useRef<() => void>(() => {});
  const historyToken = useRef<string | null>(null);

  useEffect(() => {
    heading.current?.focus();
    // A same-route history entry makes browser Back return to the originating task.
    // Preserve Next's history fields so its router retains the existing page state.
    const previous = window.history.state;
    const token = historyToken.current ??= crypto.randomUUID();
    if (previous?.productionSession !== token) window.history.pushState({ ...previous, productionSession: token }, "", window.location.href);
    let restoring = false;
    function pop() {
      if (restoring) { restoring = false; return; }
      if (window.history.state?.productionSession === token) return;
      if (current.current.busy || current.current.dirty && !window.confirm("生产稿还有未保存的改动，确定放弃改动并返回？")) {
        restoring = true; window.history.forward(); return;
      }
      close.current();
    }
    back.current = () => {
      if (!current.current.busy) window.history.back();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  return <section className="pe-session" aria-label="当前任务生产作图">
    <header className="pe-session-header">
      <button type="button" className="pe-button" disabled={navigation.busy} onClick={() => back.current()}><ArrowLeft size={16} />{returnLabel}</button>
      <div><h2 tabIndex={-1} ref={heading}>{title}</h2><p>{subtitle}</p></div>
      <span className="pe-session-state">{navigation.busy ? "正在处理…" : navigation.dirty ? "有未保存改动" : "已保存的版本可继续编辑"}</span>
    </header>
    {context ? <details className="pe-source-details"><summary>查看当前订单的定制要求与原图</summary>{context}</details> : null}
    <ProductionEditorWorkspace kind={kind} initialProjectId={projectId} reportLineId={reportLineId}
      scope={projectId ? "project" : reportLineId ? "order" : "templates"} onNavigationStateChange={setNavigation} />
  </section>;
}
