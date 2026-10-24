import { describe, expect, it } from "vitest";
import { modelBillingBudgetAmount } from "./model-billing.js";
import { ModelBillingConfirmSchema } from "@yummyai/contracts/ai/model-billing";
import { createEntityId } from "@yummyai/contracts";
describe("manual fee evidence and canonical budget precision", () => {
  it.each([
    ["0.00000000", "0.000000"],
    ["0.00000001", "0.000001"],
    ["0.00000100", "0.000001"],
    ["1.12345601", "1.123457"],
    ["99999999.99999900", "99999999.999999"],
  ])("preserves %s evidence and conservatively budgets %s", (amount, expected) =>
    expect(modelBillingBudgetAmount(amount)).toBe(expected),
  );
  it.each(["-1.00000000", "1e-8", "1.0", "NaN", "99999999.99999901", "100000000.00000000"])(
    "rejects unsupported amount %s",
    (amount) => expect(() => modelBillingBudgetAmount(amount)).toThrow(),
  );
  const input = {
    commandId: createEntityId(),
    expectedFingerprint: "a".repeat(64),
    amountUsd: "1.2",
    currency: "USD",
    evidenceKind: "provider_invoice",
    invoiceReference: "invoice-001",
    providerRequestId: "request-001",
    proofChecksum: "b".repeat(64),
    matchesOriginalRequest: true,
  };
  it("normalizes decimal evidence without using floating point", () =>
    expect(ModelBillingConfirmSchema.parse(input).amountUsd).toBe("1.20000000"));
  it.each([
    { matchesOriginalRequest: false },
    { currency: "CNY" },
    { amountUsd: "0.000000001" },
    { invoiceReference: "invoice with secrets" },
    { providerRequestId: "request\n001" },
    { executionContract: {} },
  ])("requires explicit valid evidence and rejects untrusted fields %j", (change) =>
    expect(ModelBillingConfirmSchema.safeParse({ ...input, ...change }).success).toBe(false),
  );
});
