import { useAssetStore } from "@/stores/use-asset-store";
export type { Prompt, PromptListResponse, PromptSourceStatus, PromptSourceRefreshResult, PromptSourceRefreshSummary } from "../vendor/src/services/api/prompts";
export const ALL_PROMPTS_OPTION = "all";
export async function fetchPrompts({ keyword = "", tag = [], page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}) {
  if (!useAssetStore.getState().hydrated) await new Promise<void>(resolve => { const unsub = useAssetStore.subscribe(state => { if (state.hydrated) { unsub(); resolve(); } }); });
  const all = useAssetStore.getState().assets.flatMap(asset => asset.kind === "text" ? [{ id: asset.id, title: asset.title, prompt: asset.data.content, description: asset.note ?? "", coverUrl: "", referenceImageUrls: [], tags: asset.tags, preview: asset.data.content, createdAt: asset.createdAt, updatedAt: asset.updatedAt, sourceId: "erp", category: "我的提示词", githubUrl: "" }] : []);
  const filtered = all.filter(item => `${item.title} ${item.prompt} ${item.tags.join(" ")}`.includes(keyword) && tag.every(t => item.tags.includes(t)));
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, tags: [...new Set(all.flatMap(item => item.tags))], categories: ["我的提示词"] };
}
export async function fetchSourcePrompts() { return (await fetchPrompts({ pageSize: 10_000 })).items; }
export async function refreshSource(sourceId: string) { return { sourceId, sourceName: "我的提示词", count: (await fetchSourcePrompts()).length, lastSuccessAt: "", lastError: "", success: true }; }
export async function refreshAllSources() { return { results: [], total: 0, successCount: 0, failureCount: 0 }; }
export const refreshDueSources = refreshAllSources;
export async function fetchPromptSourceStatuses() { return {}; }
export function formatPromptDate(value: string) { return value ? new Date(value).toLocaleDateString("zh-CN") : ""; }
