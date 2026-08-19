"use client";

import type { PodArtworkTaskView, PodExportView } from "@yummyai/contracts/pod";
import { Download, PackageCheck, PackagePlus } from "lucide-react";
import { useActionState, useEffect, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import {
  requestPodExport,
  requestPodExportDownload,
  type PodExportActionState,
} from "./pod-export-actions";

const initialState: PodExportActionState = { status: "idle", message: "" };

export function PodExportControls({
  exports,
  taskId,
  taskStatus,
}: {
  exports: PodExportView[];
  taskId: string;
  taskStatus: PodArtworkTaskView["status"];
}) {
  const latest = exports[0];
  const [createState, createAction] = useActionState(requestPodExport, initialState);
  const [downloadState, downloadAction] = useActionState(requestPodExportDownload, initialState);

  useEffect(() => {
    if (createState.status === "success") window.location.reload();
  }, [createState.status]);
  useEffect(() => {
    if (downloadState.downloadUrl) window.location.assign(downloadState.downloadUrl);
  }, [downloadState.downloadUrl]);

  if (latest?.status === "completed") {
    return (
      <div className="pod-export-control">
        <span className="pod-export-state completed"><PackageCheck size={12} />已锁定</span>
        <form action={downloadAction}>
          <input name="exportId" type="hidden" value={latest.id} />
          <SubmitButton icon={<Download size={12} />} label="下载 ZIP" />
        </form>
        <Notice state={downloadState} />
      </div>
    );
  }
  if (latest?.status === "queued" || latest?.status === "running") {
    return (
      <div className="pod-export-control">
        <span className={`pod-export-state ${latest.status}`}>{latest.status === "running" ? "正在封包" : "等待封包"}</span>
      </div>
    );
  }
  if (taskStatus !== "approved") return null;
  return (
    <div className="pod-export-control">
      {latest?.status === "failed" ? <span className="pod-export-state failed" title={latest.errorMessage}>导出失败</span> : null}
      <form action={createAction}>
        <input name="taskId" type="hidden" value={taskId} />
        <SubmitButton icon={<PackagePlus size={12} />} label={latest?.status === "failed" ? "重新导出" : "生成 ZIP"} />
      </form>
      <Notice state={createState} />
    </div>
  );
}

function SubmitButton({ icon, label }: { icon: ReactNode; label: string }) {
  const { pending } = useFormStatus();
  return <button disabled={pending} type="submit">{icon}{pending ? "处理中…" : label}</button>;
}

function Notice({ state }: { state: PodExportActionState }) {
  if (state.status === "idle") return null;
  return <small className={`pod-export-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"}>{state.message}</small>;
}
