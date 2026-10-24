import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { MarketplaceAccountViewSchema } from "@yummyai/contracts/marketplace/store";

/** Separate version: the original account, MCP and native Agent schemas remain unchanged. */
export const MarketplaceAuthorityWorkspaceSchema = z.object({
  version: z.literal("erp-store-authority-v1"),
  account: MarketplaceAccountViewSchema.strict(),
  lifecycle: z.object({ authorizationGeneration: z.uuid(), credentialVersion: z.number().int().positive().nullable(),
    useState: z.enum(["idle", "in_flight", "refresh_unknown"]), refreshState: z.enum(["known", "pending", "unknown"]),
    capabilityGeneration: z.uuid().nullable(), capabilityCurrent: z.boolean(),
    pendingOAuthStateDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable() }).strict(),
  access: z.object({ authorize: z.boolean(), manage: z.boolean(), sync: z.boolean() }).strict(),
  context: z.object({ actorId: EntityIdSchema, tenantId: EntityIdSchema, authority: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  observedAt: z.iso.datetime(),
}).strict();
export type MarketplaceAuthorityWorkspace = z.infer<typeof MarketplaceAuthorityWorkspaceSchema>;
