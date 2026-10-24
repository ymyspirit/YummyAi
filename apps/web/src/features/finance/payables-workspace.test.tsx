import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { createEntityId } from "@yummyai/contracts";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import type { FinancePayableBillView, FinancePayablePaymentView, FinancePayablesWorkspaceView } from "@yummyai/contracts/finance/payables";
import { ErpIdentityContext } from "../identity/erp-access";
import { PayablesWorkspace } from "./payables-workspace";

const supplierId = createEntityId(), tenantId = createEntityId(), userId = createEntityId(), at = "2026-07-02T00:00:00.000Z";
const allRights = [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
const data = (): FinancePayablesWorkspaceView => ({ suppliers: [{ id: supplierId, name: "Synthetic supplier", status: "active" }], bills: [], payments: [],
  allocations: [], releases: [], billAdjustments: [], paymentAdjustments: [], procurementAdjustments: [], procurementAdjustmentDiagnostics: [],
  permissions: { canWrite: true, canReview: true }, truncated: false });
function bill(overrides: Partial<FinancePayableBillView> = {}): FinancePayableBillView {
  return { id: createEntityId(), supplierId, kind: "factory_invoice", externalBillId: "SYNTHETIC-BILL", currency: "USD", amountMinor: 10000,
    creditMinor: 0, debitMinor: 0, voidedMinor: 0, netAmountMinor: overrides.amountMinor ?? 10000, lifecycle: "active",
    issuedAt: at, dueAt: null, procurementInvoiceId: null, procurementProofId: null, sourceStatus: "current", allocatedMinor: 0, outstandingMinor: 10000,
    status: "unallocated", recordedAt: at, ...overrides };
}
function payment(overrides: Partial<FinancePayablePaymentView> = {}): FinancePayablePaymentView {
  return { id: createEntityId(), supplierId, externalPaymentId: "SYNTHETIC-PAYMENT", currency: "USD", amountMinor: 10000, paidAt: at,
    refundedMinor: 0, voidedMinor: 0, netAmountMinor: overrides.amountMinor ?? 10000, lifecycle: "active",
    method: "bank_transfer", evidenceReference: "SYNTHETIC-EVIDENCE", evidenceStatus: "operator_recorded", allocatedMinor: 0, unallocatedMinor: 10000,
    status: "unallocated", recordedAt: at, ...overrides };
}
function render(value: FinancePayablesWorkspaceView, rights: string[] = allRights) {
  const session: ErpSessionView = { authenticated: true, canUseErp: true, tenantId, userId, displayName: "Synthetic operator",
    organizationName: "Synthetic organization", permissions: rights, dataScope: "tenant" };
  return renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}><PayablesWorkspace initialData={value} /></ErpIdentityContext.Provider>);
}

describe("actual payables workspace evidence and current access", () => {
  it("explains empty lists and the distinction between recorded evidence and a bank transfer", () => {
    const html = render(data());
    expect(html).toContain("当前已读取列表中没有应付账单"); expect(html).toContain("当前已读取列表中没有付款证据");
    expect(html).toContain("当前已读取列表中没有核销记录"); expect(html).toContain("未经银行认证"); expect(html).toContain("此处不发起转账");
    expect(html).not.toContain("USD 0.00"); expect(html).not.toContain("转账成功");
  });
  it("renders independent JPY, KWD and safe large balances exactly without a mixed-currency total", () => {
    const value = data(); value.bills = [bill({ externalBillId: "YEN", currency: "JPY", amountMinor: 1234, outstandingMinor: 1234 }),
      bill({ externalBillId: "DINAR", currency: "KWD", amountMinor: 1234, outstandingMinor: 1234 }),
      bill({ externalBillId: "SAFE-LARGE", amountMinor: 9007199254740990, outstandingMinor: 9007199254740990 })];
    value.payments = [payment({ currency: "KWD", amountMinor: 1234, unallocatedMinor: 1234 })];
    const html = render(value); expect(html).toContain("JPY 1234"); expect(html).toContain("KWD 1.234"); expect(html).toContain("USD 90071992547409.90");
    expect(html).not.toContain("90071992547409.91"); expect(html).toContain("不跨币种相加"); expect(html).toContain("不是银行余额");
  });
  it("intersects server write and review gates with the current personal permissions", () => {
    const value = data(); value.bills = [bill()]; value.payments = [payment()];
    const readOnly = render(value, [Permission.FinanceRead]);
    expect(readOnly).toContain("SYNTHETIC-BILL"); expect(readOnly).toContain("SYNTHETIC-PAYMENT");
    expect(readOnly).not.toContain("<button type=\"button\" class=\"primary\""); expect(readOnly).not.toContain("选择付款核销"); expect(readOnly).not.toContain("分配到多个账单");
    const serverDenied = render({ ...value, permissions: { canWrite: false, canReview: false } });
    expect(serverDenied).toContain("当前账号可查看账单"); expect(serverDenied).toContain("当前账号没有财务核销权限");
    expect(serverDenied).not.toContain("选择付款核销");
  });
  it("does not render a stale private snapshot after FinanceRead is removed", () => {
    const value = data(); value.bills = [bill()]; value.payments = [payment()];
    const html = render(value, [Permission.ProductRead]); expect(html).toContain("当前没有财务读取权限");
    expect(html).not.toContain("SYNTHETIC-BILL"); expect(html).not.toContain("SYNTHETIC-EVIDENCE"); expect(html).not.toContain("<table");
  });
  it("keeps procurement unknown, unreconciled and adjusted sources explicit and blocks their allocation buttons", () => {
    const value = data(); value.bills = [bill({ externalBillId: "PENDING", sourceStatus: "source_unreconciled" }),
      bill({ externalBillId: "ADJUSTED", sourceStatus: "source_adjusted" }), bill({ externalBillId: "UNKNOWN", sourceStatus: "source_unavailable" })];
    value.truncated = true; const html = render(value);
    expect(html).toContain("采购差异待核对"); expect(html).toContain("来源已有生效调整 原应付待重新核对"); expect(html).toContain("来源暂不可核对");
    expect(html.match(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*[\s\S]*?选择付款核销<\/button>/g)?.length ?? 0).toBe(3);
    expect(html).toContain("当前列表不完整"); expect(html).toContain("按全部有效核销计算");
  });
  it("retains both the original allocation and the appended release without presenting a refund", () => {
    const value = data(), due = bill(), paid = payment(), allocationId = createEntityId(); value.bills = [due]; value.payments = [paid];
    value.allocations = [{ id: allocationId, batchId: createEntityId(), paymentId: paid.id, billId: due.id, supplierId, currency: "USD", amountMinor: 6000,
      released: true, recordedAt: at }]; value.releases = [{ id: createEntityId(), allocationId, reasonCode: "WRONG_BILL", recordedAt: at }];
    const html = render(value); expect(html).toContain(allocationId); expect(html).toContain("USD 60.00"); expect(html).toContain("已撤销 本笔不再占用余额");
    expect(html).toContain("WRONG_BILL"); expect(html).toContain("撤销凭据"); expect(html).not.toContain("撤销本笔核销"); expect(html).not.toContain("退款成功");
  });
});
