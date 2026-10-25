"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileSearch, ImageIcon, RefreshCw, ShieldCheck, Square, X } from "lucide-react";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { assertStudioCurrent, useStudioAccessFence } from "../creative-studio/studio-api";
import { createCreativeOwnerResponseAdoptionClient, CreativeOwnerResponseAdoptionError, type CreativeOwnerResponseAdoptionExpected, type CreativeOwnerResponseAdoptionPreview } from "./creative-owner-response-adoption-client";
import type { CreativeOwnerResponseAdoptionReceipt } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { clearCreativeOwnerResponseAdoptionIntents, createCreativeOwnerResponseAdoptionIntent, type CreativeOwnerResponseAdoptionSnapshot } from "./creative-owner-response-adoption-intent";
import "./creative-response-adoption.css";

const phases = { pending: "等待派发", preparing: "处理中", submitted: "已记录提交", response_staging: "保存原响应", response_ready: "原响应可恢复", completed: "技术处理完成", failed: "执行未完成", uncertain: "原提交待核对" };
const archiveStates = { registered_unverified: "原归档已登记 尚需核对", missing: "没有已登记原归档", expired: "已过保留期", purged: "原归档已清理" };
const requestStates = { prepared: "原恢复已准备 尚未确认完成", processing: "原恢复正在处理 尚未确认完成", committed: "原响应已登记为未审核产物", cancelled: "原恢复已取消" };
const kinds = { creative_adaptation: "画幅适配", template_compile: "模板编译", mockup_render: "场景套图", studio_generation: "工作台生成" };
const dispositions: Record<CreativeOwnerResponseAdoptionReceipt["disposition"], string> = {
  aspect_ready: "已登记画幅适配产物", outpaint_artifact_ready: "已登记扩图产物", template_inspected: "已登记模板检查产物",
  mockup_ready: "已登记场景套图产物", studio_image_ready: "已登记工作台图片原件",
};
type Access = ReturnType<typeof useStudioAccessFence>;
type Helper = ReturnType<typeof createCreativeOwnerResponseAdoptionIntent>;
type Binding = { helper: Helper; current: () => void };
type Preview = CreativeOwnerResponseAdoptionPreview & { url: string };
const current = (value: Binding) => { try { value.current(); return true; } catch { return false; } };
const denied = (cause: unknown) => cause instanceof CreativeOwnerResponseAdoptionError && ([401, 403, 404, 409, 410].includes(cause.status) || cause.code === "authority_changed");
const message = (cause: unknown) => cause instanceof Error ? cause.message : "原采用结果尚未核对 请保留原编号";

export function CreativeOwnerResponseAdoption({ executionId, expected, onChanged }: { executionId: string; expected: CreativeOwnerResponseAdoptionExpected; onChanged: () => Promise<void> }) {
  const access = useStudioAccessFence(`creative-owner-response-adoption:${executionId}`);
  const router = useRouter();
  const refreshOwner = useCallback(async () => { await onChanged(); router.refresh(); }, [onChanged, router]);
  return <AdoptionPanel key={access.key} executionId={executionId} expected={expected} access={access} onChanged={refreshOwner} />;
}

function AdoptionPanel({ executionId, expected, access, onChanged }: { executionId: string; expected: CreativeOwnerResponseAdoptionExpected; access: Access; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false),
    [data, setData] = useState<CreativeOwnerResponseAdoptionSnapshot>(), [preview, setPreview] = useState<Preview>(),
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
      try { clearCreativeOwnerResponseAdoptionIntents(window.sessionStorage); } catch { /* The lifecycle is already closed; no private body or command may resume. */ }
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
      const client = createCreativeOwnerResponseAdoptionClient({ executionId, expected, authority: context.authority, signal: context.signal, current: assert });
      const helper = createCreativeOwnerResponseAdoptionIntent({ executionId, client, storage: window.sessionStorage, current: assert, id: () => crypto.randomUUID() });
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
  }, [open, access.available, access.capture, executionId, expected.kind, expected.stepKey, expected.parentExecutionId, expected.inputFingerprint, hide, resetPreview, stop]);

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
  return <section className="creative-response-adoption creative-owner-response-adoption" aria-label="原业务响应安全恢复" data-execution-id={executionId} data-owner-kind={expected.kind} data-state={state}>
    <button type="button" className="creative-response-toggle" aria-expanded={open} disabled={!access.available} onClick={toggle}><FileSearch size={14} /><span>{open ? "收起原业务归档响应" : "查看原业务归档响应"}</span><ChevronDown size={14} /></button>
    {!open && error && <p role="alert" className="creative-response-error">{error}</p>}
    <div className="creative-response-collapse" data-open={open && access.available} aria-hidden={!open || !access.available} inert={!open || !access.available}><div ref={privateContent}>
      <header><h4>{kinds[expected.kind]}原响应恢复</h4><div className="creative-response-actions"><button type="button" disabled={busy || !binding.current} onClick={() => void perform(async owner => { resetPreview(); await owner.helper.read(); })}><RefreshCw size={13} />{data?.intent ? "只读核对原恢复请求" : "只读核对原业务归档"}</button><button type="button" aria-label="关闭原业务响应恢复面板" onClick={close}><X size={14} /></button></div></header>
      <p className="creative-response-boundary">只读取本任务已保存的原响应 不再次调用模型 恢复后仍需权利核对和业务审核 未送审 未批准生产</p>
      {loading && <p role="status">正在读取原归档与原采用请求</p>}
      {error && <p role="alert" className="creative-response-error">{error}</p>}
      {workspace && <>
        <dl className="creative-response-facts">
          <dt>原业务</dt><dd>{kinds[workspace.kind]} · {workspace.stepKey}</dd><dt>原任务</dt><dd><code>{workspace.ownerId}</code></dd>
          <dt>原执行状态</dt><dd>{phases[workspace.originalPhase]}</dd><dt>当前任务状态</dt><dd>{workspace.ownerStatus}</dd>
          <dt>归档情况</dt><dd>{archiveStates[workspace.source.archiveState]}</dd>
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
        <p className="creative-response-boundary">预览只展示归档中的一张可显示图片 其他图片或模板数据不代表已核对 恢复回执逐份保留真实产物角色和校验</p>
        {preview && <figure className="creative-response-preview"><img src={preview.url} alt="原业务响应图片预览" onLoad={event => {
          const owner = binding.current;
          if (!owner || !current(owner) || previewRef.current?.url !== preview.url || !event.currentTarget.naturalWidth || !event.currentTarget.naturalHeight) return;
          try { owner.helper.previewLoaded(preview.basis, preview.artifactChecksum); setLoadedBasis(preview.basis); } catch (cause) { resetPreview(); setError(message(cause)); }
        }} onError={() => { const owner = binding.current; if (owner && current(owner) && previewRef.current?.url === preview.url) { resetPreview(); setError("原图未能在当前浏览器完整显示 未允许采用 请保留原归档并核对"); } }} /><figcaption>{previewReady ? "原图已显示 请核对内容后再选择采用" : "正在显示原图 尚未允许采用"}<code>图片字节校验 {preview.artifactChecksum}</code></figcaption></figure>}
        {(canStart || retryable) && <div className="creative-response-confirmation"><label><input type="checkbox" disabled={busy || !previewReady} checked={acknowledged} onChange={event => setAcknowledgedBasis(event.target.checked && previewReady && preview ? preview.basis : null)} />我已查看这份原图预览 仅恢复原任务的未审核产物 其他文件及权利仍需核对 未送审 未批准生产</label><button type="button" className="creative-response-primary" disabled={busy || !acknowledged} onClick={() => {
          const basis = acknowledgedBasis; if (!basis) return;
          setAcknowledgedBasis(null);
          void perform(async owner => { const value = data?.intent ? await owner.helper.retry(basis) : await owner.helper.adopt(basis); if (!current(owner)) return; setNotice(value.request?.status === "committed" ? "已核对采用回执 原执行状态仍按原记录显示" : "原请求已保留 尚未确认采用完成 请只读核对"); if (value.request?.status === "committed") await onChanged(); });
        }}><ShieldCheck size={14} />{data?.intent ? "按原键重试恢复" : "恢复原业务归档响应"}</button></div>}
      </>}
      {data?.intent && <div className="creative-response-request" aria-label="原采用请求"><p role="status">{request ? requestStates[request.status] : data.lookupMissing ? "原采用请求尚未找到 不等于未提交 保留原编号 仅可只读核对" : "原采用结果尚未核对 保留原编号 仅可只读核对"}</p>
        {request?.status === "processing" && !request.canRetry && !request.leaseActive && <p>原本地上传尚未确认结束 仅可只读核对</p>}
        <dl className="creative-response-facts"><dt>原请求编号</dt><dd><code>{data.intent.command.requestId}</code></dd><dt>原采用依据</dt><dd><code>{data.intent.command.expectedBasis}</code></dd>{request && <><dt>本地处理尝试</dt><dd>{request.attempts} / 3</dd><dt>产物清理</dt><dd>{{ not_required: "无需清理", pending: "尚未完成 需核对原清理结果", complete: "已清理本次未采用产物", registered: "已登记原产物" }[request.artifactCleanup]}</dd>{request.errorCode && <><dt>原处理代码</dt><dd><code>{request.errorCode}</code></dd></>}</>}</dl>
        {cancellable && <button type="button" disabled={busy} onClick={() => void perform(async owner => {
          const value = await owner.helper.cancel(); if (!current(owner)) return;
          setNotice(value.request?.status === "committed" ? "原恢复已经完成 取消未撤销已登记产物 仍需业务审核"
            : value.request?.status === "cancelled" && value.request.artifactCleanup === "pending" ? "本次采用已取消 清理尚未完成 请保留原请求核对或重试清理"
              : value.request?.status === "cancelled" ? "已核对原取消与清理回执 原任务状态保持" : "原取消结果尚未确认 请只读核对原请求");
          if (["committed", "cancelled"].includes(value.request?.status ?? "")) await onChanged();
        })}>{cleanupRetry ? <RefreshCw size={13} /> : <Square size={13} />}{cleanupRetry ? "重试清理本次未采用产物" : "取消本次采用"}</button>}
      </div>}
      {receipt && <section className="creative-response-receipt" aria-label="原业务响应恢复回执">
        <h4><ShieldCheck size={14} />{dispositions[receipt.disposition]}</h4>
        <p>原产物已登记 · 权利未核对 · 仍需业务审核 · 未送审 · 未批准生产</p>
        <p>恢复时原执行为{phases[receipt.originalPhase]} 原失败或未知执行及其费用记录仍保留</p>
        <dl className="creative-response-facts"><dt>恢复回执</dt><dd><code>{receipt.id}</code></dd><dt>原业务任务</dt><dd>{kinds[receipt.kind]} · <code>{receipt.ownerId}</code></dd>
          <dt>原步骤</dt><dd>{receipt.stepKey}</dd><dt>采用时任务状态</dt><dd>{receipt.ownerStatus}</dd><dt>业务交接校验</dt><dd><code>{receipt.ownerReceiptChecksum}</code></dd>
          <dt>原响应校验</dt><dd><code>{receipt.responseChecksum}</code></dd><dt>原服务报告费用</dt><dd>{receipt.originalCostUsd === null ? "费用未知 不能按零处理" : `${receipt.originalCostUsd} USD · 尚未核对渠道账单`}</dd></dl>
        <section aria-label="恢复产物固定清单"><h4>本次固定产物 {receipt.artifacts.length} 份</h4>{receipt.artifacts.map((artifact, index) => <article key={`${artifact.role}:${artifact.assetId}:${index}`} aria-label={`恢复产物 ${index + 1}`}>
          <dl className="creative-response-facts"><dt>真实角色</dt><dd>{artifact.role}</dd><dt>原资产版本</dt><dd><code>{artifact.assetId}</code> · v{artifact.version}</dd>
            <dt>文件类型</dt><dd>{artifact.mediaType}</dd><dt>原文件字节数</dt><dd>{artifact.byteSize} B</dd><dt>原像素</dt><dd>{artifact.width !== null && artifact.height !== null ? `${artifact.width} × ${artifact.height}` : "此文件未提供像素尺寸"}</dd>
            <dt>产物校验</dt><dd><code>{artifact.checksumSha256}</code></dd></dl>
        </article>)}</section>
        <p>请在当前原业务任务继续逐份核对和审核 本次恢复不代替送审或生产放行</p>
      </section>}
      {notice && <p role="status" className="creative-response-notice">{notice}</p>}
    </div></div>
  </section>;
}
