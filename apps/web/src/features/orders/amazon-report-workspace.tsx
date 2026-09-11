"use client";

import type { AmazonReportBatchView, AmazonReportDetailView, AmazonReportLineView, AmazonReportWorkspaceView, MarketplaceAccountView } from "@yummyai/contracts";
import { AmazonReportBatchViewSchema, AmazonReportDetailViewSchema, AmazonReportWorkspaceViewSchema } from "@yummyai/contracts/order/report";
import { Check, ChevronLeft, ChevronRight, Download, FileArchive, FileUp, ImageOff, LoaderCircle, Maximize2, RefreshCw, Search, Upload, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { ProductionEditorSession } from "../production-editor/production-editor-session";

const reportLimit = 5 * 1024 * 1024;
const zipLimit = 20 * 1024 * 1024;
const pageSize = 20;
const stateLabels: Record<AmazonReportLineView["state"], string> = { none: "无定制附件", pending: "等待解析", processing: "处理中", ready: "可查看", partial: "部分内容可查看", failed: "需要处理", expired: "文件已到期" };
const errorLabels: Record<string, string> = { unsafe_url: "附件链接不属于允许的亚马逊下载地址，请补传原始 ZIP。", download_failed: "附件下载失败，可以重试或补传 ZIP。", download_timeout: "附件下载超时，请重试。", link_unavailable: "定制链接已失效或不可用，请从亚马逊下载 ZIP 后补传。", archive_too_large: "定制 ZIP 超过允许大小，请检查附件。", scan_unavailable: "文件检查服务暂不可用，请稍后重试。", file_rejected: "附件未通过文件安全检查，无法提供预览。", archive_invalid: "ZIP 结构无法识别，请补传亚马逊原始定制 ZIP。", marketplace_mismatch: "报告站点与所选站点不一致，请核对导入站点。", merchant_mismatch: "报告卖家与所选店铺不一致，请核对订单所属店铺。", quantity_mismatch: "同一订单行的数量发生冲突，请核对原始报告。", report_conflict: "报告与已有订单存在冲突，请检查原始订单。", customization_missing: "此订单应有定制信息，但报告没有提供附件，请补传 ZIP。", source_changed: "定制附件来源已变化，需要重新解析并核对。", retention_expired: "定制内容已达到保存期限，不再提供文件访问。" };
const marketplaceNames: Record<string, string> = { ATVPDKIKX0DER: "美国", A2EUQ1WTGCTBG2: "加拿大", A1AM78C64UM0Y8: "墨西哥", A1F83G8C2ARO7P: "英国", A1PA6795UKMFR9: "德国", A13V1IB3VIYZZH: "法国", APJ6JRA9NG5V4: "意大利", A1RKKUPIHCS9HS: "西班牙", A1VC38T7YXB528: "日本", A39IBJ37TRP1C6: "澳大利亚" };
type Encoding = "utf-8" | "gb18030";

export function AmazonReportWorkspace({ accounts, initialWorkspace, initialError }: { accounts: MarketplaceAccountView[]; initialWorkspace: AmazonReportWorkspaceView; initialError?: string }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [marketplaceId, setMarketplaceId] = useState(accounts[0]?.marketplaceIds[0] ?? "");
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [batchId, setBatchId] = useState("");
  const [report, setReport] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<Encoding>("utf-8");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [queueActive, setQueueActive] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<AmazonReportDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [lineBusy, setLineBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const context = useRef(0);
  const selection = useRef(0);
  const selectedRef = useRef("");
  const reportInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const account = accounts.find((item) => item.id === accountId);
  const batch = workspace.batches.find((item) => item.id === batchId);
  const filtered = useMemo(() => workspace.lines.filter((line) => {
    const matches = `${line.externalOrderId} ${line.skuCode ?? ""} ${line.title}`.toLowerCase().includes(search.toLowerCase().trim());
    return matches && (filter === "all" || (filter === "attention" ? ["failed", "partial", "expired"].includes(line.state) : filter === "unreviewed" ? !line.reviewed && line.state !== "none" : line.state === "none"));
  }), [workspace.lines, search, filter]);
  const visibleLines = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const pending = workspace.lines.filter((line) => line.state === "pending" || line.state === "processing");

  useEffect(() => () => { context.current += 1; selection.current += 1; }, []);

  function clearDetail() { selection.current += 1; selectedRef.current = ""; setSelectedId(""); setDetail(null); setDetailError(""); setDetailLoading(false); setLineBusy(false); }
  function updateLine(value: AmazonReportDetailView) {
    setWorkspace((current) => ({ ...current, lines: current.lines.map((line) => line.id === value.line.id ? value.line : line) }));
    if (selectedRef.current === value.line.id) setDetail(value);
  }
  async function refreshWorkspace(nextAccount = accountId, nextBatch = batchId, token = context.current) {
    const query = new URLSearchParams({ accountId: nextAccount });
    if (nextBatch) query.set("batchId", nextBatch);
    const result = AmazonReportWorkspaceViewSchema.parse(await reportRequest(`workspace?${query}`));
    if (token === context.current) setWorkspace(result);
    return result;
  }
  async function changeContext(nextAccount: string, nextBatch: string) {
    const token = ++context.current;
    clearDetail(); setWorkspace({ batches: nextAccount === accountId ? workspace.batches : [], lines: [] }); setPage(0); setError(""); setNotice(""); setLoading(true); setQueueActive(false);
    setAccountId(nextAccount); setBatchId(nextBatch);
    if (nextAccount !== accountId) { setMarketplaceId(accounts.find((item) => item.id === nextAccount)?.marketplaceIds[0] ?? ""); setReport(null); if (reportInput.current) reportInput.current.value = ""; }
    try { await refreshWorkspace(nextAccount, nextBatch, token); } catch (cause) { if (token === context.current) setError(userError(cause)); }
    finally { if (token === context.current) setLoading(false); }
  }
  function chooseReport(file: File | undefined) {
    setError(""); setNotice("");
    if (!file) return;
    if (!/\.(txt|tsv)$/i.test(file.name) || file.size > reportLimit || file.size === 0) { setReport(null); setError("请选择不超过 5 MB 的原始 TXT 或 TSV 订单报告。"); return; }
    setReport(file);
  }
  async function importReport() {
    if (!report || !accountId || !marketplaceId || busy) return;
    const token = context.current;
    setBusy(true); setError(""); setNotice(""); clearDetail();
    try {
      const content = decodeAmazonReport(await report.arrayBuffer(), encoding);
      const imported = AmazonReportBatchViewSchema.parse(await reportRequest("import", { accountId, marketplaceId, fileName: report.name, content }));
      if (token !== context.current) return;
      setNotice(batchSummary(imported)); setBatchId(imported.id); setPage(0);
      const result = await refreshWorkspace(accountId, imported.id, token);
      if (token === context.current) await processQueue(result.lines.filter((line) => line.state === "pending"), token);
    } catch (cause) { if (token === context.current) setError(userError(cause)); }
    finally { if (token === context.current) setBusy(false); }
  }
  async function processQueue(lines: AmazonReportLineView[], token = context.current) {
    if (lines.length === 0) return;
    setQueueActive(true);
    await runReportQueue(lines, async (line) => {
      if (token !== context.current) return;
      setWorkspace((current) => ({ ...current, lines: current.lines.map((item) => item.id === line.id ? { ...item, state: "processing" } : item) }));
      try {
        const before = AmazonReportDetailViewSchema.parse(await reportRequest(`lines/${line.id}`));
        if (token !== context.current) return;
        const result = AmazonReportDetailViewSchema.parse(await reportRequest(`lines/${line.id}/process`, { expectedVersionId: before.versionId }));
        if (token === context.current) updateLine(result);
      } catch {
        if (token !== context.current) return;
        try { const current = AmazonReportDetailViewSchema.parse(await reportRequest(`lines/${line.id}`)); if (token === context.current) updateLine(current); }
        catch { if (token === context.current) setWorkspace((current) => ({ ...current, lines: current.lines.map((item) => item.id === line.id ? { ...item, state: "failed", lastErrorCode: "REQUEST_FAILED" } : item) })); }
      }
    }, () => token === context.current);
    if (token === context.current) setQueueActive(false);
  }
  async function openLine(line: AmazonReportLineView) {
    const token = ++selection.current;
    selectedRef.current = line.id; setSelectedId(line.id); setDetail(null); setDetailError(""); setDetailLoading(true); setLineBusy(false);
    try {
      const result = AmazonReportDetailViewSchema.parse(await reportRequest(`lines/${line.id}`));
      if (token === selection.current) setDetail(result);
    } catch (cause) { if (token === selection.current) setDetailError(userError(cause)); }
    finally { if (token === selection.current) setDetailLoading(false); }
  }
  async function lineAction(action: "process" | "review" | "upload", file?: File) {
    if (!detail || lineBusy) return;
    const token = selection.current;
    const lineId = detail.line.id;
    setLineBusy(true); setDetailError("");
    try {
      if (file && (!/\.zip$/i.test(file.name) || file.size === 0 || file.size > zipLimit)) throw new Error("请选择不超过 20 MB 的定制 ZIP 文件。");
      const body = file ? { expectedVersionId: detail.versionId, fileName: file.name, contentBase64: await fileBase64(file) } : { expectedVersionId: detail.versionId };
      const result = AmazonReportDetailViewSchema.parse(await reportRequest(`lines/${lineId}/${action}`, body));
      if (token === selection.current) updateLine(result);
    } catch (cause) { if (token === selection.current) setDetailError(userError(cause)); }
    finally { if (token === selection.current) setLineBusy(false); if (zipInput.current) zipInput.current.value = ""; }
  }

  if (editing && detail) return <ProductionEditorSession title={`订单 ${detail.line.externalOrderId} · 生产作图`}
    subtitle={`${detail.line.title} · SKU ${detail.line.skuCode ?? "未提供"} · 数量 ${detail.line.quantity} · 定制版本 V${detail.line.versionNumber}`}
    returnLabel="返回当前订单" reportLineId={detail.line.id} context={<AmazonReportDetail detail={detail} />}
    onClose={() => { setEditing(false); requestAnimationFrame(() => editButton.current?.focus()); }} />;

  return <div className="ar-workspace">
    {error && <p className="ar-alert" role="alert">{error}</p>}
    {accounts.length === 0 ? error ? <section className="ar-empty"><RefreshCw size={28} /><h2>暂时无法读取店铺</h2><p>店铺数据尚未加载，请刷新页面重试。</p><a className="ar-button" href="/orders?view=reports">刷新页面</a></section> : <section className="ar-empty"><FileUp size={28} /><h2>先建立店铺档案</h2><p>导入的订单需要归属到具体店铺。创建 Amazon 店铺连接后即可回来导入，手动导入无需平台授权。</p><Link className="ar-button primary" href="/stores">前往店铺管理</Link></section> : <>
      <section className="ar-import" aria-label="导入订单报告">
        <div className="ar-import-controls">
          <label>订单所属店铺<select value={accountId} disabled={busy} onChange={(event) => void changeContext(event.target.value, "")}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <label>报告站点<select value={marketplaceId} disabled={busy} onChange={(event) => setMarketplaceId(event.target.value)}>{account?.marketplaceIds.map((id) => <option key={id} value={id}>{marketplaceNames[id] ?? id}</option>)}</select></label>
          <label>文件编码<select value={encoding} disabled={busy} onChange={(event) => setEncoding(event.target.value as Encoding)}><option value="utf-8">UTF-8（默认）</option><option value="gb18030">GB18030 / 中文 Windows</option></select></label>
        </div>
        <div className="ar-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) chooseReport(event.dataTransfer.files[0]); }}>
          <FileUp size={23} aria-hidden="true" /><div><strong>{report?.name ?? "拖入亚马逊后台下载的订单报告"}</strong><span>{report ? `${formatBytes(report.size)} · 已选择，可开始导入` : "原始 TXT / TSV · 最大 5 MB · 重复订单自动识别"}</span></div>
          <input ref={reportInput} className="ar-file-input" id="ar-report-file" type="file" accept=".txt,.tsv,text/plain,text/tab-separated-values" disabled={busy} onChange={(event) => chooseReport(event.target.files?.[0])} />
          <label className="ar-button" htmlFor="ar-report-file"><Upload size={15} />选择报告</label>
          <button className="ar-button primary" disabled={!report || !marketplaceId || busy || loading || queueActive} onClick={() => void importReport()}>{busy ? <LoaderCircle size={15} className="ar-spin" /> : <FileUp size={15} />}{busy ? "正在导入并解析" : "导入报告"}</button>
        </div>
        <p className="ar-footnote">上传后自动获取定制附件。下载失败的订单可以单独重试，或补传从亚马逊下载的 ZIP。</p>
      </section>
      {notice && <p className="ar-notice" role="status"><Check size={16} />{notice}</p>}
      <section className="ar-ledger" aria-label="订单报告列表">
        <div className="ar-toolbar">
          <label className="ar-batch-filter">导入批次<select value={batchId} disabled={busy || loading} onChange={(event) => void changeContext(accountId, event.target.value)}><option value="">全部近期订单</option>{workspace.batches.map((item) => <option key={item.id} value={item.id}>{formatDate(item.createdAt)} · {item.fileName}</option>)}</select></label>
          <label className="ar-search"><Search size={15} /><input aria-label="搜索订单、SKU 或商品" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="订单号、SKU、商品" /></label>
          <label className="ar-state-filter">显示<select value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }}><option value="all">全部订单行</option><option value="unreviewed">待核对</option><option value="attention">需要处理</option><option value="none">无定制附件</option></select></label>
          <button className="ar-button" disabled={busy || loading || queueActive} onClick={() => void changeContext(accountId, batchId)} aria-label="刷新订单列表"><RefreshCw size={15} /></button>
        </div>
        {batch && <div className="ar-batch-summary"><span>{batchSummary(batch)}</span><time>{formatDate(batch.createdAt)}</time></div>}
        {(queueActive || pending.length > 0) && <div className="ar-queue-status" role="status"><span>{queueActive ? <LoaderCircle size={15} className="ar-spin" /> : <FileArchive size={15} />}{queueActive ? "正在逐行下载并解析，已完成的订单可立即查看。" : `有 ${pending.length} 条订单行等待完成解析。`}</span><button className="ar-button" disabled={queueActive || busy || loading} onClick={() => void processQueue(pending)}>{queueActive ? "处理中" : "继续解析"}</button></div>}
        <div className={`ar-body ${selectedId ? "has-detail" : ""}`}>
          <div className="ar-list">
            {loading ? <div className="ar-empty" role="status"><LoaderCircle className="ar-spin" size={24} /><p>正在读取订单…</p></div> : visibleLines.length === 0 ? <div className="ar-empty"><FileArchive size={26} /><h2>{error ? "订单数据尚未读取" : workspace.lines.length ? "没有匹配的订单" : "暂无导入订单"}</h2><p>{error ? "请根据页面提示重试。" : workspace.lines.length ? "调整搜索内容或筛选条件。" : "选择店铺并上传报告，订单和定制内容会显示在这里。"}</p></div> : <>
              <div className="ar-list-label"><span>商品 / 订单</span><span>数量 · 定制状态</span></div>
              <ul className="ar-lines">{visibleLines.map((line) => <li key={line.id}><button className={`ar-line ${selectedId === line.id ? "selected" : ""}`} onClick={() => void openLine(line)} aria-pressed={selectedId === line.id}>
                <ReportThumbnail line={line} />
                <span className="ar-line-copy"><strong>{line.title || "报告未提供商品名称"}</strong><span>{line.externalOrderId}</span><small>SKU：{line.skuCode ?? "未提供"}</small></span>
                <span className="ar-line-state"><b>× {line.quantity}</b><span className={`ar-state ${line.state}`} title={line.lastErrorCode ? reportErrorDescription(line.lastErrorCode) : undefined}>{stateLabels[line.state]}</span><small>{line.reviewed ? "已核对" : line.state === "none" ? "无需附件解析" : "待核对"}</small></span>
              </button></li>)}</ul>
              <div className="ar-pagination"><span>共 {filtered.length} 条订单行 · 第 {page + 1} / {Math.max(1, Math.ceil(filtered.length / pageSize))} 页</span><button className="ar-button" aria-label="上一页" disabled={page === 0} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={16} /></button><button className="ar-button" aria-label="下一页" disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage((current) => current + 1)}><ChevronRight size={16} /></button></div>
            </>}
          </div>
          {selectedId && <section className="ar-detail" aria-label="定制订单详情"><header className="ar-detail-header"><h2>定制内容与核对</h2><button className="ar-button" aria-label="关闭订单详情" onClick={clearDetail}><X size={17} /></button></header>
            {detailLoading && <div className="ar-empty" role="status"><LoaderCircle className="ar-spin" size={24} /><p>正在读取定制内容…</p></div>}
            {detailError && <p className="ar-alert" role="alert">{detailError}</p>}
            {detail && <><AmazonReportDetail detail={detail} />
              <div className="ar-detail-actions">
                {detail.line.reviewed && detail.versionId && <button ref={editButton} className="ar-button" disabled={lineBusy || queueActive} onClick={() => setEditing(true)}>制作生产图</button>}
                <button className="ar-button primary" disabled={lineBusy || detail.line.reviewed || !detail.versionId || !["ready", "partial"].includes(detail.line.state)} onClick={() => void lineAction("review")}><Check size={15} />{detail.line.reviewed ? "当前版本已核对" : "标记已核对"}</button>
                <button className="ar-button" disabled={lineBusy || queueActive || detail.line.state === "none"} onClick={() => void lineAction("process")}><RefreshCw size={15} />重新获取附件</button>
                <button className="ar-button" disabled={lineBusy || queueActive} onClick={() => zipInput.current?.click()}><Upload size={15} />补传 ZIP</button>
                <input ref={zipInput} className="ar-file-input" aria-label="补传定制 ZIP" type="file" accept=".zip,application/zip" disabled={lineBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void lineAction("upload", file); }} />
                {lineBusy && <span role="status"><LoaderCircle className="ar-spin" size={15} />正在处理此订单…</span>}
              </div>
            </>}
          </section>}
        </div>
      </section>
      <p className="ar-footnote">报告未提供的平台状态与发货期限不会推测补齐。“已核对”仅表示内部核对，不代表已生产或已发货。</p>
    </>}
  </div>;
}

export function AmazonReportDetail({ detail }: { detail: AmazonReportDetailView }) {
  const [surfaceKey, setSurfaceKey] = useState("");
  const [enlarged, setEnlarged] = useState(false);
  const previewButton = useRef<HTMLButtonElement>(null);
  function closePreview() { setEnlarged(false); previewButton.current?.focus(); }
  const surface = detail.surfaces.find((item) => item.key === surfaceKey) ?? detail.surfaces[0];
  const preview = detail.files.find((file) => file.key === surface?.previewFileKey && file.role === "preview");
  const buyerFiles = detail.files.filter((file) => file.role === "buyer_image" && (!surface || surface.buyerFileKeys.includes(file.key)));
  useEffect(() => { setSurfaceKey(""); setEnlarged(false); }, [detail.line.id, detail.versionId]);
  return <div className="ar-detail-content">
    <div className="ar-order-meta"><strong>{detail.line.title}</strong><span>{detail.line.externalOrderId} · 数量 {detail.line.quantity}</span><small>SKU：{detail.line.skuCode ?? "未提供"} · 定制版本 {detail.line.versionNumber || "未生成"}</small></div>
    {detail.line.lastErrorCode && <p className="ar-alert">{reportErrorDescription(detail.line.lastErrorCode)}</p>}
    {!["ready", "partial", "none"].includes(detail.line.state) && <p className="ar-alert">{detail.line.state === "failed" ? "最新附件未能完成解析，请重试或补传 ZIP 后再核对。" : detail.line.state === "expired" ? "定制文件已到期，不再提供预览。" : "定制附件尚未完成解析，请等待或点击继续解析。"}</p>}
    {detail.warnings.length > 0 && <div className="ar-warnings"><strong>需要留意</strong><ul>{detail.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    {detail.line.state === "none" && <p className="ar-footnote">报告未提供定制附件链接。若该商品应有定制信息，请补传对应订单行的 ZIP。</p>}
    {detail.surfaces.length > 1 && <label className="ar-surface-select">定制面<select value={surface?.key ?? ""} onChange={(event) => { setSurfaceKey(event.target.value); setEnlarged(false); }}>{detail.surfaces.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>}
    <div className="ar-customization">
      <section className="ar-preview-area"><h3>亚马逊定制预览{surface && <small>{surface.label}</small>}</h3>{preview ? <>
        <button ref={previewButton} className="ar-preview-button" onClick={() => setEnlarged(true)} aria-label="放大亚马逊定制预览"><ProtectedImage src={fileUrl(detail.line.id, preview.key, detail.versionId)} alt={`${surface?.label ?? "商品"}的亚马逊定制预览`} /><span><Maximize2 size={14} />放大查看</span></button>
        {enlarged && <div className="ar-image-dialog" role="dialog" aria-modal="true" aria-label="放大的定制预览" onKeyDown={(event) => { if (event.key === "Escape") closePreview(); if (event.key === "Tab") event.preventDefault(); }}><button className="ar-button" autoFocus onClick={closePreview}><X size={18} />关闭预览</button><ProtectedImage src={fileUrl(detail.line.id, preview.key, detail.versionId)} alt="放大的亚马逊定制预览" /></div>}
      </> : <div className="ar-no-preview"><ImageOff size={28} /><span>暂无可用的亚马逊预览</span><small>买家原图在下方单独展示</small></div>}
        <p className="ar-footnote">此图来自亚马逊附件，可能包含选项示意。请结合买家原图与文字核对，不能直接作为生产稿。</p>
      </section>
      <section className="ar-fields"><h3>买家定制要求</h3>{surface?.fields.length ? <dl>{surface.fields.map((field) => <div key={field.key}><dt>{field.label || "未命名项目"}{field.kind === "unknown" && <small>未识别类型</small>}</dt><dd>{field.value || "（空）"}{(field.font || field.color) && <small>{field.font ? `字体：${field.font}` : ""}{field.font && field.color ? " · " : ""}{field.color ? `颜色：${field.color}` : ""}</small>}</dd></div>)}</dl> : <p className="ar-footnote">暂无可展示的文字或选项。</p>}</section>
    </div>
    <section className="ar-buyers"><h3>买家上传原图 <small>{buyerFiles.length} 个文件</small></h3>{buyerFiles.length ? <div className="ar-buyer-grid">{buyerFiles.map((file) => <BuyerOriginal key={`${detail.line.id}-${detail.versionId}-${file.key}`} lineId={detail.line.id} versionId={detail.versionId} file={file} downloadName={detail.files.find((source) => source.key === file.originalFileKey)?.name ?? file.name} />)}</div> : <p className="ar-footnote">此定制面没有可用的买家原图。</p>}</section>
    <details className="ar-files"><summary>查看附件文件清单（{detail.files.length}）</summary><ul>{detail.files.map((file) => <li key={file.key}><span><strong>{file.name}</strong><small>{({ preview: "亚马逊预览", buyer_image: "买家原图", source: "来源附件" })[file.role]} · {formatBytes(file.byteSize)}</small></span><DownloadFile href={fileUrl(detail.line.id, file.key, detail.versionId)} fileName={file.name} ariaLabel={`下载 ${file.name}`} /></li>)}</ul></details>
  </div>;
}

function ReportThumbnail({ line }: { line: AmazonReportLineView }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    setSource(null);
    if (!line.hasPreview) return;
    const controller = new AbortController();
    void reportRequest(`lines/${line.id}`, undefined, controller.signal).then((value) => {
      const detail = AmazonReportDetailViewSchema.parse(value);
      const key = detail.surfaces.find((item) => item.previewFileKey)?.previewFileKey;
      if (!controller.signal.aborted && key) setSource(fileUrl(line.id, key, detail.versionId));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [line.id, line.hasPreview, line.versionNumber, line.updatedAt]);
  return <span className="ar-thumbnail">{source ? <ProtectedImage src={source} alt="定制预览缩略图" /> : <ImageOff size={20} aria-label={line.hasPreview ? "预览加载中" : "无预览"} />}</span>;
}

function BuyerOriginal({ lineId, versionId, file, downloadName }: { lineId: string; versionId: string | null; file: AmazonReportDetailView["files"][number]; downloadName: string }) {
  const [dimensions, setDimensions] = useState("");
  const originalDimensions = file.width && file.height ? `${file.width} × ${file.height} px（原图）` : dimensions ? `${dimensions}（预览）` : "";
  return <figure><ProtectedImage src={fileUrl(lineId, file.key, versionId)} alt={`买家图片预览：${file.name}`} onDimensions={setDimensions} /><figcaption><strong>{file.name}</strong><span>{formatBytes(file.byteSize)}（预览）{originalDimensions && ` · ${originalDimensions}`}</span><DownloadFile href={fileUrl(lineId, file.originalFileKey ?? file.key, versionId)} fileName={downloadName}>{file.originalFileKey ? "下载原图" : "下载图片预览"}</DownloadFile></figcaption></figure>;
}

function DownloadFile({ href, fileName, ariaLabel, children }: { href: string; fileName: string; ariaLabel?: string; children?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(href, { cache: "no-store", signal: AbortSignal.timeout(115_000) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "当前账号没有下载此文件的权限，请重新登录或联系管理员。" : response.status === 409 ? "内容已更新，请重新打开订单后再下载。" : "文件下载未完成，请刷新后重试。");
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = [...fileName].map((character) => character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? "_" : character).join("") || "attachment";
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    } catch (cause) { setError(userError(cause)); }
    finally { setBusy(false); }
  }
  return <span className="ar-download"><a className="ar-button" href={href} download={fileName} aria-label={ariaLabel} aria-disabled={busy} onClick={(event) => { event.preventDefault(); void download(); }}>{busy ? <LoaderCircle className="ar-spin" size={14} /> : <Download size={14} />}{children}</a>{error && <span role="alert">{error}</span>}</span>;
}

function ProtectedImage({ src, alt, onDimensions }: { src: string; alt: string; onDimensions?: (dimensions: string) => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <span className="ar-image-failed"><ImageOff size={20} />图片暂不可用</span>;
  // Authenticated same-origin media must stay uncached; the Next image optimizer must not fetch it.
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} onLoad={(event) => { const image = event.currentTarget; if (onDimensions && image.naturalWidth && image.naturalHeight) onDimensions(`${image.naturalWidth} × ${image.naturalHeight} px`); }} />;
}

export async function runReportQueue<T>(items: T[], process: (item: T) => Promise<void>, shouldContinue: () => boolean = () => true): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (shouldContinue()) {
      const item = items[cursor++];
      if (item === undefined) return;
      try { await process(item); } catch { /* One failed attachment must not block the remaining orders. */ }
    }
  }
  await Promise.all([worker(), worker()]);
}

export function decodeAmazonReport(bytes: ArrayBuffer, encoding: Encoding): string {
  if (!bytes.byteLength || bytes.byteLength > reportLimit) throw new Error("请选择不超过 5 MB 的订单报告。");
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { throw new Error(encoding === "utf-8" ? "文件不是有效的 UTF-8。请选择 GB18030 / 中文 Windows 编码后重试，或重新下载原始报告。" : "无法按所选编码读取文件，请重新下载原始 TXT 报告。"); }
}

export function batchSummary(batch: AmazonReportBatchView): string { return `${batch.orderCount} 个订单 / ${batch.rowCount} 条商品 · 新增 ${batch.newOrderCount} · 重复 ${batch.duplicateOrderCount} · 异常 ${batch.failedOrderCount}`; }
function fileUrl(lineId: string, key: string, versionId: string | null): string { return `/api/orders/reports/lines/${encodeURIComponent(lineId)}/files/${encodeURIComponent(key)}?versionId=${encodeURIComponent(versionId ?? "")}`; }
export function reportErrorDescription(code: string): string { return errorLabels[code.toLowerCase()] ?? "此订单需要检查，请重新获取附件或补传 ZIP。"; }
function formatDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
function formatBytes(value: number): string { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`; }
function userError(cause: unknown): string { return cause instanceof Error && /^(登录|当前账号|内容已更新|文件|请选择|无法按|操作未完成)/.test(cause.message) ? cause.message : "操作未完成，请刷新后重试。"; }
async function reportRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/orders/reports/${path}`, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }), cache: "no-store", signal: signal ?? AbortSignal.timeout(115_000) });
  if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录。" : response.status === 403 ? "当前账号没有执行此操作的权限。" : response.status === 409 ? "内容已更新，请重新打开订单后再操作。" : response.status === 413 ? "文件超过允许的大小。" : "操作未完成，请检查文件或稍后重试。");
  return response.json();
}
async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const value = reader.result; if (typeof value !== "string") reject(new Error("无法读取文件")); else resolve(value.slice(value.indexOf(",") + 1)); }; reader.onerror = () => reject(new Error("无法读取文件")); reader.readAsDataURL(file); });
}
