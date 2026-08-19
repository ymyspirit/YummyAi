import { describe, expect, it } from "vitest";

import { InMemoryBudgetLedger, type BudgetPolicySource } from "./budget.js";

const policies: BudgetPolicySource = {
  getPolicy: async () => ({
    monthlyCapUsd: 1,
    defaultTaskCapUsd: 0.5,
    taskCapsUsd: { expensive: 0.8 },
  }),
};

describe("InMemoryBudgetLedger", () => {
  it("rejects a task cap before a reservation is created", async () => {
    const ledger = new InMemoryBudgetLedger(policies);
    await expect(
      ledger.reserve({ tenantId: "tenant", taskType: "default", requestCapUsd: 1, estimatedCostUsd: 0.6 }),
    ).rejects.toMatchObject({ scope: "task" });
    expect(ledger.getUsage("tenant")).toEqual({ committedUsd: 0, reservedUsd: 0 });
  });

  it("rejects the monthly cap using committed and reserved usage", async () => {
    const ledger = new InMemoryBudgetLedger(policies);
    const first = await ledger.reserve({ tenantId: "tenant", taskType: "expensive", requestCapUsd: 1, estimatedCostUsd: 0.7 });
    await first.commit(0.7);

    await expect(
      ledger.reserve({ tenantId: "tenant", taskType: "default", requestCapUsd: 1, estimatedCostUsd: 0.4 }),
    ).rejects.toMatchObject({ scope: "monthly" });
  });

  it("releases a failed attempt without consuming monthly budget", async () => {
    const ledger = new InMemoryBudgetLedger(policies);
    const reservation = await ledger.reserve({ tenantId: "tenant", taskType: "default", requestCapUsd: 1, estimatedCostUsd: 0.4 });
    await reservation.release();
    expect(ledger.getUsage("tenant")).toEqual({ committedUsd: 0, reservedUsd: 0 });
  });
});
