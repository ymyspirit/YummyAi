export interface BudgetPolicy {
  monthlyCapUsd: number;
  defaultTaskCapUsd: number;
  taskCapsUsd?: Readonly<Record<string, number>>;
}

export interface BudgetPolicySource {
  getPolicy(tenantId: string): Promise<BudgetPolicy>;
}

export interface BudgetReservation {
  readonly reservedUsd: number;
  commit(actualCostUsd: number): Promise<void>;
  release(): Promise<void>;
}

export interface BudgetLedger {
  reserve(input: {
    tenantId: string;
    taskType: string;
    requestCapUsd: number;
    estimatedCostUsd: number;
    now?: Date;
  }): Promise<BudgetReservation>;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: "request" | "task" | "monthly",
    readonly capUsd: number,
    readonly requestedUsd: number,
  ) {
    super(`AI ${scope} budget exceeded: requested $${requestedUsd.toFixed(6)}, cap $${capUsd.toFixed(6)}`);
    this.name = "BudgetExceededError";
  }
}

interface MonthUsage {
  committedUsd: number;
  reservedUsd: number;
}

export class InMemoryBudgetLedger implements BudgetLedger {
  private readonly usage = new Map<string, MonthUsage>();

  constructor(private readonly policies: BudgetPolicySource) {}

  async reserve(input: {
    tenantId: string;
    taskType: string;
    requestCapUsd: number;
    estimatedCostUsd: number;
    now?: Date;
  }): Promise<BudgetReservation> {
    assertMoney(input.estimatedCostUsd);
    assertMoney(input.requestCapUsd);
    const policy = await this.policies.getPolicy(input.tenantId);
    const taskCap = policy.taskCapsUsd?.[input.taskType] ?? policy.defaultTaskCapUsd;

    if (input.estimatedCostUsd > input.requestCapUsd) {
      throw new BudgetExceededError("request", input.requestCapUsd, input.estimatedCostUsd);
    }
    if (input.estimatedCostUsd > taskCap) {
      throw new BudgetExceededError("task", taskCap, input.estimatedCostUsd);
    }

    const key = monthKey(input.tenantId, input.now ?? new Date());
    const usage = this.usage.get(key) ?? { committedUsd: 0, reservedUsd: 0 };
    const projected = usage.committedUsd + usage.reservedUsd + input.estimatedCostUsd;
    if (projected > policy.monthlyCapUsd) {
      throw new BudgetExceededError("monthly", policy.monthlyCapUsd, projected);
    }

    usage.reservedUsd += input.estimatedCostUsd;
    this.usage.set(key, usage);
    let open = true;

    return {
      reservedUsd: input.estimatedCostUsd,
      commit: async (actualCostUsd) => {
        if (!open) throw new Error("Budget reservation is already closed");
        assertMoney(actualCostUsd);
        if (actualCostUsd > input.requestCapUsd || actualCostUsd > taskCap) {
          throw new BudgetExceededError("request", Math.min(input.requestCapUsd, taskCap), actualCostUsd);
        }
        const monthlyProjected = usage.committedUsd + usage.reservedUsd - input.estimatedCostUsd + actualCostUsd;
        if (monthlyProjected > policy.monthlyCapUsd) {
          throw new BudgetExceededError("monthly", policy.monthlyCapUsd, monthlyProjected);
        }
        usage.reservedUsd -= input.estimatedCostUsd;
        usage.committedUsd += actualCostUsd;
        open = false;
      },
      release: async () => {
        if (!open) return;
        usage.reservedUsd -= input.estimatedCostUsd;
        open = false;
      },
    };
  }

  getUsage(tenantId: string, now = new Date()): Readonly<MonthUsage> {
    return this.usage.get(monthKey(tenantId, now)) ?? { committedUsd: 0, reservedUsd: 0 };
  }
}

function monthKey(tenantId: string, now: Date): string {
  return `${tenantId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function assertMoney(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Budget values must be finite non-negative numbers");
}
