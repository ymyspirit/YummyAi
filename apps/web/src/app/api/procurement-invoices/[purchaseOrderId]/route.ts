import { z } from "zod";
import { RecordProcurementInvoiceInputSchema, ProcurementInvoiceViewSchema } from "@yummyai/contracts/procurement";
import { procurementAmountMinor, sumProcurementMinor } from "@yummyai/contracts/procurement/measurement";
import { apiFetch } from "../../../../server-api";
import { isSameOriginRequest } from "../../../../same-origin-request";

const Id = z.uuidv7().transform(value => value.toLowerCase());
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
type RouteContext = { params: Promise<{ purchaseOrderId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginRequest(request) || !request.headers.get("content-type")?.startsWith("application/json")) return failure(403);
  let id: string, input: z.infer<typeof RecordProcurementInvoiceInputSchema>;
  try {
    id = Id.parse((await context.params).purchaseOrderId);
    if (new URL(request.url).searchParams.size) return failure(400);
    const reader = request.body?.getReader(); if (!reader) return failure(400);
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > 262_144) { await reader.cancel(); return failure(413); }
      chunks.push(next.value);
    }
    input = RecordProcurementInvoiceInputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch { return failure(400); }
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/procurement/purchase-orders/${id}/invoices`, { method: "POST", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(45_000) });
    if (!response.ok) {
      const error = [400, 409, 422].includes(response.status) ? await response.json().catch(() => null) : null;
      const code = typeof error?.code === "string" && /^(procurement_[a-z_]+|authority_changed)$/.test(error.code) ? error.code : undefined;
      return failure(response.status, typeof error?.message === "string" && error.message.length < 400 ? error.message : undefined, code);
    }
    const parsed = ProcurementInvoiceViewSchema.strict().safeParse(await response.json()); if (!parsed.success) return failure(502);
    const row = parsed.data;
    const total = sumProcurementMinor(input.lines.map(line => procurementAmountMinor(line.invoicedQuantity, line.unitCostMinor, line.priceBasisQuantity ?? 1)));
    if (row.purchaseOrderId !== id || row.invoiceNumber !== input.invoiceNumber || row.currency !== input.currency || row.totalMinor !== total ||
        new Date(row.issuedAt).toISOString() !== new Date(input.issuedAt).toISOString()) return failure(502);
    return Response.json(row, { status: response.status, headers });
  } catch { return failure(502); }
}

function failure(status: number, message?: string, code?: string) {
  return Response.json({ code: code ?? (status >= 500 ? "procurement_invoice_result_unconfirmed" : undefined), message: message ??
    (status === 401 ? "登录已失效 请重新登录" : status === 403 ? "当前账号没有发票登记权限" : status === 400 ? "请核对原发票填写" :
      status === 404 ? "原采购单不可访问" : "发票结果暂时无法确认 请保留原填写和提交键核对") }, { status, headers });
}
