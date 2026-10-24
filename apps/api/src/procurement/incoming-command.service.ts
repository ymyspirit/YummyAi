import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentCommandBindingSchema, type AgentCommandBinding, type AgentCommandOwnerReference } from "@yummyai/contracts/ai/agent-command";
import {
  PrepareIncomingCommandSchema, IncomingCommandScopeSchema, IncomingCommandViewSchema, IncomingCommandListSchema, IncomingOrderCommandsSchema,
  type PrepareIncomingCommand, type IncomingCommandScope, type IncomingCommandView,
} from "@yummyai/contracts/procurement/incoming-command";
import { incomingCommands as commands, expireIncomingCommandInputs, loadCurrentMembershipContext,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, INCOMING_COMMAND_VAULT } from "../platform.tokens.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { retryDatabaseTimeRollback } from "../database-time-retry.js";

type Command = typeof commands.$inferSelect;
const scopeOf = (row: Command): IncomingCommandScope => ({ kind: row.kind, targetId: row.targetId });
// Identical to the business owner's request proof, including the actual return.
function checksum(command: PrepareIncomingCommand) {
  return createHash("sha256").update(canonicalJson({ version: 1, parent: command.targetId,
    input: command.kind === "return_rejected" ? { postingId: command.postingId, input: command.input } : command.input })).digest("hex");
}
/** The Agent binding uses this same native request checksum, never a second body format. */
export const incomingCommandRequestChecksum = checksum;
function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }

@Injectable()
export class IncomingCommandService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(INCOMING_COMMAND_VAULT) private readonly vault: SecretVault,
    @Inject(IncomingInspectionService) private readonly owner: IncomingInspectionService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  locateForAgent(context: TenantContext, raw: AgentCommandBinding): Promise<AgentCommandOwnerReference | null> {
    const binding = AgentCommandBindingSchema.parse(raw);
    if (binding.domain !== "incoming" || binding.accountId !== null) throw new BadRequestException("来料原命令定位范围不正确");
    const scope = IncomingCommandScopeSchema.parse({ kind: binding.kind, targetId: binding.targetId });
    return this.withCurrent(context, async (tx, current) => {
      const [row] = await tx.select({ id: commands.id, kind: commands.kind, targetId: commands.targetId }).from(commands).where(and(
        eq(commands.tenantId, current.tenantId), eq(commands.createdBy, current.userId), eq(commands.kind, scope.kind), eq(commands.targetId, scope.targetId),
        eq(commands.requestChecksum, binding.ownerRequestChecksum),
        sql`encode(sha256(convert_to(${commands.requestKey},'UTF8')),'hex')=${binding.requestKeyHash}`,
      )).limit(1);
      if (!row) return null;
      await this.owner.readCommandTargetInTransaction(tx, current, { kind: row.kind, targetId: row.targetId });
      return { domain: "incoming", commandId: row.id, accountId: null };
    });
  }

  prepare(context: TenantContext, raw: unknown) {
    const original = PrepareIncomingCommandSchema.parse(raw), proof = checksum(original);
    return this.withCurrent(context, async (tx, current) => {
      // The key binds kind, actor, target, secondary target and normalized body.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`incoming-command-key:${current.tenantId}:${original.kind}:${original.input.idempotencyKey}`},0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`incoming-command-slot:${current.tenantId}:${current.userId}:${original.kind}:${original.targetId}`},0))`);
      await expireIncomingCommandInputs(tx, { actorId: current.userId, targetId: original.targetId });
      const [old] = await tx.select().from(commands).where(and(eq(commands.kind, original.kind), eq(commands.requestKey, original.input.idempotencyKey))).for("update");
      if (old) {
        if (old.createdBy !== current.userId || old.targetId !== original.targetId || old.requestChecksum !== proof ||
          old.postingId !== (original.kind === "return_rejected" ? original.postingId : null))
          conflict("incoming_original_mismatch", "原请求已绑定其他操作者、业务对象或填写 请先核对原记录");
        return this.view(tx, current, old);
      }
      const [pending] = await tx.select({ id: commands.id }).from(commands).where(and(eq(commands.kind, original.kind), eq(commands.targetId, original.targetId),
        eq(commands.createdBy, current.userId), isNull(commands.acknowledgedAt)));
      if (pending) conflict("incoming_original_unacknowledged", "请先恢复并核对上一笔原提交的结果");
      await this.owner.validateCommandInTransaction(tx, current, original);
      const [saved] = await tx.insert(commands).values({ id: createEntityId(), tenantId: current.tenantId, createdBy: current.userId,
        kind: original.kind, targetId: original.targetId, postingId: original.kind === "return_rejected" ? original.postingId : null,
        requestKey: original.input.idempotencyKey, requestChecksum: proof, authoritySnapshot: current,
        encryptedInput: this.vault.encrypt(canonicalJson(original)), expiresAt: sql`clock_timestamp()+interval '7 days'` }).returning();
      await this.record(tx, current, saved!, "prepare");
      return this.view(tx, current, saved!);
    });
  }

  list(context: TenantContext, raw: unknown) {
    const scope = IncomingCommandScopeSchema.parse(raw);
    return this.withCurrent(context, async (tx, current) => {
      await this.owner.readCommandTargetInTransaction(tx, current, scope);
      await expireIncomingCommandInputs(tx, { actorId: current.userId, targetId: scope.targetId });
      const rows = await tx.select().from(commands).where(and(eq(commands.kind, scope.kind), eq(commands.targetId, scope.targetId),
        eq(commands.createdBy, current.userId), isNull(commands.acknowledgedAt)));
      return IncomingCommandListSchema.parse({ items: await Promise.all(rows.map(row => this.view(tx, current, row))), contextAuthority: catalogContextAuthority(current) });
    });
  }
  get(context: TenantContext, commandId: string) {
    return this.withCurrent(context, async (tx, current) => this.view(tx, current, await this.currentRow(tx, current, commandId)));
  }

  /** New sessions can find originals even when their arrival is older than the
   * current workspace page. Pagination is by immutable command identity. */
  listForPurchaseOrder(context: TenantContext, purchaseOrderId: string, before?: string) {
    return this.withCurrent(context, async (tx, current) => {
      await expireIncomingCommandInputs(tx, { actorId: current.userId });
      await this.owner.readCommandTargetInTransaction(tx, current, { kind: "record_arrival", targetId: purchaseOrderId });
      const rows = await tx.select().from(commands).where(and(eq(commands.createdBy, current.userId), isNull(commands.acknowledgedAt),
        before ? sql`${commands.id}<${before}::uuid` : undefined,
        sql`(
          (${commands.kind}='record_arrival' and ${commands.targetId}=${purchaseOrderId}::uuid)
          or (${commands.kind}='publish_standard' and exists(select 1 from inventory_purchase_order_versions v,
            jsonb_array_elements(v.line_snapshot) x where v.purchase_order_id=${purchaseOrderId}::uuid and (x->>'stockItemId')::uuid=${commands.targetId}))
          or (${commands.kind} in ('record_inspection','review_inspection','post_inspection','return_rejected') and exists(
            select 1 from inventory_procurement_arrival_lines l join inventory_procurement_arrivals a on a.tenant_id=l.tenant_id and a.id=l.arrival_id
            where a.purchase_order_id=${purchaseOrderId}::uuid and l.id=${commands.targetId}))
        )`)).orderBy(desc(commands.id)).limit(51);
      return IncomingOrderCommandsSchema.parse({ purchaseOrderId, items: await Promise.all(rows.slice(0, 50).map(row => this.view(tx, current, row))),
        nextCursor: rows.length > 50 ? rows[49]!.id : null, contextAuthority: catalogContextAuthority(current) });
    });
  }

  execute(context: TenantContext, commandId: string) {
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, commandId);
      if (row.status !== "prepared") return this.view(tx, current, row);
      let original: PrepareIncomingCommand;
      try { original = this.original(row); }
      catch {
        await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row));
        // A temporary key/configuration failure must not destroy the immutable
        // encrypted original. Correct-key recovery, explicit cancel or TTL own
        // its next state; execution never guesses a replacement body.
        conflict("incoming_original_unavailable", "原填写暂时不可用 已停止执行 请重新读取原提交或取消这笔准备");
      }
      const ceiling = intersectPermissionContexts(TenantContextSchema.parse(row.authoritySnapshot), current);
      await tx.execute(sql`select set_config('app.incoming_command_id',${row.id},true)`);
      // No nested savepoint: receipt proofs also verify the original transaction.
      // Domain conflicts roll this entire attempt back and preserve preparation.
      const resultId = await this.owner.executeCommandInTransaction(tx, ceiling, original);
      const [saved] = await tx.update(commands).set({ status: "succeeded", resultId, completedAt: sql`clock_timestamp()` })
        .where(eq(commands.id, row.id)).returning();
      await this.record(tx, current, saved!, "execute");
      return this.view(tx, current, saved!);
    });
  }
  cancel(context: TenantContext, commandId: string) {
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
  acknowledge(context: TenantContext, commandId: string) {
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, commandId);
      await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row));
      if (row.status === "prepared") conflict("incoming_original_pending", "原提交仍待核对 请先执行或取消");
      if (row.acknowledgedAt) return this.view(tx, current, row);
      const [saved] = await tx.update(commands).set({ acknowledgedAt: sql`clock_timestamp()`, encryptedInput: null,
        redactedAt: sql`coalesce(${commands.redactedAt},clock_timestamp())` }).where(eq(commands.id, row.id)).returning();
      await this.record(tx, current, saved!, "acknowledge");
      return this.view(tx, current, saved!);
    });
  }

  private original(row: Command) {
    if (!row.encryptedInput || row.contractVersion !== "incoming-command-v1") throw new Error("Original incoming input unavailable");
    const authority = TenantContextSchema.parse(row.authoritySnapshot);
    if (authority.tenantId !== row.tenantId || authority.userId !== row.createdBy) throw new Error("Original incoming authority differs");
    const original = this.vault.withSecret(row.encryptedInput, text => PrepareIncomingCommandSchema.parse(JSON.parse(text)));
    if (original.kind !== row.kind || original.targetId !== row.targetId ||
      (original.kind === "return_rejected" ? original.postingId : null) !== row.postingId ||
      original.input.idempotencyKey !== row.requestKey || checksum(original) !== row.requestChecksum)
      throw new Error("Original incoming proof differs");
    return original;
  }
  private async view(tx: TenantTransaction, current: TenantContext, row: Command) {
    await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row));
    let original: PrepareIncomingCommand | null = null;
    let blockReason: IncomingCommandView["blockReason"] = row.status === "expired" ? "expired" : row.errorCode;
    if (row.encryptedInput) { try { original = this.original(row); } catch { blockReason = "input_unavailable"; } }
    const target = await this.owner.readCommandTargetInTransaction(tx, current, scopeOf(row), { original: original ?? undefined, resultId: row.resultId });
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
    return IncomingCommandViewSchema.parse({ id: row.id, kind: row.kind, targetId: row.targetId, postingId: row.postingId,
      ...target,
      status: row.status, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
      contextAuthority: catalogContextAuthority(current), acknowledged: Boolean(row.acknowledgedAt),
      canExecute: row.status === "prepared" && Boolean(original) && blockReason === null, canCancel: row.status === "prepared",
      original, result: row.resultId ? { kind: row.kind, id: row.resultId } : null, blockReason });
  }
  private async currentRow(tx: TenantTransaction, current: TenantContext, commandId: string) {
    const row = await this.row(tx, current, commandId);
    await expireIncomingCommandInputs(tx, { actorId: current.userId, targetId: row.targetId });
    return this.row(tx, current, commandId);
  }
  private async row(tx: TenantTransaction, current: TenantContext, commandId: string) {
    const [row] = await tx.select().from(commands).where(and(eq(commands.id, commandId.toLowerCase()), eq(commands.createdBy, current.userId))).for("update");
    if (!row) throw new NotFoundException("本人的原来料提交不存在");
    return row;
  }
  private withCurrent<T>(context: TenantContext, apply: (tx: TenantTransaction, current: TenantContext) => Promise<T>) {
    return retryDatabaseTimeRollback(() => withTenant(this.database.db, context, async tx => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      authorize(current, Permission.ProcurementRead);
      return apply(tx, current);
    }), "incoming_commands_time");
  }
  private record(tx: TenantTransaction, current: TenantContext, row: Command, action: string) {
    return this.audit.recordInTransaction(tx, current, { action: `procurement.incoming.command.${action}`, resourceType: "incoming_command", resourceId: row.id,
      result: "success", metadata: { kind: row.kind, targetId: row.targetId, resultId: row.resultId } });
  }
}
