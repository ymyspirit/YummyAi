import { z } from "zod";
import {
  AllocateFinancePaymentInputSchema, FinanceAllocationReleaseViewSchema, FinancePayableBillViewSchema, FinancePayablePaymentViewSchema,
  FinancePayablesWorkspaceViewSchema, FinancePaymentAllocationBatchViewSchema, RecordFinanceBillInputSchema,
  RecordFinancePaymentInputSchema, ReleaseFinanceAllocationInputSchema,
} from "@yummyai/contracts/finance/payables";
import { FinanceBillAdjustmentViewSchema, FinancePaymentAdjustmentViewSchema, RecordFinanceBillAdjustmentInputSchema,
  RecordFinancePaymentAdjustmentInputSchema, type FinanceBillAdjustmentView, type FinancePaymentAdjustmentView,
  type RecordFinanceBillAdjustmentInput, type RecordFinancePaymentAdjustmentInput } from "@yummyai/contracts/finance/payables-adjustments";
import { apiFetch } from "../../../../../server-api";
import { isSameOriginRequest } from "../../../../../same-origin-request";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const Id = z.uuidv7().transform(value => value.toLowerCase());
const privateHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export async function GET(request: Request, context: Context) { return proxy(request, context, "GET"); }
export async function POST(request: Request, context: Context) { return proxy(request, context, "POST"); }

async function proxy(request: Request, context: Context, method: "GET" | "POST") {
  const { path } = await context.params;
  const workspace = method === "GET" && path.length === 1 && path[0] === "workspace";
  const operation = method === "POST" && path.length === 1 && ["bills", "payments", "allocations"].includes(path[0]!) ? path[0]
    : method === "POST" && path.length === 3 && path[0] === "allocations" && Id.safeParse(path[1]).success && path[2] === "releases" ? "releases"
      : method === "POST" && path.length === 3 && Id.safeParse(path[1]).success && path[2] === "adjustments"
        ? path[0] === "bills" ? "bill-adjustment" : path[0] === "payments" ? "payment-adjustment" : null : null;
  if (!workspace && !operation) return failure(404);
  if ([...new URL(request.url).searchParams].length) return failure(400);
  let body: unknown;
  if (operation) {
    if (!isSameOriginRequest(request)) return failure(403);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return failure(415);
    const reader = request.body?.getReader(); if (!reader) return failure(400);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength; if (length > 65_536) { await reader.cancel(); return failure(413); }
        chunks.push(chunk.value);
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      body = (operation === "bills" ? RecordFinanceBillInputSchema : operation === "payments" ? RecordFinancePaymentInputSchema
        : operation === "allocations" ? AllocateFinancePaymentInputSchema : operation === "bill-adjustment" ? RecordFinanceBillAdjustmentInputSchema
          : operation === "payment-adjustment" ? RecordFinancePaymentAdjustmentInputSchema : ReleaseFinanceAllocationInputSchema).parse(raw);
    } catch { return failure(400); }
  }
  const base = process.env.API_BASE_URL?.replace(/\/$/, ""); if (!base) return failure(503);
  try {
    const response = await apiFetch(`${base}/v1/finance/payables/${path.map(encodeURIComponent).join("/")}`, {
      method, cache: "no-store", ...(operation ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
      signal: operation ? AbortSignal.timeout(30_000) : AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) {
      const error: unknown = [400, 409, 422].includes(response.status) ? await response.json().catch(() => null) : null;
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^finance_payables_[a-z_]{1,100}$/.test(error.code) ? error.code : undefined;
      return failure([400, 401, 403, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 502, code);
    }
    const raw: unknown = await response.json();
    if (workspace) return Response.json(FinancePayablesWorkspaceViewSchema.parse(raw), { headers: privateHeaders });
    if (operation === "bills") {
      const value = FinancePayableBillViewSchema.parse(raw), original = RecordFinanceBillInputSchema.parse(body);
      if (!matchesOriginal(original, value)) return failure(502);
      return Response.json(value, { status: response.status, headers: privateHeaders });
    }
    if (operation === "payments") {
      const value = FinancePayablePaymentViewSchema.parse(raw), original = RecordFinancePaymentInputSchema.parse(body);
      if (!matchesOriginal(original, value)) return failure(502);
      return Response.json(value, { status: response.status, headers: privateHeaders });
    }
    if (operation === "allocations") {
      const value = FinancePaymentAllocationBatchViewSchema.parse(raw), original = AllocateFinancePaymentInputSchema.parse(body);
      if (value.paymentId !== original.paymentId || value.allocations.length !== original.allocations.length || original.allocations.some(item =>
        !value.allocations.some(row => row.billId === item.billId && row.amountMinor === item.amountMinor))) return failure(502);
      return Response.json(value, { status: response.status, headers: privateHeaders });
    }
    if (operation === "bill-adjustment") {
      const value = FinanceBillAdjustmentViewSchema.parse(raw), original = RecordFinanceBillAdjustmentInputSchema.parse(body);
      if (value.billId !== Id.parse(path[1]) || !matchesBillAdjustment(original, value)) return failure(502);
      return Response.json(value, { status: response.status, headers: privateHeaders });
    }
    if (operation === "payment-adjustment") {
      const value = FinancePaymentAdjustmentViewSchema.parse(raw), original = RecordFinancePaymentAdjustmentInputSchema.parse(body);
      if (value.paymentId !== Id.parse(path[1]) || !matchesPaymentAdjustment(original, value)) return failure(502);
      return Response.json(value, { status: response.status, headers: privateHeaders });
    }
    const value = FinanceAllocationReleaseViewSchema.parse(raw), original = ReleaseFinanceAllocationInputSchema.parse(body);
    if (value.allocationId !== Id.parse(path[1]) || value.reasonCode !== original.reasonCode) return failure(502);
    return Response.json(value, { status: response.status, headers: privateHeaders });
  } catch { return failure(502); }
}

function matchesOriginal(input: object, view: object) {
  return Object.entries(input).every(([key, value]) => key === "idempotencyKey" || Reflect.get(view, key) === value);
}
function matchesBillAdjustment(input: RecordFinanceBillAdjustmentInput, view: FinanceBillAdjustmentView) {
  if (input.kind === "procurement_sync") {
    if (view.procurementAdjustmentId !== input.procurementAdjustmentId || view.procurementReviewId !== input.procurementReviewId
      || view.kind === "void" || view.reasonCode !== "PROCUREMENT_APPROVED") return false;
  } else if (view.kind !== input.kind || view.procurementAdjustmentId !== null || view.procurementReviewId !== null
    || view.evidenceReference !== input.evidenceReference || view.occurredAt !== input.occurredAt || view.reasonCode !== input.reasonCode
    || input.kind !== "void" && (view.amountMinor !== input.amountMinor || view.externalDocumentId !== input.externalDocumentId)) return false;
  const expected = BigInt(input.expectedNetAmountMinor) + (view.kind === "debit" ? BigInt(view.amountMinor) : view.kind === "source_acknowledgement" ? 0n : -BigInt(view.amountMinor));
  return expected === BigInt(view.balanceAfter.netAmountMinor) && (view.kind !== "void" || view.balanceAfter.netAmountMinor === 0);
}
function matchesPaymentAdjustment(input: RecordFinancePaymentAdjustmentInput, view: FinancePaymentAdjustmentView) {
  return view.kind === input.kind && view.evidenceReference === input.evidenceReference && view.occurredAt === input.occurredAt
    && view.reasonCode === input.reasonCode && (input.kind === "void" || view.amountMinor === input.amountMinor && view.externalDocumentId === input.externalDocumentId)
    && BigInt(input.expectedNetAmountMinor) - BigInt(view.amountMinor) === BigInt(view.balanceAfter.netAmountMinor)
    && (input.kind !== "void" || view.balanceAfter.netAmountMinor === 0);
}
function failure(status: number, code?: string) {
  const messages: Record<string, string> = {
    finance_payables_request_mismatch: "原提交键已绑定其他填写 请核对原记录",
    finance_payables_bill_already_recorded: "该供应商账单号已有记录 请核对应付台账",
    finance_payables_payment_already_recorded: "该供应商付款凭据号已有记录 请核对付款台账",
    finance_payables_payment_exceeded: "核销金额超过付款的未分配余额",
    finance_payables_bill_exceeded: "核销金额超过账单的剩余应付余额",
    finance_payables_scope_mismatch: "核销只能使用同一供应商和同币种的账单与付款",
    finance_payables_source_adjusted: "采购发票有已生效调整 请先核对原应付依据",
    finance_payables_source_unreconciled: "采购差异或调整审批尚未完成 请先完成采购核对",
    finance_payables_source_unavailable: "采购原始凭据缺失或不一致 请核对原发票",
    finance_payables_allocation_already_released: "该核销已有撤销记录 请核对原撤销凭据",
    finance_payables_balance_changed: "台账净额已变化 请刷新后按当前余额核对",
    finance_payables_adjustment_requires_release: "金额仍被核销占用 请先明确撤销相关核销 再按净额重新核销",
    finance_payables_adjustment_exceeded: "贷项超过当前应付净额 请核对原供应商凭据",
    finance_payables_refund_exceeded: "退款超过付款当前可退金额 请核对实际退款凭据",
    finance_payables_adjustment_document_duplicate: "该供应商更正或退款凭据已有记录 请核对原事件",
    finance_payables_procurement_adjustment_already_synced: "该核准采购调整已同步 不可重复入账",
    finance_payables_procurement_adjustment_required: "采购应付须选择原发票已核准调整 不支持手填金额更正",
    finance_payables_procurement_source_invalid: "核准采购来源无法精确同步 请核对原始凭据与日期",
    finance_payables_adjustment_voided: "原登记已作废 不可追加更正或核销",
    finance_payables_payment_refunded: "付款已有真实退款凭据 不可作为全额错误登记作废",
    finance_payables_adjustment_date_invalid: "更正或退款日期不能早于原始凭据日期",
    finance_payables_procurement_void_unavailable: "采购应付须先同步全部核准调整并归零 才能作废登记",
  };
  return Response.json({ code: code ?? (status >= 500 ? "finance_payables_result_unconfirmed" : "finance_payables_request_rejected"),
    message: code && messages[code] ? messages[code] : status === 401 ? "登录已失效 请重新登录" : status === 403 ? "当前账号没有此财务操作权限"
      : status === 404 ? "该财务记录不可访问" : [400, 413, 415, 422].includes(status) ? "请核对填写内容 金额精度和原始凭据"
        : "本次结果暂时无法确认 请保留原填写并核对台账" }, { status, headers: privateHeaders });
}
