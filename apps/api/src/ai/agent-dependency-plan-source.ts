import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, erpPermissionContext, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { type AgentCommandView } from "@yummyai/contracts/ai/agent-command";
import {
  AgentDependencyPlanBillDraftSchema, AgentDependencyPlanCommandSchema, AgentDependencyPlanSourceSchema,
  agentDependencyPlanSourcePayload, type AgentDependencyPlanBillDraft, type AgentDependencyPlanBlockReason,
  type AgentDependencyPlanCommand, type AgentDependencyPlanSource as InvoiceSource,
} from "@yummyai/contracts/ai/agent-dependency-plan";
import { agentCommandRequests, loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { AgentCommandService } from "./agent-command.service.js";

type ParentRow = typeof agentCommandRequests.$inferSelect;
type SourceFrame = { row: ParentRow; current: TenantContext; effective: TenantContext };
export type AgentDependencyPlanSourceRead = {
  parent: AgentDependencyPlanCommand;
  source: InvoiceSource | null;
  blockReason: AgentDependencyPlanBlockReason | null;
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const stamp = (context: TenantContext) => erpSessionAuthority(erpPermissionContext(context));
function conflict(code: string): never { throw new ConflictException({ code }); }

/** Reads only original coordination identities and the procurement owner's actual invoice result. */
@Injectable()
export class AgentDependencyPlanSource {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AgentCommandService) private readonly commands: AgentCommandService,
    @Inject(ProcurementService) private readonly procurement: ProcurementService) {}

  private async frame(context: TenantContext, id: string): Promise<SourceFrame> {
    return withTenant(this.database.db, context, async tx => {
      const current = TenantContextSchema.parse(intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true })));
      authorize(current, Permission.WorkflowRead, { ownerId: current.userId });
      const [row] = await tx.select().from(agentCommandRequests).where(and(eq(agentCommandRequests.id, id), eq(agentCommandRequests.ownerId, current.userId)));
      if (!row) throw new NotFoundException({ code: "agent_dependency_plan_parent_not_found" });
      if (row.binding.domain !== "procurement" || row.binding.kind !== "invoice_record" || row.binding.targetId === null || row.binding.accountId !== null)
        conflict("agent_dependency_plan_parent_invalid");
      const effective = TenantContextSchema.parse(intersectPermissionContexts(row.originCeiling, current));
      authorize(effective, Permission.WorkflowRead, { ownerId: effective.userId });
      return { row, current, effective };
    });
  }

  async read(context: TenantContext, rawId: string): Promise<AgentDependencyPlanSourceRead> {
    const parsed = z.uuidv7().safeParse(rawId);
    if (!parsed.success) throw new BadRequestException({ code: "agent_dependency_plan_input_invalid" });
    const before = await this.frame(context, parsed.data.toLowerCase());
    let view: AgentCommandView;
    try { view = await this.commands.get(before.effective, before.row.id); }
    catch (error) {
      if (!unavailable(error)) throw error;
      const after = await this.frame(context, before.row.id); this.sameFrame(before, after);
      return { parent: missingParent(after.row), source: null, blockReason: "parent_unavailable" };
    }
    const after = await this.frame(context, before.row.id); this.sameFrame(before, after);
    const parent = this.parent(after.row, view);
    if (parent.state !== "succeeded") return { parent, source: null,
      blockReason: ["cancelled", "expired", "rejected"].includes(parent.state) ? "parent_terminal" : parent.state === "unavailable" ? "parent_unavailable" : "parent_not_succeeded" };
    if (!view.snapshot || view.snapshot.native.domain !== "procurement" || view.snapshot.native.view.status !== "succeeded")
      return { parent, source: null, blockReason: "parent_unavailable" };
    const invoice = view.snapshot.native.view.invoiceResult;
    if (!invoice || !parent.ownerCommandId || parent.resultId !== invoice.id || invoice.purchaseOrderId !== after.row.binding.targetId)
      conflict("agent_dependency_plan_source_invalid");
    let handoff: Awaited<ReturnType<ProcurementService["readInvoiceHandoff"]>>;
    try { handoff = await this.procurement.readInvoiceHandoff(after.effective, invoice!.id); }
    catch (error) {
      if (!unavailable(error)) throw error;
      const final = await this.frame(context, before.row.id); this.sameFrame(before, final);
      return { parent, source: null, blockReason: error instanceof ForbiddenError || error instanceof ForbiddenException ? "permission_denied" : "source_unavailable" };
    }
    if (handoff.contextAuthority !== stamp(after.effective) || invoiceFields(handoff.invoice) !== invoiceFields(invoice!))
      conflict("agent_dependency_plan_source_changed");
    // A second original-owner read also fences same-membership object ownership changes.
    const finalView = await this.commands.get(after.effective, before.row.id);
    const final = await this.frame(context, before.row.id); this.sameFrame(before, final);
    const finalParent = this.parent(final.row, finalView);
    if (!finalView.snapshot || finalView.snapshot.native.domain !== "procurement" || finalParent.state !== "succeeded")
      return { parent: finalParent, source: null, blockReason: "parent_unavailable" };
    const finalInvoice = finalView.snapshot.native.view.invoiceResult;
    if (!finalInvoice || invoiceFields(finalInvoice) !== invoiceFields(invoice!) || finalParent.resultId !== invoice!.id)
      conflict("agent_dependency_plan_source_changed");
    const provisional = AgentDependencyPlanSourceSchema.parse({ invoiceId: handoff.invoice.id, purchaseOrderId: handoff.invoice.purchaseOrderId,
      purchaseOrderVersionId: handoff.purchaseOrderVersionId, procurementProofId: handoff.proofId, supplierId: handoff.supplierId,
      invoiceNumber: handoff.invoice.invoiceNumber, currency: handoff.invoice.currency, totalMinor: handoff.invoice.totalMinor,
      issuedAt: handoff.invoice.issuedAt, sourceChecksum: "0".repeat(64) });
    return { parent: finalParent, source: { ...provisional, sourceChecksum: sha(canonicalJson(agentDependencyPlanSourcePayload(provisional))) }, blockReason: null };
  }

  derive(source: InvoiceSource, fixed: { dueAt: string | null; nativeKey: string }): AgentDependencyPlanBillDraft {
    const input = AgentDependencyPlanSourceSchema.parse(source);
    if (input.sourceChecksum !== sha(canonicalJson(agentDependencyPlanSourcePayload(input)))) conflict("agent_dependency_plan_source_invalid");
    const parsed = AgentDependencyPlanBillDraftSchema.safeParse({ domain: "finance", command: { kind: "bill_record", targetId: null,
      input: { kind: "procurement_invoice", procurementInvoiceId: input.invoiceId, supplierId: input.supplierId,
        externalBillId: input.invoiceNumber, currency: input.currency, amountMinor: input.totalMinor, issuedAt: input.issuedAt,
        dueAt: fixed.dueAt, idempotencyKey: fixed.nativeKey } } });
    if (!parsed.success) conflict("agent_dependency_plan_finance_input_invalid");
    return parsed.data!;
  }

  private sameFrame(before: SourceFrame, after: SourceFrame) {
    if (stamp(before.current) !== stamp(after.current) || stamp(before.effective) !== stamp(after.effective)
      || before.row.requestChecksum !== after.row.requestChecksum || before.row.originalChecksum !== after.row.originalChecksum)
      conflict("authority_changed");
  }
  private parent(row: ParentRow, view: AgentCommandView): AgentDependencyPlanCommand {
    if (view.id !== row.id || view.requestId !== row.requestId || view.requestChecksum !== row.requestChecksum || view.ownerCommandId !== row.ownerCommandId
      || view.domain !== "procurement" || view.kind !== "invoice_record") conflict("agent_dependency_plan_parent_invalid");
    return dependencyCommandFromView(view, "procurement", "invoice_record");
  }
}

export function dependencyCommandFromView(view: AgentCommandView, domain: "procurement" | "finance", kind: "invoice_record" | "bill_record"): AgentDependencyPlanCommand {
  if (view.domain !== domain || view.kind !== kind) conflict("agent_dependency_plan_command_mismatch");
  const native = view.snapshot?.native;
  if (native && (native.domain !== domain || native.view.kind !== kind || native.view.id !== view.ownerCommandId)) conflict("agent_dependency_plan_command_mismatch");
  const resultId = view.state === "succeeded" && native && (native.domain === "procurement" || native.domain === "finance") && native.view.status === "succeeded"
    ? native.view.result?.id ?? null : null;
  return AgentDependencyPlanCommandSchema.parse({ agentCommandId: view.id, requestId: view.requestId, requestChecksum: view.requestChecksum,
    ownerCommandId: view.ownerCommandId, domain, kind, state: view.state, resultId });
}
function missingParent(row: ParentRow): AgentDependencyPlanCommand {
  return AgentDependencyPlanCommandSchema.parse({ agentCommandId: row.id, requestId: row.requestId, requestChecksum: row.requestChecksum,
    ownerCommandId: row.ownerCommandId, domain: "procurement", kind: "invoice_record", state: "unavailable", resultId: null });
}
function invoiceFields(invoice: { id: string; purchaseOrderId: string; invoiceNumber: string; currency: string; totalMinor: number; issuedAt: string }) {
  return canonicalJson({ id: invoice.id, purchaseOrderId: invoice.purchaseOrderId, invoiceNumber: invoice.invoiceNumber, currency: invoice.currency,
    totalMinor: invoice.totalMinor, issuedAt: invoice.issuedAt });
}
function unavailable(error: unknown): boolean {
  if (error instanceof HttpException) {
    const body: unknown = error.getResponse();
    if (typeof body === "object" && body !== null && "code" in body && body.code === "authority_changed") return false;
  }
  return error instanceof ForbiddenError || error instanceof HttpException && [403, 404, 409, 410].includes(error.getStatus());
}
