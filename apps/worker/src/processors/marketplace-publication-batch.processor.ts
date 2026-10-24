import { readMarketplaceCredentialFailureFence, revokeMarketplaceCredentialIfCurrent, withWorkerMarketplaceCredential,
  type MarketplaceCredentialFailureFence } from "./marketplace-credential-failure.js";
import type { SecretVault } from "@yummyai/ai-core";
import { createHash } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { PublicationAuthorityError, readPublicationAuthority } from "@yummyai/catalog-core";
import {
  MarketplaceAuthorizationModeSchema,
  MarketplacePlatformSchema,
  MarketplaceRegionSchema,
  createEntityId,
  type MarketplacePublicationIssue,
  type MarketplacePublicationStatus,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  marketplaceAccounts,
  marketplaceCapabilitySnapshots,
  marketplaceCredentials,
  marketplacePublicationBatches,
  marketplacePublicationEvents,
  marketplacePublicationIntents,
  marketplacePublicationRequests,
  marketplaceQuotaSnapshots,
  type DatabaseConnection,
  type MarketplacePublicationAssetPin,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { MarketplacePublicationBatchJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import {
  MarketplaceConnectorError,
  MarketplacePublicationPayloadSchema,
  type AmazonListingsFeedMessage,
  type AmazonListingsFeedResult,
  type AmazonListingsFeedSubmission,
  type MarketplaceFeedGateway,
  type PublicationAccountContext,
} from "@yummyai/marketplace-connectors";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { MarketplacePublicationReconciliationScheduler } from "./marketplace-publication.processor.js";

export interface PublicationBatchExecutionItem {
  message: AmazonListingsFeedMessage;
  requestId: string;
}

export interface PublicationBatchExecutionSnapshot {
  authority?: TenantContext;
  account: PublicationAccountContext;
  accountId: string;
  batchId: string;
  expectedMessageCount: number;
  feedId?: string;
  items: PublicationBatchExecutionItem[];
  marketplaceId: string;
  requestIds?: readonly string[];
}

export interface PublicationBatchCompletion {
  reconciliationRequestIds: string[];
  status: "failed" | "partial" | "reconciliation_required" | "submitted";
}

export interface AmazonFeedItemDecision {
  issues: MarketplacePublicationIssue[];
  outcome: "accepted" | "failed" | "reconciliation_required";
  requestId: string;
}

export interface AmazonFeedReportDecision {
  items: AmazonFeedItemDecision[];
  status: PublicationBatchCompletion["status"];
}

export interface PublicationBatchExecutionRepository {
  beforeProviderRequest?(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot): Promise<void>;
  claim(context: TenantContext, batchId: string, attempt: number): Promise<PublicationBatchExecutionSnapshot | undefined>;
  complete(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, result: AmazonListingsFeedResult): Promise<PublicationBatchCompletion>;
  fail(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, event: BatchFailureEvent): Promise<void>;
  recordPending(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, result: AmazonListingsFeedResult): Promise<void>;
  recordSubmission(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, result: AmazonListingsFeedSubmission): Promise<void>;
  withAccountLease<T>(context: TenantContext, batchId: string, operation: () => Promise<T>): Promise<T>;
  withCredential<T>(context: TenantContext, accountId: string, callback: (credential: Readonly<Record<string, string>>) => Promise<T>, snapshot?: PublicationBatchExecutionSnapshot): Promise<T>;
}

export interface BatchFailureEvent {
  code: string;
  message: string;
  requestIds?: string[];
  retryable: boolean;
  revokeAccount?: boolean;
  credentialFence?: MarketplaceCredentialFailureFence;
  status: "failed" | "reconciliation_required" | "retry_pending";
}

export class MarketplacePublicationBatchProcessor {
  constructor(
    private readonly repository: PublicationBatchExecutionRepository,
    private readonly gateway: MarketplaceFeedGateway,
    private readonly reconciliation: MarketplacePublicationReconciliationScheduler,
  ) {}

  async process(envelope: JobEnvelope): Promise<{ batchId: string; status: string }> {
    const payload = MarketplacePublicationBatchJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, permissions: [], dataScope: "tenant" };
    return this.repository.withAccountLease(context, payload.publicationBatchId, async () => {
      const snapshot = await this.repository.claim(context, payload.publicationBatchId, envelope.attempt);
      if (!snapshot) return { batchId: payload.publicationBatchId, status: "no_op" };
      const authority = snapshot.authority ?? context;
      let activeSnapshot = snapshot;
      let guardFailure: unknown;
      try {
        const gateway = this.repository.beforeProviderRequest ? this.gateway.withRequestGuard?.(async () => {
          try { await this.repository.beforeProviderRequest!(authority, activeSnapshot); }
          catch (error) { guardFailure = error; throw error; }
        }) : this.gateway;
        if (!gateway) throw new PublicationAuthorityError("publication_transport_guard_missing");
        let feedId = activeSnapshot.feedId;
        if (!feedId) {
          const submission = await this.repository.withCredential(authority, snapshot.accountId, (credential) =>
            gateway.submitAmazonListingsFeed(snapshot.account, credential, snapshot.marketplaceId, snapshot.items.map((item) => item.message)), snapshot);
          activeSnapshot = { ...snapshot, feedId: submission.feedId };
          try {
            await this.repository.recordSubmission(authority, activeSnapshot, submission);
          } catch {
            await this.repository.fail(authority, activeSnapshot, {
              status: "reconciliation_required",
              code: "AMAZON_FEED_WRITEBACK_FAILED",
              message: "Amazon Feed creation succeeded but its Feed ID could not be recorded conclusively",
              retryable: false,
            });
            return { batchId: snapshot.batchId, status: "reconciliation_required" };
          }
          feedId = submission.feedId;
        }
        const active = { ...activeSnapshot, feedId };
        activeSnapshot = active;
        const result = await this.repository.withCredential(authority, snapshot.accountId, (credential) =>
          gateway.getAmazonListingsFeed(snapshot.account, credential, feedId!), active);
        if (result.processingStatus === "IN_QUEUE" || result.processingStatus === "IN_PROGRESS") {
          await this.repository.recordPending(authority, active, result);
          if (envelope.attempt + 1 >= envelope.maxAttempts) {
            await this.repository.fail(authority, active, {
              status: "reconciliation_required",
              code: "AMAZON_FEED_RECONCILIATION_EXHAUSTED",
              message: "Amazon JSON Listings Feed did not finish within the bounded reconciliation window",
              retryable: false,
            });
            return { batchId: snapshot.batchId, status: "reconciliation_required" };
          }
          throw new MarketplaceConnectorError("amazon", "upstream_retryable", "Amazon JSON Listings Feed is still processing", 15 * 60 * 1_000);
        }
        const completed = await this.repository.complete(authority, active, result);
        const scheduling = await Promise.allSettled(
          completed.reconciliationRequestIds.map((requestId) => this.reconciliation.schedule(authority, requestId)),
        );
        const failedRequestIds = completed.reconciliationRequestIds.filter((_requestId, index) => scheduling[index]?.status === "rejected");
        if (failedRequestIds.length) {
          await this.repository.fail(authority, active, {
            status: "reconciliation_required",
            code: "AMAZON_FEED_RECONCILIATION_QUEUE_UNAVAILABLE",
            message: "One or more accepted Amazon Feed items could not be queued for online status reconciliation",
            requestIds: failedRequestIds,
            retryable: false,
          });
          return { batchId: snapshot.batchId, status: "reconciliation_required" };
        }
        return { batchId: snapshot.batchId, status: completed.status };
      } catch (error) {
        // Original gateways classify network errors; preserve an admission refusal instead.
        const originalError = guardFailure ?? error;
        const failure = classifyFailure(originalError, envelope);
        await this.repository.fail(authority, activeSnapshot, failure);
        if (failure.retryable) throw error;
        return { batchId: snapshot.batchId, status: failure.status };
      }
    });
  }
}

export class DrizzlePublicationBatchExecutionRepository implements PublicationBatchExecutionRepository {
  constructor(private readonly database: DatabaseConnection, private readonly secrets: SecretVault) {}

  async withAccountLease<T>(context: TenantContext, batchId: string, operation: () => Promise<T>): Promise<T> {
    const [batch] = await withTenant(this.database.db, context, (tx) => tx.select({ accountId: marketplacePublicationBatches.accountId })
      .from(marketplacePublicationBatches).where(eq(marketplacePublicationBatches.id, batchId)).limit(1));
    if (!batch) return operation();
    const lockKey = `marketplace-publication:${context.tenantId}:${batch.accountId}`;
    const connection = await this.database.client.reserve();
    try {
      await connection.unsafe("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      return await operation();
    } finally {
      await connection.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      await connection.release();
    }
  }

  async claim(context: TenantContext, batchId: string, attempt: number): Promise<PublicationBatchExecutionSnapshot | undefined> {
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${batchId}, 0))`);
      const [batch] = await tx.select().from(marketplacePublicationBatches).where(eq(marketplacePublicationBatches.id, batchId)).limit(1);
      if (!batch) return undefined;
      if (batch.createdBy !== context.userId) return undefined;
      if (batch.platform !== "amazon" || batch.action !== "continue") {
        await failBatchItems(tx, context, batchId, terminalFailure("PUBLICATION_BATCH_KIND_INVALID", "Only continued Amazon batches use JSON Listings Feed"));
        return undefined;
      }
      const requests = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.batchId, batchId)).orderBy(asc(marketplacePublicationRequests.createdAt), asc(marketplacePublicationRequests.id));
      if (requests.length !== batch.itemCount) {
        await failBatchItems(tx, context, batchId, terminalFailure("PUBLICATION_BATCH_ITEMS_MISSING", "Publication batch item history is incomplete"));
        return undefined;
      }
      const events = await tx.select().from(marketplacePublicationEvents)
        .where(inArray(marketplacePublicationEvents.requestId, requests.map((request) => request.id)))
        .orderBy(desc(marketplacePublicationEvents.sequence));
      const latest = latestEvents(events);
      const pending = requests.filter((request) => !terminalStatuses.has(latest.get(request.id)?.status ?? ""));
      if (!pending.length) return undefined;
      const intents = await tx.select().from(marketplacePublicationIntents)
        .where(inArray(marketplacePublicationIntents.requestId, requests.map(request => request.id)));
      const byRequest = new Map(intents.map(intent => [intent.requestId, intent]));
      const nodeRequestIds = new Set(intents.filter(intent => intent.route === "node_preview").map(intent => intent.requestId));
      if (nodeRequestIds.size) {
        await appendToRequests(tx, context, pending.filter(request => !nodeRequestIds.has(request.id)), latest,
          reconciliationFailure("PUBLICATION_BATCH_ROUTE_INVALID", "A node-owned request cannot enter a central Feed batch"));
        return undefined;
      }
      if (requests.some(request => byRequest.get(request.id)?.route !== "central")) {
        await appendToRequests(tx, context, pending, latest,
          reconciliationFailure("PUBLICATION_LEGACY_AUTHORITY_MISSING", "Original execution authority is missing; manual reconciliation is required"));
        return undefined;
      }
      const [clock] = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
      const now = new Date(clock!.now);
      if (batch.scheduledFor && batch.scheduledFor > now || requests.some(request => request.scheduledFor && request.scheduledFor > now)) return undefined;
      const progress = events.find((event) => event.externalSubmissionId);
      const feedIds = new Set(events.map((event) => event.externalSubmissionId).filter((value): value is string => Boolean(value)));
      if (feedIds.size > 1) {
        await appendToRequests(tx, context, pending, latest, {
          status: "reconciliation_required", code: "AMAZON_FEED_ID_CONFLICT",
          message: "Publication batch recorded conflicting Amazon Feed IDs", retryable: false,
        });
        return undefined;
      }
      if (attempt > 0 && !progress && pending.some((request) => latest.get(request.id)?.status === "processing")) {
        await appendToRequests(tx, context, pending, latest, {
          status: "reconciliation_required", code: "AMAZON_FEED_OUTCOME_UNKNOWN",
          message: "A previous Amazon Feed mutation did not record its Feed ID", retryable: false,
        });
        return undefined;
      }
      let current: Awaited<ReturnType<DrizzlePublicationBatchExecutionRepository["batchAuthorityInTransaction"]>>;
      try { current = await this.batchAuthorityInTransaction(tx, context, batch, requests, pending.map(request => request.id)); }
      catch (error) {
        if (!publicationAuthorityFailure(error)) throw error;
        const invalidSource = error instanceof PublicationAuthorityError && error.code.startsWith("publication_batch_");
        await appendToRequests(tx, context, pending, latest, invalidSource
          ? terminalFailure(error.code.toUpperCase(), "A pinned batch Listing, asset or account is no longer publishable")
          : reconciliationFailure("PUBLICATION_AUTHORITY_CHANGED", "Original publication authority is no longer current"));
        return undefined;
      }
      const { account, authority } = current;
      const messageIdByRequest = new Map(requests.map((request, index) => [request.id, index + 1]));
      const items = pending.map((request) => {
        const payload = MarketplacePublicationPayloadSchema.parse(request.payload);
        if (payload.platform !== "amazon") throw new MarketplaceConnectorError("amazon", "validation", "Amazon feed batch contains a non-Amazon payload");
        return {
          requestId: request.id,
          message: {
            messageId: messageIdByRequest.get(request.id)!,
            sku: payload.sku,
            productType: payload.productType,
            attributes: payload.attributes,
          },
        };
      });
      await appendToRequests(tx, context, pending, latest, {
        status: "processing", code: null, message: null, retryable: false,
        externalListingId: progress?.externalListingId ?? null,
        externalSubmissionId: progress?.externalSubmissionId ?? null,
        externalState: progress?.externalState ?? null,
      });
      return {
        authority,
        account: {
          authorizationMode: MarketplaceAuthorizationModeSchema.parse(account.authorizationMode),
            externalAccountId: current.externalAccountId,
          platform: MarketplacePlatformSchema.parse(account.platform),
          region: MarketplaceRegionSchema.parse(account.region),
        },
        accountId: account.id,
        batchId,
        expectedMessageCount: batch.itemCount,
        ...(progress?.externalSubmissionId ? { feedId: progress.externalSubmissionId } : {}),
        items,
        marketplaceId: batch.marketplaceId,
        requestIds: requests.map(request => request.id),
      };
    });
  }

  async withCredential<T>(context: TenantContext, accountId: string, callback: (credential: Readonly<Record<string, string>>) => Promise<T>, snapshot?: PublicationBatchExecutionSnapshot): Promise<T> {
    if (!snapshot || snapshot.accountId !== accountId) throw new PublicationAuthorityError("publication_original_request_required");
    await this.beforeProviderRequest(context, snapshot);
    const [credential] = await withTenant(this.database.db, context, (tx) => tx.select({ encryptedEnvelope: marketplaceCredentials.encryptedEnvelope,
      authorizationGeneration: marketplaceAccounts.authorizationGeneration, credentialId: marketplaceCredentials.id, credentialVersion: marketplaceCredentials.version,
      accountStatus: marketplaceAccounts.status, platform: marketplaceAccounts.platform, refreshState: marketplaceAccounts.credentialRefreshState, useId: marketplaceAccounts.credentialUseId, deletedAt: marketplaceAccounts.deletedAt })
      .from(marketplaceCredentials).innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, marketplaceCredentials.accountId))
      .where(eq(marketplaceCredentials.accountId, accountId)).limit(1));
    return withWorkerMarketplaceCredential(credential, this.secrets, callback);
  }

  async recordSubmission(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, result: AmazonListingsFeedSubmission): Promise<void> {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.batchId}, 0))`);
      if (snapshot.feedId !== result.feedId) throw new PublicationAuthorityError("publication_source_changed");
      await this.assertSnapshotInTransaction(tx, context, snapshot, true);
      const { latest, requests } = await pendingBatchItems(tx, snapshot.batchId);
      await appendToRequests(tx, context, requests, latest, {
        status: "submission_accepted", code: null, message: null, retryable: false,
        externalSubmissionId: result.feedId, externalState: "IN_QUEUE",
      }, snapshot);
      await recordQuota(tx, context, snapshot, "amazon_feed_submit", result.quota);
    });
  }

  async recordPending(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, result: AmazonListingsFeedResult): Promise<void> {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.batchId}, 0))`);
      if (snapshot.feedId !== result.feedId) throw new PublicationAuthorityError("publication_source_changed");
      await this.assertSnapshotInTransaction(tx, context, snapshot);
      const { latest, requests } = await pendingBatchItems(tx, snapshot.batchId);
      await appendToRequests(tx, context, requests, latest, {
        status: "sync_pending", code: null, message: "Amazon JSON Listings Feed is still processing", retryable: true,
        externalSubmissionId: snapshot.feedId ?? result.feedId, externalState: result.processingStatus,
      }, snapshot);
      await recordQuota(tx, context, snapshot, "amazon_feed_status", result.quota);
    });
  }

  async complete(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, result: AmazonListingsFeedResult): Promise<PublicationBatchCompletion> {
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.batchId}, 0))`);
      if (snapshot.feedId !== result.feedId) throw new PublicationAuthorityError("publication_source_changed");
      await this.assertSnapshotInTransaction(tx, context, snapshot);
      const { latest, requests } = await pendingBatchItems(tx, snapshot.batchId);
      const decision = classifyAmazonFeedReport(snapshot, result, requests.map((request) => request.id));
      const reconciliationRequestIds: string[] = [];
      for (const request of requests) {
        const item = decision.items.find((entry) => entry.requestId === request.id)!;
        const base = {
          externalListingId: snapshot.items.find((item) => item.requestId === request.id)?.message.sku ?? null,
          externalSubmissionId: snapshot.feedId ?? result.feedId,
          externalState: result.processingStatus,
          issues: item.issues,
          retryable: false,
        };
        if (item.outcome === "failed") {
          await appendToRequests(tx, context, [request], latest, { ...base, status: "publication_failed", code: "AMAZON_FEED_ITEM_REJECTED", message: "Amazon rejected this JSON Listings Feed item" });
        } else if (item.outcome === "reconciliation_required") {
          await appendToRequests(tx, context, [request], latest, { ...base, status: "reconciliation_required", code: "AMAZON_FEED_REPORT_INCOMPLETE", message: "Amazon Feed report did not conclusively process every item" });
        } else {
          reconciliationRequestIds.push(request.id);
          await appendToRequests(tx, context, [request], latest, { ...base, status: "sync_pending", code: null, message: "Amazon Feed item was accepted; online status reconciliation is queued" });
        }
      }
      await recordQuota(tx, context, snapshot, "amazon_feed_report", result.quota);
      return { reconciliationRequestIds, status: decision.status };
    });
  }

  async fail(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, event: BatchFailureEvent): Promise<void> {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.batchId}, 0))`);
      // A refusal may be recorded after withdrawal, but only against the original batch.
      await this.pinnedBatchInTransaction(tx, context, snapshot);
      const { latest, requests } = await pendingBatchItems(tx, snapshot.batchId);
      const targetIds = event.requestIds ? new Set(event.requestIds) : undefined;
      const targets = targetIds
        ? requests.filter((request) => targetIds.has(request.id))
        : requests;
      await appendToRequests(tx, context, targets, latest, {
        status: event.status,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
        externalSubmissionId: snapshot.feedId ?? null,
      }, snapshot);
      if (event.revokeAccount) await revokeMarketplaceCredentialIfCurrent(tx, context, snapshot.accountId, event.credentialFence, event.code);
    });
  }

  async beforeProviderRequest(context: TenantContext, snapshot: PublicationBatchExecutionSnapshot): Promise<void> {
    await withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${snapshot.batchId}, 0))`);
      await this.assertSnapshotInTransaction(tx, context, snapshot);
    });
  }

  private async pinnedBatchInTransaction(tx: TenantTransaction, context: TenantContext, snapshot: PublicationBatchExecutionSnapshot) {
    const [batch] = await tx.select().from(marketplacePublicationBatches).where(eq(marketplacePublicationBatches.id, snapshot.batchId)).limit(1);
    const requests = await tx.select().from(marketplacePublicationRequests).where(eq(marketplacePublicationRequests.batchId, snapshot.batchId))
      .orderBy(asc(marketplacePublicationRequests.createdAt), asc(marketplacePublicationRequests.id));
    if (!batch || batch.createdBy !== context.userId || batch.accountId !== snapshot.accountId || batch.platform !== "amazon" || batch.action !== "continue"
      || batch.marketplaceId !== snapshot.marketplaceId || batch.itemCount !== snapshot.expectedMessageCount || requests.length !== batch.itemCount
      || !snapshot.requestIds || checksum(snapshot.requestIds) !== checksum(requests.map(request => request.id))
      || !snapshot.items.length || new Set(snapshot.items.map(item => item.requestId)).size !== snapshot.items.length
      || snapshot.authority && (snapshot.authority.tenantId !== context.tenantId || snapshot.authority.userId !== context.userId)) {
      throw new PublicationAuthorityError();
    }
    for (const item of snapshot.items) {
      const index = requests.findIndex(request => request.id === item.requestId), request = requests[index];
      const parsed = request ? MarketplacePublicationPayloadSchema.safeParse(request.payload) : null;
      if (!request || !parsed?.success || parsed.data.platform !== "amazon" || item.message.messageId !== index + 1
        || checksum(item.message) !== checksum({ messageId: index + 1, sku: parsed.data.sku, productType: parsed.data.productType, attributes: parsed.data.attributes })) {
        throw new PublicationAuthorityError("publication_source_changed");
      }
    }
    return { batch, requests };
  }

  private async assertSnapshotInTransaction(tx: TenantTransaction, context: TenantContext, snapshot: PublicationBatchExecutionSnapshot, newlySubmitted = false) {
    const { batch, requests } = await this.pinnedBatchInTransaction(tx, context, snapshot);
    const current = await this.batchAuthorityInTransaction(tx, context, batch, requests, snapshot.items.map(item => item.requestId));
    if (current.account.externalAccountId !== snapshot.account.externalAccountId || current.account.region !== snapshot.account.region
      || current.account.authorizationMode !== snapshot.account.authorizationMode || current.account.platform !== snapshot.account.platform) throw new PublicationAuthorityError();
    const events = await tx.select().from(marketplacePublicationEvents)
      .where(inArray(marketplacePublicationEvents.requestId, requests.map(request => request.id))).orderBy(desc(marketplacePublicationEvents.sequence));
    const latest = latestEvents(events), feedIds = new Set(events.map(event => event.externalSubmissionId).filter((value): value is string => Boolean(value)));
    if (snapshot.items.some(item => !latest.has(item.requestId) || terminalStatuses.has(latest.get(item.requestId)!.status))
      || feedIds.size > 1 || (snapshot.feedId ? feedIds.size ? !feedIds.has(snapshot.feedId) : !newlySubmitted : feedIds.size > 0)) {
      throw new PublicationAuthorityError("publication_source_changed");
    }
    return current;
  }

  /** Every child restores its own immutable ceiling; a queue envelope grants no business authority. */
  private async batchAuthorityInTransaction(tx: TenantTransaction, context: TenantContext, batch: BatchRow, requests: RequestRow[], sourceIds: readonly string[]) {
    let selected: Awaited<ReturnType<typeof readPublicationAuthority>> | undefined;
    const sourceSet = new Set(sourceIds), sources: RequestRow[] = [];
    for (const request of requests) {
      const current = await readPublicationAuthority(tx, context, request.id, Permission.ListingPublish, true);
      if (current.intent?.route !== "central" || request.batchId !== batch.id || request.accountId !== batch.accountId || request.marketplaceId !== batch.marketplaceId
        || request.capabilitySnapshotId !== batch.capabilitySnapshotId || request.createdBy !== batch.createdBy || batch.createdBy !== context.userId
        || request.action !== "amazon_feed_submit" || request.platform !== "amazon") throw new PublicationAuthorityError();
      selected ??= current;
      if (sourceSet.has(request.id)) {
        if (current.listing.status !== "approved" || current.listing.primaryVersionId !== current.version.id || current.version.status !== "approved"
          || current.version.validation.blockers.length > 0 || current.version.content.platform !== "amazon"
          || checksum(request.payload) !== request.payloadChecksum) throw new PublicationAuthorityError("publication_batch_pin_invalid");
        sources.push(request);
      }
    }
    if (!selected || sources.length !== sourceSet.size) throw new PublicationAuthorityError();
    const [capability] = await tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.id, batch.capabilitySnapshotId)).limit(1);
    const [clock] = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`), now = new Date(clock!.now), account = selected.account;
    if (!capability || capability.accountId !== account.id || capability.authorizationGeneration !== account.authorizationGeneration || capability.platform !== "amazon"
      || !capability.marketplaceIds.includes(batch.marketplaceId) || capability.expiresAt <= now || !capability.capabilities.includes("listing_write")
      || account.platform !== "amazon" || account.status !== "active" || account.healthStatus !== "healthy" || account.deletedAt
      || (account.credentialStatus !== "valid" && account.credentialStatus !== "expiring") || !account.externalAccountId
      || !account.marketplaceIds.includes(batch.marketplaceId) || !account.capabilities.includes("listing_write")
      || batch.scheduledFor && batch.scheduledFor > now || sources.some(request => request.scheduledFor && request.scheduledFor > now)) {
      throw new PublicationAuthorityError("publication_batch_runtime_invalid");
    }
    const assetIds = [...new Set(sources.flatMap(request => request.assetManifest.map(asset => asset.assetId)))];
    const assets = assetIds.length ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, assetIds), isNull(assetFiles.deletedAt))).for("share") : [];
    if (sources.some(request => validatePinnedAssets(request.assetManifest, assets))) throw new PublicationAuthorityError("publication_batch_pin_invalid");
    return { authority: selected.authority, account, externalAccountId: account.externalAccountId };
  }
}

type BatchRow = typeof marketplacePublicationBatches.$inferSelect;
type RequestRow = typeof marketplacePublicationRequests.$inferSelect;

export function classifyAmazonFeedReport(
  snapshot: PublicationBatchExecutionSnapshot,
  result: AmazonListingsFeedResult,
  pendingRequestIds: readonly string[],
): AmazonFeedReportDecision {
  const requestByMessageId = new Map(snapshot.items.map((item) => [item.message.messageId, item.requestId]));
  const issuesByRequest = new Map<string, MarketplacePublicationIssue[]>();
  const globalIssues = result.issues.filter((entry) => entry.messageId === null).map((entry) => entry.issue);
  for (const requestId of pendingRequestIds) issuesByRequest.set(requestId, [...globalIssues]);
  let hasUnmappedIssue = false;
  for (const entry of result.issues) {
    if (entry.messageId === null) continue;
    const requestId = requestByMessageId.get(entry.messageId);
    if (!requestId) {
      hasUnmappedIssue = true;
      continue;
    }
    issuesByRequest.get(requestId)?.push(entry.issue);
  }
  const reportComplete = result.processingStatus === "DONE" &&
    result.summary?.messagesProcessed === snapshot.expectedMessageCount &&
    !hasUnmappedIssue;
  const items = pendingRequestIds.map((requestId): AmazonFeedItemDecision => {
    const issues = issuesByRequest.get(requestId) ?? [];
    const rejected = result.processingStatus === "FATAL" || result.processingStatus === "CANCELLED" ||
      issues.some((issue) => issue.severity === "blocker");
    return {
      requestId,
      issues,
      outcome: rejected ? "failed" : reportComplete ? "accepted" : "reconciliation_required",
    };
  });
  const failed = items.filter((item) => item.outcome === "failed").length;
  const reconciliationRequired = items.some((item) => item.outcome === "reconciliation_required");
  const status = reconciliationRequired
    ? "reconciliation_required"
    : failed === items.length ? "failed" : failed > 0 ? "partial" : "submitted";
  return { items, status };
}

const terminalStatuses = new Set(["published", "publication_failed", "validation_failed", "deactivated", "reconciliation_required", "cancelled", "failed"]);

function classifyFailure(error: unknown, envelope: JobEnvelope): BatchFailureEvent {
  if (publicationAuthorityFailure(error)) return reconciliationFailure("PUBLICATION_AUTHORITY_CHANGED", "Original publication authority or source changed; no further Feed request is permitted");
  if (!(error instanceof MarketplaceConnectorError)) {
    const retryable = envelope.attempt + 1 < envelope.maxAttempts;
    return { status: retryable ? "retry_pending" : "failed", code: "AMAZON_FEED_WORKER_FAILED", message: "Amazon Feed worker failed before a conclusive result", retryable };
  }
  if (error.outcomeUncertain) return { status: "reconciliation_required", code: "AMAZON_FEED_OUTCOME_UNKNOWN", message: "Amazon Feed creation outcome is unknown and cannot be replayed safely", retryable: false };
  const retryable = error.retryable && envelope.attempt + 1 < envelope.maxAttempts;
  const credentialFence = readMarketplaceCredentialFailureFence(error);
  return {
    status: retryable ? "retry_pending" : "failed",
    code: `AMAZON_FEED_${error.code.toUpperCase()}`,
    message: error.code === "authorization" ? "Amazon authorization is invalid or expired" : "Amazon Feed service is unavailable",
    retryable,
    revokeAccount: error.code === "authorization",
    ...(credentialFence ? { credentialFence } : {}),
  };
}

async function pendingBatchItems(tx: TenantTransaction, batchId: string) {
  const all = await tx.select().from(marketplacePublicationRequests).where(eq(marketplacePublicationRequests.batchId, batchId));
  const events = await tx.select().from(marketplacePublicationEvents)
    .where(inArray(marketplacePublicationEvents.requestId, all.map((request) => request.id)))
    .orderBy(desc(marketplacePublicationEvents.sequence));
  const latest = latestEvents(events);
  return { latest, requests: all.filter((request) => !terminalStatuses.has(latest.get(request.id)?.status ?? "")) };
}

async function failBatchItems(tx: TenantTransaction, context: TenantContext, batchId: string, event: BatchFailureEvent) {
  const { latest, requests } = await pendingBatchItems(tx, batchId);
  await appendToRequests(tx, context, requests, latest, event);
}

async function appendToRequests(
  tx: TenantTransaction,
  context: TenantContext,
  requests: Array<typeof marketplacePublicationRequests.$inferSelect>,
  latest: Map<string, typeof marketplacePublicationEvents.$inferSelect>,
  event: {
    code: string | null;
    externalListingId?: string | null;
    externalState?: string | null;
    externalSubmissionId?: string | null;
    issues?: MarketplacePublicationIssue[];
    message: string | null;
    retryable: boolean;
    status: MarketplacePublicationStatus;
  },
  snapshot?: PublicationBatchExecutionSnapshot,
) {
  if (!requests.length) return;
  await tx.insert(marketplacePublicationEvents).values(requests.map((request) => ({
    id: createEntityId(), tenantId: context.tenantId, requestId: request.id,
    sequence: (latest.get(request.id)?.sequence ?? 0) + 1,
    status: event.status, code: event.code, message: event.message, retryable: event.retryable,
    issues: event.issues ?? [],
    externalListingId: event.externalListingId ?? snapshot?.items.find((item) => item.requestId === request.id)?.message.sku ?? null,
    externalSubmissionId: event.externalSubmissionId ?? snapshot?.feedId ?? null,
    externalState: event.externalState ?? null,
    actorUserId: context.userId,
  })));
}

async function recordQuota(
  tx: TenantTransaction,
  context: TenantContext,
  snapshot: PublicationBatchExecutionSnapshot,
  operation: string,
  quota: AmazonListingsFeedSubmission["quota"],
) {
  if (!quota) return;
  await tx.insert(marketplaceQuotaSnapshots).values({
    id: createEntityId(), tenantId: context.tenantId, accountId: snapshot.accountId,
    platform: "amazon", operation, publicationBatchId: snapshot.batchId,
    publicationRequestId: null, listingSyncRequestId: null,
    windows: [...quota.windows], observedAt: new Date(quota.observedAt),
  });
}

function latestEvents(events: Array<typeof marketplacePublicationEvents.$inferSelect>) {
  const latest = new Map<string, typeof marketplacePublicationEvents.$inferSelect>();
  for (const event of events) if (!latest.has(event.requestId)) latest.set(event.requestId, event);
  return latest;
}

function terminalFailure(code: string, message: string): BatchFailureEvent {
  return { status: "failed", code, message, retryable: false };
}

function reconciliationFailure(code: string, message: string): BatchFailureEvent {
  return { status: "reconciliation_required", code, message, retryable: false };
}

function publicationAuthorityFailure(error: unknown): boolean {
  return error instanceof Error && ["PublicationAuthorityError", "ForbiddenError", "CatalogAccessNotFoundError"].includes(error.constructor.name);
}

function validatePinnedAssets(pins: MarketplacePublicationAssetPin[], assets: Array<typeof assetFiles.$inferSelect>): string | undefined {
  const current = new Map(assets.map((asset) => [asset.id, asset]));
  for (const pin of pins) {
    const asset = current.get(pin.assetId);
    if (!asset || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || asset.version !== pin.assetVersion ||
        asset.checksumSha256 !== pin.checksumSha256 || asset.objectKey !== pin.objectKey) return pin.assetId;
  }
  return undefined;
}

function checksum(value: unknown): string {
  const serialized = stableStringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
