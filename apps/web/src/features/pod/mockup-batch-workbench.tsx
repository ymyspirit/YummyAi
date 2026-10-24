"use client";

import "./mockup-review.css";

import { AlertTriangle, Check, ChevronLeft, FileImage, Grid3X3, RefreshCw, ShieldCheck } from "lucide-react";
import { CreativeExecutionHistoryPanel } from "../execution/creative-execution-history";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition, type CSSProperties } from "react";

import {
  bindMockupsToListings,
  confirmTemplateInspection,
  createMockupBatch,
  createTemplateInspection,
  createTemplatePack,
  rejectMockupItem,
  retryMockupOutput,
  reviewMockupBatch,
  reviewTemplatePack,
  type PodBatchActionState,
} from "./pod-batch-actions";
import type { BatchCapabilities, MockupBatch, MockupOptions } from "./pod-batch-types";
import { useWorkflowReturn } from "../navigation/use-workflow-return";

const idle: PodBatchActionState = { status: "idle", message: "" };

export function MockupBatchWorkbench({
  capabilities,
  options,
  allPacks,
  batches,
  batch,
  assetUrls,
  error, initialDesignVersionId,
}: {
  initialDesignVersionId?: string;
  capabilities?: BatchCapabilities;
  options?: MockupOptions;
  allPacks: Array<{ id: string; name: string; versionNumber: number; status: string; platform: string; locale: string }>;
  batches: MockupBatch[];
  batch?: MockupBatch;
  assetUrls: Record<string, string>;
  error?: string;
}) {
  const feature = capabilities?.mockupBatches;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const workflow = useWorkflowReturn();
  return (
    <div className="pod-batch-workbench" aria-busy={!hydrated} inert={!hydrated}>
      <header className="pod-batch-header">
        <div>
          <p className="kicker">CONTROLLED PSD PRODUCTION</p>
          <h1>商品套图</h1>
          <p>消费已绑定 SKU 的正式设计版本，用已批准模板包确定性渲染；这里只生成图片，不生成标题。</p>
        </div>
        <nav aria-label="生产上下游">
          <Link href={workflow.back ?? "/product-development"}><ChevronLeft size={14} />{workflow.back ? "返回来源 SKU" : "产品开发"}</Link>
          <Link aria-current="page" href={workflow.current}>批量套图</Link>
        </nav>
      </header>
      <section className="pod-batch-boundary">
        <span><ShieldCheck size={16} /><b>正式设计</b>只接收已批准且已绑定 SKU 的版本</span>
        <span><FileImage size={16} /><b>受控 PSD</b>编译包通过 SSIM ≥ 0.99 后才可批准</span>
        <span><Grid3X3 size={16} /><b>槽位独立</b>失败槽位单独重试并创建新版本</span>
      </section>
      {error ? <p className="pod-batch-alert error"><AlertTriangle size={15} />{error}</p> : null}
      {feature && !feature.enabled ? <div className="pod-batch-alert warning"><AlertTriangle size={15} /><span><b>套图入口暂未启用</b>{feature.blockers.join("；")}</span></div> : null}

      <TemplateConsole allPacks={allPacks} options={options} assetUrls={assetUrls} key={options ? "authorized" : "unavailable"} />
      <MockupComposer disabled={!feature?.enabled} options={options} initialDesignVersionId={initialDesignVersionId} />
      <div className="pod-batch-layout">
        <MockupLedger activeId={batch?.id} batches={batches} />
        <MockupMatrix assetUrls={assetUrls} batch={batch} key={batch?.id ?? "empty"} options={options} />
      </div>
    </div>
  );
}

function TemplateConsole({ options, allPacks, assetUrls }: { options?: MockupOptions; assetUrls: Record<string, string>; allPacks: Array<{ id: string; name: string; versionNumber: number; status: string; platform: string; locale: string }> }) {
  const [inspectionState, inspectionAction, inspecting] = useActionState(createTemplateInspection, idle);
  const [packState, packAction, creatingPack] = useActionState(createTemplatePack, idle);
  const [assetId, setAssetId] = useState(options?.templateSourceAssets[0]?.id ?? "");
  const [slotKey, setSlotKey] = useState("main");
  const [selectedInspections, setSelectedInspections] = useState<string[]>([]);
  const [selectedSpecs, setSelectedSpecs] = useState<string[]>(options?.printSpecs[0] ? [options.printSpecs[0].id] : []);
  const asset = options?.templateSourceAssets.find((entry) => entry.id === assetId);
  const completed = options?.inspections.filter((inspection) => inspection.status === "completed" && inspection.confirmedAt) ?? [];
  const staleSources = selectedInspections.some(id => !completed.some(inspection => inspection.id === id))
    || selectedSpecs.some(id => !options?.printSpecs.some(spec => spec.id === id));
  const inspectionPayload = JSON.stringify(asset ? { sourceAssetId: asset.id, sourceAssetVersion: asset.version, checksumSha256: asset.checksumSha256, slotKey } : {});
  const packPayload = JSON.stringify({
    name: "帆布画场景模板包", platform: "amazon", locale: "en-US", productCategory: "canvas_art",
    slots: selectedInspections.flatMap((id, ordinal) => {
      const inspection = completed.find((entry) => entry.id === id);
      return inspection ? [{ slotKey: inspection.slotKey, label: inspection.slotKey, ordinal, required: ordinal === 0, inspectionId: id, acceptedPrintSpecVersionIds: selectedSpecs }] : [];
    }),
  });
  return (
    <details className="pod-template-console">
      <summary><span><FileImage size={15} />PSD 模板与模板包</span><small>先编译检查，再组包审批</small></summary>
      <div className="pod-template-columns">
        <form action={inspectionAction}>
          <input name="payload" type="hidden" value={inspectionPayload} />
          <h3>1. 编译 PSD 场景</h3>
          <label>已授权 PSD<select onChange={(event) => setAssetId(event.target.value)} value={assetId}><option value="">选择 PSD</option>{options?.templateSourceAssets.map((entry) => <option key={entry.id} value={entry.id}>{entry.fileName}</option>)}</select></label>
          <label>槽位键<input onChange={(event) => setSlotKey(event.target.value)} pattern="[a-z][a-z0-9_.-]*" value={slotKey} /></label>
          <button disabled={inspecting || !asset} type="submit">{inspecting ? "编译排队中…" : "提交受控编译"}</button>
          <ActionNotice state={inspectionState} />
        </form>
        <form action={packAction}>
          <input name="payload" type="hidden" value={packPayload} />
          <h3>2. 组装模板包版本</h3>
          <div className="pod-template-checks"><b>已人工确认的槽位</b>{completed.map((inspection) => <label key={inspection.id}><input checked={selectedInspections.includes(inspection.id)} onChange={(event) => setSelectedInspections((current) => event.target.checked ? [...current, inspection.id] : current.filter((id) => id !== inspection.id))} type="checkbox" />{inspection.slotKey} · SSIM {((inspection.compilation?.ssimPermille ?? 0) / 1000).toFixed(3)}</label>)}</div>
          <label>兼容规格<select multiple onChange={(event) => setSelectedSpecs(selectedValues(event.currentTarget))} value={selectedSpecs}>{options?.printSpecs.map((spec) => <option key={spec.id} value={spec.id}>{spec.name}</option>)}</select></label>
          {staleSources ? <p className="pod-action-notice error">模板或规格选项已变化 请重新选择后再组包</p> : null}
          <button disabled={creatingPack || staleSources || !selectedInspections.length || !selectedSpecs.length} type="submit">创建模板包草稿</button>
          <ActionNotice state={packState} />
        </form>
        <div className="pod-template-ledger"><h3>3. 黄金图确认 / 模板包审核</h3>{options?.inspections.map(inspection => <CreativeExecutionHistoryPanel key={inspection.id} scope="inspection" ownerId={inspection.id} label={inspection.slotKey} />)}{options?.inspections.filter((inspection) => inspection.status === "completed" && !inspection.confirmedAt).map((inspection) => <InspectionConfirm inspection={inspection} previewUrl={assetUrls[inspection.compilation?.previewAssetId ?? ""]} key={inspection.id} />)}{allPacks.map((pack) => <TemplateReview key={pack.id} pack={pack} />)}</div>
      </div>
    </details>
  );
}

function InspectionConfirm({ inspection, previewUrl }: { inspection: MockupOptions["inspections"][number]; previewUrl?: string }) {
  const [state, action, pending] = useActionState(confirmTemplateInspection, idle);
  const imageRef = useRef<HTMLImageElement>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    setPreviewReady(Boolean(previewUrl && imageRef.current?.complete && imageRef.current.naturalWidth > 0));
    setPreviewFailed(Boolean(previewUrl && imageRef.current?.complete && imageRef.current.naturalWidth === 0));
  }, [previewUrl]);
  return <form action={action} className="pod-template-review"><input name="inspectionId" type="hidden" value={inspection.id} /><input name="expectedFingerprint" type="hidden" value={inspection.reviewFingerprint ?? ""} /><span><b>{inspection.slotKey} 黄金图</b>{previewUrl ? <img ref={imageRef} className="pod-golden-preview" alt={`${inspection.slotKey} 黄金图预览`} src={previewUrl} onLoad={() => { setPreviewReady(Boolean(imageRef.current?.complete && imageRef.current.naturalWidth > 0)); setPreviewFailed(false); }} onError={() => { setPreviewReady(false); setPreviewFailed(true); }} /> : <small>黄金图预览不可用 请刷新后核对</small>}{previewFailed ? <small>黄金图读取失败 请刷新后核对</small> : null}<small>SSIM {((inspection.compilation?.ssimPermille ?? 0) / 1000).toFixed(3)} · {inspection.executionEvidence === "legacy_compilation" ? "历史编译资料 待核对来源" : "待人工确认"}</small>{!inspection.reviewFingerprint ? <small>缺少检查版本 请刷新</small> : null}</span><button className="primary" disabled={pending || !inspection.reviewFingerprint || !previewReady}>确认编译结果</button><ActionNotice state={state} /></form>;
}

function TemplateReview({ pack }: { pack: { id: string; name: string; versionNumber: number; status: string; platform: string; locale: string } }) {
  const [state, action, pending] = useActionState(reviewTemplatePack, idle);
  return <form action={action} className="pod-template-review"><input name="versionId" type="hidden" value={pack.id} /><span><b>{pack.name} v{pack.versionNumber}</b><small>{pack.platform} · {pack.locale} · {statusLabel(pack.status)}</small></span>{pack.status === "draft" ? <><input name="rejectionReason" placeholder="驳回原因" /><button disabled={pending} name="decision" value="reject">驳回</button><button className="primary" disabled={pending} name="decision" value="approve">批准</button></> : null}<ActionNotice state={state} /></form>;
}

function MockupComposer({ options, disabled, initialDesignVersionId }: { options?: MockupOptions; disabled: boolean; initialDesignVersionId?:string }) {
  const [state, action, pending] = useActionState(createMockupBatch, idle);
  const initialDesign=options?.formalDesigns.find(d=>d.designVersionId===initialDesignVersionId);
  const [packId, setPackId] = useState(options?.templatePacks.find(p=>initialDesign && p.slots.every(s=>s.acceptedPrintSpecVersionIds.includes(initialDesign.printSpecVersionId)))?.id??options?.templatePacks[0]?.id??"");
  const [designIds, setDesignIds] = useState<string[]>(initialDesign?[initialDesign.designVersionId]:[]);
  const pack = options?.templatePacks.find((entry) => entry.id === packId);
  const designs = options?.formalDesigns.filter((design) => pack?.slots.every((slot) => slot.acceptedPrintSpecVersionIds.includes(design.printSpecVersionId))) ?? [];
  const staleDesigns = designIds.some(id => !designs.some(design => design.designVersionId === id));
  const payload = JSON.stringify({
    name: "帆布画批量套图", templatePackVersionId: packId,
    platform: pack?.platform, locale: pack?.locale,
    items: designIds.flatMap((designVersionId) => {
      const design = options?.formalDesigns.find((entry) => entry.designVersionId === designVersionId);
      return design ? [{ designVersionId, skuId: design.skuId }] : [];
    }),
  });
  return (
    <details className="pod-batch-compose" open={!!initialDesign}>
      <summary><span><Grid3X3 size={15} />新建套图批次</span><small>一个模板包 · 最多 50 个正式设计版本</small></summary>
      <form action={action}>
        <input name="payload" type="hidden" value={payload} />
        <div className="pod-mockup-compose-grid">
          <label>模板包版本<select onChange={(event) => { setPackId(event.target.value); setDesignIds([]); }} value={packId}><option value="">选择已批准模板包</option>{options?.templatePacks.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} v{entry.versionNumber} · {entry.platform}/{entry.locale}</option>)}</select></label>
          <div><b>正式设计版本</b><span>{designIds.length}/50 已选</span><div className="pod-design-option-list">{designs.map((design) => <label key={design.designVersionId}><input checked={designIds.includes(design.designVersionId)} disabled={!designIds.includes(design.designVersionId) && designIds.length >= 50} onChange={(event) => setDesignIds((current) => event.target.checked ? [...current, design.designVersionId] : current.filter((id) => id !== design.designVersionId))} type="checkbox" /><span><strong>{design.title}</strong><small>{design.skuCode}</small></span></label>)}</div></div>
        </div>
        {staleDesigns ? <p className="pod-action-notice error">所选设计当前不可用 请重新核对选择</p> : null}
        <footer><span>每个槽位独立产出；失败不会删除同款其他成功结果。</span><button disabled={disabled || pending || staleDesigns || !pack || !designIds.length} type="submit">{pending ? "提交中…" : "锁定输入并开始渲染"}</button></footer>
        <ActionNotice state={state} />
      </form>
    </details>
  );
}

function MockupLedger({ activeId, batches }: { activeId?: string; batches: MockupBatch[] }) {
  const workflow = useWorkflowReturn();
  const batchHref = (id: string) => { const url = new URL(workflow.current, "https://erp.invalid"); url.searchParams.set("batch", id); return `${url.pathname}${url.search}`; };
  return <aside className="pod-batch-ledger"><header><span>MOCKUP LEDGER</span><b>{batches.length}</b></header>{batches.length ? batches.map((entry) => <Link className={entry.id === activeId ? "active" : ""} href={batchHref(entry.id)} key={entry.id}><span>{statusLabel(entry.status)}</span><strong>{entry.name}</strong><small>{entry.completedCount}/{entry.itemCount} 已批准 · {entry.failedCount} 失败</small></Link>) : <p>尚无套图批次。</p>}</aside>;
}

function MockupMatrix({ batch, options, assetUrls }: { batch?: MockupBatch; options?: MockupOptions; assetUrls: Record<string, string> }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [selected, setSelected] = useState<Array<{ itemId: string; expectedFingerprint: string }>>([]);
  const [state, action, pending] = useActionState(reviewMockupBatch, idle);
  const currentPack = options?.templatePacks.find((entry) => entry.id === batch?.templatePackVersionId);
  const pack = currentPack ?? batch?.templatePack;
  const payload = JSON.stringify({ decisions: selected.map(selection => ({ ...selection, decision: "approve" })) });
  const staleSelection = selected.some(selection => batch?.items?.find(item => item.id === selection.itemId)?.reviewFingerprint !== selection.expectedFingerprint);
  const unavailableSelection = !currentPack || selected.some(selection => !options?.formalDesigns.some(design => design.designVersionId === batch?.items?.find(item => item.id === selection.itemId)?.designVersionId));
  if (!batch?.items || !pack) return <section className="pod-batch-empty"><Grid3X3 size={24} /><h2>等待第一批正式设计</h2><p>必须先完成 SKU 绑定和正式设计版本审批。</p></section>;
  return (
    <section className="pod-mockup-detail">
      <CreativeExecutionHistoryPanel scope="mockup_batch" ownerId={batch.id} />
      <header><div><p>ROW × SLOT REVIEW</p><h2>{batch.name}</h2></div><span>{statusLabel(batch.status)}</span><button disabled={refreshing || pending} onClick={() => startRefresh(() => router.refresh())} type="button"><RefreshCw size={14} />{refreshing ? "刷新中…" : "刷新结果"}</button></header>
      <p className="pod-batch-alert warning pod-mockup-review-stale" hidden={!staleSelection} role="status">所选结果已变化 请取消勾选并重新查看后再批准</p>
      {!currentPack ? <p className="pod-batch-alert warning">原模板当前不可用于新操作 仍可查看有权读取的历史结果</p> : null}
      <div>
        <div className="pod-mockup-matrix" style={{ "--slot-count": pack.slots.length } as CSSProperties}>
          <div className="pod-matrix-head"><span>款式 / SKU</span>{pack.slots.map((slot) => <b key={slot.id}>{slot.label}<small>{slot.required ? "必需" : "可选"}</small></b>)}</div>
          {batch.items.map((item) => {
            const design = options?.formalDesigns.find((entry) => entry.designVersionId === item.designVersionId);
            const bySlot = new Map(item.outputs.map((output) => [output.slotKey, output]));
            const reviewable = Boolean(item.reviewFingerprint) && !item.outputs.some(output => ["queued", "running"].includes(output.status));
            const approvable = Boolean(currentPack && design) && reviewable && item.status !== "completed" && pack.slots.filter((slot) => slot.required).every((slot) => ["succeeded", "approved"].includes(bySlot.get(slot.slotKey)?.status ?? "missing"));
            return (
              <article className="pod-matrix-row" key={item.id}>
                <header><label><input checked={selected.some(selection => selection.itemId === item.id)} disabled={!approvable} onChange={(event) => setSelected((current) => event.target.checked && item.reviewFingerprint ? [...current.filter(selection => selection.itemId !== item.id), { itemId: item.id, expectedFingerprint: item.reviewFingerprint }] : current.filter(selection => selection.itemId !== item.id))} type="checkbox" /><span><strong>{design?.title ?? item.designVersionId.slice(0, 8)}</strong><small>{design?.skuCode ?? item.skuId.slice(0, 8)} · {statusLabel(item.status)}</small></span></label>{item.rejectionReason ? <em>{item.rejectionReason}</em> : null}{reviewable ? <MockupRowRejectForm batchId={batch.id} itemId={item.id} expectedFingerprint={item.reviewFingerprint!} /> : null}</header>
                {pack.slots.map((slot) => {
                  const output = bySlot.get(slot.slotKey);
                  return <MockupCell assetUrls={assetUrls} batchId={batch.id} key={slot.id} output={output} slotLabel={slot.label} />;
                })}
                {item.status === "completed" ? <ListingBindingForm batch={batch} item={item} options={options} /> : null}
              </article>
            );
          })}
        </div>
        <form action={action} className="pod-matrix-review"><input name="batchId" type="hidden" value={batch.id} /><input name="payload" type="hidden" value={payload} /><span>批准按勾选时的结果版本核对 历史产物缺少原交接证据时请驳回后重渲染</span><ActionNotice state={state} /><button disabled={pending || refreshing || staleSelection || unavailableSelection || !selected.length} type="submit"><Check size={14} />批准所选款式</button></form>
      </div>
    </section>
  );
}

function MockupRowRejectForm({ batchId, itemId, expectedFingerprint }: { batchId: string; itemId: string; expectedFingerprint: string }) {
  const [state, action, pending] = useActionState(rejectMockupItem, idle);
  const [basis, setBasis] = useState(expectedFingerprint);
  const stale = basis !== expectedFingerprint;
  return <form action={action} className="pod-row-reject"><input name="batchId" type="hidden" value={batchId} /><input name="itemId" type="hidden" value={itemId} /><input name="expectedFingerprint" type="hidden" value={basis} /><input name="rejectionReason" placeholder="整款驳回原因" required />{stale ? <><small>结果已变化 驳回原因已保留</small><button onClick={() => setBasis(expectedFingerprint)} type="button">按当前结果重新核对</button></> : null}<button disabled={pending || stale}>驳回槽位</button><ActionNotice state={state} /></form>;
}

function MockupCell({ output, batchId, slotLabel, assetUrls }: { output?: NonNullable<MockupBatch["items"]>[number]["outputs"][number]; batchId: string; slotLabel: string; assetUrls: Record<string, string> }) {
  const [state, action, pending] = useActionState(retryMockupOutput, idle);
  return (
    <div className={`pod-mockup-cell ${output?.status ?? "missing"}`} data-slot={slotLabel}>
      {output?.assetId && assetUrls[output.assetId] ? <img alt={slotLabel} src={assetUrls[output.assetId]} /> : <span>{output?.status === "failed" ? <AlertTriangle size={18} /> : <Grid3X3 size={18} />}</span>}
      <b>{statusLabel(output?.status ?? "missing")}</b><small>v{output?.attempt ?? 0}</small>
      {output?.errorMessage ? <em>{output.errorMessage}</em> : null}
      {output && ["failed", "rejected"].includes(output.status) ? <form action={action}><input name="batchId" type="hidden" value={batchId} /><input name="outputId" type="hidden" value={output.id} /><button disabled={pending}><RefreshCw size={12} />重试</button><ActionNotice state={state} /></form> : null}
    </div>
  );
}

function ListingBindingForm({ batch, item, options }: { batch: MockupBatch; item: NonNullable<MockupBatch["items"]>[number]; options?: MockupOptions }) {
  const [state, action, pending] = useActionState(bindMockupsToListings, idle);
  const design = options?.formalDesigns.find((entry) => entry.designVersionId === item.designVersionId);
  const listings = options?.listingVersions.filter((entry) => entry.platform === batch.platform && entry.locale === batch.locale && entry.spuId === design?.spuId) ?? [];
  const [listingVersionId, setListingVersionId] = useState(listings[0]?.listingVersionId ?? "");
  const approved = item.outputs.filter((output) => output.status === "approved");
  const [slotKeys, setSlotKeys] = useState<Record<string, string>>(Object.fromEntries(approved.map((output) => [output.id, output.slotKey])));
  const payload = JSON.stringify({ bindings: [{ itemId: item.id, listingVersionId, slots: approved.map((output) => ({ outputId: output.id, slotKey: slotKeys[output.id] ?? output.slotKey })) }] });
  return <div className="pod-listing-binding"><form action={action}><input name="batchId" type="hidden" value={batch.id} /><input name="payload" type="hidden" value={payload} /><b>显式绑定 Listing</b><select onChange={(event) => setListingVersionId(event.target.value)} value={listingVersionId}>{listings.map((listing) => <option key={listing.listingVersionId} value={listing.listingVersionId}>{listing.listingId.slice(0, 8)} · v{listing.versionNumber}</option>)}</select>{approved.map((output) => <label key={output.id}>{output.slotKey}<input onChange={(event) => setSlotKeys((current) => ({ ...current, [output.id]: event.target.value }))} value={slotKeys[output.id] ?? output.slotKey} /></label>)}<button disabled={pending || !listingVersionId || !approved.length}>绑定候选槽位</button><ActionNotice state={state} /></form></div>;
}

function ActionNotice({ state }: { state: PodBatchActionState }) { return state.status === "idle" ? null : <p className={`pod-action-notice ${state.status}`}>{state.message}</p>; }
function selectedValues(select: HTMLSelectElement) { return Array.from(select.selectedOptions, (option) => option.value); }
function statusLabel(status: string) { return ({ queued: "排队", running: "处理中", succeeded: "渲染成功", awaiting_review: "待审核", partially_succeeded: "部分成功", completed: "已批准", approved: "已批准", rejected: "已驳回", failed: "失败", cancelled: "已取消", draft: "草稿", missing: "缺失" } as Record<string, string>)[status] ?? status; }
