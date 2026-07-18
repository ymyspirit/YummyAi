"use client";

import type { DesignFileRole, DesignTaskStatus, DesignVersionStatus, RightsSource } from "@yummyai/contracts";
import { Box, CalendarDays, CheckCircle2, FileArchive, FileImage, FileType2, LockKeyhole, Plus, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

import { VersionTimeline } from "./version-timeline";

export interface DesignAssetView {
  id: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  domain: "research" | "authorized";
  rightsSource?: RightsSource;
  rightsApprovedAt?: string;
}

export interface DesignVersionView {
  id: string;
  versionNumber: number;
  status: DesignVersionStatus;
  changeNote?: string;
  rejectionReason?: string;
  createdAt: string;
  files: Array<{ id: string; role: DesignFileRole; asset: DesignAssetView }>;
}

export interface DesignTaskView {
  id: string;
  skuId: string;
  skuCode: string;
  title: string;
  brief: string;
  status: DesignTaskStatus;
  dueAt?: string;
  primaryVersionId?: string;
  versions: DesignVersionView[];
}

const roles: DesignFileRole[] = ["source", "effect", "production"];

export function DesignTask({ task }: { task: DesignTaskView }) {
  const [selectedId, setSelectedId] = useState(task.versions[0]?.id ?? "");
  const selected = useMemo(() => task.versions.find((version) => version.id === selectedId) ?? task.versions[0], [selectedId, task.versions]);
  if (!selected) return <section className="design-empty"><FileArchive size={28} /><h1>{task.title}</h1><p>尚未上传设计版本。</p></section>;

  return (
    <div className="design-workbench">
      <header className="design-docket">
        <div><p className="kicker">DESIGN TASK / PRODUCTION PROOF</p><h1>{task.title}</h1><p>{task.brief}</p></div>
        <dl><div><dt>SKU</dt><dd>{task.skuCode}</dd></div><div><dt>DUE</dt><dd><CalendarDays size={14} />{task.dueAt ? formatDate(task.dueAt) : "未设截止"}</dd></div><div><dt>STATUS</dt><dd>{taskStatusLabel(task.status)}</dd></div></dl>
      </header>

      <div className="design-command-bar">
        <div><span className="mono">SELECTED / V{String(selected.versionNumber).padStart(2, "0")}</span><strong>{versionStatusLabel(selected.status)}</strong>{selected.id === task.primaryVersionId && <b><CheckCircle2 size={14} />当前主版本</b>}</div>
        <button type="button"><Plus size={16} />上传新版本</button>
      </div>

      <div className="design-grid">
        <main className="proof-board">
          {selected.status === "approved" && <div className="immutable-notice"><LockKeyhole size={17} /><div><strong>审批版本已锁定</strong><span>文件、校验值与权利记录不可覆盖；后续调整将从 V{String(selected.versionNumber + 1).padStart(2, "0")} 开始。</span></div></div>}
          <section className="proof-note"><p className="section-code">CHANGE NOTE</p><h2>本次交付说明</h2><p>{selected.changeNote ?? "首次提交，等待设计负责人补充变更说明。"}</p></section>
          <div className="asset-role-columns">
            {roles.map((role) => {
              const files = selected.files.filter((file) => file.role === role);
              return <section key={role} className="asset-role" aria-labelledby={`role-${role}`}><header><span>{roleIcon(role)}</span><div><p>{roleCode(role)}</p><h2 id={`role-${role}`}>{roleLabel(role)}</h2></div><b>{files.length}</b></header><div>{files.map((file) => <article key={file.id} className="design-file"><div className="file-glyph">{fileIcon(file.asset.mediaType)}</div><div className="file-name"><strong>{file.asset.fileName}</strong><span>{formatBytes(file.asset.byteSize)} · {file.asset.mediaType}</span></div><div className="rights-row"><span className={file.asset.domain === "authorized" ? "authorized" : "research"}><ShieldCheck size={13} />{file.asset.domain === "authorized" ? "授权域" : "研究域"}</span><span>{rightsLabel(file.asset.rightsSource)}</span></div><code>SHA256 {file.asset.sha256.slice(0, 12)}…</code><button type="button">获取安全链接</button></article>)}</div>{!files.length && <p className="role-empty">此版本未包含{roleLabel(role)}。</p>}</section>;
            })}
          </div>
        </main>
        <VersionTimeline versions={task.versions} selectedId={selected.id} primaryId={task.primaryVersionId} onSelect={setSelectedId} />
      </div>
    </div>
  );
}

function roleLabel(role: DesignFileRole) { return ({ source: "源文件", effect: "效果文件", production: "生产文件" })[role]; }
function roleCode(role: DesignFileRole) { return ({ source: "SOURCE / EDITABLE", effect: "EFFECT / PREVIEW", production: "PRODUCTION / READY" })[role]; }
function roleIcon(role: DesignFileRole) { return role === "production" ? <Box size={18} /> : role === "effect" ? <FileImage size={18} /> : <FileType2 size={18} />; }
function fileIcon(mediaType: string) { return mediaType.includes("image") ? <FileImage size={22} /> : <FileArchive size={22} />; }
function rightsLabel(source?: RightsSource) { return source ? ({ owned: "自有版权", licensed: "许可使用", commissioned: "委托创作", ai_generated: "AI 生成", competitor: "竞品参考" })[source.kind] : "权利未核验"; }
function taskStatusLabel(status: DesignTaskStatus) { return ({ open: "进行中", in_review: "评审中", approved: "已完成", archived: "已归档" })[status]; }
function versionStatusLabel(status: DesignVersionStatus) { return ({ pending_review: "待评审", approved: "已审批", rejected: "已驳回" })[status]; }
function formatBytes(value: number) { return value < 1_000_000 ? `${Math.round(value / 1000)} KB` : `${(value / 1_000_000).toFixed(1)} MB`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
