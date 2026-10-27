"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Layers3, Settings2 } from "lucide-react";
import type { OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { orderDesignExecutor } from "@yummyai/contracts/order/workspace";
import { orderAutomaticBasisView, orderCatalogSpus } from "./order-auto-basis-model";
import { orderDraftWithArtwork } from "./order-work-input-model";

export function OrderArtworkBasis({ detail, draft, onChange, children, manualTakeover = false, routePending = false }: {
  detail: OrderWorkDetail;
  draft: OrderWorkDraft;
  onChange: (draft: OrderWorkDraft) => void;
  children?: ReactNode;
  manualTakeover?: boolean;
  routePending?: boolean;
}) {
  const [selectedSpu, setSelectedSpu] = useState({ lineId: detail.line.id, id: "" });
  const [manualOpen, setManualOpen] = useState(false);
  const catalog = detail.catalog;
  if (!catalog) return <><p className="oc-hint oc-full-field" role="status">本单制作依据暂不可读取 请保留原需求并刷新核对</p>{children}</>;
  const view = orderAutomaticBasisView(detail, draft), { recipe, specification } = view;
  const art = catalog.artworks.find(value => value.id === (draft.artworkVersionId ?? recipe?.artworkVersionId));
  const spuId = specification?.spuId ?? (selectedSpu.lineId === detail.line.id ? selectedSpu.id : "");
  const spus = orderCatalogSpus(catalog);
  const spu = view.spu ?? spus.find(value => value.id === spuId);
  function artwork(id: string) {
    const fields = catalog!.artworks.find(value => value.id === id)?.customization.fields ?? [];
    onChange(orderDraftWithArtwork(draft, id, recipe?.artworkVersionId, fields));
  }
  return <>
    <section className={`oc-basis-summary ${view.tone}`} aria-label="本单制作依据匹配">
      <header><span>{view.tone === "warning" ? <AlertTriangle size={16} /> : <Layers3 size={16} />}<strong>{view.title}</strong></span>
        <small>{view.changed || view.automatic?.applied ? "待保存到本单需求" : detail.line.revision > 0 ? `本单需求 V${detail.line.revision}` : "待核对并保存"}</small></header>
      <dl>
        <div><dt>商品</dt><dd>{spu ? spu.name : "待明确产品"}</dd></div>
        <div><dt>本件尺寸 / 规格</dt><dd>{specification ? specification.name : "待明确具体规格"}{specification?.dimensions && <small>{specification.dimensions}</small>}</dd></div>
        <div><dt>制作数量</dt><dd>{detail.line.quantity} 件</dd></div>
      </dl>
      {!!view.issues.length && <ul className="oc-basis-issues" aria-label="制作依据待办">{view.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      <details className="oc-basis-evidence"><summary>工艺 印花版本与匹配依据</summary>
        <dl><div><dt>产品 SPU</dt><dd>{spu ? `${spu.code} · ${spu.name}` : "待明确产品"}</dd></div>
          <div><dt>规格版本</dt><dd>{specification ? `V${specification.version}` : "未固定"}</dd></div>
          <div><dt>通用工艺底稿</dt><dd>{view.process}</dd></div>
          <div><dt>印花与素材</dt><dd>{art ? `${art.code} · ${art.name} · V${art.version}` : "来图方案待确认"}</dd></div></dl>
        {view.automatic && <>
          {view.automatic.sizeInches !== null && <p>定制信息中的尺寸 {view.automatic.sizeInches} in</p>}
          {!!view.automatic.reasons.length && <ul>{view.automatic.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          {view.changed && !!view.automatic.issues.length && <ul>{view.automatic.issues.map((issue, index) => <li key={index}>原匹配提示 {issue}</li>)}</ul>}
        </>}
        <p className="oc-basis-note">匹配仅准备本单制作依据 不代表图稿已审核或放行生产 历史订单继续使用原固定版本</p>
      </details>
      {(view.issues.length > 0 || !spus.length || !specification) && <Link className="oc-basis-link" data-task-draft-link href={spuId ? `/product-specifications?spu=${spuId}` : "/product-specifications"}>到商品库核对 SPU 规格与已审核底稿</Link>}
    </section>
    <div className="oc-review-design" data-review-target="design" tabIndex={-1}><strong>{manualTakeover ? "已交美工修改" : routePending ? "正在核对本单制图状态" : orderDesignExecutor(draft) === "human" ? "本单已保存美工制作方式" : "先由 Agent 出稿"}</strong>
      <small>{manualTakeover ? "沿用本单原制作项目修改 已完成素材与费用记录保留 修改后重新送运营审核" : routePending ? "读取原制作任务后显示当前交接方式 历史制作版本保持原样"
        : orderDesignExecutor(draft) === "human" ? "保留本单原保存方式 不回写历史版本 新单默认先由 Agent 出稿"
          : "顾客原文与特殊备注一并交给 Agent 运营审核不通过后再交美工修改 审单不会自动放行生产"}</small>
    </div>
    <details className="oc-basis-manual" data-review-target="basis" open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)}>
      <summary><Settings2 size={15} /><span>手动指定印花或改选制作依据</span><ChevronDown size={14} /></summary>
      <div className="oc-basis-fields">
        <label>销售 SKU 制作版本<select aria-label="销售 SKU 制作版本" value={draft.salesRecipeVersionId ?? ""} onChange={event => {
          const value = catalog.recipes.find(row => row.id === event.target.value);
          onChange({ ...draft, salesRecipeVersionId: value?.id ?? null, salesPackageId: null,
            artworkVersionId: value?.artworkVersionId ?? draft.artworkVersionId,
            specificationVersionId: value?.specificationVersionId ?? draft.specificationVersionId,
            printProfileVersionId: value?.processProfileVersionId ?? draft.printProfileVersionId });
        }}><option value="">直接使用印花与 SPU 规格</option>{catalog.recipes.map(value => <option key={value.id} value={value.id}>{value.skuCode} · {value.spuCode} / {value.specification} · V{value.version}</option>)}</select>
          <small>优先保留下单时的固定映射 本单改选会随需求保存</small>
          {catalog.channelRecipeId && catalog.channelPackageId && <button type="button" className="oc-button" onClick={() => {
            const channel = catalog.recipes.find(value => value.id === catalog.channelRecipeId); if (!channel) return;
            onChange({ ...draft, salesRecipeVersionId: channel.id, salesPackageId: catalog.channelPackageId,
              artworkVersionId: channel.artworkVersionId, specificationVersionId: channel.specificationVersionId, printProfileVersionId: channel.processProfileVersionId });
          }}>使用下单时渠道映射</button>}
        </label>
        <label>本单印花 SKU<select aria-label="本单印花版本" value={draft.artworkVersionId ?? recipe?.artworkVersionId ?? ""} onChange={event => artwork(event.target.value)}>
          <option value="">请选择印花及素材版本</option>{catalog.artworks.map(value => <option key={value.id} value={value.id}>{value.code} · {value.name} · V{value.version}</option>)}
        </select></label>
        <label>产品 SPU<select aria-label="本单产品 SPU" value={spuId} onChange={event => {
          setSelectedSpu({ lineId: detail.line.id, id: event.target.value });
          onChange({ ...draft, salesRecipeVersionId: null, salesPackageId: null, specificationVersionId: null, printProfileVersionId: null });
        }}><option value="">请选择产品</option>{spus.map(value => <option key={value.id} value={value.id}>{value.code} · {value.name}</option>)}</select>
          {!spus.length && <small>当前未取得可用 SPU 请先核对商品库资料或访问权限</small>}
        </label>
        <label>具体规格<select aria-label="本单产品规格" disabled={!spuId} value={draft.specificationVersionId ?? recipe?.specificationVersionId ?? ""} onChange={event => {
          const value = catalog.specifications.find(row => row.id === event.target.value);
          onChange({ ...draft, salesRecipeVersionId: null, salesPackageId: null, specificationVersionId: value?.id ?? null, printProfileVersionId: value?.processProfileVersionId ?? null });
        }}><option value="">请选择尺寸 形状等规格</option>{catalog.specifications.filter(value => value.spuId === spuId).map(value => <option key={value.id} value={value.id}>{value.name} · {value.dimensions} · V{value.version}{value.productionReady === false ? " · 生产资料待核对" : ""}{!value.processProfileVersionId ? " · 工艺待绑定" : ""}</option>)}</select>
          {specification && <small>{specification.processProfileVersionId ? `随规格固定工艺 ${specification.processName}` : "该规格需要先绑定已审核的共用工艺底稿"}</small>}
        </label>
        {children}
      </div>
    </details>
  </>;
}
export function OrderArtworkMaterials({
  detail,
  draft,
  dirty = false,
}: {
  detail: OrderWorkDetail;
  draft: OrderWorkDraft;
  dirty?: boolean;
}) {
  const art = detail.catalog?.artworks.find((a) => a.id === draft.artworkVersionId);
  if (!art) return null;
  return (
    <details className="oc-section art-order-materials oc-review-reference" aria-label="本单印花素材">
      <summary>素材与制作说明 <small>{art.materials.length} 个文件</small></summary>
      <p className="oc-hint">{art.code} · 素材 V{art.version}</p>
      <p className="oc-hint">设计阶段使用以下绑定素材。{art.instructions}</p>
      <div className="art-material-list">
        {art.materials.map((m) => (
          <div key={m.assetId}>
            <span>
              <strong>{m.usage}</strong>
              <small>
                {m.fileName} · 文件 V{m.assetVersion}
              </small>
            </span>
            {detail.line.revision > 0 && !dirty ? (
              <a href={`/api/order-centers/lines/${detail.line.id}/artwork-materials/${m.assetId}`}>
                下载原文件
              </a>
            ) : (
              <small>保存匹配后可下载</small>
            )}
          </div>
        ))}
      </div>
      {!!art.customization.fields.length && (
        <p className="oc-hint">
          定制内容：
          {art.customization.fields
            .map((f) => `${f.label}${f.required ? "（必填）" : ""}`)
            .join("、")}
          。选中买家图片后，请核对它对应的图片字段；平台预览不能代替顾客原图。
        </p>
      )}
      <Link href="/print-library">查看印花库</Link>
    </details>
  );
}
