"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Copy, FolderOpen, RefreshCw, X } from "lucide-react";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT, type StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { StudioTransferPreviewSchema, type StudioTransferPreview, type StudioTransferRequest, type StudioTransferLookup } from "@yummyai/contracts/pod/studio-document-transfer";
import type { CanvasProjectSummary } from "@yummyai/contracts/pod/canvas-bridge";
import { assertStudioCurrent, studioRpc, type StudioRequestContext } from "./studio-api";
import { assistIntentHash } from "../ai-assist/assist-request-intent";
import { clearStudioTransferIntents, createStudioDocumentTransfer, studioTransferTarget, studioTransferVault } from "./studio-document-transfer-intent";
type Helper = ReturnType<typeof createStudioDocumentTransfer>;
const countNames = { canvases: "画布", prompts: "提示词", assets: "素材条目", imageDrafts: "图片输入草稿", videoDrafts: "视频输入草稿", history: "历史记录", media: "原件引用" };
export function StudioDocumentTransfer({ scope, workspace, projects, capture, flush, onBusy }: {
  scope: string; workspace?: StudioWorkspace; projects: CanvasProjectSummary[]; capture: (signal?: AbortSignal) => StudioRequestContext; flush: () => Promise<void>; onBusy: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false), [closing, setClosing] = useState(false), [busy, setBusy] = useState(false), [target, setTarget] = useState(""), [error, setError] = useState("");
  const [preview, setPreview] = useState<StudioTransferPreview>(), [request, setRequest] = useState<StudioTransferRequest>(), [found, setFound] = useState<StudioTransferLookup>(), [ready, setReady] = useState(false);
  const [history, setHistory] = useState<StudioTransferLookup[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [historyLoaded, setHistoryLoaded] = useState(false), [loadingHistory, setLoadingHistory] = useState(true), [unavailableHistory, setUnavailableHistory] = useState(0);
  const helper = useRef<Helper | undefined>(undefined), alive = useRef(false), running = useRef(false), epoch = useRef(0), closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const available = workspace?.documentTransferVersion === 1;
  const adoptRecovery = (value: Awaited<ReturnType<Helper["recover"]>>) => {
    if (value.found) { setRequest(value.found.request); setTarget(value.found.request.targetScope); setFound(value.found); }
    setHistory(value.items); setNextCursor(value.nextCursor); setUnavailableHistory(value.unavailableOnPage); setHistoryLoaded(value.historyLoaded); setLoadingHistory(false); setReady(true);
  };
  useEffect(() => {
    alive.current = true; const controller = new AbortController(), generation = ++epoch.current; let context: StudioRequestContext;
    setReady(false); setLoadingHistory(available);
    const current = () => { if (!alive.current || generation !== epoch.current) throw new DOMException("复制归属已变化", "AbortError"); assertStudioCurrent(context); };
    const clear = () => {
      epoch.current++; controller.abort(); helper.current = undefined; running.current = false; setBusy(false); onBusy(false); setReady(false); setOpen(false); setPreview(undefined); setRequest(undefined); setFound(undefined); setTarget(""); setError(""); setHistory([]); setNextCursor(null); setUnavailableHistory(0); setHistoryLoaded(false); setLoadingHistory(false);
      try { clearStudioTransferIntents(sessionStorage); } catch { /* No late value may recreate a marker after this synchronous fence. */ }
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    if (available) {
      try { context = capture(controller.signal); void assistIntentHash(context.ownerScope).then(async hash => {
        current(); const value = createStudioDocumentTransfer({ scope, current, vault: studioTransferVault(hash, sessionStorage), call: input => studioRpc(scope, input, controller.signal, context) }); helper.current = value;
        const prior = value.originals()[0];
        if (prior) { setRequest(prior); setTarget(prior.targetScope); }
        const recovered = await value.recover(); current(); adoptRecovery(recovered);
      }).catch(cause => { if (!controller.signal.aborted && generation === epoch.current) { setLoadingHistory(false); setError(cause instanceof Error ? cause.message : "原复制标识暂不可读取"); } }); }
      catch (cause) { setLoadingHistory(false); setError(cause instanceof Error ? cause.message : "本人创作范围尚未核对"); }
    }
    return () => { alive.current = false; epoch.current++; controller.abort(); helper.current = undefined; onBusy(false); if (closeTimer.current) clearTimeout(closeTimer.current); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear); };
  }, [scope, available, capture, onBusy]);
  async function perform(action: () => Promise<void>) {
    if (running.current || !helper.current) return; const generation = epoch.current;
    running.current = true; setBusy(true); onBusy(true); setError("");
    try { await action(); } catch (cause) { if (alive.current && generation === epoch.current) setError(cause instanceof Error ? cause.message : "复制尚未完成 请只读核对原请求"); }
    finally { if (alive.current && generation === epoch.current) { running.current = false; setBusy(false); onBusy(false); } }
  }
  async function readHistory(next: boolean) {
    const current = helper.current!;
    if (!ready) { const recovered = await current.recover(); if (helper.current !== current) throw new DOMException("复制归属已变化", "AbortError"); adoptRecovery(recovered); return; }
    const page = await current.requests(next && nextCursor ? nextCursor : undefined); if (helper.current !== current) throw new DOMException("复制归属已变化", "AbortError");
    setHistory(prior => next ? [...new Map([...prior, ...page.items].map(item => [item.request.requestId, item])).values()] : page.items);
    setNextCursor(page.nextCursor); setUnavailableHistory(prior => next ? prior + page.unavailableOnPage : page.unavailableOnPage); setHistoryLoaded(true);
  }
  const close = () => { if (busy || closing) return; if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setOpen(false); return; } setClosing(true); closeTimer.current = setTimeout(() => { closeTimer.current = undefined; setOpen(false); setClosing(false); }, 160); };
  const counts = found?.receipt?.counts ?? preview?.counts;
  return <><button type="button" disabled={!available} aria-expanded={open} onClick={() => { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = undefined; setClosing(false); setOpen(true); }}><Copy size={14} />复制创作资料到项目</button>
    {!available && <span className="studio-record-limit">当前创作服务尚未提供完整资料复制</span>}
    {open && <section className="studio-records studio-transfer" role="dialog" aria-label="复制创作资料到项目" data-closing={closing || undefined} onKeyDown={event => { if (event.key === "Escape") close(); }}>
      <header><h2>复制创作资料到项目</h2><button type="button" aria-label="关闭资料复制" disabled={busy} onClick={close}><X size={15} /></button></header>
      <p>来源 {scope === "unassigned" ? "个人工作区（未关联项目）" : projects.find(item => item.id === scope)?.name ?? "当前项目"} · 目标已有内容保留 追加为独立副本</p>
      <div className="studio-actions"><button type="button" disabled={busy || loadingHistory || !helper.current} onClick={() => void perform(() => readHistory(false))}><RefreshCw size={14} />{!ready ? "重试恢复原复制请求" : "读取本人复制历史"}</button>{nextCursor && <button type="button" disabled={busy || loadingHistory || !ready} onClick={() => void perform(() => readHistory(true))}>读取下一页复制历史</button>}</div>
      {loadingHistory && <p role="status">正在只读找回本人原复制记录 未建立新请求</p>}
      {!!history.length && <label className="studio-transfer-target">本人历史<select aria-label="本人复制历史" value={request?.requestId ?? ""} disabled={busy || loadingHistory} onChange={event => {
        const selected = history.find(item => item.request.requestId === event.target.value); if (!selected) return;
        void perform(async () => {
          const current = helper.current!, active = current.originals()[0];
          if (active && active.requestId !== selected.request.requestId) {
            const checked = await current.lookup(active); setRequest(active); setTarget(active.targetScope); setFound(checked);
            throw new Error(checked.status === "prepared" ? "当前准备仍保留 请先明确取消本次准备 再结束当前记录后选择历史" : checked.status === "missing" ? "当前原结果尚未证明 保留原请求 请先只读核对" : "当前原记录已核对 请先点击保留原记录并重新预览 再选择历史");
          }
          const restored = await current.restore(selected.request, selected); setRequest(restored.request); setTarget(restored.request.targetScope); setFound(restored); setPreview(undefined);
        });
      }}><option value="" disabled>选择服务端原复制记录</option>{request && !history.some(item => item.request.requestId === request.requestId) && <option value={request.requestId}>当前原请求 · {request.requestId}</option>}{history.map(item => <option key={item.request.requestId} value={item.request.requestId}>{item.status === "prepared" ? "已固定待确认" : item.status === "committed" ? "已追加副本" : "已取消"} · {item.request.requestId}</option>)}</select></label>}
      {historyLoaded && !history.length && <p className="studio-record-limit">本页暂无当前可读取的复制历史 {nextCursor ? "可继续读取下一页" : "当前可读取历史已查完"}</p>}
      {!!unavailableHistory && <p className="studio-record-limit">本次读取中有 {unavailableHistory} 条历史当前不可读取 未显示其详情</p>}
      <label className="studio-transfer-target"><FolderOpen size={14} />最近项目<select aria-label="复制目标项目" value={projects.some(item => item.id === target) ? target : ""} disabled={busy || !!request} onChange={event => { setTarget(event.target.value); setPreview(undefined); }}><option value="">选择已有项目</option>{projects.filter(item => item.id !== scope).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="studio-transfer-target">项目链接或 UUID<input aria-label="目标项目链接或 UUID" value={target} disabled={busy || !!request} placeholder="粘贴本站项目链接或项目 UUID" onChange={event => { setTarget(event.target.value); setPreview(undefined); }} /></label>
      <p className="studio-record-limit">最近项目列表仅供选择 其他已有项目可粘贴链接 权限与目标内容由服务端核对</p>
      {error && <p role="alert" className="studio-alert">{error}</p>}
      {!request && <button type="button" disabled={!target || busy || !ready} onClick={() => void perform(async () => {
        const destination = studioTransferTarget(target, location.origin); if (destination === scope) throw new Error("请选择另一个目标项目 原项目内容保持");
        const current = helper.current!; await flush(); if (helper.current !== current) throw new Error("创作归属已变化");
        const context = capture(), value = StudioTransferPreviewSchema.parse(await studioRpc(scope, { operation: "document.preview", targetScope: destination }, context.signal, context)); assertStudioCurrent(context);
        if (value.sourceScope !== scope || value.targetScope !== destination) throw new Error("复制预览归属不一致"); setPreview(value);
      })}>{busy ? "正在保存全部输入并核对" : "保存全部输入并预览"}</button>}
      {counts && <dl className="studio-transfer-counts">{Object.entries(counts).map(([name, count]) => <div key={name}><dt>{countNames[name as keyof typeof countNames]}</dt><dd>{count}</dd></div>)}</dl>}
      {preview && !request && <><p>原件和来源权限已按当前清单核对 原任务与送审意图不会跟随执行</p>{!!preview.excluded.length && <details><summary>未复制的原项目动作及配置 · {preview.excluded.length}</summary>{preview.excluded.map((item, index) => <p key={index}>{item}</p>)}</details>}<button type="button" disabled={busy} onClick={() => void perform(async () => {
        const input: StudioTransferRequest = { scope, targetScope: preview.targetScope, requestId: crypto.randomUUID(), manifestHash: preview.manifestHash };
        // Local read-proof precedes prepare. Keep this same input on every failure.
        const operation = helper.current!.prepare(input); setRequest(input); setFound(undefined); setFound(await operation);
      })}>固定本次复制清单</button></>}
      {request && <><p className="studio-record-limit">原请求 {request.requestId} · {found?.status === "committed" ? "副本已追加" : found?.status === "cancelled" ? "本次准备已取消 原记录保留" : found?.status === "prepared" ? "清单已固定 尚未追加" : "原结果尚未核对"}</p>
        <div className="studio-actions"><button type="button" disabled={busy || loadingHistory} onClick={() => void perform(async () => { setFound(await helper.current!.lookup(request)); })}><RefreshCw size={14} />只读核对原复制结果</button>
          {found?.status === "prepared" && <><button type="button" className="primary" disabled={busy} onClick={() => void perform(async () => { setFound(undefined); setFound(await helper.current!.commit(request)); })}>确认追加副本</button><button type="button" disabled={busy} onClick={() => void perform(async () => { setFound(undefined); setFound(await helper.current!.cancel(request)); })}>取消本次准备</button></>}
          {found?.status === "missing" && <button type="button" disabled={busy} onClick={() => void perform(async () => { setFound(undefined); setFound(await helper.current!.prepare(request)); })}>按原请求重新固定清单</button>}
          {found?.status === "committed" && <Link href={`/creative-designs/studio/canvas?brief=${request.targetScope}`}>打开目标项目副本</Link>}
          {(found?.status === "committed" || found?.status === "cancelled") && <button type="button" disabled={busy} onClick={() => void perform(async () => { helper.current!.beginAnother(request, found); setRequest(undefined); setFound(undefined); setPreview(undefined); })}>保留原记录并重新预览</button>}
        </div>{found?.status === "missing" && <p>当前未找到固定请求 这不证明从未提交 继续时保留原输入与原编号</p>}
        {found?.receipt && <p role="status">已追加 {found.receipt.counts.canvases} 张画布及相关创作资料 当前仍停留来源工作区</p>}
      </>}
      <p className="studio-record-limit">复制的输入草稿可在目标图片或视频工作台显式选择 撤销栈与独立 Agent 内存会话不在本次资料中</p>
    </section>}
    <style>{`.studio-transfer{margin-top:12px;background:var(--panel);max-width:860px;animation:studio-access-enter .18s ease-out}.studio-transfer-target{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}.studio-transfer-target select,.studio-transfer-target input{flex:1;min-width:160px;max-width:100%}.studio-transfer-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:14px 0}.studio-transfer-counts div{padding:8px 0;border-bottom:1px solid var(--border)}.studio-transfer-counts dt{font-size:11px;color:var(--muted)}.studio-transfer-counts dd{margin:4px 0 0;font-size:18px;font-weight:600}.studio-transfer details{max-height:180px;overflow:auto;margin:10px 0}.studio-transfer p{overflow-wrap:anywhere}@media(max-width:600px){.studio-transfer-counts{grid-template-columns:repeat(2,minmax(0,1fr))}}`}</style>
  </>;
}
