import { createHash, randomUUID } from "node:crypto";
import { ConflictException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission, requireTenantOrderPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import {
  FULFILLMENT_COMMAND_VERSION, FulfillmentCommandListSchema, FulfillmentCommandQuerySchema, FulfillmentCommandViewSchema,
  fulfillmentCommandCanonicalJson, fulfillmentCommandRequestKey, normalizeFulfillmentCommand,
  type FulfillmentCommandKind, type FulfillmentCommandSummary, type FulfillmentCommandView, type PrepareFulfillmentCommand,
} from "@yummyai/contracts/order/fulfillment-command";
import { orderFulfillmentCommandIntents as intents, orderLines, orderProtectedDetails, orders, orderWorkItems,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { currentOrderAuthority } from "@yummyai/order-core";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderFulfillmentCommandOwner } from "./order-fulfillment-command-owner.js";
import { fulfillmentCommandBinding, fulfillmentCommandPermissions } from "./order-fulfillment-command-fence.js";

type Intent = typeof intents.$inferSelect;
const readPermissions = [Permission.OrderRead, Permission.OrderPiiRead];
const retentionMs = 7 * 24 * 60 * 60 * 1000, leaseMs = 120_000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const writePermissions = (kind: FulfillmentCommandKind) => [
  ...readPermissions, Permission.OrderWrite,
  ...(["delivery_create", "delivery_feedback"].includes(kind) ? [Permission.DesignRead, Permission.AssetRead] : []),
];

/** Internal read frame. Ciphertexts, data keys and execution lease tokens never leave this owner. */
export type OrderFulfillmentAgentFrame = {
  native: FulfillmentCommandView;
  original: PrepareFulfillmentCommand | null;
  session: TenantContext;
  effective: TenantContext;
  originCeiling: TenantContext;
  generation: number;
  checkedAt: Date;
};
/** Additional gates are used only by the independent Agent protocol. Legacy calls omit this argument. */
export type OrderFulfillmentAgentGate = {
  orderId: string;
  requestId?: string;
  requestChecksum?: string;
  beforeClaim?: (tx: TenantTransaction, frame: OrderFulfillmentAgentFrame) => Promise<void>;
};

/** Durable original input, never a second fulfillment fact ledger or executor. */
@Injectable()
export class OrderFulfillmentCommandService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderFulfillmentCommandOwner) private readonly owner: OrderFulfillmentCommandOwner,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async prepare(context: TenantContext, raw: unknown, agent?: OrderFulfillmentAgentGate): Promise<FulfillmentCommandView> {
    const command = normalizeFulfillmentCommand(raw), binding = fulfillmentCommandBinding(command);
    const requestChecksum = hash(fulfillmentCommandCanonicalJson(command));
    return withTenant(this.database.db, context, async tx => {
      const authority = await currentOrderAuthority(tx, context, [...readPermissions, ...fulfillmentCommandPermissions(command)], { requireMembership: true });
      if (agent) await this.agentAuthority(tx, context, undefined, true);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fulfillment-request:${context.tenantId}:${context.userId}:${command.requestId}`},0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fulfillment-owner:${context.tenantId}:${command.kind}:${command.targetId}:${binding.requestKey}`},0))`);
      const priorWhere = or(
        and(eq(intents.createdBy, context.userId), eq(intents.requestId, command.requestId)),
        and(eq(intents.kind, command.kind), eq(intents.targetId, command.targetId), eq(intents.requestKey, binding.requestKey)),
      );
      // Agent privacy readers/writers use source -> intent order, including an
      // exact replay. Legacy admission keeps its existing locking behavior.
      const prior = agent ? await tx.select().from(intents).where(priorWhere) : await tx.select().from(intents).where(priorWhere).for("update");
      if (prior.length) {
        let row = prior[0]!;
        if (row.contractVersion !== (agent ? AGENT_FULFILLMENT_COMMAND_VERSION : FULFILLMENT_COMMAND_VERSION))
          throw new ConflictException({ code: "agent_fulfillment_command_protocol_mismatch" });
        if (agent) {
          this.agentPins(row, agent);
          row = await this.agentOwned(tx, context, row.id, agent);
          await this.agentAuthority(tx, context, row, true);
        }
        if (prior.length !== 1 || row.createdBy !== context.userId || row.requestId !== command.requestId || row.requestChecksum !== requestChecksum || row.ownerChecksum !== binding.ownerChecksum)
          throw new ConflictException("原履约提交的操作员 目标 正文或请求编号不能改变");
        return this.view(tx, context, row, Boolean(agent));
      }
      const described = await this.owner.describe(tx, authority, command);
      if (agent && described.orderId !== agent.orderId) throw new NotFoundException("原履约目标不属于指定订单");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`fulfillment-order:${context.tenantId}:${context.userId}:${described.orderId}`},0))`);
      const lineIds = [...new Set(described.lineIds)].sort();
      if (!lineIds.length || lineIds.length > 100) throw new ConflictException("本次履约商品来源不完整");
      const source = await this.source(tx, { orderId: described.orderId, lineIds }, true), now = await this.now(tx);
      if (!source.available) throw new NotFoundException("原订单或制作资料已到期或清理");
      const unresolved = await tx.select({ id: intents.id, lineIds: intents.lineIds }).from(intents).where(and(
        eq(intents.createdBy, context.userId), eq(intents.orderId, described.orderId), isNull(intents.acknowledgedAt),
      )).limit(101);
      if (unresolved.length > 100 || unresolved.some(row => row.lineIds.some(id => lineIds.includes(id))))
        throw new ConflictException("请先核对同单原履约提交的结果 再开始新提交");
      // Detect a historical owner-key conflict before admitting a new execution.
      await this.owner.locate(tx, authority, command);
      const deadline = Math.min(now.getTime() + retentionMs, source.deadline, described.deadline);
      if (!Number.isFinite(deadline) || deadline <= now.getTime()) throw new NotFoundException("原履约来源保留期已结束");
      const id = createEntityId();
      const [row] = await tx.insert(intents).values({ id, tenantId: context.tenantId, createdBy: context.userId,
        requestId: command.requestId, orderId: described.orderId, lineIds, kind: command.kind, targetId: command.targetId,
        requestKey: fulfillmentCommandRequestKey(command), requestChecksum, ownerChecksum: binding.ownerChecksum,
        authoritySnapshot: authority, contractVersion: agent ? AGENT_FULFILLMENT_COMMAND_VERSION : FULFILLMENT_COMMAND_VERSION, createdAt: now, expiresAt: new Date(deadline),
        encryptedInput: this.vault.encrypt(JSON.stringify({ tenantId: context.tenantId, userId: context.userId, intentId: id, command, summary: described.summary })),
      }).returning();
      await this.audit.recordInTransaction(tx, authority, { action: "order_fulfillment_command.prepare", resourceType: "order_fulfillment_command", resourceId: id,
        result: "success", metadata: { kind: command.kind, orderId: described.orderId, lineCount: lineIds.length } });
      return this.view(tx, context, row!, Boolean(agent));
    });
  }

  async list(context: TenantContext, raw: unknown) {
    const query = FulfillmentCommandQuerySchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
      const rows = await tx.select().from(intents).where(and(eq(intents.createdBy, context.userId), eq(intents.orderId, query.orderId),
        query.requestId ? eq(intents.requestId, query.requestId) : isNull(intents.acknowledgedAt),
        query.requestChecksum ? eq(intents.requestChecksum, query.requestChecksum) : undefined,
        query.lineId ? sql`${intents.lineIds} ? ${query.lineId}` : undefined,
      )).orderBy(asc(intents.createdAt), asc(intents.id)).limit(101).for("update");
      const items: FulfillmentCommandView[] = [];
      for (const row of rows.slice(0, 100)) items.push(await this.view(tx, context, row));
      return FulfillmentCommandListSchema.parse({ items, truncated: rows.length > 100 });
    });
  }

  async get(context: TenantContext, id: string): Promise<FulfillmentCommandView> {
    return withTenant(this.database.db, context, async tx => this.view(tx, context, await this.owned(tx, context, id, true)));
  }

  async execute(context: TenantContext, id: string, agent?: OrderFulfillmentAgentGate): Promise<FulfillmentCommandView> {
    const claim = await withTenant(this.database.db, context, async tx => {
      const row = agent ? await this.agentOwned(tx, context, id, agent) : await this.owned(tx, context, id, true);
      this.executionProtocol(row, Boolean(agent));
      const authority = await this.authority(tx, context, row, true);
      if (agent) await this.agentAuthority(tx, context, row, true);
      const view = await this.view(tx, context, row, Boolean(agent));
      if (agent) {
        const frame = await this.agentFrame(tx, context, row);
        if (!frame.original) throw new ConflictException("原履约正文当前不可读");
        await agent.beforeClaim?.(tx, frame);
      }
      const now = await this.now(tx);
      if (view.status === "succeeded") return null;
      if (!view.canExecute || agent && row.expiresAt <= now) throw new ConflictException("原履约提交当前不能恢复执行 请先核对原结果");
      const { command } = this.envelope(context, row, Boolean(agent)), token = randomUUID();
      await tx.update(intents).set({ status: "executing", generation: row.generation + 1, leaseToken: token,
        leaseExpiresAt: new Date(Math.min(now.getTime() + leaseMs, row.expiresAt.getTime())), errorCode: null,
      }).where(eq(intents.id, row.id));
      await this.audit.recordInTransaction(tx, authority, { action: "order_fulfillment_command.claim", resourceType: "order_fulfillment_command", resourceId: row.id,
        result: "success", metadata: { kind: row.kind, generation: row.generation + 1 } });
      return { command, authority, generation: row.generation + 1, leaseToken: token };
    });
    if (!claim) return this.get(context, id);
    let failure: unknown;
    try { await this.owner.execute(claim.authority, claim.command, { intentId: id, leaseToken: claim.leaseToken, ...(agent ? { agent: true as const } : {}) }); }
    catch (error) { failure = error; }
    // The original transaction may have committed even when its read/response
    // failed. Always inspect committed owner evidence before classifying it.
    await withTenant(this.database.db, context, async tx => {
      const row = agent ? await this.agentOwned(tx, context, id, agent) : await this.owned(tx, context, id, true);
      if (row.generation !== claim.generation || row.leaseToken !== claim.leaseToken) return;
      const authority = await this.authority(tx, context, row, false), source = await this.source(tx, row), now = await this.now(tx);
      if (!source.available || row.expiresAt <= now || !row.encryptedInput) { await this.redact(tx, row, now); return; }
      const receipt = await this.owner.locate(tx, authority, claim.command);
      const definitive = !receipt && failure instanceof HttpException && [400, 409, 422].includes(failure.getStatus());
      await tx.update(intents).set({ status: definitive ? "rejected" : "uncertain", leaseToken: null, leaseExpiresAt: null,
        errorCode: receipt ? null : definitive ? "conflict" : "unknown",
      }).where(and(eq(intents.id, id), eq(intents.generation, claim.generation), eq(intents.leaseToken, claim.leaseToken)));
    });
    return this.get(context, id);
  }

  async cancel(context: TenantContext, id: string, agent?: OrderFulfillmentAgentGate) {
    return withTenant(this.database.db, context, async tx => {
      const row = agent ? await this.agentOwned(tx, context, id, agent) : await this.owned(tx, context, id, true);
      this.executionProtocol(row, Boolean(agent));
      await this.authority(tx, context, row, true);
      if (agent) await this.agentAuthority(tx, context, row, true);
      const view = await this.view(tx, context, row, Boolean(agent));
      if (view.status === "succeeded") return view;
      if (!view.canCancel) throw new ConflictException("当前原提交不能取消 请先核对已执行结果");
      const [updated] = await tx.update(intents).set({ status: "cancelled", leaseToken: null, leaseExpiresAt: null, errorCode: null }).where(eq(intents.id, id)).returning();
      await this.audit.recordInTransaction(tx, context, { action: "order_fulfillment_command.cancel", resourceType: "order_fulfillment_command", resourceId: id, result: "success", metadata: { kind: row.kind } });
      return this.view(tx, context, updated!, Boolean(agent));
    });
  }

  async acknowledge(context: TenantContext, id: string, agent?: OrderFulfillmentAgentGate) {
    return withTenant(this.database.db, context, async tx => {
      const row = agent ? await this.agentOwned(tx, context, id, agent) : await this.owned(tx, context, id, true);
      this.executionProtocol(row, Boolean(agent));
      if (agent) await this.agentAuthority(tx, context, row, true);
      const view = await this.view(tx, context, row, Boolean(agent));
      if (row.acknowledgedAt) return view;
      if (!["succeeded", "rejected", "cancelled", "expired"].includes(view.status)) throw new ConflictException("请先核对原履约结果 不能清除尚未确认的提交");
      const now = await this.now(tx);
      const [updated] = await tx.update(intents).set({ acknowledgedAt: now, encryptedInput: null, redactedAt: row.redactedAt ?? now,
        leaseToken: null, leaseExpiresAt: null, status: row.status === "executing" ? "uncertain" : row.status,
      }).where(eq(intents.id, id)).returning();
      await this.audit.recordInTransaction(tx, context, { action: "order_fulfillment_command.acknowledge", resourceType: "order_fulfillment_command", resourceId: id,
        result: "success", metadata: { kind: row.kind } });
      return this.view(tx, context, updated!, Boolean(agent));
    });
  }

  async readForAgent(context: TenantContext, id: string, orderId: string): Promise<OrderFulfillmentAgentFrame> {
    return withTenant(this.database.db, context, async tx => this.agentFrame(tx, context,
      await this.agentOwned(tx, context, id, { orderId })));
  }

  async listForAgent(context: TenantContext, raw: unknown): Promise<{ items: OrderFulfillmentAgentFrame[]; truncated: boolean; session: TenantContext }> {
    const query = FulfillmentCommandQuerySchema.parse(raw);
    return withTenant(this.database.db, context, async tx => {
      await this.agentAuthority(tx, context);
      const rows = await tx.select({ id: intents.id }).from(intents).where(and(eq(intents.createdBy, context.userId), eq(intents.orderId, query.orderId),
        eq(intents.contractVersion, AGENT_FULFILLMENT_COMMAND_VERSION), isNull(intents.acknowledgedAt), query.lineId ? sql`${intents.lineIds} ? ${query.lineId}` : undefined,
      )).orderBy(asc(intents.createdAt), asc(intents.id)).limit(101);
      const items: OrderFulfillmentAgentFrame[] = [];
      for (const row of rows.slice(0, 100)) items.push(await this.agentFrame(tx, context, await this.agentOwned(tx, context, row.id, { orderId: query.orderId })));
      const { session } = await this.agentAuthority(tx, context);
      return { items, truncated: rows.length > 100, session };
    });
  }

  /** Metadata-only exact recovery. No prepare, execute, envelope decryption or business write. */
  async receiptForAgent(context: TenantContext, query: { orderId: string; requestId: string; requestChecksum: string }) {
    return withTenant(this.database.db, context, async tx => {
      await this.agentAuthority(tx, context);
      const [row] = await tx.select().from(intents).where(and(eq(intents.createdBy, context.userId), eq(intents.requestId, query.requestId)));
      if (row) { this.agentPins(row, query); this.executionProtocol(row, true); await this.agentAuthority(tx, context, row); }
      const { session } = await this.agentAuthority(tx, context);
      return { id: row?.id ?? null, session };
    });
  }

  private agentPins(row: Intent, gate: OrderFulfillmentAgentGate) {
    if (row.orderId !== gate.orderId) throw new NotFoundException("原履约目标不属于指定订单");
    if (gate.requestId !== undefined && row.requestId !== gate.requestId || gate.requestChecksum !== undefined && row.requestChecksum !== gate.requestChecksum)
      throw new ConflictException({ code: "agent_fulfillment_command_request_mismatch" });
  }

  private executionProtocol(row: Intent, agent: boolean) {
    if (row.contractVersion !== (agent ? AGENT_FULFILLMENT_COMMAND_VERSION : FULFILLMENT_COMMAND_VERSION))
      throw new ConflictException({ code: "agent_fulfillment_command_protocol_mismatch" });
  }

  private async agentAuthority(tx: TenantTransaction, context: TenantContext, row?: Intent, write = false) {
    const session = await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
    const effective = row ? intersectPermissionContexts(row.authoritySnapshot, session) : session;
    requireTenantOrderPermissions(effective, readPermissions);
    authorize(effective, Permission.WorkflowRead, { ownerId: context.userId });
    if (write) authorize(effective, Permission.WorkflowRun, { ownerId: context.userId });
    return { session, effective };
  }

  private async agentOwned(tx: TenantTransaction, context: TenantContext, id: string, gate: OrderFulfillmentAgentGate) {
    const metadata = await this.owned(tx, context, id);
    this.agentPins(metadata, gate);
    this.executionProtocol(metadata, true);
    await this.source(tx, metadata, true);
    const row = await this.owned(tx, context, id, true);
    this.agentPins(row, gate);
    this.executionProtocol(row, true);
    await this.agentAuthority(tx, context, row);
    return row;
  }

  private async agentFrame(tx: TenantTransaction, context: TenantContext, initial: Intent): Promise<OrderFulfillmentAgentFrame> {
    let native = await this.view(tx, context, initial, true);
    const row = await this.owned(tx, context, initial.id);
    const { session, effective } = await this.agentAuthority(tx, context, row);
    let original: PrepareFulfillmentCommand | null = null;
    let deadline = -Infinity;
    if (row.encryptedInput && !row.acknowledgedAt && !row.redactedAt && native.summary) {
      const stored = this.envelope(context, row, true);
      requireTenantOrderPermissions(effective, fulfillmentCommandPermissions(stored.command, false));
      const described = await this.owner.describe(tx, effective, stored.command), source = await this.source(tx, row), now = await this.now(tx);
      if (source.available && row.expiresAt > now && described.deadline > now.getTime() && described.orderId === row.orderId &&
        described.lineIds.length === row.lineIds.length && new Set(described.lineIds).size === row.lineIds.length && described.lineIds.every(id => row.lineIds.includes(id))) {
        original = stored.command;
        deadline = Math.min(row.expiresAt.getTime(), source.deadline, described.deadline);
      }
      else { await this.redact(tx, row, now); native = await this.view(tx, context, await this.owned(tx, context, row.id), true); }
    }
    const checkedAt = await this.now(tx);
    if (original && deadline <= checkedAt.getTime()) {
      original = null;
      await this.redact(tx, row, checkedAt);
      native = await this.view(tx, context, await this.owned(tx, context, row.id), true);
    }
    if (!original) native = FulfillmentCommandViewSchema.parse({ ...native, summary: null, receipt: null, canExecute: false, canCancel: false,
      status: native.status === "succeeded" ? "expired" : native.status, leaseExpiresAt: null });
    return { native, original, session, effective, originCeiling: row.authoritySnapshot, generation: row.generation, checkedAt };
  }

  private async owned(tx: TenantTransaction, context: TenantContext, id: string, lock = false) {
    await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
    const query = tx.select().from(intents).where(and(eq(intents.id, id), eq(intents.createdBy, context.userId)));
    const [row] = await (lock ? query.for("update") : query);
    if (!row) throw new NotFoundException("本人的原履约提交不存在");
    return row;
  }

  private async authority(tx: TenantTransaction, context: TenantContext, row: Intent, write: boolean) {
    const current = await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
    const authority = intersectPermissionContexts(row.authoritySnapshot, current);
    requireTenantOrderPermissions(authority, write ? writePermissions(row.kind) : readPermissions);
    return authority;
  }

  private envelope(context: TenantContext, row: Intent, agent = false) {
    if (!row.encryptedInput) throw new ConflictException("原履约正文已按保留规则清除");
    return this.vault.withSecret(row.encryptedInput, text => {
      const saved = JSON.parse(text) as { tenantId: string; userId: string; intentId: string; command: unknown; summary: FulfillmentCommandSummary };
      const command = normalizeFulfillmentCommand(saved.command), binding = fulfillmentCommandBinding(command);
      if (saved.tenantId !== context.tenantId || saved.userId !== context.userId || saved.intentId !== row.id || row.contractVersion !== (agent ? AGENT_FULFILLMENT_COMMAND_VERSION : FULFILLMENT_COMMAND_VERSION) ||
        command.requestId !== row.requestId || command.kind !== row.kind || command.targetId !== row.targetId || binding.requestKey !== row.requestKey ||
        binding.ownerChecksum !== row.ownerChecksum || hash(fulfillmentCommandCanonicalJson(command)) !== row.requestChecksum)
        throw new ConflictException("原履约提交完整性校验失败");
      return { command, summary: saved.summary };
    });
  }

  private async view(tx: TenantTransaction, context: TenantContext, original: Intent, agent = false): Promise<FulfillmentCommandView> {
    let row = original;
    const authority = await this.authority(tx, context, row, false), now = await this.now(tx), source = await this.source(tx, row);
    if (row.encryptedInput && (!source.available || row.expiresAt <= now)) row = await this.redact(tx, row, now);
    let retained = Boolean(row.encryptedInput && source.available && row.expiresAt > now && !row.acknowledgedAt);
    let summary: FulfillmentCommandSummary | null = null, receipt: FulfillmentCommandView["receipt"] = null;
    let errorCode = row.errorCode, status: FulfillmentCommandView["status"] = row.acknowledgedAt ? "acknowledged" : !retained && row.status !== "cancelled" && row.status !== "rejected" ? "expired" : row.status;
    if (!agent && row.contractVersion === AGENT_FULFILLMENT_COMMAND_VERSION) {
      // This is the original transport's metadata view, not an alternative
      // approval path. Business success remains available only from the Agent
      // protocol's typed owner receipt; no private envelope is opened here.
      if (status === "executing" && row.leaseExpiresAt && row.leaseExpiresAt <= now) status = "uncertain";
      return FulfillmentCommandViewSchema.parse({ id: row.id, requestId: row.requestId, requestChecksum: row.requestChecksum,
        kind: row.kind, targetId: row.targetId, orderId: row.orderId, lineIds: row.lineIds, status,
        createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
        acknowledged: Boolean(row.acknowledgedAt), canExecute: false, canCancel: false, summary: null, receipt: null, errorCode });
    }
    let writable = false;
    try { requireTenantOrderPermissions(authority, writePermissions(row.kind)); writable = true; } catch (error) { if (!(error instanceof ForbiddenError)) throw error; }
    let privateReadable = !["delivery_create", "delivery_feedback"].includes(row.kind) || [Permission.DesignRead, Permission.AssetRead].every(permission => {
      try { requireTenantOrderPermissions(authority, [permission]); return true; } catch (error) { if (error instanceof ForbiddenError) return false; throw error; }
    });
    if (retained && privateReadable) {
      const stored = this.envelope(context, row, agent);
      try { requireTenantOrderPermissions(authority, [...readPermissions, ...fulfillmentCommandPermissions(stored.command, false)]); }
      catch (error) { if (!(error instanceof ForbiddenError)) throw error; privateReadable = false; errorCode = "forbidden"; }
      try { requireTenantOrderPermissions(authority, [...readPermissions, ...fulfillmentCommandPermissions(stored.command)]); }
      catch (error) { if (!(error instanceof ForbiddenError)) throw error; writable = false; }
      if (privateReadable) summary = stored.summary;
      try { if (privateReadable) receipt = await this.owner.locate(tx, authority, stored.command); }
      catch (error) {
        if (error instanceof NotFoundException) {
          // A more specific original asset/editor gate can expire before the
          // coarse order/work privacy index. Hide it without replacing source.
          row = await this.redact(tx, row, await this.now(tx)); retained = false;
          summary = null; status = "expired"; errorCode = "source_unavailable";
        } else if (error instanceof ConflictException) { status = "rejected"; errorCode = "conflict"; }
        else throw error;
      }
      // A late original reader must not restore content after a more specific
      // editor source was cleared while its receipt query was in flight.
      if (privateReadable && retained) {
        try {
          const latest = await this.owner.describe(tx, authority, stored.command), checkedAt = await this.now(tx), currentSource = await this.source(tx, row);
          if (!currentSource.available || latest.deadline <= checkedAt.getTime() || row.expiresAt <= checkedAt || latest.orderId !== row.orderId ||
            latest.lineIds.length !== row.lineIds.length || !latest.lineIds.every(id => row.lineIds.includes(id))) throw new NotFoundException("原履约来源已失效");
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error;
          row = await this.redact(tx, row, await this.now(tx)); retained = false; receipt = null; summary = null; status = "expired"; errorCode = "source_unavailable";
        }
      }
      if (receipt) { status = "succeeded"; errorCode = null; }
      else if (status === "executing" && row.leaseExpiresAt && row.leaseExpiresAt <= now) status = "uncertain";
    } else if (retained && !privateReadable) { errorCode = "forbidden"; }
    const available = retained && privateReadable && writable && !receipt && !row.acknowledgedAt;
    const activeLease = row.status === "executing" && row.leaseExpiresAt && row.leaseExpiresAt > now;
    return FulfillmentCommandViewSchema.parse({ id: row.id, requestId: row.requestId, requestChecksum: row.requestChecksum,
      kind: row.kind, targetId: row.targetId, orderId: row.orderId, lineIds: row.lineIds, status,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
      acknowledged: Boolean(row.acknowledgedAt), canExecute: available && ["prepared", "uncertain"].includes(status),
      canCancel: available && !activeLease && ["prepared", "uncertain", "rejected"].includes(status), summary, receipt, errorCode,
    });
  }

  private async source(tx: TenantTransaction, row: Pick<Intent, "orderId" | "lineIds"> & Partial<Pick<Intent, "id">>, lock = false) {
    const oq = tx.select().from(orders).where(eq(orders.id, row.orderId)); const [order] = await (lock ? oq.for("share") : oq);
    const lq = tx.select({ id: orderLines.id }).from(orderLines).where(and(eq(orderLines.orderId, row.orderId), inArray(orderLines.id, row.lineIds)));
    const lines = await (lock ? lq.for("share") : lq);
    const pq = tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, row.orderId)); const [privacy] = await (lock ? pq.for("share") : pq);
    const wq = tx.select().from(orderWorkItems).where(inArray(orderWorkItems.id, row.lineIds)).orderBy(orderWorkItems.id); const work = await (lock ? wq.for("share") : wq);
    // A prepared v4 child retains its original owner, but its parent must still
    // authorize private reads as well as the final business fence. The database
    // predicate holds the parent's shared lock until this transaction ends.
    const [planSource] = row.id ? await tx.execute<{ available: boolean; deadline: Date | null }>(sql`
      select order_fulfillment_agent_plan_source_available(command) as available,
        (select parent.expires_at from agent_plan_items item
          join agent_plan_runs parent on parent.tenant_id=item.tenant_id and parent.id=item.run_id
          where item.tenant_id=command.tenant_id and item.id=command.request_id
            and parent.version='erp-agent-native-v4') as deadline
        from order_fulfillment_command_intents command where command.id=${row.id}::uuid`) : [];
    const now = await this.now(tx);
    const planDeadline = planSource?.deadline ? new Date(planSource.deadline).getTime() : Infinity;
    const available = Boolean((!row.id || planSource?.available && planDeadline > now.getTime()) &&
      order && order.addressStatus !== "anonymized" && lines.length === row.lineIds.length &&
      ((!privacy && order.addressStatus === "missing") || privacy?.status === "protected" && privacy.retentionExpiresAt > now) &&
      work.every(item => item.encryptedDataKey && !item.archivedAt && item.expiresAt > now));
    return { available, deadline: Math.min(planDeadline, privacy?.retentionExpiresAt.getTime() ?? Infinity, ...work.map(item => item.expiresAt.getTime())) };
  }

  private async redact(tx: TenantTransaction, row: Intent, now: Date) {
    const [updated] = await tx.update(intents).set({ encryptedInput: null, redactedAt: row.redactedAt ?? now, leaseToken: null, leaseExpiresAt: null,
      status: ["prepared", "executing", "uncertain"].includes(row.status) ? "expired" : row.status, errorCode: "source_unavailable",
    }).where(and(eq(intents.id, row.id), isNotNull(intents.encryptedInput))).returning();
    if (updated) return updated;
    const [current] = await tx.select().from(intents).where(eq(intents.id, row.id));
    if (!current) throw new NotFoundException("原履约提交不存在");
    return current;
  }
  private async now(tx: TenantTransaction) { const [row] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`); return new Date(row!.now); }
}
