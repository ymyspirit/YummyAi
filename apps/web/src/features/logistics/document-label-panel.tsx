"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Upload, FolderDown } from "lucide-react";
import type { DocumentExportView, DocumentLabelView, OrderDocumentsPreview } from "@yummyai/contracts/logistics/documents";
import { ProductionDeliveryWorkspaceSchema, type ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { centerRead } from "../order-centers/order-center-model";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { documentRequest, DocumentRequestError } from "./document-client";
import { logisticsError } from "./logistics-client";

export function DocumentLabelPanel({ orderId, refreshToken, canWrite, canReadProduction, onStateChange }: { orderId: string; refreshToken: string; canWrite: boolean; canReadProduction: boolean; onStateChange?(state: { dirty: boolean; busy: boolean }): void }) {
  const [exports, setExports] = useState<DocumentExportView[]>([]), [labels, setLabels] = useState<DocumentLabelView[]>([]);
  const [exportId, setExportId] = useState(""), [basis, setBasis] = useState<OrderDocumentsPreview | null>(null), [file, setFile] = useState<File | null>(null), [tracking, setTracking] = useState(""), [verified, setVerified] = useState(false);
  const [packages, setPackages] = useState<ProductionDeliveryPackageView[]>([]), [packageIds, setPackageIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const alive = useRef(true), request = useRef(0), key = useRef(crypto.randomUUID()), fileInput = useRef<HTMLInputElement>(null);
  const ctl = useRef<AbortController | null>(null);
  useLeaveGuard(Boolean(file || tracking), busy);
  useEffect(() => { onStateChange?.({ dirty: Boolean(file || tracking), busy }); return () => onStateChange?.({ dirty: false, busy: false }); }, [file, tracking, busy, onStateChange]);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const serial = ++request.current;
    const [records, files] = await Promise.all([documentRequest<{ exports: DocumentExportView[] }>(`exports?orderId=${orderId}`, undefined, signal), documentRequest<{ labels: DocumentLabelView[] }>(`labels?orderId=${orderId}`, undefined, signal)]);
    if (!alive.current || signal?.aborted || serial !== request.current) return;
    setExports(records.exports.filter(row => row.adapter === "yunexpress" && row.available)); setLabels(files.labels);
  }, [orderId]);
  const fail = useCallback((cause: unknown) => {
    if (cause && typeof cause === "object" && "status" in cause && [401, 403].includes(Number(cause.status))) { request.current++; setBasis(null); setLabels([]); setExports([]); setPackages([]); setFile(null); setTracking(""); }
    setError(logisticsError(cause));
  }, []);
  useEffect(() => { alive.current = true; const controller = new AbortController(); ctl.current = controller;
    void reload(controller.signal).catch(cause => { if (!controller.signal.aborted) fail(cause); });
    return () => { alive.current = false; request.current++; controller.abort(); ctl.current?.abort(); };
  }, [reload, refreshToken, fail]);
  async function run(work: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); try { await work(); } catch (cause) { if (alive.current) fail(cause); } finally { if (alive.current) setBusy(false); } }
  function changed() { key.current = crypto.randomUUID(); setNotice(""); }
  async function inspect() {
    const serial = ++request.current;
    const result = await documentRequest<OrderDocumentsPreview>(`exports/${exportId}/label-basis?orderId=${orderId}`, undefined, ctl.current?.signal);
    if (alive.current && serial === request.current) { setBasis(result); setVerified(false); }
  }
  async function register() {
    if (!file || !basis?.ready || !verified) return;
    if (file.size > 5 * 1024 * 1024 || !/\.pdf$/i.test(file.name)) throw new Error("请选择不超过 5 MiB 的云途 PDF 面单");
    const serial = ++request.current, base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("面单文件读取失败")); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.readAsDataURL(file); });
    if (!alive.current || serial !== request.current) return;
    await documentRequest("labels", { exportId, orderId, expectedFingerprint: basis.fingerprint, trackingNumber: tracking.trim(), fileName: file.name, base64, verifiedByOperator: true, idempotencyKey: key.current }, ctl.current?.signal);
    if (!alive.current || serial !== request.current) return;
    setFile(null); setTracking(""); setVerified(false); if (fileInput.current) fileInput.current.value = "";
    setNotice("已登记云途单号和面单 可关联正式生产交付包"); await reload();
  }
  async function loadPackages() {
    const serial = ++request.current, value = await centerRead(`deliveries?order=${orderId}`, ctl.current?.signal ?? new AbortController().signal);
    if (alive.current && serial === request.current) { setPackages(ProductionDeliveryWorkspaceSchema.parse(value).packages); setPackageIds([]); }
  }
  async function handoff(id: string) {
    const serial = ++request.current;
    const response = await fetch(`/api/logistics/documents/labels/${id}/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deliveryPackageIds: packageIds }), cache: "no-store", signal: ctl.current?.signal });
    if (!response.ok) { const value = await response.json().catch(() => null); throw new DocumentRequestError(response.status, value?.message ?? "义彩交付包生成失败"); }
    const blob = await response.blob();
    if (!alive.current || serial !== request.current) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `yicai-${id}.zip`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("义彩交付包已下载 请核对 JPG、尺寸清单与云途 PDF 后交给工厂");
  }
  const current = labels.find(row => row.available);
  return <details className="document-config"><summary>云途单号、面单与义彩交付</summary>
    <p className="oc-muted">在云途官网创建面单后 登记官方单号和 PDF 再与已审核生产文件组成订单文件夹</p>
    {canWrite && <form className="logistics-form" onSubmit={event => { event.preventDefault(); void run(register); }}>
      <fieldset className="logistics-fields" disabled={busy}>
        <label className="logistics-wide">对应的云途导出<select aria-label="对应的云途导出" value={exportId} onChange={event => { setExportId(event.target.value); setBasis(null); setVerified(false); changed(); }}><option value="">请选择本订单的有效导出记录</option>{exports.map(row => <option key={row.id} value={row.id}>{new Date(row.createdAt).toLocaleString()} · {row.rowCount} 行</option>)}</select></label>
        <button className="oc-button" type="button" disabled={!exportId} onClick={() => void run(inspect)}>核对当前收件资料</button>
        {basis && <><p className="logistics-wide">{Object.entries(basis.orders[0]?.rows[0] ?? {}).filter(([name]) => ["客户订单号", "收件人姓名", "收件人地址", "收件人城市", "收件人省州", "邮编", "包裹总重量", "产品代码"].includes(name)).map(([name, value]) => `${name} ${value}`).join(" · ")}</p><label>云途跟踪号<input required maxLength={120} pattern="[A-Za-z0-9-]+" value={tracking} onChange={e => { setTracking(e.target.value); changed(); }}/></label><label>官方 PDF 面单<input ref={fileInput} type="file" accept="application/pdf,.pdf" required onChange={e => { setFile(e.target.files?.[0] ?? null); setVerified(false); changed(); }}/></label><label className="logistics-check logistics-wide"><input type="checkbox" required checked={verified} onChange={e => { setVerified(e.target.checked); changed(); }}/>已核对 PDF 的订单号、收件资料和跟踪号 与本单一致</label></>}
      </fieldset><button className="oc-button" disabled={busy || !basis?.ready || !verified || !file}><Upload size={16}/>保存单号与面单</button>
    </form>}
    {labels.map(row => <div className="document-history-row" key={row.id}><div><strong>{row.trackingNumber}</strong><p>{row.fileName}</p>{row.reason && <p>{row.reason}</p>}</div>{row.available && <a download className="oc-button" href={`/api/logistics/documents/labels/${row.id}/file`}><Download size={16}/>下载面单</a>}</div>)}
    {current && canReadProduction && <div className="logistics-form"><button className="oc-button" disabled={busy} onClick={() => void run(loadPackages)}>读取本单正式生产交付包</button>{packages.map(packet => <label className="logistics-check" key={packet.id}><input type="checkbox" disabled={busy || !packet.canDownload} checked={packageIds.includes(packet.id)} onChange={e => setPackageIds(ids => e.target.checked ? [...ids, packet.id] : ids.filter(id => id !== packet.id))}/>{new Date(packet.createdAt).toLocaleString()} · {packet.items.length} 商品 · {packet.canDownload ? "可交付" : "生产校验待处理"}</label>)}<button className="oc-button" disabled={busy || !packageIds.length} onClick={() => void run(() => handoff(current.id))}><FolderDown size={16}/>下载义彩订单文件夹</button></div>}
    {!labels.length && <p className="oc-muted">尚未登记本单云途面单</p>}{error && <p role="alert" className="logistics-error">{error}</p>}{notice && <p role="status">{notice}</p>}
  </details>;
}
