import type { TenantContext } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import {
  AGENT_FULFILLMENT_COMMAND_VERSION, AgentFulfillmentCommandReceiptSchema, AgentFulfillmentCommandViewSchema,
  PrepareAgentFulfillmentCommandSchema, canonicalAgentFulfillmentOriginal,
} from "@yummyai/contracts/ai/agent-fulfillment-command";
import { bindAgentFulfillmentCompletion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { fulfillmentCommandRequestKey, normalizeFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";
import { orderFulfillmentCommandIntents, type TenantTransaction } from "@yummyai/database";
import { agentCommandV2Capabilities, agentNativeChecksum, type NativeResolvedProposal } from "@yummyai/workflow-core";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AgentFulfillmentCommandService } from "./agent-fulfillment-command.service.js";
import {
  nativeOriginalMismatch, type NativeCommandPreparationPort, type NativeOriginalIdentity,
  type NativeOriginalLink, type NativePreparationBinding,
} from "./agent-native-command-port.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Original preparation and exact read-only recovery, never confirmation or business execution. */
export class AgentNativeV4CommandOwner implements NativeCommandPreparationPort {
  constructor(private readonly legacy: NativeCommandPreparationPort, private readonly fulfillment: AgentFulfillmentCommandService) {}

  capabilities(context: TenantContext) { return agentCommandV2Capabilities(context); }

  bind(proposal: NativeResolvedProposal, completion: unknown): NativePreparationBinding {
    if (proposal.draft.capability.domain !== "fulfillment") return this.legacy.bind(proposal, completion);
    if (proposal.draft.original || !proposal.draft.fulfillment || proposal.draft.fulfillment.original.kind !== proposal.draft.capability.kind ||
      proposal.originalChecksum !== null || proposal.preparationRequestChecksum !== null)
      return nativeOriginalMismatch();
    let completed: ReturnType<typeof bindAgentFulfillmentCompletion>;
    try { completed = bindAgentFulfillmentCompletion(proposal.draft.fulfillment, proposal.id, completion); }
    catch { return nativeOriginalMismatch(); }
    const request = PrepareAgentFulfillmentCommandSchema.parse({ ...completed, original: normalizeFulfillmentCommand(completed.original) });
    const originalChecksum = sha(canonicalAgentFulfillmentOriginal(request.original));
    // The original fulfillment receipt uses its native canonical request hash.
    // The separately encrypted wrapper completion retains its independent SHA.
    return { protocol: AGENT_FULFILLMENT_COMMAND_VERSION, request, originalChecksum,
      preparationRequestChecksum: originalChecksum, completionChecksum: agentNativeChecksum(request) };
  }

  private fulfilled(binding: NativePreparationBinding) {
    if (binding.protocol !== AGENT_FULFILLMENT_COMMAND_VERSION) return nativeOriginalMismatch();
    const request = PrepareAgentFulfillmentCommandSchema.parse(binding.request), checksum = sha(canonicalAgentFulfillmentOriginal(request.original));
    if (binding.originalChecksum !== checksum || binding.preparationRequestChecksum !== checksum ||
      binding.completionChecksum !== agentNativeChecksum(request) || fulfillmentCommandRequestKey(request.original) !== request.original.requestId)
      return nativeOriginalMismatch();
    return request;
  }

  async prepare(context: TenantContext, binding: NativePreparationBinding): Promise<NativeOriginalLink | null> {
    if (binding.protocol === AGENT_COMMAND_VERSION) return this.legacy.prepare(context, binding);
    const request = this.fulfilled(binding), response = AgentFulfillmentCommandViewSchema.parse(await this.fulfillment.prepare(context, request));
    const actual = response.native;
    if (actual.orderId !== request.orderId || actual.requestId !== request.original.requestId || actual.requestChecksum !== binding.preparationRequestChecksum ||
      actual.kind !== request.original.kind || actual.targetId !== request.original.targetId) return nativeOriginalMismatch();
    return { agentCommandId: null, ownerCommandId: null, fulfillmentIntentId: actual.id };
  }

  async receipt(context: TenantContext, identity: NativeOriginalIdentity): Promise<NativeOriginalLink | null> {
    if (identity.originalProtocol !== AGENT_FULFILLMENT_COMMAND_VERSION) return this.legacy.receipt(context, identity);
    if (identity.agentCommandId || identity.originalChecksum !== identity.preparationRequestChecksum) return nativeOriginalMismatch();
    if (!identity.preparationRequestChecksum) return identity.fulfillmentIntentId ? nativeOriginalMismatch() : null;
    if (!identity.originalOrderId) return nativeOriginalMismatch();
    const response = AgentFulfillmentCommandReceiptSchema.parse(await this.fulfillment.receipt(context, {
      version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: identity.originalOrderId, requestId: identity.itemId,
      requestChecksum: identity.preparationRequestChecksum,
    }));
    if (response.orderId !== identity.originalOrderId || response.requestId !== identity.itemId || response.requestChecksum !== identity.preparationRequestChecksum)
      return nativeOriginalMismatch();
    if (response.disposition !== "known" || !response.id) return null;
    if (identity.fulfillmentIntentId && identity.fulfillmentIntentId !== response.id) return nativeOriginalMismatch();
    return { agentCommandId: null, ownerCommandId: null, fulfillmentIntentId: response.id };
  }

  async linked(tx: TenantTransaction, identity: NativeOriginalIdentity): Promise<NativeOriginalLink> {
    if (identity.originalProtocol !== AGENT_FULFILLMENT_COMMAND_VERSION) return this.legacy.linked(tx, identity);
    if (identity.agentCommandId || identity.originalChecksum !== identity.preparationRequestChecksum) return nativeOriginalMismatch();
    if (!identity.fulfillmentIntentId) {
      if (identity.preparationRequestChecksum && !identity.originalOrderId) return nativeOriginalMismatch();
      return { agentCommandId: null, ownerCommandId: null, fulfillmentIntentId: null };
    }
    if (!identity.originalOrderId || !identity.preparationRequestChecksum) return nativeOriginalMismatch();
    // TenantTransaction enforces the original tenant RLS and the link FK keeps
    // the same tenant. No private body or fabricated success is needed here.
    const [actual] = await tx.select().from(orderFulfillmentCommandIntents).where(eq(orderFulfillmentCommandIntents.id, identity.fulfillmentIntentId));
    if (!actual || actual.createdBy !== identity.ownerId || actual.contractVersion !== AGENT_FULFILLMENT_COMMAND_VERSION ||
      actual.orderId !== identity.originalOrderId || actual.requestId !== identity.itemId || actual.requestKey !== identity.itemId ||
      actual.requestChecksum !== identity.preparationRequestChecksum || actual.requestChecksum !== identity.originalChecksum)
      return nativeOriginalMismatch();
    return { agentCommandId: null, ownerCommandId: null, fulfillmentIntentId: actual.id };
  }
}
