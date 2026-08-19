"use client";

import type { CreateCreativeDesignBatchInput } from "@yummyai/contracts/pod/batch-workflows";
import { AlertTriangle, Check, ChevronRight, FileSpreadsheet, Plus, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import {
  bindCreativeSkus,
  cancelDesignBatch,
  createPrintSpec,
  createDesignBatch,
  retryCreativeItem,
  reviewCreativeVersion,
  reviewPrintSpec,
  selectCreativeCandidates,
  type PodBatchActionState,
} from "./pod-batch-actions";
import { parseCanvasBatchCsv } from "./canvas-batch-csv";
import type { BatchCapabilities, CreativeBatch, CreativeVersion, DesignOptions } from "./pod-batch-types";

const idle: PodBatchActionState = { status: "idle", message: "" };
type DraftItem = CreateCreativeDesignBatchInput["items"][number];

export function BatchDesignWorkbench({
  capabilities,
  options,
  batches,
  batch,
  assetUrls,
  error,
}: {
  capabilities?: BatchCapabilities;
  options?: DesignOptions;
  batches: CreativeBatch[];
  batch?: CreativeBatch;
  assetUrls: Record<string, string>;
  error?: string;
}) {
  const feature = capabilities?.batchDesign;
  return (
    <div className="pod-batch-workbench">
      <header className="pod-batch-header">
        <div>
          <p className="kicker">CREATIVE DESIGN STUDIO</p>
          <h1>画图设计</h1>
          <p>在独立创意空间完成批量生成、候选多选、画幅适配与整套审核；批准后再按需交接给 SKU 和套图生产。</p>
        </div>
        <nav aria-label="生产交接" className="creative-production-bridge">
          <Link href="/pod-workbench/mockup-batches">正式设计交接 <ChevronRight size={14} /> 批量套图</Link>
        </nav>
      </header>

      <section className="pod-batch-boundary">
        <span><ShieldCheck size={16} /><b>授权素材</b>研究、竞品和订单私有图直接阻断</span>
        <span><Sparkles size={16} /><b>候选独立</b>同一需求可批准多个创意设计族</span>
        <span><Check size={16} /><b>整套审核</b>母版与全部必需画幅一次批准</span>
      </section>

      {error ? <p className="pod-batch-alert error"><AlertTriangle size={15} />{error}</p> : null}
      {feature && !feature.enabled ? (
        <div className="pod-batch-alert warning"><AlertTriangle size={15} /><span><b>入口暂未启用</b>{feature.blockers.join("；")}</span></div>
      ) : null}

      <PrintSpecConsole options={options} />
      <BatchEditor disabled={!feature?.enabled} options={options} />

      <div className="pod-batch-layout">
        <BatchLedger activeId={batch?.id} batches={batches} />
        <BatchDetail assetUrls={assetUrls} batch={batch} options={options} />
      </div>
    </div>
  );
}

function PrintSpecConsole({ options }: { options?: DesignOptions }) {
  const [state, action, pending] = useActionState(createPrintSpec, idle);
  const [name, setName] = useState("帆布画 4:3");
  const [aspectWidth, setAspectWidth] = useState(4);
  const [aspectHeight, setAspectHeight] = useState(3);
  const [widthMm, setWidthMm] = useState(400);
  const [heightMm, setHeightMm] = useState(300);
  const payload = JSON.stringify({
    name, aspectWidth, aspectHeight, targetDpi: 300, bleedMm: 30, safeZoneMm: 15, wrapMode: "extend",
    physicalSizes: [{ key: `${widthMm}x${heightMm}`, label: `${widthMm} × ${heightMm} mm`, widthMm, heightMm }],
  });
  return (
    <details className="pod-template-console">
      <summary><span><ShieldCheck size={15} />印刷规格版本</span><small>规格先审核，再进入创意与模板兼容矩阵</small></summary>
      <div className="pod-template-columns pod-print-spec-columns">
        <form action={action}>
          <input name="payload" type="hidden" value={payload} />
          <h3>创建规格草稿</h3>
          <label>规格名称<input maxLength={160} onChange={(event) => setName(event.target.value)} value={name} /></label>
          <div className="pod-field-pair"><label>画幅宽比<input min="1" max="100" onChange={(event) => setAspectWidth(Number(event.target.value))} type="number" value={aspectWidth} /></label><label>画幅高比<input min="1" max="100" onChange={(event) => setAspectHeight(Number(event.target.value))} type="number" value={aspectHeight} /></label></div>
          <div className="pod-field-pair"><label>成品宽 mm<input min="1" max="10000" onChange={(event) => setWidthMm(Number(event.target.value))} type="number" value={widthMm} /></label><label>成品高 mm<input min="1" max="10000" onChange={(event) => setHeightMm(Number(event.target.value))} type="number" value={heightMm} /></label></div>
          <button disabled={pending || !name || !aspectWidth || !aspectHeight || !widthMm || !heightMm} type="submit">创建不可覆盖的新版本</button>
          <ActionNotice state={state} />
        </form>
        <div className="pod-template-ledger">
          <h3>规格审核</h3>
          {options?.printSpecVersions.length ? options.printSpecVersions.map((spec) => <PrintSpecReview key={spec.id} spec={spec} />) : <p>尚无印刷规格。</p>}
        </div>
      </div>
    </details>
  );
}

function PrintSpecReview({ spec }: { spec: DesignOptions["printSpecVersions"][number] }) {
  const [state, action, pending] = useActionState(reviewPrintSpec, idle);
  return (
    <form action={action} className="pod-template-review pod-version-review">
      <input name="versionId" type="hidden" value={spec.id} />
      <span><b>{spec.name} v{spec.versionNumber}</b><small>{spec.aspectWidth}:{spec.aspectHeight} · {spec.targetDpi ?? 300} DPI · {statusLabel(spec.status)}</small></span>
      {spec.status === "draft" ? <><input name="rejectionReason" placeholder="驳回原因" /><button disabled={pending} name="decision" value="reject">驳回</button><button className="primary" disabled={pending} name="decision" value="approve">批准</button></> : null}
      {spec.rejectionReason ? <em>{spec.rejectionReason}</em> : null}
      <ActionNotice state={state} />
    </form>
  );
}

function BatchEditor({ disabled, options }: { disabled: boolean; options?: DesignOptions }) {
  const [state, action, pending] = useActionState(createDesignBatch, idle);
  const [batchName, setBatchName] = useState("帆布画创意批次");
  const [items, setItems] = useState<DraftItem[]>([blankItem(1, options?.printSpecs[0]?.id)]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const payload = useMemo(() => JSON.stringify({ name: batchName, items }), [batchName, items]);
  function update(index: number, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }
  async function importCsv(file?: File) {
    if (!file) return;
    const result = parseCanvasBatchCsv(await file.text());
    setDiagnostics(result.diagnostics);
    if (!result.diagnostics.length) setItems(result.items);
  }
  return (
    <details className="pod-batch-compose" open={!items.length || !disabled}>
      <summary><span><Plus size={15} />新建批量设计</span><small>表格录入 / 本地 CSV · 最多 50 条</small></summary>
      <form action={action}>
        <input name="payload" type="hidden" value={payload} />
        <div className="pod-batch-compose-bar">
          <label>批次名称<input maxLength={160} onChange={(event) => setBatchName(event.target.value)} value={batchName} /></label>
          <label className="pod-csv-picker"><FileSpreadsheet size={15} />本地解析 CSV<input accept=".csv,text/csv" onChange={(event) => void importCsv(event.target.files?.[0])} type="file" /></label>
          <button disabled={items.length >= 50} onClick={() => setItems((current) => [...current, blankItem(current.length + 1, options?.printSpecs[0]?.id)])} type="button"><Plus size={14} />添加需求</button>
          <b>{items.length}/50</b>
        </div>
        {diagnostics.length ? <ul className="pod-csv-diagnostics">{diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}</ul> : null}
        <div className="pod-design-entry-table" role="table" aria-label="批量设计需求">
          <div className="pod-entry-head" role="row"><span>行键 / 名称</span><span>提示词</span><span>参考图</span><span>候选</span><span>目标画幅</span><span /></div>
          {items.map((item, index) => (
            <div className="pod-entry-row" key={`${item.rowKey}-${index}`} role="row">
              <div><input aria-label={`第 ${index + 1} 行键`} onChange={(event) => update(index, { rowKey: event.target.value })} value={item.rowKey} /><input aria-label={`第 ${index + 1} 名称`} onChange={(event) => update(index, { name: event.target.value })} value={item.name} /></div>
              <div><textarea aria-label={`第 ${index + 1} 提示词`} onChange={(event) => update(index, { prompt: event.target.value })} rows={2} value={item.prompt} /><input aria-label={`第 ${index + 1} 负面提示词`} onChange={(event) => update(index, { negativePrompt: event.target.value || undefined })} placeholder="负面提示词（可选）" value={item.negativePrompt ?? ""} /></div>
              <select aria-label={`第 ${index + 1} 参考图`} multiple onChange={(event) => update(index, { referenceAssetIds: selectedValues(event.currentTarget) })} value={item.referenceAssetIds}>
                {options?.referenceAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.fileName}</option>)}
              </select>
              <select aria-label={`第 ${index + 1} 候选数量`} onChange={(event) => update(index, { candidateCount: Number(event.target.value) })} value={item.candidateCount}>{[1, 2, 3, 4].map((count) => <option key={count}>{count}</option>)}</select>
              <select aria-label={`第 ${index + 1} 印刷规格`} multiple onChange={(event) => update(index, { printSpecVersionIds: selectedValues(event.currentTarget) })} value={item.printSpecVersionIds}>
                {options?.printSpecs.map((spec) => <option key={spec.id} value={spec.id}>{spec.name} · {spec.aspectWidth}:{spec.aspectHeight}</option>)}
              </select>
              <button aria-label={`删除第 ${index + 1} 行`} disabled={items.length === 1} onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button"><X size={14} /></button>
            </div>
          ))}
        </div>
        <footer>
          <span>CSV 固定列：row_key, name, prompt, negative_prompt, reference_asset_ids, candidate_count, print_spec_version_ids</span>
          <button disabled={disabled || pending || !items.length} type="submit">{pending ? "提交中…" : "锁定输入并提交"}</button>
        </footer>
        <ActionNotice state={state} />
      </form>
    </details>
  );
}

function BatchLedger({ activeId, batches }: { activeId?: string; batches: CreativeBatch[] }) {
  return (
    <aside className="pod-batch-ledger">
      <header><span>BATCH LEDGER</span><b>{batches.length}</b></header>
      {batches.length ? batches.map((entry) => (
        <Link className={entry.id === activeId ? "active" : ""} href={`/creative-designs?batch=${entry.id}`} key={entry.id}>
          <span>{statusLabel(entry.status)}</span><strong>{entry.name}</strong><small>{entry.generatedCount} 候选已生成 · {entry.itemCount} 条需求 · {new Date(entry.createdAt).toLocaleDateString("zh-CN")}</small>
        </Link>
      )) : <p>尚无批量设计。</p>}
    </aside>
  );
}

function BatchDetail({ batch, assetUrls, options }: { batch?: CreativeBatch; assetUrls: Record<string, string>; options?: DesignOptions }) {
  const [selectionState, selectionAction, selecting] = useActionState(selectCreativeCandidates, idle);
  if (!batch?.items) return <section className="pod-batch-empty"><Sparkles size={24} /><h2>建立第一批创意需求</h2><p>先创建印刷规格，再用表格或 CSV 提交 1–50 条需求。</p></section>;
  return (
    <section className="pod-design-batch-detail">
      <header>
        <div><p>IMMUTABLE INPUT · {batch.id.slice(0, 8)}</p><h2>{batch.name}</h2></div>
        <div><span>{statusLabel(batch.status)}</span><b>{batch.generatedCount} 已生成</b><b>{batch.failedCount} 失败款</b></div>
      </header>
      <form action={selectionAction} className="pod-candidate-selection">
        <input name="batchId" type="hidden" value={batch.id} />
        {batch.items.map((item) => (
          <article className="pod-creative-row" key={item.id}>
            <header><div><code>{item.rowKey}</code><h3>{item.name}</h3><p>{item.prompt}</p></div><span>{statusLabel(item.status)}</span></header>
            <div className="pod-candidate-filmstrip">
              {item.candidates.map((candidate) => (
                <label className={`pod-candidate-frame ${candidate.status}`} key={candidate.id}>
                  <div>{candidate.assetId && assetUrls[candidate.assetId] ? <img alt={`${item.name} 候选 ${candidate.ordinal + 1}`} src={assetUrls[candidate.assetId]} /> : <span>{candidate.status === "failed" ? <AlertTriangle size={20} /> : <Sparkles size={20} />}</span>}</div>
                  <input disabled={candidate.status !== "generated"} name="candidateId" type="checkbox" value={candidate.id} />
                  <b>候选 {candidate.ordinal + 1}</b><small>{candidate.modelKey ?? statusLabel(candidate.status)}</small>
                  {candidate.errorMessage ? <em>{candidate.errorMessage}</em> : null}
                </label>
              ))}
            </div>
            {item.status === "failed" || item.status === "partially_succeeded" ? <RetryCreativeForm batchId={batch.id} itemId={item.id} /> : null}
            {item.creativeVersions.map((version) => <CreativeVersionPanel assetUrls={assetUrls} key={version.id} options={options} version={version} />)}
          </article>
        ))}
        <footer><ActionNotice state={selectionState} /><button disabled={selecting} type="submit">{selecting ? "适配排队中…" : "将所选候选创建为独立创意族"}</button></footer>
      </form>
      {!(["completed", "cancelled"].includes(batch.status)) ? <CancelDesignForm batchId={batch.id} /> : null}
    </section>
  );
}

function CreativeVersionPanel({ version, assetUrls, options }: { version: CreativeVersion; assetUrls: Record<string, string>; options?: DesignOptions }) {
  const [reviewState, reviewAction, reviewing] = useActionState(reviewCreativeVersion, idle);
  const [bindState, bindAction, binding] = useActionState(bindCreativeSkus, idle);
  const variants = version.assets.filter((asset) => asset.role === "aspect_variant");
  return (
    <section className="pod-aspect-review">
      <header><div><span>CREATIVE FAMILY</span><b>{version.id.slice(0, 8)}</b></div><strong>{statusLabel(version.status)}</strong></header>
      <div className="pod-aspect-strip">
        {version.assets.map((asset) => (
          <figure className={asset.adaptationMode === "ai_outpaint" ? "ai" : ""} key={asset.id}>
            {assetUrls[asset.assetId] ? <img alt={asset.role === "master" ? "创意母版" : "画幅适配"} src={assetUrls[asset.assetId]} /> : <div />}
            <figcaption><b>{asset.role === "master" ? "母版" : options?.printSpecs.find((spec) => spec.id === asset.printSpecVersionId)?.name ?? "画幅"}</b><span>{asset.adaptationMode === "ai_outpaint" ? "AI 扩图 · 必须人工确认" : asset.adaptationMode === "crop" ? "确定性裁切" : "原始"}</span></figcaption>
          </figure>
        ))}
      </div>
      {version.status === "pending_review" ? (
        <form action={reviewAction} className="pod-review-bar">
          <input name="versionId" type="hidden" value={version.id} />
          <input name="rejectionReason" placeholder="驳回原因（驳回时必填）" />
          <button disabled={reviewing} name="decision" value="reject">驳回整套</button>
          <button className="primary" disabled={reviewing || !variants.length} name="decision" value="approve">批准母版与全部画幅</button>
          <ActionNotice state={reviewState} />
        </form>
      ) : null}
      {version.status === "approved" ? (
        <form action={bindAction} className="pod-sku-binding">
          <input name="versionId" type="hidden" value={version.id} />
          <div><b>提升为正式设计</b><span>规格兼容检查整批通过后才会创建记录</span></div>
          <select name="printSpecVersionId" required>{variants.map((asset) => <option key={asset.id} value={asset.printSpecVersionId}>{options?.printSpecs.find((spec) => spec.id === asset.printSpecVersionId)?.name ?? asset.printSpecVersionId}</option>)}</select>
          <div className="pod-sku-checks">{options?.skus.map((sku) => <label key={sku.id}><input name="skuId" type="checkbox" value={sku.id} />{sku.code}</label>)}</div>
          <button disabled={binding} type="submit">绑定所选 SKU</button>
          <ActionNotice state={bindState} />
        </form>
      ) : null}
    </section>
  );
}

function RetryCreativeForm({ batchId, itemId }: { batchId: string; itemId: string }) {
  const [state, action, pending] = useActionState(retryCreativeItem, idle);
  return <form action={action} className="pod-inline-action"><input name="batchId" type="hidden" value={batchId} /><input name="itemId" type="hidden" value={itemId} /><button disabled={pending}><RefreshCw size={13} />只重试失败候选</button><ActionNotice state={state} /></form>;
}

function CancelDesignForm({ batchId }: { batchId: string }) {
  const [state, action, pending] = useActionState(cancelDesignBatch, idle);
  return <form action={action} className="pod-cancel-action"><input name="batchId" type="hidden" value={batchId} /><button disabled={pending}>取消未完成任务</button><ActionNotice state={state} /></form>;
}

function ActionNotice({ state }: { state: PodBatchActionState }) {
  return state.status === "idle" ? null : <p className={`pod-action-notice ${state.status}`}>{state.message}</p>;
}

function blankItem(index: number, printSpecVersionId?: string): DraftItem {
  return { rowKey: `row-${index}`, name: `创意需求 ${index}`, prompt: "", referenceAssetIds: [], candidateCount: 2, printSpecVersionIds: printSpecVersionId ? [printSpecVersionId] : [], focalPoint: { xPermille: 500, yPermille: 500 } };
}

function selectedValues(select: HTMLSelectElement) { return Array.from(select.selectedOptions, (option) => option.value); }
function statusLabel(status: string) { return ({ queued: "排队", running: "处理中", generated: "已生成", selected: "已选择", adapting: "适配中", pending_review: "待审核", awaiting_review: "待审核", partially_succeeded: "部分成功", completed: "已完成", approved: "已批准", rejected: "已驳回", failed: "失败", cancelled: "已取消" } as Record<string, string>)[status] ?? status; }
