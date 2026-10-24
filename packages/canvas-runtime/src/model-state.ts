import { create } from "zustand";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { studioModelCatalogue } from "./model-selection";

// Loading model configuration must never hold up document hydration or editing.
export const useStudioModels = create<{ status: "loading" | "ready" | "error"; error: string; executionAllowed: boolean; executionReason: string; canSave: boolean; canConfigure: boolean }>(() => ({ status: "loading", error: "", executionAllowed: false, executionReason: "生成状态尚未核对", canSave: false, canConfigure: false }));

studioModelCatalogue.subscribe(() => {
  const current = studioModelCatalogue.snapshot();
  useStudioModels.setState({ status: current.status === "ready" ? "ready" : current.status === "loading" ? "loading" : "error", error: current.error });
});

export function applyStudioWorkspace(workspace?: StudioWorkspace, scope = workspace?.scope ?? "unassigned") {
  // Missing workspace is the explicitly retained development transport. Every
  // personal production initialization supplies the validated owner workspace.
  const readable = !workspace || workspace.scope === scope && workspace.capabilities.read;
  const changed = studioModelCatalogue.configure(readable ? JSON.stringify([scope, workspace?.contextAuthority ?? "local-development"]) : "");
  useStudioModels.setState({ executionAllowed: readable && (workspace ? workspace.generation.enabled : true),
    executionReason: workspace ? workspace.capabilities.save ? "生成已暂停 你可以继续编辑 保存和管理素材" : "生成已暂停 你可以查看历史文档和素材" : "", canSave: readable && (workspace ? workspace.capabilities.save : true), canConfigure: readable && (workspace ? workspace.capabilities.configure : true) });
  return changed;
}

export function assertStudioModelsReady() {
  const { status, error, executionAllowed, executionReason } = useStudioModels.getState();
  if (!executionAllowed) throw new Error(executionReason || "当前尚未开通模型生成");
  if (status !== "ready") throw new Error(error || "模型配置正在读取，请稍后生成；画布可以继续编辑和保存。");
}

export function studioExecutionAllowed() { return useStudioModels.getState().executionAllowed; }
export function assertStudioExecutionAllowed() {
  if (!studioExecutionAllowed()) throw new Error(useStudioModels.getState().executionReason || "原任务恢复与轮询已暂停 原记录保持");
}
