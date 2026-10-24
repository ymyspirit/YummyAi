"use client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Upload, FileCheck2 } from "lucide-react";
import {
  AdReportTypeSchema,
  AdImportInputSchema,
  AdImportPreviewSchema,
  AdCommitImportSchema,
  AdCommitImportResultSchema,
  AdAttributionModelSchema,
  type AdImportInput,
  type AdImportPreview,
  type AdImportView,
  type AdProduct,
  type AdReportType,
  type AdMarketplace,
  type AdAttributionModel,
  type AdMetricCandidates,
  type AdMetricColumns,
} from "@yummyai/contracts/advertising";
import { adRequest, adIdempotency, adLabels, adError, adDenied, adMetricLabels, adConversionLabels, adMoney } from "./advertising-client";
import { useAdCommandMutation } from "./advertising-command-forms";
import { AdCommandMutationPanel } from "./advertising-command-workbench";
import { useErpAccess } from "../identity/erp-access";
import { AdMutationFeedback, AdArchiveForm, AdMeasurementSummary } from "./advertising-forms";

const localDateTime = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
type FileInput = AdImportInput["files"][number];
export function AdImportPanel({
  accountId,
  onCommitted,
  onDirty,
  permitted = false,
  onDenied,
  onArchived,
}: {
  accountId: string;
  onCommitted: (imports: AdImportView[]) => Promise<void>;
  onDirty: (dirty: boolean) => void;
  permitted?: boolean;
  onDenied?: (message: string) => void;
  onArchived?: () => Promise<void>;
}) {
  const access = useErpAccess();
  const [files, setFiles] = useState<FileInput[]>([]),
    [preview, setPreview] = useState<AdImportPreview | null>(null),
    [input, setInput] = useState<AdImportInput | null>(null),
    [candidates, setCandidates] = useState<Array<{ fileName: string; columns: AdMetricCandidates | undefined }>>([]),
    [conversionModel, setConversionModel] = useState<AdAttributionModel>("unknown"),
    [windowDays, setWindowDays] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""), [refreshError, setRefreshError] = useState("");
  const mutation = useAdCommandMutation({ kind: "import_commit", accountId, targetId: null }, permitted, onDenied, () => {
    generation.current++; previewAbort.current?.abort(); setFiles([]); setPreview(null); setInput(null); setCandidates([]); setConversionModel("unknown"); setWindowDays(""); setBusy(false); formRef.current?.reset(); onDirty(false);
  });
  const committed = AdCommitImportResultSchema.safeParse(mutation.result);
  const live = useRef(true), generation = useRef(0), previewAbort = useRef<AbortController | null>(null), formRef = useRef<HTMLFormElement | null>(null);
  const current = useRef({ accountId, authority: access.authority, preferenceScope: access.preferenceScope, permitted }); current.current = { accountId, authority: access.authority, preferenceScope: access.preferenceScope, permitted };
  useLayoutEffect(() => {
    generation.current++; previewAbort.current?.abort(); setFiles([]); setPreview(null); setInput(null); setCandidates([]); setConversionModel("unknown"); setWindowDays(""); setBusy(false); setError(""); setRefreshError(""); formRef.current?.reset();
  }, [accountId, access.authority, access.preferenceScope, permitted]);
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++; previewAbort.current?.abort(); }; }, []);
  const changed = () => {
    if (mutation.locked || !permitted) return;
    generation.current++; previewAbort.current?.abort();
    setPreview(null);
    setInput(null);
    onDirty(true);
  };
  async function choose(selected: FileList | null) {
    if (!selected || !permitted || mutation.locked) return;
    changed();
    setCandidates([]);
    const epoch = generation.current;
    setBusy(true);
    setError("");
    try {
      if (
        selected.length > 20 ||
        [...selected].reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024 ||
        [...selected].some((f) => f.size > 5 * 1024 * 1024)
      )
        throw new Error("单文件最多 5 MiB，每批最多 20 个文件、20 MiB");
      const decoded: FileInput[] = [];
      for (const f of selected) {
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            await f.arrayBuffer(),
          );
        } catch {
          throw new Error(`${f.name} 不是有效 UTF-8 CSV，请从报表导出 UTF-8 版本`);
        }
        decoded.push({ fileName: f.name, content, reportTypeHint: null, adProductHint: null });
      }
      if (live.current && epoch === generation.current && current.current.permitted) setFiles(decoded);
    } catch (e) {
      if (live.current && epoch === generation.current) { setFiles([]); setError(adError(e)); }
    } finally {
      if (live.current && epoch === generation.current) setBusy(false);
    }
  }
  async function inspect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!permitted || busy || mutation.locked) return;
    const epoch = ++generation.current, captured = { ...current.current };
    const abort = new AbortController(); previewAbort.current?.abort(); previewAbort.current = abort;
    const valid = () => live.current && !abort.signal.aborted && epoch === generation.current && current.current.accountId === captured.accountId && current.current.authority === captured.authority && current.current.preferenceScope === captured.preferenceScope && current.current.permitted;
    setError("");
    setBusy(true);
    try {
      const form = new FormData(e.currentTarget),
        val = (k: string) => String(form.get(k) ?? "");
      const marketplaceByCurrency: Record<string, AdMarketplace> = {};
      for (const line of val("mapping")
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean)) {
        const [c, m] = line.split("=").map((v) => v.trim().toUpperCase());
        if (!c || !m) throw new Error("币种映射格式为 USD=US，每行一项");
        marketplaceByCurrency[c] = m as AdMarketplace;
      }
      const prepared = AdImportInputSchema.parse({
        accountId,
        files,
        timezone: val("timezone"),
        attributionBasis: val("basis") as AdImportInput["attributionBasis"],
        attributionWindowDays: val("window") ? Number(val("window")) : null,
        conversionDefinition: { model: conversionModel, source: val("conversionSource") },
        observedAt: new Date(val("observedAt")).toISOString(),
        dateOrder: val("dateOrder") ? (val("dateOrder") as "MDY" | "DMY") : null,
        marketplaceByCurrency,
        allowPartial: form.get("partial") === "on",
        idempotencyKey: adIdempotency(),
      });
      const result = AdImportPreviewSchema.parse(await adRequest("imports/preview", prepared, abort.signal));
      if (!valid()) return;
      setInput(prepared);
      setPreview(result);
      setCandidates(result.files.map(file => ({ fileName: file.fileName, columns: file.metricCandidates })));
    } catch (err) {
      if (!valid()) return;
      setPreview(null); setInput(null); setError(adError(err));
      if (adDenied(err)) { setFiles([]); setCandidates([]); setConversionModel("unknown"); setWindowDays(""); formRef.current?.reset(); onDirty(false); onDenied?.(adError(err)); }
    } finally {
      if (valid()) setBusy(false);
    }
  }
  async function commit() {
    if (!input || !preview?.canCommit || !permitted) return;
    const epoch = generation.current;
    const result = await mutation.submit("imports", () => AdCommitImportSchema.parse({ ...input, previewChecksum: preview.previewChecksum }), AdCommitImportResultSchema);
    if (!result || !live.current || epoch !== generation.current) return;
      onDirty(false);
      setPreview(null);
      setInput(null);
      setFiles([]);
      setCandidates([]);
      setConversionModel("unknown");
      setWindowDays("");
      formRef.current?.reset();
      try { await onCommitted(result.imports); } catch { if (live.current && epoch === generation.current) setRefreshError("refresh_failed"); }
  }
  if (mutation.commandId) return <AdCommandMutationPanel mutation={mutation} accountId={accountId} onDenied={onDenied} onCompleted={detail => { onDirty(false); if (detail.status === "succeeded" && onArchived) void onArchived().catch(() => setRefreshError("refresh_failed")); }} />;
  return (
    <section className="ad-import-panel" aria-label="导入广告 CSV">
      <h2>
        <Upload size={17} />
        导入广告报表
      </h2>
      <p className="ad-note">
        选择下载的 CSV，核对店铺与归因设置，预览通过后导入。报告类型按字段识别；SP 文件名不会把
        SB／SD 活动改成 SP。
      </p>
      <form ref={formRef} className="ad-form" onSubmit={inspect} onChange={changed}>
        <fieldset disabled={busy || mutation.pending || mutation.checking} inert={mutation.locked || !permitted} aria-disabled={mutation.locked || !permitted}>
          <label>
            选择 CSV 文件
            <input
              aria-label="选择 CSV 文件"
              type="file"
              multiple
              accept=".csv,text/csv"
              onChange={(e) => { e.stopPropagation(); void choose(e.target.files); }}
            />
          </label>
          {files.length > 0 && (
            <div className="ad-file-list">
              {files.map((f, i) => (
                <div key={`${f.fileName}:${i}`} className="ad-file-settings">
                  <span>{f.fileName}</span>
                  <label>
                    报告类型
                    <select
                      aria-label={`${f.fileName} 报告类型`}
                      value={f.reportTypeHint ?? ""}
                      onChange={(e) =>
                        setFiles((rows) =>
                          rows.map((r, j) =>
                            j === i
                              ? {
                                  ...r,
                                  reportTypeHint: (e.target.value || null) as AdReportType | null,
                                }
                              : r,
                          ),
                        )
                      }
                    >
                      <option value="">自动识别</option>
                      {AdReportTypeSchema.options.map((t) => (
                        <option value={t} key={t}>
                          {adLabels[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    缺失广告产品时
                    <select
                      aria-label={`${f.fileName} 广告产品`}
                      value={f.adProductHint ?? ""}
                      onChange={(e) =>
                        setFiles((rows) =>
                          rows.map((r, j) =>
                            j === i
                              ? {
                                  ...r,
                                  adProductHint: (e.target.value || null) as AdProduct | null,
                                }
                              : r,
                          ),
                        )
                      }
                    >
                      <option value="">保持未知／关联活动表</option>
                      <option>SP</option>
                      <option>SB</option>
                      <option>SD</option>
                    </select>
                  </label>
                  {candidates[i]?.fileName === f.fileName && candidates[i]?.columns && <details className="ad-column-picker">
                    <summary>{f.fileName} · 选择采用的指标列</summary>
                    <p className="ad-note">候选来自这份原 CSV 的解析 修改任何选择后原预览凭据即失效 必须重新解析并预览</p>
                    <div className="ad-metric-selectors">
                      {(Object.keys(adMetricLabels) as Array<keyof AdMetricColumns>).map(metric => {
                        const selected = f.metricColumns?.[metric];
                        return <label key={metric}>{adMetricLabels[metric]}采用列<select
                          aria-label={`${f.fileName} ${adMetricLabels[metric]}采用列`}
                          value={selected === undefined ? "auto" : selected === null ? "none" : `column:${selected}`}
                          onChange={event => {
                            if (!permitted || mutation.locked) return;
                            const value = event.target.value;
                            setFiles(rows => rows.map((row, index) => {
                              if (index !== i) return row;
                              const metricColumns = { ...row.metricColumns };
                              if (value === "auto") delete metricColumns[metric];
                              else metricColumns[metric] = value === "none" ? null : value.slice(7);
                              const next = { ...row };
                              if (Object.keys(metricColumns).length) next.metricColumns = metricColumns;
                              else delete next.metricColumns;
                              return next;
                            }));
                          }}>
                          <option value="auto">自动识别 必须核对新预览</option>
                          <option value="none">明确不采用此指标列</option>
                          {candidates[i]!.columns![metric].map(column => <option value={`column:${column}`} key={column}>{column}</option>)}
                        </select></label>;
                      })}
                    </div>
                  </details>}
                </div>
              ))}
            </div>
          )}
          <div className="ad-form-grid">
            <label>
              报告时区
              <input
                name="timezone"
                required
                placeholder="例如 America/Los_Angeles"
              />
            </label>
            <label>
              下载／采集时间
              <input
                name="observedAt"
                type="datetime-local"
                defaultValue={localDateTime()}
                required
              />
            </label>
            <label>
              归因天数（未知则留空）
              <input name="window" type="number" min="0" max="90" placeholder="按报表设置填写" value={windowDays} required={conversionModel === "shopping_signal_2026"} readOnly={conversionModel === "all_views_14d"} onChange={event => setWindowDays(event.target.value)} />
            </label>
            <label>
              归因方式
              <select aria-label="归因方式" name="basis" defaultValue="unknown">
                <option value="unknown">未确认</option>
                <option value="click">点击归因</option>
                <option value="click_and_view">点击与浏览归因</option>
              </select>
            </label>
            <label>
              数字日期顺序
              <select aria-label="数字日期顺序" name="dateOrder" defaultValue="">
                <option value="">仅自动识别无歧义日期</option>
                <option value="MDY">月／日／年</option>
                <option value="DMY">日／月／年</option>
              </select>
            </label>
            <label>
              缺失站点时的明确映射
              <textarea name="mapping" rows={2} placeholder={"USD=US\nCAD=CA"} />
            </label>
          </div>
          <div className="ad-conversion-input">
            <label>转化指标定义<select aria-label="转化指标定义" name="conversionModel" value={conversionModel} onChange={event => {
              const next = AdAttributionModelSchema.parse(event.target.value);
              if (next === "all_views_14d") setWindowDays("14");
              else if (conversionModel === "all_views_14d") setWindowDays("");
              setConversionModel(next);
            }}>{AdAttributionModelSchema.options.map(model => <option key={model} value={model}>{adConversionLabels[model]}</option>)}</select></label>
            <label>指标定义核对依据<textarea name="conversionSource" rows={2} maxLength={1000} minLength={conversionModel === "unknown" ? undefined : 3} required={conversionModel !== "unknown"} placeholder="填写原报告设置 指标名称与窗口来源 尚未核对可留空" /></label>
            <p className="ad-note">这是人工核对说明 不代表外部验真 不按年份自动选择购物信号口径 SB／SD 的 vCPM 或 Store 等特殊指标须以原报告适用范围为准</p>
            {conversionModel === "all_views_14d" && <p className="ad-note">全部浏览转化使用固定 14 天窗口 仍需核对原报告指标和适用范围</p>}
            {conversionModel === "shopping_signal_2026" && <p className="ad-note">购物信号转化没有默认窗口 请在归因天数及核对依据中填写报告实际设置</p>}
          </div>
          <p className="ad-note">
            时区需与导出报表一致。归因窗口未知时仍可展示表现，但不会用近期零购买量生成否词建议。混合归因口径的报告应分批导入。
          </p>
          <label className="ad-check">
            <input name="partial" type="checkbox" />
            保留可用行并隔离错误行（先核对预览诊断）
          </label>
        </fieldset>
        <button
          type="submit"
          disabled={busy || mutation.locked || !files.length || !accountId || !permitted}
          className="ad-secondary"
        >
          {busy ? "处理中…" : "解析并预览"}
        </button>
      </form>
      {error && (
        <p className="ad-error" role="alert">
          {error}
        </p>
      )}
      <AdMutationFeedback mutation={mutation} title="报表导入已登记" refreshError={refreshError} />
      {committed.success && <section className="ad-receipt" aria-label="本次导入来源回执"><h3>本次导入来源回执</h3><p className="ad-note">以下仅为本次导入实际返回的来源 不表示读取了其他历史报表</p>{committed.data.imports.map(row => <div key={row.id} className="ad-receipt-row"><strong>{row.fileName}</strong><p>来源 ID <code>{row.id}</code></p><p>SHA-256 <code>{row.checksum}</code></p><dl className="ad-source-fields"><div><dt>统计范围</dt><dd>{row.periodStart ?? "未知"} 至 {row.periodEnd ?? "未知"}</dd></div><div><dt>时区与声明归因</dt><dd>{row.timezone} · {row.attributionWindowDays ?? "未知"} 天 · {row.attributionBasis}</dd></div><div><dt>原始／可用／隔离行</dt><dd>{row.sourceRowCount}／{row.acceptedRowCount}／{row.rejectedRowCount}</dd></div></dl><details><summary>本次来源测量依据 {row.fileName}</summary><AdMeasurementSummary measurement={row.measurement} /></details><details><summary>归档本次导入来源 {row.fileName}</summary><AdArchiveForm accountId={accountId} importId={row.id} permitted={permitted} onDirty={onDirty} onDenied={onDenied} onSaved={onArchived ?? (async () => {})} /></details></div>)}</section>}
      {mutation.result !== null && <button type="button" className="ad-secondary" onClick={() => { mutation.reset(); setRefreshError(""); }}>准备导入另一批报表</button>}
      {preview && (
        <section className="ad-preview" aria-label="导入预览">
          <h3>
            <FileCheck2 size={16} />
            导入预览
          </h3>
          <div className="ad-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>文件／报告类型</th>
                  <th>原始行</th>
                  <th>可用行</th>
                  <th>隔离行</th>
                  <th>诊断</th>
                </tr>
              </thead>
              <tbody>
                {preview.files.map((f, index) => (
                  <tr key={`${f.fileName}:${index}`}>
                    <td>
                      {f.fileName}
                      <small>{f.reportType ? adLabels[f.reportType] : "未识别"}</small>
                    </td>
                    <td>{f.sourceRowCount}</td>
                    <td>{f.acceptedRowCount}</td>
                    <td>{f.rejectedRowCount}</td>
                    <td>{f.diagnosticCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.files.map((f, index) => (
            <details key={`${f.fileName}:${index}`}>
              <summary>{f.fileName} · 字段与诊断</summary>
              <p className="ad-note">{f.headers.join(" · ")}</p>
              <AdMeasurementSummary measurement={f.measurement} />
              <ul className="ad-constraints">
                {f.diagnostics.map((d, i) => (
                  <li key={i}>
                    {d.row ? `第 ${d.row} 行 · ` : ""}
                    {d.message}
                  </li>
                ))}
              </ul>
              <p className="ad-note">
                示例广告产品：{[...new Set(f.sample.map((r) => r.adProduct ?? "未知"))].join(" / ")}{" "}
                · 示例币种：{[...new Set(f.sample.map((r) => r.currency ?? "缺失"))].join(" / ")} · 示例不代替完整报表精度清单
              </p>
              {f.sample.length > 0 && <details className="ad-sample-measurement"><summary>核对实际样例原值与转换 {f.sample.length} 行</summary><p className="ad-note">服务返回的前 {f.sample.length} 行样例 不是全量事实 原文件与完整采用列仍按本次预览固定</p>{f.sample.map(row => <details key={`${row.sourceRow}:${row.rowKey}`}><summary>原文件第 {row.sourceRow} 行 · {row.currency ?? "币种未确认"}</summary><dl className="ad-source-fields"><div><dt>展示／点击／购买</dt><dd>{row.metrics.impressions ?? "待补充"}／{row.metrics.clicks ?? "待补充"}／{row.metrics.purchases ?? "待补充"}</dd></div><div><dt>转换后广告花费</dt><dd>{adMoney(row.metrics.spendMinor, row.currency, row.measurement?.monetaryBasis)}</dd></div><div><dt>转换后归因销售额</dt><dd>{adMoney(row.metrics.salesMinor, row.currency, row.measurement?.monetaryBasis)}</dd></div><div><dt>转换后竞价</dt><dd>{adMoney(row.bidMinor, row.currency, row.measurement?.monetaryBasis)}</dd></div></dl><AdMeasurementSummary measurement={row.measurement} sourceFields={row.sourceFields} currency={row.currency} /></details>)}</details>}
            </details>
          ))}
          {!preview.canCommit && (
            <p role="alert" className="ad-error">
              存在阻止导入的错误，请修正设置或文件后重新预览。
            </p>
          )}
          <button
            className="ad-primary"
            type="button"
            disabled={!preview.canCommit || busy || mutation.pending || mutation.result !== null || !permitted}
            onClick={() => void commit()}
          >
            {mutation.pending ? "正在保存原提交…" : mutation.frozen ? "重试保存同一批原报表" : "保存已预览原报表并核对"}
          </button>
        </section>
      )}
    </section>
  );
}
