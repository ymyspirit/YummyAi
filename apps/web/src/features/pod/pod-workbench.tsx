import {
  CreativeDesignQualityCheckSnapshotSchema,
  ListingAssetQualityCheckSnapshotSchema,
  PieceComposeQualityCheckSnapshotSchema,
  PieceExtractQualityCheckSnapshotSchema,
  PatternCropQualityCheckSnapshotSchema,
  PatternProcessingQualityCheckSnapshotSchema,
  PrintExtractQualityCheckSnapshotSchema,
  ProductVideoQualityCheckSnapshotSchema,
  RightsRiskQualityCheckSnapshotSchema,
  UvLayersQualityCheckSnapshotSchema,
  type CreativeDesignQualityCheckSnapshot,
  type ListingAssetQualityCheckSnapshot,
  type PieceComposeQualityCheckSnapshot,
  type PieceExtractQualityCheckSnapshot,
  type PatternCropQualityCheckSnapshot,
  type PatternProcessingQualityCheckSnapshot,
  type PrintExtractQualityCheckSnapshot,
  type ProductVideoQualityCheckSnapshot,
  type RightsRiskQualityCheckSnapshot,
  type UvLayersQualityCheckSnapshot,
  type PodAssetPolicy,
  type PodModuleKey,
  type PodPhase,
  type PodToolAvailability,
  type PodToolCatalogView,
  type PodToolDefinition,
  type PodArtworkTaskView,
  type PodTaskInputOptionsView,
  type PodExportView,
} from "@yummyai/contracts/pod";
import type {
  PersonalizationTemplateVersion,
  PersonalizationTemplateSourceInspection,
  PodPersonalizationOptionsView,
  ProductionManifest,
} from "@yummyai/contracts/pod/personalization";
import type { PodListingArtifactOptionsView } from "@yummyai/contracts/pod/listing-artifacts";
import type {
  OrderPersonalizationBatch,
  OrderPersonalizationOptionsView,
  OrderPersonalizationRenderTask,
  OrderPersonalizationRenderTool,
} from "@yummyai/contracts/pod/order-personalization";
import {
  CircleAlert,
  Clock3,
  FileCheck2,
  LockKeyhole,
  Search,
  Sparkles,
} from "lucide-react";
import Link from "next/link";

import { PodTaskCreatePanel } from "./pod-task-create-panel";
import { PodExportControls } from "./pod-export-controls";
import { PodPersonalizationPanel } from "./pod-personalization-panel";
import { PodOrderPersonalizationPanel } from "./pod-order-personalization-panel";
import { PodListingArtifactPanel } from "./pod-listing-artifact-panel";
import { PodProductionManifestPanel } from "./pod-production-manifest-panel";
import { PodRightsSearchPanel } from "./pod-rights-search-panel";

const canonicalModules = [
  { key: "print_extraction", label: "印花提取", order: 1, phase: "pod_1" },
  { key: "print_design", label: "印花设计", order: 2, phase: "pod_2" },
  { key: "pattern_processing", label: "图案处理", order: 3, phase: "pod_1" },
  { key: "rights_risk", label: "侵权检测", order: 4, phase: "pod_1" },
  { key: "listing_assets", label: "套图&标题", order: 5, phase: "pod_2" },
  { key: "personalization", label: "来图定制", order: 6, phase: "pod_3" },
  { key: "production_artwork", label: "生产图", order: 7, phase: "pod_3" },
] as const;

export type PodWorkbenchLoadError = {
  kind: "unauthorized" | "forbidden" | "failed";
  message: string;
};

export function PodWorkbench({
  catalog,
  configurationError,
  error,
  exportError,
  exportsByTask = {},
  inputOptions,
  listingError,
  listingOptions,
  personalizationError,
  personalizationInspections = [],
  personalizationOptions,
  personalizationTemplates = [],
  orderPersonalizationBatches = [],
  orderPersonalizationError,
  orderPersonalizationOptions,
  orderPersonalizationRenderTasks = [],
  productionError,
  productionManifests = [],
  requestedModule,
  requestedTool,
  rightsError,
  rightsOptions,
  taskError,
  tasks = [],
}: {
  catalog?: PodToolCatalogView;
  configurationError?: string;
  error?: PodWorkbenchLoadError;
  exportError?: string;
  exportsByTask?: Record<string, PodExportView[]>;
  inputOptions?: PodTaskInputOptionsView;
  listingError?: string;
  listingOptions?: PodListingArtifactOptionsView;
  personalizationError?: string;
  personalizationInspections?: PersonalizationTemplateSourceInspection[];
  personalizationOptions?: PodPersonalizationOptionsView;
  personalizationTemplates?: PersonalizationTemplateVersion[];
  orderPersonalizationBatches?: OrderPersonalizationBatch[];
  orderPersonalizationError?: string;
  orderPersonalizationOptions?: OrderPersonalizationOptionsView;
  orderPersonalizationRenderTasks?: OrderPersonalizationRenderTask[];
  productionError?: string;
  productionManifests?: ProductionManifest[];
  requestedModule?: string;
  requestedTool?: string;
  rightsError?: string;
  rightsOptions?: PodTaskInputOptionsView;
  taskError?: string;
  tasks?: PodArtworkTaskView[];
}) {
  const moduleKey = isModuleKey(requestedModule) ? requestedModule : canonicalModules[0].key;
  const activeModule = catalog?.modules.find((module) => module.key === moduleKey)
    ?? canonicalModules.find((module) => module.key === moduleKey)!;
  const tools = catalog?.tools.filter((tool) => tool.module === moduleKey) ?? [];

  return (
    <>
      <header className="pod-header">
        <div>
          <p className="kicker">POD ARTWORK OPERATIONS</p>
          <h1>POD 作图中心</h1>
          <p>为 Amazon 和 Etsy 统一编排印花提取、设计处理、权利复核、套图、定制与生产文件。</p>
        </div>
        <div className="pod-marketplaces" aria-label="服务平台">
          <span><b>Amazon</b>Listing 与定制素材</span>
          <span><b>Etsy</b>Listing 与个性化素材</span>
        </div>
      </header>

      <section className="pod-boundary" aria-label="作图中心安全边界">
        <div><LockKeyhole size={17} /><span><b>资产域隔离</b>竞品证据不能进入发布或生产导出</span></div>
        <div><Clock3 size={17} /><span><b>版本不可覆盖</b>重试和参数变化创建新版本</span></div>
        <div><FileCheck2 size={17} /><span><b>人工审核</b>AI 生成、补全和改图结果审核后流转</span></div>
      </section>

      {catalog ? (
        <section className="pod-capability-strip" aria-label="公共能力">
          <div><Search size={16} /><strong>公共能力</strong></div>
          {catalog.supportCapabilities.map((capability) => (
            <span key={capability.key}>
              <b>{capability.label}</b>
              <small>{availabilityLabel(capability.availability)}</small>
            </span>
          ))}
        </section>
      ) : null}

      {catalog ? <TaskCenter error={taskError} exportError={exportError} exportsByTask={exportsByTask} tasks={tasks} /> : null}

      <div className="pod-workspace">
        <nav className="pod-module-nav" aria-label="作图中心模块">
          <header><span>MODULES</span><b>7</b></header>
          {canonicalModules.map((module) => {
            const count = catalog?.tools.filter((tool) => tool.module === module.key).length;
            const selected = module.key === moduleKey;
            return (
              <Link
                aria-current={selected ? "page" : undefined}
                className={selected ? "active" : undefined}
                href={`/pod-workbench?module=${module.key}`}
                key={module.key}
              >
                <span>{String(module.order).padStart(2, "0")}</span>
                <strong>{module.label}</strong>
                <small>{count ?? phaseLabel(module.phase)}</small>
              </Link>
            );
          })}
        </nav>

        <section className="pod-module-panel" aria-labelledby="pod-module-title">
          <header>
            <div>
              <p>{phaseLabel(activeModule.phase)} / MODULE {String(activeModule.order).padStart(2, "0")}</p>
              <h2 id="pod-module-title">{activeModule.label}</h2>
            </div>
            <span className={`pod-phase pod-phase-${activeModule.phase}`}>{phaseStatus(activeModule.phase)}</span>
          </header>

          {error ? <LoadState error={error} /> : null}
          {!error && configurationError ? (
            <p className="pod-create-blocked" role="alert">
              <CircleAlert size={15} />{configurationError}
            </p>
          ) : null}
          {!error && inputOptions && requestedTool === inputOptions.toolKey ? (
            <PodTaskCreatePanel
              moduleKey={moduleKey}
              options={inputOptions}
              toolLabel={tools.find((tool) => tool.key === inputOptions.toolKey)?.label ?? inputOptions.toolKey}
            />
          ) : null}
          {!error && moduleKey === "personalization" ? (
            <>
              <PodPersonalizationPanel
                error={personalizationError}
                options={personalizationOptions}
                inspections={personalizationInspections}
                templates={personalizationTemplates}
              />
              <PodOrderPersonalizationPanel
                batches={orderPersonalizationBatches}
                enabledRenderTools={enabledOrderTools(catalog, ["image_composite", "group_photo", "pet_outfit"])}
                error={orderPersonalizationError}
                mode="personalization"
                options={orderPersonalizationOptions}
                renderTasks={orderPersonalizationRenderTasks}
              />
            </>
          ) : null}
          {!error && moduleKey === "production_artwork" ? (
            <>
              <PodOrderPersonalizationPanel
                batches={orderPersonalizationBatches}
                enabledRenderTools={enabledOrderTools(catalog, ["fulfillment_composite", "vector_fulfillment"])}
                error={orderPersonalizationError}
                mode="production"
                options={orderPersonalizationOptions}
                renderTasks={orderPersonalizationRenderTasks}
              />
              <PodProductionManifestPanel error={productionError} manifests={productionManifests} />
            </>
          ) : null}
          {!error && moduleKey === "rights_risk" ? (
            <PodRightsSearchPanel error={rightsError} options={rightsOptions} />
          ) : null}
          {!error && moduleKey === "listing_assets" ? (
            <PodListingArtifactPanel error={listingError} options={listingOptions} />
          ) : null}
          {!error && tools.length ? (
            <div className="pod-tool-list">
              {tools.map((item) => <ToolRow key={item.key} selected={item.key === requestedTool} tool={item} />)}
            </div>
          ) : null}
          {!error && !tools.length ? (
            <div className="pod-empty">
              <Sparkles size={24} />
              <strong>当前模块还没有工具定义</strong>
              <span>目录接口可用后会展示工具、参数、资产策略和交付阶段。</span>
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}

function enabledOrderTools(catalog: PodToolCatalogView | undefined, tools: OrderPersonalizationRenderTool[]) {
  return tools.filter((toolKey) => catalog?.tools.some((tool) => tool.key === toolKey && tool.availability === "enabled"));
}

function ToolRow({ selected, tool }: { selected: boolean; tool: PodToolDefinition }) {
  return (
    <article className="pod-tool-row">
      <div className="pod-tool-identity">
        <span><Sparkles size={16} /></span>
        <div>
          <h3>{tool.label}</h3>
          <p>{tool.description}</p>
        </div>
      </div>
      <dl className="pod-tool-policy">
        <div><dt>阶段</dt><dd>{phaseLabel(tool.phase)}</dd></div>
        <div><dt>素材范围</dt><dd>{assetPolicyLabel(tool.assetPolicy)}</dd></div>
        <div><dt>输入</dt><dd>{tool.inputKinds.map(inputKindLabel).join("、")}</dd></div>
        <div><dt>输出</dt><dd>{tool.outputKinds.map(outputKindLabel).join("、")}</dd></div>
      </dl>
      <div className="pod-tool-parameters" aria-label="可配置参数">
        {tool.parameterSummary.map((parameter) => <span key={parameter}>{parameter}</span>)}
      </div>
      <footer>
        <span className={`pod-availability pod-availability-${tool.availability}`}>
          {availabilityLabel(tool.availability)}
        </span>
        {tool.availability === "enabled" ? (
          <Link
            aria-current={selected ? "step" : undefined}
            className="pod-tool-create"
            href={`/pod-workbench?module=${tool.module}&tool=${tool.key}`}
          >
            {selected ? "正在配置" : "创建任务"}
          </Link>
        ) : <small>任务创建入口尚未开放</small>}
      </footer>
    </article>
  );
}

function TaskCenter({
  error,
  exportError,
  exportsByTask,
  tasks,
}: {
  error?: string;
  exportError?: string;
  exportsByTask: Record<string, PodExportView[]>;
  tasks: PodArtworkTaskView[];
}) {
  return (
    <section className="pod-task-center" aria-labelledby="pod-task-center-title">
      <header>
        <div><p>TASK CENTER</p><h2 id="pod-task-center-title">最近任务</h2></div>
        <span>{tasks.length} TASKS</span>
      </header>
      {error ? <p className="pod-task-error"><CircleAlert size={14} />{error}</p> : null}
      {!error && exportError ? <p className="pod-task-error"><CircleAlert size={14} />{exportError}</p> : null}
      {!error && !tasks.length ? <p className="pod-task-empty">还没有 POD 作图任务。工具启用后，可从对应工具行创建异步任务。</p> : null}
      {!error && tasks.length ? <ol>{tasks.slice(0, 12).map((task) => (
        <li key={task.id}>
          <span className={`pod-task-status pod-task-status-${task.status}`}>{taskStatusLabel(task.status)}</span>
          <div><strong>{task.title}</strong><small>{toolKeyLabel(task.toolKey)} · 尝试 {task.attemptCount}/{task.maxAttempts}</small></div>
          <progress aria-label={`${task.title}进度`} max={100} value={task.progressPercent} />
          <b>{task.progressPercent}%</b>
          <div className="pod-task-actions">
            <Link href={`/design?task=${task.designTaskId}`}>查看版本</Link>
            <PodExportControls exports={exportsByTask[task.id] ?? []} taskId={task.id} taskStatus={task.status} />
          </div>
          <ProductionTaskEvidence task={task} />
        </li>
      ))}</ol> : null}
    </section>
  );
}

function ProductionTaskEvidence({ task }: { task: PodArtworkTaskView }) {
  if (task.toolKey === "pattern_crop") return <PatternCropEvidence task={task} />;
  if (task.toolKey === "print_extract") return <PrintExtractEvidence task={task} />;
  if (["background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize", "authorized_watermark_remove"].includes(task.toolKey)) {
    return <PatternProcessingEvidence task={task} />;
  }
  if (["design_variation", "product_print_variation", "instruction_edit", "text_to_image", "element_fusion", "licensed_brand_fusion", "series_design", "style_reference", "style_transfer", "canvas_extend", "seamless_pattern", "seamless_stitch", "print_composite", "meme_print"].includes(task.toolKey)) {
    return <CreativeDesignEvidence task={task} />;
  }
  if (["product_suite", "title_draft", "virtual_try_on", "background_replace"].includes(task.toolKey)) {
    return <ListingAssetEvidence task={task} />;
  }
  if (task.toolKey === "rights_risk_scan") return <RightsRiskEvidence task={task} />;
  if (task.toolKey === "product_video") return <ProductVideoEvidence task={task} />;
  if (task.toolKey === "piece_extract") return <PieceExtractEvidence task={task} />;
  if (task.toolKey === "uv_layers") return <UvLayersEvidence task={task} />;
  return <PieceLayoutEvidence task={task} />;
}

function ListingAssetEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = ListingAssetQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed" || task.status === "partially_succeeded"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />套图或标题未形成完整的商品事实、身份保持、安全、许可和逐项结果证据。</p>
    : null;
  return <ListingAssetEvidenceView quality={parsed.data} />;
}

function ListingAssetEvidenceView({ quality }: { quality: ListingAssetQualityCheckSnapshot }) {
  const partial = quality.failedOutputCount > 0;
  return (
    <div className={`pod-piece-layout-evidence${partial ? " invalid" : ""}`}>
      {partial ? <CircleAlert size={12} /> : <FileCheck2 size={12} />}
      <span>
        <b>{partial ? "套图部分完成，失败槽位已隔离" : "套图与标题已校验"}</b>
        <small>{toolKeyLabel(quality.toolKey)} · {quality.platform.toUpperCase()} / {quality.locale} · {quality.successfulOutputCount} 成功 · {quality.failedOutputCount} 失败</small>
      </span>
      <span>{quality.outputChecks.map((check) => check.contentKind === "title"
        ? <code key={check.fileName}>#{check.outputIndex + 1} · {check.characterCount} 字符 / {check.byteCount} 字节 · 事实与商标检查通过</code>
        : <code key={check.fileName}>#{check.outputIndex + 1} · {check.slotKey} · {check.width}×{check.height}{check.modelLicenseVerified ? " · 模特许可已核验" : ""}{check.backgroundOnlyChanged ? " · 仅背景变化" : ""}</code>)}</span>
      {quality.failedOutputs.length ? <small>{quality.failedOutputs.map((failure) => `#${failure.outputIndex + 1} ${failure.errorCode}`).join(" · ")} · 修复后创建新版本</small> : null}
      <small>商品事实、身份保持、内容安全和文字均需人工审核；这里只形成 Listing 候选。</small>
    </div>
  );
}

function CreativeDesignEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = CreativeDesignQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />印花设计未形成完整的提示词、输入覆盖、安全检查和 AI 来源证据。</p>
    : null;
  return <CreativeDesignEvidenceView quality={parsed.data} />;
}

function CreativeDesignEvidenceView({ quality }: { quality: CreativeDesignQualityCheckSnapshot }) {
  const inputCount = new Set(quality.outputChecks.flatMap((check) => check.sourceInputOrdinals)).size;
  const aiGenerated = quality.outputChecks.some((check) => check.aiInference !== "none");
  const generatedRegionCount = quality.outputChecks.reduce((sum, check) => sum + check.generatedRegions.length, 0);
  return (
    <div className="pod-piece-layout-evidence">
      <FileCheck2 size={12} />
      <span>
        <b>印花设计已校验</b>
        <small>{toolKeyLabel(quality.toolKey)} · {quality.outputChecks.length} 张结果 · {inputCount} 张输入 · {aiGenerated ? "AI 生成" : "确定性处理"}</small>
      </span>
      <span>{quality.outputChecks.map((check) => (
        <code key={check.fileName}>
          #{check.outputIndex + 1} · {check.width}×{check.height}
          {check.tilePreviewValidated ? " · 平铺/接缝通过" : ""}
          {check.textReviewRequired ? " · 文字待人工复核" : ""}
        </code>
      ))}</span>
      <small>提示词指纹 {quality.finalPromptHashSha256.slice(0, 12)}… · {generatedRegionCount} 个局部 AI 区域已标记 · AI 结果仍需人工审核</small>
    </div>
  );
}

function RightsRiskEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = RightsRiskQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed" || task.status === "blocked"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />侵权检查未形成完整的数据源、有效期、模型和逐素材风险证据。</p>
    : null;
  return <RightsRiskEvidenceView quality={parsed.data} />;
}

function RightsRiskEvidenceView({ quality }: { quality: RightsRiskQualityCheckSnapshot }) {
  const blocked = quality.highRiskDetected || quality.unknownRiskDetected;
  return (
    <div className={`pod-piece-layout-evidence${blocked ? " invalid" : ""}`}>
      {blocked ? <CircleAlert size={12} /> : <FileCheck2 size={12} />}
      <span>
        <b>{blocked ? "侵权风险已阻断" : "侵权风险待人工复核"}</b>
        <small>{quality.depth === "deep" ? "深度检查" : "基础过滤"} · {quality.outputChecks.length} 张素材 · {quality.missingSourceKeys.length} 个缺失源 · 有效至 {new Date(quality.validUntil).toLocaleDateString("zh-CN")}</small>
      </span>
      <span>{quality.outputChecks.map((check) => (
        <code key={check.fileName}>#{check.inputOrdinal + 1} · 法律风险 {rightsRiskLabel(check.legalRisk)} · {Math.round(check.confidence * 100)}% 置信 · {check.evidence.length} 条证据{check.visualSimilarityPermille === undefined ? "" : ` · 视觉相似 ${(check.visualSimilarityPermille / 10).toFixed(1)}%（非法律结论）`}</code>
      ))}</span>
      <small>辅助判断，不是法律意见 · 规则 {quality.ruleVersion} · 模型 {quality.detectorModelKey}@{quality.detectorModelVersion}</small>
    </div>
  );
}

function rightsRiskLabel(value: "unknown" | "low" | "medium" | "high") {
  return { unknown: "未知", low: "低", medium: "中", high: "高" }[value];
}

function PatternProcessingEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = PatternProcessingQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />图案处理未形成完整的输入覆盖、文件属性和 AI 区域证据。</p>
    : null;
  return <PatternProcessingEvidenceView quality={parsed.data} />;
}

function PatternProcessingEvidenceView({ quality }: { quality: PatternProcessingQualityCheckSnapshot }) {
  const generatedCount = quality.outputChecks.reduce((sum, check) => sum + check.generatedRegions.length, 0);
  return (
    <div className="pod-piece-layout-evidence">
      <FileCheck2 size={12} />
      <span>
        <b>图案处理已校验</b>
        <small>{toolKeyLabel(quality.toolKey)} · {quality.outputChecks.length} 张结果 · {generatedCount} 个 AI 区域{generatedCount ? "均已标记" : ""}</small>
      </span>
      <span>{quality.outputChecks.map((check) => (
        <code key={check.fileName}>#{check.inputOrdinal + 1} · {check.format.toUpperCase()} · {check.width}×{check.height}{check.dpi ? ` · ${check.dpi} DPI` : ""}{check.pathCount ? ` · ${check.pathCount} paths` : ""}</code>
      ))}</span>
    </div>
  );
}

function PatternCropEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = PatternCropQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />图案裁剪未形成完整的输入覆盖、裁剪范围和文件映射证据。</p>
    : null;
  return <PatternCropEvidenceView quality={parsed.data} />;
}

function PatternCropEvidenceView({ quality }: { quality: PatternCropQualityCheckSnapshot }) {
  const inputCount = new Set(quality.outputChecks.map((check) => check.inputOrdinal)).size;
  return (
    <div className="pod-piece-layout-evidence">
      <FileCheck2 size={12} />
      <span><b>图案裁剪已校验</b><small>{inputCount} 张输入图 · {quality.outputChecks.length} 个裁剪结果 · 无空白/重复</small></span>
      <span>{quality.outputChecks.map((check) => <code key={check.fileName}>#{check.inputOrdinal + 1}.{check.cropIndex + 1} · {Math.round(check.sourceBounds.width * 100)}%×{Math.round(check.sourceBounds.height * 100)}% · {check.outputWidth}×{check.outputHeight}</code>)}</span>
    </div>
  );
}

function PrintExtractEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = PrintExtractQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />印花图提取未形成完整的校正、完整度和 AI 推断区域证据。</p>
    : null;
  return <PrintExtractEvidenceView quality={parsed.data} />;
}

function PrintExtractEvidenceView({ quality }: { quality: PrintExtractQualityCheckSnapshot }) {
  const inferredCount = quality.outputChecks.reduce((sum, check) => sum + check.inferredRegions.length, 0);
  return (
    <div className="pod-piece-layout-evidence">
      <FileCheck2 size={12} />
      <span><b>印花图提取已校验</b><small>{quality.outputChecks.length} 张结果 · {inferredCount} 个 AI 推断区域{inferredCount ? " · 均已标记" : ""}</small></span>
      <span>{quality.outputChecks.map((check) => <code key={check.fileName}>#{check.inputOrdinal + 1} · {Math.round(check.completeness * 100)}% 完整 · {check.width}×{check.height}{check.transparent ? " · 透明底" : ""}</code>)}</span>
    </div>
  );
}

function ProductVideoEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = ProductVideoQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />商品短视频未形成完整的播放、素材覆盖、字幕与音轨许可证据。</p>
    : null;
  return <ProductVideoEvidenceView quality={parsed.data} />;
}

function ProductVideoEvidenceView({ quality }: { quality: ProductVideoQualityCheckSnapshot }) {
  const output = quality.outputChecks[0];
  return (
    <div className="pod-piece-layout-evidence">
      <FileCheck2 size={12} />
      <span>
        <b>商品短视频已通过检查</b>
        <small>{output.durationSeconds} 秒 · {output.width}×{output.height} · {output.fps} FPS · {output.usedInputOrdinals.length} 张输入图</small>
      </span>
      <span>
        <code>H.264 · {output.audioCodec === "aac" ? "AAC 许可音轨" : "无音轨"}</code>
        <code>安全区 / 字幕 / 空白帧 / 音频均已校验</code>
      </span>
    </div>
  );
}

function UvLayersEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = UvLayersQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />UV 分层未形成可审核的完整通道与冲突证据。</p>
    : null;
  return <UvLayersEvidenceView quality={parsed.data} />;
}

function UvLayersEvidenceView({ quality }: { quality: UvLayersQualityCheckSnapshot }) {
  const conflicted = quality.conflictRegions.length > 0;
  return (
    <div className={`pod-piece-layout-evidence${conflicted ? " invalid" : ""}`}>
      {conflicted ? <CircleAlert size={12} /> : <FileCheck2 size={12} />}
      <span>
        <b>{conflicted ? "UV 冲突待人工处理" : "UV 分层已校验"}</b>
        <small>{quality.layers.length} 个图层 · {quality.conflictRegions.length} 个冲突区域 · {quality.outputChecks.length} 个文件 · {quality.exportReady ? "可进入审核" : "禁止导出"}</small>
      </span>
      <span>{quality.layers.map((layer) => <code key={layer.layerKey}>{String(layer.order).padStart(2, "0")} · {layer.layerKey} · {layer.channel}</code>)}</span>
    </div>
  );
}

function PieceExtractEvidence({ task }: { task: PodArtworkTaskView }) {
  const parsed = PieceExtractQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />裁片提取未形成可审核的完整区域与模板草稿证据。</p>
    : null;
  return <PieceExtractEvidenceView quality={parsed.data} />;
}

function PieceExtractEvidenceView({ quality }: { quality: PieceExtractQualityCheckSnapshot }) {
  return (
    <div className="pod-piece-layout-evidence">
      <FileCheck2 size={12} />
      <span>
        <b>{quality.extractionMode === "separate" ? "分版裁片草稿待确认" : "合版裁片草稿待确认"}</b>
        <small>{quality.regions.length} 个裁片 · {quality.lowConfidencePieceKeys.length} 个低置信度 · {quality.outputChecks.length} 个文件</small>
      </span>
      <span>{quality.regions.map((region) => <code key={region.pieceKey}>{region.pieceKey} · {Math.round(region.confidence * 100)}%{region.manualConfirmationRequired ? " · 需人工确认" : ""}</code>)}</span>
    </div>
  );
}

function PieceLayoutEvidence({ task }: { task: PodArtworkTaskView }) {
  if (task.toolKey !== "piece_compose") return null;
  const parsed = PieceComposeQualityCheckSnapshotSchema.safeParse(task.qualityCheckSnapshot);
  if (!parsed.success) return task.status === "failed"
    ? <p className="pod-piece-layout-evidence invalid"><CircleAlert size={12} />裁片排版未形成可审核的完整质量证据。</p>
    : null;
  return <PieceLayoutEvidenceView quality={parsed.data} />;
}

function PieceLayoutEvidenceView({ quality }: { quality: PieceComposeQualityCheckSnapshot }) {
  return (
    <div className="pod-piece-layout-evidence">
      <FileCheck2 size={12} />
      <span><b>{quality.layoutMode === "automatic" ? "自动排版已校验" : "手动排版已锁定"}</b><small>{quality.placements.length} 个裁片 · {quality.outputChecks.length} 个生产文件 · 无重叠/越界/空白</small></span>
      <span>{quality.placements.map((placement) => <code key={placement.pieceKey}>{placement.pieceKey} · {placement.rotationDegrees}° · {placement.effectiveDpi} DPI</code>)}</span>
    </div>
  );
}

function LoadState({ error }: { error: PodWorkbenchLoadError }) {
  const title = error.kind === "unauthorized"
    ? "作图中心访问未授权"
    : error.kind === "forbidden"
      ? "缺少作图中心权限"
      : "工具目录暂不可用";
  return (
    <div className={`pod-load-state pod-load-state-${error.kind}`} role="alert">
      <CircleAlert size={22} />
      <div><strong>{title}</strong><span>{error.message}</span></div>
    </div>
  );
}

function isModuleKey(value: string | undefined): value is PodModuleKey {
  return canonicalModules.some((module) => module.key === value);
}

function phaseLabel(value: PodPhase) {
  return ({ pod_1: "POD-1", pod_2: "POD-2", pod_3: "POD-3" } as const)[value];
}

function phaseStatus(value: PodPhase) {
  return ({ pod_1: "首期建设", pod_2: "二期规格", pod_3: "三期规格" } as const)[value];
}

function availabilityLabel(value: PodToolAvailability) {
  return ({
    definition_ready: "规格就绪",
    implementation_active: "正在实现",
    enabled: "可用",
    unavailable: "不可用",
  } as const)[value];
}

function assetPolicyLabel(value: PodAssetPolicy) {
  return ({
    authorized_only: "仅授权域",
    risk_evidence_allowed: "授权域与风险证据",
    order_context_only: "仅订单私有域",
  } as const)[value];
}

function inputKindLabel(value: PodToolDefinition["inputKinds"][number]) {
  return ({
    image: "图片",
    text: "文字",
    template: "模板",
    vector: "矢量图",
    psd: "PSD",
    order_customization: "订单定制数据",
  } as const)[value];
}

function outputKindLabel(value: PodToolDefinition["outputKinds"][number]) {
  return ({
    image: "图片",
    text: "文字",
    transparent_image: "透明底图片",
    vector: "矢量图",
    video: "视频",
    template: "模板",
    risk_report: "风险报告",
    production_package: "生产包",
  } as const)[value];
}

function taskStatusLabel(value: PodArtworkTaskView["status"]) {
  return ({
    queued: "排队中",
    running: "处理中",
    awaiting_review: "待审核",
    partially_succeeded: "部分成功",
    failed: "失败",
    blocked: "风险阻断",
    approved: "已批准",
    rejected: "已驳回",
    cancelled: "已取消",
  } as const)[value];
}

function toolKeyLabel(value: PodArtworkTaskView["toolKey"]) {
  return ({
    pattern_crop: "图案裁剪",
    print_extract: "印花图提取",
    background_remove: "一键抠图",
    super_resolution: "超分提质",
    outpaint: "扩图",
    crop_compress: "裁剪压缩",
    vectorize: "转矢量图",
    authorized_watermark_remove: "授权素材去水印",
    rights_risk_scan: "侵权风险检查",
    design_variation: "图裂变",
    product_print_variation: "商品图裂变",
    instruction_edit: "全能改图",
    text_to_image: "文生图",
    element_fusion: "元素融合",
    licensed_brand_fusion: "授权品牌/IP 元素融合",
    series_design: "多联图与系列图",
    style_reference: "风格参考",
    style_transfer: "风格转绘",
    canvas_extend: "尺寸延展",
    seamless_pattern: "连续图",
    seamless_stitch: "连续图拼接",
    print_composite: "印花合成",
    meme_print: "梗图印花",
    product_suite: "商品套图",
    title_draft: "标题草稿",
    virtual_try_on: "模特试衣",
    background_replace: "换背景",
    product_video: "商品短视频",
    piece_extract: "裁片图提取",
    piece_compose: "裁片图合成",
    uv_layers: "UV 智能分层",
  } as const)[value];
}
