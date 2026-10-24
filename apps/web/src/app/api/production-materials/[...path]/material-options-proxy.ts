import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ProductionMaterialStockQuerySchema, ProductionMaterialStockOptionsSchema, ProductionMaterialReservationQuerySchema,
  ProductionMaterialReservationOptionsSchema } from "@yummyai/contracts/order/material-execution";
import { ProductionMaterialReceiptSchema } from "@yummyai/contracts/order/material-execution";
import { apiFetch } from "../../../../server-api";

export async function proxyMaterialOptions(request: Request, path: string[], method: "GET" | "POST") {
  const production = EntityIdSchema.safeParse(path[0]), stock = path[1] === "stock-options";
  if (method !== "GET" || path.length !== 2 || !production.success) return failure(404);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return failure(400);
  const query = (stock ? ProductionMaterialStockQuerySchema : ProductionMaterialReservationQuerySchema).safeParse(Object.fromEntries(params));
  if (!query.success) return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/production-orders/${production.data.toLowerCase()}/materials/${path[1]}?${new URLSearchParams(query.data).toString()}`, {
      cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) return upstreamFailure(response);
    const raw = await response.json(), parsed = (stock ? ProductionMaterialStockOptionsSchema : ProductionMaterialReservationOptionsSchema).safeParse(raw);
    if (!parsed.success) return failure(502);
    const value = parsed.data;
    if (value.productionOrderId !== production.data.toLowerCase() || value.bindingId !== query.data.bindingId || value.materialCode !== query.data.materialCode ||
      [...value.items, ...value.selected].some(item => item.unit !== value.unit) || value.nextCursor && value.items.length !== 25) return failure(502);
    if (stock) {
      const data = ProductionMaterialStockOptionsSchema.parse(value);
      if ([...data.items, ...data.selected].some(item => item.stockItemId !== data.stockItemId || item.dimensionKey !== `${item.stockItemId}:${item.locationId}:${item.lotId ?? "-"}`) ||
        data.selected.some(item => item.dimensionKey !== query.data.selected) ||
        data.nextCursor && data.nextCursor !== data.items.at(-1)!.dimensionKey) return failure(502);
    } else {
      const data = ProductionMaterialReservationOptionsSchema.parse(value);
      if (data.selected.some(item => item.entryId !== query.data.selected) || data.nextCursor && data.nextCursor !== data.items.at(-1)!.entryId) return failure(502);
    }
    return Response.json(value, { headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return failure(502); }
}
async function upstreamFailure(response: Response) {
  const value = response.status === 409 ? await response.json().catch(() => null) : null;
  return failure(response.status, value?.code === "authority_changed" ? "authority_changed" : undefined);
}
function failure(status: number, code?: "authority_changed") { return Response.json({ code, message: code === "authority_changed" ? "当前账号或权限已变化 请重新核对物料资料" : status === 403 ? "当前账号不能读取原物料库存" : "原物料库存选项暂时无法核对 请保留填写后重新读取" },
  { status, headers: { "cache-control": "private, no-store" } }); }

export async function proxyMaterialEntry(request: Request, path: string[], method: "GET" | "POST") {
  const production = EntityIdSchema.safeParse(path[0]), entry = EntityIdSchema.safeParse(path[2]);
  if (method !== "GET" || path.length !== 3 || !production.success || !entry.success) return failure(404);
  if (new URL(request.url).searchParams.size) return failure(400);
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/production-orders/${production.data.toLowerCase()}/materials/entries/${entry.data.toLowerCase()}`, {
      cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) return upstreamFailure(response);
    const value = ProductionMaterialReceiptSchema.safeParse(await response.json());
    if (!value.success || value.data.id !== entry.data.toLowerCase() || value.data.productionOrderId !== production.data.toLowerCase()) return failure(502);
    return Response.json(value.data, { headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch { return failure(502); }
}
