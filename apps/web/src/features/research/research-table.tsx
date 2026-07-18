"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";
import { ChevronDown, ExternalLink, LoaderCircle, PackageSearch, Store } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import {
  ResearchProductDossier,
  type ResearchSnapshotView,
} from "./snapshot-timeline";

export interface ResearchItemView {
  id: string;
  lastCapturedAt: string;
  latestStatus: string;
  latestTitle: string | null;
  marketplace: string;
  normalizedUrl: string;
  platform: "amazon" | "etsy";
  shopName?: string | null;
  snapshots?: ResearchSnapshotView[];
}

export function ResearchTable({ items, nextCursor }: { items: ResearchItemView[]; nextCursor: string | null }) {
  const columns = useMemo<ColumnDef<ResearchItemView>[]>(() => [
    {
      accessorKey: "platform",
      header: "平台",
      cell: ({ row }) => <span className={`platform-stamp platform-${row.original.platform}`}>{row.original.platform}</span>,
    },
    {
      accessorKey: "latestTitle",
      header: "研究条目",
      cell: ({ row }) => (
        <div className="item-title">
          {row.original.latestTitle ?? "未识别标题"}
          <a className="item-url" href={row.original.normalizedUrl} target="_blank" rel="noreferrer">
            {row.original.normalizedUrl}
            <ExternalLink size={10} aria-hidden="true" />
          </a>
        </div>
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
      cell: ({ getValue }) => <time className="mono">{formatDate(String(getValue()))}</time>,
    },
    {
      accessorKey: "latestStatus",
      header: "状态",
      cell: ({ row }) => <span className={`status-chip status-${row.original.latestStatus}`}>{row.original.latestStatus}</span>,
    },
  ], []);
  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel() });

  if (!items.length) {
    return (
      <div className="empty-library">
        <strong>还没有符合条件的研究证据</strong>
        <span>在 Amazon 或 Etsy 商品页打开 YummyAI Capture 开始采集。</span>
      </div>
    );
  }

  return (
    <>
      <div className="research-table-scroll">
        <table className="research-table">
          <colgroup>
            <col className="column-platform" />
            <col className="column-item" />
            <col className="column-shop" />
            <col className="column-marketplace" />
            <col className="column-captured" />
            <col className="column-status" />
            <col className="column-action" />
          </colgroup>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>
                ))}
                <th>详情</th>
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <ResearchTableRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor && (
        <div className="pager"><a href={`?cursor=${encodeURIComponent(nextCursor)}`}>下一页</a></div>
      )}
    </>
  );
}

function ResearchTableRow({ row }: { row: Row<ResearchItemView> }) {
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
            {loading ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <PackageSearch size={14} aria-hidden="true" />}
            {open ? "收起" : "查看详情"}
            <ChevronDown className="timeline-chevron" size={13} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {open ? (
        <tr className="research-detail-row" id={detailId}>
          <td colSpan={7}>
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
