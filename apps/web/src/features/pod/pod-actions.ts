"use server";

import { createEntityId } from "@yummyai/contracts/common/ids";
import {
  CreatePodArtworkTaskInputSchema,
  PodArtworkTaskViewSchema,
  PodExecutableToolKeySchema,
} from "@yummyai/contracts/pod";
import { revalidatePath } from "next/cache";

import { apiFetch } from "../../server-api";
import { parsePodTaskParameters as parameters, podFormValue as value } from "./pod-task-parameters";

export interface PodActionState {
  message: string;
  status: "idle" | "success" | "error";
  taskId?: string;
}

export async function createPodArtworkTask(
  _previous: PodActionState,
  formData: FormData,
): Promise<PodActionState> {
  const toolResult = PodExecutableToolKeySchema.safeParse(value(formData, "toolKey"));
  if (!toolResult.success) return failure("请选择有效的 POD 工具。");
  const assetIds = formData.getAll("inputAssetIds").filter((entry): entry is string => typeof entry === "string");
  const parameterResult = parameters(toolResult.data, formData);
  if ("error" in parameterResult) return failure(parameterResult.error);
  const parsed = CreatePodArtworkTaskInputSchema.safeParse({
    idempotencyKey: createEntityId(),
    skuId: value(formData, "skuId"),
    toolKey: toolResult.data,
    title: value(formData, "title"),
    inputAssetIds: assetIds,
    parameterSnapshot: parameterResult.values,
  });
  if (!parsed.success) {
    const pieceKeyIssue = toolResult.data === "piece_compose" && parsed.error.issues.some(
      (issue) => issue.path.includes("pieceKeys"),
    );
    const extractSourceIssue = toolResult.data === "piece_extract" && parsed.error.issues.some(
      (issue) => issue.path.includes("inputAssetIds"),
    );
    const extractDefinitionIssue = toolResult.data === "piece_extract" && parsed.error.issues.some(
      (issue) => issue.path.includes("pieceDefinitions"),
    );
    const extractModeIssue = toolResult.data === "piece_extract" && parsed.error.issues.some(
      (issue) => issue.path.includes("boundarySource")
        || issue.path.includes("outputFormat")
        || issue.path.includes("preserveTransparency"),
    );
    const uvSourceIssue = toolResult.data === "uv_layers" && parsed.error.issues.some(
      (issue) => issue.path.includes("inputAssetIds"),
    );
    const uvPlanIssue = toolResult.data === "uv_layers" && parsed.error.issues.some(
      (issue) => issue.path.includes("layerDefinitions")
        || issue.path.includes("whiteInkLayer")
        || issue.path.includes("varnishLayer"),
    );
    const videoSourceIssue = toolResult.data === "product_video" && parsed.error.issues.some(
      (issue) => issue.path.includes("inputAssetIds"),
    );
    const videoPlanIssue = toolResult.data === "product_video" && parsed.error.issues.some(
      (issue) => issue.path.includes("parameterSnapshot"),
    );
    const printExtractionIssue = (toolResult.data === "pattern_crop" || toolResult.data === "print_extract")
      && parsed.error.issues.some((issue) => issue.path.includes("parameterSnapshot") || issue.path.includes("inputAssetIds"));
    const patternProcessingIssue = [
      "background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize", "authorized_watermark_remove",
    ].includes(toolResult.data) && parsed.error.issues.some(
      (issue) => issue.path.includes("parameterSnapshot") || issue.path.includes("inputAssetIds"),
    );
    const rightsRiskIssue = toolResult.data === "rights_risk_scan" && parsed.error.issues.some(
      (issue) => issue.path.includes("parameterSnapshot") || issue.path.includes("inputAssetIds"),
    );
    const creativeDesignIssue = [
      "design_variation", "product_print_variation", "instruction_edit", "text_to_image", "element_fusion",
      "licensed_brand_fusion", "series_design", "style_reference", "style_transfer", "canvas_extend",
      "seamless_pattern", "seamless_stitch", "print_composite", "meme_print",
    ].includes(toolResult.data) && parsed.error.issues.some(
      (issue) => issue.path.includes("parameterSnapshot") || issue.path.includes("inputAssetIds"),
    );
    const listingAssetIssue = ["product_suite", "title_draft", "virtual_try_on", "background_replace"].includes(toolResult.data)
      && parsed.error.issues.some((issue) => issue.path.includes("parameterSnapshot") || issue.path.includes("inputAssetIds"));
    return failure(
      pieceKeyIssue
        ? "每个已选素材必须按相同顺序填写一个唯一裁片键。"
        : extractSourceIssue
          ? "裁片提取每次必须且只能选择一份源图片或模板。"
          : extractDefinitionIssue
            ? "每个裁片定义必须使用“稳定键|名称|角度|翻转”，且稳定键不能重复。"
            : extractModeIssue
              ? "分版必须使用透明通道并输出透明 PNG/TIFF；合版必须使用深色裁片线，JPEG 不能保留透明通道。"
              : uvSourceIssue
                ? "UV 分层每次必须且只能选择一份源图片或模板。"
                : uvPlanIssue
                  ? "每个 UV 图层定义必须使用“稳定键|名称|通道|顺序|透明度”，键与顺序不能重复，白墨/光油开关必须与定义一致。"
                  : videoSourceIssue
                    ? "商品短视频必须选择 1 到 20 张已授权商品图片。"
                    : videoPlanIssue
                      ? "商品短视频参数不完整，请检查画幅、分辨率、帧率、字幕、音轨许可和 AI 运动声明。"
                      : printExtractionIssue
                        ? "印花提取参数不完整：透明底必须使用 PNG；单图裁剪只能设置 1 个结果，且每次需选择 1–100 张授权图片。"
                        : patternProcessingIssue
                          ? "图案处理参数不完整：请检查输出格式、尺寸、透明通道和 AI 标记，并选择 1–100 张授权图片。"
                          : rightsRiskIssue
                            ? "侵权检查参数不完整：请选择平台、1–90 天有效期和 1–100 张素材；每条补充检查词不得超过 240 字。"
                            : creativeDesignIssue
                              ? "印花设计参数不完整：请检查提示词、参考强度、创意程度、比例、数量、连续图设置和许可证明。"
                              : listingAssetIssue
                                ? "套图与标题参数不完整：请检查平台、语言、数量、商品事实、模特许可或主体保持设置。"
                                : parsed.error.issues[0]?.message ?? "POD 任务参数无效。",
    );
  }
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return failure("API_BASE_URL 未配置。");
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/pod/tasks`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) return failure(messageFrom(payload) ?? `POD 任务创建失败 (${response.status})。`);
    const task = PodArtworkTaskViewSchema.safeParse(payload);
    if (!task.success) return failure("任务已提交，但接口返回格式无效。请刷新任务中心确认。");
    revalidatePath("/pod-workbench");
    revalidatePath("/design");
    return { status: "success", message: "任务已进入异步队列。", taskId: task.data.id };
  } catch (error) {
    return failure(error instanceof Error ? error.message : "POD 任务创建失败。");
  }
}

function messageFrom(payload: Record<string, unknown> | undefined) {
  for (const key of ["detail", "message", "title"]) if (typeof payload?.[key] === "string") return payload[key];
  return undefined;
}

function failure(message: string): PodActionState {
  return { message, status: "error" };
}
