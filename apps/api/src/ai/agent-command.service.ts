import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, HttpException, Inject, Injectable, NotFoundException, Optional, PayloadTooLargeException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  AGENT_COMMAND_VERSION, AGENT_COMMAND_MAX_BYTES, AdoptAgentCommandSchema, PrepareAgentCommandSchema,
  AgentCommandBindingSchema, AgentCommandConfirmationSchema, AgentCommandReceiptQuerySchema, AgentCommandReceiptSchema,
  AgentCommandViewSchema, AgentCommandWorkspaceSchema, ConfirmAgentCommandSchema, CancelAgentCommandSchema,
  canonicalAgentCommandOriginal, canonicalAgentCommandRequest, normalizeAgentCommandOriginal,
  type AgentCommandOriginal, type AgentCommandOwnerReference,
  type AgentCommandView,
} from "@yummyai/contracts/ai/agent-command";
import { agentCommandRequests as requests, loadCurrentMembershipContext, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentCommandOwnerAdapter } from "./agent-command-owner.js";

type Row = typeof requests.$inferSelect;
const Id = z.uuidv7();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
const conflict = (code: string): never => { throw new ConflictException({ code }); };
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const value = schema.safeParse(raw); if (!value.success) throw new BadRequestException({ code: "agent_command_input_invalid" }); return value.data;
};
export const AGENT_COMMAND_CONFIRMATION_SECONDS = Symbol("AGENT_COMMAND_CONFIRMATION_SECONDS");

/** Stores coordination identities only; all command preparation and business effects remain native-owner calls. */
@Injectable()
export class AgentCommandService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(AgentCommandOwnerAdapter) private readonly owner: AgentCommandOwnerAdapter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(AGENT_COMMAND_CONFIRMATION_SECONDS) private readonly confirmationTtlSeconds = 300) {
    if (!Number.isInteger(confirmationTtlSeconds) || confirmationTtlSeconds < 1 || confirmationTtlSeconds > 300) throw new Error("Invalid server confirmation lifetime");
  }

  private async current(tx: TenantTransaction, caller: TenantContext, ceiling?: TenantContext, write = false) {
    const membership = await loadCurrentMembershipContext(tx, caller, { lock: true });
    const session = TenantContextSchema.parse(intersectPermissionContexts(TenantContextSchema.parse(caller), membership));
    const effective = ceiling ? TenantContextSchema.parse(intersectPermissionContexts(ceiling, session)) : session;
    authorize(effective, Permission.WorkflowRead, { ownerId: caller.userId });
    if (write) authorize(effective, Permission.WorkflowRun, { ownerId: caller.userId });
    return { session, effective };
  }

  private async access(context: TenantContext, ceiling?: TenantContext, write = false) {
    return withTenant(this.database.db, context, tx => this.current(tx, context, ceiling, write));
  }
  private async now(tx: TenantTransaction) {
    const [row] = await tx.execute<{ milliseconds: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
    const value = Number(row?.milliseconds); if (!Number.isSafeInteger(value)) conflict("agent_command_clock_unavailable"); return new Date(value);
  }
  private async row(tx: TenantTransaction, context: TenantContext, id: string, lock = false): Promise<Row> {
    const query = tx.select().from(requests).where(and(eq(requests.id, id), eq(requests.ownerId, context.userId)));
    const [row] = await (lock ? query.for("update") : query); if (!row) throw new NotFoundException({ code: "agent_command_not_found" }); return row;
  }
  private read(context: TenantContext, id: string) {
    parse(Id, id); return withTenant(this.database.db, context, async tx => {
      const row = await this.row(tx, context, id); await this.current(tx, context, row.originCeiling); return row;
    });
  }
  private reference(row: Row): AgentCommandOwnerReference | null {
    return row.ownerCommandId ? { domain: row.binding.domain, commandId: row.ownerCommandId, accountId: row.binding.accountId } : null;
  }
  private record(tx: TenantTransaction, current: TenantContext, row: Row, action: string, extra: Record<string, unknown> = {}) {
    return this.audit.recordInTransaction(tx, current, { action: "agent.command." + action, resourceType: "agent_command_request", resourceId: row.id,
      result: "success", metadata: { requestChecksum: row.requestChecksum, originalChecksum: row.originalChecksum,
        ownerCommandId: row.ownerCommandId, ...extra } });
  }
  private async existing(context: TenantContext, requestId: string, requestChecksum: string) {
    return withTenant(this.database.db, context, async tx => {
      await this.current(tx, context);
      const [row] = await tx.select().from(requests).where(and(eq(requests.ownerId, context.userId), eq(requests.requestId, requestId)));
      if (row && row.requestChecksum !== requestChecksum) conflict("agent_command_request_mismatch"); return row ?? null;
    });
  }
  private async create(context: TenantContext, operation: "prepare" | "adopt", requestId: string, requestChecksum: string, original: AgentCommandOriginal) {
    const binding = AgentCommandBindingSchema.parse(this.owner.binding(original));
    return withTenant(this.database.db, context, async tx => {
      const { effective } = await this.current(tx, context, undefined, true);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-command:${context.tenantId}:${context.userId}:${requestId}`},0))`);
      const [old] = await tx.select().from(requests).where(and(eq(requests.ownerId, context.userId), eq(requests.requestId, requestId))).for("update");
      if (old) { if (old.requestChecksum !== requestChecksum) conflict("agent_command_request_mismatch"); return old; }
      const [row] = await tx.insert(requests).values({ id: createEntityId(), tenantId: context.tenantId, ownerId: context.userId, requestId,
        requestChecksum, operation, originalChecksum: sha(canonicalAgentCommandOriginal(original)), binding, originCeiling: effective,
        expiresAt: sql`clock_timestamp()+interval '7 days'` }).returning();
      await this.record(tx, effective, row!, "create"); return row!;
    });
  }
  private async link(context: TenantContext, row: Row, reference: AgentCommandOwnerReference) {
    if (reference.domain !== row.binding.domain || reference.accountId !== row.binding.accountId) conflict("agent_command_owner_mismatch");
    return withTenant(this.database.db, context, async tx => {
      const currentRow = await this.row(tx, context, row.id, true), { effective } = await this.current(tx, context, currentRow.originCeiling);
      if (currentRow.ownerCommandId) {
        if (currentRow.ownerCommandId !== reference.commandId) conflict("agent_command_owner_mismatch"); return currentRow;
      }
      const [saved] = await tx.update(requests).set({ ownerCommandId: reference.commandId }).where(eq(requests.id, row.id)).returning();
      await this.record(tx, effective, saved!, "link"); return saved!;
    });
  }
  /** May resolve metadata after a lost preparation response. It never dispatches a prepare or execute. */
  private async resolve(context: TenantContext, row: Row) {
    if (row.ownerCommandId) return row;
    const before = await this.access(context, row.originCeiling);
    const reference = await this.owner.locate(before.effective, row.binding);
    const after = await this.access(context, row.originCeiling);
    if (stamp(before.session) !== stamp(after.session) || stamp(before.effective) !== stamp(after.effective)) conflict("authority_changed");
    return reference ? this.link(context, row, reference) : row;
  }

  async workspace(context: TenantContext) {
    return withTenant(this.database.db, context, async tx => {
      const { session, effective } = await this.current(tx, context);
      let canRun = true; try { authorize(effective, Permission.WorkflowRun, { ownerId: context.userId }); } catch { canRun = false; }
      const rows = await tx.select({ id: requests.id, requestId: requests.requestId, binding: requests.binding, createdAt: requests.createdAt, ownerCommandId: requests.ownerCommandId })
        .from(requests).where(eq(requests.ownerId, context.userId)).orderBy(desc(requests.id)).limit(21);
      return AgentCommandWorkspaceSchema.parse({ version: AGENT_COMMAND_VERSION, contextAuthority: stamp(session), capabilities: this.owner.capabilities(effective).map(item =>
        ({ ...item, available: canRun && item.available, blockReason: canRun ? item.blockReason : "workflow_run_required" })),
        recent: rows.slice(0, 20).map(row => ({ id: row.id, requestId: row.requestId, domain: row.binding.domain, kind: row.binding.kind, createdAt: row.createdAt.toISOString(), ownerCommandId: row.ownerCommandId })),
        recentLimit: 20, recentHasMore: rows.length > 20, readLoopVersion: "erp-agent-loop-v1", autonomousModelWrites: false, mcpState: "not_connected" });
    });
  }
  async prepare(context: TenantContext, raw: unknown) {
    const input = parse(PrepareAgentCommandSchema, raw), original = normalizeAgentCommandOriginal(input.original);
    const canonical = canonicalAgentCommandRequest("prepare", input);
    if (Buffer.byteLength(canonical) > AGENT_COMMAND_MAX_BYTES) throw new PayloadTooLargeException({ code: "agent_command_input_too_large" });
    const checksum = sha(canonical);
    let row = await this.existing(context, input.requestId, checksum) ?? await this.create(context, "prepare", input.requestId, checksum, original);
    row = await this.resolve(context, row);
    if (!row.ownerCommandId) {
      const { effective } = await this.access(context, row.originCeiling, true);
      const snapshot = await this.owner.prepare(effective, original);
      await this.link(context, row, snapshot.reference);
    }
    return this.get(context, row.id);
  }
  async adopt(context: TenantContext, raw: unknown) {
    const input = parse(AdoptAgentCommandSchema, raw), checksum = sha(canonicalAgentCommandRequest("adopt", input));
    const existing = await this.existing(context, input.requestId, checksum);
    if (existing) return this.get(context, existing.id);
    const before = await this.access(context, undefined, true), snapshot = await this.owner.read(before.effective, input.reference);
    const after = await this.access(context, undefined, true);
    if (stamp(before.session) !== stamp(after.session)) conflict("authority_changed");
    if (!snapshot.original) conflict("agent_command_original_unavailable");
    const row = await this.create(context, "adopt", input.requestId, checksum, snapshot.original!);
    await this.link(context, row, input.reference); return this.get(context, row.id);
  }
  async receipt(context: TenantContext, raw: unknown) {
    const input = parse(AgentCommandReceiptQuerySchema, raw);
    let row = await this.existing(context, input.requestId, input.requestChecksum);
    if (row) {
      try { row = await this.resolve(context, row); }
      catch (error) { if (!this.unavailable(error)) throw error; }
    }
    const { session } = await this.access(context);
    return AgentCommandReceiptSchema.parse({ version: AGENT_COMMAND_VERSION, ...input, disposition: row ? "known" : "not_found",
      id: row?.id ?? null, ownerCommandId: row?.ownerCommandId ?? null, contextAuthority: stamp(session), privateAvailable: false });
  }
  private unavailable(error: unknown) {
    return error instanceof HttpException && [403, 404, 409, 410].includes(error.getStatus()) || error instanceof Error && error.name === "ForbiddenError";
  }
  private async snapshot(context: TenantContext, row: Row) {
    const reference = this.reference(row); if (!reference) return null;
    const before = await this.access(context, row.originCeiling);
    try {
      const snapshot = await this.owner.read(before.effective, reference), after = await this.access(context, row.originCeiling);
      if (stamp(before.session) !== stamp(after.session) || stamp(before.effective) !== stamp(after.effective)) conflict("authority_changed");
      if (snapshot.original && sha(canonicalAgentCommandOriginal(snapshot.original)) !== row.originalChecksum) conflict("agent_command_original_mismatch");
      return snapshot;
    } catch (error) { if (!this.unavailable(error)) throw error; return null; }
  }
  async get(context: TenantContext, rawId: string): Promise<AgentCommandView> {
    let row = await this.read(context, rawId);
    try { row = await this.resolve(context, row); } catch (error) { if (!this.unavailable(error)) throw error; }
    const frame = await this.access(context, row.originCeiling), snapshot = await this.snapshot(context, row);
    return withTenant(this.database.db, context, async tx => {
      const { session, effective } = await this.current(tx, context, row.originCeiling), now = await this.now(tx);
      if (snapshot && (stamp(frame.session) !== stamp(session) || stamp(frame.effective) !== stamp(effective))) conflict("authority_changed");
      let writable = true; try { authorize(effective, Permission.WorkflowRun, { ownerId: context.userId }); } catch { writable = false; }
      const state = snapshot?.native.view.status ?? (row.ownerCommandId ? "unavailable" : "preparing");
      const mappedState = state === "uncertain" ? "unknown" : state;
      const live = row.expiresAt > now, canConfirm = writable && live && !!snapshot?.original && state === "prepared" && snapshot.native.view.canExecute;
      const expiresAt = canConfirm ? new Date(Math.min(now.getTime() + this.confirmationTtlSeconds * 1000, row.expiresAt.getTime(), new Date(snapshot!.native.view.expiresAt).getTime())) : null;
      const token = canConfirm ? this.vault.encrypt(canonicalJson(AgentCommandConfirmationSchema.parse({ version: AGENT_COMMAND_VERSION,
        id: row.id, requestId: row.requestId, tenantId: row.tenantId, userId: row.ownerId, ownerCommandId: row.ownerCommandId,
        originalChecksum: row.originalChecksum, ceilingChecksum: sha(canonicalJson(row.originCeiling)), currentAuthority: sha(stamp(session)),
        issuedAt: now.toISOString(), expiresAt: expiresAt!.toISOString() }))) : null;
      return AgentCommandViewSchema.parse({ version: AGENT_COMMAND_VERSION, id: row.id, requestId: row.requestId, requestChecksum: row.requestChecksum,
        contextAuthority: stamp(session), domain: row.binding.domain, kind: row.binding.kind, ownerCommandId: row.ownerCommandId,
        createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), executeRequestedAt: row.confirmedAt?.toISOString() ?? null,
        cancelledAt: row.cancelledAt?.toISOString() ?? null, state: mappedState, privateAvailable: !!snapshot, snapshot,
        originalChecksum: snapshot?.original ? row.originalChecksum : null, confirmationToken: token, confirmationExpiresAt: expiresAt?.toISOString() ?? null,
        canConfirm, canCancel: writable && !!snapshot?.native.view.canCancel, errorCode: snapshot ? null : row.ownerCommandId ? "original_unavailable" : "original_preparation_unresolved" });
    });
  }
  async confirm(context: TenantContext, rawId: string, raw: unknown) {
    const id = parse(Id, rawId), input = parse(ConfirmAgentCommandSchema, raw), row = await this.read(context, id);
    let token: z.infer<typeof AgentCommandConfirmationSchema>;
    try { token = this.vault.withSecret(input.confirmationToken, text => AgentCommandConfirmationSchema.parse(JSON.parse(text))); }
    catch { conflict("agent_command_confirmation_invalid"); }
    if (token!.id !== id || token!.requestId !== input.requestId || token!.tenantId !== context.tenantId || token!.userId !== context.userId ||
      token!.ownerCommandId !== input.ownerCommandId || token!.originalChecksum !== input.originalChecksum || row.requestId !== input.requestId ||
      row.ownerCommandId !== input.ownerCommandId || row.originalChecksum !== input.originalChecksum || token!.ceilingChecksum !== sha(canonicalJson(row.originCeiling))) conflict("agent_command_confirmation_mismatch");
    const snapshot = await this.snapshot(context, row);
    if (!snapshot) conflict("agent_command_original_unavailable");
    if (snapshot!.native.view.status === "succeeded") return this.get(context, id);
    if (!snapshot!.original || !snapshot!.native.view.canExecute || snapshot!.native.view.status !== "prepared") conflict("agent_command_original_not_executable");
    const effective = await withTenant(this.database.db, context, async tx => {
      const locked = await this.row(tx, context, id, true), current = await this.current(tx, context, locked.originCeiling, true), now = await this.now(tx);
      if (token!.currentAuthority !== sha(stamp(current.session)) || new Date(token!.issuedAt) > now || new Date(token!.expiresAt) <= now || locked.expiresAt <= now)
        conflict("agent_command_confirmation_expired_or_changed");
      if (!locked.confirmedAt) {
        const confirmationChecksum = sha(canonicalJson(token!));
        const [saved] = await tx.update(requests).set({ confirmedAt: now, confirmationChecksum }).where(eq(requests.id, id)).returning();
        await this.record(tx, current.effective, saved!, "confirm", { confirmationChecksum });
      } else await this.record(tx, current.effective, locked, "confirm_replay", { confirmationChecksum: locked.confirmationChecksum });
      return current.effective;
    });
    await this.owner.execute(effective, snapshot!.reference);
    return this.get(context, id);
  }
  private async action(context: TenantContext, rawId: string, raw: unknown, action: "cancel" | "acknowledge") {
    const id = parse(Id, rawId), input = parse(CancelAgentCommandSchema, raw), row = await this.read(context, id);
    if (row.requestId !== input.requestId || row.ownerCommandId !== input.ownerCommandId) conflict("agent_command_owner_mismatch");
    const { effective } = await this.access(context, row.originCeiling, true), reference = this.reference(row)!;
    const snapshot = action === "cancel" ? await this.owner.cancel(effective, reference) : await this.owner.acknowledge(effective, reference);
    const accepted = action === "cancel" ? snapshot.native.view.status === "cancelled" : snapshot.native.view.acknowledged;
    if (accepted) await withTenant(this.database.db, context, async tx => {
      const currentRow = await this.row(tx, context, id, true), { effective: current } = await this.current(tx, context, currentRow.originCeiling, true);
      const field = action === "cancel" ? "cancelledAt" : "acknowledgedAt";
      if (currentRow[field]) return;
      const [saved] = await tx.update(requests).set({ [field]: await this.now(tx) }).where(eq(requests.id, id)).returning();
      await this.record(tx, current, saved!, action);
    });
    return this.get(context, id);
  }
  cancel(context: TenantContext, id: string, raw: unknown) { return this.action(context, id, raw, "cancel"); }
  acknowledge(context: TenantContext, id: string, raw: unknown) { return this.action(context, id, raw, "acknowledge"); }
}
