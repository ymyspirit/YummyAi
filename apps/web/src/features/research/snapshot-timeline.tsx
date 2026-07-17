"use client";

import { Clock3, LoaderCircle } from "lucide-react";
import { useState } from "react";

export interface ResearchSnapshotView {
  capturedAt: string;
  id: string;
  status: string;
  title: string | null;
}

export function SnapshotTimeline({ researchItemId, initialSnapshots = [] }: { researchItemId: string; initialSnapshots?: ResearchSnapshotView[] }) {
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [open, setOpen] = useState(initialSnapshots.length > 0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (snapshots.length) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/v1/research-items/${researchItemId}/snapshots`);
      if (!response.ok) throw new Error(`快照读取失败 (${response.status})`);
      setSnapshots((await response.json()) as ResearchSnapshotView[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "快照读取失败");
    } finally { setLoading(false); }
  }

  return (
    <div>
      <button className="timeline-toggle" type="button" onClick={() => void toggle()} aria-expanded={open}>
        {loading ? <LoaderCircle size={14} aria-hidden="true" /> : <Clock3 size={14} aria-hidden="true" />}
        {open ? "收起时间线" : "查看时间线"}
      </button>
      {open && (
        <div className="snapshot-panel">
          <p className="section-code">SNAPSHOT HISTORY</p>
          {error ? <p role="alert">{error}</p> : loading ? <p>正在读取版本…</p> : snapshots.length ? (
            <ol className="snapshot-list">
              {snapshots.map((snapshot) => (
                <li key={snapshot.id}>
                  <span className="snapshot-dot" aria-hidden="true" />
                  <time className="mono" dateTime={snapshot.capturedAt}>{new Intl.DateTimeFormat("zh-CN", { dateStyle:"medium", timeStyle:"short" }).format(new Date(snapshot.capturedAt))}</time>
                  <span>{snapshot.title ?? "未识别标题"}</span>
                  <span className={`status-chip status-${snapshot.status}`}>{snapshot.status}</span>
                </li>
              ))}
            </ol>
          ) : <p>暂无历史快照。</p>}
        </div>
      )}
    </div>
  );
}
