"use client";

import type { ResearchItemSummary, ResearchProductTypeFacet } from "@yummyai/contracts/research";
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
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { researchRequest, studyStatusLabels } from "./research-client";
import { ResearchThumbnail } from "./research-thumbnail";
import "./research-workflow.css";

import { ResearchProductDossier, type ResearchSnapshotView } from "./snapshot-timeline";

export type ResearchItemView = ResearchItemSummary & {
  snapshots?: ResearchSnapshotView[];
};

export function ResearchTable({
  items,
  nextPageHref,
  productTypes,
  initialItemId,
  initialSnapshotId,
  studyRevisionId,
}: {
  items: ResearchItemView[];
  nextPageHref: string | null;
  productTypes: ResearchProductTypeFacet[];
  initialItemId?: string;
  initialSnapshotId?: string;
  studyRevisionId?: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [productTypeName, setProductTypeName] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedSet.has(item.id));

  async function setArchived(item: ResearchItemView) {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await researchRequest("archive", { itemIds: [item.id], archived: !item.archivedAt });
      setSelected((current) => current.filter((id) => id !== item.id));
      setNotice(
        item.archivedAt
          ? "已恢复到资料库。"
          : "已归档，可在“资料范围 → 已归档”中恢复。历史快照和创意引用仍保留。",
      );
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档状态保存失败");
    } finally {
      setPending(false);
    }
  }

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
          <div>
            <span className={`platform-stamp platform-${row.original.platform}`}>
              {row.original.platform}
            </span>
            <small className="research-platform-meta">{row.original.marketplace}</small>
          </div>
        ),
      },
      {
        accessorKey: "latestTitle",
        header: "研究条目",
        cell: ({ row }) => (
          <div className="research-item-visual">
            <ResearchThumbnail
              src={row.original.thumbnailUrl}
              alt={row.original.latestTitle ?? "竞品缩略图"}
            />
            <div className="item-title">
              {row.original.latestTitle ?? "未识别标题"}
              <small>
                {row.original.archivedAt ? "已归档 · " : ""}
                {row.original.study?.theme || "尚未归纳设计主题"}
                {row.original.priceRaw ? ` · 采集价 ${row.original.priceRaw}` : ""}
              </small>
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
        id: "researchStatus",
        header: "研究状态",
        cell: ({ row }) => (
          <div>
            {studyStatusLabels[row.original.study?.status ?? "unreviewed"]}
            {row.original.study?.version ? (
              <small className="research-capture-meta">
                V{row.original.study.version}
                {row.original.study.snapshotId !== row.original.latestSnapshotId
                  ? " · 需复核新快照"
                  : ""}
              </small>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "lastCapturedAt",
        header: "最近采集",
        cell: ({ row, getValue }) => (
          <div>
            <time className="mono">{formatDate(String(getValue()))}</time>
            <small className="research-capture-meta">
              采集：{captureStatusLabel(row.original.latestStatus)}
            </small>
          </div>
        ),
      },
      {
        id: "creativeCount",
        header: "关联创意",
        cell: ({ row }) => <span>{row.original.study?.creativeCount ?? 0} 个项目</span>,
      },
    ],
    [assignProductType, pending],
  );
  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel() });

  if (!items.length) {
    return (
      <div className="empty-library">
        {notice && <p role="status">{notice}</p>}
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
        <button
          type="button"
          className="classification-apply"
          disabled={!selected.length || selected.length > 30 || pending}
          onClick={() => router.push(`/creative-designs/canvas?research=${selected.join(",")}`)}
        >
          加入创意项目{selected.length > 30 ? "（最多 30 条）" : ""}
        </button>
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
                key={row.original.id}
                initialOpen={row.original.id === initialItemId}
                initialSnapshotId={
                  row.original.id === initialItemId ? initialSnapshotId : undefined
                }
                studyRevisionId={row.original.id === initialItemId ? studyRevisionId : undefined}
                pending={pending}
                onArchive={() => void setArchived(row.original)}
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
  onArchive,
  onSelect,
  pending,
  row,
  selected,
  initialOpen = false,
  initialSnapshotId,
  studyRevisionId,
}: {
  onArchive: () => void;
  onSelect: (checked: boolean) => void;
  pending: boolean;
  row: Row<ResearchItemView>;
  selected: boolean;
  initialOpen?: boolean;
  initialSnapshotId?: string;
  studyRevisionId?: string;
}) {
  const [snapshots, setSnapshots] = useState(row.original.snapshots ?? []);
  const [open, setOpen] = useState(initialOpen);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailId = `research-detail-${row.original.id}`;

  useEffect(() => {
    if (!open || snapshots.length) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      const response = await fetch(`/v1/research-items/${row.original.id}/snapshots`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`商品详情读取失败 (${response.status})`);
      setSnapshots((await response.json()) as ResearchSnapshotView[]);
    })()
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "商品详情读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, row.original.id, snapshots.length]);
  function toggle() {
    if (open && dirty && !confirm("研究结论尚未保存，确定收起？")) return;
    setOpen(!open);
    setDirty(false);
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
          <button
            className="timeline-toggle"
            type="button"
            onClick={onArchive}
            disabled={pending || dirty}
            title={
              dirty
                ? "请先保存研究结论"
                : row.original.archivedAt
                  ? "恢复到日常资料库"
                  : "移到已归档，保留历史快照和创意引用"
            }
          >
            {row.original.archivedAt ? "恢复" : "归档"}
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
              researchItemId={row.original.id}
              initialSnapshotId={initialSnapshotId}
              studyRevisionId={studyRevisionId}
              onDirtyChange={setDirty}
            />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function captureStatusLabel(status: string) {
  return (
    (
      { complete: "完成", partial: "部分完成", failed: "失败", normalizing: "整理中" } as Record<
        string,
        string
      >
    )[status] ?? status
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}
