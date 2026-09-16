"use client";

import { useState } from "react";
import type { AssistListingCopy, AssistTemplateSlot } from "@yummyai/contracts/ai/assist";

export type CopyField =
  | "title"
  | "description"
  | "bullets"
  | "tags"
  | "personalizationInstructions"
  | "imageDescriptions";
const copyFields: Array<{ key: CopyField; label: string }> = [
  { key: "title", label: "标题" },
  { key: "description", label: "描述" },
  { key: "bullets", label: "卖点" },
  { key: "tags", label: "标签" },
  { key: "personalizationInstructions", label: "定制说明" },
  { key: "imageDescriptions", label: "图片说明" },
];

export function TemplateSuggestions({
  slots,
  stale,
  onAdopt,
  sourceLabel,
}: {
  slots: AssistTemplateSlot[];
  stale: boolean;
  onAdopt?: (slot: AssistTemplateSlot) => boolean | void;
  sourceLabel: (id: string) => string;
}) {
  const [notice, setNotice] = useState("");
  if (!slots.length) return null;
  return (
    <div className="ai-assist-matches">
      <h4>槽位建议</h4>
      <p>逐项填入下方表单后可以继续修改，最后确认模板版本。</p>
      {slots.map((slot) => (
        <div key={slot.stableKey}>
          <strong>
            {slot.stableKey} · {slot.name}
          </strong>
          <p>
            {{ image: "图片", text: "文字", decoration: "固定装饰", background: "背景" }[slot.kind]}{" "}
            · {slot.replaceable ? `顾客替换 / ${slot.fieldKey}` : "固定内容"} · {slot.fillMode}
          </p>
          <p>{slot.reason}</p>
          {slot.evidence.map((e, i) => (
            <small key={i}>
              依据：{sourceLabel(e.sourceId)} · {e.detail}
            </small>
          ))}
          <button
            type="button"
            disabled={stale || !onAdopt}
            onClick={() => {
              if (onAdopt?.(slot) !== false) setNotice(`已填入 ${slot.stableKey}，请核对表单。`);
            }}
          >
            填入此槽位配置
          </button>
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function ListingSuggestions({
  copy,
  stale,
  onAdopt,
  sourceLabel,
}: {
  copy: AssistListingCopy;
  stale: boolean;
  onAdopt?: (copy: AssistListingCopy, fields: CopyField[]) => boolean | void;
  sourceLabel: (id: string) => string;
}) {
  const [draft, setDraft] = useState(() => structuredClone(copy));
  const [selected, setSelected] = useState<CopyField[]>([]);
  const [notice, setNotice] = useState("");
  return (
    <div className="ai-assist-adoption">
      <h4>核对 SKU 文案</h4>
      <p>
        编辑建议并勾选需要填入的字段。填入后仍需保存新版本和送审；定制说明只适用于已启用定制的
        Listing。
      </p>
      {copyFields
        .filter(
          (f) =>
            !["bullets", "tags", "imageDescriptions"].includes(f.key) ||
            (draft[f.key] as unknown[]).length > 0,
        )
        .map((field) => (
          <div key={field.key}>
            <label className="ai-assist-checkbox">
              <input
                type="checkbox"
                disabled={stale}
                checked={selected.includes(field.key)}
                onChange={(e) =>
                  setSelected((s) =>
                    e.target.checked ? [...s, field.key] : s.filter((k) => k !== field.key),
                  )
                }
              />
              {field.label}
            </label>
            {field.key === "imageDescriptions" ? (
              draft.imageDescriptions.map((item, i) => (
                <label key={item.assetId}>
                  {sourceLabel(item.assetId)}
                  <textarea
                    aria-label={`图片说明 ${i + 1}`}
                    maxLength={500}
                    value={item.text}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        imageDescriptions: d.imageDescriptions.map((x, j) =>
                          j === i ? { ...x, text: e.target.value } : x,
                        ),
                      }))
                    }
                  />
                </label>
              ))
            ) : (
              <textarea
                aria-label={`AI 建议${field.label}`}
                rows={field.key === "description" ? 5 : 2}
                value={
                  Array.isArray(draft[field.key])
                    ? (draft[field.key] as string[]).join("\n")
                    : (draft[field.key] as string)
                }
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    [field.key]:
                      field.key === "bullets" || field.key === "tags"
                        ? e.target.value.split("\n")
                        : e.target.value,
                  }))
                }
              />
            )}
          </div>
        ))}
      {copy.evidence.map((e, i) => (
        <small key={i}>
          依据：{sourceLabel(e.sourceId)} · {e.detail}
        </small>
      ))}
      <button
        type="button"
        disabled={stale || !selected.length || !onAdopt}
        onClick={() => {
          if (onAdopt?.(draft, selected) !== false)
            setNotice("已填入所选字段，请在 Listing 草稿中核对并保存。");
        }}
      >
        填入所选字段
      </button>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
