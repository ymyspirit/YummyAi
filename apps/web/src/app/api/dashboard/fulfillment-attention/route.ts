import { FulfillmentAttentionQuerySchema, FulfillmentAttentionViewSchema } from "@yummyai/contracts/operations/fulfillment-attention";
import { apiFetch } from "../../../../server-api";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return failure(400);
  const parsed = FulfillmentAttentionQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  try {
    const query = new URLSearchParams({ source: parsed.data.source, page: String(parsed.data.page) });
    const response = await apiFetch(`${base}/v1/dashboard/fulfillment-attention?${query}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return failure(response.status);
    return Response.json(FulfillmentAttentionViewSchema.parse(await response.json()), { headers });
  } catch { return failure(502); }
}
function failure(status: number) {
  return Response.json({ message: status === 401 ? "登录已失效，请重新登录" : status === 403 ? "当前成员无权查看此类履约待办" : "履约待办暂时无法读取，请重试" }, { status, headers });
}
