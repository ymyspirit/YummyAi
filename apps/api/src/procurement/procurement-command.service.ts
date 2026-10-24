import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentCommandBindingSchema, type AgentCommandBinding, type AgentCommandOwnerReference } from "@yummyai/contracts/ai/agent-command";
import {
  PrepareProcurementCommandSchema, ProcurementCommandQuerySchema, ProcurementCommandViewSchema, ProcurementCommandListSchema,
  ProcurementCommandScopeSchema,
  type PrepareProcurementCommand, type ProcurementCommandScope, type ProcurementCommandView,
} from "@yummyai/contracts/procurement/procurement-command";
import { procurementCommands as commands, expireProcurementCommandInputs, loadCurrentMembershipContext,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PROCUREMENT_COMMAND_VAULT } from "../platform.tokens.js";
import { retryDatabaseTimeRollback } from "../database-time-retry.js";
import { ProcurementService } from "./procurement.service.js";
import { procurementCommandBinding } from "./procurement-original-request.js";

type Command = typeof commands.$inferSelect;
const scopeOf = (row: Command): ProcurementCommandScope => ({ kind: row.kind, targetId: row.targetId });
const commandIdSchema = z.uuidv7().transform(value => value.toLowerCase());
function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException("采购原请求参数无效 请重新核对");
  return parsed.data;
}
function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }

/** Retains an original transport and delegates every actual fact to its owner. */
@Injectable()
export class ProcurementCommandService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PROCUREMENT_COMMAND_VAULT) private readonly vault: SecretVault,
    @Inject(ProcurementService) private readonly owner: ProcurementService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  /** Exact metadata lookup after a lost preparation response. Never expire or decrypt an original here. */
  locateForAgent(context: TenantContext, raw: AgentCommandBinding): Promise<AgentCommandOwnerReference | null> {
    const binding = input(AgentCommandBindingSchema, raw);
    if (binding.domain !== "procurement" || binding.accountId !== null) throw new BadRequestException("采购原命令定位范围不正确");
    const scope = input(ProcurementCommandScopeSchema, { kind: binding.kind, targetId: binding.targetId });
    return this.withCurrent(context, async (tx, current) => {
      const [row] = await tx.select({ id: commands.id, kind: commands.kind, targetId: commands.targetId }).from(commands).where(and(
        eq(commands.tenantId, current.tenantId), eq(commands.createdBy, current.userId), eq(commands.kind, scope.kind),
        scope.targetId === null ? isNull(commands.targetId) : eq(commands.targetId, scope.targetId),
        eq(commands.requestChecksum, binding.ownerRequestChecksum),
        sql`encode(sha256(convert_to(${commands.requestKey},'UTF8')),'hex')=${binding.requestKeyHash}`,
      )).limit(1);
      if (!row) return null;
      await this.owner.readCommandTargetInTransaction(tx, current, { kind: row.kind, targetId: row.targetId });
      return { domain: "procurement", commandId: row.id, accountId: null };
    });
  }

  prepare(context: TenantContext, raw: unknown) {
    const original = input(PrepareProcurementCommandSchema, raw), binding = procurementCommandBinding(original);
    return this.withCurrent(context, async (tx, current) => {
      // The actual owner and retained transports share one operation/key lock.
      await this.keyLock(tx, current, binding.operation, binding.idempotencyKey);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-command-slot:${current.tenantId}:${current.userId}:${original.kind}:${original.targetId ?? "root"}`},0))`);
      const [old] = await tx.select().from(commands).where(and(eq(commands.operation, binding.operation), eq(commands.requestKey, binding.idempotencyKey))).for("update");
      if (old) {
        if (old.createdBy !== current.userId || old.kind !== original.kind || old.targetId !== original.targetId || old.requestChecksum !== binding.requestChecksum)
          conflict("procurement_original_mismatch", "原采购请求已绑定其他操作者 业务对象或填写 请先核对原记录");
        await expireProcurementCommandInputs(tx, { actorId: current.userId, commandId: old.id });
        return this.view(tx, current, await this.row(tx, current, old.id));
      }
      const [pending] = await tx.select({ id: commands.id }).from(commands).where(and(eq(commands.kind, original.kind),
        original.targetId ? eq(commands.targetId, original.targetId) : isNull(commands.targetId),
        eq(commands.createdBy, current.userId), isNull(commands.acknowledgedAt)));
      if (pending) conflict("procurement_original_unacknowledged", "请先恢复并核对上一笔原采购提交的结果");
      await this.owner.validateCommandInTransaction(tx, current, original);
      const [saved] = await tx.insert(commands).values({ id: createEntityId(), tenantId: current.tenantId, createdBy: current.userId,
        kind: original.kind, operation: binding.operation, targetId: original.targetId,
        requestKey: binding.idempotencyKey, requestChecksum: binding.requestChecksum, authoritySnapshot: current,
        encryptedInput: this.vault.encrypt(canonicalJson(original)), expiresAt: sql`clock_timestamp()+interval '7 days'` }).returning();
      await this.record(tx, current, saved!, "prepare");
      return this.view(tx, current, saved!);
    });
  }

  list(context: TenantContext, raw: unknown) {
    const query = input(ProcurementCommandQuerySchema, raw);
    return this.withCurrent(context, async (tx, current) => {
      const rows = await tx.select().from(commands).where(and(eq(commands.createdBy, current.userId), isNull(commands.acknowledgedAt),
        query.kind ? eq(commands.kind, query.kind) : undefined,
        query.targetId ? eq(commands.targetId, query.targetId) : undefined,
        query.before ? sql`${commands.id}<${query.before}::uuid` : undefined)).orderBy(desc(commands.id)).limit(51);
      const items: ProcurementCommandView[] = [];
      let unavailableCount = 0;
      // Advance over the immutable raw page even if a source is no longer readable.
      // No one inaccessible row can starve recovery of older accessible originals.
      for (const row of rows.slice(0, 50)) {
        try { items.push(await this.view(tx, current, await this.currentRow(tx, current, row.id))); }
        catch (error) {
          if (error instanceof ForbiddenError || error instanceof NotFoundException) unavailableCount++;
          else throw error;
        }
      }
      return ProcurementCommandListSchema.parse({ items, unavailableCount,
        nextCursor: rows.length > 50 ? rows[49]!.id : null, contextAuthority: catalogContextAuthority(current) });
    });
  }

  get(context: TenantContext, id: string) {
    const commandId = input(commandIdSchema, id);
    return this.withCurrent(context, async (tx, current) => this.view(tx, current, await this.currentRow(tx, current, commandId)));
  }
  execute(context: TenantContext, id: string) {
    const commandId = input(commandIdSchema, id);
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, commandId);
      if (row.status !== "prepared") return this.view(tx, current, row);
      // Read admission precedes decrypting the retained private filling.
      await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row));
      let original: PrepareProcurementCommand;
      try { original = this.original(row); }
      catch { conflict("procurement_original_unavailable", "原填写暂时不可用 已停止执行 请重新读取或取消这笔准备"); }
      const ceiling = intersectPermissionContexts(TenantContextSchema.parse(row.authoritySnapshot), current);
      await tx.execute(sql`select set_config('app.procurement_command_id',${row.id},true)`);
      // One top-level transaction binds actual owner facts and their proof domain.
      const resultProofId = await this.owner.executeCommandInTransaction(tx, ceiling, original);
      const proof = row.kind === "invoice_reconcile" ? { reconciliationResultProofId: resultProofId } : row.kind === "invoice_record" ? { invoiceResultProofId: resultProofId } : { resultProofId };
      const [saved] = await tx.update(commands).set({ status: "succeeded", ...proof, completedAt: sql`clock_timestamp()` })
        .where(eq(commands.id, row.id)).returning();
      await this.record(tx, current, saved!, "execute");
      return this.view(tx, current, saved!);
    });
  }
  cancel(context: TenantContext, id: string) {
    const commandId = input(commandIdSchema, id);
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, commandId);
      await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row));
      if (row.status !== "prepared") return this.view(tx, current, row);
      const [saved] = await tx.update(commands).set({ status: "cancelled", completedAt: sql`clock_timestamp()`, encryptedInput: null,
        redactedAt: sql`clock_timestamp()` }).where(eq(commands.id, row.id)).returning();
      await this.record(tx, current, saved!, "cancel");
      return this.view(tx, current, saved!);
    });
  }
  acknowledge(context: TenantContext, id: string) {
    const commandId = input(commandIdSchema, id);
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, commandId);
      await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row), { resultProofId: row.reconciliationResultProofId ?? row.invoiceResultProofId ?? row.resultProofId });
      if (row.status === "prepared") conflict("procurement_original_pending", "原采购提交仍待核对 请先执行或取消");
      if (row.acknowledgedAt) return this.view(tx, current, row);
      const [saved] = await tx.update(commands).set({ acknowledgedAt: sql`clock_timestamp()`, encryptedInput: null,
        redactedAt: sql`coalesce(${commands.redactedAt},clock_timestamp())` }).where(eq(commands.id, row.id)).returning();
      await this.record(tx, current, saved!, "acknowledge");
      return this.view(tx, current, saved!);
    });
  }

  private original(row: Command) {
    if (!row.encryptedInput || row.contractVersion !== "procurement-command-v1") throw new Error("Original procurement input unavailable");
    const authority = TenantContextSchema.parse(row.authoritySnapshot);
    if (authority.tenantId !== row.tenantId || authority.userId !== row.createdBy) throw new Error("Original procurement authority differs");
    const original = this.vault.withSecret(row.encryptedInput, text => PrepareProcurementCommandSchema.parse(JSON.parse(text)));
    const binding = procurementCommandBinding(original);
    if (original.kind !== row.kind || original.targetId !== row.targetId || binding.operation !== row.operation ||
      binding.idempotencyKey !== row.requestKey || binding.requestChecksum !== row.requestChecksum) throw new Error("Original procurement proof differs");
    return original;
  }
  private async view(tx: TenantTransaction, current: TenantContext, row: Command) {
    await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row), { resultProofId: row.reconciliationResultProofId ?? row.invoiceResultProofId ?? row.resultProofId });
    let original: PrepareProcurementCommand | null = null;
    let blockReason: ProcurementCommandView["blockReason"] = row.status === "expired" ? "expired" : null;
    if (row.encryptedInput) { try { original = this.original(row); } catch { blockReason = "input_unavailable"; } }
    const target = await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row), { original: original ?? undefined, resultProofId: row.reconciliationResultProofId ?? row.invoiceResultProofId ?? row.resultProofId });
    let reviewBasis: ProcurementCommandView["reviewBasis"] = null;
    if (original) {
      try { reviewBasis = await this.owner.reviewCommandBasisInTransaction(tx, current, original); }
      catch (error) {
        if (error instanceof ForbiddenError) blockReason = "permission_denied";
        else if (error instanceof ConflictException || error instanceof NotFoundException) blockReason = "basis_changed";
        else throw error;
      }
    }
    if (row.status === "prepared" && !original) blockReason = "input_unavailable";
    if (row.status === "prepared" && original && !blockReason) {
      const ceiling = intersectPermissionContexts(TenantContextSchema.parse(row.authoritySnapshot), current);
      try { await this.owner.validateCommandInTransaction(tx, ceiling, original); }
      catch (error) {
        if (error instanceof ForbiddenError) blockReason = "permission_denied";
        else if (error instanceof ConflictException || error instanceof NotFoundException) blockReason = "basis_changed";
        else throw error;
      }
    }
    const proofId = row.reconciliationResultProofId ?? row.invoiceResultProofId ?? row.resultProofId;
    const result = proofId ? await this.owner.readCommandResultInTransaction(tx, current, row.kind, proofId) : null;
    const invoiceResult = row.invoiceResultProofId ? await this.owner.readCommandInvoiceResultInTransaction(tx, current, row.invoiceResultProofId) : null;
    const reconciliationResult = row.reconciliationResultProofId ? await this.owner.readCommandReconciliationResultInTransaction(tx, current, row.reconciliationResultProofId) : null;
    return ProcurementCommandViewSchema.parse({ id: row.id, kind: row.kind, targetId: row.targetId, ...target,
      status: row.status, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
      contextAuthority: catalogContextAuthority(current), acknowledged: Boolean(row.acknowledgedAt),
      canExecute: row.status === "prepared" && Boolean(original) && blockReason === null, canCancel: row.status === "prepared",
      original, result, blockReason, reviewBasis, ...(row.kind === "invoice_record" ? { invoiceResult } : {}),
      ...(row.kind === "invoice_reconcile" ? { reconciliationResult } : {}) });
  }
  private async currentRow(tx: TenantTransaction, current: TenantContext, id: string) {
    // Match the actual owner's key-before-row lock order to avoid raw/execute deadlocks.
    const [peek] = await tx.select().from(commands).where(and(eq(commands.id, id), eq(commands.createdBy, current.userId)));
    if (!peek) throw new NotFoundException("本人的原采购提交不存在");
    await this.keyLock(tx, current, peek.operation, peek.requestKey);
    await this.row(tx, current, id);
    // Target the requested row, including originals older than a 100-row batch.
    await expireProcurementCommandInputs(tx, { actorId: current.userId, commandId: id, limit: 1 });
    return this.row(tx, current, id);
  }
  private async row(tx: TenantTransaction, current: TenantContext, id: string) {
    const [row] = await tx.select().from(commands).where(and(eq(commands.id, id), eq(commands.createdBy, current.userId))).for("update");
    if (!row) throw new NotFoundException("本人的原采购提交不存在");
    authorize(current, Permission.ProcurementRead, { ownerId: row.createdBy });
    return row;
  }
  private keyLock(tx: TenantTransaction, current: TenantContext, operation: string, key: string) {
    return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-original:${current.tenantId}:${operation}:${key}`},0))`);
  }
  private withCurrent<T>(context: TenantContext, apply: (tx: TenantTransaction, current: TenantContext) => Promise<T>) {
    return retryDatabaseTimeRollback(() => withTenant(this.database.db, context, async tx => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      authorize(current, Permission.ProcurementRead);
      return apply(tx, current);
    }), "procurement_commands_time");
  }
  private record(tx: TenantTransaction, current: TenantContext, row: Command, action: string) {
    return this.audit.recordInTransaction(tx, current, { action: `procurement.command.${action}`, resourceType: "procurement_command", resourceId: row.id,
      result: "success", metadata: { kind: row.kind, targetId: row.targetId, resultProofId: row.resultProofId,
        ...(row.kind === "invoice_record" ? { invoiceResultProofId: row.invoiceResultProofId } : {}),
        ...(row.kind === "invoice_reconcile" ? { reconciliationResultProofId: row.reconciliationResultProofId } : {}) } });
  }
}
