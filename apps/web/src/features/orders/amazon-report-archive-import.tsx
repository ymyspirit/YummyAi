"use client";

import { AmazonReportDetailViewSchema, AmazonReportWorkspaceViewSchema, type AmazonReportLineView } from "@yummyai/contracts/order/report";
import { FileArchive, LoaderCircle, Pause, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { archiveSkipReason, planReportArchives } from "./amazon-report-archive-plan";
import { reportRequest, reportUserError } from "./amazon-report-request";

export function AmazonReportArchiveImport({ accountId, batchId, lines, disabled, onBusy, onComplete }: {
  accountId: string; batchId: string; lines: AmazonReportLineView[]; disabled: boolean;
  onBusy: (busy: boolean) => void; onComplete: () => Promise<unknown>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const active = useRef(true), stopped = useRef(false), input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const plan = planReportArchives(files, lines);
  const eligible = plan.filter(row => !row.issue && row.line);
  useEffect(() => { active.current = true; return () => { active.current = false; stopped.current = true; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!busy) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [busy]);

  async function run() {
    if (busy || disabled || !eligible.length) return;
    stopped.current = false; setBusy(true); onBusy(true); setError(""); setMessage(""); setResults({});
    let imported = 0, skipped = 0, failed = 0;
    const update = (name: string, status: string) => { if (active.current) setResults(current => ({ ...current, [name]: status })); };
    try {
      // Re-read the authenticated store/batch before uploading; never trust a
      // stale UI list or a line ID supplied by a local migration manifest.
      const current = AmazonReportWorkspaceViewSchema.parse(await reportRequest(`workspace?${new URLSearchParams({ accountId, ...(batchId ? { batchId } : {}) })}`));
      for (const row of planReportArchives(files, current.lines)) {
        if (stopped.current || !active.current) break;
        if (row.issue || !row.line) { skipped++; update(row.file.name, row.issue ?? "未找到订单项"); continue; }
        try {
          request.current = new AbortController();
          const signal = AbortSignal.any([request.current.signal, AbortSignal.timeout(115_000)]);
          update(row.file.name, "正在检查与上传");
          const detail = AmazonReportDetailViewSchema.parse(await reportRequest(`lines/${row.line.id}`, undefined, signal));
          const reason = archiveSkipReason(detail.line);
          if (reason) { skipped++; update(row.file.name, reason); continue; }
          if (detail.line.externalOrderId !== row.line.externalOrderId || detail.line.externalLineId !== row.line.externalLineId) throw new Error("内容已更新，请刷新后重试。");
          const contentBase64 = await readBase64(row.file);
          if (!active.current || stopped.current) break;
          const result = AmazonReportDetailViewSchema.parse(await reportRequest(`lines/${row.line.id}/upload`, { expectedVersionId: detail.versionId, fileName: row.file.name, contentBase64 }, signal));
          if (["ready", "partial"].includes(result.line.state)) { imported++; update(row.file.name, result.line.state === "ready" ? "已扫描并承接原始 ZIP" : "已承接 部分定制内容待核对"); }
          else { failed++; update(row.file.name, "未完成 请打开订单详情查看原因"); }
        } catch (cause) {
          failed++; const reason = reportUserError(cause); update(row.file.name, reason);
          if (/^(登录|当前账号)/.test(reason)) { setFiles([]); setResults({}); throw cause; }
        } finally { request.current = null; }
      }
      if (active.current) {
        setMessage(`${stopped.current ? "已暂停" : "本批完成"} · 成功 ${imported} · 跳过 ${skipped} · 未完成 ${failed} · 刷新列表后可继续`);
        await onComplete();
      }
    } catch (cause) { if (active.current) { const reason = reportUserError(cause); if (/^(登录|当前账号)/.test(reason)) { setFiles([]); setResults({}); } setError(reason); } }
    finally { if (active.current) { setBusy(false); onBusy(false); } }
  }

  return <details className="ar-archive-import">
    <summary><FileArchive size={16} aria-hidden="true" />批量承接已下载的原始 ZIP</summary>
    <p>先选择对应店铺并导入原始报告 再按订单号与订单项匹配 ZIP 已有可读取内容的商品会跳过 原始附件仍需服务端扫描与身份核对</p>
    <div className="ar-toolbar">
      <input ref={input} className="ar-file-input" type="file" multiple accept=".zip,application/zip" aria-label="选择已下载的原始 ZIP" disabled={disabled || busy} onChange={event => {
        const selected = Array.from(event.target.files ?? []); setError(""); setMessage(""); setResults({});
        if (selected.length > 500) { setFiles([]); setError("请选择不超过 500 个 ZIP 文件。"); }
        else setFiles(selected);
        event.target.value = "";
      }} />
      <button className="ar-button" disabled={disabled || busy} onClick={() => input.current?.click()}><Upload size={15} />选择原始 ZIP</button>
      <span>已选择 {files.length} 个 · 可承接 {eligible.length} 个</span>
      <button className="ar-button primary" disabled={disabled || busy || !eligible.length} onClick={() => void run()}>{busy ? <LoaderCircle size={15} className="ar-spin" /> : <FileArchive size={15} />}开始承接</button>
      {busy && <button className="ar-button" onClick={() => { stopped.current = true; setMessage("当前文件完成后暂停"); }}><Pause size={15} />暂停</button>}
    </div>
    {error && <p className="ar-alert" role="alert">{error}</p>}
    {message && <p className="ar-notice" role="status">{message}</p>}
    {!!plan.length && <ul className="ar-archive-plan" aria-label="原始 ZIP 匹配结果">{plan.map((row, index) => <li key={`${row.file.name}-${index}`}><span>{row.file.name}</span><span>{results[row.file.name] ?? row.issue ?? "等待承接"}</span></li>)}</ul>}
  </details>;
}

async function readBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    return btoa(binary);
  } finally { bytes.fill(0); }
}
