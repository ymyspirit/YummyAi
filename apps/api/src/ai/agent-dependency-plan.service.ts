import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, erpPermissionContext, ForbiddenError, intersectPermissionContexts, Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest, type AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import {
  AGENT_DEPENDENCY_PLAN_VERSION, AGENT_DEPENDENCY_PLAN_KIND, AGENT_DEPENDENCY_PLAN_RETENTION_SECONDS,
  CreateAgentDependencyPlanSchema, PrepareAgentDependencyPlanSchema, CancelAgentDependencyPlanSchema,
  AgentDependencyPlanListQuerySchema, AgentDependencyPlanReceiptQuerySchema, AgentDependencyPlanReceiptSchema,
  AgentDependencyPlanSummarySchema, AgentDependencyPlanViewSchema, AgentDependencyPlanPageSchema, AgentDependencyPlanWorkspaceSchema,
  AgentDependencyPlanCommandSchema, canonicalAgentDependencyPlanRequest,
  type AgentDependencyPlanBillDraft, type AgentDependencyPlanCommand,
  type AgentDependencyPlanView, type AgentDependencyPlanSummary,
} from "@yummyai/contracts/ai/agent-dependency-plan";
import { agentDependencyPlans as plans, agentCommandRequests, loadCurrentMembershipContext, withTenant,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, lte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentCommandService } from "./agent-command.service.js";
import { AgentDependencyPlanSource, dependencyCommandFromView, type AgentDependencyPlanSourceRead } from "./agent-dependency-plan-source.js";

type Row = typeof plans.$inferSelect;
type Frame = { row: Row; session: TenantContext; effective: TenantContext; now: Date };
type Access = "read" | "prepare" | "cancel";
const Id = z.uuidv7();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
function conflict(code: string): never { throw new ConflictException({ code }); }
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestException({ code: "agent_dependency_plan_input_invalid" });
  return result.data;
}

/** Coordinates a fixed dependency. Original owners alone prepare, confirm and write business facts. */
@Injectable()
export class AgentDependencyPlanService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AgentCommandService) private readonly commands: AgentCommandService,
    @Inject(AgentDependencyPlanSource) private readonly source: AgentDependencyPlanSource,
    @Inject(AuditService) private readonly audit: AuditService) {}

  private async current(tx: TenantTransaction, caller: TenantContext, ceiling?: TenantContext, access: Access = "read") {
    const membership = await loadCurrentMembershipContext(tx, caller, { lock: true });
    const session = TenantContextSchema.parse(intersectPermissionContexts(TenantContextSchema.parse(caller), membership));
    const effective = ceiling ? TenantContextSchema.parse(intersectPermissionContexts(ceiling, session)) : session;
    authorize(effective, Permission.WorkflowRead, { ownerId: caller.userId });
    this.requireAccess(effective, access);
    return { session, effective };
  }
  private requireAccess(context: TenantContext, access: Access) {
    if (access === "read") return;
    authorize(context, Permission.WorkflowRun, { ownerId: context.userId });
    if (access === "prepare") {
      authorize(context, Permission.ProcurementRead, { ownerId: context.userId });
      authorize(context, Permission.FinanceRead, { ownerId: context.userId });
      authorize(context, Permission.FinanceWrite);
      if (permissionScope(context, Permission.FinanceWrite) !== "tenant") throw new ForbiddenError(Permission.FinanceWrite, "outside_data_scope");
    }
  }
  private canAccess(context: TenantContext, access: Access): boolean {
    try { this.requireAccess(context, access); return true; }
    catch (error) { if (!(error instanceof ForbiddenError)) throw error; return false; }
  }
  private async now(tx: TenantTransaction): Promise<Date> {
    const [value] = await tx.execute<{ milliseconds: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
    const milliseconds = Number(value?.milliseconds);
    if (!Number.isSafeInteger(milliseconds)) conflict("agent_dependency_plan_clock_unavailable");
    return new Date(milliseconds);
  }
  private async row(tx: TenantTransaction, context: TenantContext, id: string, lock = false): Promise<Row> {
    const query = tx.select().from(plans).where(and(eq(plans.id, id), eq(plans.ownerId, context.userId), eq(plans.version, AGENT_DEPENDENCY_PLAN_VERSION)));
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw new NotFoundException({ code: "agent_dependency_plan_not_found" });
    return row;
  }
  private async frame(context: TenantContext, id: string): Promise<Frame> {
    return withTenant(this.database.db, context, async tx => {
      await this.current(tx, context);
      const row = await this.row(tx, context, id), current = await this.current(tx, context, row.originCeiling);
      return { row, ...current, now: await this.now(tx) };
    });
  }
  private sameAuthority(before: Pick<Frame, "session" | "effective">, after: Pick<Frame, "session" | "effective">) {
    if (stamp(before.session) !== stamp(after.session) || stamp(before.effective) !== stamp(after.effective)) conflict("authority_changed");
  }
  private async record(tx: TenantTransaction, current: TenantContext, row: Row, action: "create" | "prepare" | "link" | "cancel") {
    await this.audit.recordInTransaction(tx, current, { action: `agent.dependency_plan.${action}`, resourceType: "agent_dependency_plan", resourceId: row.id,
      result: "success", metadata: { requestChecksum: row.requestChecksum, parentAgentCommandId: row.parentAgentCommandId,
        childRequestId: row.childRequestId, sourceChecksum: row.sourceChecksum,
        childPreparationRequestChecksum: row.childPreparationRequestChecksum, childAgentCommandId: row.childAgentCommandId, childOwnerCommandId: row.childOwnerCommandId } });
  }

  async workspace(context: TenantContext) {
    return withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context);
      const parents = await tx.select({ id: agentCommandRequests.id, requestId: agentCommandRequests.requestId, createdAt: agentCommandRequests.createdAt })
        .from(agentCommandRequests).where(and(eq(agentCommandRequests.ownerId, current.session.userId),
          sql`${agentCommandRequests.binding}->>'domain'='procurement'`, sql`${agentCommandRequests.binding}->>'kind'='invoice_record'`))
        .orderBy(desc(agentCommandRequests.id)).limit(21);
      return AgentDependencyPlanWorkspaceSchema.parse({ version: AGENT_DEPENDENCY_PLAN_VERSION, contextAuthority: stamp(current.session),
        canCreate: this.canAccess(current.effective, "prepare"), kind: AGENT_DEPENDENCY_PLAN_KIND,
        parents: parents.slice(0, 20).map(value => ({ ...value, createdAt: value.createdAt.toISOString() })),
        parentLimit: 20, parentHasMore: parents.length > 20, newPreparationIsExecution: false });
    });
  }

  async create(context: TenantContext, raw: unknown) {
    const input = parse(CreateAgentDependencyPlanSchema, raw), requestChecksum = sha(canonicalAgentDependencyPlanRequest(input));
    const admission = await withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context);
      const [old] = await tx.select().from(plans).where(and(eq(plans.ownerId, context.userId), eq(plans.requestId, input.requestId)));
      if (old && old.requestChecksum !== requestChecksum) conflict("agent_dependency_plan_request_mismatch");
      if (!old) this.requireAccess(current.effective, "prepare");
      return { ...current, old };
    });
    if (admission.old) return this.get(context, admission.old.id);
    const parent = await this.source.read(admission.effective, input.parentAgentCommandId);
    if (parent.blockReason === "parent_unavailable" || parent.blockReason === "permission_denied")
      conflict("agent_dependency_plan_parent_unavailable");
    const created = await withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context); this.sameAuthority(admission, current);
      this.requireAccess(current.effective, "prepare");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-dependency-plan:${context.tenantId}:${context.userId}:${input.requestId.toLowerCase()}`},0))`);
      const [old] = await tx.select().from(plans).where(and(eq(plans.ownerId, context.userId), eq(plans.requestId, input.requestId))).for("update");
      if (old) { if (old.requestChecksum !== requestChecksum) conflict("agent_dependency_plan_request_mismatch"); return old; }
      const now = await this.now(tx);
      const [row] = await tx.insert(plans).values({ id: createEntityId(), tenantId: current.session.tenantId, ownerId: current.session.userId,
        version: AGENT_DEPENDENCY_PLAN_VERSION, kind: AGENT_DEPENDENCY_PLAN_KIND, requestId: input.requestId, requestChecksum,
        parentAgentCommandId: input.parentAgentCommandId, originCeiling: current.effective, childRequestId: createEntityId(), childNativeKey: createEntityId(),
        dueAt: input.dueAt === null ? null : new Date(input.dueAt), createdAt: now, updatedAt: now,
        expiresAt: new Date(now.getTime() + AGENT_DEPENDENCY_PLAN_RETENTION_SECONDS * 1000) }).returning();
      if (!row) conflict("agent_dependency_plan_create_failed");
      await this.record(tx, current.effective, row!, "create"); return row!;
    });
    return this.get(context, created.id);
  }

  async list(context: TenantContext, raw: unknown = {}) {
    const input = parse(AgentDependencyPlanListQuerySchema, raw);
    return withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context);
      let upperId = input.upperId?.toLowerCase() ?? null;
      if (upperId === null) {
        const [last] = await tx.select({ id: plans.id }).from(plans).where(and(eq(plans.ownerId, context.userId), eq(plans.version, AGENT_DEPENDENCY_PLAN_VERSION)))
          .orderBy(desc(plans.id)).limit(1); upperId = last?.id ?? null;
      }
      const rows = upperId === null ? [] : await tx.select().from(plans).where(and(eq(plans.ownerId, context.userId), eq(plans.version, AGENT_DEPENDENCY_PLAN_VERSION),
        lte(plans.id, upperId), input.before ? lt(plans.id, input.before) : undefined)).orderBy(desc(plans.id)).limit(input.limit + 1);
      const items = rows.slice(0, input.limit).map(summary), hasMore = rows.length > input.limit;
      return AgentDependencyPlanPageSchema.parse({ version: AGENT_DEPENDENCY_PLAN_VERSION, contextAuthority: stamp(current.session), items,
        limit: input.limit, upperId, nextBefore: hasMore ? items[items.length - 1]!.id : null, hasMore,
        scope: "personal", coverage: "bounded_original_id_range" });
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }

  async receipt(context: TenantContext, raw: unknown) {
    const input = parse(AgentDependencyPlanReceiptQuerySchema, raw);
    const initial = await withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context);
      const [row] = await tx.select().from(plans).where(and(eq(plans.ownerId, context.userId), eq(plans.requestId, input.requestId), eq(plans.version, AGENT_DEPENDENCY_PLAN_VERSION)));
      if (row && row.requestChecksum !== input.requestChecksum) conflict("agent_dependency_plan_request_mismatch");
      return { ...current, row };
    });
    if (initial.row) await this.recover(context, initial.row);
    return withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context);
      this.sameAuthority(initial, current);
      return AgentDependencyPlanReceiptSchema.parse({ version: AGENT_DEPENDENCY_PLAN_VERSION, ...input, contextAuthority: stamp(current.session),
        disposition: initial.row ? "known" : "not_found", id: initial.row?.id ?? null });
    });
  }

  /** Recovery can only attach the already prepared original child, including after expiry or cancellation. */
  private async recover(context: TenantContext, row: Row): Promise<Row> {
    if (!row.preparationRequestedAt || !row.childPreparationRequestChecksum || row.childOwnerCommandId) return row;
    const before = await this.frame(context, row.id);
    let receipt: Awaited<ReturnType<AgentCommandService["receipt"]>>;
    try { receipt = await this.commands.receipt(before.effective, { requestId: row.childRequestId, requestChecksum: row.childPreparationRequestChecksum }); }
    catch (error) { if (isUnavailable(error)) return before.row; throw error; }
    const after = await this.frame(context, row.id); this.sameAuthority(before, after);
    if (receipt.disposition !== "known" || !receipt.id || !receipt.ownerCommandId) return after.row;
    return this.link(context, after.row, receipt.id, receipt.ownerCommandId);
  }
  private async link(context: TenantContext, original: Row, commandId: string, ownerCommandId: string): Promise<Row> {
    return withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context, original.originCeiling);
      const row = await this.row(tx, context, original.id, true);
      if (!row.preparationRequestedAt || !row.childPreparationRequestChecksum || !row.childOriginalChecksum) conflict("agent_dependency_plan_child_mismatch");
      const [child] = await tx.select().from(agentCommandRequests).where(and(eq(agentCommandRequests.id, commandId), eq(agentCommandRequests.ownerId, current.session.userId)));
      if (!child || child.operation !== "prepare" || child.requestId !== row.childRequestId || child.requestChecksum !== row.childPreparationRequestChecksum
        || child.originalChecksum !== row.childOriginalChecksum || child.ownerCommandId !== ownerCommandId || child.binding.domain !== "finance"
        || child.binding.kind !== "bill_record" || child.binding.targetId !== null || child.binding.accountId !== null
        || child.binding.requestKeyHash !== sha(row.childNativeKey))
        conflict("agent_dependency_plan_child_mismatch");
      if (row.childAgentCommandId !== null && row.childAgentCommandId !== commandId || row.childOwnerCommandId !== null && row.childOwnerCommandId !== ownerCommandId)
        conflict("agent_dependency_plan_child_mismatch");
      if (row.childAgentCommandId === commandId && row.childOwnerCommandId === ownerCommandId) return row;
      const [saved] = await tx.update(plans).set({ childAgentCommandId: commandId, childOwnerCommandId: ownerCommandId, updatedAt: sql`clock_timestamp()` })
        .where(eq(plans.id, row.id)).returning();
      await this.record(tx, current.effective, saved!, "link"); return saved!;
    });
  }

  private async parentMetadata(context: TenantContext, row: Row): Promise<AgentDependencyPlanCommand> {
    return withTenant(this.database.db, context, async tx => {
      await this.current(tx, context, row.originCeiling);
      const [parent] = await tx.select().from(agentCommandRequests).where(and(eq(agentCommandRequests.id, row.parentAgentCommandId), eq(agentCommandRequests.ownerId, context.userId)));
      if (!parent || parent.binding.domain !== "procurement" || parent.binding.kind !== "invoice_record") conflict("agent_dependency_plan_parent_invalid");
      return AgentDependencyPlanCommandSchema.parse({ agentCommandId: parent!.id, requestId: parent!.requestId, requestChecksum: parent!.requestChecksum,
        ownerCommandId: parent!.ownerCommandId, domain: "procurement", kind: "invoice_record", state: "unavailable", resultId: null });
    });
  }
  private async readSource(context: TenantContext, row: Row): Promise<AgentDependencyPlanSourceRead> {
    try { return await this.source.read(context, row.parentAgentCommandId); }
    catch (error) {
      if (!isUnavailable(error)) throw error;
      return { parent: await this.parentMetadata(context, row), source: null,
        blockReason: errorCode(error) === "agent_dependency_plan_source_changed" ? "source_changed" : error instanceof ForbiddenError || error instanceof HttpException && error.getStatus() === 403 ? "permission_denied" : "source_unavailable" };
    }
  }
  private async child(context: TenantContext, row: Row): Promise<AgentDependencyPlanCommand | null> {
    if (!row.childAgentCommandId || !row.childOwnerCommandId) return null;
    let view: AgentCommandView;
    try { view = await this.commands.get(context, row.childAgentCommandId); }
    catch (error) { if (isUnavailable(error)) return null; throw error; }
    if (view.id !== row.childAgentCommandId || view.ownerCommandId !== row.childOwnerCommandId || view.requestId !== row.childRequestId
      || view.requestChecksum !== row.childPreparationRequestChecksum) conflict("agent_dependency_plan_child_mismatch");
    return dependencyCommandFromView(view, "finance", "bill_record");
  }

  async get(context: TenantContext, rawId: string): Promise<AgentDependencyPlanView> {
    const id = parse(Id, rawId).toLowerCase(), before = await this.frame(context, id);
    const recovered = await this.recover(context, before.row);
    await this.readSource(before.effective, recovered);
    const child = await this.child(before.effective, recovered);
    const current = await this.frame(context, id); this.sameAuthority(before, current);
    // Re-enter the original source owner after the child I/O; a membership stamp alone does not fence object ownership.
    const source = await this.readSource(before.effective, recovered);
    const after = await this.frame(context, id); this.sameAuthority(before, after);
    const row = after.row, expires = row.expiresAt <= after.now;
    let currentSource = source.source, childDraft: AgentDependencyPlanBillDraft | null = null, blockReason = source.blockReason;
    if (currentSource && row.sourceChecksum !== null && (row.sourceChecksum !== currentSource.sourceChecksum || row.sourceInvoiceId !== currentSource.invoiceId)) {
      currentSource = null; blockReason = "source_changed";
    }
    if (currentSource && !expires) {
      try { childDraft = this.source.derive(currentSource, { dueAt: row.dueAt?.toISOString() ?? null, nativeKey: row.childNativeKey }); }
      catch (error) { if (errorCode(error) !== "agent_dependency_plan_finance_input_invalid") throw error; blockReason = "finance_input_invalid"; }
      if (childDraft && row.childPreparationRequestChecksum !== null) {
        const hashes = this.hashes(row, childDraft);
        if (hashes.childOriginalChecksum !== row.childOriginalChecksum || hashes.childPreparationRequestChecksum !== row.childPreparationRequestChecksum) {
          currentSource = null; childDraft = null; blockReason = "source_changed";
        }
      }
    }
    const actualChild = child && child.agentCommandId === row.childAgentCommandId && child.ownerCommandId === row.childOwnerCommandId ? child : null;
    const writable = this.canAccess(after.effective, "prepare");
    let state: AgentDependencyPlanView["state"];
    if (actualChild?.state === "succeeded" && actualChild.resultId) { state = "succeeded"; blockReason = null; }
    else if (row.cancelledAt) { state = "cancelled"; blockReason = "cancelled"; }
    else if (expires) { state = "expired"; blockReason = "expired"; }
    else if (row.childOwnerCommandId) {
      if (actualChild?.state === "prepared") { state = "child_prepared"; blockReason = null; }
      else if (actualChild && ["unknown", "executing", "preparing"].includes(actualChild.state)) { state = "child_unknown"; blockReason = "preparation_unresolved"; }
      else { state = "blocked"; blockReason = "child_unavailable"; }
    } else if (!writable) { state = "blocked"; blockReason = "permission_denied"; }
    else if (source.parent.state !== "succeeded") {
      state = source.blockReason === "parent_not_succeeded" ? "waiting_predecessor" : "predecessor_blocked";
    } else if (!currentSource || !childDraft) { state = "blocked"; blockReason ??= "source_unavailable"; }
    else if (row.preparationRequestedAt) { state = "preparation_unknown"; blockReason = "preparation_unresolved"; }
    else { state = "ready_to_prepare"; blockReason = null; }
    if (expires) { currentSource = null; childDraft = null; }
    const canPrepare = writable && !expires && row.cancelledAt === null && row.childOwnerCommandId === null && !!currentSource && !!childDraft
      && (state === "ready_to_prepare" || state === "preparation_unknown");
    return AgentDependencyPlanViewSchema.parse({ ...summary(row), contextAuthority: stamp(after.session), state, parent: source.parent, child: actualChild,
      dependency: { from: "procurement_invoice", to: "finance_bill", requires: "original_owner_succeeded" },
      source: currentSource, childDraft, privateAvailable: currentSource !== null, canPrepare,
      canCancel: !expires && row.cancelledAt === null && this.canAccess(after.effective, "cancel"), blockReason,
      businessExecution: "separate_original_confirmation", modelCalls: 0, queueDispatches: 0 });
  }

  private hashes(row: Row, draft: AgentDependencyPlanBillDraft) {
    const request = { version: AGENT_COMMAND_VERSION, requestId: row.childRequestId, original: draft };
    return { request, childOriginalChecksum: sha(canonicalAgentCommandOriginal(draft)),
      childPreparationRequestChecksum: sha(canonicalAgentCommandRequest("prepare", request)) };
  }
  private preparable(frame: Frame) {
    this.requireAccess(frame.effective, "prepare");
    if (frame.row.cancelledAt) conflict("agent_dependency_plan_cancelled");
    if (frame.row.expiresAt <= frame.now) conflict("agent_dependency_plan_expired");
  }
  async prepare(context: TenantContext, rawId: string, raw: unknown) {
    const id = parse(Id, rawId).toLowerCase(), input = parse(PrepareAgentDependencyPlanSchema, raw), before = await this.frame(context, id);
    if (before.row.requestId !== input.requestId.toLowerCase()) conflict("agent_dependency_plan_request_mismatch");
    this.preparable(before);
    if (before.row.sourceChecksum !== null && before.row.sourceChecksum !== input.sourceChecksum) conflict("agent_dependency_plan_source_changed");
    if (before.row.childOwnerCommandId) return this.get(context, id);
    const first = await this.source.read(before.effective, before.row.parentAgentCommandId);
    let fresh = await this.frame(context, id); this.sameAuthority(before, fresh); this.preparable(fresh);
    if (!first.source || first.parent.state !== "succeeded") conflict(`agent_dependency_plan_${first.blockReason ?? "source_unavailable"}`);
    if (first.source!.sourceChecksum !== input.sourceChecksum) conflict("agent_dependency_plan_source_changed");
    const draft = this.source.derive(first.source!, { dueAt: before.row.dueAt?.toISOString() ?? null, nativeKey: before.row.childNativeKey }), hashes = this.hashes(before.row, draft);
    // The second original-owner read fences an unchanged membership whose object ownership changed during I/O.
    const checked = await this.source.read(before.effective, before.row.parentAgentCommandId);
    fresh = await this.frame(context, id); this.sameAuthority(before, fresh); this.preparable(fresh);
    if (!checked.source || checked.parent.state !== "succeeded" || checked.source.sourceChecksum !== first.source!.sourceChecksum)
      conflict("agent_dependency_plan_source_changed");
    const staged = await withTenant(this.database.db, context, async tx => {
      const current = await this.current(tx, context, before.row.originCeiling); this.sameAuthority(before, current);
      this.requireAccess(current.effective, "prepare");
      const row = await this.row(tx, context, id, true), now = await this.now(tx);
      this.preparable({ row, ...current, now });
      if (row.requestId !== input.requestId.toLowerCase()) conflict("agent_dependency_plan_request_mismatch");
      if (row.preparationRequestedAt) {
        if (row.sourceInvoiceId !== checked.source!.invoiceId || row.sourceChecksum !== input.sourceChecksum || row.childOriginalChecksum !== hashes.childOriginalChecksum
          || row.childPreparationRequestChecksum !== hashes.childPreparationRequestChecksum) conflict("agent_dependency_plan_source_changed");
        return { row, ...current };
      }
      const [saved] = await tx.update(plans).set({ sourceInvoiceId: checked.source!.invoiceId, sourceChecksum: input.sourceChecksum,
        childOriginalChecksum: hashes.childOriginalChecksum, childPreparationRequestChecksum: hashes.childPreparationRequestChecksum,
        preparationRequestedAt: now, updatedAt: now }).where(eq(plans.id, row.id)).returning();
      await this.record(tx, current.effective, saved!, "prepare"); return { row: saved!, ...current };
    });
    if (!staged.row.childOwnerCommandId) {
      const dispatch = await this.frame(context, id); this.sameAuthority(before, dispatch); this.preparable(dispatch);
      // Never hold a coordination transaction or lock while entering the original owner's preparation.
      const child = await this.commands.prepare(dispatch.effective, hashes.request);
      const after = await this.frame(context, id); this.sameAuthority(before, after);
      if (child.ownerCommandId) await this.link(context, after.row, child.id, child.ownerCommandId);
    }
    return this.get(context, id);
  }

  async cancel(context: TenantContext, rawId: string, raw: unknown) {
    const id = parse(Id, rawId).toLowerCase(), input = parse(CancelAgentDependencyPlanSchema, raw);
    await withTenant(this.database.db, context, async tx => {
      const initial = await this.row(tx, context, id), current = await this.current(tx, context, initial.originCeiling, "cancel");
      const row = await this.row(tx, context, id, true);
      if (row.requestId !== input.requestId.toLowerCase()) conflict("agent_dependency_plan_request_mismatch");
      if (row.cancelledAt) return;
      const now = await this.now(tx);
      const [saved] = await tx.update(plans).set({ cancelledAt: now, updatedAt: now }).where(eq(plans.id, row.id)).returning();
      await this.record(tx, current.effective, saved!, "cancel");
    });
    return this.get(context, id);
  }
}

function summary(row: Row): AgentDependencyPlanSummary {
  return AgentDependencyPlanSummarySchema.parse({ version: AGENT_DEPENDENCY_PLAN_VERSION, id: row.id, requestId: row.requestId, requestChecksum: row.requestChecksum,
    kind: AGENT_DEPENDENCY_PLAN_KIND, parentAgentCommandId: row.parentAgentCommandId, childRequestId: row.childRequestId,
    childAgentCommandId: row.childAgentCommandId, childOwnerCommandId: row.childOwnerCommandId, childPreparationRequestChecksum: row.childPreparationRequestChecksum,
    childOriginalChecksum: row.childOriginalChecksum, preparationRequestedAt: row.preparationRequestedAt?.toISOString() ?? null,
    dueAt: row.dueAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null });
}
function errorCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body: unknown = error.getResponse();
  return typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : null;
}
function isUnavailable(error: unknown): boolean {
  if (errorCode(error) === "authority_changed") return false;
  return error instanceof ForbiddenError || error instanceof HttpException && [403, 404, 409, 410].includes(error.getStatus());
}
