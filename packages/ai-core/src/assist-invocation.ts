import {
  HarnessInvocationViewSchema,
  HarnessUsdSchema,
  type HarnessExecutionContract,
  type HarnessInvocationView,
  type ModelBillingAcknowledgment,
} from "@yummyai/contracts/harness";

const money = (v: string | null) => {
  if (v === null || !/^\d{1,12}(\.\d{1,8})?$/.test(v)) return null;
  const [whole, fraction = ""] = v.split(".");
  const parsed = HarnessUsdSchema.safeParse(whole + "." + fraction.padEnd(8, "0"));
  return parsed.success ? parsed.data : null;
};
export function assistInvocationView(
  run: {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    startedAt: Date | null;
    completedAt: Date | null;
    costUsd: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    modelSnapshot: {
      model: string;
      inputUsdPerMillion: number | null;
      outputUsdPerMillion: number | null;
    };
  },
  execution: {
    phase: string;
    submissionState: string;
    attemptCount: number;
    dispatchCount: number;
    submittedAt: Date | null;
    receivedAt: Date | null;
    providerRequestId: string | null;
    responseChecksum: string | null;
  } | null,
  budget: { state: string; amountUsd: string } | null,
  contract: HarnessExecutionContract | null,
  ambiguousBudget = false,
  reconciliation: ModelBillingAcknowledgment | null = null,
): HarnessInvocationView {
  const price =
    run.inputTokens !== null &&
    run.outputTokens !== null &&
    run.modelSnapshot.inputUsdPerMillion !== null &&
    run.modelSnapshot.outputUsdPerMillion !== null
      ? money(run.costUsd)
      : null;
  const basis =
    price !== null
      ? "configured_rate"
      : execution?.submissionState === "not_submitted"
        ? "not_submitted"
        : "unknown";
  return HarnessInvocationViewSchema.parse({
    version: "harness-invocation-v1",
    owner: "assist",
    id: run.id,
    requestId: run.id,
    parentId: null,
    method: contract?.skill ?? null,
    tool: contract?.tools[0] ?? null,
    state: execution?.phase === "uncertain" ? "uncertain" : run.status,
    boundary: execution?.submissionState ?? "legacy_missing",
    dispatches: execution?.dispatchCount ?? null,
    processingAttempts: execution?.attemptCount ?? null,
    submittedAt: execution?.submittedAt?.toISOString() ?? null,
    receivedAt: execution?.receivedAt?.toISOString() ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.completedAt?.toISOString() ?? null,
    providerRequestId: execution?.providerRequestId ?? null,
    responseChecksum: execution?.responseChecksum ?? null,
    model: { key: run.modelSnapshot.model, version: null },
    artifact: null,
    usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens },
    billing: {
      basis,
      amountUsd: price,
      budgetState: ambiguousBudget ? null : (budget?.state ?? null),
      budgetAmountUsd: ambiguousBudget ? null : money(budget?.amountUsd ?? null),
      needsProviderEvidence: basis !== "not_submitted" && !reconciliation,
      reconciliation,
    },
    issues: [
      ...(!execution ? ["legacy_execution_missing"] : []),
      ...(!contract ? ["execution_contract_unavailable"] : []),
      ...(execution?.phase === "uncertain" ? ["submission_unknown"] : []),
      ...(basis === "unknown" ? ["cost_unknown"] : []),
      ...(ambiguousBudget ? ["ambiguous_budget"] : []),
    ],
  });
}
