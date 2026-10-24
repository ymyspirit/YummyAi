import { ContentProjectQuerySchema } from "@yummyai/contracts/catalog/content-project";
import { PillowProjectQuerySchema } from "@yummyai/contracts/catalog/pillow-project";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { apiFetch } from "../../../../server-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
export async function GET(request: Request, context: Context) {
  const url = new URL(request.url), path = (await context.params).path ?? [];
  // Reuse the existing loopback ERP identity only in local development.
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || request.headers.get("sec-fetch-site") === "cross-site") return failure(403);
  const pillowList = path.length === 1 && path[0] === "pillow";
  const pillowOrder = path.length === 3 && path[0] === "pillow" && path[1] === "orders" && EntityIdSchema.safeParse(path[2]).success;
  if (!pillowList && !pillowOrder && (path.length > 1 || path.length === 1 && !EntityIdSchema.safeParse(path[0]).success)) return failure(404);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  let query = "";
  if (!path.length || pillowList) {
    const parsed = (pillowList ? PillowProjectQuerySchema : ContentProjectQuerySchema).safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return failure(400);
    const filters = new URLSearchParams({ q: parsed.data.q, page: String(parsed.data.page), pageSize: String(parsed.data.pageSize) });
    if ("stage" in parsed.data && typeof parsed.data.stage === "string") filters.set("stage", parsed.data.stage);
    query = `?${filters}`;
  } else if (url.search) return failure(400);
  try {
    const response = await apiFetch(`${base}/v1/content-projects${path.length ? `/${path.join("/")}` : ""}${query}`, {
      cache: "no-store", signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return failure(response.status);
    return new Response(response.body, { status: response.status, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return failure(502); }
}
function failure(status: number) {
  const message = status === 401 ? "登录已失效，请重新登录" : status === 403 ? "当前入口或账号没有读取权限"
    : status === 404 ? "图文项目不存在或已归档" : status === 400 ? "图文项目查询条件无效"
      : status === 503 ? "图文项目 API 尚未配置" : "图文项目读取失败，请刷新重试";
  return Response.json({ message }, { status, headers: { "cache-control": "private, no-store" } });
}
