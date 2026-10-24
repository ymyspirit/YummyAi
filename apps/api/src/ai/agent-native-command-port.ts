import { ConflictException } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import { AGENT_COMMAND_VERSION, PrepareAgentCommandSchema, canonicalAgentCommandOriginal, canonicalAgentCommandRequest,
  type PrepareAgentCommand } from "@yummyai/contracts/ai/agent-command";
import type { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommand } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { agentCommandRequests, type TenantTransaction } from "@yummyai/database";
import { agentNativeChecksum, type NativeResolvedProposal } from "@yummyai/workflow-core";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AgentCommandService } from "./agent-command.service.js";
import type { AgentCommandOwnerAdapter } from "./agent-command-owner.js";

export type NativeOriginalProtocol = typeof AGENT_COMMAND_VERSION | typeof AGENT_FULFILLMENT_COMMAND_VERSION;
type BindingHashes = { originalChecksum: string; preparationRequestChecksum: string };
export type NativePreparationBinding = BindingHashes & (
  { protocol: typeof AGENT_COMMAND_VERSION; request: PrepareAgentCommand; completionChecksum: null } |
  { protocol: typeof AGENT_FULFILLMENT_COMMAND_VERSION; request: PrepareAgentFulfillmentCommand; completionChecksum: string }
);
export type NativeOriginalLink = { agentCommandId: string | null; ownerCommandId: string | null; fulfillmentIntentId: string | null };
export type NativeOriginalIdentity = {
  itemId: string; ownerId: string; originalProtocol: NativeOriginalProtocol | null; originalOrderId: string | null;
  originalChecksum: string | null; preparationRequestChecksum: string | null;
  agentCommandId: string | null; fulfillmentIntentId: string | null;
};
/** API-only preparation adapter. No confirmation or business-execution methods. */
export interface NativeCommandPreparationPort {
  capabilities(context: TenantContext): readonly { domain: string; kind: string; available: boolean }[];
  bind(proposal: NativeResolvedProposal, completion: unknown): NativePreparationBinding;
  prepare(context: TenantContext, binding: NativePreparationBinding): Promise<NativeOriginalLink | null>;
  receipt(context: TenantContext, identity: NativeOriginalIdentity): Promise<NativeOriginalLink | null>;
  linked(tx: TenantTransaction, identity: NativeOriginalIdentity): Promise<NativeOriginalLink>;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const nativeOriginalMismatch = (): never => { throw new ConflictException({ code: "agent_plan_item_original_mismatch" }); };

/** Historical families retain their exact original request and receipt semantics. */
export class LegacyNativeCommandPreparationPort implements NativeCommandPreparationPort {
  constructor(protected readonly commands: AgentCommandService, protected readonly owner: AgentCommandOwnerAdapter) {}
  capabilities(context: TenantContext) { return this.owner.capabilities(context); }
  bind(proposal: NativeResolvedProposal, completion: unknown): NativePreparationBinding {
    if (completion !== undefined && completion !== null || !proposal.draft.original || proposal.draft.fulfillment) return nativeOriginalMismatch();
    const request = PrepareAgentCommandSchema.parse({ version: AGENT_COMMAND_VERSION, requestId: proposal.id, original: proposal.draft.original });
    const originalChecksum = sha(canonicalAgentCommandOriginal(request.original));
    const preparationRequestChecksum = sha(canonicalAgentCommandRequest("prepare", request));
    if (originalChecksum !== proposal.originalChecksum || preparationRequestChecksum !== proposal.preparationRequestChecksum) return nativeOriginalMismatch();
    return { protocol: AGENT_COMMAND_VERSION, request, originalChecksum, preparationRequestChecksum, completionChecksum: null };
  }
  async prepare(context: TenantContext, binding: NativePreparationBinding): Promise<NativeOriginalLink | null> {
    if (binding.protocol !== AGENT_COMMAND_VERSION) return nativeOriginalMismatch();
    // Re-parse a sealed value at the original boundary, never accept an arbitrary command path.
    if (sha(canonicalAgentCommandRequest("prepare", binding.request)) !== binding.preparationRequestChecksum) return nativeOriginalMismatch();
    const actual = await this.commands.prepare(context, binding.request);
    return actual.ownerCommandId ? { agentCommandId: actual.id, ownerCommandId: actual.ownerCommandId, fulfillmentIntentId: null } : null;
  }
  async receipt(context: TenantContext, identity: NativeOriginalIdentity): Promise<NativeOriginalLink | null> {
    if (identity.originalProtocol !== null && identity.originalProtocol !== AGENT_COMMAND_VERSION || identity.fulfillmentIntentId) return nativeOriginalMismatch();
    if (!identity.preparationRequestChecksum) return null;
    const receipt = await this.commands.receipt(context, { requestId: identity.itemId, requestChecksum: identity.preparationRequestChecksum });
    return receipt.disposition === "known" && receipt.id && receipt.ownerCommandId
      ? { agentCommandId: receipt.id, ownerCommandId: receipt.ownerCommandId, fulfillmentIntentId: null } : null;
  }
  async linked(tx: TenantTransaction, identity: NativeOriginalIdentity): Promise<NativeOriginalLink> {
    if (identity.fulfillmentIntentId || identity.originalProtocol !== null && identity.originalProtocol !== AGENT_COMMAND_VERSION) return nativeOriginalMismatch();
    if (!identity.agentCommandId) return { agentCommandId: null, ownerCommandId: null, fulfillmentIntentId: null };
    const [command] = await tx.select().from(agentCommandRequests).where(eq(agentCommandRequests.id, identity.agentCommandId));
    if (!command || !command.ownerCommandId || command.ownerId !== identity.ownerId || command.requestId !== identity.itemId ||
      command.requestChecksum !== identity.preparationRequestChecksum || command.originalChecksum !== identity.originalChecksum) return nativeOriginalMismatch();
    return { agentCommandId: command.id, ownerCommandId: command.ownerCommandId, fulfillmentIntentId: null };
  }
}

export function nativeBindingChecksum(binding: NativePreparationBinding): string {
  return agentNativeChecksum(binding.request);
}
