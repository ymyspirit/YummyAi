import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { marketplaceAccounts, marketplaceAuthorizationSessions, marketplaceCredentials, recordAuditInTransaction,
  type TenantTransaction } from "@yummyai/database";
import { MarketplaceConnectorError } from "@yummyai/marketplace-connectors";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { requireWorkerMarketplaceCredential, type CredentialBoundary } from "./marketplace-credential-boundary.js";

const FenceSchema = z.object({ authorizationGeneration: z.uuid(), credentialId: z.uuidv7(),
  credentialVersion: z.number().int().positive().safe() }).strict();

export type MarketplaceCredentialFailureFence = z.infer<typeof FenceSchema>;
export type WorkerMarketplaceCredentialSnapshot = CredentialBoundary & MarketplaceCredentialFailureFence & { encryptedEnvelope: string };

class FencedMarketplaceConnectorError extends MarketplaceConnectorError {
  readonly credentialFence: Readonly<MarketplaceCredentialFailureFence>;
  constructor(error: MarketplaceConnectorError, fence: MarketplaceCredentialFailureFence) {
    super(error.platform, error.code, error.message, error.retryAfterMs, error.outcomeUncertain);
    this.credentialFence = Object.freeze({ ...fence });
  }
}

/** The fence and ciphertext come from the same original SELECT, before any provider I/O. */
export async function withWorkerMarketplaceCredential<T>(snapshot: WorkerMarketplaceCredentialSnapshot | undefined,
  secrets: SecretVault, callback: (credential: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
  requireWorkerMarketplaceCredential(snapshot);
  const fence = FenceSchema.parse({ authorizationGeneration: snapshot.authorizationGeneration,
    credentialId: snapshot.credentialId, credentialVersion: snapshot.credentialVersion });
  return secrets.withSecret(snapshot.encryptedEnvelope, async (raw) => {
    const credential = z.record(z.string(), z.string()).parse(JSON.parse(raw));
    try { return await callback(credential); }
    catch (error) {
      // Local refusals and decode failures never become evidence of a rejected credential.
      if (error instanceof MarketplaceConnectorError && error.code === "authorization")
        throw new FencedMarketplaceConnectorError(error, fence);
      throw error;
    }
  });
}

export function readMarketplaceCredentialFailureFence(error: unknown): MarketplaceCredentialFailureFence | undefined {
  return error instanceof FencedMarketplaceConnectorError ? { ...error.credentialFence } : undefined;
}

/** Only the exact credential actually rejected upstream can revoke its current account generation. */
export async function revokeMarketplaceCredentialIfCurrent(tx: TenantTransaction, context: TenantContext, accountId: string,
  rawFence: MarketplaceCredentialFailureFence | undefined, errorCode: string): Promise<boolean> {
  const parsed = FenceSchema.safeParse(rawFence);
  if (!parsed.success) return false;
  const fence = parsed.data;
  const [account] = await tx.select().from(marketplaceAccounts).where(and(eq(marketplaceAccounts.id, accountId),
    eq(marketplaceAccounts.tenantId, context.tenantId))).for("update").limit(1);
  if (!account || account.authorizationGeneration !== fence.authorizationGeneration || account.status !== "active"
    || account.credentialRefreshState !== "known" || account.credentialUseId !== null || account.deletedAt !== null) return false;
  const [credential] = await tx.select({ id: marketplaceCredentials.id, version: marketplaceCredentials.version })
    .from(marketplaceCredentials).where(and(eq(marketplaceCredentials.accountId, accountId),
      eq(marketplaceCredentials.tenantId, context.tenantId))).for("update").limit(1);
  if (!credential || credential.id !== fence.credentialId || credential.version !== fence.credentialVersion) return false;
  const [clock] = await tx.execute<{ now: string | Date }>(sql`select clock_timestamp() as now`);
  const now = new Date(clock!.now);
  const generation = createEntityId();
  const updated = await tx.update(marketplaceAccounts).set({ authorizationGeneration: generation,
    status: "revoked", credentialStatus: "revoked", healthStatus: "unauthorized", grantedScopes: [], capabilities: [],
    capabilityExpiresAt: null, credentialUseId: null, credentialUseStartedAt: null, credentialRefreshState: "known",
    lastHealthAt: now, lastErrorCode: errorCode, updatedAt: now }).where(and(eq(marketplaceAccounts.id, accountId),
      eq(marketplaceAccounts.authorizationGeneration, fence.authorizationGeneration), eq(marketplaceAccounts.status, "active"),
      eq(marketplaceAccounts.credentialRefreshState, "known"), isNull(marketplaceAccounts.credentialUseId), isNull(marketplaceAccounts.deletedAt)))
    .returning({ id: marketplaceAccounts.id });
  if (updated.length !== 1) return false;
  await tx.update(marketplaceAuthorizationSessions).set({ consumedAt: now, failureCode: "provider_rejected" })
    .where(and(eq(marketplaceAuthorizationSessions.accountId, accountId), isNull(marketplaceAuthorizationSessions.consumedAt)));
  await recordAuditInTransaction(tx, context, { action: "marketplace_authorization.provider_revoke", resourceType: "marketplace_account",
    resourceId: accountId, result: "success", metadata: { errorCode, previousGeneration: fence.authorizationGeneration,
      generation, rejectedVersion: fence.credentialVersion } });
  return true;
}
