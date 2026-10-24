import { ResearchListResponseSchema, ResearchProductTypeFacetResponseSchema, type ResearchProductTypeFacet } from "@yummyai/contracts/research";
import { apiFetch } from "../../server-api";

export async function loadResearch(query: URLSearchParams): Promise<{
  items: ReturnType<typeof ResearchListResponseSchema.parse>["items"];
  nextCursor: string | null;
  total: number;
  error?: string;
}> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], nextCursor: null, total: 0, error: "尚未配置研究 API。请设置 API_BASE_URL 后重试。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/research-items?${query}`, { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) throw new Error("身份会话无效，请重新登录。");
      if (response.status === 403) throw new Error("当前成员没有 research:read 权限。");
      throw new Error(`资料库读取失败 (${response.status})`);
    }
    return ResearchListResponseSchema.parse(await response.json());
  } catch (error) {
    return { items: [], nextCursor: null, total: 0, error: error instanceof Error ? error.message : "资料库读取失败" };
  }
}

export async function loadProductTypes(visibility: string): Promise<{ items: ResearchProductTypeFacet[] }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [] };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/research-items/product-types?visibility=${encodeURIComponent(visibility || "active")}`, { cache: "no-store" });
    if (!response.ok) return { items: [] };
    return ResearchProductTypeFacetResponseSchema.parse(await response.json());
  } catch {
    return { items: [] };
  }
}
