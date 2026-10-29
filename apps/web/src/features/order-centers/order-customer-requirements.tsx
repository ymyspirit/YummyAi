"use client";

import { useEffect, useRef, useState } from "react";
import { ImageOff, Maximize2, RotateCcw, X } from "lucide-react";
import type { OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { OrderRequirementsView } from "./order-requirements-view";
import "./order-customer-requirements.css";

type ReferenceImage = { key: string; src: string | null; label: string; caption: string };
const keepReadOnly = () => {};

/** Read-only evidence: an updated report must never replace the source used for this draft. */
export function OrderCustomerRequirements({ detail, revisionId }: { detail: OrderWorkDetail; revisionId?: string }) {
  const [enlarged, setEnlarged] = useState<ReferenceImage | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const currentRevision = detail.versions.find(version => version.revision === detail.line.revision);
  const mismatch = !!revisionId && currentRevision?.id !== revisionId;
  const source = detail.sourceReport === undefined
    ? !detail.line.sourceChanged ? detail.report : null
    : detail.sourceReport;
  const sourcePath = (key: string) => detail.sourceReport === undefined
    ? `/api/orders/reports/lines/${source!.line.id}/files/${encodeURIComponent(key)}?versionId=${source!.versionId}`
    : `/api/order-centers/lines/${detail.line.id}/source-files/${encodeURIComponent(key)}?revision=${detail.line.revision}`;
  const selected: ReferenceImage[] = detail.draft.images.map((image, index) => {
    const asset = image.origin === "upload" ? detail.assets.find(asset => asset.id === image.key) : null;
    const file = image.origin === "report" ? source?.files.find(file => file.key === image.key) : null;
    const original = file?.originalFileKey ? source?.files.find(value => value.key === file.originalFileKey) : null;
    const name = asset?.name ?? original?.name.split("/").at(-1) ?? file?.name ?? `图片 ${index + 1}`;
    return { key: `${image.origin}:${image.key}`, label: `顾客原图：${name}`,
      src: image.origin === "upload" ? asset?.path ?? null : source ? sourcePath(image.key) : null,
      caption: `${({ buyer_photo: "顾客来图", front_photo: "正面参考图", back_photo: "背面参考图" } as Record<string, string>)[image.usage] ?? image.usage}${asset ? " · 运营上传素材" : " · 顾客上传素材"}` };
  });
  const previews: ReferenceImage[] = source?.surfaces.flatMap(surface => surface.previewFileKey
    ? [{ key: surface.key, src: sourcePath(surface.previewFileKey), label: `平台定制预览：${surface.label}`, caption: "平台效果示意，核对时结合顾客原图" }]
    : []) ?? [];
  const specification = detail.catalog?.specifications.find(spec => spec.id === detail.draft.specificationVersionId);

  useEffect(() => {
    if (enlarged) dialog.current?.showModal();
    else dialog.current?.close();
  }, [enlarged]);

  return <section className="oc-customer-requirements" aria-label="顾客定制信息" tabIndex={0}>
    <h3>顾客定制信息</h3>
    {mismatch ? <p className="oc-error" role="alert">此稿件关联的制作需求与当前需求版本不同，请返回对应任务核对；当前要求不能作为此稿的审核依据。</p> : <>
      {detail.line.sourceChanged && <p className="oc-notice" role="status">顾客资料已有更新。这里保留本次制作采用的要求，请对照下方“最新导入资料与平台预览”核对差异。</p>}
      <section aria-label="本次制作要求">
        <h4>本次制作要求 <span className="oc-badge">需求 V{detail.line.revision}</span></h4>
        <dl>
          <div><dt>订单 / 数量</dt><dd>{detail.line.externalOrderId} · {detail.line.quantity} 件</dd></div>
          <div><dt>规格</dt><dd>{specification?.name ?? "未匹配具体规格"}</dd></div>
          <div><dt>制作说明</dt><dd>{detail.draft.instructions.trim() ? detail.draft.instructions : "未填写额外制作说明"}</dd></div>
          <div><dt>客户确认校样</dt><dd>{detail.draft.customerApprovalRequired ? "需要客户确认" : "本单未要求客户确认"}</dd></div>
        </dl>
        {detail.requirementInterpretation?.sources.length ? <div className="oc-review-requirements">
          <OrderRequirementsView key={`${detail.line.id}:${detail.line.revision}`} detail={detail} draft={detail.draft} check={null}
            disabled readOnly onChange={keepReadOnly} onPending={keepReadOnly} />
        </div> : <p className="oc-notice" role="status">本单尚无可核对的文字分组说明 原始制作要求与顾客选项完整保留在下方详情 请人工核对 不按旧字段附带的样式猜测归属</p>}
        <details className="oc-review-reference" aria-label="原制作需求字段详情"><summary>原制作需求字段 · {detail.draft.fields.length} 项</summary>
          <dl>{detail.draft.fields.map(field => <div key={field.key}><dt>{field.label || "未命名定制项"}</dt><dd>{fieldValue(field)}</dd></div>)}</dl>
        </details>
      </section>
      <div className="oc-customer-image-comparison">
        <section aria-label="本次选用原图">
          <h4>本次选用原图</h4>
          {selected.length ? <div className="oc-customer-images">{selected.map(image => <Reference key={image.key} image={image} onOpen={setEnlarged} />)}</div>
            : <p className="oc-hint">本次制作未选择顾客图片。</p>}
        </section>
        <section aria-label="平台定制预览">
          <h4>平台定制预览</h4>
          {previews.length ? <div className="oc-customer-images">{previews.map(image => <Reference key={image.key} image={image} onOpen={setEnlarged} />)}</div>
            : <p className="oc-hint">本次来源资料没有可用的平台预览。</p>}
        </section>
      </div>
      <details className="oc-review-reference" aria-label="顾客原始选项">
        <summary>顾客原始选项 {source && <span className="oc-badge">附件 V{source.line.versionNumber}</span>}</summary>
        {!source ? <p className="oc-notice">本次制作的原始定制资料暂不可用；请补齐核对依据，不能仅凭图稿判断正确。</p>
          : source.surfaces.length ? source.surfaces.map(surface => <div className="oc-customer-surface" key={surface.key}>
            <strong>{surface.label}</strong>
            {surface.fields.length ? <dl>{surface.fields.map(field => <div key={field.key}><dt>{field.label || "未命名定制项"}{field.kind === "unknown" && <small>未识别类型</small>}</dt><dd>{field.value.trim() ? field.value : "未填写"}</dd></div>)}</dl>
              : <p className="oc-hint">此定制面没有文字或选项。</p>}
          </div>) : <p className="oc-hint">来源附件未提供可展示的定制选项。</p>}
        {!!source?.warnings.length && <ul className="oc-customer-warnings">{source.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      </details>
    </>}
    <dialog ref={dialog} className="oc-customer-image-dialog" aria-label="定制图片放大预览"
      onCancel={event => { event.stopPropagation(); setEnlarged(null); }}
      onClose={event => { event.stopPropagation(); setEnlarged(null); }}>
      {enlarged && <><header><strong>{enlarged.label}</strong><button type="button" className="oc-button" onClick={() => setEnlarged(null)} autoFocus><X size={16} />关闭预览</button></header>
        <ReferenceImageView key={enlarged.src} image={enlarged} /><p>{enlarged.caption}</p></>}
    </dialog>
  </section>;
}

function fieldValue(field: OrderWorkDraft["fields"][number]) {
  const value = field.value.trim() ? field.value : "未填写";
  if (field.key === "crop_scope") return ({ head: "仅头部", half_body: "半身", body: "全身" } as Record<string, string>)[field.value] ?? value;
  if (field.key === "print_sides") return ({ single_sided: "单面印刷（背面镜像空白）", double_sided: "双面印刷（背面镜像，文字正读）" } as Record<string, string>)[field.value] ?? value;
  return value;
}
function Reference({ image, onOpen }: { image: ReferenceImage; onOpen: (image: ReferenceImage) => void }) {
  return <figure><ReferenceImageView key={image.src} image={image} onOpen={() => onOpen(image)} />
    <figcaption><strong>{image.label}</strong><small>{image.caption}</small></figcaption></figure>;
}
function ReferenceImageView({ image, onOpen }: { image: ReferenceImage; onOpen?: () => void }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (!image.src) return <span className="oc-customer-image-missing"><ImageOff size={20} />来源图片不可用</span>;
  if (failed) return <span className="oc-customer-image-missing" role="status"><ImageOff size={20} />图片暂不可用<span>请重试；仍不可用时核对资料权限或保存期限。</span>
    <button type="button" className="oc-button" aria-label={`重试 ${image.label}`} onClick={() => { setFailed(false); setAttempt(value => value + 1); }}><RotateCcw size={14} />重试</button></span>;
  // Private, authenticated media never goes through a public image optimizer.
  const imageElement = <img src={`${image.src}${image.src.includes("?") ? "&" : "?"}attempt=${attempt}`} alt={image.label} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return onOpen ? <button type="button" className="oc-customer-image-open" aria-label={`放大 ${image.label}`} onClick={onOpen}>{imageElement}<span><Maximize2 size={14} />放大查看</span></button> : imageElement;
}
