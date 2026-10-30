"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function ModelSettingsCompatibility({ open, busy, dirty, children, onClose }: {
  open: boolean; busy: boolean; dirty: boolean; children: ReactNode; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null), closeRef = useRef<HTMLButtonElement>(null), timer = useRef<ReturnType<typeof setTimeout>>(null);
  const [closing, setClosing] = useState(false), titleId = useId(), descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current, previousFocus = document.activeElement, overflow = document.body.style.overflow;
    dialog?.showModal(); closeRef.current?.focus({ preventScroll: true }); document.body.style.overflow = "hidden";
    return () => {
      if (timer.current) clearTimeout(timer.current);
      dialog?.close(); document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);
  function close() {
    if (busy || closing) return;
    setClosing(true);
    timer.current = setTimeout(() => { setClosing(false); onClose(); }, typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
  }
  // Keep this subtree mounted after closing so compatibility drafts and unknown
  // write receipts survive reopening. The outer authority boundary still owns it.
  return <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}
    className={`studio-workspace ai-settings-dialog ai-settings-compatibility${closing ? " is-closing" : ""}`}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="ai-settings-dialog-header"><div><h2 id={titleId}>高级兼容配置工作区</h2>
      <p id={descriptionId}>原画布配置和历史分析模型共用 ERP 配置 修改其他入口后先读取最新配置{dirty ? " 当前有未保存填写 关闭窗口后仍保留在本页" : " 关闭窗口后保留本页填写"}</p></div>
      <button ref={closeRef} type="button" className="ai-settings-icon-button" aria-label="关闭高级兼容配置" disabled={busy} onClick={close}><X size={18} /></button></header>
    <div className="ai-settings-compatibility-body">{children}</div>
  </dialog>;
}
