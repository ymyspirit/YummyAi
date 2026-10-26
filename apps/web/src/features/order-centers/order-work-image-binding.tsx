"use client";

import type { CustomizationField } from "@yummyai/contracts";
import { orderImageBindingField } from "./order-work-input-model";
import "./order-work-image-binding.css";

export function OrderWorkImageBinding({ fields, usage, disabled, onChange }: {
  fields: readonly CustomizationField[];
  usage: string | undefined;
  disabled: boolean;
  onChange: (usage: string) => void;
}) {
  const images = fields.filter(field => field.type === "image");
  const bound = orderImageBindingField(fields, usage ?? "");
  return <div className="oc-work-image-binding" hidden={usage === undefined}>
    {images.length ? <>
      <label>对应图片字段
        <select aria-label="对应图片字段" disabled={disabled || usage === undefined}
          value={bound?.key ?? usage ?? ""} onChange={event => onChange(event.target.value)}>
          {!bound && <option value={usage ?? ""}>{usage ? `待匹配 · 原用途：${usage}` : "请选择这张图片对应的字段"}</option>}
          {images.map(field => <option key={field.key} value={field.key}>{field.label}{field.required ? "（必填）" : ""}</option>)}
        </select>
      </label>
      <small className={bound ? "oc-hint" : "oc-error"} role="status">
        {bound ? `已绑定 ${bound.label}` : "已选此图，尚未绑定图片字段；请明确选择，原用途不会自动改写。"}
      </small>
    </> : <label>制作用途
      <input disabled={disabled || usage === undefined} value={usage ?? ""} placeholder="说明这张图的制作用途"
        onChange={event => onChange(event.target.value)} />
      <small className="oc-hint">本单未提供图片字段，保留通用用途填写方式。</small>
    </label>}
  </div>;
}
