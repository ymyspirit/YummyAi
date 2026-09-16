"use client";
import { useState } from "react";
import Image from "next/image";
import type { CustomizationDefinition } from "@yummyai/contracts";
import type { ArtworkLayout } from "@yummyai/contracts/catalog/artwork";

type Field = CustomizationDefinition["fields"][number];
export function ArtworkFieldsEditor({
  value,
  layout,
  onChange,
  disabled = false,
  previewPath,
}: {
  value: CustomizationDefinition;
  layout: ArtworkLayout;
  onChange: (value: CustomizationDefinition, layout: ArtworkLayout) => void;
  disabled?: boolean;
  previewPath?: string;
}) {
  const [samples, setSamples] = useState<Record<string, string>>({});
  function update(index: number, field: Field) {
    onChange({ ...value, fields: value.fields.map((f, i) => (i === index ? field : f)) }, layout);
  }
  function add(type: "short_text" | "image") {
    let n = value.fields.length + 1;
    while (value.fields.some((f) => f.key === `${type === "image" ? "photo" : "text"}_${n}`)) n++;
    const key = `${type === "image" ? "photo" : "text"}_${n}`;
    const field: Field =
      type === "image"
        ? {
            key,
            label: `定制图片 ${n}`,
            type,
            required: true,
            validation: {
              allowedMediaTypes: ["image/png", "image/jpeg", "image/webp"],
              maxFiles: 1,
              maxBytes: 32 * 1024 * 1024,
            },
          }
        : { key, label: `定制文字 ${n}`, type, required: true, validation: { maxLength: 100 } };
    onChange({ ...value, fields: [...value.fields, field] }, [
      ...layout,
      {
        fieldKey: key,
        xPercent: 10,
        yPercent: type === "image" ? 10 : 75,
        widthPercent: 80,
        heightPercent: type === "image" ? 60 : 15,
        color: "#111111",
      },
    ]);
  }
  return (
    <section className="art-customization" aria-label="定制字段与排版">
      <p className="canvas-help">
        定义买家能修改的内容及其版面区域。区域位置按成品版面的百分比保存，每个规格仍须审核实际效果。
      </p>
      {value.fields.map((field, index) => {
        const p = layout.find((p) => p.fieldKey === field.key);
        return (
          <fieldset key={field.key} disabled={disabled} className="art-field-row">
            <div className="art-field-header">
              <label>
                字段名称
                <input
                  value={field.label}
                  maxLength={120}
                  onChange={(e) => update(index, { ...field, label: e.target.value })}
                />
              </label>
              <span>
                {field.type === "image" ? "图片" : "文字 / 选项"} · {field.key}
              </span>
              <label className="canvas-check">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(e) => update(index, { ...field, required: e.target.checked })}
                />
                必填
              </label>
              <button
                type="button"
                onClick={() =>
                  onChange(
                    { ...value, fields: value.fields.filter((_, i) => i !== index) },
                    layout.filter((l) => l.fieldKey !== field.key),
                  )
                }
              >
                移除字段
              </button>
            </div>
            <label>
              填写说明
              <input
                value={field.helpText ?? ""}
                maxLength={500}
                onChange={(e) => update(index, { ...field, helpText: e.target.value })}
              />
            </label>
            {(field.type === "short_text" || field.type === "long_text") && (
              <label>
                最多字符
                <input
                  aria-label={`${field.label} 最多字符`}
                  type="number"
                  min={1}
                  max={500}
                  value={field.validation?.maxLength ?? 100}
                  onChange={(e) =>
                    update(index, {
                      ...field,
                      validation: { ...field.validation, maxLength: Number(e.target.value) },
                    })
                  }
                />
              </label>
            )}
            {p ? (
              <div className="art-placement">
                {(
                  [
                    ["xPercent", "左侧位置"],
                    ["yPercent", "顶部位置"],
                    ["widthPercent", "区域宽度"],
                    ["heightPercent", "区域高度"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label} %
                    <input
                      aria-label={`${field.label} ${label}`}
                      type="number"
                      min={0}
                      max={100}
                      value={p[key]}
                      onChange={(e) =>
                        onChange(
                          value,
                          layout.map((l) =>
                            l.fieldKey === field.key ? { ...l, [key]: Number(e.target.value) } : l,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                {field.type !== "image" && (
                  <label>
                    文字颜色
                    <input
                      type="color"
                      value={p.color}
                      onChange={(e) =>
                        onChange(
                          value,
                          layout.map((l) =>
                            l.fieldKey === field.key ? { ...l, color: e.target.value } : l,
                          ),
                        )
                      }
                    />
                  </label>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() =>
                  onChange(value, [
                    ...layout,
                    {
                      fieldKey: field.key,
                      xPercent: 10,
                      yPercent: 10,
                      widthPercent: 80,
                      heightPercent: 30,
                      color: "#111111",
                    },
                  ])
                }
              >
                配置排版区域
              </button>
            )}
          </fieldset>
        );
      })}
      {!disabled && (
        <div className="canvas-actions">
          <button
            type="button"
            disabled={value.fields.length >= 30}
            onClick={() => add("short_text")}
          >
            添加文字字段
          </button>
          <button type="button" disabled={value.fields.length >= 30} onClick={() => add("image")}>
            添加图片字段
          </button>
        </div>
      )}
      {!!value.fields.length && (
        <details className="art-preview">
          <summary>试填与布局预览</summary>
          <p className="canvas-help">
            使用示例内容检查区域布局。此处是布局示意，正式字体、清晰度和工艺在订单生产稿中审核。
          </p>
          <div className="art-preview-grid">
            <div>
              {value.fields.map((f) => (
                <label key={f.key}>
                  {f.label}
                  {f.type === "image" ? (
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file || file.size > 20 * 1024 * 1024) return;
                        const reader = new FileReader();
                        reader.onload = () =>
                          setSamples((v) => ({ ...v, [f.key]: String(reader.result) }));
                        reader.readAsDataURL(file);
                      }}
                    />
                  ) : (
                    <input
                      value={samples[f.key] ?? ""}
                      maxLength={
                        f.type === "short_text" || f.type === "long_text"
                          ? f.validation?.maxLength
                          : 500
                      }
                      onChange={(e) => setSamples((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  )}
                </label>
              ))}
            </div>
            <div className="art-preview-sheet" aria-label="定制版面预览">
              {previewPath && (
                <Image
                  src={previewPath}
                  alt="印花母版"
                  fill
                  unoptimized
                  style={{ objectFit: "contain" }}
                />
              )}
              {layout.map((p) => {
                const f = value.fields.find((f) => f.key === p.fieldKey);
                return (
                  <div
                    key={p.fieldKey}
                    className="art-preview-slot"
                    style={{
                      left: `${p.xPercent}%`,
                      top: `${p.yPercent}%`,
                      width: `${p.widthPercent}%`,
                      height: `${p.heightPercent}%`,
                      color: p.color,
                    }}
                  >
                    {f?.type === "image" && samples[p.fieldKey] ? (
                      <Image
                        src={samples[p.fieldKey]!}
                        alt={f.label}
                        fill
                        unoptimized
                        style={{ objectFit: "contain" }}
                      />
                    ) : (
                      samples[p.fieldKey] || f?.label
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </details>
      )}
    </section>
  );
}
