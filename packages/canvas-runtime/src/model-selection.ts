import { StudioModelSchema, type StudioModel } from "@yummyai/contracts/pod/studio-personal";
import type { AiConfig, ModelCapability } from "@/stores/use-config-store";
import type { WorkbenchDraftDocument } from "./workbench-draft";

export const STUDIO_RUNTIME_MODELS = Symbol("studio-runtime-models");
type RuntimeConfig = AiConfig & { [STUDIO_RUNTIME_MODELS]?: string };
export type ModelCatalogueState = { owner: string; status: "loading" | "ready" | "error" | "unavailable"; error: string; models: StudioModel[] };
export const modelToken = (model: StudioModel) => `${model.id}::${model.model}`;
export const isStudioRuntimeConfig = (config: AiConfig) => typeof (config as RuntimeConfig)[STUDIO_RUNTIME_MODELS] === "string";
const capabilityNames: Record<ModelCapability, string> = { image: "图片", video: "视频", text: "文字", audio: "音频" };

export function createStudioModelCatalogue() {
  let state: ModelCatalogueState = { owner: "", status: "unavailable", error: "模型归属尚未核对", models: [] }, epoch = 0;
  let active: { controller: AbortController; promise: Promise<StudioModel[] | undefined> } | undefined;
  const listeners = new Set<() => void>();
  const publish = (value: ModelCatalogueState) => { state = value; for (const listener of listeners) listener(); };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure(owner: string) {
      if (owner === state.owner) return false;
      epoch++; active?.controller.abort(); active = undefined;
      publish({ owner, status: owner ? "loading" : "unavailable", error: owner ? "" : "模型归属尚未核对", models: [] }); return true;
    },
    load(read: (signal: AbortSignal) => Promise<unknown>): Promise<StudioModel[] | undefined> {
      if (!state.owner) return Promise.resolve(undefined);
      if (active) return active.promise;
      const owner = state.owner, captured = ++epoch, controller = new AbortController();
      const request = { controller, promise: Promise.resolve<StudioModel[] | undefined>(undefined) }; active = request;
      const current = () => owner === state.owner && captured === epoch && !controller.signal.aborted;
      publish({ owner, status: "loading", error: "", models: [] });
      request.promise = (async () => {
        try {
          const raw = await read(controller.signal); if (!current()) return;
          const models = StudioModelSchema.array().max(1000).parse(raw);
          if (new Set(models.map(model => model.id)).size !== models.length) throw new Error("模型目录包含重复标识 请重新读取");
          publish({ owner, status: "ready", error: "", models }); return current() ? models : undefined;
        } catch (cause) {
          if (current()) publish({ owner, status: "error", error: cause instanceof Error ? cause.message : "模型目录暂时无法读取", models: [] });
        } finally { if (active === request) active = undefined; }
      })();
      return request.promise;
    },
  };
}
export const studioModelCatalogue = createStudioModelCatalogue();

export type StudioModelSelection = {
  status: "loading" | "failed" | "unsupported" | "empty" | "missing" | "invalid" | "ready";
  value: string; original: string; label: string; message: string; options: string[]; model?: StudioModel;
};
export function selectStudioModel(state: ModelCatalogueState, value: string | undefined, capability: ModelCapability): StudioModelSelection {
  const original = value ?? "", name = capabilityNames[capability];
  const options = state.status === "ready" ? state.models.filter(model => model.capability === capability).map(modelToken) : [];
  const base = { value: "", original, options };
  if (state.status === "loading") return { ...base, status: "loading", label: "正在核对模型目录", message: "原选择保持 目录核对完成前不可生成" };
  if (state.status !== "ready") return { ...base, status: "failed", label: "模型目录尚未核对", message: state.error || "模型目录暂不可读取 原选择保持" };
  if (capability === "audio") return { ...base, status: "unsupported", label: "音频模型尚未接入", message: "当前 ERP 尚未接入音频生成 原记录保持" };
  const model = state.models.find(model => modelToken(model) === original);
  if (original && (!model || model.capability !== capability)) return { ...base, status: "invalid", label: `原选择不适用于${name}`, message: (model ? `原选择的用途不是${name} 请明确重新选择` : "原选择已删除 停用或不在当前目录 请明确重新选择") + (options.length ? "" : ` 当前没有可用的${name}模型`) };
  if (!options.length) return { ...base, status: "empty", label: `没有可用的${name}模型`, message: `当前目录没有可用的${name}模型 可进入 ERP 模型配置` };
  if (!model) return { ...base, status: "missing", label: `请选择${name}模型`, message: "尚未选择模型 不会自动选择列表第一项" };
  return { ...base, status: "ready", value: original, label: `${model.model}（${model.label}）`, message: "", model };
}
export function selectStudioConfigModel(config: AiConfig, value: string | undefined, capability: ModelCapability, state = studioModelCatalogue.snapshot()) {
  if (!state.owner || (config as RuntimeConfig)[STUDIO_RUNTIME_MODELS] !== state.owner) return { status: "failed" as const, value: "", original: "", label: "模型归属已变化", message: "旧模型选择未采用 请重新核对当前目录", options: [] };
  return selectStudioModel(state, value, capability);
}
export function studioModelValue(config: AiConfig, current: string | undefined, capability: ModelCapability) {
  if (current) return current;
  const specific = config[`${capability}Model`];
  if (specific) return specific;
  const state = studioModelCatalogue.snapshot();
  const preferred = state.status === "ready" ? state.models.filter(model => model.capability === capability && model.isDefault) : [];
  return preferred.length === 1 ? modelToken(preferred[0]!) : "";
}
export function studioWorkbenchModel(config: AiConfig, capability: "image" | "video", document: WorkbenchDraftDocument) {
  const active = document.drafts.find(item => item.id === document.activeId), original = active?.config[`${capability}Model`] || active?.config.model;
  return studioModelValue(config, original, capability);
}
export function studioNodeModelFields(config: AiConfig, current: string | undefined, capability: ModelCapability) {
  const value = studioModelValue(config, current, capability);
  return { model: value, [`${capability}Model`]: value };
}
export function studioModelUsable(config: AiConfig, value: string | undefined, capability: ModelCapability) {
  return !isStudioRuntimeConfig(config) || selectStudioConfigModel(config, value, capability).status === "ready";
}
export function studioAnyModelUsable(config: AiConfig, value: string) {
  const state = studioModelCatalogue.snapshot();
  return !isStudioRuntimeConfig(config) || (config as RuntimeConfig)[STUDIO_RUNTIME_MODELS] === state.owner && state.status === "ready" && state.models.some(model => modelToken(model) === value);
}
export function studioModelLabel(config: AiConfig, value: string | undefined, capability: ModelCapability) {
  return selectStudioConfigModel(config, value, capability).label;
}
export function requireStudioModel(config: AiConfig, capability: "image" | "video" | "text") {
  if (!isStudioRuntimeConfig(config)) throw new Error("原模型配置尚未与 ERP 当前目录核对 请重新选择");
  // A capability-specific choice always wins over the retained generic field.
  // Native canvas builders explicitly project their selected node model into it.
  const selected = selectStudioConfigModel(config, config[`${capability}Model`] || "", capability);
  if (selected.status !== "ready" || !selected.model) throw new Error(selected.message || selected.label);
  return selected.model;
}
export function projectStudioModels(config: AiConfig, models: StudioModel[]): AiConfig {
  const owner = studioModelCatalogue.snapshot().owner, changedOwner = isStudioRuntimeConfig(config) && (config as RuntimeConfig)[STUDIO_RUNTIME_MODELS] !== owner;
  const choose = (value: string, capability: "image" | "video" | "text") => value || (() => { const candidates = models.filter(model => model.capability === capability && model.isDefault); return candidates.length === 1 ? modelToken(candidates[0]!) : ""; })();
  return { ...config, [STUDIO_RUNTIME_MODELS]: owner, model: changedOwner ? "" : config.model,
    channels: models.map(model => ({ id: model.id, name: model.label, baseUrl: "", apiKey: "", apiFormat: "openai" as const, models: [{ name: model.model, capability: model.capability }] })),
    models: models.map(modelToken), imageModel: choose(changedOwner ? "" : config.imageModel, "image"), videoModel: choose(changedOwner ? "" : config.videoModel, "video"), textModel: choose(changedOwner ? "" : config.textModel, "text"), audioModel: changedOwner ? "" : config.audioModel,
  } as RuntimeConfig;
}
