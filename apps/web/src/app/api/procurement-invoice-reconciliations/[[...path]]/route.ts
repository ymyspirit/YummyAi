import { z } from "zod";
import { InvoiceReconciliationQuerySchema, InvoiceReconciliationListSchema, InvoiceReconciliationDetailSchema } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { apiFetch } from "../../../../server-api";

type Context = { params: Promise<{ path?: string[] }> };
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export async function GET(request: Request, context: Context) {
  const { path = [] } = await context.params, search = new URL(request.url).searchParams, query = Object.fromEntries(search);
  if (search.size !== Object.keys(query).length || path.length > 1) return failure(400);
  let invoiceId: string | undefined, options: z.infer<typeof InvoiceReconciliationQuerySchema> | undefined;
  try {
    if (path.length) { invoiceId = z.uuidv7().transform(v => v.toLowerCase()).parse(path[0]); z.object({}).strict().parse(query); }
    else options = InvoiceReconciliationQuerySchema.parse(query);
  } catch { return failure(400); }
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  if (!base) return failure(503);
  const suffix = invoiceId ? `/${invoiceId}` : `?${new URLSearchParams(options)}`;
  try {
    const response = await apiFetch(`${base}/v1/procurement/invoice-reconciliations${suffix}`, {
      method: "GET", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) return failure([400, 401, 403, 404, 409].includes(response.status) ? response.status : 502);
    const raw = await response.json();
    if (invoiceId) {
      const parsed = InvoiceReconciliationDetailSchema.safeParse(raw);
      if (!parsed.success || parsed.data.invoiceId !== invoiceId) return failure(502);
      return Response.json(parsed.data, { headers });
    }
    const parsed = InvoiceReconciliationListSchema.safeParse(raw);
    if (!parsed.success || parsed.data.items.some(row => options?.purchaseOrderId && row.purchaseOrderId !== options.purchaseOrderId || options?.pendingOnly === "true" && row.pendingCount === 0)) return failure(502);
    return Response.json(parsed.data, { headers });
  } catch { return failure(502); }
}
function failure(status: number) {
  return Response.json({ message: status === 401 ? "登录已失效 请重新登录" : status === 403 ? "当前账号无权读取发票处理依据" : status === 404 ? "原发票不可访问" : status === 400 ? "请核对发票处理查询参数" : "实际处理余额暂时无法读取 请稍后重试" }, { status, headers });
}
