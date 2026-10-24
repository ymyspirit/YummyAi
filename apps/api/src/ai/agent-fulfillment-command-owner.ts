import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { erpPermissionContext } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  canonicalAgentFulfillmentOriginal,
  type AgentFulfillmentConfirmation, type ConfirmAgentFulfillmentCommand, type PrepareAgentFulfillmentCommand,
} from "@yummyai/contracts/ai/agent-fulfillment-command";
import type { TenantTransaction } from "@yummyai/database";
import { sql } from "drizzle-orm";
import {
  OrderFulfillmentCommandService, type OrderFulfillmentAgentFrame,
} from "../orders/order-fulfillment-command.service.js";

type Control = { orderId: string; requestId: string; requestChecksum: string };
type ClaimHook = (tx: TenantTransaction, frame: OrderFulfillmentAgentFrame) => Promise<void>;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const mismatch = (): never => { throw new ConflictException({ code: "agent_fulfillment_command_confirmation_mismatch" }); };

/** Protocol adapter only. All identities, original input and business receipts belong to the original owner. */
@Injectable()
export class AgentFulfillmentCommandOwner {
  constructor(@Inject(OrderFulfillmentCommandService) private readonly original: OrderFulfillmentCommandService) {}

  prepare(context: TenantContext, input: PrepareAgentFulfillmentCommand) {
    return this.original.prepare(context, input.original, { orderId: input.orderId });
  }

  read(context: TenantContext, id: string, orderId: string) {
    return this.original.readForAgent(context, id, orderId);
  }

  list(context: TenantContext, input: { orderId: string; lineId?: string }) {
    return this.original.listForAgent(context, input);
  }

  receipt(context: TenantContext, input: Control) {
    return this.original.receiptForAgent(context, input);
  }

  confirm(context: TenantContext, id: string, input: ConfirmAgentFulfillmentCommand,
    proof: AgentFulfillmentConfirmation, onClaim?: ClaimHook) {
    return this.original.execute(context, id, { orderId: input.orderId, requestId: input.requestId, requestChecksum: input.requestChecksum,
      beforeClaim: async (tx, frame) => {
        const native = frame.native, now = frame.checkedAt.getTime();
        const decision = native.status === "prepared" ? "execute_original" : native.status === "uncertain" ? "resume_original" : null;
        if (!frame.original || !native.canExecute || !decision || input.decision !== decision || proof.decision !== decision ||
          proof.intentId !== id || native.id !== id || proof.tenantId !== context.tenantId || proof.userId !== context.userId ||
          proof.orderId !== input.orderId || native.orderId !== input.orderId || proof.requestId !== input.requestId || native.requestId !== input.requestId ||
          proof.requestChecksum !== input.requestChecksum || native.requestChecksum !== input.requestChecksum ||
          proof.originalChecksum !== input.originalChecksum || native.requestChecksum !== input.originalChecksum ||
          sha(canonicalAgentFulfillmentOriginal(frame.original)) !== input.originalChecksum || proof.kind !== native.kind || proof.targetId !== native.targetId ||
          proof.lineIds.length !== native.lineIds.length || !proof.lineIds.every((value, index) => value === native.lineIds[index]) ||
          proof.ceilingChecksum !== sha(canonicalJson(frame.originCeiling)) || proof.currentAuthority !== sha(erpSessionAuthority(erpPermissionContext(frame.session))) ||
          proof.generation !== frame.generation || proof.expectedStatus !== native.status) mismatch();
        if (Date.parse(proof.issuedAt) > now || Date.parse(proof.expiresAt) <= now || Date.parse(proof.expiresAt) > Date.parse(native.expiresAt))
          throw new ConflictException({ code: "agent_fulfillment_command_confirmation_expired" });
        await onClaim?.(tx, frame);
        const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
        if (!clock || Date.parse(proof.expiresAt) <= new Date(clock.now).getTime())
          throw new ConflictException({ code: "agent_fulfillment_command_confirmation_expired" });
      } });
  }

  cancel(context: TenantContext, id: string, input: Control) {
    return this.original.cancel(context, id, input);
  }

  acknowledge(context: TenantContext, id: string, input: Control) {
    return this.original.acknowledge(context, id, input);
  }
}
