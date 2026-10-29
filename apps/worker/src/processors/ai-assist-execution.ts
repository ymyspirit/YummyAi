import { createHash } from "node:crypto";
import {
  assistHarness,
  assistUsesReviewedGuidance,
  HarnessContractError,
  ASSIST_LEGACY_MAX_OUTPUT_TOKENS,
  assistPromptVersion,
  assistResultSchema,
  isBenchmarkAssist,
  BenchmarkProofError,
  assistFingerprint,
  assistExecutionPolicy,
  assessPaidRequestRecovery,
  decodeModelResponse,
  ModelResponseCheckpointSchema,
  normalizeModelTokenUsage,
  validateAssistResult,
  type AssistContext,
  type ModelProvider,
  type ModelResult,
  type ModelResponseCheckpoint,
  type SecretVault,
  KnowledgeEvaluationProofError,
} from "@yummyai/ai-core";
import { isDeepStrictEqual } from "node:util";
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
      const policy=assistExecutionPolicy(!!input.artworkAudit, benchmark, run.kind === "order_review", input.outputTokenPolicy === "provider");
      if (policy.contractVersion !== execution.contractVersion || policy.checksum !== execution.policyChecksum)
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
        const submittedAt=new Date();
        await withTenant(this.options.database.db, context, async (tx) => {
          await this.assertClaim(tx, run, token);
          await assertEvaluationExecution(tx, context, run, input, this.options.contentVault);
          await assertBusinessBenchmarkExecution(tx, context, run, input, this.options.contentVault);
          await tx
            .update(executions)
            .set({
              submissionState: "submitted",
              submittedAt,
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
            maxOutputTokens: input.outputTokenPolicy === "provider" ? null : ASSIST_LEGACY_MAX_OUTPUT_TOKENS,
            onResponseCheckpoint: async (response) => {
              const value: SavedResponse = {
                response: ModelResponseCheckpointSchema.parse(response),
                images,
                diagnostics,
              };
              if(response.modelKey!==run.modelSnapshot.model || response.providerId!==model.providerId)throw new Error("assist_response_identity_invalid");
              let raw:string|undefined;
              try {raw=JSON.stringify(value);} catch { /* Usage still belongs to the original submitted call. */ }
              const responseChecksum=checksum(raw??JSON.stringify({...value.response,payload:null}));
              await this.captureResponse(context,run,execution,token,submittedAt,value.response,responseChecksum);
              if(raw===undefined)throw new Error("assist_response_invalid");
              if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
                throw new Error("assist_response_too_large");
              const encryptedResponse = this.options.contentVault.encrypt(raw);
              await this.captureResponse(context,run,execution,token,submittedAt,value.response,responseChecksum,encryptedResponse);
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
        await settleAssistResponse(tx, run, saved.response);
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
                : cause instanceof Error && /^model_response_(incomplete|invalid)$/.test(cause.message)
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

  /** The original submission can report usage after cancellation; it cannot regain adoption authority. */
  private async captureResponse(context:TenantContext,run:Run,original:Execution,token:string,submittedAt:Date,response:ModelResponseCheckpoint,responseChecksum:string,encryptedResponse?:string) {
    await withTenant(this.options.database.db,context,async tx=>{
      const [currentRun]=await tx.select().from(runs).where(and(eq(runs.id,run.id),eq(runs.ownerId,context.userId))).for("update");
      const [current]=await tx.select().from(executions).where(eq(executions.runId,run.id)).for("update");
      if(!currentRun || currentRun.requestId!==run.requestId || currentRun.inputFingerprint!==run.inputFingerprint || !current
        || current.inputFingerprint!==original.inputFingerprint || current.policyChecksum!==original.policyChecksum || current.contractVersion!==original.contractVersion
        || current.submissionState==="not_submitted" || current.submittedAt?.getTime()!==submittedAt.getTime())throw new Error("assist_response_identity_invalid");
      if(current.receivedAt && (current.responseChecksum!==responseChecksum || current.providerRequestId!==response.providerRequestId
        || current.receivedAt.getTime()!==Date.parse(response.receivedAt)))throw new Error("assist_response_changed");
      const now=await leaseClock(tx);
      const active=currentRun.status==="running"&&!terminal(current.phase)&&current.leaseToken===token
        &&current.attemptCount===original.attemptCount+1&&!!current.leaseExpiresAt&&current.leaseExpiresAt>now;
      const expiredOriginalClaim=currentRun.status==="running"&&!terminal(current.phase)&&current.leaseToken===token
        &&current.attemptCount===original.attemptCount+1&&!!current.leaseExpiresAt&&current.leaseExpiresAt<=now&&!current.encryptedResponse;
      if(expiredOriginalClaim){
        // A late first receipt cannot revive or settle an expired submission.
        // Retain its evidence behind the same uncertainty fence as a second delivery.
        await tx.update(executions).set({phase:"uncertain",leaseToken:null,leaseExpiresAt:null,updatedAt:now}).where(eq(executions.runId,run.id));
        await tx.update(runs).set({status:"failed",errorCode:"assist_submission_unknown",completedAt:now}).where(eq(runs.id,run.id));
      }
      const retainPrivate=currentRun.expiresAt>now&&currentRun.encryptedInput!==null;
      const mayRetainCheckpoint=active||expiredOriginalClaim||terminal(current.phase)||["completed","failed","cancelled"].includes(currentRun.status);
      await tx.update(executions).set({
        ...(!current.receivedAt?{submissionState:"received" as const,receivedAt:new Date(response.receivedAt),providerRequestId:response.providerRequestId,responseChecksum}:{}),
        ...(encryptedResponse&&retainPrivate&&mayRetainCheckpoint&&!current.encryptedResponse?{encryptedResponse}:{}),
        ...(active&&encryptedResponse&&retainPrivate?{phase:"response_ready" as const}:{}),updatedAt:now,
      }).where(eq(executions.runId,run.id));
      await settleAssistResponse(tx,run,response,true,active?"active_claim":"usage_only");
    });
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
export async function settleAssistResponse(tx: TenantTransaction, run: Run, response: ModelResponseCheckpoint, allowTerminalUsage=false, settlement:"active_claim"|"usage_only"="active_claim") {
  const [current]=await tx.select().from(runs).where(and(eq(runs.id,run.id),eq(runs.ownerId,run.ownerId))).for("update");
  if(!current || current.requestId!==run.requestId || current.inputFingerprint!==run.inputFingerprint)throw new Error("assist_response_identity_invalid");
  if(current.tokenUsage!==null && response.tokenUsage!==undefined && !isDeepStrictEqual(current.tokenUsage,response.tokenUsage))throw new Error("assist_usage_conflict");
  const tokenUsage=current.tokenUsage===null&&response.tokenUsage!=null?{tokenUsage:response.tokenUsage}:{};
  if(["completed","failed","cancelled"].includes(current.status)) {
    if(allowTerminalUsage&&"tokenUsage" in tokenUsage)await tx.update(runs).set(tokenUsage).where(eq(runs.id,run.id));
    return;
  }
  if(settlement==="usage_only"){
    if("tokenUsage" in tokenUsage)await tx.update(runs).set(tokenUsage).where(eq(runs.id,run.id));
    return;
  }
  if(current.status!=="running")throw new Error("assist_lease_lost");
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
      ...tokenUsage,
    })
    .where(eq(runs.id, run.id));
  if (costKnown)
    await tx
      .update(aiBudgetLedger)
      .set({ state: "committed", amountUsd: response.costUsd!.toFixed(6) })
      .where(and(eq(aiBudgetLedger.requestId, run.id), eq(aiBudgetLedger.state, "reserved")));
}
/** Compatibility adapters may return usage without implementing a response checkpoint callback. */
export function assistResultReceipt(result:ModelResult<unknown>):ModelResponseCheckpoint {
  const known=result.usageReported===true&&Number.isSafeInteger(result.inputTokens)&&result.inputTokens>=0&&Number.isSafeInteger(result.outputTokens)&&result.outputTokens>=0;
  return ModelResponseCheckpointSchema.parse({version:"model-response-v1",providerId:result.providerId,modelKey:result.modelKey,providerRequestId:result.providerRequestId??null,payload:result.value,
    inputTokens:known?result.inputTokens:null,outputTokens:known?result.outputTokens:null,costUsd:result.costUsd!==null&&Number.isFinite(result.costUsd)&&result.costUsd>=0?result.costUsd:null,
    tokenUsage:result.tokenUsage??(known?normalizeModelTokenUsage({input_tokens:result.inputTokens,output_tokens:result.outputTokens}):null),receivedAt:result.completedAt.toISOString()});
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
