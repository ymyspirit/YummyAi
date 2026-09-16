import { create } from "zustand";

// Loading model configuration must never hold up document hydration or editing.
export const useStudioModels = create<{ status: "loading" | "ready" | "error"; error: string }>(() => ({ status: "loading", error: "" }));

export function assertStudioModelsReady() {
  const { status, error } = useStudioModels.getState();
  if (status !== "ready") throw new Error(error || "模型配置正在读取，请稍后生成；画布可以继续编辑和保存。");
}
