"use client";
import Image from "next/image";
import type {
  ArtworkView,
  DevelopmentOptions,
  DevelopmentWorkspace,
} from "@yummyai/contracts/catalog/development";
import { modes, statuses } from "./development-client";
import { Permission } from "@yummyai/authz/permissions";
import { useErpAccess } from "../identity/erp-access";
import { boundSpecificationAxes } from "./specification-options";
import { orderedSpecifications } from "./specification-presentation";
import "./spu-catalog-summary.css";

export function ArtworkTable({
  items,
  options,
  selected,
  archived,
  busy,
  onOpen,
  onEdit,
  onCompose,
  onArchive,
}: {
  items: ArtworkView[];
  options: DevelopmentOptions;
  selected: string | null;
  archived: boolean;
  busy: boolean;
  onOpen: (item: ArtworkView) => void;
  onEdit: (item: ArtworkView) => void;
  onCompose: (item: ArtworkView) => void;
  onArchive: (item: ArtworkView) => void;
}) {
  const { can, canAll } = useErpAccess();
  const canWrite = can(Permission.ProductWrite);
  return (
    <div className="pd-table pd-record-table">
      <table aria-label="印花列表">
        <thead>
          <tr>
            <th>印花 SKU</th>
            <th>名称 / 模式</th>
            <th>来源</th>
            <th>版本</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              id={`artwork-${item.id}`}
              aria-current={item.id === selected ? "true" : undefined}
            >
              <td data-label="印花 SKU">
                {item.assetId && (
                  <Image
                    unoptimized
                    className="pd-thumb"
                    src={`/api/product-development/assets/${item.assetId}/preview`}
                    width={48}
                    height={48}
                    alt={item.name}
                  />
                )}
                <strong>{item.code}</strong>
              </td>
              <td data-label="名称 / 模式">
                {item.name}
                <small>
                  {modes[item.mode]} · {item.tags.join(" / ")}
                </small>
                <button className="oc-button pd-notes-toggle" onClick={() => onOpen(item)}>
                  制作说明与素材（{item.materials.length}）
                </button>
              </td>
              <td data-label="来源">
                {item.creativeVersionId
                  ? (options.creativeVersions.find(
                      (version) => version.id === item.creativeVersionId,
                    )?.name ?? "历史审核创意")
                  : "无固定主图 · 定制方案"}
                <small>{item.researchItemIds.length} 条研究来源</small>
              </td>
              <td data-label="版本">V{item.version}</td>
              <td data-label="操作">
                {!archived && canWrite && (
                  <>
                    <button className="oc-button" onClick={() => onCompose(item)}>
                      组合商品
                    </button>
                    {canAll([Permission.ProductWrite, Permission.DesignReview], {
                      ownerId: item.ownerUserId,
                      teamId: item.teamId,
                    }) && (
                      <button className="oc-button" onClick={() => onEdit(item)}>
                        修改印花
                      </button>
                    )}
                  </>
                )}
                {can(Permission.ProductWrite, {
                  ownerId: item.ownerUserId,
                  teamId: item.teamId,
                }) && (
                  <button className="oc-button" disabled={busy} onClick={() => onArchive(item)}>
                    {archived ? "恢复印花" : "归档印花"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <p className="pd-empty">
          {archived
            ? "暂无已归档印花。"
            : "暂无印花。可登记已审核的固定图案，或创建无固定主图的来图定制方案。"}
        </p>
      )}
    </div>
  );
}

export function SpuTable({
  items,
  options,
  onOpen,
}: {
  items: DevelopmentOptions["spus"];
  options: DevelopmentOptions;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="pd-table pd-record-table">
      <table aria-label="SPU 列表">
        <thead>
          <tr>
            <th>商品 SPU</th>
            <th>产品名称</th>
            <th>规格</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const variants = orderedSpecifications(options.specifications.filter((spec) => spec.spuId === item.id));
            const axes = boundSpecificationAxes(variants);
            const preview = axes.length
              ? axes.map(axis => `${axis.name} ${axis.values.slice(0, 4).join("、")}${axis.values.length > 4 ? ` 等 ${axis.values.length} 项` : ""}`).join(" · ")
              : variants.slice(0, 2).map(spec => spec.name).join(" / ");
            const allOptions = axes.length
              ? axes.map(axis => `${axis.name} ${axis.values.join("、")}`).join("；")
              : variants.map(spec => spec.name).join(" / ");
            return (
              <tr key={item.id}>
                <td data-label="商品 SPU">
                  <strong>{item.code}</strong>
                </td>
                <td data-label="产品名称">{item.name}</td>
                <td data-label="规格">
                  <div className="pd-spu-variant-summary">
                    <span className="pd-spu-variant-count">{variants.length} 个规格</span>
                    <small className="pd-spu-option-preview" title={allOptions || undefined}>{preview || "待完善"}</small>
                  </div>
                </td>
                <td data-label="操作">
                  <button className="oc-button" onClick={() => onOpen(item.id)}>
                    查看产品与规格
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!items.length && (
        <p className="pd-empty">没有符合条件的 SPU。可调整搜索，或新增产品档案。</p>
      )}
    </div>
  );
}

export function SalesSkuTable({
  workspace,
  onOpen,
}: {
  workspace: DevelopmentWorkspace;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="pd-table pd-record-table">
      <table aria-label="销售 SKU 列表">
        <thead>
          <tr>
            <th>销售 SKU</th>
            <th>印花</th>
            <th>SPU / 规格</th>
            <th>进度</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {workspace.items.map((item) => (
            <tr key={item.skuId}>
              <td data-label="销售 SKU">
                <strong>{item.skuCode}</strong>
              </td>
              <td data-label="印花">
                {item.recipe?.artwork.code ?? "待映射"}
                <small>{item.recipe?.artwork.name}</small>
              </td>
              <td data-label="SPU / 规格">
                {item.spuCode}
                <small>
                  {item.recipe?.specification.name ?? Object.values(item.attributes).join(" / ")}
                </small>
              </td>
              <td data-label="进度">
                {item.recipe ? statuses[item.recipe.status] : "待映射"}
                <small>
                  {item.packageCount} 个资料包{item.recipe?.needsUpdate ? " · 来源有新版本" : ""}
                </small>
              </td>
              <td data-label="操作">
                <button className="oc-button" onClick={() => onOpen(item.skuId)}>
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!workspace.items.length && (
        <p className="pd-empty">没有符合条件的销售 SKU。可调整筛选，或组合印花与规格。</p>
      )}
    </div>
  );
}
