"use client";
import { specificationFactsReady } from "@yummyai/contracts/catalog/development";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import type {
  SalesPlanFields,
  SalesPlanListing,
  SalesPlanOptions,
} from "@yummyai/contracts/catalog/sales-plan";
import { ArtworkFieldsEditor } from "../product-development/artwork-fields-editor";
import { workflowHref } from "../navigation/workflow-href";
import { retainUnlistedReferences } from "./sales-plan-references";

type Props = {
  fields: SalesPlanFields;
  options: SalesPlanOptions;
  spuId: string;
  disabled: boolean;
  current: string;
  change: <K extends keyof SalesPlanFields>(key: K, value: SalesPlanFields[K]) => void;
};
const toggle = (values: string[], id: string, checked: boolean) =>
  checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);
const selectedIds = (select: HTMLSelectElement) =>
  [...select.selectedOptions].map((option) => option.value);
export function SalesPlanProductStep({ fields, options, spuId, change, disabled, current }: Props) {
  const spu = options.spus.find((spu) => spu.id === spuId),
    specs = options.specifications.filter((spec) => spec.spuId === spuId);
  return (
    <>
      <p className="sp-hint">
        商品事实由 SPU 和规格共用。为当前方案选择销售规格；重量未测量时显示待确认。
      </p>
      <dl className="sp-facts">
        <div>
          <dt>加工工艺</dt>
          <dd>{spu?.capabilities?.processes || "待补充"}</dd>
        </div>
        <div>
          <dt>可定制范围</dt>
          <dd>{spu?.capabilities?.customizationScope || "待补充"}</dd>
        </div>
        <div>
          <dt>包装要求</dt>
          <dd>{spu?.capabilities?.packaging || "待补充"}</dd>
        </div>
      </dl>
      <div className="sp-tools">
        <Link
          className="oc-button"
          href={workflowHref(`/product-specifications?spu=${spuId}`, current)}
        >
          维护商品事实与规格
        </Link>
        <Link className="oc-button" href={workflowHref("/process-library", current)}>
          工艺底稿
        </Link>
        <Link className="oc-button" href={workflowHref(`/product-supply?spuId=${spuId}`, current)}>
          供应商与供货
        </Link>
      </div>
      <fieldset disabled={disabled} className="sp-specifications">
        <legend>当前方案销售的规格</legend>
        {specs.map((spec) => (
          <label key={spec.id} className="sp-spec-row">
            <input
              type="checkbox"
              checked={fields.specificationIds.includes(spec.id)}
              onChange={(e) =>
                change(
                  "specificationIds",
                  toggle(fields.specificationIds, spec.id, e.target.checked),
                )
              }
            />
            <div>
              <strong>{spec.name}</strong>
              <p>
                {spec.facts.material} · {spec.facts.dimensions}
              </p>
              <small>
                商品重量：{spec.facts.weightGrams ? `${spec.facts.weightGrams} g` : "待确认"} ·
                含包装重量：
                {spec.facts.packagedWeightGrams ? `${spec.facts.packagedWeightGrams} g` : "待确认"}
              </small>
              <small>
                工艺：{spec.processName || "待绑定"} ·{" "}
                {specificationFactsReady(spec.facts) ? "商品事实已确认" : "商品事实待核实"} · 规格 V
                {spec.version}
              </small>
            </div>
          </label>
        ))}
      </fieldset>
      {!specs.length && (
        <p className="sp-empty">此商品暂无规格，可先保存方案，再到商品库添加尺寸和工艺。</p>
      )}
    </>
  );
}
export function SalesPlanResearchStep({
  fields,
  options,
  change,
  disabled,
  current,
  keywords,
  onKeywords,
}: Props & { keywords: string; onKeywords: (value: string) => void }) {
  return (
    <>
      <p className="sp-hint">围绕这个 SPU 确定卖给谁、用于什么场景，以及采用哪种设计或定制方式。</p>
      <fieldset className="pd-form" disabled={disabled}>
        <label>
          目标人群
          <textarea
            aria-label="目标人群"
            value={fields.audience}
            maxLength={5000}
            onChange={(e) => change("audience", e.target.value)}
            placeholder="例如 需要宠物纪念礼物的主人"
          />
        </label>
        <label>
          使用场景
          <textarea
            aria-label="使用场景"
            value={fields.scenario}
            maxLength={5000}
            onChange={(e) => change("scenario", e.target.value)}
            placeholder="例如 纪念、生日赠礼、家居装饰"
          />
        </label>
        <label>
          卖点与定制方向
          <textarea
            aria-label="卖点与定制方向"
            value={fields.positioning}
            maxLength={5000}
            onChange={(e) => change("positioning", e.target.value)}
          />
        </label>
        <label>
          核心关键词（每行一个）
          <textarea
            aria-label="核心关键词（每行一个）"
            value={keywords}
            maxLength={16000}
            onChange={(e) => onKeywords(e.target.value)}
          />
        </label>
        <label className="pd-wide">
          市场调研结论
          <textarea
            aria-label="市场调研结论"
            value={fields.researchConclusion}
            rows={4}
            maxLength={5000}
            onChange={(e) => change("researchConclusion", e.target.value)}
            placeholder="记录需求依据、竞品差异和为什么采用这个方向。"
          />
        </label>
        <label>
          目标售价
          <input
            type="number"
            min="0"
            step="0.01"
            value={fields.targetPrice?.amount ?? ""}
            onChange={(e) =>
              change(
                "targetPrice",
                e.target.value
                  ? {
                      amount: Number(e.target.value),
                      currency: fields.targetPrice?.currency ?? "USD",
                    }
                  : null,
              )
            }
          />
        </label>
        <label>
          售价币种
          <select
            value={fields.targetPrice?.currency ?? "USD"}
            disabled={!fields.targetPrice}
            onChange={(e) => {
              if (fields.targetPrice)
                change("targetPrice", { ...fields.targetPrice, currency: e.target.value });
            }}
          >
            <option>USD</option>
            <option>EUR</option>
            <option>GBP</option>
            <option>CAD</option>
            <option>JPY</option>
          </select>
        </label>
        <label className="pd-wide">
          关联研究商品
          <select
            aria-label="关联研究商品"
            multiple
            size={5}
            disabled={!options.access.research}
            value={fields.researchItemIds}
            onChange={(e) =>
              change(
                "researchItemIds",
                retainUnlistedReferences(
                  fields.researchItemIds,
                  selectedIds(e.target),
                  options.researchItems.map((item) => item.id),
                ),
              )
            }
          >
            {options.researchItems.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <small>
            {options.access.research
              ? "竞品资料用于研究依据，刊登图片从授权资产中选择。"
              : "当前账号没有研究资料读取权限。"}
          </small>
        </label>
      </fieldset>
      <div className="sp-tools">
        <Link className="oc-button" href={workflowHref("/research", current)}>
          打开研究资料库
        </Link>
        <Link className="oc-button" href={workflowHref("/competitors", current)}>
          竞争店铺
        </Link>
      </div>
    </>
  );
}
export function SalesPlanDesignStep({ fields, options, change, disabled, current }: Props) {
  return (
    <>
      <p className="sp-hint">
        选择可重复使用的印花版本。固定装饰可以和顾客图片、文字方案组合；顾客原图保留在订单中。
      </p>
      <fieldset className="pd-form" disabled={disabled || !options.access.design}>
        <label className="pd-wide">
          印花版本
          <select
            multiple
            size={8}
            value={fields.artworkVersionIds}
            onChange={(e) =>
              change(
                "artworkVersionIds",
                retainUnlistedReferences(
                  fields.artworkVersionIds,
                  selectedIds(e.target),
                  options.artworks
                    .filter((a) => fields.mode !== "standard" || a.mode === "fixed")
                    .map((a) => a.versionId),
                ),
              )
            }
          >
            {options.artworks
              .filter((a) => fields.mode !== "standard" || a.mode === "fixed")
              .map((a) => (
                <option key={a.versionId} value={a.versionId}>
                  {a.code} · {a.name} · v{a.version} ·{" "}
                  {a.mode === "fixed" ? "固定印花" : "顾客定制"}
                </option>
              ))}
          </select>
        </label>
      </fieldset>
      <div className="sp-tools">
        <Link className="oc-button" href={workflowHref("/print-library", current)}>
          登记或修订印花
        </Link>
        <Link className="oc-button" href={workflowHref("/creative-designs/canvas?new=1", current)}>
          创作印花设计
        </Link>
      </div>
      {!options.artworks.length && (
        <p role="status">尚无印花版本，请先登记原创设计或顾客定制方案。</p>
      )}
    </>
  );
}
export function SalesPlanCompositionStep({
  fields,
  options,
  spuId,
  change,
  disabled,
  current,
}: Props) {
  const skus = options.skus.filter((s) => s.spuId === spuId);
  const selected = skus.filter((s) => fields.skuIds.includes(s.id));
  return (
    <>
      <p className="sp-hint">
        每个销售 SKU 固定一个规格和完整印花组合。选款用于顾客挑选图案；不同制作面和区域在 SKU
        配方中登记。
      </p>
      <fieldset className="pd-form" disabled={disabled}>
        <label className="pd-wide">
          关联销售 SKU
          <select
            multiple
            size={7}
            value={fields.skuIds}
            onChange={(e) => {
              change(
                "skuIds",
                retainUnlistedReferences(
                  fields.skuIds,
                  selectedIds(e.target),
                  skus.map((s) => s.id),
                ),
              );
              change("patternChoices", undefined);
            }}
          >
            {skus.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {Object.values(s.attributes).join(" / ")}
              </option>
            ))}
          </select>
        </label>
        {fields.mode === "custom" && (
          <label>
            图案销售方式
            <select
              value={fields.patternChoices ? "choice" : "composition"}
              onChange={(e) =>
                change(
                  "patternChoices",
                  e.target.value === "choice"
                    ? {
                        fieldKey: "print_style",
                        options: selected.map((s) => ({
                          skuId: s.id,
                          value: s.code,
                          label: s.code,
                        })),
                      }
                    : undefined,
                )
              }
            >
              <option value="composition">同一印花组合，按规格销售</option>
              <option value="choice" disabled={selected.length < 2}>
                多个图案供顾客选款（Amazon Custom）
              </option>
            </select>
          </label>
        )}
        {fields.patternChoices && (
          <>
            <label>
              Custom 选款字段
              <input
                value={fields.patternChoices.fieldKey}
                maxLength={80}
                onChange={(e) =>
                  change("patternChoices", { ...fields.patternChoices!, fieldKey: e.target.value })
                }
              />
            </label>
            {fields.patternChoices.options.map((choice, i) => (
              <div key={choice.skuId} className="pd-wide sp-choice-row">
                <span>{skus.find((s) => s.id === choice.skuId)?.code}</span>
                <label>
                  选款值
                  <input
                    value={choice.value}
                    maxLength={120}
                    onChange={(e) =>
                      change("patternChoices", {
                        ...fields.patternChoices!,
                        options: fields.patternChoices!.options.map((c, n) =>
                          n === i ? { ...c, value: e.target.value } : c,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  顾客看到的名称
                  <input
                    value={choice.label}
                    maxLength={120}
                    onChange={(e) =>
                      change("patternChoices", {
                        ...fields.patternChoices!,
                        options: fields.patternChoices!.options.map((c, n) =>
                          n === i ? { ...c, label: e.target.value } : c,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
            <p className="pd-wide">
              封存时保留选款与销售 SKU 映射；渠道登记必须填写同一选款值，订单按下单时间匹配。
            </p>
          </>
        )}
      </fieldset>
      <div className="sp-tools">
        <Link
          className="oc-button"
          href={workflowHref(`/product-development?spuId=${spuId}`, current)}
        >
          组合印花、规格与制作区域
        </Link>
      </div>
      {!selected.length && <p role="status">尚未关联销售 SKU，完成组合后返回此处选择。</p>}
    </>
  );
}
export function SalesPlanContentStep(props: Props) {
  const { fields, options, spuId, change, disabled, current } = props;
  const [assetQuery, setAssetQuery] = useState("");
  const assets = options.assets.filter((asset) =>
    asset.fileName.toLowerCase().includes(assetQuery.toLowerCase()),
  );
  const selectedAssets = fields.mediaAssetIds.flatMap((id) => {
    const asset = options.assets.find((candidate) => candidate.id === id);
    return asset ? [asset] : [];
  });
  const shownAssets = [
    ...selectedAssets,
    ...assets.filter((asset) => !fields.mediaAssetIds.includes(asset.id)).slice(0, 24),
  ];
  const skus = options.skus.filter((sku) => sku.spuId === spuId);
  return (
    <>
      <div className="sp-tools">
        <Link
          className="oc-button"
          href={workflowHref(
            fields.creativeProjectId
              ? `/content-projects?project=${fields.creativeProjectId}`
              : "/content-projects",
            current,
          )}
        >
          商品图文项目
        </Link>
        <Link className="oc-button" href={workflowHref("/creative-designs/canvas?new=1", current)}>
          新建创意需求
        </Link>
        <Link className="oc-button" href={workflowHref("/pod-workbench/mockup-batches", current)}>
          制作商品套图
        </Link>
        <Link className="oc-button" href={workflowHref("/creative-designs/studio/assets", current)}>
          上传与管理资产
        </Link>
      </div>
      <fieldset className="pd-form" disabled={disabled}>
        <label className="pd-wide">
          标题
          <input
            value={fields.title}
            maxLength={1000}
            onChange={(e) => change("title", e.target.value)}
          />
        </label>
        <label className="pd-wide">
          五点描述（每行一点）
          <textarea
            aria-label="五点描述（每行一点）"
            value={fields.bullets.join("\n")}
            rows={5}
            maxLength={20000}
            onChange={(e) => change("bullets", e.target.value.split("\n"))}
          />
        </label>
        <label className="pd-wide">
          商品描述
          <textarea
            aria-label="商品描述"
            value={fields.description}
            rows={5}
            maxLength={20000}
            onChange={(e) => change("description", e.target.value)}
          />
        </label>
        <label>
          关联图文项目
          <select
            value={fields.creativeProjectId ?? ""}
            disabled={!options.access.design}
            onChange={(e) => change("creativeProjectId", e.target.value || null)}
          >
            <option value="">尚未关联</option>
            {fields.creativeProjectId &&
              !options.projects.some((project) => project.id === fields.creativeProjectId) && (
                <option value={fields.creativeProjectId} disabled>
                  原关联项目当前不可选择
                </option>
              )}
            {options.projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          关联印花版本
          <select
            multiple
            size={4}
            value={fields.artworkVersionIds}
            disabled={!options.access.design}
            onChange={(e) =>
              change(
                "artworkVersionIds",
                retainUnlistedReferences(
                  fields.artworkVersionIds,
                  selectedIds(e.target),
                  options.artworks
                    .filter((art) => fields.mode !== "standard" || art.mode === "fixed")
                    .map((art) => art.versionId),
                ),
              )
            }
          >
            {options.artworks
              .filter((art) => (fields.mode === "standard" ? art.mode === "fixed" : true))
              .map((art) => (
                <option key={art.versionId} value={art.versionId}>
                  {art.name} · {art.code} · V{art.version}
                </option>
              ))}
          </select>
          <small>采用的印花版本独立保存；买家来图款可以先准备定制方案。</small>
        </label>
        <label className="pd-wide">
          销售 SKU
          <select
            multiple
            size={4}
            value={fields.skuIds}
            onChange={(e) => {
              change(
                "skuIds",
                retainUnlistedReferences(
                  fields.skuIds,
                  selectedIds(e.target),
                  skus.map((sku) => sku.id),
                ),
              );
              change("patternChoices", undefined);
            }}
          >
            {skus.map((sku) => (
              <option key={sku.id} value={sku.id}>
                {sku.code} · {Object.values(sku.attributes).join(" / ")}
              </option>
            ))}
          </select>
          <small>可先保存图文，规格和设计确定后再关联销售 SKU。</small>
        </label>
      </fieldset>
      <div className="sp-tools">
        <Link
          className="oc-button"
          href={workflowHref(`/product-development?spuId=${spuId}`, current)}
        >
          生成与维护销售 SKU
        </Link>
        <Link className="oc-button" href={workflowHref("/print-library", current)}>
          印花库与版本
        </Link>
      </div>
      <section className="sp-media" aria-label="刊登图片">
        <h3>刊登图片</h3>
        <label>
          查找授权图片
          <input
            value={assetQuery}
            onChange={(e) => setAssetQuery(e.target.value)}
            placeholder="按文件名搜索"
          />
        </label>
        {!options.access.assets ? (
          <p role="status">当前账号没有素材读取权限。</p>
        ) : !options.assets.length ? (
          <p>暂无已审核的授权图片。上传并确认素材权利后，在这里选择。</p>
        ) : (
          <>
            <p className="sp-caption">
              已选 {fields.mediaAssetIds.length} 张 · 找到 {assets.length} 张
              {assets.length > 24 ? "，请输入文件名缩小范围" : ""}· 已选图片始终保留显示
            </p>
            <div className="sp-asset-list">
              {shownAssets.map((asset) => (
                <label key={asset.id}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={fields.mediaAssetIds.includes(asset.id)}
                    onChange={(e) => {
                      const ids = toggle(fields.mediaAssetIds, asset.id, e.target.checked);
                      change("mediaAssetIds", ids);
                      if (!e.target.checked && fields.mainImageId === asset.id)
                        change("mainImageId", null);
                    }}
                  />
                  <Image
                    width={72}
                    height={72}
                    unoptimized
                    src={`/api/product-development/assets/${asset.id}/preview`}
                    alt={asset.fileName}
                  />
                  <span>{asset.fileName}</span>
                </label>
              ))}
            </div>
          </>
        )}
        <label>
          主图
          <select
            value={fields.mainImageId ?? ""}
            disabled={disabled || !options.access.assets}
            onChange={(e) => change("mainImageId", e.target.value || null)}
          >
            <option value="">尚未指定主图</option>
            {fields.mediaAssetIds.map((id) => (
              <option key={id} value={id}>
                {options.assets.find((asset) => asset.id === id)?.fileName ??
                  "原关联图片当前不可读取"}
              </option>
            ))}
          </select>
        </label>
      </section>
      {fields.mode === "custom" && (
        <section className="sp-custom" aria-label="Custom 选项与素材">
          <h3>Custom 选项与素材</h3>
          <p className="sp-hint">
            准备买家可填写或选择的内容、说明和选项图片。订单的最终生产图在接单后制作。
          </p>
          <ArtworkFieldsEditor
            value={fields.customization}
            layout={fields.layout}
            disabled={disabled}
            onChange={(customization, layout) => {
              change("customization", customization);
              change("layout", layout);
              change(
                "customMaterials",
                fields.customMaterials
                  .filter(
                    (material) =>
                      !material.fieldKey ||
                      customization.fields.some((field) => field.key === material.fieldKey),
                  )
                  .map((material) => {
                    const field = customization.fields.find(
                      (field) => field.key === material.fieldKey,
                    );
                    return material.optionValue &&
                      (!field ||
                        !("options" in field) ||
                        !field.options.some((option) => option.value === material.optionValue))
                      ? { ...material, optionValue: "" }
                      : material;
                  }),
              );
            }}
            previewPath={
              fields.mainImageId && options.assets.some((asset) => asset.id === fields.mainImageId)
                ? `/api/product-development/assets/${fields.mainImageId}/preview`
                : undefined
            }
          />
          <label>
            定制说明与验收要求
            <textarea
              rows={4}
              disabled={disabled}
              maxLength={5000}
              value={fields.customInstructions}
              onChange={(e) => change("customInstructions", e.target.value)}
            />
          </label>
          <h4>Custom 选项图片</h4>
          {fields.customMaterials.map((material, index) => (
            <div className="sp-material-row" key={index}>
              <label>
                图片用途
                <input
                  disabled={disabled}
                  maxLength={160}
                  value={material.label}
                  onChange={(e) =>
                    change(
                      "customMaterials",
                      fields.customMaterials.map((m, i) =>
                        i === index ? { ...m, label: e.target.value } : m,
                      ),
                    )
                  }
                />
              </label>
              <label>
                关联字段
                <select
                  disabled={disabled}
                  value={material.fieldKey}
                  onChange={(e) =>
                    change(
                      "customMaterials",
                      fields.customMaterials.map((m, i) =>
                        i === index ? { ...m, fieldKey: e.target.value, optionValue: "" } : m,
                      ),
                    )
                  }
                >
                  <option value="">通用说明图片</option>
                  {fields.customization.fields.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                授权图片
                <select
                  disabled={disabled || !options.access.assets}
                  value={material.assetId}
                  onChange={(e) =>
                    change(
                      "customMaterials",
                      fields.customMaterials.map((m, i) =>
                        i === index ? { ...m, assetId: e.target.value } : m,
                      ),
                    )
                  }
                >
                  {!options.assets.some((asset) => asset.id === material.assetId) && (
                    <option value={material.assetId} disabled>
                      原关联图片当前不可选择
                    </option>
                  )}
                  {options.assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.fileName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                对应选项
                <select
                  disabled={disabled}
                  value={material.optionValue}
                  onChange={(e) =>
                    change(
                      "customMaterials",
                      fields.customMaterials.map((m, i) =>
                        i === index ? { ...m, optionValue: e.target.value } : m,
                      ),
                    )
                  }
                >
                  <option value="">字段通用图片</option>
                  {fields.customization.fields
                    .filter((field) => field.key === material.fieldKey)
                    .flatMap((field) => ("options" in field ? field.options : []))
                    .map((option) => (
                      <option value={option.value} key={option.value}>
                        {option.label}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="oc-button"
                disabled={disabled}
                onClick={() =>
                  change(
                    "customMaterials",
                    fields.customMaterials.filter((_, i) => i !== index),
                  )
                }
              >
                移除
              </button>
            </div>
          ))}
          <button
            className="oc-button"
            disabled={disabled || !options.assets.length}
            onClick={() => {
              const asset = options.assets[0];
              if (asset)
                change("customMaterials", [
                  ...fields.customMaterials,
                  { label: "Custom 选项图", fieldKey: "", assetId: asset.id, optionValue: "" },
                ]);
            }}
          >
            添加选项图片
          </button>
        </section>
      )}
    </>
  );
}
export function SalesPlanListingStep({
  fields,
  options,
  change,
  disabled,
  current,
  listings,
  planRevision,
  dirty,
  listingAccess,
  onDraft,
  draftDisabledReason,
}: Props & {
  listings: SalesPlanListing[];
  planRevision: number;
  dirty: boolean;
  listingAccess: boolean;
  onDraft: () => void;
  draftDisabledReason?: string;
}) {
  const target = listings.find(
    (listing) => listing.marketplaceId === fields.marketplaceId && listing.locale === fields.locale,
  );
  function downloadGuide() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            kind: "amazon-custom-configuration-draft",
            planRevision,
            name: fields.name,
            instructions: fields.customInstructions,
            customization: fields.customization,
            layout: fields.layout,
            materials: fields.customMaterials.map((material) => ({
              ...material,
              fileName:
                options.assets.find((asset) => asset.id === material.assetId)?.fileName ?? null,
            })),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const href = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = href;
    link.download = `custom-config-v${planRevision}.json`;
    link.click();
    URL.revokeObjectURL(href);
  }
  return (
    <>
      <p className="sp-hint">
        先保存本地草稿，再进入刊登编辑器核对类目字段、审核和导出。平台校验通过、实际提交和确认可售分别显示。
      </p>
      <fieldset disabled={disabled} className="pd-form">
        <label>
          目标店铺
          <select
            value={fields.accountId ?? ""}
            onChange={(e) => change("accountId", e.target.value || null)}
          >
            <option value="">尚未选择店铺</option>
            {fields.accountId &&
              !options.accounts.some((account) => account.id === fields.accountId) && (
                <option value={fields.accountId} disabled>
                  原关联店铺当前不可选择
                </option>
              )}
            {options.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.displayName}
              </option>
            ))}
          </select>
          <small>本地草稿可先建立；实际提交需要店铺授权及刊登权限。</small>
        </label>
        <label>
          Amazon 站点编号
          <input
            value={fields.marketplaceId}
            maxLength={80}
            onChange={(e) => change("marketplaceId", e.target.value)}
          />
        </label>
        <label>
          刊登语言
          <input
            value={fields.locale}
            maxLength={20}
            onChange={(e) => change("locale", e.target.value)}
          />
        </label>
        <label>
          产品类型
          <input
            value={fields.productType}
            maxLength={120}
            onChange={(e) => change("productType", e.target.value.toUpperCase())}
            placeholder="在店铺类目能力中确认后填写"
          />
          <small>保存类型记录后，在刊登编辑器核对当前类目所需字段。</small>
        </label>
      </fieldset>
      <div className="sp-tools">
        <button
          className="oc-button primary"
          disabled={
            !!draftDisabledReason ||
            dirty ||
            !options.access.listingWrite ||
            (!!target && target.status !== "draft")
          }
          onClick={onDraft}
        >
          {target ? "同步为草稿新版本" : "创建刊登草稿"}
        </button>
        <Link className="oc-button" href={workflowHref("/stores", current)}>
          店铺授权与类目能力
        </Link>
      </div>
      {dirty && <p className="sp-hint">请先保存当前方案，再创建或同步刊登草稿。</p>}
      {draftDisabledReason && <p className="sp-hint">{draftDisabledReason}</p>}
      {!listingAccess && <p role="status">当前账号没有刊登读取权限。</p>}
      {listings.map((listing) => (
        <article className="sp-listing" key={listing.id}>
          <div>
            <h3>{listing.title || "未填写标题的刊登草稿"}</h3>
            <p>
              {listing.marketplaceId} · {listing.locale} · 刊登 V{listing.version} ·{" "}
              {listing.status === "draft"
                ? "本地草稿"
                : listing.status === "approved"
                  ? "内部已审核"
                  : listing.status === "archived"
                    ? "已归档"
                    : "评审中"}
            </p>
            <p>
              来自方案第 {listing.planRevision ?? "未知"} 版 · 当前方案第 {planRevision} 版
              {listing.planRevision !== planRevision ? "，请核对内容变化" : ""}
            </p>
          </div>
          <Link
            className="oc-button"
            href={workflowHref(
              `/listings/${listing.id}?${new URLSearchParams({ ...(fields.accountId ? { accountId: fields.accountId } : {}), marketplaceId: listing.marketplaceId ?? fields.marketplaceId })}`,
              current,
            )}
          >
            编辑、审核与平台提交
          </Link>
          <details>
            <summary>
              {listing.blockers.length} 个刊登缺项 · 完整度 {listing.completeness}%
            </summary>
            <ul>
              {listing.blockers.map((blocker, index) => (
                <li key={index}>{blocker}</li>
              ))}
            </ul>
          </details>
        </article>
      ))}
      {fields.mode === "custom" ? (
        <section className="sp-custom-page">
          <h3>Custom 页面配置</h3>
          <p>使用选项定义、说明和图片完成平台配置，然后记录人工核验依据。</p>
          <fieldset className="pd-form" disabled={disabled}>
            <label>
              配置进度
              <select
                value={fields.customPage.status}
                onChange={(e) =>
                  change("customPage", {
                    ...fields.customPage,
                    status: e.target.value as typeof fields.customPage.status,
                  })
                }
              >
                <option value="not_configured">待平台配置</option>
                <option value="needs_verification">已配置，待核验</option>
                <option value="verified">人工已核验</option>
              </select>
            </label>
            <label>
              核验依据
              <textarea
                value={fields.customPage.evidence}
                maxLength={3000}
                onChange={(e) =>
                  change("customPage", { ...fields.customPage, evidence: e.target.value })
                }
                placeholder="记录对应 ASIN、核验日期、人员与结果"
              />
            </label>
          </fieldset>
          <button
            className="oc-button"
            disabled={dirty || !options.access.assets}
            onClick={downloadGuide}
          >
            下载 Custom 配置草稿
          </button>
          <small>配置草稿供人工操作参考，正式资料包仍需审核与封存。</small>
        </section>
      ) : fields.fulfillment === "fba" ? (
        <section>
          <h3>FBA 备货衔接</h3>
          <p>核对固定设计、各规格包装尺寸与重量，再安排采购和备货。补货与刊登进度分别管理。</p>
          <div className="sp-tools">
            <Link className="oc-button" href={workflowHref("/procurement", current)}>
              采购与备货
            </Link>
            <Link className="oc-button" href={workflowHref("/channel-inventory", current)}>
              渠道库存
            </Link>
          </div>
        </section>
      ) : (
        <p className="sp-hint">此方案采用标品 FBM，自有库存与发货安排在库存和履约模块维护。</p>
      )}
    </>
  );
}
