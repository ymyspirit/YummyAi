"use client";

import { useEffect, useId, useRef } from "react";
import { RefreshCw, Trash2 } from "lucide-react";

export function ModelRemovalDialog({ label, model, channel, shared, busy, error, confirmationBlocked = false, rechecking = false, notice = "", onReconcile, onConfirm, onCancel }: {
  label: string; model: string; channel: string; shared: boolean;
  busy: boolean; error: string; onConfirm: () => void; onCancel: () => void;
  confirmationBlocked?: boolean; rechecking?: boolean; notice?: string; onReconcile?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null), cancelRef = useRef<HTMLButtonElement>(null), titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current, previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    dialog?.showModal();
    // Native dialog focusing runs on open, after React's mount-time autoFocus.
    cancelRef.current?.focus({ preventScroll: true });
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <dialog ref={ref} className="studio-workspace studio-model-removal-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id={titleId}>删除模型“{label}”？</h2>
    <p className="studio-removal-identity">{channel} · {model}</p>
    <div id={descriptionId}>
      <p>删除后不能再为新任务选择此模型。历史分析结果和生成文件保留，你的相关默认选择会同步清除。</p>
      {shared && <p>这是共用文本模型，删除后也不能再用于文字创作。</p>}
      <p>如有排队或进行中的任务，请等待完成后再删除。</p>
    </div>
    {error && <p role="alert" className="studio-alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {confirmationBlocked && <p>核对前不能再次删除 读取配置不会重试删除</p>}
    <footer>
      {onReconcile && <button type="button" className="studio-reconcile-removal" aria-label="读取原配置核对" disabled={busy} onClick={onReconcile}><RefreshCw size={14} />{rechecking ? "正在核对…" : "读取原配置核对"}</button>}
      <button ref={cancelRef} type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="studio-confirm-removal" disabled={busy || confirmationBlocked} onClick={onConfirm}><Trash2 size={14} />{rechecking ? "正在核对…" : busy ? "正在删除…" : "确认删除"}</button>
    </footer>
  </dialog>;
}
