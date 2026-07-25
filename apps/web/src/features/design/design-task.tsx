"use client";

import type { DesignFileRole, DesignTaskStatus, DesignVersionStatus, RightsSource } from "@yummyai/contracts";
import { BadgeCheck, Box, CalendarDays, CheckCircle2, CircleAlert, ExternalLink, FileArchive, FileImage, FileType2, LoaderCircle, LockKeyhole, Plus, ShieldCheck } from "lucide-react";
import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { getDesignFileUrl, reviewDesignVersion, setPrimaryDesignVersion, uploadDesignVersion, type DesignActionState } from "./design-actions";
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
  if (!selected) return <div className="design-workbench"><header className="design-docket"><div><p className="kicker">DESIGN TASK / PRODUCTION PROOF</p><h1>{task.title}</h1><p>{task.brief}</p></div><dl><div><dt>SKU</dt><dd>{task.skuCode}</dd></div><div><dt>DUE</dt><dd><CalendarDays size={14} />{task.dueAt ? formatDate(task.dueAt) : "未设截止"}</dd></div><div><dt>STATUS</dt><dd>{taskStatusLabel(task.status)}</dd></div></dl></header><UploadVersionPanel taskId={task.id} empty /><section className="design-empty"><FileArchive size={28} /><h2>尚未上传设计版本</h2><p>上传自有或已获许可的设计文件，创建第一个不可变校样版本。</p></section></div>;

  return (
    <div className="design-workbench">
      <header className="design-docket">
        <div><p className="kicker">DESIGN TASK / PRODUCTION PROOF</p><h1>{task.title}</h1><p>{task.brief}</p></div>
        <dl><div><dt>SKU</dt><dd>{task.skuCode}</dd></div><div><dt>DUE</dt><dd><CalendarDays size={14} />{task.dueAt ? formatDate(task.dueAt) : "未设截止"}</dd></div><div><dt>STATUS</dt><dd>{taskStatusLabel(task.status)}</dd></div></dl>
      </header>

      <div className="design-command-bar">
        <div><span className="mono">SELECTED / V{String(selected.versionNumber).padStart(2, "0")}</span><strong>{versionStatusLabel(selected.status)}</strong>{selected.id === task.primaryVersionId && <b><CheckCircle2 size={14} />当前主版本</b>}</div>
        <a href="#design-upload"><Plus size={16} />上传新版本</a>
      </div>

      <UploadVersionPanel taskId={task.id} />
      <DesignReviewActions primaryId={task.primaryVersionId} taskId={task.id} version={selected} />

      <div className="design-grid">
        <main className="proof-board">
          {selected.status === "approved" && <div className="immutable-notice"><LockKeyhole size={17} /><div><strong>审批版本已锁定</strong><span>文件、校验值与权利记录不可覆盖；后续调整将从 V{String(selected.versionNumber + 1).padStart(2, "0")} 开始。</span></div></div>}
          <section className="proof-note"><p className="section-code">CHANGE NOTE</p><h2>本次交付说明</h2><p>{selected.changeNote ?? "首次提交，等待设计负责人补充变更说明。"}</p></section>
          <div className="asset-role-columns">
            {roles.map((role) => {
              const files = selected.files.filter((file) => file.role === role);
              return <section key={role} className="asset-role" aria-labelledby={`role-${role}`}><header><span>{roleIcon(role)}</span><div><p>{roleCode(role)}</p><h2 id={`role-${role}`}>{roleLabel(role)}</h2></div><b>{files.length}</b></header><div>{files.map((file) => <article key={file.id} className="design-file"><div className="file-glyph">{fileIcon(file.asset.mediaType)}</div><div className="file-name"><strong>{file.asset.fileName}</strong><span>{formatBytes(file.asset.byteSize)} · {file.asset.mediaType}</span></div><div className="rights-row"><span className={file.asset.domain === "authorized" ? "authorized" : "research"}><ShieldCheck size={13} />{file.asset.domain === "authorized" ? "授权域" : "研究域"}</span><span>{rightsLabel(file.asset.rightsSource)}</span></div><code>SHA256 {file.asset.sha256.slice(0, 12)}…</code><FileReadAction fileId={file.id} versionId={selected.id} /></article>)}</div>{!files.length && <p className="role-empty">此版本未包含{roleLabel(role)}。</p>}</section>;
            })}
          </div>
        </main>
        <VersionTimeline versions={task.versions} selectedId={selected.id} primaryId={task.primaryVersionId} onSelect={setSelectedId} />
      </div>
    </div>
  );
}

const idle: DesignActionState = { message: "", status: "idle" };

function UploadVersionPanel({ empty, taskId }: { empty?: boolean; taskId: string }) {
  const [state, action] = useActionState(uploadDesignVersion.bind(null, taskId), idle);
  useReload(state);
  return <details className="design-upload-panel" id="design-upload" open={empty}><summary><Plus size={15} />上传新版本<span>文件进入授权域并记录权利来源</span></summary><form action={action}><label className="design-upload-file"><span>设计文件 *</span><input accept="image/*,.ai,.psd,.pdf,.svg,.zip" name="file" required type="file" /><small>最大 20 MB。不能上传竞品图片作为设计资产。</small></label><label><span>文件角色</span><select defaultValue="effect" name="role"><option value="source">源文件</option><option value="effect">效果文件</option><option value="production">生产文件</option></select></label><label><span>权利来源</span><select defaultValue="owned" name="rightsKind"><option value="owned">自有版权</option><option value="licensed">许可使用</option><option value="commissioned">委托创作</option><option value="ai_generated">AI 生成</option><option value="customer_provided">客户提供</option></select></label><label><span>来源编号或说明 *</span><input name="rightsReference" placeholder="内部项目号、合同号或许可证编号" required /></label><label className="design-upload-note"><span>版本说明</span><textarea maxLength={2000} name="changeNote" placeholder="说明本次校样变更" rows={3} /></label><footer><ActionNotice state={state} /><PendingButton label="创建新版本" /></footer></form></details>;
}

function DesignReviewActions({ primaryId, taskId, version }: { primaryId?: string; taskId: string; version: DesignVersionView }) {
  const [approveState, approve] = useActionState(reviewDesignVersion.bind(null, version.id, "approve"), idle);
  const [rejectState, reject] = useActionState(reviewDesignVersion.bind(null, version.id, "reject"), idle);
  const [primaryState, setPrimary] = useActionState(setPrimaryDesignVersion.bind(null, taskId, version.id), idle);
  const state = [approveState, rejectState, primaryState].find((item) => item.status !== "idle") ?? idle;
  useReload(state);
  if (version.status === "pending_review") return <section className="design-review-controls"><div><p className="section-code">HUMAN REVIEW</p><strong>校样等待人工结论</strong></div><form action={approve}><PendingButton label="批准并锁定" /></form><form action={reject} className="design-reject-form"><input name="rejectionReason" placeholder="填写驳回原因" required /><PendingButton label="驳回" /></form><ActionNotice state={state} /></section>;
  if (version.status === "approved" && version.id !== primaryId) return <section className="design-review-controls"><div><p className="section-code">PRIMARY VERSION</p><strong>批准版本尚未绑定为主版本</strong></div><form action={setPrimary}><PendingButton label="设为主版本" /></form><ActionNotice state={state} /></section>;
  return null;
}

function FileReadAction({ fileId, versionId }: { fileId: string; versionId: string }) {
  const [state, action] = useActionState(getDesignFileUrl.bind(null, versionId, fileId), idle);
  return <form action={action} className="design-read-form">{state.url ? <a href={state.url} target="_blank" rel="noreferrer">打开安全链接<ExternalLink size={13} /></a> : <PendingButton label="获取安全链接" />}{state.status === "error" ? <ActionNotice state={state} /> : null}</form>;
}

function PendingButton({ label }: { label: string }) { const { pending } = useFormStatus(); return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={14} /> : null}{label}</button>; }
function ActionNotice({ state }: { state: DesignActionState }) { if (state.status === "idle") return null; return <p className={`design-action-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}{state.message}</p>; }
function useReload(state: DesignActionState) { useEffect(() => { if (state.status === "success") window.location.reload(); }, [state.status]); }

function roleLabel(role: DesignFileRole) { return ({ source: "源文件", effect: "效果文件", production: "生产文件" })[role]; }
function roleCode(role: DesignFileRole) { return ({ source: "SOURCE / EDITABLE", effect: "EFFECT / PREVIEW", production: "PRODUCTION / READY" })[role]; }
function roleIcon(role: DesignFileRole) { return role === "production" ? <Box size={18} /> : role === "effect" ? <FileImage size={18} /> : <FileType2 size={18} />; }
function fileIcon(mediaType: string) { return mediaType.includes("image") ? <FileImage size={22} /> : <FileArchive size={22} />; }
function rightsLabel(source?: RightsSource) { return source ? ({ owned: "自有版权", licensed: "许可使用", commissioned: "委托创作", ai_generated: "AI 生成", customer_provided: "客户提供", competitor: "竞品参考" })[source.kind] : "权利未核验"; }
function taskStatusLabel(status: DesignTaskStatus) { return ({ open: "进行中", in_review: "评审中", approved: "已完成", archived: "已归档" })[status]; }
function versionStatusLabel(status: DesignVersionStatus) { return ({ pending_review: "待评审", approved: "已审批", rejected: "已驳回" })[status]; }
function formatBytes(value: number) { return value < 1_000_000 ? `${Math.round(value / 1000)} KB` : `${(value / 1_000_000).toFixed(1)} MB`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
