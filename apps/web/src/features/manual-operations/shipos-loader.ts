import "server-only";
import { ShiposWorkspaceSchema, type ShiposWorkspace } from "@yummyai/contracts/suppliers/shipos";
import { apiFetch } from "../../server-api";

export async function loadShiposWorkspace(supplierId: string): Promise<{ data: ShiposWorkspace | null; error: string | null }> {
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return { data: null, error: "ShipOS 服务尚未配置" };
  try {
    const response = await apiFetch(`${base}/v1/sourcing/suppliers/${encodeURIComponent(supplierId)}/shipos`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { data: null, error: response.status === 403 ? "当前成员无权查看 ShipOS 同步记录" : "ShipOS 同步记录暂时无法读取，请刷新重试" };
    return { data: ShiposWorkspaceSchema.parse(await response.json()), error: null };
  } catch { return { data: null, error: "ShipOS 同步记录暂时无法读取，请刷新重试" }; }
}
