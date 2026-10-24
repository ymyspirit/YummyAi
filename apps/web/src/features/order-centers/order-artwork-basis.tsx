"use client";
import { useState } from "react";
import Link from "next/link";
import type { OrderWorkDetail, OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import { orderDesignExecutor } from "@yummyai/contracts/order/workspace";

export function OrderArtworkBasis({
  detail,
  draft,
  onChange,
}: {
  detail: OrderWorkDetail;
  draft: OrderWorkDraft;
  onChange: (draft: OrderWorkDraft) => void;
}) {
  const [spu, setSpu] = useState("");
  const catalog = detail.catalog;
  if (!catalog) return null;
  const recipe = catalog.recipes.find((r) => r.id === draft.salesRecipeVersionId);
  const specification = catalog.specifications.find(
    (s) => s.id === (draft.specificationVersionId ?? recipe?.specificationVersionId),
  );
  const spuId = specification?.spuId ?? spu;
  const spus = [...new Map(catalog.specifications.map((s) => [s.spuId, s])).values()];
  function artwork(id: string) {
    const art = catalog!.artworks.find((a) => a.id === id);
    const added =
      art?.customization.fields
        .filter(
          (f) =>
            f.type !== "image" && !draft.fields.some((v) => v.key === f.key || v.label === f.label),
        )
        .map((f) => ({ key: f.key, label: f.label, kind: "text" as const, value: "" })) ?? [];
    onChange({ ...draft, artworkVersionId: id || null, fields: [...draft.fields, ...added],
      ...(id !== recipe?.artworkVersionId ? { salesRecipeVersionId: null, salesPackageId: null } : {}),
    });
  }
  return (
    <>
      <label>
        销售 SKU 自动匹配
        <select
          aria-label="销售 SKU 制作版本"
          value={draft.salesRecipeVersionId ?? ""}
          onChange={(e) => {
            const r = catalog.recipes.find((r) => r.id === e.target.value);
            onChange({
              ...draft,
              salesRecipeVersionId: r?.id ?? null,
              salesPackageId: null,
              artworkVersionId: r?.artworkVersionId ?? draft.artworkVersionId,
              specificationVersionId: r?.specificationVersionId ?? draft.specificationVersionId,
              printProfileVersionId: r?.processProfileVersionId ?? draft.printProfileVersionId,
            });
          }}
        >
          <option value="">直接匹配印花与 SPU 规格</option>
          {catalog.recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.skuCode} · {r.spuCode} / {r.specification} · V{r.version}
            </option>
          ))}
        </select>
        <small>已有渠道映射会自动带入，也可以为本单直接指定下面的印花和规格。</small>
        {catalog.channelRecipeId && catalog.channelPackageId && <button type="button" className="oc-button" onClick={() => {
          const channel = catalog.recipes.find(r => r.id === catalog.channelRecipeId);
          if (!channel) return;
          onChange({ ...draft, salesRecipeVersionId: channel.id, salesPackageId: catalog.channelPackageId,
            artworkVersionId: channel.artworkVersionId, specificationVersionId: channel.specificationVersionId,
            printProfileVersionId: channel.processProfileVersionId });
        }}>使用下单时渠道映射</button>}
      </label>
      <label>
        本单印花 SKU
        <select
          aria-label="本单印花版本"
          value={draft.artworkVersionId ?? recipe?.artworkVersionId ?? ""}
          onChange={(e) => artwork(e.target.value)}
        >
          <option value="">请选择印花及素材版本</option>
          {catalog.artworks.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name} · V{a.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        产品 SPU
        <select
          aria-label="本单产品 SPU"
          value={spuId}
          onChange={(e) => {
            setSpu(e.target.value);
            onChange({
              ...draft,
              salesRecipeVersionId: null,
              salesPackageId: null,
              specificationVersionId: null,
              printProfileVersionId: null,
            });
          }}
        >
          <option value="">请选择产品</option>
          {spus.map((s) => (
            <option key={s.spuId} value={s.spuId}>
              {s.spuCode} · {s.spuName}
            </option>
          ))}
        </select>
      </label>
      <label>
        具体规格
        <select
          aria-label="本单产品规格"
          disabled={!spuId}
          value={draft.specificationVersionId ?? recipe?.specificationVersionId ?? ""}
          onChange={(e) => {
            const s = catalog.specifications.find((s) => s.id === e.target.value);
            onChange({
              ...draft,
              salesRecipeVersionId: null,
              salesPackageId: null,
              specificationVersionId: s?.id ?? null,
              printProfileVersionId: s?.processProfileVersionId ?? null,
            });
          }}
        >
          <option value="">请选择尺寸、形状等规格</option>
          {catalog.specifications
            .filter((s) => s.spuId === spuId)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.dimensions} · V{s.version}
              </option>
            ))}
        </select>
        {specification && <small>工艺自动带入：{specification.processName}</small>}
      </label>
      <label>
        设计执行方式
        <select
          aria-label="设计执行方式"
          value={orderDesignExecutor(draft)}
          onChange={(e) =>
            onChange({ ...draft, designExecutor: e.target.value as "human" | "agent" })
          }
        >
          <option value="agent">无人设计 Agent（默认）</option>
          <option value="human">美工领取制作</option>
        </select>
        <small>
          {orderDesignExecutor(draft) === "agent"
            ? "派发后自动准备模板排版并美化顾客图片，生成待核对草稿；复杂要求会提示处理，运营审核后才能生产。"
            : "派发后由美工领取，系统准备素材并自动美化顾客图片，运营审核后才能生产。"}
        </small>
        <small>所有顾客图片统一保真美化，与顾客是否选择美化无关。保留原图及原始选项，核对人物、宠物外貌和特征。</small>
      </label>
    </>
  );
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
          。选中买家图片时，用途填写对应的图片字段名称。
        </p>
      )}
      <datalist id="order-image-usages">
        {art.customization.fields
          .filter((f) => f.type === "image")
          .map((f) => (
            <option key={f.key} value={f.label} />
          ))}
      </datalist>
      <Link href="/print-library">查看印花库</Link>
    </section>
  );
}
