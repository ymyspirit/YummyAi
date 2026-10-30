"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function ModelSettingsDialog({ title, description, children, busy, onClose, onBeforeClose, wide = false }: {
  title: string; description: string; children: ReactNode | ((close: () => void) => ReactNode); busy: boolean; onClose: () => void; onBeforeClose?: () => boolean; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null), closeRef = useRef<HTMLButtonElement>(null), timer = useRef<ReturnType<typeof setTimeout>>(null);
  const [closing, setClosing] = useState(false), titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current, previousFocus = document.activeElement, overflow = document.body.style.overflow;
    dialog?.showModal(); closeRef.current?.focus({ preventScroll: true }); document.body.style.overflow = "hidden";
    return () => { if (timer.current) clearTimeout(timer.current); dialog?.close(); document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  function close() {
    if (busy || closing || onBeforeClose?.() === false) return;
    setClosing(true); timer.current = setTimeout(onClose, typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
  }
  return <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}
    className={`studio-workspace ai-settings-dialog${wide ? " ai-settings-dialog-wide" : ""}${closing ? " is-closing" : ""}`}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="ai-settings-dialog-header"><div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
      <button ref={closeRef} type="button" className="ai-settings-icon-button" aria-label="关闭配置窗口" disabled={busy} onClick={close}><X size={18} /></button></header>
    {typeof children === "function" ? children(close) : children}
  </dialog>;
}
