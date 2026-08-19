"use client";

import type {
  OrderPersonalizationBatch,
  OrderPersonalizationCandidate,
  OrderPersonalizationCandidateBlocker,
  OrderPersonalizationOptionsView,
  OrderPersonalizationRenderTask,
  OrderPersonalizationRenderTool,
} from "@yummyai/contracts/pod/order-personalization";
import { VectorFulfillmentQualityCheckSnapshotSchema } from "@yummyai/contracts/pod/order-personalization";
import {
  Boxes,
  CheckCircle2,
  CircleAlert,
  Download,
  ExternalLink,
  Factory,
  FileSpreadsheet,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  Play,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { Fragment, useActionState, useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

import {
  createOrderPersonalizationBatch,
  createOrderPersonalizationRenderTask,
  type PodOrderPersonalizationActionState,
} from "./pod-order-personalization-actions";
import {
  candidateSelectionValue,
  parseOrderPersonalizationCandidateCsv,
  type OrderPersonalizationTableImportDiagnosticCode,
  type OrderPersonalizationTableImportResult,
} from "./pod-order-personalization-table-import";

const idle: PodOrderPersonalizationActionState = { message: "", status: "idle" };

export function PodOrderPersonalizationPanel({
  batches,
  error,
  enabledRenderTools,
  mode,
  options,
  renderTasks,
}: {
  batches: OrderPersonalizationBatch[];
  error?: string;
  enabledRenderTools: OrderPersonalizationRenderTool[];
  mode: "personalization" | "production";
  options?: OrderPersonalizationOptionsView;
  renderTasks: OrderPersonalizationRenderTask[];
}) {
  const activeKey = [
    ...batches.filter((batch) => batch.status === "queued" || batch.status === "running")
      .map((batch) => `${batch.id}:${batch.status}`),
    ...renderTasks.filter((task) => task.status === "queued" || task.status === "running")
      .map((task) => `${task.id}:${task.status}:${task.progressPercent}`),
  ].join("|");
  useEffect(() => {
    if (!activeKey) return;
    const timer = window.setTimeout(() => window.location.reload(), 2_500);
    return () => window.clearTimeout(timer);
  }, [activeKey]);

  const eligible = options?.items.filter((candidate) => candidate.eligible) ?? [];
  const blocked = options?.items.filter((candidate) => !candidate.eligible) ?? [];
  const title = mode === "personalization" ? "订单定制编排" : "订单履约生产";
  const description = mode === "personalization"
    ? "先把订单行、顾客素材版本和 SKU 模板绑定解析成加密快照，再生成可审核套图。"
    : "从已预处理的订单行生成 PNG/TIFF 履约图或 SVG 矢量生产文件，输出版本仍需质检和人工审核。";
  const Icon = mode === "personalization" ? ImagePlus : Factory;

  return (
    <section className="pod-order-console" aria-labelledby={`pod-order-console-${mode}`}>
      <header>
        <div><p>ORDER PERSONALIZATION</p><h3 id={`pod-order-console-${mode}`}>{title}</h3></div>
        <span>{eligible.length} READY</span>
      </header>
      <div className="pod-order-boundary">
        <LockKeyhole size={15} />
        <span><b>顾客数据留在订单私有域</b>{description} 页面只显示订单标识、商品、SKU、模板和状态，不返回顾客姓名、留言或原始图片引用。</span>
      </div>
      {error ? <p className="pod-order-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
      {!error ? (
        <div className="pod-order-layout">
          <BatchPreparationForm blocked={blocked} eligible={eligible} icon={<Icon size={16} />} />
          <div className="pod-order-ledgers">
            <BatchLedger
              batches={batches}
              candidates={options?.items ?? []}
              enabledRenderTools={enabledRenderTools}
              mode={mode}
              renderTasks={renderTasks}
            />
            <RenderLedger renderTasks={renderTasks} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BatchPreparationForm({
  blocked,
  eligible,
  icon,
}: {
  blocked: OrderPersonalizationCandidate[];
  eligible: OrderPersonalizationCandidate[];
  icon: ReactNode;
}) {
  const [state, action] = useActionState(createOrderPersonalizationBatch, idle);
  const [selectedValues, setSelectedValues] = useState<Set<string>>(() => new Set());
  const [tableImport, setTableImport] = useState<OrderPersonalizationTableImportResult>();
  const [importing, setImporting] = useState(false);
  const duplicateLines = new Set(
    eligible.filter((candidate, index) => eligible.findIndex((entry) => entry.orderLineId === candidate.orderLineId) !== index)
      .map((candidate) => candidate.orderLineId),
  );
  const valueCandidates = new Map(eligible.flatMap((candidate) => {
    const candidateValue = candidateSelectionValue(candidate);
    return candidateValue ? [[candidateValue, candidate] as const] : [];
  }));
  const toggleCandidate = (candidate: OrderPersonalizationCandidate, checked: boolean) => {
    const candidateValue = candidateSelectionValue(candidate);
    if (!candidateValue) return;
    setSelectedValues((current) => {
      const next = new Set(current);
      for (const [entryValue, entryCandidate] of valueCandidates) {
        if (entryCandidate.orderLineId === candidate.orderLineId) next.delete(entryValue);
      }
      if (checked) next.add(candidateValue);
      return next;
    });
  };
  const selectUnambiguous = () => setSelectedValues(new Set(
    eligible.flatMap((candidate) => {
      const candidateValue = candidateSelectionValue(candidate);
      return candidateValue && !duplicateLines.has(candidate.orderLineId) ? [candidateValue] : [];
    }),
  ));
  const importCsv = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const result = parseOrderPersonalizationCandidateCsv(await file.text(), [...eligible, ...blocked]);
      setTableImport(result);
      if (!result.fileError) setSelectedValues(new Set(result.matchedValues));
    } catch {
      setTableImport({ diagnostics: [], matchedValues: [], rowCount: 0, fileError: "无法读取 CSV 文件。" });
    } finally {
      setImporting(false);
    }
  };
  return (
    <form action={action} className="pod-order-preparation-form">
      <div className="pod-form-heading">{icon}<div><strong>创建安全预处理批次</strong><span>每批最多 100 个订单行，标识与版本固定后进入异步解析。</span></div></div>
      <section className="pod-order-table-import" aria-label="批量表格填充">
        <header><span><FileSpreadsheet size={14} /><b>批量表格填充</b></span><small>仅在本机解析安全标识列</small></header>
        <p>支持 <code>external_order_id</code>、<code>external_line_id</code> 和可选 <code>size_label</code>。未知列会拒绝整表，原始 CSV 不上传。</p>
        <div>
          <label className="pod-order-import-button">
            <FileSpreadsheet size={13} />{importing ? "解析中" : "导入 CSV"}
            <input
              accept=".csv,text/csv"
              disabled={importing}
              onChange={(event) => {
                void importCsv(event.target.files?.[0]);
                event.currentTarget.value = "";
              }}
              type="file"
            />
          </label>
          <a download="order-personalization-template.csv" href="data:text/csv;charset=utf-8,%EF%BB%BFexternal_order_id%2Cexternal_line_id%2Csize_label%0A"><Download size={13} />下载模板</a>
          <button onClick={selectUnambiguous} type="button">选择全部无歧义项</button>
          <button onClick={() => { setSelectedValues(new Set()); setTableImport(undefined); }} type="button">清空</button>
        </div>
        {tableImport ? <TableImportNotice result={tableImport} /> : null}
      </section>
      <div className="pod-order-candidate-list" role="group" aria-label="可处理订单行">
        {!eligible.length ? (
          <p className="pod-order-empty"><Boxes size={16} />当前没有同时满足定制完整、SKU 已关联、模板已批准且绑定有效的订单行。</p>
        ) : eligible.map((candidate) => (
          <label className="pod-order-candidate" key={`${candidate.orderLineId}:${candidate.bindingId}`}>
            <input
              checked={selectedValues.has(candidateSelectionValue(candidate) ?? "")}
              name="candidate"
              onChange={(event) => toggleCandidate(candidate, event.target.checked)}
              type="checkbox"
              value={[candidate.orderId, candidate.orderLineId, candidate.customizationVersionId, candidate.bindingId].join(":")}
            />
            <span>
              <b>{candidate.externalOrderId}</b>
              <strong>{candidate.lineTitle}</strong>
              <small>{candidate.platform.toUpperCase()} · {candidate.skuCode ?? "未命名 SKU"} · 数量 {candidate.quantity}</small>
            </span>
            <span>
              <b>{candidate.templateName}</b>
              <small>尺寸 {candidate.sizeLabel} · 定制 V{candidate.customizationVersionNumber} · {candidate.completeness}%</small>
              {duplicateLines.has(candidate.orderLineId) ? <em>该订单行有多个模板，只能选择一个</em> : null}
            </span>
          </label>
        ))}
      </div>
      {blocked.length ? (
        <details className="pod-order-blocked">
          <summary>{blocked.length} 个候选项被安全规则阻断</summary>
          <div>{blocked.slice(0, 20).map((candidate) => (
            <article key={`${candidate.orderLineId}:${candidate.bindingId ?? "none"}`}>
              <span><b>{candidate.externalOrderId}</b><small>{candidate.lineTitle}</small></span>
              <span>{candidate.blockers.map(blockerLabel).join(" · ")}</span>
            </article>
          ))}</div>
        </details>
      ) : null}
      <footer>
        <ActionNotice state={state} />
        <span className="pod-order-selected-count">已选 {selectedValues.size} 行</span>
        <SubmitButton disabled={!selectedValues.size} icon="prepare" label="创建预处理批次" />
      </footer>
    </form>
  );
}

function TableImportNotice({ result }: { result: OrderPersonalizationTableImportResult }) {
  if (result.fileError) return <p className="pod-order-import-error" role="alert"><CircleAlert size={12} />{result.fileError}</p>;
  return (
    <div className="pod-order-import-result" role="status">
      <p><CheckCircle2 size={12} />{result.rowCount} 行中 {result.matchedValues.length} 行已匹配，{result.diagnostics.length} 行未进入选择。</p>
      {result.diagnostics.length ? <ul>{result.diagnostics.slice(0, 20).map((diagnostic) => (
        <li key={`${diagnostic.row}:${diagnostic.code}`}>第 {diagnostic.row} 行 · {tableImportDiagnosticLabel(diagnostic.code)}</li>
      ))}</ul> : null}
    </div>
  );
}

function BatchLedger({
  batches,
  candidates,
  enabledRenderTools,
  mode,
  renderTasks,
}: {
  batches: OrderPersonalizationBatch[];
  candidates: OrderPersonalizationCandidate[];
  enabledRenderTools: OrderPersonalizationRenderTool[];
  mode: "personalization" | "production";
  renderTasks: OrderPersonalizationRenderTask[];
}) {
  return (
    <section className="pod-order-batch-ledger" aria-label="预处理批次">
      <header><strong>预处理批次</strong><span>{batches.length} BATCHES</span></header>
      {!batches.length ? <p className="pod-order-empty"><Boxes size={16} />尚无订单个性化预处理批次。</p> : null}
      {batches.slice(0, 12).map((batch) => (
        <article key={batch.id}>
          <header>
            <Boxes size={15} />
            <span><b>{shortId(batch.id)}</b><small>{timeLabel(batch.createdAt)} · {batch.preparedCount}/{batch.itemCount} 已预处理 · {batch.failedCount} 失败</small></span>
            <span className={`pod-order-status ${batch.status}`}>{batchStatusLabel(batch.status)}</span>
          </header>
          {batch.errorCode ? <p className="pod-order-diagnostic"><CircleAlert size={12} />{batch.errorCode}: {batch.errorMessage}</p> : null}
          <div className="pod-order-batch-items">
            {batch.items.map((item) => {
              const candidate = candidates.find((entry) => entry.orderLineId === item.orderLineId && entry.bindingId === item.bindingId);
              const latestRender = renderTasks.find((task) => task.batchItemId === item.id);
              return (
                <section key={item.id}>
                  <header>
                    <span><b>{candidate?.externalOrderId ?? shortId(item.orderId)}</b><small>{candidate?.lineTitle ?? `订单行 ${shortId(item.orderLineId)}`}</small></span>
                    <span className={`pod-order-status ${item.status}`}>{batchItemStatusLabel(item.status)}</span>
                  </header>
                  {item.errorCode ? <p className="pod-order-diagnostic"><CircleAlert size={12} />{item.errorCode}: {item.errorMessage}</p> : null}
                  {item.status === "prepared" ? (
                    <RenderForm
                      enabledRenderTools={enabledRenderTools}
                      itemId={item.id}
                      latestRender={latestRender}
                      mode={mode}
                    />
                  ) : null}
                </section>
              );
            })}
          </div>
        </article>
      ))}
    </section>
  );
}

function RenderForm({
  enabledRenderTools,
  itemId,
  latestRender,
  mode,
}: {
  enabledRenderTools: OrderPersonalizationRenderTool[];
  itemId: string;
  latestRender?: OrderPersonalizationRenderTask;
  mode: "personalization" | "production";
}) {
  const [state, action] = useActionState(createOrderPersonalizationRenderTask, idle);
  const production = mode === "production";
  const productionTools = enabledRenderTools.filter((tool) => tool === "fulfillment_composite" || tool === "vector_fulfillment");
  const personalizationTools = enabledRenderTools.filter((tool) => tool !== "fulfillment_composite" && tool !== "vector_fulfillment");
  const [toolKey, setToolKey] = useState<OrderPersonalizationRenderTool>(
    production ? productionTools[0] ?? "fulfillment_composite" : personalizationTools[0] ?? "image_composite",
  );
  const [aiConsent, setAiConsent] = useState(false);
  const enabled = enabledRenderTools.includes(toolKey);
  const creative = toolKey === "group_photo" || toolKey === "pet_outfit";
  const vector = toolKey === "vector_fulfillment";
  const availableTools = production ? productionTools : personalizationTools;
  return (
    <form action={action} className="pod-order-render-form">
      <input name="batchItemId" type="hidden" value={itemId} />
      <div className="pod-order-render-fields" key={toolKey}>
        <label><span>{production ? "生产类型" : "任务类型"}</span><select name="toolKey" onChange={(event) => { setToolKey(event.target.value as OrderPersonalizationRenderTool); setAiConsent(false); }} value={toolKey}>
            {availableTools.length ? availableTools.map((tool) => <option key={tool} value={tool}>{renderToolLabel(tool)}</option>) : <option value={production ? "fulfillment_composite" : "image_composite"}>{production ? "履约图合成" : "图片合成"}</option>}
          </select></label>
        {vector ? <>
          <input name="outputFormat" type="hidden" value="svg" />
          <input name="fitMode" type="hidden" value="template" />
          <input name="autoComposition" type="hidden" value="off" />
          <label><span>模板配置</span><input defaultValue="laser-cut-v1" maxLength={500} name="vectorTemplateProfile" required /></label>
          <label><span>宽度</span><input defaultValue={300} max={100000} min={0.01} name="vectorWidth" required step="0.01" type="number" /></label>
          <label><span>高度</span><input defaultValue={400} max={100000} min={0.01} name="vectorHeight" required step="0.01" type="number" /></label>
          <label><span>单位</span><select defaultValue="mm" name="vectorUnit"><option value="mm">毫米</option><option value="in">英寸</option></select></label>
          <label><span>排版</span><select defaultValue="template" name="vectorLayoutMode"><option value="template">按模板定位</option><option value="automatic">自动排版</option></select></label>
          <label><span>色彩</span><select defaultValue="spot" name="colorMode"><option value="spot">专色</option><option value="cmyk">CMYK</option></select></label>
          <label><span>最小线宽 mm</span><input defaultValue={0.3} max={100} min={0.01} name="minimumLineWidthMm" required step="0.01" type="number" /></label>
          <label><span>连接桥 mm</span><input defaultValue={1.5} max={100} min={0.1} name="bridgeWidthMm" required step="0.1" type="number" /></label>
          <label><span>路径修复</span><select defaultValue="safe" name="pathRepair"><option value="safe">安全修复并留痕</option><option value="off">不自动修复</option></select></label>
        </> : <>
          <label><span>格式</span><select defaultValue={production ? "tiff" : "png"} name="outputFormat">{production ? <><option value="tiff">TIFF</option><option value="png">PNG</option></> : <><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></>}</select></label>
          <label><span>适配</span><select defaultValue="template" name="fitMode"><option value="template">按模板</option><option value="contain">完整适配</option><option value="cover">裁切填充</option><option value="stretch">拉伸</option></select></label>
          <label><span>构图</span><select defaultValue={creative ? "subject_focus" : "off"} name="autoComposition">{creative ? <><option value="subject_focus">主体聚焦</option><option value="balanced">全局均衡</option></> : <><option value="off">关闭</option><option value="balanced">全局均衡</option><option value="subject_focus">主体聚焦</option></>}</select></label>
          <label><span>DPI</span><input defaultValue={300} max={2400} min={36} name="dpi" type="number" /></label>
          <label><span>色彩</span><select defaultValue={production ? "cmyk" : "rgb"} name="colorMode"><option value="rgb">RGB</option><option value="cmyk">CMYK</option><option value="grayscale">灰度</option></select></label>
        </>}
      </div>
      <input name="identityMode" type="hidden" value={creative ? "strict" : "standard"} />
      <input name="customerAssetUsage" type="hidden" value={creative ? "all" : "mapped"} />
      <input name="referenceIdentityTransfer" type="hidden" value={toolKey === "pet_outfit" ? "forbid" : "not_applicable"} />
      {vector ? <Fragment key="vector-options">
        <input name="transparent" type="hidden" value="on" />
        <label className="pod-order-checkbox"><input defaultChecked name="hollowMode" type="checkbox" /><span>启用镂空连接桥检查</span></label>
        <p className="pod-order-quality-rule"><ShieldCheck size={12} />文本强制转路径；禁止嵌入位图、外部资源和生成式推断。画布、闭合路径、孔洞方向、线宽与连接桥必须全部通过，失败时不生成可导出版本。</p>
      </Fragment> : <Fragment key="bitmap-options">
        <label className="pod-order-checkbox"><input name="transparent" type="checkbox" /><span>透明背景</span></label>
        <label className="pod-order-checkbox"><input checked={aiConsent} name="allowAiEnhancement" onChange={(event) => setAiConsent(event.target.checked)} required={creative} type="checkbox" /><span>{creative ? "确认使用 AI 构图，并执行严格身份保持检查" : "允许 AI 提质，并将结果标记为 AI 处理"}</span></label>
      </Fragment>}
      {creative ? <p className="pod-order-quality-rule"><ShieldCheck size={12} />{toolKey === "group_photo" ? "至少需要两张不同顾客图片。每个输出必须完整使用全部输入，人物缺失、重复或新增时失败关闭。" : "每个输出必须保持宠物身份、毛色斑纹和体型，且禁止把参考宠物身份迁移到结果。"}</p> : null}
      {!enabled ? <p className="pod-order-diagnostic"><CircleAlert size={12} />当前环境未配置该订单渲染处理器。</p> : null}
      {latestRender ? <p className="pod-order-latest"><Play size={12} />最近任务 {renderStatusLabel(latestRender.status)} · {latestRender.progressPercent}%</p> : null}
      <footer><ActionNotice state={state} /><SubmitButton disabled={!enabled || (creative && !aiConsent)} icon="render" label={vector ? "生成履约 SVG" : production ? "生成履约图" : toolKey === "group_photo" ? "生成合照" : toolKey === "pet_outfit" ? "生成宠物换装" : "生成定制套图"} /></footer>
    </form>
  );
}

function RenderLedger({ renderTasks }: { renderTasks: OrderPersonalizationRenderTask[] }) {
  return (
    <section className="pod-order-render-ledger" aria-label="订单渲染任务">
      <header><strong>渲染任务</strong><span>{renderTasks.length} TASKS</span></header>
      {!renderTasks.length ? <p className="pod-order-empty"><ImagePlus size={16} />预处理项完成后，可在上方创建渲染任务。</p> : null}
      {renderTasks.slice(0, 16).map((task) => (
        <article key={task.id}>
          {task.status === "awaiting_review" || task.status === "partially_succeeded" ? <CheckCircle2 size={14} /> : task.status === "failed" ? <CircleAlert size={14} /> : <LoaderCircle className={task.status === "running" ? "spin" : undefined} size={14} />}
          <span><b>{renderToolLabel(task.toolKey)}</b><small>{task.parameterSnapshot.outputFormat.toUpperCase()} · {task.progressPercent}% · {timeLabel(task.createdAt)}</small></span>
          <span className={`pod-order-status ${task.status}`}>{renderStatusLabel(task.status)}</span>
          {task.resultVersionId ? <Link href={`/design?task=${task.designTaskId}`}><ExternalLink size={11} />查看审核版本</Link> : null}
          {creativeInputKeys(task).length ? <p className="pod-order-quality-evidence"><ShieldCheck size={12} />已核对输入：{creativeInputKeys(task).join("、")}</p> : null}
          {task.toolKey === "vector_fulfillment" ? <VectorQualityEvidence task={task} /> : null}
          {task.errorCode ? <p className="pod-order-diagnostic"><CircleAlert size={12} />{task.errorCode}: {task.errorMessage}</p> : null}
        </article>
      ))}
      <div className="pod-order-review-note"><ShieldCheck size={14} /><span>所有输出都保留模板版本、参数快照、处理器版本和质量检查记录。未经人工审核，不进入 Listing 或生产导出。</span></div>
    </section>
  );
}

function SubmitButton({ disabled, icon, label }: { disabled?: boolean; icon: "prepare" | "render"; label: string }) {
  const { pending } = useFormStatus();
  return <button aria-busy={pending} disabled={disabled || pending} type="submit">{pending ? <LoaderCircle className="spin" size={13} /> : icon === "prepare" ? <Boxes size={13} /> : <Play size={13} />}{pending ? "提交中" : label}</button>;
}

function ActionNotice({ state }: { state: PodOrderPersonalizationActionState }) {
  if (!state.message) return <span />;
  return <p className={`pod-order-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"}>{state.status === "success" ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}{state.message}</p>;
}

function blockerLabel(value: OrderPersonalizationCandidateBlocker) {
  return ({
    order_cancelled: "订单已取消",
    customization_requirement_missing: "缺少定制需求",
    customization_version_missing: "缺少定制版本",
    customization_not_ready: "定制数据未就绪",
    catalog_sku_missing: "未关联目录 SKU",
    template_binding_missing: "缺少模板绑定",
    template_binding_inactive: "模板绑定已停用",
    template_not_approved: "模板尚未批准",
    binding_not_effective_at_order: "下单时绑定未生效",
  } as const)[value];
}

function tableImportDiagnosticLabel(value: OrderPersonalizationTableImportDiagnosticCode) {
  return ({
    candidate_blocked: "候选项被安全规则阻断",
    candidate_not_found: "未找到完全匹配的订单行与尺寸",
    duplicate_order_line: "同一订单行重复出现",
    invalid_row: "字段为空、过长或格式无效",
    size_required: "同一订单行有多个模板，必须填写尺寸",
  } as const)[value];
}

function batchStatusLabel(value: OrderPersonalizationBatch["status"]) {
  return ({ queued: "排队中", running: "解析中", completed: "已完成", partially_succeeded: "部分成功", failed: "失败" } as const)[value];
}

function batchItemStatusLabel(value: OrderPersonalizationBatch["items"][number]["status"]) {
  return ({ queued: "排队中", running: "解析中", prepared: "可渲染", failed: "失败" } as const)[value];
}

function renderStatusLabel(value: OrderPersonalizationRenderTask["status"]) {
  return ({ queued: "排队中", running: "渲染中", awaiting_review: "待审核", partially_succeeded: "部分成功", failed: "失败" } as const)[value];
}

function renderToolLabel(value: OrderPersonalizationRenderTool) {
  return ({ image_composite: "图片合成", group_photo: "合照", pet_outfit: "宠物换装", fulfillment_composite: "履约图合成", vector_fulfillment: "履约矢量合成" } as const)[value];
}

function VectorQualityEvidence({ task }: { task: OrderPersonalizationRenderTask }) {
  if (!task.qualityCheckSnapshot) return null;
  const parsed = VectorFulfillmentQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) {
    return task.status === "awaiting_review" || task.status === "partially_succeeded"
      ? <p className="pod-order-diagnostic"><CircleAlert size={12} />SVG 质量证据无效，禁止导出。</p>
      : null;
  }
  const paths = parsed.data.outputChecks.reduce((sum, check) => sum + check.pathCount, 0);
  const minimumLine = Math.min(...parsed.data.outputChecks.map((check) => check.minimumLineWidthMm));
  const bridges = parsed.data.outputChecks.flatMap((check) => check.minimumBridgeWidthMm ?? []);
  return <p className="pod-order-quality-evidence"><ShieldCheck size={12} />SVG 已通过生产检查 · {parsed.data.outputChecks.length} 文件 · {paths} 路径 · 最小线宽 {minimumLine} mm{bridges.length ? ` · 最小连接桥 ${Math.min(...bridges)} mm` : ""} · 修复 {parsed.data.repairs.length}</p>;
}

function creativeInputKeys(task: OrderPersonalizationRenderTask) {
  if (task.toolKey !== "group_photo" && task.toolKey !== "pet_outfit") return [];
  const snapshot = task.qualityCheckSnapshot as { outputChecks?: Array<{ usedInputStableKeys?: unknown }> } | undefined;
  const keys = snapshot?.outputChecks?.flatMap((check) => Array.isArray(check.usedInputStableKeys)
    ? check.usedInputStableKeys.filter((value): value is string => typeof value === "string")
    : []) ?? [];
  return [...new Set(keys)];
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function timeLabel(value: string) {
  return value.slice(0, 16).replace("T", " ");
}
