"use client";
import { useEffect, useRef, useState } from "react";
import { ManufacturingRecipeVersionViewSchema, ManufacturingVersionListSchema, type ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import { ManufacturingContextChanged, ManufacturingRequestError, manufacturingRequest } from "./manufacturing-api";
import { quantityText, responsibilityLabels, unitLabels } from "./manufacturing-model";
import type { z } from "zod";
import { manufacturingTransition } from "./manufacturing-transition";
type Rows = z.infer<typeof ManufacturingVersionListSchema>;
export function ManufacturingVersionSummary({ version }: { version: ManufacturingRecipeVersionView }) {
  return <div className="mf-version-summary">
    <p>V{version.versionNumber} · {version.content.name} · 固定规格{version.specificationVersionNumber ? ` V${version.specificationVersionNumber}` : "历史版本"}</p>
    <p>以下用量对应产出 {version.content.outputQuantity} {unitLabels[version.content.outputUnit]}</p>
    <h3>原材料记录</h3><ul>{version.content.materials.map(row => <li key={row.code}><strong>{row.code} {row.name}</strong>
      <span>净用量 {quantityText(row.quantityNumerator, row.quantityDenominator) || "待确认"} {row.unit ? unitLabels[row.unit] : "单位待确认"} · {responsibilityLabels[row.responsibility]}供料</span>
      <span>损耗 {row.lossBps === null ? "待确认" : quantityText(row.lossBps, 100) + "%"} · {row.lossBasis === "add_to_net" ? "净耗量额外增加" : row.lossBasis === "fraction_of_input" ? "占总投入量" : "口径待确认"}</span>
      {row.notes && <span>{row.notes}</span>}</li>)}</ul>
    <h3>原工序记录</h3><ol>{version.content.operations.map(row => <li key={row.code}><strong>{row.code} {row.name}</strong><span>{row.processCode} · {responsibilityLabels[row.responsibility]}执行</span>{row.notes && <span>{row.notes}</span>}</li>)}</ol>
    {version.review && <p>{version.review.decision === "approved" ? "已批准" : "已驳回"} · {new Date(version.review.reviewedAt).toLocaleString("zh-CN")} · {version.review.note}</p>}
    {version.content.notes && <p>{version.content.notes}</p>}
  </div>;
}
export function ManufacturingHistory({ recipeId, authority, localDevelopment, refresh, onAccessChanged }: {
  recipeId: string; authority: string; localDevelopment: boolean; refresh: number; onAccessChanged: () => void;
}) {
  const [open, setOpen] = useState(false), [before, setBefore] = useState<number | null>(null), [data, setData] = useState<Rows | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null), [version, setVersion] = useState<ManufacturingRecipeVersionView | null>(null);
  const [error, setError] = useState(""), [reading, setReading] = useState(false), [retry, setRetry] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    if (!open) return;
    const request = ++latest.current, abort = new AbortController(); setReading(true); setError("");
    const query = new URLSearchParams({ limit: "10" }); if (before) query.set("before", String(before));
    void (async () => {
      const rows = await manufacturingRequest(`/${recipeId}/history?${query}`, ManufacturingVersionListSchema, authority, localDevelopment, { signal: abort.signal });
      const detail = versionId ? await manufacturingRequest(`/${recipeId}/versions/${versionId}`, ManufacturingRecipeVersionViewSchema, authority, localDevelopment, { signal: abort.signal }) : null;
      if (!abort.signal.aborted && request === latest.current) { setData(rows); setVersion(detail); }
    })().catch(cause => {
      if (abort.signal.aborted || request !== latest.current) return;
      if (cause instanceof ManufacturingContextChanged || cause instanceof ManufacturingRequestError && [401, 403, 404].includes(cause.status ?? 0)) { onAccessChanged(); return; }
      setError(cause instanceof Error ? cause.message : "历史版本暂时无法读取");
    }).finally(() => { if (!abort.signal.aborted && request === latest.current) setReading(false); });
    return () => abort.abort();
  }, [authority, before, localDevelopment, onAccessChanged, open, recipeId, refresh, retry, versionId]);
  return <section className="mf-section"><button type="button" className="oc-button" aria-expanded={open} onClick={() => manufacturingTransition(() => setOpen(value => !value))}>版本历史</button>
    {open && <div className="mf-history" aria-label="制造版本历史">
      {reading && <p role="status">正在读取原版本</p>}
      {error && <p role="alert" className="mf-error">{error} <button type="button" className="oc-button" onClick={() => setRetry(n => n + 1)}>重试版本读取</button></p>}
      {!error && <><ul>{data?.items.map(row => <li key={row.id}><button type="button" className="oc-button" aria-pressed={row.id === versionId} disabled={reading} onClick={() => setVersionId(row.id)}>
        V{row.versionNumber} {row.name} · {row.decision === "approved" ? "已批准" : row.decision === "rejected" ? "已驳回" : "未审核"}</button></li>)}</ul>
        <div className="mf-actions">{before && <button type="button" className="oc-button" disabled={reading} onClick={() => setBefore(null)}>回到最新版本</button>}
          {data?.nextVersion && <button type="button" className="oc-button" disabled={reading} onClick={() => setBefore(data.nextVersion)}>更早版本</button>}</div>
        {version && !reading && <div className="mf-history-detail" aria-label={`历史制造版本V${version.versionNumber}`}><p className="mf-notice">原版本只读 依据与结论保留</p><ManufacturingVersionSummary version={version} /></div>}
      </>}
    </div>}
  </section>;
}
