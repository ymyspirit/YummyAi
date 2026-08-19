"use client";

import type { ProductionManifest } from "@yummyai/contracts/pod/personalization";
import { BadgeCheck, CircleAlert, FileCheck2, LoaderCircle, ShieldCheck } from "lucide-react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  reviewProductionManifest,
  type PodGovernanceActionState,
} from "./pod-governance-actions";

const idle: PodGovernanceActionState = { message: "", status: "idle" };

export function PodProductionManifestPanel({ error, manifests }: { error?: string; manifests: ProductionManifest[] }) {
  return (
    <section className="pod-governance-panel" aria-labelledby="pod-production-ledger-title">
      <header>
        <div><p>PRODUCTION CONTROL</p><h3 id="pod-production-ledger-title">不可变生产清单</h3></div>
        <span>{manifests.length} MANIFESTS</span>
      </header>
      {error ? <p className="pod-governance-error"><CircleAlert size={14} />{error}</p> : null}
      {!error && !manifests.length ? <p className="pod-governance-empty">暂无生产清单。裁片、UV 或订单履约结果通过质量检查后会进入这里。</p> : null}
      {!error && manifests.length ? (
        <div className="pod-production-ledger">
          {manifests.slice(0, 20).map((manifest) => <ManifestRecord key={manifest.id} manifest={manifest} />)}
        </div>
      ) : null}
    </section>
  );
}

function ManifestRecord({ manifest }: { manifest: ProductionManifest }) {
  return (
    <article>
      <header>
        <FileCheck2 size={16} />
        <div><strong>{manifest.files.length} 个生产文件</strong><span>{manifest.designVersionId ? `设计版本 ${short(manifest.designVersionId)}` : `订单行 ${short(manifest.orderLineId)}`} · {new Date(manifest.createdAt).toLocaleString("zh-CN")}</span></div>
        <span className={`pod-record-status ${manifest.status}`}>{manifestStatus(manifest.status)}</span>
      </header>
      <div className="pod-production-files">
        {manifest.files.map((file) => <span key={`${file.assetId}:${file.fileName}`}><b>{file.fileName}</b><small>{file.width}×{file.height} {file.unit} · {file.dpi ?? "—"} DPI · {file.colorMode.toUpperCase()}</small><code>{short(file.checksumSha256)}</code></span>)}
      </div>
      {manifest.status === "pending_review" ? <ManifestReviewForms id={manifest.id} /> : null}
    </article>
  );
}

function ManifestReviewForms({ id }: { id: string }) {
  const [approveState, approveAction] = useActionState(reviewProductionManifest, idle);
  const [rejectState, rejectAction] = useActionState(reviewProductionManifest, idle);
  return (
    <div className="pod-review-grid">
      <form action={approveAction}><input name="id" type="hidden" value={id} /><input name="decision" type="hidden" value="approve" /><ReviewButton label="批准并锁定" /><Notice state={approveState} /></form>
      <form action={rejectAction}><input name="id" type="hidden" value={id} /><input name="decision" type="hidden" value="reject" /><input maxLength={2000} name="reason" placeholder="驳回原因（必填）" required /><ReviewButton label="驳回清单" /><Notice state={rejectState} /></form>
    </div>
  );
}

function ReviewButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} type="submit">{pending ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}{pending ? "正在提交" : label}</button>;
}

function Notice({ state }: { state: PodGovernanceActionState }) {
  if (state.status === "idle") return null;
  return <p className={`pod-governance-notice ${state.status}`} role="status">{state.status === "success" ? <BadgeCheck size={13} /> : <CircleAlert size={13} />}{state.message}</p>;
}

function short(value: string | undefined) {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "未关联";
}

function manifestStatus(status: ProductionManifest["status"]) {
  return ({ pending_review: "待审核", approved: "已批准", rejected: "已驳回" } as const)[status];
}
