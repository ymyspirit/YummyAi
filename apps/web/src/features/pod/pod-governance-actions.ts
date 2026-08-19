"use server";

import {
  ConfirmTemplateSourceInspectionInputSchema,
  ClonePersonalizationTemplateInputSchema,
  CreateTemplateSourceInspectionInputSchema,
  CreatePersonalizationTemplateVersionInputSchema,
  CreateSkuTemplateBindingInputSchema,
  PersonalizationTemplateVersionSchema,
  PersonalizationTemplateSourceInspectionSchema,
  PodReviewDecisionInputSchema,
  ProductionManifestSchema,
  SkuTemplateBindingSchema,
  type CreateTemplateSlotInput,
} from "@yummyai/contracts/pod/personalization";
import { createEntityId } from "@yummyai/contracts/common/ids";
import {
  VisualSearchInputSchema,
  VisualSearchResultSchema,
  type VisualSearchHit,
} from "@yummyai/contracts/pod/visual-search";
import {
  CreateListingArtifactBindingInputSchema,
  ListingArtifactBindingSchema,
} from "@yummyai/contracts/pod/listing-artifacts";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";

export interface PodGovernanceActionState {
  message: string;
  status: "idle" | "success" | "error";
}

export interface PodVisualSearchActionState extends PodGovernanceActionState {
  hits?: VisualSearchHit[];
  queryFingerprintId?: string;
}

export async function createListingArtifactBinding(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const assetSelection = value(formData, "assetSelection");
  const separator = assetSelection.lastIndexOf(":");
  const parsed = CreateListingArtifactBindingInputSchema.safeParse({
    listingVersionId: value(formData, "listingVersionId"),
    assetId: separator > 0 ? assetSelection.slice(0, separator) : "",
    assetVersion: separator > 0 ? Number(assetSelection.slice(separator + 1)) : Number.NaN,
    contentKind: value(formData, "contentKind"),
    slotKey: value(formData, "slotKey"),
  });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Listing 素材槽位参数无效。");
  const result = await post("/v1/pod/listing-artifacts", parsed.data);
  if ("error" in result) return failure(result.error);
  if (!ListingArtifactBindingSchema.safeParse(result.payload).success) {
    return failure("素材槽位已提交，但接口返回格式无效。请刷新后确认。");
  }
  revalidatePath("/pod-workbench");
  return success("已创建 Listing 素材候选；发布前仍需 Listing 审核。");
}

export async function clonePersonalizationTemplate(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const id = value(formData, "id");
  const input = ClonePersonalizationTemplateInputSchema.safeParse({ name: value(formData, "name") });
  if (!id || !input.success) return failure(input.success ? "源模板版本 ID 无效。" : input.error.issues[0]?.message ?? "模板复制参数无效。");
  const result = await post(`/v1/pod/personalization-templates/${encodeURIComponent(id)}/clone`, input.data);
  if ("error" in result) return failure(result.error);
  if (!PersonalizationTemplateVersionSchema.safeParse(result.payload).success) {
    return failure("模板已复制，但接口返回格式无效。请刷新后确认。");
  }
  revalidatePath("/pod-workbench");
  return success("已复制为独立草稿。后续编辑、审核和绑定不会影响源模板。");
}

export async function runPodVisualSearch(
  _previous: PodVisualSearchActionState,
  formData: FormData,
): Promise<PodVisualSearchActionState> {
  const assetVersion = Number(value(formData, "assetVersion"));
  const maxHammingDistance = Number(value(formData, "maxHammingDistance"));
  const limit = Number(value(formData, "limit"));
  const parsed = VisualSearchInputSchema.safeParse({
    assetId: value(formData, "assetId"),
    assetVersion,
    domain: value(formData, "domain") || "all",
    maxHammingDistance,
    limit,
  });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "视觉检索参数无效。");
  const result = await post("/v1/pod/visual-search", parsed.data);
  if ("error" in result) return failure(result.error);
  const response = VisualSearchResultSchema.safeParse(result.payload);
  if (!response.success) return failure("视觉检索接口返回格式无效。");
  return {
    status: "success",
    message: response.data.hits.length ? `找到 ${response.data.hits.length} 个相似资产版本。` : "未找到符合阈值的相似资产。",
    hits: response.data.hits,
    queryFingerprintId: response.data.queryFingerprintId,
  };
}

export async function createBlankPersonalizationTemplate(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const primary = templateSlot(formData, "primary", true);
  if ("error" in primary) return failure(primary.error);
  const secondary = templateSlot(formData, "secondary", false);
  if ("error" in secondary) return failure(secondary.error);
  const caption = templateSlot(formData, "caption", false);
  if ("error" in caption) return failure(caption.error);
  const width = boundedNumber(formData, "canvasWidth", 1, 100_000, true);
  const height = boundedNumber(formData, "canvasHeight", 1, 100_000, true);
  const dpi = boundedNumber(formData, "canvasDpi", 36, 2_400, true);
  if (width === undefined || height === undefined || dpi === undefined) {
    return failure("画布尺寸或 DPI 超出允许范围。");
  }
  const slots = [primary.slot, secondary.slot, caption.slot].filter(
    (slot): slot is CreateTemplateSlotInput => Boolean(slot),
  );
  const parsed = CreatePersonalizationTemplateVersionInputSchema.safeParse({
    name: value(formData, "name"),
    source: "blank",
    canvas: {
      width,
      height,
      dpi,
      colorMode: value(formData, "colorMode") || "rgb",
      background: value(formData, "background") || undefined,
    },
    slots,
  });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "模板参数无效。");
  const result = await post("/v1/pod/personalization-templates", parsed.data);
  if ("error" in result) return failure(result.error);
  if (!PersonalizationTemplateVersionSchema.safeParse(result.payload).success) {
    return failure("模板已提交，但接口返回格式无效。请刷新后确认。");
  }
  revalidatePath("/pod-workbench");
  return success("模板版本已创建，批准前不会绑定 SKU 或进入生产。");
}

export async function createTemplateSourceInspection(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const selection = value(formData, "sourceAsset");
  const separator = selection.lastIndexOf(":");
  const parsed = CreateTemplateSourceInspectionInputSchema.safeParse({
    sourceAssetId: separator > 0 ? selection.slice(0, separator) : "",
    sourceAssetVersion: separator > 0 ? Number(selection.slice(separator + 1)) : Number.NaN,
    idempotencyKey: createEntityId(),
  });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "模板源文件无效。");
  const result = await post("/v1/pod/personalization-template-source-inspections", parsed.data);
  if ("error" in result) return failure(result.error);
  if (!PersonalizationTemplateSourceInspectionSchema.safeParse(result.payload).success) {
    return failure("解析任务已提交，但接口返回格式无效。请刷新后确认。");
  }
  revalidatePath("/pod-workbench");
  return success("解析任务已创建。页面会自动刷新任务状态，完成后请确认四类槽位。");
}

export async function confirmTemplateSourceInspection(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const inspectionId = value(formData, "inspectionId");
  const slotCount = Number(value(formData, "slotCount"));
  if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 500) return failure("槽位数量无效。");
  const slots = Array.from({ length: slotCount }, (_, index) => ({
    stableKey: value(formData, `slot.${index}.stableKey`),
    name: value(formData, `slot.${index}.name`),
    kind: value(formData, `slot.${index}.kind`),
    fillMode: value(formData, `slot.${index}.fillMode`),
    replaceable: formData.has(`slot.${index}.replaceable`),
    reuseLabel: value(formData, `slot.${index}.reuseLabel`) || undefined,
  }));
  const parsed = ConfirmTemplateSourceInspectionInputSchema.safeParse({
    name: value(formData, "name"),
    acknowledgeWarnings: formData.has("acknowledgeWarnings"),
    slots,
  });
  if (!inspectionId || !parsed.success) return failure(parsed.success ? "解析任务 ID 无效。" : parsed.error.issues[0]?.message ?? "槽位确认参数无效。");
  const result = await post(`/v1/pod/personalization-template-source-inspections/${encodeURIComponent(inspectionId)}/confirm`, parsed.data);
  if ("error" in result) return failure(result.error);
  if (!PersonalizationTemplateVersionSchema.safeParse(result.payload).success) {
    return failure("模板确认已提交，但接口返回格式无效。请刷新后确认。");
  }
  revalidatePath("/pod-workbench");
  return success("不可变模板版本已创建；批准后可绑定 SKU 与尺寸。");
}

export async function reviewPersonalizationTemplate(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const id = value(formData, "id");
  const decision = PodReviewDecisionInputSchema.safeParse({
    decision: value(formData, "decision"),
    reason: value(formData, "reason") || undefined,
  });
  if (!id || !decision.success) return failure(decision.success ? "模板版本 ID 无效。" : decision.error.issues[0]?.message ?? "审核参数无效。");
  const result = await post(`/v1/pod/personalization-templates/${encodeURIComponent(id)}/review`, decision.data);
  if ("error" in result) return failure(result.error);
  if (!PersonalizationTemplateVersionSchema.safeParse(result.payload).success) return failure("审核已提交，但接口返回格式无效。");
  revalidatePath("/pod-workbench");
  return success(decision.data.decision === "approve" ? "模板版本已批准。" : "模板版本已驳回。");
}

export async function createSkuTemplateBinding(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const slotFieldMap: Record<string, string> = {};
  for (const [key, entry] of formData.entries()) {
    if (!key.startsWith("slotField.") || typeof entry !== "string" || !entry.trim()) continue;
    slotFieldMap[key.slice("slotField.".length)] = entry.trim();
  }
  const parsed = CreateSkuTemplateBindingInputSchema.safeParse({
    skuId: value(formData, "skuId"),
    templateVersionId: value(formData, "templateVersionId"),
    sizeLabel: value(formData, "sizeLabel"),
    mappingSnapshot: { slotFieldMap },
    effectiveFrom: value(formData, "effectiveFrom") || new Date().toISOString(),
  });
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "SKU 模板绑定参数无效。");
  const result = await post("/v1/pod/template-bindings", parsed.data);
  if ("error" in result) return failure(result.error);
  if (!SkuTemplateBindingSchema.safeParse(result.payload).success) return failure("绑定已提交，但接口返回格式无效。");
  revalidatePath("/pod-workbench");
  return success("SKU、尺寸与模板版本已显式绑定。");
}

export async function reviewProductionManifest(
  _previous: PodGovernanceActionState,
  formData: FormData,
): Promise<PodGovernanceActionState> {
  const id = value(formData, "id");
  const decision = PodReviewDecisionInputSchema.safeParse({
    decision: value(formData, "decision"),
    reason: value(formData, "reason") || undefined,
  });
  if (!id || !decision.success) return failure(decision.success ? "生产清单 ID 无效。" : decision.error.issues[0]?.message ?? "审核参数无效。");
  const result = await post(`/v1/pod/production-manifests/${encodeURIComponent(id)}/review`, decision.data);
  if ("error" in result) return failure(result.error);
  if (!ProductionManifestSchema.safeParse(result.payload).success) return failure("审核已提交，但接口返回格式无效。");
  revalidatePath("/pod-workbench");
  return success(decision.data.decision === "approve" ? "生产清单已锁定批准。" : "生产清单已驳回。");
}

function templateSlot(
  formData: FormData,
  prefix: "primary" | "secondary" | "caption",
  required: boolean,
): { slot?: CreateTemplateSlotInput } | { error: string } {
  const stableKey = value(formData, `${prefix}StableKey`);
  if (!stableKey && !required) return {};
  const name = value(formData, `${prefix}Name`);
  const kind = prefix === "caption" ? "text" as const : "image" as const;
  const x = boundedNumber(formData, `${prefix}X`, -100_000, 100_000, required);
  const y = boundedNumber(formData, `${prefix}Y`, -100_000, 100_000, required);
  const width = boundedNumber(formData, `${prefix}Width`, 0.01, 100_000, required);
  const height = boundedNumber(formData, `${prefix}Height`, 0.01, 100_000, required);
  if (!stableKey || !name || x === undefined || y === undefined || width === undefined || height === undefined) {
    return { error: `${prefix === "primary" ? "主图片" : prefix === "secondary" ? "复用图片" : "文字"}槽位参数不完整。` };
  }
  return {
    slot: {
      stableKey,
      name,
      kind,
      geometry: { x, y, width, height, rotationDegrees: 0 },
      fillMode: kind === "image" ? "cover" : "none",
      validationSnapshot: kind === "image" ? { required: required || undefined } : { maxLength: 80 },
      replaceable: true,
    },
  };
}

async function post(path: string, body: unknown): Promise<{ payload: unknown } | { error: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { error: "API_BASE_URL 未配置。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return { error: messageFrom(payload) ?? `请求失败 (${response.status})。` };
    return { payload };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "请求失败。" };
  }
}

function boundedNumber(formData: FormData, name: string, minimum: number, maximum: number, required: boolean) {
  const raw = value(formData, name);
  if (!raw && !required) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function value(formData: FormData, name: string) {
  const entry = formData.get(name);
  return typeof entry === "string" ? entry.trim() : "";
}

function messageFrom(payload: Record<string, unknown> | undefined) {
  for (const key of ["detail", "message", "title"]) if (typeof payload?.[key] === "string") return payload[key];
  return undefined;
}

function failure(message: string): PodGovernanceActionState {
  return { message, status: "error" };
}

function success(message: string): PodGovernanceActionState {
  return { message, status: "success" };
}
