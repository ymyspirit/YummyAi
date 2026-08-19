import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import {
  MarketplaceAuthorizationModeSchema,
  MarketplaceListingSyncActionSchema,
  MarketplacePlatformSchema,
  MarketplaceRegionSchema,
  createEntityId,
  type MarketplaceListingSyncAction,
  type MarketplaceListingSyncStatus,
  type TenantContext,
} from "@yummyai/contracts";
import {
  listingVersions,
  listings,
  marketplaceAccounts,
  marketplaceCredentials,
  marketplaceListingSyncEvents,
  marketplaceListingSyncRequests,
  marketplaceQuotaSnapshots,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { MarketplaceListingSyncJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import {
  MarketplaceConnectorError,
  MarketplacePublicationPayloadSchema,
  onlineListingStateForAction,
  type MarketplaceDraftGateway,
  type MarketplaceOnlineListingResult,
  type MarketplacePublicationPayload,
  type PublicationAccountContext,
} from "@yummyai/marketplace-connectors";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { ChannelMutationReconciliationWriter } from "./channel-inventory-reconciliation.repository.js";

export interface ListingSyncExecutionSnapshot {
  requestId: string;
  accountId: string;
  action: MarketplaceListingSyncAction;
  account: PublicationAccountContext;
  payload: MarketplacePublicationPayload;
  externalListingId: string;
  desiredChecksum: string;
}

export interface ListingSyncExecutionRepository {
  claim(context: TenantContext, requestId: string, attempt: number): Promise<ListingSyncExecutionSnapshot | undefined>;
  withCredential<T>(context: TenantContext, accountId: string, callback: (credential: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
  complete(context: TenantContext, snapshot: ListingSyncExecutionSnapshot, result: MarketplaceOnlineListingResult): Promise<MarketplaceListingSyncStatus>;
  fail(context: TenantContext, requestId: string, event: SyncFailureEvent): Promise<void>;
}

export interface SyncFailureEvent {
  status: "retry_pending" | "reconciliation_required" | "failed";
  code: string;
  message: string;
  retryable: boolean;
  revokeAccount?: boolean;
}

export class MarketplaceListingSyncProcessor {
  constructor(private readonly repository: ListingSyncExecutionRepository, private readonly gateway: MarketplaceDraftGateway) {}

  async process(envelope: JobEnvelope): Promise<{ requestId: string; status: string }> {
    const payload = MarketplaceListingSyncJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, permissions: [], dataScope: "tenant" };
    const snapshot = await this.repository.claim(context, payload.syncRequestId, envelope.attempt);
    if (!snapshot) return { requestId: payload.syncRequestId, status: "ignored" };
    try {
      const result = await this.repository.withCredential(context, snapshot.accountId, (credential) => {
        if (snapshot.action === "read" || snapshot.action === "read_full_content") {
          return this.gateway.readOnlineListing(snapshot.account, credential, snapshot.payload, snapshot.externalListingId);
        }
        if (snapshot.action === "push_price_inventory") {
          return this.gateway.updateOnlineListingPriceInventory(snapshot.account, credential, snapshot.payload, snapshot.externalListingId);
        }
        return this.gateway.updateOnlineListingContent(snapshot.account, credential, snapshot.payload, snapshot.externalListingId);
      });
      return { requestId: snapshot.requestId, status: await this.repository.complete(context, snapshot, result) };
    } catch (error) {
      const failure = classifyFailure(error, envelope);
      await this.repository.fail(context, snapshot.requestId, failure);
      if (failure.retryable) throw error;
      return { requestId: snapshot.requestId, status: failure.status };
    }
  }
}

export class DrizzleListingSyncExecutionRepository implements ListingSyncExecutionRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly secrets: SecretVault,
    private readonly channelReconciliations: ChannelMutationReconciliationWriter,
  ) {}

  async claim(context: TenantContext, requestId: string, attempt: number): Promise<ListingSyncExecutionSnapshot | undefined> {
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const [request] = await tx.select().from(marketplaceListingSyncRequests).where(eq(marketplaceListingSyncRequests.id, requestId)).limit(1);
      if (!request) return undefined;
      const [latest] = await tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId)).orderBy(desc(marketplaceListingSyncEvents.sequence)).limit(1);
      if (!latest || terminalStatuses.has(latest.status as MarketplaceListingSyncStatus)) return undefined;
      if (attempt > 0 && isListingMutation(request.action) && latest.status === "processing") {
        const code = "LISTING_SYNC_INTERRUPTED_OUTCOME_UNKNOWN";
        const message = "A previous online Listing mutation did not record a conclusive result; automatic retry is blocked";
        await insertEvent(tx, context, requestId, latest.sequence + 1, { status: "reconciliation_required", code, message, retryable: false });
        await this.channelReconciliations.ensure(tx, context, {
          accountId: request.accountId,
          listingId: request.listingId,
          syncRequestId: request.id,
          platform: MarketplacePlatformSchema.parse(request.platform),
          externalListingId: request.externalListingId,
          reasonCode: code,
          message,
        });
        return undefined;
      }
      const [[account], [listing], [version]] = await Promise.all([
        tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, request.accountId)).limit(1),
        tx.select().from(listings).where(eq(listings.id, request.listingId)).limit(1),
        tx.select().from(listingVersions).where(eq(listingVersions.id, request.listingVersionId)).limit(1),
      ]);
      if (!account || !listing || !version || version.listingId !== listing.id || !account.externalAccountId) {
        await insertEvent(tx, context, requestId, latest.sequence + 1, { status: "failed", code: "LISTING_SYNC_SNAPSHOT_MISSING", message: "Pinned Listing sync snapshot is incomplete", retryable: false });
        return undefined;
      }
      if (account.status !== "active" || account.healthStatus !== "healthy" || listing.status !== "approved" || version.status !== "approved" || listing.primaryVersionId !== version.id || version.validation.blockers.length) {
        await insertEvent(tx, context, requestId, latest.sequence + 1, { status: "failed", code: "LISTING_SYNC_RUNTIME_INVALID", message: "Pinned account or approved Listing version is no longer eligible", retryable: false });
        return undefined;
      }
      const stored = request.desiredState as Record<string, unknown>;
      const parsedPayload = MarketplacePublicationPayloadSchema.safeParse(stored.payload);
      const desired = onlineListingStateForAction(MarketplaceListingSyncActionSchema.parse(request.action), {
        content: stored.content ?? null,
        price: stored.price ?? null,
        inventory: stored.inventory ?? null,
      });
      if (!parsedPayload.success || checksum(desired) !== request.desiredChecksum) {
        await insertEvent(tx, context, requestId, latest.sequence + 1, { status: "failed", code: "LISTING_SYNC_PAYLOAD_MISMATCH", message: "Pinned Listing sync payload is invalid", retryable: false });
        return undefined;
      }
      await insertEvent(tx, context, requestId, latest.sequence + 1, { status: "processing", code: null, message: null, retryable: false });
      return {
        requestId,
        accountId: account.id,
        action: MarketplaceListingSyncActionSchema.parse(request.action),
        account: { authorizationMode: MarketplaceAuthorizationModeSchema.parse(account.authorizationMode), externalAccountId: account.externalAccountId, platform: MarketplacePlatformSchema.parse(account.platform), region: MarketplaceRegionSchema.parse(account.region) },
        payload: parsedPayload.data,
        externalListingId: request.externalListingId,
        desiredChecksum: request.desiredChecksum,
      };
    });
  }

  async withCredential<T>(context: TenantContext, accountId: string, callback: (credential: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
    const [credential] = await withTenant(this.database.db, context, (tx) => tx.select({ encryptedEnvelope: marketplaceCredentials.encryptedEnvelope, accountStatus: marketplaceAccounts.status, platform: marketplaceAccounts.platform }).from(marketplaceCredentials).innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, marketplaceCredentials.accountId)).where(eq(marketplaceCredentials.accountId, accountId)).limit(1));
    if (!credential || credential.accountStatus !== "active") throw new MarketplaceConnectorError(credential?.platform === "etsy" ? "etsy" : "amazon", "authorization", "Marketplace credential is unavailable");
    return this.secrets.withSecret(credential.encryptedEnvelope, (raw) => callback(z.record(z.string(), z.string()).parse(JSON.parse(raw))));
  }

  async complete(context: TenantContext, snapshot: ListingSyncExecutionSnapshot, result: MarketplaceOnlineListingResult): Promise<MarketplaceListingSyncStatus> {
    const snapshotChecksum = checksum(onlineListingStateForAction(snapshot.action, result.snapshot));
    const status: MarketplaceListingSyncStatus = snapshotChecksum === snapshot.desiredChecksum ? "completed" : "drift_detected";
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.requestId}, 0))`);
      const [latest] = await tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, snapshot.requestId)).orderBy(desc(marketplaceListingSyncEvents.sequence)).limit(1);
      if (!latest || terminalStatuses.has(latest.status as MarketplaceListingSyncStatus)) return;
      if (result.refreshedCredential) {
        const [stored] = await tx.select({ id: marketplaceCredentials.id, version: marketplaceCredentials.version }).from(marketplaceCredentials).where(eq(marketplaceCredentials.accountId, snapshot.accountId)).limit(1);
        if (!stored) throw new MarketplaceConnectorError(snapshot.account.platform, "authorization", "Marketplace credential is unavailable");
        await tx.update(marketplaceCredentials).set({ encryptedEnvelope: this.secrets.encrypt(JSON.stringify(result.refreshedCredential)), version: stored.version + 1, expiresAt: result.refreshedCredentialExpiresAt ?? null, rotatedAt: new Date(), updatedAt: new Date() }).where(eq(marketplaceCredentials.id, stored.id));
      }
      if (result.quota) {
        await tx.insert(marketplaceQuotaSnapshots).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          accountId: snapshot.accountId,
          platform: snapshot.account.platform,
          operation: snapshot.action,
          publicationRequestId: null,
          listingSyncRequestId: snapshot.requestId,
          windows: [...result.quota.windows],
          observedAt: new Date(result.quota.observedAt),
        });
      }
      await insertEvent(tx, context, snapshot.requestId, latest.sequence + 1, { status, code: null, message: status === "drift_detected" ? "Online Listing state differs from the approved Listing version" : null, retryable: false, issues: [...result.issues], snapshot: result.snapshot, snapshotChecksum });
    });
    return status;
  }

  async fail(context: TenantContext, requestId: string, event: SyncFailureEvent) {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const [request] = await tx.select().from(marketplaceListingSyncRequests).where(eq(marketplaceListingSyncRequests.id, requestId)).limit(1);
      const [latest] = await tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId)).orderBy(desc(marketplaceListingSyncEvents.sequence)).limit(1);
      if (!request || !latest || terminalStatuses.has(latest.status as MarketplaceListingSyncStatus)) return;
      await insertEvent(tx, context, requestId, latest.sequence + 1, event);
      if (event.status === "reconciliation_required" && isListingMutation(request.action)) {
        await this.channelReconciliations.ensure(tx, context, {
          accountId: request.accountId,
          listingId: request.listingId,
          syncRequestId: request.id,
          platform: MarketplacePlatformSchema.parse(request.platform),
          externalListingId: request.externalListingId,
          reasonCode: event.code,
          message: event.message,
        });
      }
      if (event.revokeAccount) await tx.update(marketplaceAccounts).set({ status: "revoked", credentialStatus: "revoked", healthStatus: "unauthorized", lastHealthAt: new Date(), lastErrorCode: event.code, updatedAt: new Date() }).where(eq(marketplaceAccounts.id, request.accountId));
    });
  }
}

const terminalStatuses = new Set<MarketplaceListingSyncStatus>(["completed", "drift_detected", "reconciliation_required", "failed"]);

function classifyFailure(error: unknown, envelope: JobEnvelope): SyncFailureEvent {
  if (!(error instanceof MarketplaceConnectorError)) return { status: "failed", code: "LISTING_SYNC_UNEXPECTED", message: "Listing sync failed before a marketplace result was recorded", retryable: false };
  if (error.outcomeUncertain) return { status: "reconciliation_required", code: `LISTING_SYNC_${error.code.toUpperCase()}`, message: error.message, retryable: false };
  if (error.code === "authorization") return { status: "failed", code: "LISTING_SYNC_AUTHORIZATION", message: error.message, retryable: false, revokeAccount: true };
  const retryable = error.retryable && envelope.attempt + 1 < envelope.maxAttempts;
  return { status: retryable ? "retry_pending" : "failed", code: `LISTING_SYNC_${error.code.toUpperCase()}`, message: error.message, retryable };
}

function isListingMutation(action: string): boolean {
  return action === "push_price_inventory" || action === "push_full_content";
}

async function insertEvent(tx: TenantTransaction, context: TenantContext, requestId: string, sequence: number, event: { status: MarketplaceListingSyncStatus; code: string | null; message: string | null; retryable: boolean; issues?: MarketplaceOnlineListingResult["issues"]; snapshot?: MarketplaceOnlineListingResult["snapshot"]; snapshotChecksum?: string }) {
  await tx.insert(marketplaceListingSyncEvents).values({ id: createEntityId(), tenantId: context.tenantId, requestId, sequence, status: event.status, code: event.code, message: event.message, retryable: event.retryable, issues: event.issues ? [...event.issues] : [], snapshot: event.snapshot, snapshotChecksum: event.snapshotChecksum, actorUserId: context.userId });
}

function checksum(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
