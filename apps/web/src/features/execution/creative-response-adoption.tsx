"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, FileSearch, ImageIcon, RefreshCw, ShieldCheck, Square, X } from "lucide-react";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { assertStudioCurrent, useStudioAccessFence } from "../creative-studio/studio-api";
import { createCreativeResponseAdoptionClient, CreativeResponseAdoptionError, type CreativeResponseAdoptionPreview } from "./creative-response-adoption-client";
import { clearCreativeResponseAdoptionIntents, createCreativeResponseAdoptionIntent, type CreativeResponseAdoptionSnapshot } from "./creative-response-adoption-intent";
import "./creative-response-adoption.css";

const phases = { pending: "等待派发", preparing: "处理中", submitted: "已记录提交", response_staging: "保存原响应", response_ready: "原响应可恢复", completed: "技术处理完成", failed: "执行未完成", uncertain: "原提交待核对" };
const archiveStates = { registered_unverified: "原归档已登记 尚需核对", missing: "没有已登记原归档", expired: "已过保留期", purged: "原归档已清理" };
const requestStates = { prepared: "原采用已准备 尚未确认完成", processing: "原采用正在处理 尚未确认完成", committed: "原响应已采用为待审核候选", cancelled: "原采用已取消" };
type Access = ReturnType<typeof useStudioAccessFence>;
type Helper = ReturnType<typeof createCreativeResponseAdoptionIntent>;
type Binding = { helper: Helper; current: () => void };
type Preview = CreativeResponseAdoptionPreview & { url: string };
const current = (value: Binding) => { try { value.current(); return true; } catch { return false; } };
const denied = (cause: unknown) => cause instanceof CreativeResponseAdoptionError && ([401, 403, 404, 409, 410].includes(cause.status) || cause.code === "authority_changed");
const message = (cause: unknown) => cause instanceof Error ? cause.message : "原采用结果尚未核对 请保留原编号";

export function CreativeResponseAdoption({ executionId, onChanged }: { executionId: string; onChanged: () => Promise<void> }) {
  const access = useStudioAccessFence(`creative-response-adoption:${executionId}`);
  const router = useRouter();
  const refreshOwner = useCallback(async () => { await onChanged(); router.refresh(); }, [onChanged, router]);
  return <AdoptionPanel key={access.key} executionId={executionId} access={access} onChanged={refreshOwner} />;
}

function AdoptionPanel({ executionId, access, onChanged }: { executionId: string; access: Access; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false),
    [data, setData] = useState<CreativeResponseAdoptionSnapshot>(), [preview, setPreview] = useState<Preview>(),
    [loadedBasis, setLoadedBasis] = useState<string | null>(null), [acknowledgedBasis, setAcknowledgedBasis] = useState<string | null>(null),
    [error, setError] = useState(""), [notice, setNotice] = useState("");
  const live = useRef(false), blocked = useRef(false), epoch = useRef(0), mutating = useRef(false), abort = useRef<AbortController | null>(null),
    binding = useRef<Binding | null>(null), previewRef = useRef<Preview | null>(null), privateContent = useRef<HTMLDivElement | null>(null),
    closingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releasePreview = useCallback(() => { const value = previewRef.current; previewRef.current = null; if (value) URL.revokeObjectURL(value.url); }, []);
  const stop = useCallback(() => { epoch.current++; abort.current?.abort(); abort.current = null; binding.current = null; mutating.current = false; releasePreview(); }, [releasePreview]);
  const hide = useCallback(() => {
    if (privateContent.current) { privateContent.current.hidden = true; privateContent.current.inert = true; }
    stop();
  }, [stop]);
  const resetPreview = useCallback(() => { releasePreview(); setPreview(undefined); setLoadedBasis(null); setAcknowledgedBasis(null); }, [releasePreview]);

  useLayoutEffect(() => {
    live.current = true;
    const clear = () => {
      blocked.current = true; hide();
      if (closingTimer.current) clearTimeout(closingTimer.current);
      setOpen(false); setData(undefined); setPreview(undefined); setLoadedBasis(null); setAcknowledgedBasis(null); setBusy(false); setLoading(false); setError(""); setNotice("");
      try { clearCreativeResponseAdoptionIntents(window.sessionStorage); } catch { /* The lifecycle is already closed; no private body or command may resume. */ }
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.addEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear);
    return () => { live.current = false; hide(); if (closingTimer.current) clearTimeout(closingTimer.current); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(STUDIO_PERSONAL_CLEAR_EVENT, clear); };
  }, [hide]);

  useLayoutEffect(() => {
    if (!open || !access.available || blocked.current) return;
    const controller = new AbortController(), generation = ++epoch.current;
    abort.current = controller; mutating.current = true; setBusy(true); setLoading(true); setError(""); setNotice(""); setData(undefined); resetPreview();
    if (privateContent.current) { privateContent.current.hidden = false; privateContent.current.inert = false; }
    try {
      const context = access.capture(controller.signal);
      const assert = () => { if (!live.current || blocked.current || generation !== epoch.current) throw new DOMException("原采用读取已结束", "AbortError"); assertStudioCurrent(context); };
      const client = createCreativeResponseAdoptionClient({ executionId, authority: context.authority, signal: context.signal, current: assert });
      const helper = createCreativeResponseAdoptionIntent({ executionId, client, storage: window.sessionStorage, current: assert, id: () => crypto.randomUUID() });
      const owner: Binding = { helper, current: assert }; binding.current = owner;
      void helper.read().then(value => { if (current(owner)) setData(value); }).catch(cause => {
        if (!current(owner)) return;
        if (denied(cause)) { hide(); setData(undefined); setPreview(undefined); setOpen(false); setBusy(false); setLoading(false); }
        setError(message(cause));
      }).finally(() => { if (current(owner)) { mutating.current = false; setBusy(false); setLoading(false); } });
    } catch (cause) {
      if (generation === epoch.current && live.current) { setError(message(cause)); mutating.current = false; setBusy(false); setLoading(false); }
    }
    return () => { if (abort.current === controller) stop(); else controller.abort(); };
  }, [open, access.available, access.capture, executionId, hide, resetPreview, stop]);

  async function perform(action: (owner: Binding) => Promise<void>) {
    const owner = binding.current;
    if (!owner || mutating.current || !current(owner)) return;
    mutating.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(owner); if (current(owner)) setData(owner.helper.snapshot()); }
    catch (cause) {
      if (!current(owner)) return;
      if (denied(cause)) { hide(); setData(undefined); setPreview(undefined); setOpen(false); setBusy(false); setLoading(false); }
      else setData(owner.helper.snapshot());
      setError(message(cause));
    } finally { if (current(owner)) { mutating.current = false; setBusy(false); } }
  }
  function close() {
    stop(); resetPreview(); setBusy(false); setLoading(false); setOpen(false); setError(""); setNotice("");
    if (closingTimer.current) clearTimeout(closingTimer.current);
    closingTimer.current = setTimeout(() => { closingTimer.current = null; if (live.current) setData(undefined); }, 180);
  }
  function toggle() {
    if (open) { close(); return; }
    if (!access.available || blocked.current) return;
    if (closingTimer.current) clearTimeout(closingTimer.current);
    setOpen(true);
  }
  const workspace = data?.workspace, request = data?.request, receipt = request?.receipt;
  const previewReady = !!preview && loadedBasis === preview.basis && workspace?.basis === preview.basis;
  const acknowledged = previewReady && acknowledgedBasis === preview?.basis;
  const retryable = !!request && ["prepared", "processing"].includes(request.status) && request.canRetry && !request.leaseActive;
  const cleanupRetry = request?.status === "cancelled" && request.artifactCleanup === "pending";
  const cancellable = !!request && request.canCancel && (["prepared", "processing"].includes(request.status) || cleanupRetry);
  const canStart = !!workspace?.canAdopt && ["failed", "uncertain"].includes(workspace.originalPhase) && !workspace.requests.length && !data?.intent;
  const state = !open ? "closed" : loading ? "loading" : request?.status ?? (data?.intent ? "unknown" : error ? "error" : "ready");
  return <section className="creative-response-adoption" aria-label="原响应安全采用" data-execution-id={executionId} data-state={state}>
    <button type="button" className="creative-response-toggle" aria-expanded={open} disabled={!access.available} onClick={toggle}><FileSearch size={14} /><span>{open ? "收起原归档响应" : "查看原归档响应"}</span><ChevronDown size={14} /></button>
    {!open && error && <p role="alert" className="creative-response-error">{error}</p>}
    <div className="creative-response-collapse" data-open={open && access.available} aria-hidden={!open || !access.available} inert={!open || !access.available}><div ref={privateContent}>
      <header><h4>原响应安全采用</h4><div className="creative-response-actions"><button type="button" disabled={busy || !binding.current} onClick={() => void perform(async owner => { resetPreview(); await owner.helper.read(); })}><RefreshCw size={13} />{data?.intent ? "只读核对原采用请求" : "只读核对原归档"}</button><button type="button" aria-label="关闭原响应采用面板" onClick={close}><X size={14} /></button></div></header>
      <p className="creative-response-boundary">只读取已保存的原响应 不再次调用模型 采用后仍需权利核对和业务审核</p>
      {loading && <p role="status">正在读取原归档与原采用请求</p>}
      {error && <p role="alert" className="creative-response-error">{error}</p>}
      {workspace && <>
        <dl className="creative-response-facts">
          <dt>原执行状态</dt><dd>{phases[workspace.originalPhase]}</dd><dt>原候选状态</dt><dd>{workspace.candidateStatus}</dd>
          <dt>归档情况</dt><dd>{archiveStates[workspace.source.archiveState]}</dd><dt>原模型</dt><dd>{workspace.source.modelKey ?? "原记录未提供"}{workspace.source.modelVersion ? ` · ${workspace.source.modelVersion}` : ""}</dd>
          <dt>原渠道请求</dt><dd><code>{workspace.source.providerRequestId ?? "原记录未提供"}</code></dd>
          <dt>原输入校验</dt><dd><code>{workspace.source.inputFingerprint}</code></dd><dt>原响应校验</dt><dd><code>{workspace.source.responseChecksum ?? "原记录未提供"}</code></dd>
          <dt>加密归档校验</dt><dd><code>{workspace.source.encryptedChecksum ?? "原记录未提供"}</code></dd>
          <dt>保留期限</dt><dd>{workspace.source.archiveExpiresAt ? new Date(workspace.source.archiveExpiresAt).toLocaleString("zh-CN") : "原记录未提供"}</dd>
          <dt>原服务报告费用</dt><dd>{workspace.source.originalCostUsd === null ? "费用未知 不能按零处理" : `${workspace.source.originalCostUsd} USD · 尚未核对渠道账单`}</dd>
        </dl>
        {!!workspace.blockers.length && <ul className="creative-response-blockers">{workspace.blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        <div className="creative-response-actions"><button type="button" disabled={busy || !workspace.canInspectOriginal || !workspace.basis} onClick={() => void perform(async owner => {
          resetPreview(); const result = await owner.helper.inspect(); if (!current(owner)) return;
          const value = { ...result, url: URL.createObjectURL(result.blob) };
          if (!current(owner)) { URL.revokeObjectURL(value.url); return; }
          previewRef.current = value; setPreview(value);
        })}><ImageIcon size={13} />读取原图预览</button></div>
        {preview && <figure className="creative-response-preview"><img src={preview.url} alt="原任务归档响应预览" onLoad={event => {
          const owner = binding.current;
          if (!owner || !current(owner) || previewRef.current?.url !== preview.url || !event.currentTarget.naturalWidth || !event.currentTarget.naturalHeight) return;
          try { owner.helper.previewLoaded(preview.basis, preview.artifactChecksum); setLoadedBasis(preview.basis); } catch (cause) { resetPreview(); setError(message(cause)); }
        }} onError={() => { const owner = binding.current; if (owner && current(owner) && previewRef.current?.url === preview.url) { resetPreview(); setError("原图未能在当前浏览器完整显示 未允许采用 请保留原归档并核对"); } }} /><figcaption>{previewReady ? "原图已显示 请核对内容后再选择采用" : "正在显示原图 尚未允许采用"}<code>图片字节校验 {preview.artifactChecksum}</code></figcaption></figure>}
        {(canStart || retryable) && <div className="creative-response-confirmation"><label><input type="checkbox" disabled={busy || !previewReady} checked={acknowledged} onChange={event => setAcknowledgedBasis(event.target.checked && previewReady && preview ? preview.basis : null)} />我已核对这份原图 仅采用为待审核候选 权利尚未核对 仍需业务审核</label><button type="button" className="creative-response-primary" disabled={busy || !acknowledged} onClick={() => {
          const basis = acknowledgedBasis; if (!basis) return;
          setAcknowledgedBasis(null);
          void perform(async owner => { const value = data?.intent ? await owner.helper.retry(basis) : await owner.helper.adopt(basis); if (!current(owner)) return; setNotice(value.request?.status === "committed" ? "已核对采用回执 原执行状态仍按原记录显示" : "原请求已保留 尚未确认采用完成 请只读核对"); if (value.request?.status === "committed") await onChanged(); });
        }}><ShieldCheck size={14} />{data?.intent ? "按原键重试采用" : "采用原归档响应"}</button></div>}
      </>}
      {data?.intent && <div className="creative-response-request" aria-label="原采用请求"><p role="status">{request ? requestStates[request.status] : data.lookupMissing ? "原采用请求尚未找到 不等于未提交 保留原编号 仅可只读核对" : "原采用结果尚未核对 保留原编号 仅可只读核对"}</p>
        {request?.status === "processing" && !request.canRetry && !request.leaseActive && <p>原本地上传尚未确认结束 仅可只读核对</p>}
        <dl className="creative-response-facts"><dt>原请求编号</dt><dd><code>{data.intent.command.requestId}</code></dd><dt>原采用依据</dt><dd><code>{data.intent.command.expectedBasis}</code></dd>{request && <><dt>本地处理尝试</dt><dd>{request.attempts} / 3</dd><dt>产物清理</dt><dd>{{ not_required: "无需清理", pending: "尚未完成 需核对原清理结果", complete: "已清理本次未采用产物", registered: "已登记原产物" }[request.artifactCleanup]}</dd>{request.errorCode && <><dt>原处理代码</dt><dd><code>{request.errorCode}</code></dd></>}</>}</dl>
        {cancellable && <button type="button" disabled={busy} onClick={() => void perform(async owner => {
          const value = await owner.helper.cancel(); if (!current(owner)) return;
          setNotice(value.request?.status === "committed" ? "原采用已经完成 取消未撤销候选 仍需业务审核"
            : value.request?.status === "cancelled" && value.request.artifactCleanup === "pending" ? "本次采用已取消 清理尚未完成 请保留原请求核对或重试清理"
              : value.request?.status === "cancelled" ? "已核对原取消与清理回执 原任务状态保持" : "原取消结果尚未确认 请只读核对原请求");
          if (["committed", "cancelled"].includes(value.request?.status ?? "")) await onChanged();
        })}>{cleanupRetry ? <RefreshCw size={13} /> : <Square size={13} />}{cleanupRetry ? "重试清理本次未采用产物" : "取消本次采用"}</button>}
      </div>}
      {receipt && <section className="creative-response-receipt" aria-label="原响应采用回执"><h4><ShieldCheck size={14} />已采用为待审核候选</h4><p>候选已生成 · 权利未核对 · 仍需业务审核</p><p>采用时原执行为{phases[receipt.originalPhase]} 本次采用未将原失败或未知执行标记为完成</p><dl className="creative-response-facts"><dt>采用回执</dt><dd><code>{receipt.id}</code></dd><dt>原候选</dt><dd><code>{receipt.candidateId}</code></dd><dt>原图片资产</dt><dd><code>{receipt.artifact.assetId}</code> · v{receipt.artifact.version} · {receipt.artifact.width} × {receipt.artifact.height}</dd><dt>产物校验</dt><dd><code>{receipt.artifact.checksumSha256}</code></dd></dl>{workspace && <Link href={`/creative-designs?batch=${workspace.batchId}`}>定位原设计批次</Link>}</section>}
      {notice && <p role="status" className="creative-response-notice">{notice}</p>}
    </div></div>
  </section>;
}
