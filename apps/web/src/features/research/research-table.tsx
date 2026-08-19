"use client";

import type {
  ResearchItemSummary,
  ResearchProductTypeFacet,
} from "@yummyai/contracts/research";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import {
  Check,
  ChevronDown,
  ExternalLink,
  LoaderCircle,
  PackageSearch,
  Store,
  Tags,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useMemo, useState } from "react";

import {
  ResearchProductDossier,
  type ResearchSnapshotView,
} from "./snapshot-timeline";

export type ResearchItemView = ResearchItemSummary & {
  snapshots?: ResearchSnapshotView[];
};

export function ResearchTable({
  items,
  nextPageHref,
  productTypes,
}: {
  items: ResearchItemView[];
  nextPageHref: string | null;
  productTypes: ResearchProductTypeFacet[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [productTypeName, setProductTypeName] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allVisibleSelected =
    items.length > 0 && items.every((item) => selectedSet.has(item.id));

  const assignProductType = useCallback(
    async (itemIds: string[], nextProductTypeName: string | null) => {
      if (!itemIds.length || pending) return;
      setPending(true);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch("/v1/research-items/product-type", {
          body: JSON.stringify({ itemIds, productTypeName: nextProductTypeName }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        });
        const payload = (await response.json().catch(() => null)) as {
          cascaded?: unknown;
          message?: unknown;
          updated?: unknown;
        } | null;
        if (!response.ok) {
          if (response.status === 403) {
            throw new Error("当前成员没有 research:write 权限，无法修改产品类型。");
          }
          throw new Error(
            typeof payload?.message === "string"
              ? payload.message
              : `产品类型保存失败 (${response.status})`,
          );
        }
        const updated = typeof payload?.updated === "number" ? payload.updated : itemIds.length;
        const cascaded = typeof payload?.cascaded === "number" ? payload.cascaded : 0;
        setNotice(
          cascaded > 0
            ? `已更新 ${updated} 条，并同步修正 ${cascaded} 条相同类目建议。`
            : `已更新 ${updated} 条研究资料。`,
        );
        setSelected([]);
        router.refresh();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "产品类型保存失败");
      } finally {
        setPending(false);
      }
    },
    [pending, router],
  );

  const columns = useMemo<ColumnDef<ResearchItemView>[]>(
    () => [
      {
        accessorKey: "platform",
        header: "平台",
        cell: ({ row }) => (
          <span className={`platform-stamp platform-${row.original.platform}`}>
            {row.original.platform}
          </span>
        ),
      },
      {
        accessorKey: "latestTitle",
        header: "研究条目",
        cell: ({ row }) => (
          <div className="item-title">
            {row.original.latestTitle ?? "未识别标题"}
            <a
              className="item-url"
              href={row.original.normalizedUrl}
              target="_blank"
              rel="noreferrer"
            >
              {row.original.normalizedUrl}
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          </div>
        ),
      },
      {
        id: "productType",
        header: "产品类型",
        cell: ({ row }) => (
          <ProductTypeCell
            item={row.original}
            pending={pending}
            onConfirm={(name) => void assignProductType([row.original.id], name)}
          />
        ),
      },
      {
        accessorKey: "shopName",
        header: "店铺名",
        cell: ({ row }) => (
          <span className={row.original.shopName ? "shop-name-cell" : "shop-name-cell is-empty"}>
            <Store size={13} aria-hidden="true" />
            <span>{row.original.shopName ?? "未识别店铺"}</span>
          </span>
        ),
      },
      {
        accessorKey: "marketplace",
        header: "站点",
        cell: ({ getValue }) => <span className="mono">{String(getValue())}</span>,
      },
      {
        accessorKey: "lastCapturedAt",
        header: "最近采集",
        cell: ({ getValue }) => (
          <time className="mono">{formatDate(String(getValue()))}</time>
        ),
      },
      {
        accessorKey: "latestStatus",
        header: "状态",
        cell: ({ row }) => (
          <span className={`status-chip status-${row.original.latestStatus}`}>
            {row.original.latestStatus}
          </span>
        ),
      },
    ],
    [assignProductType, pending],
  );
  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel() });

  if (!items.length) {
    return (
      <div className="empty-library">
        <strong>没有符合当前条件的研究资料</strong>
        <span>调整标题、产品类型或分类状态筛选；也可以继续从扩展采集公开证据。</span>
      </div>
    );
  }

  return (
    <>
      <div className="research-classification-bar" aria-busy={pending}>
        <div className="research-selection-count" aria-live="polite">
          <strong>{selected.length}</strong>
          <span>已选</span>
        </div>
        <label>
          <span>统一产品类型</span>
          <input
            list="research-product-types"
            maxLength={120}
            onChange={(event) => setProductTypeName(event.target.value)}
            placeholder="选择已有类型或输入新类型"
            value={productTypeName}
          />
          <datalist id="research-product-types">
            {productTypes.map((type) => (
              <option key={type.key} value={type.name} />
            ))}
          </datalist>
        </label>
        <button
          className="classification-apply"
          disabled={!selected.length || !productTypeName.trim() || pending}
          onClick={() => void assignProductType(selected, productTypeName.trim())}
          type="button"
        >
          {pending ? <LoaderCircle className="spin" size={15} /> : <Tags size={15} />}
          批量归类
        </button>
        <button
          className="classification-clear"
          disabled={!selected.length || pending}
          onClick={() => void assignProductType(selected, null)}
          type="button"
        >
          <X size={15} />
          标记未分类
        </button>
        <div className="classification-feedback" aria-live="polite">
          {error ? <span className="is-error">{error}</span> : null}
          {notice ? <span className="is-success">{notice}</span> : null}
          {!error && !notice ? <span>仅修改研究索引，不改变历史快照。</span> : null}
        </div>
      </div>
      <div className="research-table-scroll">
        <table className="research-table">
          <colgroup>
            <col className="column-select" />
            <col className="column-platform" />
            <col className="column-item" />
            <col className="column-product-type" />
            <col className="column-shop" />
            <col className="column-marketplace" />
            <col className="column-captured" />
            <col className="column-status" />
            <col className="column-action" />
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <th className="research-select-cell">
                  <input
                    aria-label="选择当前页全部研究资料"
                    checked={allVisibleSelected}
                    disabled={pending}
                    onChange={(event) =>
                      setSelected(event.target.checked ? items.map((item) => item.id) : [])
                    }
                    type="checkbox"
                  />
                </th>
                {group.headers.map((header) => (
                  <th key={header.id}>
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
                <th>详情</th>
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <ResearchTableRow
                key={row.id}
                pending={pending}
                row={row}
                selected={selectedSet.has(row.original.id)}
                onSelect={(checked) =>
                  setSelected((current) =>
                    checked
                      ? [...new Set([...current, row.original.id])]
                      : current.filter((id) => id !== row.original.id),
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      {nextPageHref && (
        <div className="pager">
          <a href={nextPageHref}>下一页</a>
        </div>
      )}
    </>
  );
}

function ProductTypeCell({
  item,
  onConfirm,
  pending,
}: {
  item: ResearchItemView;
  onConfirm: (name: string) => void;
  pending: boolean;
}) {
  const type = item.classification.productType;
  if (!type) {
    return (
      <span className="product-type-cell is-unclassified">
        <span>未分类</span>
        <small>等待人工归类</small>
      </span>
    );
  }
  const suggested = item.classification.status === "suggested";
  return (
    <span className={`product-type-cell is-${item.classification.status}`}>
      <span>{type.name}</span>
      <small>{suggested ? "待复核" : "已确认"}</small>
      {suggested ? (
        <button
          aria-label={`确认产品类型 ${type.name}`}
          disabled={pending}
          onClick={() => onConfirm(type.name)}
          type="button"
        >
          <Check size={13} />
          确认
        </button>
      ) : null}
    </span>
  );
}

function ResearchTableRow({
  onSelect,
  pending,
  row,
  selected,
}: {
  onSelect: (checked: boolean) => void;
  pending: boolean;
  row: Row<ResearchItemView>;
  selected: boolean;
}) {
  const [snapshots, setSnapshots] = useState(row.original.snapshots ?? []);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailId = `research-detail-${row.original.id}`;

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }

    setOpen(true);
    if (snapshots.length) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/v1/research-items/${row.original.id}/snapshots`);
      if (!response.ok) throw new Error(`商品详情读取失败 (${response.status})`);
      setSnapshots((await response.json()) as ResearchSnapshotView[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "商品详情读取失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Fragment>
      <tr className={open ? "research-summary-row is-expanded" : "research-summary-row"}>
        <td className="research-select-cell">
          <input
            aria-label={`选择 ${row.original.latestTitle ?? "未识别标题"}`}
            checked={selected}
            disabled={pending}
            onChange={(event) => onSelect(event.target.checked)}
            type="checkbox"
          />
        </td>
        {row.getVisibleCells().map((cell) => (
          <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
        ))}
        <td className="research-action-cell">
          <button
            className="timeline-toggle"
            type="button"
            onClick={() => void toggle()}
            aria-controls={detailId}
            aria-expanded={open}
          >
            {loading ? (
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
            ) : (
              <PackageSearch size={14} aria-hidden="true" />
            )}
            {open ? "收起" : "查看详情"}
            <ChevronDown className="timeline-chevron" size={13} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="research-detail-row" id={detailId}>
          <td colSpan={9}>
            <ResearchProductDossier
              item={row.original}
              snapshots={snapshots}
              loading={loading}
              error={error}
            />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}
