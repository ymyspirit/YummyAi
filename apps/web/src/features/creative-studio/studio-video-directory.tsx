"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowRight, FileSearch, RefreshCw, ShieldCheck } from "lucide-react";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import type { StudioVideoDiagnosticSchema, StudioVideoPreflight } from "@yummyai/contracts/pod/studio-video-directory";
import type { z } from "zod";
import { assertStudioCurrent, studioScopeUnavailable, studioRpc, type StudioRequestContext } from "./studio-api";
import { createStudioVideoDirectory } from "./studio-video-directory-state";

const diagnostics: Record<z.infer<typeof StudioVideoDiagnosticSchema>, string> = {
  invalid_document: "记录内容损坏", invalid_status: "原状态无法识别", invalid_origin: "来源标记异常", invalid_task: "任务关联格式异常", missing_task: "待处理记录缺少任务",
  untracked_task: "未找到本人原任务", unexpected_asset: "记录错误关联了素材", invalid_references: "引用格式异常", invalid_media: "媒体记录异常",
};
export function StudioVideoDirectory({ scope, workspace, active, capture, onReadDenied, onAdmission }: {
  scope: string; workspace?: StudioWorkspace; active: boolean; capture: (signal?: AbortSignal) => StudioRequestContext;
  onReadDenied: () => void; onAdmission: (value: StudioVideoPreflight | null) => void;
}) {
  const available = workspace?.videoDirectoryVersion === 1;
  const helper = useMemo(() => {
    const context = capture();
    return createStudioVideoDirectory({ current: () => assertStudioCurrent(context), admission: onAdmission,
      call: (input, signal) => studioRpc(scope, input, signal, context), failure: cause => { if (studioScopeUnavailable(cause)) onReadDenied(); } });
  }, [scope, capture, onAdmission, onReadDenied]);
  const state = useSyncExternalStore(helper.subscribe, helper.snapshot, helper.snapshot), [shown, setShown] = useState(50);
  useEffect(() => { helper.activate(); if (active && available) { setShown(50); void helper.read(); } return () => helper.stop(); }, [active, available, helper]);
  if (!active) return null;
  const busy = state.phase === "reading" || state.phase === "opening", directory = state.directory;
  const pending = directory?.items.filter(item => item.nativeStatus === "pending" && item.origin !== "frozen").length ?? 0;
  const frozen = directory?.items.filter(item => item.origin === "frozen").length ?? 0;
  const damaged = directory?.items.filter(item => item.diagnostics.length > 0).length ?? 0;
  const blocked = new Set(state.preflight?.blockedEntryIds ?? []);
  return <section className="studio-records studio-video-directory" aria-label="视频原生日志目录" aria-busy={busy} data-error-code={!available ? "studio_video_directory_unavailable" : undefined}>
    <header><div><h2><FileSearch size={16} />视频历史检查</h2><p>先读取当前范围全部原生日志 打开工作台仅查看和编辑 不恢复原任务</p></div>
      <button type="button" disabled={!available || busy} onClick={() => { setShown(50); void helper.read(); }}><RefreshCw size={14} />重新读取视频历史</button></header>
    {!available ? <p role="alert" className="studio-alert">当前服务尚未提供完整视频历史检查 请联系管理员升级 视频工具尚未打开</p>
      : <><p role="status" className="studio-video-directory-status">{state.phase === "reading" ? "正在读取完整视频历史 尚未打开工具" : state.phase === "opening" ? "正在重新核对原目录 尚未打开工具" : state.phase === "opened" ? "视频工作台已打开 原任务恢复与生成保持暂停" : state.phase === "blocked" ? "目录已读完 部分记录需核对 视频工具未打开" : state.phase === "error" ? "视频历史尚未核对 原记录保持 工具未打开" : directory ? `已完整读取 ${directory.total} 条原生日志` : "尚未读取视频历史 工具未打开"}</p>
        {state.error && <p role="alert" className="studio-alert">{state.error}</p>}
        {directory && <><div className="studio-video-counts"><span><strong>{directory.total}</strong>全部记录</span><span><strong>{pending}</strong>原待处理</span><span><strong>{frozen}</strong>冻结历史</span><span><strong>{damaged}</strong>需核对</span></div>
          {directory.total === 0 ? <p className="studio-empty">已完整读取 当前范围没有原生视频日志</p> : <div className="studio-record-list">{directory.items.slice(0, shown).map(item => <article className="studio-record" key={item.entryId} data-video-entry-id={item.entryId} data-blocked={blocked.has(item.entryId) || undefined}><div><strong>{item.title || "未命名视频记录"}</strong><small>{({ pending: "待处理", success: "原记录已完成", failed: "原记录失败", unknown: "原状态未知" })[item.nativeStatus]} · {item.origin === "frozen" ? "来源历史副本 原任务已冻结" : item.origin === "invalid" ? "来源待核对" : "本人原记录"} · {({ none: "无任务关联", tracked: "已关联本人任务", untracked: "任务未匹配", invalid: "任务关联异常" })[item.task]}</small>
            {!!item.diagnostics.length && <p className="studio-video-diagnostic">{item.diagnostics.map(code => diagnostics[code]).join(" · ")}</p>}<details><summary>记录标识</summary><small>{item.key} · 版本 {item.revision}<br />{item.entryId}</small></details></div></article>)}</div>}
          {shown < directory.total && <button type="button" onClick={() => setShown(value => value + 50)}>显示更多记录 当前显示 {Math.min(shown, directory.total)}／{directory.total}</button>}
          <p className="studio-record-limit">目录已完整读取 列表分段显示 原状态与任务保持不变</p>
          <div className="studio-actions">{state.phase === "opened" ? <span><ShieldCheck size={14} />仅查看与编辑 原任务不恢复</span> : <button type="button" className="primary" disabled={busy || !["ready", "blocked"].includes(state.phase)} onClick={() => void helper.open()}><ArrowRight size={14} />核对并打开视频工作台</button>}</div>
        </>}
      </>}
  </section>;
}
