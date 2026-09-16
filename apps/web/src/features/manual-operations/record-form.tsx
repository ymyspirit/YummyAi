"use client";

import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, X } from "lucide-react";
import { saveOperation } from "./operation-actions";
import type { Operation, OperationResult } from "./operation-types";

export function RecordDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const close = () => { if (!ref.current?.querySelector("fieldset:disabled")) onClose(); };
  useEffect(() => { setMounted(true); }, []);
  useLayoutEffect(() => {
    if (!mounted) return;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("input:not([type=hidden]),select,textarea")?.focus();
    return () => { dialog?.close(); };
  }, [mounted]);
  if (!mounted) return null;
  return createPortal(<dialog aria-labelledby={titleId} aria-modal="true" className="record-dialog" onCancel={(event) => { event.preventDefault(); close(); }} ref={ref}>
    <header><h2 id={titleId}>{title}</h2><button aria-label={`关闭${title}`} onClick={close} type="button"><X size={18} /></button></header>
    {children}
  </dialog>, document.body);
}

export function RecordForm({ operation, id, build, children, onSaved, submitLabel = "保存", description, onCancel }: {
  operation: Operation; id?: string; build: (form: FormData) => unknown; children: ReactNode;
  onSaved: (record: Record<string, unknown>) => void; submitLabel?: string; description?: string; onCancel: () => void;
}) {
  const [result, setResult] = useState<OperationResult>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const retry = useRef({ body: "", key: "" });
  return <form className="record-form" onSubmit={async (event) => {
    event.preventDefault();
    if (inFlight.current) return;
    const form = new FormData(event.currentTarget);
    try {
      const input = build(form) as Record<string, unknown>;
      if (operation.startsWith("purchase.") || operation.startsWith("supply.") || operation === "movement.create") {
        const signature = JSON.stringify(input);
        if (retry.current.body !== signature) retry.current = { body: signature, key: crypto.randomUUID() };
        input.idempotencyKey = retry.current.key;
      }
      inFlight.current = true; setPending(true); setResult(undefined);
      const saved = await saveOperation(operation, input, id);
      setResult(saved);
      if (saved.ok) onSaved(saved.record ?? {});
    } catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : "保存失败，请重试。" }); }
    finally { inFlight.current = false; setPending(false); }
  }}>
    {description && <p className="record-help">{description}</p>}
    {result && <div className={`record-notice ${result.ok ? "success" : "error"}`} role={result.ok ? "status" : "alert"}>
      {result.message}{result.fieldErrors && <ul>{Object.entries(result.fieldErrors).map(([key, error]) => <li key={key}>{key.startsWith("lines.") ? `第 ${Number(key.split(".")[1]) + 1} 行：` : ""}{error}</li>)}</ul>}
    </div>}
    <fieldset disabled={pending} className="record-fields">{children}</fieldset>
    <footer><button disabled={pending} onClick={onCancel} type="button">取消</button><button className="primary" disabled={pending} type="submit"><Check size={15} />{pending ? "正在保存…" : submitLabel}</button></footer>
  </form>;
}

export function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  const generatedId = useId();
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(children) ? children : null;
  const id = control?.props.id ?? generatedId;
  const helpId = help ? `${id}-help` : undefined;
  return <div className="record-field"><label htmlFor={id}>{label}</label>{control ? cloneElement(control, { id, "aria-describedby": [control.props["aria-describedby"], helpId].filter(Boolean).join(" ") || undefined }) : children}{help && <small id={helpId}>{help}</small>}</div>;
}

export interface Choice { id: string; label: string }
export function RecordSelect({ label, value, onChange, options, onCreate, required = true, emptyLabel = "不指定批次" }: {
  label: string; value: string; onChange: (value: string) => void; options: Choice[]; onCreate?: () => void; required?: boolean; emptyLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = options.filter((option) => option.id === value || option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="record-choice">
    <Field label={label}><select required={required} value={value} onChange={(event) => onChange(event.target.value)}><option value="">{required ? `请选择${label}` : emptyLabel}</option>{filtered.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></Field>
    {options.length > 5 && <input aria-label={`搜索${label}`} placeholder={`搜索${label}`} value={query} onChange={(event) => setQuery(event.target.value)} />}
    {onCreate && <button className="record-link-button" onClick={onCreate} type="button"><Plus size={14} />新增{label}</button>}
    {!options.length && <small className="record-help">暂无{label}，{required ? "请先新增" : "可先留空"}。</small>}
  </div>;
}
