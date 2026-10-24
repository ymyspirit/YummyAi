import { createHash } from "node:crypto";
import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { MarketplaceOAuthStateSchema } from "./marketplace-lifecycle";
export { marketplaceOAuthAuthorizationUrl } from "./marketplace-lifecycle";

/** Retained only to remove the old single-flow cookie when starting a new flow. */
export const MARKETPLACE_OAUTH_ACCOUNT_COOKIE = "yummyai-marketplace-oauth-account";
export const MARKETPLACE_OAUTH_COOKIE_PREFIX = "yummyai-marketplace-oauth-v1-";
const State = MarketplaceOAuthStateSchema;
export const MarketplaceOAuthBindingSchema = z.object({
  version: z.literal(1), accountId: EntityIdSchema, actorId: EntityIdSchema, tenantId: EntityIdSchema,
  platform: z.enum(["amazon", "etsy"]), stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authority: z.string().regex(/^[a-f0-9]{64}$/), authorizationGeneration: z.uuid(), expiresAt: z.iso.datetime(),
}).strict();
export type MarketplaceOAuthBinding = z.infer<typeof MarketplaceOAuthBindingSchema>;
export const marketplaceOAuthStateDigest = (state: string) => createHash("sha256").update(State.parse(state)).digest("hex");
export const marketplaceOAuthPendingStateDigest = (state: string) => createHash("sha256").update(State.parse(state)).digest("base64url");
export const marketplaceOAuthCookieName = (state: string) => MARKETPLACE_OAUTH_COOKIE_PREFIX + marketplaceOAuthStateDigest(state);
export function readMarketplaceOAuthBinding(value: string | undefined): MarketplaceOAuthBinding | null {
  if (!value || value.length > 4096) return null;
  try { return MarketplaceOAuthBindingSchema.parse(JSON.parse(value)); } catch { return null; }
}
export function parseMarketplaceOAuthCallback(url: URL) {
  if (url.search.length > 32768 || url.hash) throw new Error("marketplace_oauth_invalid");
  const allowed = new Set(["state", "code", "spapi_oauth_code", "selling_partner_id", "error", "error_description"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error("marketplace_oauth_invalid");
  const state = State.parse(url.searchParams.get("state")), error = url.searchParams.has("error");
  const codes = [url.searchParams.get("code"), url.searchParams.get("spapi_oauth_code")].filter(value => value !== null);
  if (error ? codes.length !== 0 : codes.length !== 1) throw new Error("marketplace_oauth_invalid");
  const code = error ? null : z.string().min(1).max(16384).parse(codes[0]);
  const sellingPartnerId = url.searchParams.has("selling_partner_id") ? z.string().trim().min(1).max(160).parse(url.searchParams.get("selling_partner_id")) : undefined;
  return { state, code, sellingPartnerId, error };
}
