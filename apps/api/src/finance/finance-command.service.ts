import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission, permissionScope } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { AgentCommandBindingSchema, type AgentCommandBinding, type AgentCommandOwnerReference } from "@yummyai/contracts/ai/agent-command";
import {
  FINANCE_COMMAND_CONTRACT, FINANCE_COMMAND_MAX_CIPHERTEXT_BYTES, FINANCE_COMMAND_MAX_PLAINTEXT_BYTES,
  FinanceCommandDetailSchema, FinanceCommandListSchema, FinanceCommandOriginalSchema, FinanceCommandQuerySchema, FinanceCommandScopeSchema,
  FinanceCommandResultSchema, FinanceCommandSummarySchema, PrepareFinanceCommandSchema, canonicalFinanceCommandOriginal,
  type FinanceCommandDetail, type FinanceCommandScope, type PrepareFinanceCommand,
} from "@yummyai/contracts/finance/finance-command";
import { expireFinanceCommandInputs, financeCommands as commands, loadCurrentMembershipContext,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { retryDatabaseTimeRollback } from "../database-time-retry.js";
import { DATABASE_CONNECTION, FINANCE_COMMAND_VAULT } from "../platform.tokens.js";
import { FinanceCommandOwnerAdapter, financeCommandKeyLock, financeCommandPermission } from "./finance-command-owner.js";
import { FinanceCommandResultPageQuerySchema } from "@yummyai/contracts/finance/finance-command-result";
import { FinanceCommandResultReader } from "./finance-command-result.reader.js";

type Command = typeof commands.$inferSelect;
type Metadata = Pick<Command, "id" | "tenantId" | "createdBy" | "kind" | "targetId" | "requestKey" | "requestChecksum" |
  "ownerInputChecksum" | "contractVersion" | "status" | "resultId" | "createdAt" | "expiresAt" | "completedAt" | "acknowledgedAt"> & {
  originalRetained: boolean; inputDue: boolean;
};
type PrivateInput = Pick<Command, "authoritySnapshot" | "encryptedInput">;
const idSchema = EntityIdSchema.transform(value => value.toLowerCase());
const envelopeSchema = z.object({ tenantId: idSchema, createdBy: idSchema, commandId: idSchema, original: PrepareFinanceCommandSchema }).strict();
const scopeOf = (row: Metadata): FinanceCommandScope => ({ kind: row.kind, targetId: row.targetId });

/** A list query must never materialize retained ciphertext or authority blobs. */
const metadataColumns = {
  id: commands.id, tenantId: commands.tenantId, createdBy: commands.createdBy, kind: commands.kind, targetId: commands.targetId,
  requestKey: commands.requestKey, requestChecksum: commands.requestChecksum, ownerInputChecksum: commands.ownerInputChecksum,
  contractVersion: commands.contractVersion, status: commands.status, resultId: commands.resultId,
  createdAt: commands.createdAt, expiresAt: commands.expiresAt, completedAt: commands.completedAt, acknowledgedAt: commands.acknowledgedAt,
  originalRetained: sql<boolean>`${commands.encryptedInput} is not null and ${commands.redactedAt} is null and ${commands.expiresAt}>clock_timestamp()`,
  inputDue: sql<boolean>`${commands.expiresAt}<=clock_timestamp()`,
};

function input<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestException({ code: "finance_command_input_invalid", message: "财务原提交填写或查询格式不正确" });
  return result.data;
}
function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }
function tooLarge(): never { throw new PayloadTooLargeException({ code: "finance_command_input_too_large", message: "财务原提交超过完整保留上限 请核对本次报表 不会截断任何分录" }); }
class OriginalUnavailable extends Error {}

/** Private transport only. All actual Finance writes stay in the original owners. */
@Injectable()
export class FinanceCommandService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(FINANCE_COMMAND_VAULT) private readonly vault: SecretVault,
    @Inject(FinanceCommandOwnerAdapter) private readonly owner: FinanceCommandOwnerAdapter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FinanceCommandResultReader) private readonly results: FinanceCommandResultReader) {}

  locateForAgent(context: TenantContext, raw: AgentCommandBinding): Promise<AgentCommandOwnerReference | null> {
    const binding = input(AgentCommandBindingSchema, raw);
    if (binding.domain !== "finance" || binding.accountId !== null) throw new BadRequestException("财务原命令定位范围不正确");
    const scope = input(FinanceCommandScopeSchema, { kind: binding.kind, targetId: binding.targetId });
    return this.withCurrent(context, async (tx, current) => {
      const [row] = await tx.select({ id: commands.id, kind: commands.kind, targetId: commands.targetId, resultId: commands.resultId }).from(commands).where(and(
        eq(commands.tenantId, current.tenantId), eq(commands.createdBy, current.userId), eq(commands.kind, scope.kind),
        scope.targetId === null ? isNull(commands.targetId) : eq(commands.targetId, scope.targetId),
        eq(commands.requestChecksum, binding.ownerRequestChecksum),
        sql`encode(sha256(convert_to(${commands.requestKey},'UTF8')),'hex')=${binding.requestKeyHash}`,
      )).limit(1);
      if (!row) return null;
      await this.owner.readInTransaction(tx, current, { kind: row.kind, targetId: row.targetId }, row.resultId);
      return { domain: "finance", commandId: row.id, accountId: null };
    });
  }

  prepare(context: TenantContext, raw: unknown) {
    const original = input(PrepareFinanceCommandSchema, raw);
    if (Buffer.byteLength(canonicalFinanceCommandOriginal(original), "utf8") > FINANCE_COMMAND_MAX_PLAINTEXT_BYTES) tooLarge();
    return this.withCurrent(context, async (tx, current) => {
      tenantPermission(current, financeCommandPermission(original.kind));
      const binding = await this.owner.bindingInTransaction(tx, current, original);
      await financeCommandKeyLock(tx, current, original.kind, binding.requestKey);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`finance-command-slot:${current.tenantId}:${current.userId}:${original.kind}:${original.targetId ?? "root"}`},0))`);
      const [old] = await tx.select(metadataColumns).from(commands).where(and(eq(commands.kind, original.kind), eq(commands.requestKey, binding.requestKey))).for("update");
      if (old) {
        if (old.createdBy !== current.userId || old.targetId !== original.targetId || old.requestChecksum !== binding.requestChecksum
          || old.ownerInputChecksum !== binding.ownerInputChecksum) requestMismatch();
        await expireFinanceCommandInputs(tx, { actorId: current.userId, commandId: old.id, limit: 1 });
        return this.detail(tx, current, await this.row(tx, current, old.id));
      }
      const [pending] = await tx.select({ id: commands.id }).from(commands).where(and(eq(commands.createdBy, current.userId),
        eq(commands.kind, original.kind), original.targetId === null ? isNull(commands.targetId) : eq(commands.targetId, original.targetId), isNull(commands.acknowledgedAt))).limit(1);
      if (pending) conflict("finance_command_unacknowledged", "请先恢复并确认上一笔财务原提交的结果");
      // Old raw identities and current business basis are checked by their owner.
      await this.owner.validateInTransaction(tx, current, original);
      const id = createEntityId();
      const plaintext = canonicalJson({ tenantId: current.tenantId, createdBy: current.userId, commandId: id, original });
      if (Buffer.byteLength(plaintext, "utf8") > FINANCE_COMMAND_MAX_PLAINTEXT_BYTES) tooLarge();
      const encryptedInput = this.vault.encrypt(plaintext);
      if (Buffer.byteLength(encryptedInput, "utf8") > FINANCE_COMMAND_MAX_CIPHERTEXT_BYTES) tooLarge();
      await tx.insert(commands).values({ id, tenantId: current.tenantId, createdBy: current.userId, kind: original.kind,
        targetId: original.targetId, ...binding, authoritySnapshot: current, encryptedInput,
        contractVersion: FINANCE_COMMAND_CONTRACT, expiresAt: sql`clock_timestamp()+interval '7 days'` });
      const saved = await this.row(tx, current, id);
      await this.record(tx, current, saved, "prepare");
      return this.detail(tx, current, saved, { original, authority: current });
    });
  }

  list(context: TenantContext, raw: unknown) {
    const query = input(FinanceCommandQuerySchema, raw);
    return this.withCurrent(context, async (tx, current) => {
      const rows = await tx.select(metadataColumns).from(commands).where(and(eq(commands.createdBy, current.userId),
        query.view === "recorded" ? eq(commands.status, "succeeded") : isNull(commands.acknowledgedAt),
        query.kind ? eq(commands.kind, query.kind) : undefined,
        query.targetId === undefined ? undefined : query.targetId === null ? isNull(commands.targetId) : eq(commands.targetId, query.targetId),
        query.before ? sql`${commands.id}<${query.before}::uuid` : undefined)).orderBy(desc(commands.id)).limit(51);
      const items = [];
      let unavailableCount = 0;
      for (const before of rows.slice(0, 50)) {
        try {
          // Target this page's exact due row; an older original cannot be starved
          // behind the first hundred unrelated retention candidates.
          const row = before.inputDue ? await this.currentRow(tx, current, before.id) : before;
          items.push(await this.summary(tx, current, row));
        } catch (error) {
          if (error instanceof ForbiddenError || error instanceof NotFoundException) unavailableCount++;
          else throw error;
        }
      }
      return FinanceCommandListSchema.parse({ items, unavailableCount, nextCursor: rows.length > 50 ? rows[49]!.id : null,
        contextAuthority: catalogContextAuthority(current) });
    });
  }

  get(context: TenantContext, rawId: string) {
    const id = input(idSchema, rawId);
    return this.withCurrent(context, async (tx, current) => this.detail(tx, current, await this.currentRow(tx, current, id)));
  }

  async recordedResult(context: TenantContext, rawId: string) {
    const id = input(idSchema, rawId);
    return this.withCurrent(context, (tx, current) => this.results.read(tx, current, id), true);
  }

  async recordedResultEntries(context: TenantContext, rawId: string, rawQuery: unknown) {
    const id = input(idSchema, rawId), query = input(FinanceCommandResultPageQuerySchema, rawQuery);
    return this.withCurrent(context, (tx, current) => this.results.page(tx, current, id, query), true);
  }

  original(context: TenantContext, rawId: string) {
    const id = input(idSchema, rawId);
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, id);
      await this.owner.readInTransaction(tx, current, scopeOf(row), row.resultId);
      let original: PrepareFinanceCommand | null = null;
      let blockReason: FinanceCommandDetail["blockReason"] = row.status === "expired" || row.inputDue ? "expired" : null;
      if (row.originalRetained) {
        try { original = await this.decrypt(tx, current, row, await this.privateInput(tx, current, id)); }
        catch (error) { if (error instanceof OriginalUnavailable) blockReason = "input_unavailable"; else throw error; }
      }
      return FinanceCommandOriginalSchema.parse({ id, original, blockReason, contextAuthority: catalogContextAuthority(current) });
    });
  }

  execute(context: TenantContext, rawId: string) {
    const id = input(idSchema, rawId);
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, id);
      await this.owner.readInTransaction(tx, current, scopeOf(row), row.resultId);
      if (row.status !== "prepared") return this.detail(tx, current, row);
      const retained = await this.privateInput(tx, current, id);
      let original: PrepareFinanceCommand, ceiling: TenantContext;
      try {
        ceiling = intersectPermissionContexts(this.authority(row, retained), current);
        tenantPermission(ceiling, financeCommandPermission(row.kind));
        original = await this.decrypt(tx, current, row, retained);
      } catch (error) {
        if (error instanceof OriginalUnavailable) conflict("finance_command_input_unavailable", "原填写暂时不可用 请核对原提交或明确取消 本次未执行");
        throw error;
      }
      await tx.execute(sql`select set_config('app.finance_command_id',${row.id},true)`);
      await this.owner.validateInTransaction(tx, ceiling, original);
      const result = FinanceCommandResultSchema.parse(await this.owner.executeInTransaction(tx, ceiling, original));
      if (result.kind !== row.kind) resultUnavailable();
      const [saved] = await tx.update(commands).set({ status: "succeeded", resultId: result.id, completedAt: sql`clock_timestamp()` })
        .where(and(eq(commands.id, id), eq(commands.createdBy, current.userId), eq(commands.status, "prepared"))).returning(metadataColumns);
      if (!saved) resultUnavailable();
      await this.record(tx, current, saved, "execute");
      return this.detail(tx, current, saved);
    });
  }

  cancel(context: TenantContext, rawId: string) {
    const id = input(idSchema, rawId);
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, id);
      await this.owner.readInTransaction(tx, current, scopeOf(row), row.resultId);
      if (row.status !== "prepared") return this.detail(tx, current, row);
      const [saved] = await tx.update(commands).set({ status: "cancelled", encryptedInput: null, completedAt: sql`clock_timestamp()`, redactedAt: sql`clock_timestamp()` })
        .where(eq(commands.id, id)).returning(metadataColumns);
      if (!saved) missing();
      await this.record(tx, current, saved, "cancel");
      return this.detail(tx, current, saved);
    });
  }

  acknowledge(context: TenantContext, rawId: string) {
    const id = input(idSchema, rawId);
    return this.withCurrent(context, async (tx, current) => {
      const row = await this.currentRow(tx, current, id);
      await this.owner.readInTransaction(tx, current, scopeOf(row), row.resultId);
      if (row.status === "prepared") conflict("finance_command_pending", "财务原提交仍待处理 请先核对执行结果或明确取消");
      if (row.acknowledgedAt) return this.detail(tx, current, row);
      const [saved] = await tx.update(commands).set({ acknowledgedAt: sql`clock_timestamp()`, encryptedInput: null,
        redactedAt: sql`coalesce(${commands.redactedAt},clock_timestamp())` }).where(eq(commands.id, id)).returning(metadataColumns);
      if (!saved) missing();
      await this.record(tx, current, saved, "acknowledge");
      return this.detail(tx, current, saved);
    });
  }

  private async summary(tx: TenantTransaction, current: TenantContext, row: Metadata) {
    const result = await this.owner.readInTransaction(tx, current, scopeOf(row), row.resultId);
    if (row.status === "succeeded" && (!result || result.id !== row.resultId || result.kind !== row.kind)) resultUnavailable();
    return FinanceCommandSummarySchema.parse({ id: row.id, kind: row.kind, targetId: row.targetId, status: row.status, requestKey: row.requestKey,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null,
      acknowledged: Boolean(row.acknowledgedAt), originalRetained: row.originalRetained, result,
      contextAuthority: catalogContextAuthority(current) });
  }

  private async detail(tx: TenantTransaction, current: TenantContext, row: Metadata,
    known: { original: PrepareFinanceCommand; authority: TenantContext } | undefined = undefined) {
    const summary = await this.summary(tx, current, row);
    let blockReason: FinanceCommandDetail["blockReason"] = row.status === "expired" ? "expired" : null;
    if (row.status === "prepared") {
      try {
        tenantPermission(current, financeCommandPermission(row.kind));
        if (!row.originalRetained) throw new OriginalUnavailable();
        const retained = known ? null : await this.privateInput(tx, current, row.id);
        const authority = known?.authority ?? this.authority(row, retained!);
        const ceiling = intersectPermissionContexts(authority, current);
        tenantPermission(ceiling, financeCommandPermission(row.kind));
        const original = known?.original ?? await this.decrypt(tx, current, row, retained!);
        await this.owner.validateInTransaction(tx, ceiling, original);
      } catch (error) {
        if (error instanceof OriginalUnavailable) blockReason = "input_unavailable";
        else if (error instanceof ForbiddenError) blockReason = "permission_denied";
        else if (error instanceof ConflictException || error instanceof NotFoundException) blockReason = "basis_changed";
        else throw error;
      }
    }
    return FinanceCommandDetailSchema.parse({ ...summary, blockReason,
      canExecute: row.status === "prepared" && row.originalRetained && blockReason === null,
      canCancel: row.status === "prepared", canAcknowledge: row.status !== "prepared" && !row.acknowledgedAt });
  }

  private authority(row: Metadata, retained: PrivateInput) {
    const parsed = TenantContextSchema.safeParse(retained.authoritySnapshot);
    if (!parsed.success || parsed.data.tenantId !== row.tenantId || parsed.data.userId !== row.createdBy) throw new OriginalUnavailable();
    return parsed.data;
  }

  private async decrypt(tx: TenantTransaction, current: TenantContext, row: Metadata, retained: PrivateInput) {
    if (!row.originalRetained || !retained.encryptedInput || row.contractVersion !== FINANCE_COMMAND_CONTRACT) throw new OriginalUnavailable();
    this.authority(row, retained);
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = this.vault.withSecret(retained.encryptedInput, value => {
        if (Buffer.byteLength(value, "utf8") > FINANCE_COMMAND_MAX_PLAINTEXT_BYTES) throw new OriginalUnavailable();
        return envelopeSchema.parse(JSON.parse(value));
      });
    } catch { throw new OriginalUnavailable(); }
    const original = envelope.original;
    if (envelope.tenantId !== row.tenantId || envelope.createdBy !== row.createdBy || envelope.commandId !== row.id
      || original.kind !== row.kind || original.targetId !== row.targetId) throw new OriginalUnavailable();
    const binding = await this.owner.bindingInTransaction(tx, current, original);
    if (binding.requestKey !== row.requestKey || binding.requestChecksum !== row.requestChecksum || binding.ownerInputChecksum !== row.ownerInputChecksum)
      throw new OriginalUnavailable();
    return original;
  }

  private async privateInput(tx: TenantTransaction, current: TenantContext, id: string): Promise<PrivateInput> {
    const [row] = await tx.select({ authoritySnapshot: commands.authoritySnapshot, encryptedInput: commands.encryptedInput }).from(commands)
      .where(and(eq(commands.id, id), eq(commands.createdBy, current.userId)));
    if (!row) missing();
    return row;
  }

  private async currentRow(tx: TenantTransaction, current: TenantContext, id: string) {
    const [before] = await tx.select(metadataColumns).from(commands).where(and(eq(commands.id, id), eq(commands.createdBy, current.userId)));
    if (!before) missing();
    await financeCommandKeyLock(tx, current, before.kind, before.requestKey);
    await this.row(tx, current, id);
    await expireFinanceCommandInputs(tx, { actorId: current.userId, commandId: id, limit: 1 });
    return this.row(tx, current, id);
  }

  private async row(tx: TenantTransaction, current: TenantContext, id: string): Promise<Metadata> {
    const [row] = await tx.select(metadataColumns).from(commands).where(and(eq(commands.id, id), eq(commands.createdBy, current.userId))).for("update");
    if (!row) missing();
    return row;
  }

  private withCurrent<T>(context: TenantContext, apply: (tx: TenantTransaction, current: TenantContext) => Promise<T>, immutableRead = false) {
    // The current membership row remains locked during authorization. PostgreSQL
    // requires read-write mode for that lock even when result reads write no data.
    return retryDatabaseTimeRollback(() => withTenant(this.database.db, context, async tx => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      requireAnyFinancePermission(current);
      return apply(tx, current);
    }, immutableRead ? { isolationLevel: "repeatable read", accessMode: "read write" } : undefined), "finance_commands_time");
  }

  private record(tx: TenantTransaction, current: TenantContext, row: Metadata, action: "prepare" | "execute" | "cancel" | "acknowledge") {
    return this.audit.recordInTransaction(tx, current, { action: `finance.command.${action}`, resourceType: "finance_command", resourceId: row.id,
      result: "success", metadata: { kind: row.kind, targetId: row.targetId, resultId: row.resultId } });
  }
}

function tenantPermission(context: TenantContext, permission: Permission) {
  authorize(context, permission);
  if (permissionScope(context, permission) !== "tenant") throw new ForbiddenError(permission, "outside_data_scope");
}
function requireAnyFinancePermission(context: TenantContext) {
  for (const permission of [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview]) {
    try { tenantPermission(context, permission); return; }
    catch (error) { if (!(error instanceof ForbiddenError)) throw error; }
  }
  throw new ForbiddenError(Permission.FinanceRead);
}
function requestMismatch(): never { conflict("finance_command_request_mismatch", "这笔原提交已绑定原操作者 目标和填写 请恢复原记录"); }
function resultUnavailable(): never { conflict("finance_command_result_unavailable", "原财务结果凭据暂不可核对 请读取同一原提交 不会补造成功"); }
function missing(): never { throw new NotFoundException({ code: "finance_command_not_found", message: "本人的财务原提交不存在或不可读取" }); }
