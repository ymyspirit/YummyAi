import { createHash } from "node:crypto";
import {
  assistHarness,
  assistUsesReviewedGuidance,
  HarnessContractError,
  ASSIST_MAX_OUTPUT_TOKENS,
  assistPromptVersion,
  assistResultSchema,
  isBenchmarkAssist,
  BenchmarkProofError,
  assistFingerprint,
  assistExecutionPolicy,
  assessPaidRequestRecovery,
  decodeModelResponse,
  ModelResponseCheckpointSchema,
  validateAssistResult,
  type AssistContext,
  type ModelProvider,
  type ModelResponseCheckpoint,
  type SecretVault,
  KnowledgeEvaluationProofError,
} from "@yummyai/ai-core";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  aiAssistRuns as runs,
  aiAssistExecutions as executions,
  aiBudgetLedger,
  AssistInputChangedError,
  assistAuthorityResourceLabel,
  assertAgentMethodSelection,
  loadCurrentMembershipContext,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requiredAssistPermissions, ASSIST_ACCESS_POLICY_VERSION, authorizeAssistRequest } from "@yummyai/authz";
import { assertMethodKnowledge } from "@yummyai/knowledge-core";
import { assertEvaluationExecution, completeEvaluationExecution } from "./knowledge-evaluation-execution.js";
import { assertBusinessBenchmarkExecution, completeBusinessBenchmarkExecution } from "./business-benchmark-execution.js";

type Run = typeof runs.$inferSelect;
type Execution = typeof executions.$inferSelect;
type SavedResponse = {
  response: ModelResponseCheckpoint;
  images: Array<{ sourceId: string; dataUrl: string }>;
  diagnostics: string[];
};
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
const terminal = (phase: Execution["phase"]) =>
  ["completed", "failed", "uncertain"].includes(phase);
const lease = (now: Date) => ({
  leaseToken: createEntityId(),
  leaseExpiresAt: new Date(now.getTime() + 300_000),
});
async function leaseClock(tx: TenantTransaction): Promise<Date> {
  const [row] = await tx.execute(
    sql`select (extract(epoch from clock_timestamp())*1000)::bigint as milliseconds`,
  );
  const value = Number(row?.milliseconds);
  if (!Number.isFinite(value)) throw new Error("assist_lease_clock_unavailable");
  return new Date(value);
}

export class DurableAssistExecution {
  constructor(
    private readonly options: {
      database: DatabaseConnection;
      contentVault: SecretVault;
      provider: (context: TenantContext, run: Run, input: AssistContext) => Promise<ModelProvider>;
      readImage: (url: string) => Promise<string>;
    },
  ) {}

  async process(context: TenantContext, id: string, operation: "analyze" | "expire") {
    const claim = await withTenant(this.options.database.db, context, async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, id), eq(runs.ownerId, context.userId)))
        .for("update");
      const [execution] = await tx
        .select()
        .from(executions)
        .where(eq(executions.runId, id))
        .for("update");
      if (!run || !execution) return null;
      if (run.expiresAt <= new Date()) {
        await expireAssistInTransaction(tx, run, execution);
        return null;
      }
      if (
        operation === "expire" ||
        ["completed", "failed", "cancelled"].includes(run.status) ||
        terminal(execution.phase)
      )
        return null;
      const now = await leaseClock(tx);
      if (execution.leaseExpiresAt && execution.leaseExpiresAt > now) return null;
      if (execution.phase === "response_ready" && execution.nextAttemptAt > now) return null;
      const recovery = assessPaidRequestRecovery({
        submissionState: execution.submissionState,
        hasResponseReceipt: execution.receivedAt !== null,
        hasResponseCheckpoint: execution.encryptedResponse !== null,
      });
      if (recovery.action === "reconcile") {
        await tx
          .update(executions)
          .set({
            phase: "uncertain",
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(executions.runId, id));
        await tx
          .update(runs)
          .set({
            status: "failed",
            errorCode: "assist_submission_unknown",
            completedAt: new Date(),
          })
          .where(eq(runs.id, id));
        return null;
      }
      if (execution.attemptCount >= 3) {
        await tx
          .update(executions)
          .set({ phase: "failed", leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
          .where(eq(executions.runId, id));
        await tx
          .update(runs)
          .set({
            status: "failed",
            errorCode: "assist_local_processing_failed",
            completedAt: new Date(),
          })
          .where(eq(runs.id, id));
        if (recovery.reservation === "release") await releaseReservation(tx, id);
        return null;
      }
      const claimed = lease(now);
      await tx
        .update(executions)
        .set({
          ...claimed,
          phase: execution.encryptedResponse ? "response_ready" : "preparing",
          attemptCount: execution.attemptCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(executions.runId, id));
      await tx
        .update(runs)
        .set({ status: "running", startedAt: run.startedAt ?? new Date(), errorCode: null })
        .where(eq(runs.id, id));
      return { run, execution, token: claimed.leaseToken };
    });
    if (!claim) return { id, disposition: "skipped" };
    const { run, execution, token } = claim;
    try {
      if (!run.encryptedInput) throw new Error("assist_expired");
      if (execution.contractVersion !== "assist-execution-v1")
        throw new Error("assist_execution_version_unsupported");
      const input = await this.options.contentVault.withSecret(
        run.encryptedInput,
        async (raw) => JSON.parse(raw) as AssistContext,
      );
      const benchmark = isBenchmarkAssist(input);
      if (run.promptVersion !== assistPromptVersion(benchmark, run.kind === "order_review")) throw new Error("assist_execution_version_unsupported");
      const outputSchema = assistResultSchema(benchmark, run.kind === "order_review");
      if (
        assistFingerprint(input) !== run.inputFingerprint ||
        execution.inputFingerprint !== run.inputFingerprint
      )
        throw new Error("assist_input_changed");
      if (assistExecutionPolicy(!!input.artworkAudit, benchmark, run.kind === "order_review").checksum !== execution.policyChecksum)
        throw new Error("assist_execution_version_unsupported");
      input.request = CreateAssistSchema.parse(input.request);
      if (input.request.kind !== run.kind) throw new Error("assist_input_changed");
      if (input.request.kind === "knowledge_answer" && input.request.purpose === "evaluation")
        await withTenant(this.options.database.db, context, tx => assertEvaluationExecution(tx, context, run, input, this.options.contentVault));
      await withTenant(this.options.database.db, context, tx => assertBusinessBenchmarkExecution(tx, context, run, input, this.options.contentVault));
      const harness = assistHarness(
        run.kind,
        !!input.artworkAudit,
        requiredAssistPermissions(run.kind, "run"),
        ASSIST_ACCESS_POLICY_VERSION,
        benchmark,
      );
      let saved: SavedResponse;
      if (execution.encryptedResponse) {
        saved = await this.options.contentVault.withSecret(
          execution.encryptedResponse,
          async (raw) => {
            if (checksum(raw) !== execution.responseChecksum)
              throw new Error("assist_checkpoint_invalid");
            return JSON.parse(raw) as SavedResponse;
          },
        );
        ModelResponseCheckpointSchema.parse(saved.response);
        if (saved.response.modelKey !== run.modelSnapshot.model)
          throw new Error("assist_checkpoint_invalid");
        // Authorization and route checks also apply to local continuation, before exposing stored bytes.
        await this.options.provider(context, run, input);
      } else {
        await this.options.provider(context, run, input);
        const images: SavedResponse["images"] = [],
          diagnostics: string[] = [];
        for (const image of input.images) {
          try {
            images.push({
              sourceId: image.sourceId,
              dataUrl: image.dataUrl ?? (await this.options.readImage(image.url!)),
            });
          } catch {
            diagnostics.push(
              `未读到图片“${input.sources.find((s) => s.id === image.sourceId)?.label ?? image.sourceId}”，相关视觉内容未经检查`,
            );
          }
        }
        const model = await this.options.provider(context, run, input);
        await withTenant(this.options.database.db, context, async (tx) => {
          await this.assertClaim(tx, run, token);
          await assertEvaluationExecution(tx, context, run, input, this.options.contentVault);
          await assertBusinessBenchmarkExecution(tx, context, run, input, this.options.contentVault);
          await tx
            .update(executions)
            .set({
              submissionState: "submitted",
              submittedAt: new Date(),
              leaseExpiresAt: sql`clock_timestamp()+interval '5 minutes'`,
              updatedAt: new Date(),
            })
            .where(eq(executions.runId, id));
        });
        let checkpoint: SavedResponse | undefined;
        await model.generate(
          {
            modelKey: run.modelSnapshot.model,
            providerModel: run.modelSnapshot.model,
            taskType: run.kind,
            systemInstructions: harness.registry.instructions(
              input.executionContract,
              harness.skill,
            ),
            untrustedSourceData: {
              ...input.data,
              sources: input.sources.filter(
                (s) =>
                  !input.images.some((i) => i.sourceId === s.id) ||
                  images.some((i) => i.sourceId === s.id),
              ),
              checks: input.checks,
              diagnostics: [...input.diagnostics, ...diagnostics],
              availableImageIds: images.map((i) => i.sourceId),
            },
            images,
            outputSchema,
            outputSchemaName: "erp_assist",
            maxCostUsd: run.modelSnapshot.maxTaskCostUsd,
            maxOutputTokens: ASSIST_MAX_OUTPUT_TOKENS,
            onResponseCheckpoint: async (response) => {
              const value: SavedResponse = {
                response: ModelResponseCheckpointSchema.parse(response),
                images,
                diagnostics,
              };
              const raw = JSON.stringify(value);
              if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
                throw new Error("assist_response_too_large");
              const encryptedResponse = this.options.contentVault.encrypt(raw);
              await withTenant(this.options.database.db, context, async (tx) => {
                await this.assertClaim(tx, run, token);
                await tx
                  .update(executions)
                  .set({
                    phase: "response_ready",
                    submissionState: "received",
                    receivedAt: new Date(response.receivedAt),
                    providerRequestId: response.providerRequestId,
                    encryptedResponse,
                    responseChecksum: checksum(raw),
                    updatedAt: new Date(),
                  })
                  .where(eq(executions.runId, id));
                await settleResponse(tx, run, response);
              });
              checkpoint = value;
            },
          },
          AbortSignal.timeout(
            harness.registry.descriptor(input.executionContract, harness.skill, harness.toolKey)
              .timeout.milliseconds,
          ),
        );
        if (!checkpoint) throw new Error("assist_checkpoint_missing");
        saved = checkpoint;
      }
      // A response can arrive after its business inputs changed. Preserve its bill,
      // then reject adoption of the old result under the same current-input check.
      await this.options.provider(context, run, input);
      const result = decodeModelResponse(saved.response, outputSchema);
      const imageIds = saved.images.map((i) => i.sourceId);
      const validated = validateAssistResult(result.value, input, imageIds);
      harness.registry.checkOutput(
        input.executionContract,
        harness.skill,
        harness.toolKey,
        validated,
      );
      const diagnostics = [...saved.diagnostics];
      if (!result.usageReported)
        diagnostics.push("渠道未返回完整用量；费用未知，预算预留保留，实际费用请查看渠道账单");
      else if (saved.response.costUsd === null)
        diagnostics.push("未配置渠道单价，已记录实际 tokens，费用以渠道账单为准");
      else if (
        run.modelSnapshot.maxTaskCostUsd !== null &&
        saved.response.costUsd > run.modelSnapshot.maxTaskCostUsd
      )
        diagnostics.push("渠道报告的费用超过预估上限，请核对配置的单价和渠道账单");
      const encryptedOutput = this.options.contentVault.encrypt(
        JSON.stringify({ result: validated, diagnostics, images: saved.images }),
      );
      await withTenant(this.options.database.db, context, async (tx) => {
        await this.assertClaim(tx, run, token);
        await settleResponse(tx, run, saved.response);
        const currentContext=await loadCurrentMembershipContext(tx,context,{lock:true});
        authorizeAssistRequest(currentContext,input.request,"run",{hasKnowledge:assistUsesReviewedGuidance(input),pinnedDataScope:input.accessPolicy?.dataScope??"tenant"});
        const method=await assertAgentMethodSelection(tx,harness.registry.describeSkill(harness.skill),input.methodSelection,{lock:true});
        await assertMethodKnowledge(tx,currentContext,method.definition);
        await tx
          .update(runs)
          .set({ status: "completed", completedAt: new Date(), encryptedOutput, errorCode: null })
          .where(eq(runs.id, id));
        await completeEvaluationExecution(tx, currentContext, run, input, validated, this.options.contentVault);
        await completeBusinessBenchmarkExecution(tx, currentContext, run, input, validated, this.options.contentVault,saved.images);
        await tx
          .update(executions)
          .set({
            phase: "completed",
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(executions.runId, id));
      });
      return { id, disposition: "completed" };
    } catch (cause) {
      return withTenant(this.options.database.db, context, async (tx) => {
        const current = await this.currentClaim(tx, run, token);
        if (!current) return { id, disposition: "skipped" };
        const safeCode =
          cause instanceof KnowledgeEvaluationProofError || cause instanceof BenchmarkProofError ? "assist_evaluation_proof_invalid" : cause instanceof HarnessContractError
            ? `assist_${cause.code}`
            : cause instanceof z.ZodError || cause instanceof SyntaxError
              ? "assist_invalid_result"
              : cause instanceof Error &&
                  /^model_output_(truncated|missing|invalid_json)$/.test(cause.message)
                ? `assist_${cause.message}`
                : cause instanceof Error && /^assist_[a-z_]+$/.test(cause.message)
                  ? cause.message
                  : null;
        if (current.encryptedResponse && !safeCode && current.attemptCount < 3) {
          await tx
            .update(executions)
            .set({
              phase: "response_ready",
              leaseToken: null,
              leaseExpiresAt: null,
              nextAttemptAt: sql`clock_timestamp()+interval '1 minute'`,
              updatedAt: new Date(),
            })
            .where(eq(executions.runId, id));
          await tx
            .update(runs)
            .set({ errorCode: "assist_local_retry_pending" })
            .where(eq(runs.id, id));
          return { id, disposition: "recovery_pending" };
        }
        const failureOutput =
          cause instanceof AssistInputChangedError
            ? this.options.contentVault.encrypt(
                JSON.stringify({
                  result: null,
                  images: [],
                  diagnostics: [
                    `执行依据已变化：${[...new Set(cause.resources.map(assistAuthorityResourceLabel))].join("、")}；请重新读取当前资料。`,
                  ],
                }),
              )
            : undefined;
        const uncertain = current.submissionState !== "not_submitted" && !current.encryptedResponse;
        const code = uncertain
          ? "assist_submission_unknown"
          : (safeCode ?? "assist_local_processing_failed");
        await tx
          .update(runs)
          .set({
            status: "failed",
            errorCode: code,
            completedAt: new Date(),
            ...(failureOutput ? { encryptedOutput: failureOutput } : {}),
          })
          .where(eq(runs.id, id));
        await tx
          .update(executions)
          .set({
            phase: uncertain ? "uncertain" : "failed",
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(executions.runId, id));
        if (current.submissionState === "not_submitted") await releaseReservation(tx, id);
        return { id, disposition: "failed", code };
      });
    }
  }

  private async currentClaim(tx: TenantTransaction, run: Run, token: string) {
    const [currentRun] = await tx.select().from(runs).where(eq(runs.id, run.id)).for("update");
    const [execution] = await tx
      .select()
      .from(executions)
      .where(eq(executions.runId, run.id))
      .for("update");
    const now = await leaseClock(tx);
    return currentRun?.status === "running" &&
      currentRun.expiresAt > new Date() &&
      execution?.leaseToken === token &&
      execution.leaseExpiresAt &&
      execution.leaseExpiresAt > now
      ? execution
      : null;
  }
  private async assertClaim(tx: TenantTransaction, run: Run, token: string) {
    if (!(await this.currentClaim(tx, run, token))) throw new Error("assist_lease_lost");
  }
}

async function releaseReservation(tx: TenantTransaction, id: string) {
  await tx
    .update(aiBudgetLedger)
    .set({ state: "released" })
    .where(and(eq(aiBudgetLedger.requestId, id), eq(aiBudgetLedger.state, "reserved")));
}
async function settleResponse(tx: TenantTransaction, run: Run, response: ModelResponseCheckpoint) {
  const usageKnown = response.inputTokens !== null && response.outputTokens !== null;
  const costKnown =
    usageKnown &&
    run.modelSnapshot.inputUsdPerMillion !== null &&
    run.modelSnapshot.outputUsdPerMillion !== null &&
    response.costUsd !== null;
  await tx
    .update(runs)
    .set({
      inputTokens: usageKnown ? response.inputTokens : null,
      outputTokens: usageKnown ? response.outputTokens : null,
      costUsd: costKnown ? response.costUsd!.toFixed(6) : null,
    })
    .where(eq(runs.id, run.id));
  if (costKnown)
    await tx
      .update(aiBudgetLedger)
      .set({ state: "committed", amountUsd: response.costUsd!.toFixed(6) })
      .where(and(eq(aiBudgetLedger.requestId, run.id), eq(aiBudgetLedger.state, "reserved")));
}
export async function expireAssistInTransaction(
  tx: TenantTransaction,
  run: Run,
  execution: Execution,
) {
  await tx
    .update(runs)
    .set({
      encryptedInput: null,
      encryptedOutput: null,
      ...(["queued", "running"].includes(run.status)
        ? { status: "failed" as const, errorCode: "assist_expired", completedAt: new Date() }
        : {}),
    })
    .where(eq(runs.id, run.id));
  await tx
    .update(executions)
    .set({
      encryptedResponse: null,
      updatedAt: new Date(),
      ...(!terminal(execution.phase)
        ? {
            phase:
              execution.submissionState === "not_submitted"
                ? ("failed" as const)
                : ("uncertain" as const),
            leaseToken: null,
            leaseExpiresAt: null,
          }
        : {}),
    })
    .where(eq(executions.runId, run.id));
  if (execution.submissionState === "not_submitted") await releaseReservation(tx, run.id);
}
