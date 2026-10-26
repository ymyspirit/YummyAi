"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Layers3, Settings2 } from "lucide-react";
import type { OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { orderDesignExecutor } from "@yummyai/contracts/order/workspace";
import { orderAutomaticBasisView, orderCatalogSpus } from "./order-auto-basis-model";
import { orderDraftWithArtwork } from "./order-work-input-model";

export function OrderArtworkBasis({ detail, draft, onChange, children }: {
  detail: OrderWorkDetail;
  draft: OrderWorkDraft;
  onChange: (draft: OrderWorkDraft) => void;
  children?: ReactNode;
}) {
  const [selectedSpu, setSelectedSpu] = useState({ lineId: detail.line.id, id: "" });
  const [manualOpen, setManualOpen] = useState(!detail.catalog?.automatic?.applied && detail.catalog?.automatic?.status !== "preserved");
  const catalog = detail.catalog;
  if (!catalog) return <><p className="oc-hint oc-full-field" role="status">本单制作依据暂不可读取 请保留原需求并刷新核对</p>{children}</>;
  const view = orderAutomaticBasisView(detail, draft), { recipe, specification } = view;
  const art = catalog.artworks.find(value => value.id === (draft.artworkVersionId ?? recipe?.artworkVersionId));
  const spuId = specification?.spuId ?? (selectedSpu.lineId === detail.line.id ? selectedSpu.id : "");
  const spus = orderCatalogSpus(catalog);
  const spu = view.spu ?? spus.find(value => value.id === spuId);
  function artwork(id: string) {
    onChange(orderDraftWithArtwork(draft, id, recipe?.artworkVersionId));
  }
  return <>
    <section className={`oc-basis-summary ${view.tone}`} aria-label="本单制作依据匹配">
      <header><span>{view.tone === "warning" ? <AlertTriangle size={16} /> : <Layers3 size={16} />}<strong>{view.title}</strong></span>
        <small>{view.changed || view.automatic?.applied ? "待保存到本单需求" : detail.line.revision > 0 ? `本单需求 V${detail.line.revision}` : "待核对并保存"}</small></header>
      <dl>
        <div><dt>产品 SPU</dt><dd>{spu ? `${spu.code} · ${spu.name}` : "待明确产品"}</dd></div>
        <div><dt>具体规格</dt><dd>{specification ? `${specification.name} · V${specification.version}` : "待明确具体规格"}{specification?.dimensions && <small>{specification.dimensions}</small>}</dd></div>
        <div><dt>通用工艺底稿</dt><dd>{view.process}</dd></div>
        <div><dt>印花与素材</dt><dd>{art ? `${art.code} · ${art.name} · V${art.version}` : "来图方案待确认"}</dd></div>
      </dl>
      {!!view.issues.length && <ul className="oc-basis-issues" aria-label="制作依据待办">{view.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      {view.automatic && <details className="oc-basis-evidence"><summary>{view.changed ? "查看原自动匹配依据 当前已改选" : "查看本次匹配依据"}</summary>
        {view.automatic.sizeInches !== null && <p>定制信息中的尺寸 {view.automatic.sizeInches} in</p>}
        {!!view.automatic.reasons.length && <ul>{view.automatic.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        {view.changed && !!view.automatic.issues.length && <ul>{view.automatic.issues.map((issue, index) => <li key={index}>原匹配提示 {issue}</li>)}</ul>}
        {!view.automatic.reasons.length && <p>当前没有额外匹配说明</p>}
      </details>}
      <p className="oc-basis-note">匹配只准备制作依据 保存审单与派发时仍会核对固定版本 不代表图稿已审核或已放行生产</p>
      {(view.issues.length > 0 || !spus.length || !specification) && <Link className="oc-basis-link" data-task-draft-link href={spuId ? `/product-specifications?spu=${spuId}` : "/product-specifications"}>到商品库核对 SPU 规格与已审核底稿</Link>}
    </section>
    <details className="oc-basis-manual" open={manualOpen} onToggle={event => setManualOpen(event.currentTarget.open)}>
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
    <label>设计执行方式<select aria-label="设计执行方式" value={orderDesignExecutor(draft)} onChange={event => onChange({ ...draft, designExecutor: event.target.value as "human" | "agent" })}>
      <option value="agent">无人设计 Agent（默认）</option><option value="human">美工领取制作</option>
    </select><small>{orderDesignExecutor(draft) === "agent" ? "派发后自动准备模板排版并美化顾客图片，生成待核对草稿；复杂要求会提示处理，运营审核后才能生产。" : "派发后由美工领取，系统准备素材并自动美化顾客图片，运营审核后才能生产。"}</small>
      <small>所有顾客图片统一保真美化，与顾客是否选择美化无关。保留原图及原始选项，核对人物、宠物外貌和特征。</small>
    </label>
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
    <section className="oc-section art-order-materials" aria-label="本单印花素材">
      <div className="oc-section-heading">
        <strong>
          {art.code} · 素材 V{art.version}
        </strong>
        <span>{art.materials.length} 个文件</span>
      </div>
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
    </section>
  );
}
