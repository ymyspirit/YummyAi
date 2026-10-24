import { authorize, Permission, requireAssetAuthority, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  CreativeExecutionHistorySchema, CreativeExecutionViewSchema, CreativeHistoryQuerySchema,
  CreativeOperatorCommandSchema, CreativeOperatorEventSchema,
  type CreativeHistoryScope, type CreativeExecutionView,
} from "@yummyai/contracts/harness/creative-operator";
import {
  aiBudgetLedger, assetFiles, auditEvents, creativeDesignBatchItems, creativeDesignCandidates,
  creativeDesignVersions, creativeExecutions, creativeExecutionChecksum, creativeStudioGenerations,
  mockupBatches, mockupBatchItems, mockupTemplateSourceInspections, recordAuditInTransaction, withTenant,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { admitCreativeExecution } from "./creative-execution-admission.js";
import type { CreativeOperation } from "./creative-execution-input.js";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  creativeOwnerFilter, requireBatchAccess, requireCreativeVersionAccess,
  currentCreativeAuthority as currentDesignAuthority,
} from "@yummyai/catalog-core";

export class CreativeExecutionOperatorOwnerError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(readonly status: 404 | 409, readonly body: string) {
    super(body);
    this.name = "CreativeExecutionOperatorOwnerError";
    this.statusCode = status;
    this.code = status === 404 ? "creative_execution_not_found" : "creative_execution_conflict";
  }
}

type Execution = typeof creativeExecutions.$inferSelect;
const entityType = "creative_execution";
const actionPrefix = "creative.execution.operator.";
const terminal = new Set(["completed", "failed", "uncertain"]);
const ownerId = (row: Execution) => row.candidateId ?? row.creativeVersionId ?? row.inspectionId ?? row.mockupItemId ?? row.studioGenerationId!;
const operation = (row: Execution): CreativeOperation => ({ kind: row.kind, ownerId: ownerId(row), stepKey: row.stepKey });
const usd = (value?: string | null) => value == null ? null : `${value.split(".")[0]}.${(value.split(".")[1] ?? "").padEnd(8, "0")}`;

// Excludes dispatch scheduling fields: two requests cannot replenish attempts or change the original inputs.
function fingerprint(row: Execution) {
  return creativeExecutionChecksum({ id: row.id, phase: row.phase, attempts: row.attemptCount, input: row.inputFingerprint,
    submittedAt: row.submittedAt, receipt: row.receipt, responseChecksum: row.responseChecksum,
    responsePurgedAt: row.responsePurgedAt, completionChecksum: row.completionChecksum, errorCode: row.errorCode,
    leaseToken: row.leaseToken, leaseExpiresAt: row.leaseExpiresAt });
}

export class CreativeExecutionOperatorOwner {
  constructor(private readonly database: DatabaseConnection) {}

  async history(context: TenantContext, scope: CreativeHistoryScope, id: string, rawQuery: unknown = {}) {
    const query = CreativeHistoryQuerySchema.parse(rawQuery);
    return withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
      const subject = await this.scope(tx, authority, scope, id);
      const rows = await tx.select().from(creativeExecutions).where(and(subject.filter,
        query.after ? lt(creativeExecutions.id, query.after) : undefined)).orderBy(desc(creativeExecutions.id)).limit(21);
      const entries: CreativeExecutionView[] = [];
      for (const row of rows.slice(0, 20)) {
        const owning = row.creativeVersionId
          ? await requireCreativeVersionAccess(tx, authority, row.creativeVersionId, [Permission.DesignRead]) : null;
        entries.push(await this.view(tx, authority, checkedAt, row, owning ? owning.version.createdBy : subject.owner));
      }
      return CreativeExecutionHistorySchema.parse({ scope, ownerId: id, entries, nextCursor: rows.length > 20 ? entries.at(-1)!.id : null });
    });
  }

  async act(context: TenantContext, id: string, rawInput: unknown) {
    const command = CreativeOperatorCommandSchema.parse(rawInput);
    return withTenant(this.database.db, context, async tx => {
      const required = command.action === "request_recovery" ? Permission.DesignWrite : Permission.DesignReview;
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead, required]);
      const [row] = await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, id)).for("update");
      if (!row) throw new CreativeExecutionOperatorOwnerError(404, "创作执行记录不存在");
      const subject = await this.executionScope(tx, authority, row);
      authorize(authority, required, { ownerId: subject.owner });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${command.commandId}:creative-operator`},0))`);
      const requestChecksum = creativeExecutionChecksum({ id, command });
      const [existing] = await tx.select().from(auditEvents).where(and(eq(auditEvents.entityType, entityType),
        sql`${auditEvents.metadata}->>'commandId'=${command.commandId}`)).limit(1);
      if (existing) {
        if (existing.entityId !== id || existing.actorUserId !== context.userId || existing.metadata.requestChecksum !== requestChecksum)
          throw new CreativeExecutionOperatorOwnerError(409, "此核对编号已用于其他操作");
        return this.event(existing);
      }
      if (command.expectedFingerprint !== fingerprint(row)) throw new CreativeExecutionOperatorOwnerError(409, "执行记录已变化 请刷新后核对");
      if (command.action === "request_recovery") {
        const blockers = await this.blockers(tx, authority, checkedAt, row, subject.owner);
        if (blockers.length) throw new CreativeExecutionOperatorOwnerError(409, blockers.join("；"));
        // Reuse the Worker's exact original membership, source, method, route and budget ceilings.
        // This only makes the existing record due. It never calls a provider or creates another job owner.
        try { await admitCreativeExecution(tx, { tenantId: context.tenantId, userId: context.userId }, operation(row)); }
        catch (error) {
          if (error instanceof Error && "status" in error && error.status === 409) throw new CreativeExecutionOperatorOwnerError(409, error.message);
          throw error;
        }
        await tx.update(creativeExecutions).set({ nextAttemptAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
          .where(eq(creativeExecutions.id, id));
      }
      const eventId = await recordAuditInTransaction(tx, context, {
        action: actionPrefix + command.action, resourceType: entityType, resourceId: id, result: "success",
        metadata: { commandId: command.commandId, requestChecksum, basisFingerprint: command.expectedFingerprint,
          ...(command.action === "record_check" ? { finding: command.finding, proofChecksum: command.proofChecksum } : {}),
          verification: "operator_attested", changesProviderState: false, changesBilling: false },
      });
      const [event] = await tx.select().from(auditEvents).where(eq(auditEvents.id, eventId));
      return this.event(event!);
    });
  }

  private async scope(tx: TenantTransaction, authority: TenantContext, scope: CreativeHistoryScope, id: string) {
    if (scope === "design_batch") {
      const batch = await requireBatchAccess(tx, authority, id, [Permission.DesignRead]);
      const candidates = tx.select({ id: creativeDesignCandidates.id }).from(creativeDesignCandidates)
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId)).where(eq(creativeDesignBatchItems.batchId, id));
      const versions = tx.select({ id: creativeDesignVersions.id }).from(creativeDesignVersions)
        .innerJoin(creativeDesignCandidates, eq(creativeDesignCandidates.id, creativeDesignVersions.sourceCandidateId))
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId))
        .where(and(eq(creativeDesignBatchItems.batchId, id), creativeOwnerFilter(authority, Permission.DesignRead, creativeDesignVersions.createdBy)));
      return { owner: batch.createdBy, filter: or(inArray(creativeExecutions.candidateId, candidates), inArray(creativeExecutions.creativeVersionId, versions))! };
    }
    if (scope === "inspection") {
      const [inspection] = await tx.select().from(mockupTemplateSourceInspections).where(eq(mockupTemplateSourceInspections.id, id));
      if (!inspection) throw new CreativeExecutionOperatorOwnerError(404, "模板检查记录不存在");
      authorize(authority, Permission.DesignRead, { ownerId: inspection.requestedBy });
      const [source] = await tx.select().from(assetFiles).where(eq(assetFiles.id, inspection.sourceAssetId));
      if (!source) throw new CreativeExecutionOperatorOwnerError(404, "原模板资料不存在");
      requireAssetAuthority(authority, Permission.AssetRead, source);
      return { owner: inspection.requestedBy, filter: eq(creativeExecutions.inspectionId, id) };
    }
    if (scope === "mockup_batch") {
      const [batch] = await tx.select().from(mockupBatches).where(eq(mockupBatches.id, id));
      if (!batch) throw new CreativeExecutionOperatorOwnerError(404, "套图批次不存在");
      authorize(authority, Permission.DesignRead, { ownerId: batch.createdBy });
      return { owner: batch.createdBy, filter: inArray(creativeExecutions.mockupItemId,
        tx.select({ id: mockupBatchItems.id }).from(mockupBatchItems).where(eq(mockupBatchItems.batchId, id))) };
    }
    const [generation] = await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, id));
    if (!generation) throw new CreativeExecutionOperatorOwnerError(404, "生成记录不存在");
    authorize(authority, Permission.DesignRead, { ownerId: generation.ownerId });
    if (generation.scope !== "unassigned") await requireBatchAccess(tx, authority, generation.scope, [Permission.DesignRead], { canvas: true });
    return { owner: generation.ownerId, filter: eq(creativeExecutions.studioGenerationId, id) };
  }

  private async executionScope(tx: TenantTransaction, authority: TenantContext, row: Execution) {
    if (row.inspectionId) return this.scope(tx, authority, "inspection", row.inspectionId);
    if (row.studioGenerationId) return this.scope(tx, authority, "studio_generation", row.studioGenerationId);
    if (row.mockupItemId) {
      const [item] = await tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.id, row.mockupItemId));
      if (!item) throw new CreativeExecutionOperatorOwnerError(404, "原套图款式不存在");
      return this.scope(tx, authority, "mockup_batch", item.batchId);
    }
    if (row.creativeVersionId) {
      const { batch, version } = await requireCreativeVersionAccess(tx, authority, row.creativeVersionId, [Permission.DesignRead]);
      const subject = await this.scope(tx, authority, "design_batch", batch.id);
      return { ...subject, owner: version.createdBy };
    }
    const candidates = tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignCandidates)
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId));
    const [source] = row.candidateId ? await candidates.where(eq(creativeDesignCandidates.id, row.candidateId))
      : await tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignVersions)
        .innerJoin(creativeDesignCandidates, eq(creativeDesignCandidates.id, creativeDesignVersions.sourceCandidateId))
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId)).where(eq(creativeDesignVersions.id, row.creativeVersionId!));
    if (!source) throw new CreativeExecutionOperatorOwnerError(404, "原创作项目不存在");
    return this.scope(tx, authority, "design_batch", source.batchId);
  }

  private allowed(authority: TenantContext, permission: PermissionValue, owner: string | null) {
    try { authorize(authority, permission, { ownerId: owner }); return true; }
    catch (error) { if (error instanceof Error && "status" in error && error.status === 403) return false; throw error; }
  }

  private async blockers(tx: TenantTransaction, authority: TenantContext, checkedAt: number, row: Execution, owner: string | null) {
    const result: string[] = [];
    if (!this.allowed(authority, Permission.DesignWrite, owner)) result.push("需要当前项目的创作写入权限");
    if (row.requestedBy !== authority.userId) result.push("须由原申请人申请续做");
    if (terminal.has(row.phase)) result.push("终态只可核对 不可重置或重复提交");
    if (row.attemptCount >= 3) result.push("原本地处理次数已用尽");
    if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > checkedAt) result.push("原执行仍持有有效租约");
    if (row.responsePurgedAt || (row.responseExpiresAt && row.responseExpiresAt.getTime() <= checkedAt)) result.push("原响应已过保留期");
    if (row.submittedAt && !row.responseObjectKey) {
      const [generation] = row.studioGenerationId ? await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, row.studioGenerationId)) : [];
      if (generation?.modelSnapshot.capability !== "video" || !generation.providerTaskId || !/^[a-zA-Z0-9_-]{1,160}$/.test(generation.providerTaskId))
        result.push("原提交结果不明 需要人工核对渠道");
    }
    return result;
  }

  private async view(tx: TenantTransaction, authority: TenantContext, checkedAt: number, row: Execution, owner: string | null) {
    const [budget] = row.budgetLedgerId ? await tx.select().from(aiBudgetLedger).where(and(eq(aiBudgetLedger.id, row.budgetLedgerId),
      eq(aiBudgetLedger.requestId, row.studioGenerationId ?? row.id))) : [];
    const pins = row.completionEvidence?.artifacts ?? [];
    const files = pins.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, pins.map(pin => pin.assetId))) : [];
    const artifacts = pins.filter(pin => {
      const file = files.find(item => item.id === pin.assetId);
      if (!file || file.deletedAt || file.version !== pin.version || file.checksumSha256 !== pin.checksumSha256) return false;
      try { requireAssetAuthority(authority, Permission.AssetRead, file); return true; }
      catch (error) { if (error instanceof Error && "status" in error && error.status === 403) return false; throw error; }
    });
    const events = await tx.select().from(auditEvents).where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, row.id),
      inArray(auditEvents.action, [actionPrefix + "request_recovery", actionPrefix + "record_check"]))).orderBy(desc(auditEvents.id)).limit(11);
    const recoveryBlockers = await this.blockers(tx, authority, checkedAt, row, owner);
    return CreativeExecutionViewSchema.parse({ id: row.id, parentId: row.parentExecutionId, kind: row.kind, stepKey: row.stepKey,
      phase: row.phase, fingerprint: fingerprint(row), inputFingerprint: row.inputFingerprint, method: row.methodSelection,
      processingAttempts: row.attemptCount, dispatches: row.dispatchCount, createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null, receivedAt: row.receipt?.receivedAt ?? null,
      providerRequestId: row.receipt?.providerRequestId ?? null, responseChecksum: row.responseChecksum,
      responseState: row.responsePurgedAt ? "purged" : row.responseExpiresAt && row.responseExpiresAt.getTime() <= checkedAt ? "expired" : row.responseObjectKey ? "retained" : "missing",
      cost: { basis: row.effect === "internal_write" ? "not_applicable" : row.receipt?.costUsd != null ? "processor_reported" : row.submittedAt ? "unknown" : "not_submitted",
        amountUsd: row.receipt?.costUsd ?? null, budgetState: budget?.state ?? null, budgetAmountUsd: usd(budget?.amountUsd), providerInvoiceVerified: false },
      artifacts, unavailableArtifacts: pins.length - artifacts.length, completionChecksum: row.completionChecksum, errorCode: row.errorCode,
      canRequestRecovery: recoveryBlockers.length === 0, recoveryBlockers, canRecordCheck: this.allowed(authority, Permission.DesignReview, owner),
      events: events.slice(0, 10).map(event => this.event(event)), hasMoreEvents: events.length > 10 });
  }

  private event(row: typeof auditEvents.$inferSelect) {
    return CreativeOperatorEventSchema.parse({ id: row.id, action: row.action.slice(actionPrefix.length), recordedAt: row.occurredAt.toISOString(),
      finding: row.metadata.finding ?? null, proofChecksum: row.metadata.proofChecksum ?? null, verification: "operator_attested" });
  }
}
