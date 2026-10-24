"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Download, RefreshCw, X } from "lucide-react";
import { StudioOriginalInspectionSchema, StudioOriginalNamespaceSchema, StudioPinnedResultRequestSchema, type StudioOriginalInspection, type StudioResultLookup } from "@yummyai/contracts/pod/studio-original";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { studioReadDenied, studioRpc, type StudioAsset, type StudioRequestContext } from "./studio-api";
import { createStudioResultIntents, type StoredResultIntent } from "./studio-result-intent";

type Call = <T>(input: Record<string, unknown>) => Promise<T>;
type Props = { scope: string; closing: boolean; onClose: () => void; onReadDenied: () => void; accessEpoch: { current: number }; capture: (signal?: AbortSignal) => StudioRequestContext; workspace?: StudioWorkspace };
type Selection = { asset: StudioAsset; mode: "review" | "submit" };
function facts(value?: StudioOriginalInspection) {
  if (!value) return "原件尺寸与大小尚未核对";
  const info = value.technical, size = `${value.source.byteSize.toLocaleString("zh-CN")} B`;
  if (info.status !== "verified") return `${info.status === "unknown" ? "原件参数未知" : info.status === "unsupported" ? "暂不支持检查此原件" : "原件未通过检查"} · 登记大小 ${size}`;
  if (info.kind === "audio") return `${info.durationSeconds.toFixed(2)} 秒 · ${size} · 容器与数据包已核对`;
  return `${info.displayWidth}×${info.displayHeight} px${info.kind === "image" ? ` · 原图已完整解码${info.orientation !== 1 ? ` · 编码 ${info.encodedWidth}×${info.encodedHeight} · 方向 ${info.orientation}` : ""}` : ` · ${info.durationSeconds.toFixed(2)} 秒 · 旋转 ${info.rotation}° · 容器与数据包已核对`} · ${size}`;
}
function originalAddress(asset: StudioAsset) { return { key: asset.key, namespace: StudioOriginalNamespaceSchema.parse(asset.namespace) }; }
function failure(cause: unknown) { return cause instanceof Error ? cause.message : "当前请求尚未核对 请保留原记录"; }

export function StudioOriginalRecords({ scope, closing, onClose, onReadDenied, accessEpoch, capture, workspace }: Props) {
  const [assets, setAssets] = useState<StudioAsset[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [inspectionRevision, setInspectionRevision] = useState(0);
  const [chosen, setChosen] = useState<Selection>(), [title, setTitle] = useState(""), [reference, setReference] = useState(""), [attested, setAttested] = useState(false), [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [inspections, setInspections] = useState<Record<string, StudioOriginalInspection>>({}), [intents, setIntents] = useState<StoredResultIntent[]>([]), [lookups, setLookups] = useState<Record<string, StudioResultLookup>>({});
  const [preview, setPreview] = useState<{ url: string; type: string; name: string }>();
  const live = useRef(false), epoch = useRef(accessEpoch.current), controller = useRef(new AbortController()), mutating = useRef(false), closingRef = useRef(closing), previewUrl = useRef<string | undefined>(undefined), workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  closingRef.current = closing;
  const supported = workspace?.originalHandoffVersion === 1;
  const current = useCallback(() => {
    if (!live.current || closingRef.current || controller.current.signal.aborted || epoch.current !== accessEpoch.current) throw new DOMException("原创作读取已结束", "AbortError");
  }, [accessEpoch]);
  useLayoutEffect(() => { live.current = true; if (controller.current.signal.aborted) controller.current = new AbortController(); return () => { live.current = false; controller.current.abort(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }; }, []);
  useLayoutEffect(() => { if (closing) controller.current.abort(); }, [closing]);
  useLayoutEffect(() => { if (chosen && workspace && !(chosen.mode === "review" ? workspace.capabilities.review : workspace.capabilities.submit)) { setChosen(undefined); setReference(""); setAttested(false); } }, [workspace, chosen]);
  const call: Call = useCallback(async <T,>(input: Record<string, unknown>) => {
    try { current(); if (["asset.inspect", "result.lookup", "result.submit.pinned"].includes(String(input.operation)) && workspaceRef.current?.originalHandoffVersion !== 1) throw new Error("当前创作服务尚未提供原件核对与固定送审 请联系管理员升级"); const context = capture(controller.current.signal); const result = await studioRpc<T>(scope, input, controller.current.signal, context); current(); return result; }
    catch (cause) { if (live.current && !controller.current.signal.aborted && studioReadDenied(cause)) onReadDenied(); throw cause; }
  }, [scope, capture, current, onReadDenied]);
  const originals = useMemo(() => createStudioResultIntents(scope, call, current), [scope, call, current]);
  const inspectionJobs = useRef<Array<() => Promise<void>>>([]), inspectionCount = useRef(0);
  const inspect = useCallback((asset: StudioAsset, signal?: AbortSignal) => new Promise<StudioOriginalInspection>((resolve, reject) => {
    const pump = () => { while (inspectionCount.current < 3 && inspectionJobs.current.length) { const job = inspectionJobs.current.shift()!; inspectionCount.current++; void job().finally(() => { inspectionCount.current--; pump(); }); } };
    inspectionJobs.current.push(async () => {
      try { current(); signal?.throwIfAborted();
        if (workspaceRef.current?.originalHandoffVersion !== 1) throw new Error("当前创作服务尚未提供原件核对 请联系管理员升级");
        const context = capture(signal ? AbortSignal.any([controller.current.signal, signal]) : controller.current.signal);
        const raw = await studioRpc(scope, { operation: "asset.inspect", ...originalAddress(asset) }, context.signal, context);
        current(); signal?.throwIfAborted(); if (workspaceRef.current?.originalHandoffVersion !== 1) throw new Error("原件检查能力已变化 请重新读取"); const value = StudioOriginalInspectionSchema.parse(raw);
        if (value.source.assetId !== asset.assetId || value.source.namespace !== asset.namespace) throw new Error("素材原件已变化 请刷新目录");
        setInspections(values => ({ ...values, [asset.assetId]: value })); resolve(value);
      } catch (cause) { if (live.current && !controller.current.signal.aborted && studioReadDenied(cause)) onReadDenied(); reject(cause); }
    }); pump();
  }), [capture, current, onReadDenied]);
  const remember = (item: StoredResultIntent) => { current(); setIntents(items => [item, ...items.filter(value => value.key !== item.key)]); };
  const lookup = useCallback(async (item: StoredResultIntent) => { const result = await originals.lookup(item); current(); setLookups(values => ({ ...values, [item.value.request.submissionId]: result })); return result; }, [originals, current]);
  const reload = useCallback(async () => {
    const result = await call<StudioAsset[]>({ operation: "assets" }); current(); setAssets(result); setInspections({}); setInspectionRevision(value => value + 1);
    if (!supported || scope === "unassigned") return;
    const restored = await originals.list(); current(); setIntents(restored.items);
    if (restored.unreadable) setError(`${restored.unreadable} 项原送审记录尚未读取 其他素材仍可核对`);
    const queue = [...restored.items];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { for (;;) { current(); const item = queue.shift(); if (!item) return; try { await lookup(item); } catch { current(); setNotice("部分原送审结果暂时无法核对 未自动重新提交"); } } }));
  }, [call, current, supported, scope, originals, lookup]);
  useEffect(() => { void reload().catch(cause => { if (live.current && !controller.current.signal.aborted) setError(failure(cause)); }).finally(() => { if (live.current && !controller.current.signal.aborted) setLoading(false); }); }, [reload]);
  async function perform(action: () => Promise<void>) {
    if (mutating.current) return; try { current(); } catch { return; }
    mutating.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { if (live.current && !controller.current.signal.aborted) setError(failure(cause)); }
    finally { mutating.current = false; if (live.current && !controller.current.signal.aborted) setBusy(false); }
  }
  async function execute(item: StoredResultIntent) {
    if (workspaceRef.current?.originalHandoffVersion !== 1 || !workspaceRef.current.capabilities.submit || !workspaceRef.current.capabilities.save) throw new Error("当前范围没有固定方案提交权限 原意图保持");
    try {
      const receipt = await originals.submit(item); current();
      setLookups(values => ({ ...values, [item.value.request.submissionId]: { status: "found", receipt } }));
      try { remember(await originals.record(item, "confirmed", receipt)); }
      catch { current(); setNotice("原方案回执已核对 意图状态保存尚未完成 刷新后可只读找回"); }
      setChosen(undefined);
    } catch (cause) {
      current();
      try { remember(await originals.record(item, "unknown")); } catch { current(); }
      setError(`原提交结果尚未核对 ${failure(cause)} 请只读找回原回执 未换新提交编号`);
    }
  }
  async function submit() {
    if (!chosen || chosen.mode !== "submit" || !supported || !workspace?.capabilities.submit || !workspace.capabilities.save || !attested || !title.trim() || !reference.trim()) return;
    const value = await inspect(chosen.asset); current();
    if (value.technical.status !== "verified" || value.technical.kind !== "image") throw new Error("方案原图未通过完整检查 请先核对原件");
    const prepared = await originals.prepare(StudioPinnedResultRequestSchema.parse({ operation: "result.submit.pinned", scope, key: chosen.asset.key, title, submissionId: crypto.randomUUID(), rightsAttested: true, sourceReference: reference, source: value.source }), replaceConfirmed);
    remember(prepared.item);
    if (!prepared.created) { await lookup(prepared.item); setNotice("此原件已有原送审意图 已只读核对 请在原记录继续 未自动提交新方案"); setChosen(undefined); return; }
    await execute(prepared.item);
  }
  const select = (asset: StudioAsset, mode: Selection["mode"]) => { setChosen({ asset, mode }); setTitle(asset.fileName.slice(0, 160)); setReference(""); setAttested(false); setReplaceConfirmed(false); };
  const review = async (decision: "approve" | "reject") => {
    if (!chosen || chosen.mode !== "review" || !workspace?.capabilities.review || !reference.trim() || !attested) return;
    await call({ operation: "asset.review", key: chosen.asset.key, decision, sourceReference: reference }); current(); setChosen(undefined); await reload();
  };
  const show = async (asset: StudioAsset) => {
    const inspected = supported ? await inspect(asset) : undefined;
    const value = await call<{ revision: number; assetId: string; media: { contentBase64: string; mediaType: string } }>({ operation: "state.get", ...originalAddress(asset) }); current();
    const binary = atob(value.media.contentBase64), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (inspected) {
      const source = inspected.source, checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join(""); current();
      if (value.revision !== source.revision || value.assetId !== source.assetId || value.media.mediaType !== source.mediaType || bytes.byteLength !== source.byteSize || checksum !== source.checksumSha256) throw new Error("预览原件与检查结果不一致 请刷新后重新读取");
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: value.media.mediaType }));
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = url; setPreview({ url, name: asset.fileName, type: value.media.mediaType });
  };
  const statuses: Record<string, string> = { unverified: "待审核", approved: "已批准参考素材", rejected: "已退回" };
  return <section className="studio-records" data-closing={closing || undefined} aria-label="素材与审核"><header><h2>项目素材与审核</h2><div className="studio-actions"><button type="button" disabled={busy || closing} onClick={() => void perform(reload)}><RefreshCw size={14} />刷新</button><button type="button" aria-label="关闭记录面板" onClick={onClose}><X size={16} /></button></div></header>
    <p className="studio-record-limit">本次最多读取 500 条素材记录 原件检查与参考素材批准 项目方案审核分别记录</p>
    {!supported && <p role="status">当前创作服务尚未提供原件核对与固定送审 请联系管理员升级 原有素材仍可读取</p>}
    {error && <p className="studio-alert" role="alert">{error}</p>}{notice && <p className="studio-alert" role="status">{notice}</p>}
    {loading ? <p role="status">正在读取原素材与送审记录</p> : <div className="studio-record-list">{[...new Map(assets.map(asset => [asset.assetId, asset])).values()].map(asset => <div className="studio-record" key={asset.assetId}>
      <div><strong>{asset.fileName}</strong><small>{asset.mediaType} · {statuses[asset.rightsStatus] ?? asset.rightsStatus} · {asset.aiGenerated ? "AI 生成" : "上传素材"}</small>
        {supported && <OriginalFact key={`${asset.assetId}:${inspectionRevision}`} asset={asset} value={inspections[asset.assetId]} inspect={inspect} />}
        {scope === "unassigned" ? <small>请先选择创意项目 再提交项目方案</small> : !asset.mediaType.startsWith("image/") && <small>视频与音频保留为创作素材 项目方案仅接收图片</small>}
      </div><div className="studio-actions"><button type="button" disabled={busy} onClick={() => void perform(() => show(asset))}>预览</button>
        {asset.rightsStatus === "unverified" && workspace?.capabilities.review && !(asset.aiGenerated && scope !== "unassigned" && asset.mediaType.startsWith("image/")) && <button type="button" disabled={busy} onClick={() => select(asset, "review")}>审核参考素材</button>}
        {supported && scope !== "unassigned" && asset.mediaType.startsWith("image/") && asset.rightsStatus !== "rejected" && workspace?.capabilities.submit && <button type="button" disabled={busy || !workspace.capabilities.save} onClick={() => select(asset, "submit")}>提交项目方案</button>}
      </div></div>)}{!assets.length && <p className="studio-empty">当前范围暂无可读素材 上传的图片与视频会保存在这里</p>}</div>}
    {chosen && <form className="studio-review" onSubmit={event => { event.preventDefault(); void perform(chosen.mode === "submit" ? submit : () => review("approve")); }}>
      <strong>{chosen.mode === "submit" ? "提交项目方案" : "审核参考素材"}：{chosen.asset.fileName}</strong>
      {chosen.mode === "submit" && <label>方案名称<input required maxLength={160} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>}
      <label>素材来源与使用依据<input required maxLength={500} value={reference} disabled={busy} onChange={event => setReference(event.target.value)} placeholder="例如 本人原创设计 或授权文件名称" /></label>
      <label className="studio-checkbox"><input type="checkbox" required checked={attested} disabled={busy} onChange={event => setAttested(event.target.checked)} />我已核对素材内容及使用权 可用于当前创作</label>
      {chosen.mode === "submit" && intents.some(item => item.value.request.key === chosen.asset.key && item.value.status === "confirmed") && <label className="studio-checkbox"><input type="checkbox" checked={replaceConfirmed} disabled={busy} onChange={event => setReplaceConfirmed(event.target.checked)} />原方案已提交 以当前输入明确建立一次新送审 保留原记录</label>}
      <div className="studio-actions"><button className="primary" type="submit" disabled={busy || !attested || !reference.trim()}>{chosen.mode === "submit" ? "保存意图并提交方案" : "批准作为参考素材"}</button>{chosen.mode === "review" && <button type="button" disabled={busy || !attested || !reference.trim()} onClick={() => void perform(() => review("reject"))}>退回参考素材</button>}<button type="button" onClick={() => setChosen(undefined)} disabled={busy}>取消</button></div>
    </form>}
    {supported && !!intents.length && <section aria-label="原项目方案送审记录"><h3>原项目方案送审记录</h3>{intents.map(item => {
      const recovered = lookups[item.value.request.submissionId];
      const receipt = recovered?.status === "found" ? recovered.receipt : item.value.status === "confirmed" ? item.value.receipt : undefined;
      return <div className="studio-record" key={item.key} data-studio-result-intent={item.key}><div><strong>{item.value.request.title}</strong><small>{receipt ? "原方案已提交 审核状态以项目为准" : "原提交结果尚未核对"}</small><small>{item.value.request.sourceReference}</small>{recovered?.status === "missing" && <p>当前未查到原回执 这不能证明从未提交 需要继续时仅按原输入同键重试</p>}</div><div className="studio-actions">
        <button type="button" disabled={busy} onClick={() => void perform(async () => { await lookup(item); })}>只读找回原回执</button>
        {receipt && item.value.status !== "confirmed" && workspace?.capabilities.save && <button type="button" disabled={busy} onClick={() => void perform(async () => {
          if (workspaceRef.current?.originalHandoffVersion !== 1 || !workspaceRef.current.capabilities.save) throw new Error("当前范围不能保存原回执 原意图保持");
          remember(await originals.record(item, "confirmed", receipt)); setNotice("已保存找回的原回执 未重新提交方案 需要新方案时可明确建立新送审");
        })}>保存已找回的原回执</button>}
        {receipt ? <Link href={`/creative-designs/canvas?brief=${receipt.batchId}`}>查看原项目审核</Link> : workspace?.capabilities.submit && workspace.capabilities.save && <button type="button" disabled={busy} onClick={() => void perform(() => execute(item))}>按原输入同键再次提交</button>}
      </div></div>;
    })}</section>}
    {preview && <div className="studio-preview"><div className="studio-actions"><a href={preview.url} download={preview.name}><Download size={14} />下载文件</a><button type="button" onClick={() => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); previewUrl.current = undefined; setPreview(undefined); }}>关闭预览</button></div>{preview.type.startsWith("image/") ? <img src={preview.url} alt={preview.name} /> : preview.type.startsWith("video/") ? <video src={preview.url} controls /> : <audio src={preview.url} controls />}</div>}
  </section>;
}
function OriginalFact({ asset, value, inspect }: { asset: StudioAsset; value?: StudioOriginalInspection; inspect: (asset: StudioAsset, signal?: AbortSignal) => Promise<StudioOriginalInspection> }) {
  const element = useRef<HTMLSpanElement>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!element.current) return; const controller = new AbortController(); let started = false;
    const observer = new IntersectionObserver(entries => { if (!started && entries.some(entry => entry.isIntersecting)) { started = true; observer.disconnect(); void inspect(asset, controller.signal).catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); }); } }, { rootMargin: "100px" });
    observer.observe(element.current); return () => { controller.abort(); observer.disconnect(); };
  }, [asset.assetId, asset.key, inspect]);
  return <small ref={element} data-studio-original-key={asset.key}>{error || facts(value)}</small>;
}
