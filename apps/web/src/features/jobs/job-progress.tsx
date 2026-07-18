"use client";

import { AlertTriangle, Check, Clock3, LoaderCircle, X } from "lucide-react";

export interface JobProgressView { id: string; jobId: string; label: string; state: "queued" | "running" | "completed" | "failed" | "cancelled"; progress: number; message?: string; occurredAt: string }

export function JobProgress({ jobs }: { jobs: readonly JobProgressView[] }) {
  if (!jobs.length) return <div className="job-progress-empty"><Check size={16} /><span>当前没有运行中的后台任务</span></div>;
  return <ol className="job-progress-list">{jobs.map((job) => <li key={job.id} className={`job-${job.state}`}><span className="job-state-icon">{icon(job.state)}</span><div className="job-progress-copy"><p><strong>{job.label}</strong><b>{stateLabel(job.state)}</b></p><div className="job-progress-track" aria-label={`${job.label} ${job.progress}%`}><span style={{ width: `${job.progress}%` }} /></div><small>{job.message ?? `${job.progress}% complete`} · {formatTime(job.occurredAt)}</small></div><code>{String(job.progress).padStart(2, "0")}%</code></li>)}</ol>;
}

function icon(state: JobProgressView["state"]) { if (state === "running") return <LoaderCircle size={15} className="job-spin" />; if (state === "completed") return <Check size={15} />; if (state === "failed") return <AlertTriangle size={15} />; if (state === "cancelled") return <X size={15} />; return <Clock3 size={15} />; }
function stateLabel(state: JobProgressView["state"]) { return ({ queued: "排队", running: "执行中", completed: "完成", failed: "失败", cancelled: "已取消" })[state]; }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
