import type { CompetitorShopView } from "./competitor-shop-library";
import { apiFetch } from "../../server-api";

export async function loadCompetitorShops(): Promise<{ items: CompetitorShopView[]; error?: string }> {
  const apiBase = process.env.API_BASE_URL;
  if (!apiBase) return { items: [], error: "尚未配置竞争店铺 API。请设置 API_BASE_URL 后重试。" };
  try {
    const response = await apiFetch(`${apiBase.replace(/\/$/, "")}/v1/competitor-shops`, { cache: "no-store" });
    if (!response.ok) throw new Error(`竞争店铺读取失败 (${response.status})`);
    return (await response.json()) as { items: CompetitorShopView[] };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "竞争店铺读取失败" };
  }
}
