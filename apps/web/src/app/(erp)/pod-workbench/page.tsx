import {
  OrderPersonalizationBatchListSchema,
  OrderPersonalizationOptionsViewSchema,
  OrderPersonalizationRenderTaskListSchema,
  type OrderPersonalizationBatch,
  type OrderPersonalizationOptionsView,
  type OrderPersonalizationRenderTask,
} from "@yummyai/contracts/pod/order-personalization";
import {
  PodArtworkTaskListViewSchema,
  PodExecutableToolKeySchema,
  PodExportListViewSchema,
  PodTaskInputOptionsViewSchema,
  PodToolCatalogViewSchema,
  type PodArtworkTaskView,
  type PodExportView,
  type PodTaskInputOptionsView,
  type PodToolCatalogView,
} from "@yummyai/contracts/pod";
import {
  PersonalizationTemplateVersionListSchema,
  PersonalizationTemplateSourceInspectionListSchema,
  PodPersonalizationOptionsViewSchema,
  ProductionManifestListSchema,
  type PersonalizationTemplateVersion,
  type PersonalizationTemplateSourceInspection,
  type PodPersonalizationOptionsView,
  type ProductionManifest,
} from "@yummyai/contracts/pod/personalization";
import {
  PodListingArtifactOptionsViewSchema,
  type PodListingArtifactOptionsView,
} from "@yummyai/contracts/pod/listing-artifacts";

import { ErpSidebar } from "../../../features/navigation/erp-sidebar";
import {
  PodWorkbench,
  type PodWorkbenchLoadError,
} from "../../../features/pod/pod-workbench";
import { apiFetch } from "../../../server-api";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PodWorkbenchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const moduleKey = typeof params.module === "string" ? params.module : undefined;
  const requestedTool = typeof params.tool === "string" ? params.tool : undefined;
  const result = await loadToolCatalog();
  const catalog = result.catalog;
  const taskResult = catalog ? await loadTasks() : undefined;
  const exportResult = taskResult && "items" in taskResult
    ? await loadTaskExports(taskResult.items)
    : undefined;
  const orderRenderTool = requestedTool === "image_composite"
    || requestedTool === "group_photo"
    || requestedTool === "pet_outfit"
    || requestedTool === "fulfillment_composite"
    || requestedTool === "vector_fulfillment";
  const inputOptions = catalog && requestedTool && !orderRenderTool
    ? await loadInputOptions(catalog, requestedTool)
    : undefined;
  const personalizationResult = catalog && moduleKey === "personalization"
    ? await loadPersonalizationConsole()
    : undefined;
  const productionResult = catalog && moduleKey === "production_artwork"
    ? await loadProductionManifests()
    : undefined;
  const orderPersonalizationResult = catalog && (moduleKey === "personalization" || moduleKey === "production_artwork")
    ? await loadOrderPersonalizationConsole()
    : undefined;
  const rightsResult = catalog && moduleKey === "rights_risk"
    ? await loadRiskOptions()
    : undefined;
  const listingResult = catalog && moduleKey === "listing_assets"
    ? await loadListingOptions()
    : undefined;
  return (
    <div className="research-shell pod-shell">
      <ErpSidebar
        active="pod-workbench"
        contextLabel="POD OPS"
        note="面向 Amazon 与 Etsy；生成和生产只使用授权资产或订单私有域素材。"
      />
      <main className="research-main pod-main">
        <PodWorkbench
          {...(catalog ? { catalog } : { error: result.error })}
          {...(inputOptions && "data" in inputOptions ? { inputOptions: inputOptions.data } : {})}
          configurationError={inputOptions && "error" in inputOptions ? inputOptions.error : undefined}
          requestedModule={moduleKey}
          requestedTool={requestedTool}
          personalizationError={personalizationResult && "error" in personalizationResult ? personalizationResult.error : undefined}
          personalizationOptions={personalizationResult && "data" in personalizationResult ? personalizationResult.data.options : undefined}
          personalizationInspections={personalizationResult && "data" in personalizationResult ? personalizationResult.data.inspections : []}
          personalizationTemplates={personalizationResult && "data" in personalizationResult ? personalizationResult.data.templates : []}
          orderPersonalizationBatches={orderPersonalizationResult && "data" in orderPersonalizationResult ? orderPersonalizationResult.data.batches : []}
          orderPersonalizationError={orderPersonalizationResult && "error" in orderPersonalizationResult ? orderPersonalizationResult.error : undefined}
          orderPersonalizationOptions={orderPersonalizationResult && "data" in orderPersonalizationResult ? orderPersonalizationResult.data.options : undefined}
          orderPersonalizationRenderTasks={orderPersonalizationResult && "data" in orderPersonalizationResult ? orderPersonalizationResult.data.renderTasks : []}
          productionError={productionResult && "error" in productionResult ? productionResult.error : undefined}
          productionManifests={productionResult && "items" in productionResult ? productionResult.items : []}
          rightsError={rightsResult && "error" in rightsResult ? rightsResult.error : undefined}
          rightsOptions={rightsResult && "data" in rightsResult ? rightsResult.data : undefined}
          listingError={listingResult && "error" in listingResult ? listingResult.error : undefined}
          listingOptions={listingResult && "data" in listingResult ? listingResult.data : undefined}
          taskError={taskResult && "error" in taskResult ? taskResult.error : undefined}
          tasks={taskResult && "items" in taskResult ? taskResult.items : []}
          exportError={exportResult && "error" in exportResult ? exportResult.error : undefined}
          exportsByTask={exportResult && "data" in exportResult ? exportResult.data : {}}
        />
      </main>
    </div>
  );
}

async function loadOrderPersonalizationConsole(): Promise<
  | { data: { options: OrderPersonalizationOptionsView; batches: OrderPersonalizationBatch[]; renderTasks: OrderPersonalizationRenderTask[] } }
  | { error: string }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  const base = apiBase.replace(/\/$/, "");
  try {
    const [optionsResponse, batchesResponse, renderTasksResponse] = await Promise.all([
      apiFetch(`${base}/v1/pod/order-personalization-batches/options`, { cache: "no-store" }),
      apiFetch(`${base}/v1/pod/order-personalization-batches`, { cache: "no-store" }),
      apiFetch(`${base}/v1/pod/order-personalization-render-tasks`, { cache: "no-store" }),
    ]);
    if (!optionsResponse.ok) return { error: `订单定制候选项读取失败 (${optionsResponse.status})。` };
    if (!batchesResponse.ok) return { error: `订单定制批次读取失败 (${batchesResponse.status})。` };
    if (!renderTasksResponse.ok) return { error: `订单渲染任务读取失败 (${renderTasksResponse.status})。` };
    return {
      data: {
        options: OrderPersonalizationOptionsViewSchema.parse(await optionsResponse.json()),
        batches: OrderPersonalizationBatchListSchema.parse(await batchesResponse.json()).items,
        renderTasks: OrderPersonalizationRenderTaskListSchema.parse(await renderTasksResponse.json()).items,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "订单个性化控制台读取失败。" };
  }
}

async function loadListingOptions(): Promise<{ data: PodListingArtifactOptionsView } | { error: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/listing-options`, { cache: "no-store" });
    if (!response.ok) return { error: `Listing 素材选项读取失败 (${response.status})。` };
    return { data: PodListingArtifactOptionsViewSchema.parse(await response.json()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Listing 素材选项读取失败。" };
  }
}

async function loadRiskOptions(): Promise<{ data: PodTaskInputOptionsView } | { error: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/input-options/rights_risk_scan`, { cache: "no-store" });
    if (!response.ok) return { error: `风险检索素材读取失败 (${response.status})。` };
    return { data: PodTaskInputOptionsViewSchema.parse(await response.json()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "风险检索素材读取失败。" };
  }
}

async function loadPersonalizationConsole(): Promise<
  | { data: { templates: PersonalizationTemplateVersion[]; inspections: PersonalizationTemplateSourceInspection[]; options: PodPersonalizationOptionsView } }
  | { error: string }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  try {
    const [templatesResponse, inspectionsResponse, optionsResponse] = await Promise.all([
      apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/personalization-templates`, { cache: "no-store" }),
      apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/personalization-template-source-inspections`, { cache: "no-store" }),
      apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/personalization-options`, { cache: "no-store" }),
    ]);
    if (!templatesResponse.ok) return { error: `模板版本读取失败 (${templatesResponse.status})。` };
    if (!inspectionsResponse.ok) return { error: `模板导入检查读取失败 (${inspectionsResponse.status})。` };
    if (!optionsResponse.ok) return { error: `模板选项读取失败 (${optionsResponse.status})。` };
    return {
      data: {
        templates: PersonalizationTemplateVersionListSchema.parse(await templatesResponse.json()).items,
        inspections: PersonalizationTemplateSourceInspectionListSchema.parse(await inspectionsResponse.json()).items,
        options: PodPersonalizationOptionsViewSchema.parse(await optionsResponse.json()),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "来图定制控制台读取失败。" };
  }
}

async function loadProductionManifests(): Promise<{ items: ProductionManifest[] } | { error: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/production-manifests`, { cache: "no-store" });
    if (!response.ok) return { error: `生产清单读取失败 (${response.status})。` };
    return ProductionManifestListSchema.parse(await response.json());
  } catch (error) {
    return { error: error instanceof Error ? error.message : "生产清单读取失败。" };
  }
}

async function loadTaskExports(
  tasks: PodArtworkTaskView[],
): Promise<{ data: Record<string, PodExportView[]> } | { error: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  const approved = tasks.filter((task) => task.status === "approved").slice(0, 8);
  try {
    const results = await Promise.all(approved.map(async (task) => {
      const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/tasks/${task.id}/exports`, { cache: "no-store" });
      if (!response.ok) throw new Error(`导出状态读取失败 (${response.status})。`);
      const parsed = PodExportListViewSchema.parse(await response.json());
      return [task.id, [...parsed.items].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))] as const;
    }));
    return { data: Object.fromEntries(results) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "导出状态读取失败。" };
  }
}

async function loadTasks(): Promise<{ items: PodArtworkTaskView[] } | { error: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/tasks`, { cache: "no-store" });
    if (!response.ok) return { error: `任务中心读取失败 (${response.status})。` };
    return PodArtworkTaskListViewSchema.parse(await response.json());
  } catch (error) {
    return { error: error instanceof Error ? error.message : "任务中心读取失败。" };
  }
}

async function loadInputOptions(
  catalog: PodToolCatalogView,
  requestedTool: string,
): Promise<{ data: PodTaskInputOptionsView } | { error: string }> {
  const parsed = PodExecutableToolKeySchema.safeParse(requestedTool);
  if (!parsed.success) return { error: "所选工具尚未接入可执行任务链路。" };
  const tool = catalog.tools.find((item) => item.key === parsed.data);
  if (!tool || tool.availability !== "enabled") return { error: "所选工具尚未开放任务创建。" };
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "尚未配置作图中心 API。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/input-options/${parsed.data}`, { cache: "no-store" });
    if (!response.ok) return { error: `任务输入选项读取失败 (${response.status})。` };
    return { data: PodTaskInputOptionsViewSchema.parse(await response.json()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "任务输入选项读取失败。" };
  }
}

async function loadToolCatalog(): Promise<
  | { catalog: PodToolCatalogView; error?: never }
  | { catalog?: never; error: PodWorkbenchLoadError }
> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: { kind: "failed", message: "尚未配置作图中心 API。" } };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/tools`, { cache: "no-store" });
    if (response.status === 401) {
      return { error: { kind: "unauthorized", message: "身份会话无效，请重新登录本地身份服务。" } };
    }
    if (response.status === 403) {
      return { error: { kind: "forbidden", message: "当前成员没有 design:read 权限。" } };
    }
    if (!response.ok) {
      return { error: { kind: "failed", message: `工具目录读取失败 (${response.status})。` } };
    }
    return { catalog: PodToolCatalogViewSchema.parse(await response.json()) };
  } catch (error) {
    return {
      error: {
        kind: "failed",
        message: error instanceof Error ? error.message : "工具目录读取失败。",
      },
    };
  }
}
