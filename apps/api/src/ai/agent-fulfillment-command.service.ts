import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import {
  AGENT_COMMAND_CATALOG_V2_VERSION, AGENT_FULFILLMENT_COMMAND_VERSION, AGENT_FULFILLMENT_CONFIRMATION_SECONDS,
  AcknowledgeAgentFulfillmentCommandSchema, AgentFulfillmentCommandGetQuerySchema, AgentFulfillmentCommandListQuerySchema,
  AgentFulfillmentCommandListSchema, AgentFulfillmentCommandReceiptQuerySchema, AgentFulfillmentCommandReceiptSchema,
  AgentFulfillmentCommandViewSchema, AgentFulfillmentCommandWorkspaceSchema, AgentFulfillmentConfirmationSchema,
  CancelAgentFulfillmentCommandSchema, ConfirmAgentFulfillmentCommandSchema, PrepareAgentFulfillmentCommandSchema,
  canonicalAgentFulfillmentOriginal, type AgentFulfillmentCommandView, type AgentFulfillmentConfirmation,
} from "@yummyai/contracts/ai/agent-fulfillment-command";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { agentCommandV2Capabilities } from "@yummyai/workflow-core";
import type { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import type { OrderFulfillmentAgentFrame } from "../orders/order-fulfillment-command.service.js";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AgentFulfillmentCommandOwner } from "./agent-fulfillment-command-owner.js";

const Id = EntityIdSchema.refine(value => value === value.toLowerCase());
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: "agent_fulfillment_command_input_invalid" });
  return parsed.data;
};
const changed = (): never => { throw new ConflictException({ code: "authority_changed" }); };

export const AGENT_FULFILLMENT_CONFIRMATION_TTL_SECONDS = Symbol("AGENT_FULFILLMENT_CONFIRMATION_TTL_SECONDS");

/** Independent confirmation protocol over the original durable fulfillment intent, without a second business ledger. */
@Injectable()
export class AgentFulfillmentCommandService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(AgentFulfillmentCommandOwner) private readonly owner: AgentFulfillmentCommandOwner,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(AGENT_FULFILLMENT_CONFIRMATION_TTL_SECONDS) private readonly confirmationTtlSeconds = AGENT_FULFILLMENT_CONFIRMATION_SECONDS,
  ) {
    if (!Number.isInteger(confirmationTtlSeconds) || confirmationTtlSeconds < 1 || confirmationTtlSeconds > AGENT_FULFILLMENT_CONFIRMATION_SECONDS)
      throw new Error("Invalid server confirmation lifetime");
  }

  private async current(context: TenantContext, write = false) {
    return withTenant(this.database.db, context, async tx => {
      const membership = await loadCurrentMembershipContext(tx, context, { lock: true });
      const session = TenantContextSchema.parse(intersectPermissionContexts(context, membership));
      authorize(session, Permission.WorkflowRead, { ownerId: context.userId });
      if (write) authorize(session, Permission.WorkflowRun, { ownerId: context.userId });
      return session;
    });
  }

  private consistent(before: TenantContext, after: TenantContext, frames: readonly OrderFulfillmentAgentFrame[] = []) {
    const authority = stamp(after);
    if (stamp(before) !== authority || frames.some(frame => stamp(frame.session) !== authority)) changed();
    return authority;
  }

  private async readCurrentFrame(context: TenantContext, id: string, orderId: string, before: TenantContext) {
    const first = await this.owner.read(context, id, orderId);
    // The first owner transaction may have completed before a caller-visible
    // await resumes. Re-enter the original retained-source gate rather than
    // trusting a private packet held across that boundary.
    const last = first.original ? await this.owner.read(context, id, orderId) : first;
    const after = await this.current(context);
    this.consistent(before, after, [first, last]);
    if (first.native.id !== last.native.id || first.native.orderId !== last.native.orderId || first.native.requestId !== last.native.requestId ||
      first.native.requestChecksum !== last.native.requestChecksum || first.native.kind !== last.native.kind || first.native.targetId !== last.native.targetId)
      throw new ConflictException({ code: "agent_fulfillment_command_original_mismatch" });
    return last;
  }

  async workspace(context: TenantContext) {
    const session = await this.current(context);
    return AgentFulfillmentCommandWorkspaceSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION,
      catalogVersion: AGENT_COMMAND_CATALOG_V2_VERSION, contextAuthority: stamp(session),
      capabilities: agentCommandV2Capabilities(session), modelProposalState: "not_integrated", autonomousWrites: false,
      confirmationTtlSeconds: this.confirmationTtlSeconds });
  }

  async prepare(context: TenantContext, raw: unknown): Promise<AgentFulfillmentCommandView> {
    const input = parse(PrepareAgentFulfillmentCommandSchema, raw), before = await this.current(context, true);
    const native = await this.owner.prepare(context, input);
    const frame = await this.readCurrentFrame(context, native.id, input.orderId, before);
    return this.view(frame);
  }

  async list(context: TenantContext, raw: unknown) {
    const input = parse(AgentFulfillmentCommandListQuerySchema, raw), before = await this.current(context);
    const result = await this.owner.list(context, { orderId: input.orderId, ...(input.lineId ? { lineId: input.lineId } : {}) });
    const items: OrderFulfillmentAgentFrame[] = [];
    for (const frame of result.items) items.push(frame.original ? await this.owner.read(context, frame.native.id, input.orderId) : frame);
    const after = await this.current(context), contextAuthority = this.consistent(before, after, [...result.items, ...items]);
    if (stamp(result.session) !== contextAuthority) changed();
    return AgentFulfillmentCommandListSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION,
      contextAuthority, items: items.map(frame => this.view(frame)), truncated: result.truncated });
  }

  async get(context: TenantContext, rawId: string, rawQuery: unknown): Promise<AgentFulfillmentCommandView> {
    const id = parse(Id, rawId), input = parse(AgentFulfillmentCommandGetQuerySchema, rawQuery), before = await this.current(context);
    const frame = await this.readCurrentFrame(context, id, input.orderId, before);
    return this.view(frame);
  }

  async receipt(context: TenantContext, raw: unknown) {
    const input = parse(AgentFulfillmentCommandReceiptQuerySchema, raw), before = await this.current(context);
    const result = await this.owner.receipt(context, input), after = await this.current(context), contextAuthority = this.consistent(before, after);
    if (stamp(result.session) !== contextAuthority) changed();
    return AgentFulfillmentCommandReceiptSchema.parse({ ...input, contextAuthority, disposition: result.id ? "known" : "not_found",
      id: result.id, privateAvailable: false });
  }

  async confirm(context: TenantContext, rawId: string, raw: unknown): Promise<AgentFulfillmentCommandView> {
    const id = parse(Id, rawId), input = parse(ConfirmAgentFulfillmentCommandSchema, raw);
    let proof: AgentFulfillmentConfirmation;
    try { proof = this.vault.withSecret(input.confirmationToken, value => AgentFulfillmentConfirmationSchema.parse(JSON.parse(value))); }
    catch { throw new ConflictException({ code: "agent_fulfillment_command_confirmation_invalid" }); }
    const before = await this.current(context, true);
    await this.owner.confirm(context, id, input, proof, async (tx, frame) => {
      await this.audit.recordInTransaction(tx, frame.effective, { action: "agent.fulfillment_command.confirm", resourceType: "order_fulfillment_command",
        resourceId: id, result: "success", metadata: { requestId: frame.native.requestId, requestChecksum: frame.native.requestChecksum,
          originalChecksum: input.originalChecksum, decision: input.decision, generation: frame.generation, confirmationChecksum: sha(canonicalJson(proof)) } });
    });
    const frame = await this.readCurrentFrame(context, id, input.orderId, before);
    return this.view(frame);
  }

  async cancel(context: TenantContext, rawId: string, raw: unknown): Promise<AgentFulfillmentCommandView> {
    const id = parse(Id, rawId), input = parse(CancelAgentFulfillmentCommandSchema, raw), before = await this.current(context, true);
    await this.owner.cancel(context, id, input);
    const frame = await this.readCurrentFrame(context, id, input.orderId, before);
    return this.view(frame);
  }

  async acknowledge(context: TenantContext, rawId: string, raw: unknown): Promise<AgentFulfillmentCommandView> {
    const id = parse(Id, rawId), input = parse(AcknowledgeAgentFulfillmentCommandSchema, raw), before = await this.current(context, true);
    await this.owner.acknowledge(context, id, input);
    const frame = await this.readCurrentFrame(context, id, input.orderId, before);
    return this.view(frame);
  }

  private view(frame: OrderFulfillmentAgentFrame): AgentFulfillmentCommandView {
    const native = frame.native, original = frame.original;
    let writable = true;
    try { authorize(frame.effective, Permission.WorkflowRun, { ownerId: frame.session.userId }); }
    catch (error) { if (!(error instanceof ForbiddenError)) throw error; writable = false; }
    if (original && sha(canonicalAgentFulfillmentOriginal(original)) !== native.requestChecksum)
      throw new ConflictException({ code: "agent_fulfillment_command_original_mismatch" });
    const decision = native.status === "prepared" ? "execute_original" : native.status === "uncertain" ? "resume_original" : null;
    const canConfirm = Boolean(writable && original && native.canExecute && decision && Date.parse(native.expiresAt) > frame.checkedAt.getTime());
    const expiresAt = canConfirm ? new Date(Math.min(frame.checkedAt.getTime() + this.confirmationTtlSeconds * 1000, Date.parse(native.expiresAt))) : null;
    const proof = canConfirm ? AgentFulfillmentConfirmationSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, purpose: "agent_fulfillment_confirm",
      intentId: native.id, requestId: native.requestId, requestChecksum: native.requestChecksum, originalChecksum: native.requestChecksum,
      kind: native.kind, targetId: native.targetId, orderId: native.orderId, lineIds: native.lineIds,
      tenantId: frame.session.tenantId, userId: frame.session.userId, ceilingChecksum: sha(canonicalJson(frame.originCeiling)),
      currentAuthority: sha(stamp(frame.session)), generation: frame.generation, expectedStatus: native.status, decision,
      issuedAt: frame.checkedAt.toISOString(), expiresAt: expiresAt!.toISOString() }) : null;
    return AgentFulfillmentCommandViewSchema.parse({ version: AGENT_FULFILLMENT_COMMAND_VERSION, contextAuthority: stamp(frame.session), native,
      original, privateAvailable: original !== null, originalChecksum: original ? native.requestChecksum : null,
      confirmationToken: proof ? this.vault.encrypt(canonicalJson(proof)) : null, confirmationExpiresAt: expiresAt?.toISOString() ?? null,
      confirmationDecision: canConfirm ? decision : null, canConfirm, canCancel: Boolean(writable && original && native.canCancel),
      canAcknowledge: writable && !native.acknowledged && ["succeeded", "rejected", "cancelled", "expired"].includes(native.status) });
  }
}
