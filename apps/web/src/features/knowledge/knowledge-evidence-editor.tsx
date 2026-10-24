"use client";
import { useEffect, useState } from "react";
import type { KnowledgeFields } from "@yummyai/contracts/knowledge";
import {
  KnowledgeGovernanceViewSchema,
  type KnowledgeGovernanceView,
} from "@yummyai/contracts/knowledge/governance";
import { governanceApi } from "./knowledge-api";
export function KnowledgeEvidenceEditor({
  fields,
  onChange,
}: {
  fields: KnowledgeFields;
  onChange: (fields: KnowledgeFields) => void;
}) {
  const [data, setData] = useState<KnowledgeGovernanceView | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    governanceApi("workspace", undefined, controller.signal)
      .then((v) => setData(KnowledgeGovernanceViewSchema.parse(v)))
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "证据列表读取失败");
      });
    return () => controller.abort();
  }, []);
  const toggle = (key: "documentIds" | "sourceSnapshotIds", id: string, checked: boolean) =>
    onChange({
      ...fields,
      [key]: checked
        ? [...new Set([...(fields[key] ?? []), id])]
        : (fields[key] ?? []).filter((v) => v !== id),
    });
  const claims = fields.claims ?? [];
  const changeClaim = (index: number, value: Partial<(typeof claims)[number]>) =>
    onChange({ ...fields, claims: claims.map((c, i) => (i === index ? { ...c, ...value } : c)) });
  return (
    <details className="kb-evidence-editor">
      <summary>来源证据与关键主张</summary>
      <div className="kb-form">
        {error && (
          <p role="alert" className="kb-error">
            {error}
          </p>
        )}
        <fieldset className="kb-choices">
          <legend>关联已确认的参考资料</legend>
          {data?.documents
            .filter((d) => d.kind === "reference" && d.state === "confirmed")
            .map((d) => (
              <label key={d.id}>
                <input
                  type="checkbox"
                  checked={fields.documentIds?.includes(d.id) ?? false}
                  onChange={(e) => toggle("documentIds", d.id, e.target.checked)}
                />
                {d.fileName} · 复查 {d.fields.reviewDueOn}
              </label>
            ))}
          {fields.documentIds
            ?.filter((id) => !data?.documents.some((d) => d.id === id))
            .map((id) => (
              <label key={id}>
                <input type="checkbox" checked onChange={() => toggle("documentIds", id, false)} />
                关联资料 {id}（可能已归档）
              </label>
            ))}
        </fieldset>
        <fieldset className="kb-choices">
          <legend>关联官方来源快照</legend>
          {data?.sources
            .filter((s) => s.latestSnapshotId)
            .map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={fields.sourceSnapshotIds?.includes(s.latestSnapshotId!) ?? false}
                  onChange={(e) =>
                    toggle("sourceSnapshotIds", s.latestSnapshotId!, e.target.checked)
                  }
                />
                {s.label} · 最新成功检查 {s.lastSuccessAt?.slice(0, 10)}
              </label>
            ))}
          {fields.sourceSnapshotIds
            ?.filter((id) => !data?.sources.some((s) => s.latestSnapshotId === id))
            .map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked
                  onChange={() => toggle("sourceSnapshotIds", id, false)}
                />
                固定历史证据 {id}
              </label>
            ))}
        </fieldset>
        <p className="kb-meta">
          登记需要核对的关键主张。相同主张编号、重叠范围与有效期出现不同值时进入冲突风险；正文仍需人工审阅。
        </p>
        {claims.map((c, i) => (
          <fieldset key={i} className="kb-form">
            <legend>主张 {i + 1}</legend>
            <div className="kb-form-grid">
              <label>
                主张编号
                <input
                  required
                  maxLength={120}
                  value={c.key}
                  placeholder="例如 amazon.main_image.background"
                  onChange={(e) => changeClaim(i, { key: e.target.value })}
                />
              </label>
              <label>
                主张值
                <input
                  required
                  maxLength={500}
                  value={c.value}
                  onChange={(e) => changeClaim(i, { value: e.target.value })}
                />
              </label>
              <label>
                单位
                <input
                  maxLength={40}
                  value={c.unit}
                  onChange={(e) => changeClaim(i, { unit: e.target.value })}
                />
              </label>
              <label>
                风险级别
                <select
                  value={c.severity}
                  onChange={(e) =>
                    changeClaim(i, { severity: e.target.value as typeof c.severity })
                  }
                >
                  <option value="warning">需核对</option>
                  <option value="blocking">阻断新发布与检索</option>
                </select>
              </label>
              <label>
                有效开始
                <input
                  type="date"
                  required
                  value={c.validFrom}
                  onChange={(e) => changeClaim(i, { validFrom: e.target.value })}
                />
              </label>
              <label>
                有效结束
                <input
                  type="date"
                  required
                  value={c.validUntil}
                  onChange={(e) => changeClaim(i, { validUntil: e.target.value })}
                />
              </label>
            </div>
            <label>
              适用条件
              <textarea
                rows={2}
                maxLength={500}
                value={c.condition}
                onChange={(e) => changeClaim(i, { condition: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="oc-button"
              onClick={() => onChange({ ...fields, claims: claims.filter((_, n) => n !== i) })}
            >
              移除此主张
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="oc-button"
          disabled={claims.length >= 20}
          onClick={() =>
            onChange({
              ...fields,
              claims: [
                ...claims,
                {
                  key: "",
                  value: "",
                  unit: "",
                  condition: "",
                  validFrom: fields.verifiedOn,
                  validUntil: fields.reviewDueOn,
                  severity: "warning",
                },
              ],
            })
          }
        >
          添加关键主张
        </button>
      </div>
    </details>
  );
}
