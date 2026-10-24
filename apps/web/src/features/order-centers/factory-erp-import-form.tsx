"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Check, Search, Upload, X } from "lucide-react";
import {
  FACTORY_ERP_HEADERS, FACTORY_ERP_MAX_BYTES, UploadFactoryErpImportSchema,
  type UploadFactoryErpImport, type FactoryErpImportView, type FactoryErpCandidatePage,
  type FactoryErpItemSelection, type FactoryErpDiagnostic, type ApplyFactoryErpImport, type FactoryErpSourceLifecycle,
} from "@yummyai/contracts/order/factory-erp-import";
import { FactoryErpAssociationPinSchema, type FactoryErpAssociationPin } from "@yummyai/contracts/order/factory-erp-binding";

type PreviewRow = FactoryErpImportView["rows"][number];
type Candidate = FactoryErpCandidatePage["items"][number];
export type FactoryErpRowChoice = {
  row: PreviewRow; items: FactoryErpItemSelection[]; quantity: number | null; fromExisting: boolean; association: FactoryErpAssociationPin;
};
export const factoryErpStatusLabel = (status: string) => status === "已审核" ? "已排产" :
  status === "已出库" ? "工厂已发货" : status === "已作废" ? "原表作废 不自动取消" : "未知状态 不可应用";
export const factoryErpKnownStatus = (status: string) => ["已审核", "已出库", "已作废"].includes(status);
export function FactoryErpDiagnostics({ diagnostics }: { diagnostics: FactoryErpDiagnostic[] }) {
  const [page, setPage] = useState(0), maximum = Math.max(0, Math.ceil(diagnostics.length / 25) - 1), current = Math.min(page, maximum);
  if (!diagnostics.length) return <p className="fei-hint">本次解析未返回格式诊断 绑定与应用仍须逐组核对</p>;
  return <details className="fei-details"><summary>查看解析诊断 共 {diagnostics.length} 项</summary>
    <p>诊断当前显示 {current * 25 + 1}–{Math.min((current + 1) * 25, diagnostics.length)} 项</p>
    <div className="fei-actions"><button type="button" className="oc-button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页诊断</button>
      <button type="button" className="oc-button" disabled={current >= maximum} onClick={() => setPage(current + 1)}>下一页诊断</button></div>
    <ul>{diagnostics.slice(current * 25, (current + 1) * 25).map((item, index) => <li key={String(item.rowNumber) + ":" + item.code + ":" + index}>
      {item.rowNumber === null ? "原文件" : "原表第 " + item.rowNumber + " 行"} · <code>{item.code}</code>
    </li>)}</ul>
  </details>;
}
export function FactoryErpRawRow({ row, headers = FACTORY_ERP_HEADERS }: { row: PreviewRow; headers?: readonly string[] }) {
  return <details className="fei-details"><summary>读取第 {row.rowNumber} 行全部 13 个原始列值</summary>
    <dl className="fei-raw">{headers.map((header, index) => <div key={header}>
      <dt>{header}</dt><dd>{row.rawCells[index] === "" ? <span className="fei-hint">原单元格为空</span> : row.rawCells[index]}</dd>
    </div>)}</dl>
  </details>;
}
export function FactoryErpImportSummary({ view }: { view: FactoryErpImportView }) {
  return <section aria-label="原工厂文件与覆盖范围" className="fei-summary">
    <h4>原工厂文件与覆盖范围</h4>
    <dl className="fei-pairs">
      <div><dt>原文件</dt><dd>{view.fileName} · {view.byteSize} 字节 · {view.format.toUpperCase()}</dd></div>
      <div><dt>工作表</dt><dd>{view.sheetName ?? "CSV 无工作表"}</dd></div>
      <div><dt>原文件行数</dt><dd>{view.rowCount} 行 · 当前显示 {view.rows.length ? view.offset + 1 : 0}–{view.offset + view.rows.length}</dd></div>
      <div><dt>固定模板</dt><dd><code>{view.templateVersion}</code></dd></div>
      <div><dt>导入 ID</dt><dd><code>{view.id}</code></dd></div>
      <div><dt>原字节 SHA-256</dt><dd><code>{view.fileChecksum}</code></dd></div>
      <div><dt>固定预览校验值</dt><dd><code>{view.previewChecksum}</code></dd></div>
      <div><dt>上传登记时间</dt><dd>{view.createdAt}</dd></div>
      <div><dt>原文件保留截止</dt><dd>{view.expiresAt}</dd></div>
    </dl>
    <p>仅当前页或未声明覆盖范围 不代表工厂全量订单 缺席记录不视为取消 删除或未排产</p>
    <p>原创建与更新时间没有时区 按原文显示 上传时间不冒充工厂实际操作时间</p>
    <p>固定 13 表头 {view.headers.join(" · ")}</p>
    <FactoryErpDiagnostics diagnostics={view.diagnostics} />
  </section>;
}
export function factoryErpLifecycleLabel(value: FactoryErpSourceLifecycle, expired = value.access === "expired") {
  if (value.purgeStatus === "purged") return "已清理 原 ID 校验值与审计仍保留";
  if (expired) return value.access === "retained" ? "已到期 原文已隐藏 清理状态待读取" : "已到期 原文已隐藏 清理待完成";
  return "仍在保留期";
}
export function FactoryErpLifecycleSummary({ value, expired = value.access === "expired" }: { value: FactoryErpSourceLifecycle; expired?: boolean }) {
  const stages = { not_due: "尚未到清理时间", pending: "等待清理", running: "正在清理", failed: "清理未完成 等待重试", purged: "永久删除完成" };
  return <section aria-label="工厂来源保留与清理凭据" className="fei-lifecycle">
    <h4>工厂来源保留与清理凭据</h4>
    <p className="fei-lifecycle-state" data-expired={expired} data-purged={value.purgeStatus === "purged"}>{factoryErpLifecycleLabel(value, expired)}</p>
    <dl className="fei-pairs">
      <div><dt>原导入 ID</dt><dd><code>{value.id}</code></dd></div>
      <div><dt>原工厂 ID</dt><dd><code>{value.factoryId}</code></dd></div>
      <div><dt>原字节 SHA-256</dt><dd><code>{value.fileChecksum}</code></dd></div>
      <div><dt>固定预览校验值</dt><dd><code>{value.previewChecksum}</code></dd></div>
      <div><dt>原字节数与模板</dt><dd>{value.byteSize} 字节 · <code>{value.templateVersion}</code></dd></div>
      <div><dt>上传登记时间</dt><dd>{value.createdAt}</dd></div>
      <div><dt>保留截止时间</dt><dd>{value.expiresAt}</dd></div>
      <div><dt>服务器核验时间</dt><dd>{value.checkedAt}</dd></div>
      <div><dt>私文清除完成时间</dt><dd>{value.privateRedactedAt ?? (expired ? "尚无完成凭据" : "仍在保留期")}</dd></div>
      <div><dt>实际对象清理状态</dt><dd>{expired && value.purgeStatus === "not_due" ? "尚无到期后的清理凭据 请重新读取" : stages[value.purgeStatus]}</dd></div>
      <div><dt>实际对象清理完成时间</dt><dd>{value.purgedAt ?? "尚无永久删除完成凭据"}</dd></div>
      <div><dt>已尝试清理次数</dt><dd>{value.attempts}</dd></div>
      {value.nextAttemptAt && <div><dt>下一次重试时间</dt><dd>{value.nextAttemptAt}</dd></div>}
      <div><dt>最近原应用 ID</dt><dd>{value.lastApplicationId ? <code>{value.lastApplicationId}</code> : "尚无已登记应用"}</dd></div>
    </dl>
    <p className="fei-hint">清理结论来自服务器实际凭据 截止时间或原文不可访问不代表原对象已永久删除 读取此处不会触发清理或应用状态</p>
    {expired && <p>原文件名 原始列值与外部编号已隐藏 原 ID 与校验值用于核对历史 已清理原文无法从此恢复</p>}
  </section>;
}
export function FactoryErpItemPins({ items }: { items: FactoryErpItemSelection[] }) {
  return <ol className="fei-pins">{items.map(item => <li key={item.deliveryItemId}>
    <dl className="fei-pairs">
      <div><dt>原交付项</dt><dd><code>{item.deliveryItemId}</code></dd></div>
      <div><dt>原生产单</dt><dd><code>{item.productionOrderId}</code></dd></div>
      <div><dt>固定生产版本</dt><dd><code>{item.productionVersionId}</code></dd></div>
      <div><dt>原文件校验值</dt><dd><code>{item.fileChecksum}</code></dd></div>
      <div><dt>原制造清单校验值</dt><dd><code>{item.manufacturingChecksum}</code></dd></div>
    </dl>
  </li>)}</ol>;
}
async function bytesBase64(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  return btoa(parts.join(""));
}
export async function factoryErpSha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
export function FactoryErpUploadForm({ factoryId, scope, reset, disabled, onPrepared, onDirty, onPreparing }: {
  factoryId: string; scope: string; reset: number; disabled: boolean;
  onPrepared(input: UploadFactoryErpImport): void; onDirty(dirty: boolean): void; onPreparing(preparing: boolean): void;
}) {
  const [file, setFile] = useState<File | null>(null), [preparing, setPreparing] = useState(false), [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null), generation = useRef(0), alive = useRef(true);
  const live = useRef({ scope, disabled }); live.current = { scope, disabled };
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useLayoutEffect(() => { generation.current++; setFile(null); setPreparing(false); setError(""); form.current?.reset(); }, [scope, reset]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || preparing || !file) return;
    const captured = scope, token = ++generation.current, data = new FormData(event.currentTarget);
    const valid = () => alive.current && generation.current === token && live.current.scope === captured && !live.current.disabled;
    setPreparing(true); onPreparing(true); setError("");
    try {
      if (file.size < 1 || file.size > FACTORY_ERP_MAX_BYTES || !/\.(xlsx|csv)$/i.test(file.name))
        throw new Error("请选择不超过 5 MiB 的原始 XLSX 或 CSV 文件");
      const bytes = new Uint8Array(await file.arrayBuffer()), checksumSha256 = await factoryErpSha256(bytes);
      const contentBase64 = await bytesBase64(bytes);
      if (!valid()) return;
      const isCsv = /\.csv$/i.test(file.name), sheetName = String(data.get("sheetName") ?? "").trim();
      const input = UploadFactoryErpImportSchema.safeParse({
        factoryId, fileName: file.name, contentBase64, checksumSha256, idempotencyKey: crypto.randomUUID(),
        options: isCsv ? { csvEncoding: data.get("csvEncoding"), delimiter: data.get("delimiter") } : sheetName ? { sheetName } : {},
      });
      if (!input.success) throw new Error("原文件名称 格式或解析选项无法核对 未截断提交");
      onPrepared(input.data);
    } catch (reason) { if (valid()) setError(reason instanceof Error ? reason.message : "原文件读取失败 请重新选择"); }
    finally {
      if (alive.current && generation.current === token && live.current.scope === captured) { setPreparing(false); onPreparing(false); }
    }
  }
  return <form ref={form} className="fei-form" aria-label="上传原工厂 Excel 或 CSV" onSubmit={event => void submit(event)}>
    <fieldset disabled={disabled || preparing}>
      <label className="fei-wide">工厂原始文件<input type="file" name="sourceFile" accept=".xlsx,.csv" required onChange={event => {
        generation.current++; const selected = event.target.files?.[0] ?? null; setFile(selected); setError(""); onDirty(selected !== null);
      }} /></label>
      {file && <p className="fei-hint fei-wide">已选原文件 {file.name} · {file.size} 字节</p>}
      <label>Excel 工作表（可留空）<input name="sheetName" maxLength={100} disabled={disabled || preparing || !!file && /\.csv$/i.test(file.name)} placeholder="指定原文件工作表 不改原表头" /></label>
      <label>CSV 编码<select name="csvEncoding" defaultValue="utf-8" disabled={disabled || preparing || !!file && /\.xlsx$/i.test(file.name)}><option value="utf-8">UTF-8</option><option value="gb18030">GB18030</option></select></label>
      <label>CSV 分隔符<select name="delimiter" defaultValue="," disabled={disabled || preparing || !!file && /\.xlsx$/i.test(file.name)}><option value=",">逗号</option><option value={"\t"}>制表符</option><option value=";">分号</option></select></label>
      <p className="fei-hint fei-wide">最大 5 MiB 原字节交服务器扫描与解析 不执行公式 宏或外部链接 上传和预览不会应用工厂状态</p>
      <button className="oc-button primary" type="submit" disabled={disabled || preparing || !file}><Upload size={14} aria-hidden="true" />{preparing ? "正在核对原文件字节" : "上传并预览原文件"}</button>
    </fieldset>{error && <p role="alert" className="oc-delivery-error">{error}</p>}
  </form>;
}

export function FactoryErpBindingForm({ scope, row, headers, disabled, loadCandidates, onSave, onCancel, onDenied }: {
  scope: string; row: PreviewRow; headers: readonly string[]; disabled: boolean;
  loadCandidates(query: { q: string; cursor?: string }, signal: AbortSignal): Promise<FactoryErpCandidatePage>;
  onSave(value: FactoryErpRowChoice): void; onCancel(): void; onDenied(error: unknown): void;
}) {
  const [query, setQuery] = useState(""), [trail, setTrail] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState<FactoryErpCandidatePage | null>(null), [selected, setSelected] = useState<Record<string, Candidate>>({});
  const [reading, setReading] = useState(false), [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false), generation = useRef(0), live = useRef(scope), alive = useRef(true);
  live.current = scope;
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (row.binding) return;
    const abort = new AbortController(), token = ++generation.current, captured = scope;
    const valid = () => alive.current && !abort.signal.aborted && live.current === captured && generation.current === token;
    setReading(true); setError(""); setPage(null);
    const cursor = trail.at(-1);
    void loadCandidates({ q: query, ...(cursor ? { cursor } : {}) }, abort.signal).then(value => {
      if (valid()) setPage(value);
    }).catch(reason => { if (valid()) { setError("候选读取未完成 请重新查询 原组选择仍保留"); onDenied(reason); } })
      .finally(() => { if (valid()) setReading(false); });
    return () => abort.abort();
  }, [scope, row.binding, query, trail, loadCandidates, onDenied]);
  const chosen = Object.values(selected), quantity = chosen.reduce((sum, item) => sum + item.quantity, 0);
  const association = row.association ? FactoryErpAssociationPinSchema.safeParse({ expectedActiveBindingId: row.association.activeBindingId,
    expectedRevision: row.association.revision, expectedReleaseId: row.association.releaseId, confirmed: true }) : null;
  const associationKnown = association?.success === true && association.data.expectedActiveBindingId === (row.binding?.id ?? null);
  const ready = associationKnown && confirmed && (row.binding !== null ? row.binding.items.length > 0 && row.binding.items.length <= 50 :
    chosen.length > 0 && chosen.length <= 50 && quantity === row.itemQuantity);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled || !ready || !association?.success) return;
    const items = row.binding?.items ?? chosen.map(({ deliveryItemId, productionOrderId, productionVersionId, fileChecksum, manufacturingChecksum }) =>
      ({ deliveryItemId, productionOrderId, productionVersionId, fileChecksum, manufacturingChecksum }));
    onSave({ row, items, quantity: row.binding ? null : quantity, fromExisting: row.binding !== null, association: association.data });
  }
  return <section className="fei-binding" aria-label={"核对原表整组 第 " + row.rowNumber + " 行"}>
    <h4>核对外部编号 {row.externalId} 的完整原生产组</h4>
    <p>原表第 {row.rowNumber} 行 · 原商品种类 {row.itemKinds} · 原商品总数 {row.itemQuantity} · {factoryErpStatusLabel(row.rawStatus)}</p>
    <p>一行按工厂任务或订单头级绑定 不按商品种类猜拆成 SKU 或逐件发货数量</p>
    {associationKnown && row.association ? <div className="fei-association"><p>本次核对关联修订 {row.association.revision} · {row.association.activeBindingId ? "明确复用当前活动组" : row.association.revision > 0 ? "原组已解除 重新绑定需要明确确认" : "尚无原绑定"}</p>
      {row.association.activeBindingId && <p>当前绑定 ID <code>{row.association.activeBindingId}</code></p>}
      {row.association.releaseId && <p>最近解除凭据 <code>{row.association.releaseId}</code></p>}</div> :
      <p role="alert" className="oc-delivery-error">当前关联修订依据缺失或不一致 请重新读取原表 不猜测初始修订或解除凭据</p>}
    <FactoryErpRawRow row={row} headers={headers} />
    {row.binding ? <><p>原编号已有固定绑定 仅可明确复用下列完整集合 不自动改为当前最新版本</p>
      <FactoryErpItemPins items={row.binding.items} /><p className="fei-hint">原绑定未返回各项计数 当前不补 0 应用时由服务器按完整原数量复核</p></> :
      <><form className="fei-search" aria-label={"查询整组候选 第 " + row.rowNumber + " 行"} onSubmit={event => {
        event.preventDefault(); const data = new FormData(event.currentTarget); setQuery(String(data.get("q") ?? "").trim()); setTrail([undefined]);
      }}><label>查询已提交的原生产文件<input name="q" maxLength={200} placeholder="订单号或原编号辅助筛选 不自动匹配" /></label>
        <button className="oc-button" type="submit" disabled={reading || disabled}><Search size={14} aria-hidden="true" />查询原生产候选</button></form>
      {reading && <p role="status">正在读取本工厂原版本候选</p>}
      {error && <p role="alert" className="oc-delivery-error">{error}</p>}
      {page && <><div className="fei-actions"><button className="oc-button" type="button" disabled={disabled || reading || trail.length < 2} onClick={() => setTrail(value => value.slice(0, -1))}>上一页原生产候选</button>
        <button className="oc-button" type="button" disabled={disabled || reading || !page.nextCursor} onClick={() => setTrail(value => [...value, page.nextCursor!])}>下一页原生产候选</button></div>
        <p className="fei-hint">候选本页 {page.items.length} 项{page.nextCursor ? " 还有下一页" : " 当前查询已到末页"} 已选组不因翻页被替换</p>
        {!page.items.length && <p>{page.nextCursor ? "本扫描页无可绑定项 可继续下一页" : "当前查询已到末页 没有可绑定的原生产版本"}</p>}
        <ul className="fei-candidates">{page.items.map(item => <li key={item.deliveryItemId}><label className="fei-check">
          <input type="checkbox" aria-label={"选择原交付项 " + item.deliveryItemId} checked={!!selected[item.deliveryItemId]}
            disabled={disabled || item.bindingId !== null}
            onChange={event => { setConfirmed(false); setSelected(previous => { const next = { ...previous }; if (event.target.checked) next[item.deliveryItemId] = item; else delete next[item.deliveryItemId]; return next; }); }} />
          <span>{item.orderNumber} · 原生产计数 {item.quantity}<br />原交付项 <code>{item.deliveryItemId}</code><br />固定生产版本 <code>{item.productionVersionId}</code><br />真实提交 {item.submittedAt}
            {item.bindingId !== null && <span className="fei-hint"> 已固定绑定 请读取原编号核对 <code>{item.bindingId}</code></span>}</span>
        </label><details className="fei-details"><summary>核对候选完整来源</summary><FactoryErpItemPins items={[item]} /><p>提交凭据 <code>{item.submittedFeedbackId}</code> · 原交付包 <code>{item.packageId}</code></p></details></li>)}</ul></>}
      <h4>本行已选完整组 {chosen.length} 项</h4><p>已选原生产计数合计 {quantity} · 原表商品总数 {row.itemQuantity}</p>
      {chosen.length > 0 && <><FactoryErpItemPins items={chosen} /><div className="fei-actions">{chosen.map(item => <button className="oc-button" type="button" key={item.deliveryItemId} disabled={disabled}
        onClick={() => { setConfirmed(false); setSelected(previous => { const next = { ...previous }; delete next[item.deliveryItemId]; return next; }); }}>移除交付项 {item.deliveryItemId.slice(-8)}</button>)}</div></>}
      {quantity !== row.itemQuantity && <p className="oc-delivery-error">整组原计数须等于原表商品总数 不自动拆分 补齐或缩减数量</p>}</>}
    <form aria-label={"确认整组 第 " + row.rowNumber + " 行"} className="fei-form" onSubmit={save}>
      <fieldset disabled={disabled}><label className="fei-check fei-wide"><input type="checkbox" name="wholeGroupConfirmed" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        我已核对编号 {row.externalId} 对应这一整组原生产版本与文件 原表商品总数 {row.itemQuantity} 并确认上述当前关联修订与解除凭据
      </label><div className="fei-actions fei-wide"><button className="oc-button primary" type="submit" disabled={!ready || disabled}><Check size={14} aria-hidden="true" />确认并选择整组</button>
        <button className="oc-button" type="button" onClick={onCancel}><X size={14} aria-hidden="true" />放弃本行未保存的组选择</button></div></fieldset>
    </form>
  </section>;
}

export function FactoryErpApplySummary({ input, fileName }: { input: ApplyFactoryErpImport; fileName: string }) {
  const [page, setPage] = useState(0), current = Math.min(page, Math.max(0, Math.ceil(input.rows.length / 25) - 1));
  return <section aria-label="原工厂状态应用请求" className="fei-review">
    <h4>核对即将应用的固定原请求</h4><p>{fileName} · 仅应用明确选中的 {input.rows.length} 个原表整组 其余行不自动应用</p>
    <dl className="fei-pairs"><div><dt>原文件 SHA-256</dt><dd><code>{input.fileChecksum}</code></dd></div>
      <div><dt>原预览校验值</dt><dd><code>{input.previewChecksum}</code></dd></div>
      <div><dt>本次原请求编号</dt><dd><code>{input.idempotencyKey}</code></dd></div></dl>
    <p>本次只记录工厂状态及来源 不创建承运揽收 质检合格或已发货数量 作废只记异常不取消内部订单</p>
    <div className="fei-actions"><button className="oc-button" type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页原绑定</button>
      <button className="oc-button" type="button" disabled={(current + 1) * 25 >= input.rows.length} onClick={() => setPage(current + 1)}>下一页原绑定</button></div>
    <p>当前核对第 {current * 25 + 1}–{Math.min((current + 1) * 25, input.rows.length)} 组</p>
    {input.rows.slice(current * 25, (current + 1) * 25).map(row => <details className="fei-details" key={row.rowNumber}>
      <summary>原表第 {row.rowNumber} 行 · 已明确确认完整组 {row.items.length} 个原交付项</summary>
      {row.association ? <div className="fei-association"><p>固定关联修订 {row.association.expectedRevision}</p>
        <p>预期活动绑定 {row.association.expectedActiveBindingId ? <code>{row.association.expectedActiveBindingId}</code> : "无"}</p>
        <p>预期最近解除凭据 {row.association.expectedReleaseId ? <code>{row.association.expectedReleaseId}</code> : "无"}</p></div> :
        <p className="fei-hint">此为既存旧原请求 未保存关联修订确认 不以今天依据补填或替换原正文</p>}
      <FactoryErpItemPins items={row.items} />
    </details>)}
  </section>;
}
