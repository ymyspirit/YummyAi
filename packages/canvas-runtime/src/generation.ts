import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { AiTextMessage } from "@/services/api/image";
import type { VideoGenerationTask, VideoGenerationTaskState } from "@/services/api/video";
import { decodeBlob } from "./storage";
import { notify, rpc } from "./rpc";
import { assertStudioModelsReady } from "./model-state";
type Result = { id: string; status: string; key?: string; error?: string; text?: string; contentBase64?: string; mediaType?: string; reviewError?: string };
function modelId(config: AiConfig, capability: "image" | "video" | "text") {
  const value = config.model || config[`${capability}Model`];
  const id = value.split("::")[0];
  if (!id || !config.channels.some(channel => channel.id === id && channel.models.some(model => model.capability === capability))) throw new Error("请先在 ERP 配置中启用相应用途的模型");
  return id;
}
async function submit(config: AiConfig, prompt: string, refs: ReferenceImage[], capability: "image" | "video" | "text") {
  assertStudioModelsReady();
  if (refs.some(ref => !ref.storageKey)) throw new Error("请先将参考图上传到项目素材，并完成权利审核");
  const background = ["transparent", "opaque"].includes(config.background) ? config.background : "auto";
  const quality = ["low", "medium", "high"].includes(config.quality) ? config.quality : "auto";
  return rpc<{ id: string }>({ operation: "generate", input: {
    requestId: crypto.randomUUID(), modelId: modelId(config, capability), prompt: [config.systemPrompt, prompt].filter(Boolean).join("\n\n"),
    referenceKeys: refs.map(ref => ref.storageKey), size: config.size || (capability === "video" ? "16:9" : "1:1"),
    quality, background, seconds: Number(config.videoSeconds) || 4,
  } });
}
function resultError(result: Result) {
  const errors: Record<string, string> = {
    studio_submission_interrupted: "生成提交中断。请先核对渠道任务或账单，再决定是否重新生成。",
    studio_reference_changed: "参考素材的审核或版本已变化，请重新选择。",
    studio_provider_requires_base64_result: "渠道未返回图片文件，请检查是否支持 b64_json 图片响应。",
    studio_result_too_large: "生成文件超过 20 MiB，结果未入库。",
    studio_provider_http_401: "模型渠道认证失败，请在 ERP 配置中更新凭据。",
    studio_provider_http_429: "模型渠道请求受限，请稍后再试。",
  };
  return errors[result.error ?? ""] ?? "生成失败，请检查 ERP 的模型配置与渠道状态。任务记录已保留。";
}
async function wait(id: string, options?: { signal?: AbortSignal }): Promise<Result> {
  for (let attempt = 0; attempt < 480; attempt++) {
    if (options?.signal?.aborted) throw new Error("已停止等待，已提交任务可在 ERP 的生成任务中查看");
    const result = await rpc<Result>({ operation: "generation.get", id });
    if (result.status === "failed") throw new Error(resultError(result));
    if (result.status === "completed") { if (result.reviewError) notify("studio.error", { error: result.reviewError }); return result; }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw new Error("任务仍在服务端执行，可在生成任务中继续查看");
}
export async function studioImages(config: AiConfig, prompt: string, refs: ReferenceImage[], options?: { signal?: AbortSignal }) {
  const count = Math.max(1, Math.floor(Number(config.count) || 1));
  if (count > 4) throw new Error("每次最多生成 4 张图片，请调整数量");
  const images: Array<{ id: string; dataUrl: string }> = [];
  for (let index = 0; index < count; index++) {
    if (options?.signal?.aborted) throw new Error("已停止提交后续图片");
    const created = await submit(config, prompt, refs, "image");
    const result = await wait(created.id, options);
    if (!result.contentBase64 || !result.mediaType?.startsWith("image/")) throw new Error("生成任务没有返回图片");
    images.push({ id: created.id, dataUrl: `data:${result.mediaType};base64,${result.contentBase64}` });
  }
  return images;
}
export async function studioText(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: { signal?: AbortSignal }) {
  if (messages.some(message => typeof message.content !== "string")) throw new Error("当前文字模型接入只支持文字内容，图片请使用生图或编辑节点");
  const created = await submit(config, messages.map(message => `${message.role}: ${message.content}`).join("\n"), [], "text");
  const result = await wait(created.id, options);
  if (!result.text) throw new Error("模型没有返回文字");
  onDelta(result.text); return result.text;
}
export async function studioVideo(config: AiConfig, prompt: string, refs: ReferenceImage[], options?: { videos?: unknown[]; audios?: unknown[] }): Promise<VideoGenerationTask> {
  if (options?.videos?.length || options?.audios?.length) throw new Error("当前视频接口支持文字与单张首帧参考图；音视频参考暂未接入");
  const result = await submit(config, prompt, refs, "video");
  return { id: result.id, model: config.model || config.videoModel, provider: "openai" };
}
export async function pollStudioVideo(task: VideoGenerationTask): Promise<VideoGenerationTaskState> {
  const result = await rpc<Result>({ operation: "generation.get", id: task.id });
  if (result.status === "failed") return { status: "failed", error: resultError(result) };
  if (result.status !== "completed") return { status: "pending" };
  if (!result.contentBase64 || !result.mediaType) return { status: "failed", error: "任务没有返回视频文件" };
  return { status: "completed", result: { blob: decodeBlob({ contentBase64: result.contentBase64, mediaType: result.mediaType }), mimeType: result.mediaType } };
}
