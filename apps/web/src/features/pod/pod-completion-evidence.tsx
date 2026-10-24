"use client";

import { useState } from "react";
import { Download, FileCheck2 } from "lucide-react";
import { PodCompletionRecordSchema, type PodCompletionRecord } from "@yummyai/contracts/pod/completion";
import "./pod-completion-evidence.css";

export function PodCompletionEvidence({ taskId, record, hasResult }: { taskId: string; record?: PodCompletionRecord | null; hasResult: boolean }) {
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [denied, setDenied] = useState(false);
  if (!record && !hasResult) return null;
  async function download() {
    setPending(true); setError("");
    try {
      const response = await fetch(`/api/pod/tasks/${taskId}/completion`, { cache: "no-store" });
      if (!response.ok) {
        if ([401,403,404,410].includes(response.status)) setDenied(true);
        throw new Error([401,403].includes(response.status) ? "当前无权读取此交接记录" : response.status === 404 ? "没有可下载的原始交接记录" : "暂时无法核对交接记录 请稍后重试");
      }
      const checked = PodCompletionRecordSchema.safeParse(await response.json());
      if (!checked.success || checked.data.evidence.taskId !== taskId || checked.data.checksum !== record?.checksum) throw new Error("交接记录与当前页面不一致 请重新读取任务");
      const url = URL.createObjectURL(new Blob([JSON.stringify(checked.data,null,2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `pod-completion-${taskId}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "交接记录下载失败"); }
    finally { setPending(false); }
  }
  return <section className="pod-completion-evidence" aria-label="原始产物交接">
    <FileCheck2 size={15} aria-hidden="true" />
    <div><strong>{denied ? "交接记录已不可读取" : record ? "已记录原始产物交接" : "历史任务未记录交接凭据"}</strong>
      <span>{!denied && record ? `${record.evidence.outputs.length} 个文件 · ${record.evidence.resultState === "blocked" ? "生成时已阻断" : record.evidence.resultState === "partially_succeeded" ? "部分生成待审核" : "生成后交由业务审核"}` : "不会补造旧任务的执行证据"}</span>
    </div>
    {!denied && record && <button type="button" onClick={download} disabled={pending} aria-busy={pending}><Download size={13} aria-hidden="true" />{pending ? "正在核对" : "下载交接记录"}</button>}
    <div className={`pod-completion-message${error ? " is-visible" : ""}`}><p role={error ? "alert" : undefined}>{error}</p></div>
  </section>;
}
