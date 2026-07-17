"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";

import { SnapshotTimeline, type ResearchSnapshotView } from "./snapshot-timeline";

export interface ResearchItemView {
  id: string;
  lastCapturedAt: string;
  latestStatus: string;
  latestTitle: string | null;
  marketplace: string;
  normalizedUrl: string;
  platform: "amazon" | "etsy";
  snapshots?: ResearchSnapshotView[];
}

export function ResearchTable({ items, nextCursor }: { items: ResearchItemView[]; nextCursor: string | null }) {
  const columns = useMemo<ColumnDef<ResearchItemView>[]>(() => [
    { accessorKey:"platform", header:"平台", cell:({ row }) => <span className={`platform-stamp platform-${row.original.platform}`}>{row.original.platform}</span> },
    { accessorKey:"latestTitle", header:"研究条目", cell:({ row }) => <div className="item-title">{row.original.latestTitle ?? "未识别标题"}<span className="item-url">{row.original.normalizedUrl}</span></div> },
    { accessorKey:"marketplace", header:"站点", cell:({ getValue }) => <span className="mono">{String(getValue())}</span> },
    { accessorKey:"lastCapturedAt", header:"最近采集", cell:({ getValue }) => <time className="mono">{new Intl.DateTimeFormat("zh-CN", { dateStyle:"medium" }).format(new Date(String(getValue())))}</time> },
    { accessorKey:"latestStatus", header:"状态", cell:({ row }) => <span className={`status-chip status-${row.original.latestStatus}`}>{row.original.latestStatus}</span> },
  ], []);
  const table = useReactTable({ data: items, columns, getCoreRowModel:getCoreRowModel() });
  if (!items.length) return <div className="empty-library"><strong>还没有符合条件的研究证据</strong><span>在 Amazon 或 Etsy 商品页打开 YummyAI Capture 开始采集。</span></div>;
  return (
    <>
      <table className="research-table">
        <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}<th>版本</th></tr>)}</thead>
        <tbody>{table.getRowModel().rows.map((row) => (
          <tr key={row.id}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}<td><SnapshotTimeline researchItemId={row.original.id} initialSnapshots={row.original.snapshots} /></td></tr>
        ))}</tbody>
      </table>
      {nextCursor && <div className="pager"><a href={`?cursor=${encodeURIComponent(nextCursor)}`}>下一页</a></div>}
    </>
  );
}
