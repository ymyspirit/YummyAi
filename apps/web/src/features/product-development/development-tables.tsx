"use client";
import Image from "next/image";
import type {
  ArtworkView,
  DevelopmentOptions,
  DevelopmentWorkspace,
} from "@yummyai/contracts/catalog/development";
import { modes, statuses } from "./development-client";

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
  return (
    <div className="pd-table">
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
              <td>
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
              <td>
                {item.name}
                <small>
                  {modes[item.mode]} · {item.tags.join(" / ")}
                </small>
                <button className="oc-button pd-notes-toggle" onClick={() => onOpen(item)}>
                  制作说明与素材（{item.materials.length}）
                </button>
              </td>
              <td>
                {item.creativeVersionId
                  ? (options.creativeVersions.find(
                      (version) => version.id === item.creativeVersionId,
                    )?.name ?? "历史审核创意")
                  : "无固定主图 · 定制方案"}
                <small>{item.researchItemIds.length} 条研究来源</small>
              </td>
              <td>V{item.version}</td>
              <td>
                {!archived && (
                  <>
                    <button className="oc-button" onClick={() => onCompose(item)}>
                      组合商品
                    </button>
                    <button className="oc-button" onClick={() => onEdit(item)}>
                      新版本
                    </button>
                  </>
                )}
                <button className="oc-button" disabled={busy} onClick={() => onArchive(item)}>
                  {archived ? "恢复印花" : "归档印花"}
                </button>
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
    <div className="pd-table">
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
            const variants = options.specifications.filter((spec) => spec.spuId === item.id);
            return (
              <tr key={item.id}>
                <td>
                  <strong>{item.code}</strong>
                </td>
                <td>{item.name}</td>
                <td>
                  {variants.length} 个规格
                  <small>{variants.map((spec) => spec.name).join(" / ") || "待完善"}</small>
                </td>
                <td>
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
    <div className="pd-table">
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
              <td>
                <strong>{item.skuCode}</strong>
              </td>
              <td>
                {item.recipe?.artwork.code ?? "待映射"}
                <small>{item.recipe?.artwork.name}</small>
              </td>
              <td>
                {item.spuCode}
                <small>
                  {item.recipe?.specification.name ?? Object.values(item.attributes).join(" / ")}
                </small>
              </td>
              <td>
                {item.recipe ? statuses[item.recipe.status] : "待映射"}
                <small>
                  {item.packageCount} 个资料包{item.recipe?.needsUpdate ? " · 来源有新版本" : ""}
                </small>
              </td>
              <td>
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
