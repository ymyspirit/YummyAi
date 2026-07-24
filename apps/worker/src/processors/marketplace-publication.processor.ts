import type { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import {
  MarketplacePublicationStatusSchema,
  MarketplacePublicationActionSchema,
  MarketplacePlatformSchema,
  MarketplaceRegionSchema,
  MarketplaceAuthorizationModeSchema,
  createEntityId,
  type MarketplacePublicationIssue,
  type MarketplacePublicationAction,
  type MarketplacePublicationStatus,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  listingVersions,
  listings,
  marketplaceAccounts,
  marketplaceCapabilitySnapshots,
  marketplaceCredentials,
  marketplacePublicationEvents,
  marketplacePublicationRequests,
  marketplaceQuotaSnapshots,
  type DatabaseConnection,
  type MarketplacePublicationAssetPin,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import {
  MarketplacePublicationJobPayloadSchema,
  type JobEnvelope,
} from "@yummyai/jobs";
import {
  MarketplaceConnectorError,
  MarketplacePublicationPayloadSchema,
  type MarketplaceDraftGateway,
  type MarketplaceDraftResult,
  type MarketplaceMediaInput,
  type MarketplacePublicationPayload,
  type PublicationAccountContext,
} from "@yummyai/marketplace-connectors";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";

export interface PublicationExecutionSnapshot {
  requestId: string;
  accountId: string;
  action: MarketplacePublicationAction;
  platform: "amazon" | "etsy";
  payload: MarketplacePublicationPayload;
  account: PublicationAccountContext;
  assetManifest: readonly MarketplacePublicationAssetPin[];
  externalListingId?: string;
  externalMediaIds: readonly string[];
  resumeStatus?: MarketplacePublicationStatus;
}

export interface PublicationExecutionRepository {
  withAccountLease<T>(
    context: TenantContext,
    requestId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  claim(
    context: TenantContext,
    requestId: string,
    attempt: number,
  ): Promise<PublicationExecutionSnapshot | undefined>;
  withCredential<T>(
    context: TenantContext,
    accountId: string,
    callback: (credential: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T>;
  readMedia(
    context: TenantContext,
    snapshot: PublicationExecutionSnapshot,
  ): Promise<readonly MarketplaceMediaInput[]>;
  complete(
    context: TenantContext,
    requestId: string,
    result: MarketplaceDraftResult,
  ): Promise<void>;
  fail(
    context: TenantContext,
    requestId: string,
    event: PublicationFailureEvent,
  ): Promise<void>;
}

export interface MarketplacePublicationReconciliationScheduler {
  schedule(context: TenantContext, publicationRequestId: string): Promise<void>;
}

export interface PublicationFailureEvent {
  status: "retry_pending" | "reconciliation_required" | "failed";
  code: string;
  message: string;
  retryable: boolean;
  revokeAccount?: boolean;
}

export class MarketplacePublicationProcessor {
  constructor(
    private readonly repository: PublicationExecutionRepository,
    private readonly gateway: MarketplaceDraftGateway,
    private readonly reconciliationScheduler?: MarketplacePublicationReconciliationScheduler,
  ) {}

  async process(envelope: JobEnvelope): Promise<{ requestId: string; status: string }> {
    const payload = MarketplacePublicationJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = {
      tenantId: envelope.tenantId,
      userId: envelope.requestedBy,
      permissions: [],
      dataScope: "tenant",
    };
    return this.repository.withAccountLease(context, payload.publicationRequestId, async () => {
      const snapshot = await this.repository.claim(context, payload.publicationRequestId, envelope.attempt);
      if (!snapshot) return { requestId: payload.publicationRequestId, status: "no_op" };
      if (snapshot.action === "amazon_validation_preview" || snapshot.action === "etsy_create_draft") {
        const step = await this.execute(context, snapshot, envelope, snapshot.action === "etsy_create_draft", (credential) =>
          this.gateway.create(snapshot.account, credential, snapshot.payload),
        );
        return { requestId: snapshot.requestId, status: step.status };
      }
      if (snapshot.action === "amazon_submit") {
        return this.submitAmazon(context, snapshot, envelope);
      }
      if (snapshot.action === "amazon_feed_submit") {
        return this.reconcileAmazonFeedItem(context, snapshot, envelope);
      }
      return this.activateEtsy(context, snapshot, envelope);
    });
  }

  private async submitAmazon(
    context: TenantContext,
    snapshot: PublicationExecutionSnapshot,
    envelope: JobEnvelope,
  ): Promise<{ requestId: string; status: string }> {
    let externalListingId = snapshot.externalListingId;
    if (!hasProgress(snapshot.resumeStatus, ["submission_accepted", "sync_pending"])) {
      const submitted = await this.execute(context, snapshot, envelope, true, (credential) =>
        this.gateway.submit(snapshot.account, credential, snapshot.payload),
      );
      if (!submitted.result || submitted.result.status === "publication_failed") {
        return { requestId: snapshot.requestId, status: submitted.status };
      }
      externalListingId = submitted.result.externalListingId;
    }
    if (!externalListingId) {
      return this.recordTerminal(context, snapshot.requestId, "PUBLICATION_EXTERNAL_ID_MISSING", "Amazon submission did not record its SKU");
    }
    const synced = await this.execute(context, snapshot, envelope, false, (credential) =>
      this.gateway.getStatus(snapshot.account, credential, snapshot.payload, externalListingId!),
    );
    await retryPendingStatus(synced.result, envelope);
    if (synced.result?.status === "sync_pending") {
      return this.scheduleReconciliation(context, snapshot.requestId);
    }
    return { requestId: snapshot.requestId, status: synced.status };
  }

  private async reconcileAmazonFeedItem(
    context: TenantContext,
    snapshot: PublicationExecutionSnapshot,
    envelope: JobEnvelope,
  ): Promise<{ requestId: string; status: string }> {
    if (!snapshot.externalListingId || snapshot.payload.platform !== "amazon") {
      return this.recordTerminal(
        context,
        snapshot.requestId,
        "PUBLICATION_EXTERNAL_ID_MISSING",
        "Amazon Feed item did not record its SKU",
      );
    }
    const synced = await this.execute(context, snapshot, envelope, false, (credential) =>
      this.gateway.getStatus(snapshot.account, credential, snapshot.payload, snapshot.externalListingId!),
    );
    await retryPendingStatus(synced.result, envelope);
    if (synced.result?.status === "sync_pending") {
      return this.scheduleReconciliation(context, snapshot.requestId);
    }
    return { requestId: snapshot.requestId, status: synced.status };
  }

  private async activateEtsy(
    context: TenantContext,
    snapshot: PublicationExecutionSnapshot,
    envelope: JobEnvelope,
  ): Promise<{ requestId: string; status: string }> {
    const externalListingId = snapshot.externalListingId;
    if (!externalListingId) {
      return this.recordTerminal(context, snapshot.requestId, "PUBLICATION_EXTERNAL_ID_MISSING", "Etsy activation request does not pin a draft Listing ID");
    }
    let progress = snapshot.resumeStatus;
    if (!hasProgress(progress, ["configuration_applied", "media_uploaded", "activation_accepted", "sync_pending"])) {
      const configuresExternalState = snapshot.payload.platform === "etsy" && Boolean(
        snapshot.payload.inventory || snapshot.payload.personalization,
      );
      const configured = await this.execute(context, snapshot, envelope, configuresExternalState, (credential) =>
        this.gateway.configure(snapshot.account, credential, snapshot.payload, externalListingId),
      );
      if (!configured.result) return { requestId: snapshot.requestId, status: configured.status };
      progress = configured.result.status;
    }
    if (!hasProgress(progress, ["media_uploaded", "activation_accepted", "sync_pending"])) {
      let media: readonly MarketplaceMediaInput[];
      try {
        media = await this.repository.readMedia(context, snapshot);
      } catch (error) {
        const failure = classifyFailure(error, envelope);
        await this.repository.fail(context, snapshot.requestId, failure);
        if (failure.retryable) throw error;
        return { requestId: snapshot.requestId, status: failure.status };
      }
      const uploaded = await this.execute(context, snapshot, envelope, true, (credential) =>
        this.gateway.uploadMedia(snapshot.account, credential, externalListingId, media),
      );
      if (!uploaded.result) return { requestId: snapshot.requestId, status: uploaded.status };
      progress = uploaded.result.status;
    }
    if (!hasProgress(progress, ["activation_accepted", "sync_pending"])) {
      const activated = await this.execute(context, snapshot, envelope, true, (credential) =>
        this.gateway.activate(snapshot.account, credential, externalListingId),
      );
      if (!activated.result) return { requestId: snapshot.requestId, status: activated.status };
    }
    const synced = await this.execute(context, snapshot, envelope, false, (credential) =>
      this.gateway.getStatus(snapshot.account, credential, snapshot.payload, externalListingId),
    );
    await retryPendingStatus(synced.result, envelope);
    if (synced.result?.status === "sync_pending") {
      return this.scheduleReconciliation(context, snapshot.requestId);
    }
    return { requestId: snapshot.requestId, status: synced.status };
  }

  private async scheduleReconciliation(
    context: TenantContext,
    requestId: string,
  ): Promise<{ requestId: string; status: string }> {
    if (!this.reconciliationScheduler) return { requestId, status: "sync_pending" };
    try {
      await this.reconciliationScheduler.schedule(context, requestId);
      return { requestId, status: "sync_pending" };
    } catch {
      await this.repository.fail(context, requestId, {
        status: "reconciliation_required",
        code: "PUBLICATION_RECONCILIATION_QUEUE_UNAVAILABLE",
        message: "Background marketplace reconciliation could not be scheduled; manual reconciliation is required",
        retryable: false,
      });
      return { requestId, status: "reconciliation_required" };
    }
  }

  private async execute(
    context: TenantContext,
    snapshot: PublicationExecutionSnapshot,
    envelope: JobEnvelope,
    mutation: boolean,
    operation: (credential: Readonly<Record<string, string>>) => Promise<MarketplaceDraftResult>,
  ): Promise<{ result?: MarketplaceDraftResult; status: string }> {
    let result: MarketplaceDraftResult;
    try {
      result = await this.repository.withCredential(context, snapshot.accountId, operation);
    } catch (error) {
      const failure = classifyFailure(error, envelope);
      await this.repository.fail(context, snapshot.requestId, failure);
      if (failure.retryable) throw error;
      return { status: failure.status };
    }
    try {
      await this.repository.complete(context, snapshot.requestId, result);
      return { result, status: result.status };
    } catch (error) {
      const failure: PublicationFailureEvent = mutation
        ? {
            status: "reconciliation_required",
            code: "PUBLICATION_WRITEBACK_FAILED",
            message: "Marketplace mutation succeeded but its result could not be recorded; manual reconciliation is required",
            retryable: false,
          }
        : classifyFailure(error, envelope);
      await this.repository.fail(context, snapshot.requestId, failure);
      if (failure.retryable) throw error;
      return { status: failure.status };
    }
  }

  private async recordTerminal(
    context: TenantContext,
    requestId: string,
    code: string,
    message: string,
  ): Promise<{ requestId: string; status: string }> {
    await this.repository.fail(context, requestId, terminalFailure(code, message));
    return { requestId, status: "failed" };
  }
}

export class DrizzlePublicationExecutionRepository implements PublicationExecutionRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly secrets: SecretVault,
    private readonly storage: Storage,
  ) {}

  async withAccountLease<T>(
    context: TenantContext,
    requestId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const [request] = await withTenant(this.database.db, context, (tx) =>
      tx.select({ accountId: marketplacePublicationRequests.accountId })
        .from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, requestId))
        .limit(1),
    );
    if (!request) return operation();

    const lockKey = `marketplace-publication:${context.tenantId}:${request.accountId}`;
    const connection = await this.database.client.reserve();
    try {
      await connection.unsafe("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      return await operation();
    } finally {
      await connection.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      await connection.release();
    }
  }

  async claim(
    context: TenantContext,
    requestId: string,
    attempt: number,
  ): Promise<PublicationExecutionSnapshot | undefined> {
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const [request] = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, requestId))
        .limit(1);
      if (!request) return undefined;
      const [latest] = await tx.select().from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(desc(marketplacePublicationEvents.sequence))
        .limit(1);
      if (!latest || isTerminal(latest.status)) return undefined;
      let nextSequence = latest.sequence + 1;
      const [progress] = await tx.select().from(marketplacePublicationEvents)
        .where(and(
          eq(marketplacePublicationEvents.requestId, requestId),
          inArray(marketplacePublicationEvents.status, [
            "submission_accepted",
            "configuration_applied",
            "media_uploaded",
            "activation_accepted",
            "sync_pending",
          ]),
        ))
        .orderBy(desc(marketplacePublicationEvents.sequence))
        .limit(1);
      const resumeStatus = progress ? MarketplacePublicationStatusSchema.parse(progress.status) : undefined;
      if (attempt > 0 && interruptedMutationIsUncertain(request.action, latest.status, resumeStatus)) {
        await insertEvent(tx, context, requestId, nextSequence, {
          status: "reconciliation_required",
          code: "PUBLICATION_INTERRUPTED_OUTCOME_UNKNOWN",
          message: "A previous marketplace mutation did not record a conclusive result; automatic retry is blocked",
          retryable: false,
        });
        return undefined;
      }

      if (latest.status === "scheduled") {
        await insertEvent(tx, context, requestId, nextSequence, {
          status: "queued",
          code: null,
          message: null,
          retryable: false,
        });
        nextSequence += 1;
      }

      const [[account], [capability], [listing], [version]] = await Promise.all([
        tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, request.accountId)).limit(1),
        tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.id, request.capabilitySnapshotId)).limit(1),
        tx.select().from(listings).where(eq(listings.id, request.listingId)).limit(1),
        tx.select().from(listingVersions).where(eq(listingVersions.id, request.listingVersionId)).limit(1),
      ]);
      if (!account || !capability || !listing || !version) {
        await insertEvent(tx, context, requestId, nextSequence, terminalFailure("PUBLICATION_SNAPSHOT_MISSING", "Pinned publication snapshot is incomplete"));
        return undefined;
      }
      const safeStatusRead = isSafeStatusRead(request.action, resumeStatus);
      const runtimeFailure = validateRuntime(request, account, capability, listing, version, safeStatusRead);
      if (runtimeFailure) {
        await insertEvent(tx, context, requestId, nextSequence, runtimeFailure);
        return undefined;
      }
      const assetIds = request.assetManifest.map((asset) => asset.assetId);
      const assets = assetIds.length === 0
        ? []
        : await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, assetIds), isNull(assetFiles.deletedAt)));
      const assetFailure = safeStatusRead ? undefined : validatePinnedAssets(request.assetManifest, assets);
      if (assetFailure) {
        await insertEvent(tx, context, requestId, nextSequence, assetFailure);
        return undefined;
      }
      const parsedPayload = MarketplacePublicationPayloadSchema.safeParse(request.payload);
      if (!parsedPayload.success || checksum(request.payload) !== request.payloadChecksum) {
        await insertEvent(tx, context, requestId, nextSequence, terminalFailure("PUBLICATION_PAYLOAD_MISMATCH", "Pinned publication payload is invalid"));
        return undefined;
      }
      await insertEvent(tx, context, requestId, nextSequence, {
        status: "processing",
        code: null,
        message: null,
        retryable: false,
      });
      return {
        requestId,
        accountId: account.id,
        action: MarketplacePublicationActionSchema.parse(request.action),
        platform: MarketplacePlatformSchema.parse(account.platform),
        payload: parsedPayload.data,
        assetManifest: request.assetManifest,
        externalListingId: progress?.externalListingId ?? request.sourceExternalListingId ?? undefined,
        externalMediaIds: progress?.externalMediaIds ?? [],
        resumeStatus,
        account: {
          authorizationMode: MarketplaceAuthorizationModeSchema.parse(account.authorizationMode),
          externalAccountId: account.externalAccountId!,
          platform: MarketplacePlatformSchema.parse(account.platform),
          region: MarketplaceRegionSchema.parse(account.region),
        },
      };
    });
  }

  async readMedia(
    context: TenantContext,
    snapshot: PublicationExecutionSnapshot,
  ): Promise<readonly MarketplaceMediaInput[]> {
    const pins = snapshot.assetManifest
      .filter((pin) => pin.publicationRole !== "supplemental")
      .map((pin, index) => ({ ...pin, rank: pin.rank ?? index + 1 }))
      .sort((left, right) => left.rank - right.rank);
    if (pins.length === 0 || pins.length > 20) {
      throw new MarketplaceConnectorError("etsy", "validation", "Etsy activation requires between 1 and 20 listing images");
    }
    const storageContext: TenantContext = {
      ...context,
      permissions: [...new Set([...context.permissions, Permission.AssetRead])],
    };
    return Promise.all(pins.map(async (pin) => {
      const bytes = await this.storage.readPrivate(storageContext, {
        id: pin.assetId,
        tenantId: context.tenantId,
        assetDomain: pin.assetDomain,
        objectKey: pin.objectKey,
      }, { requiredDomain: "authorized" });
      if (createHash("sha256").update(bytes).digest("hex") !== pin.checksumSha256) {
        throw new MarketplaceConnectorError("etsy", "validation", `Pinned asset checksum changed: ${pin.assetId}`);
      }
      return {
        assetId: pin.assetId,
        bytes,
        fileName: pin.fileName,
        mediaType: pin.mediaType,
        rank: pin.rank,
      };
    }));
  }

  async withCredential<T>(
    context: TenantContext,
    accountId: string,
    callback: (credential: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    const [credential] = await withTenant(this.database.db, context, (tx) =>
      tx.select({
        encryptedEnvelope: marketplaceCredentials.encryptedEnvelope,
        accountStatus: marketplaceAccounts.status,
        platform: marketplaceAccounts.platform,
      })
        .from(marketplaceCredentials)
        .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, marketplaceCredentials.accountId))
        .where(eq(marketplaceCredentials.accountId, accountId))
        .limit(1),
    );
    if (!credential || credential.accountStatus !== "active") {
      throw new MarketplaceConnectorError(
        credential?.platform === "etsy" ? "etsy" : "amazon",
        "authorization",
        "Marketplace credential is unavailable",
      );
    }
    return this.secrets.withSecret(credential.encryptedEnvelope, (raw) =>
      callback(z.record(z.string(), z.string()).parse(JSON.parse(raw))),
    );
  }

  async complete(context: TenantContext, requestId: string, result: MarketplaceDraftResult): Promise<void> {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const [request] = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, requestId)).limit(1);
      const [latest] = await tx.select().from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(desc(marketplacePublicationEvents.sequence)).limit(1);
      if (!request || !latest || isTerminal(latest.status)) return;
      const [[identifierProgress], [mediaProgress]] = await Promise.all([
        tx.select().from(marketplacePublicationEvents)
          .where(and(
            eq(marketplacePublicationEvents.requestId, requestId),
            inArray(marketplacePublicationEvents.status, [
              "submission_accepted",
              "configuration_applied",
              "media_uploaded",
              "activation_accepted",
              "sync_pending",
            ]),
          ))
          .orderBy(desc(marketplacePublicationEvents.sequence))
          .limit(1),
        tx.select().from(marketplacePublicationEvents)
          .where(and(
            eq(marketplacePublicationEvents.requestId, requestId),
            eq(marketplacePublicationEvents.status, "media_uploaded"),
          ))
          .orderBy(desc(marketplacePublicationEvents.sequence))
          .limit(1),
      ]);
      if (result.refreshedCredential) {
        const [stored] = await tx.select({ id: marketplaceCredentials.id, version: marketplaceCredentials.version })
          .from(marketplaceCredentials)
          .where(eq(marketplaceCredentials.accountId, request.accountId))
          .limit(1);
        if (!stored) throw new MarketplaceConnectorError(request.platform === "etsy" ? "etsy" : "amazon", "authorization", "Marketplace credential is unavailable");
        await tx.update(marketplaceCredentials).set({
          encryptedEnvelope: this.secrets.encrypt(JSON.stringify(result.refreshedCredential)),
          version: stored.version + 1,
          expiresAt: result.refreshedCredentialExpiresAt ?? null,
          rotatedAt: result.submittedAt,
          updatedAt: result.submittedAt,
        }).where(eq(marketplaceCredentials.id, stored.id));
      }
      if (result.quota) {
        await tx.insert(marketplaceQuotaSnapshots).values({
          id: createEntityId(),
          tenantId: context.tenantId,
          accountId: request.accountId,
          platform: request.platform,
          operation: result.status,
          publicationRequestId: requestId,
          listingSyncRequestId: null,
          windows: [...result.quota.windows],
          observedAt: new Date(result.quota.observedAt),
        });
      }
      await insertEvent(tx, context, requestId, latest.sequence + 1, {
        status: result.status,
        code: null,
        message: null,
        issues: [...result.issues],
        externalListingId: result.externalListingId ?? identifierProgress?.externalListingId ?? request.sourceExternalListingId,
        externalSubmissionId: result.externalSubmissionId ?? identifierProgress?.externalSubmissionId,
        externalMediaIds: result.externalMediaIds ? [...result.externalMediaIds] : (mediaProgress?.externalMediaIds ?? []),
        externalState: result.externalState,
        retryable: false,
      });
    });
  }

  async fail(context: TenantContext, requestId: string, event: PublicationFailureEvent): Promise<void> {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const [request] = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, requestId)).limit(1);
      const [latest] = await tx.select().from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(desc(marketplacePublicationEvents.sequence)).limit(1);
      if (!request || !latest || isTerminal(latest.status)) return;
      await insertEvent(tx, context, requestId, latest.sequence + 1, event);
      if (event.revokeAccount) {
        await tx.update(marketplaceAccounts).set({
          status: "revoked",
          credentialStatus: "revoked",
          healthStatus: "unauthorized",
          lastHealthAt: new Date(),
          lastErrorCode: event.code,
          updatedAt: new Date(),
        }).where(eq(marketplaceAccounts.id, request.accountId));
      }
    });
  }
}

type RequestRow = typeof marketplacePublicationRequests.$inferSelect;
type AccountRow = typeof marketplaceAccounts.$inferSelect;
type CapabilityRow = typeof marketplaceCapabilitySnapshots.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type ListingVersionRow = typeof listingVersions.$inferSelect;
type AssetRow = typeof assetFiles.$inferSelect;

const terminalStatuses = new Set<MarketplacePublicationStatus>([
  "validation_passed",
  "validation_failed",
  "draft_created",
  "published",
  "publication_failed",
  "deactivated",
  "reconciliation_required",
  "cancelled",
  "failed",
]);

function hasProgress(
  status: MarketplacePublicationStatus | undefined,
  accepted: readonly MarketplacePublicationStatus[],
): boolean {
  return status !== undefined && accepted.includes(status);
}

export function interruptedMutationIsUncertain(
  action: string,
  latestStatus: string,
  resumeStatus: MarketplacePublicationStatus | undefined,
): boolean {
  if (latestStatus === "retry_pending" || action === "amazon_validation_preview" || action === "amazon_feed_submit") return false;
  if (action === "etsy_create_draft") return latestStatus === "processing";
  if (action === "amazon_submit") {
    return latestStatus === "processing" && !hasProgress(resumeStatus, ["submission_accepted", "sync_pending"]);
  }
  if (action === "etsy_activate") {
    const safeRead = hasProgress(resumeStatus, ["activation_accepted", "sync_pending"]);
    return latestStatus === "processing" && !safeRead;
  }
  return false;
}

async function retryPendingStatus(
  result: MarketplaceDraftResult | undefined,
  envelope: JobEnvelope,
): Promise<void> {
  if (result?.status === "sync_pending" && envelope.attempt + 1 < envelope.maxAttempts) {
    throw new PublicationStatusPendingError();
  }
}

class PublicationStatusPendingError extends Error {
  constructor() {
    super("Marketplace publication status is still processing");
    this.name = "PublicationStatusPendingError";
  }
}

function isTerminal(status: string): boolean {
  const parsed = MarketplacePublicationStatusSchema.safeParse(status);
  return parsed.success && terminalStatuses.has(parsed.data);
}

function validateRuntime(
  request: RequestRow,
  account: AccountRow,
  capability: CapabilityRow,
  listing: ListingRow,
  version: ListingVersionRow,
  safeStatusRead: boolean,
): PublicationFailureEvent | undefined {
  if (account.status !== "active" || account.healthStatus !== "healthy" ||
      (account.credentialStatus !== "valid" && account.credentialStatus !== "expiring")) {
    return terminalFailure("PUBLICATION_ACCOUNT_UNAVAILABLE", "Marketplace account is no longer active and healthy");
  }
  const requiredCapability = safeStatusRead ? "listing_read" : "listing_write";
  if (!account.externalAccountId || !account.capabilities.includes(requiredCapability) ||
      !account.marketplaceIds.includes(request.marketplaceId)) {
    return terminalFailure("PUBLICATION_CAPABILITY_REVOKED", "Marketplace account no longer grants the pinned publication target");
  }
  if (!safeStatusRead && (capability.expiresAt.getTime() <= Date.now() || !capability.capabilities.includes("listing_write"))) {
    return terminalFailure("PUBLICATION_CAPABILITY_STALE", "Pinned marketplace capability snapshot is stale or read-only");
  }
  if (!safeStatusRead && request.action === "etsy_activate" && (
    !account.capabilities.includes("media_write") ||
    !account.capabilities.includes("inventory_write") ||
    !capability.capabilities.includes("media_write") ||
    !capability.capabilities.includes("inventory_write")
  )) {
    return terminalFailure("PUBLICATION_ETSY_WRITE_CAPABILITY_MISSING", "Etsy activation requires current media and inventory write capabilities");
  }
  if (!safeStatusRead && (listing.status !== "approved" || listing.primaryVersionId !== version.id || version.status !== "approved" ||
      version.listingId !== listing.id || version.validation.blockers.length > 0)) {
    return terminalFailure("PUBLICATION_LISTING_CHANGED", "Pinned Listing version is no longer the current approved version");
  }
  if (request.platform !== account.platform || request.platform !== listing.platform || request.platform !== version.content.platform) {
    return terminalFailure("PUBLICATION_PLATFORM_MISMATCH", "Publication platform does not match its pinned resources");
  }
  return undefined;
}

function isSafeStatusRead(
  action: string,
  resumeStatus: MarketplacePublicationStatus | undefined,
): boolean {
  if (action === "amazon_submit" || action === "amazon_feed_submit") {
    return hasProgress(resumeStatus, ["submission_accepted", "sync_pending"]);
  }
  if (action === "etsy_activate") {
    return hasProgress(resumeStatus, ["activation_accepted", "sync_pending"]);
  }
  return false;
}

function validatePinnedAssets(
  pins: readonly MarketplacePublicationAssetPin[],
  assets: readonly AssetRow[],
): PublicationFailureEvent | undefined {
  const current = new Map(assets.map((asset) => [asset.id, asset]));
  for (const pin of pins) {
    const asset = current.get(pin.assetId);
    if (!asset || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" ||
        asset.version !== pin.assetVersion || asset.checksumSha256 !== pin.checksumSha256 ||
        asset.objectKey !== pin.objectKey) {
      return terminalFailure("PUBLICATION_ASSET_CHANGED", `Pinned authorized asset is unavailable: ${pin.assetId}`);
    }
  }
  return undefined;
}

function classifyFailure(error: unknown, envelope: JobEnvelope): PublicationFailureEvent {
  if (!(error instanceof MarketplaceConnectorError)) {
    const retryable = envelope.attempt + 1 < envelope.maxAttempts;
    return {
      status: retryable ? "retry_pending" : "failed",
      code: "PUBLICATION_WORKER_FAILED",
      message: "Publication worker failed before a marketplace result was recorded",
      retryable,
    };
  }
  const code = `PUBLICATION_${error.code.toUpperCase()}`;
  if (error.outcomeUncertain) {
    return {
      status: "reconciliation_required",
      code: "PUBLICATION_OUTCOME_UNKNOWN",
      message: "Marketplace response was not received; manual reconciliation is required",
      retryable: false,
    };
  }
  const retryable = error.retryable && envelope.attempt + 1 < envelope.maxAttempts;
  return {
    status: retryable ? "retry_pending" : "failed",
    code,
    message: safeConnectorMessage(error),
    retryable,
    revokeAccount: error.code === "authorization",
  };
}

function safeConnectorMessage(error: MarketplaceConnectorError): string {
  if (error.code === "authorization") return "Marketplace authorization is invalid or expired";
  if (error.code === "validation") return "Marketplace rejected the publication payload";
  if (error.code === "rate_limited") return "Marketplace rate limit delayed the publication";
  if (error.code === "conflict") return "Marketplace state conflicts with the publication request";
  return "Marketplace publication service is unavailable";
}

function terminalFailure(code: string, message: string): PublicationFailureEvent {
  return { status: "failed", code, message, retryable: false };
}

async function insertEvent(
  tx: TenantTransaction,
  context: TenantContext,
  requestId: string,
  sequence: number,
  event: {
    status: MarketplacePublicationStatus;
    code: string | null;
    message: string | null;
    issues?: MarketplacePublicationIssue[];
    externalListingId?: string | null;
    externalSubmissionId?: string | null;
    externalMediaIds?: string[];
    externalState?: string | null;
    retryable: boolean;
  },
): Promise<void> {
  await tx.insert(marketplacePublicationEvents).values({
    id: createEntityId(),
    tenantId: context.tenantId,
    requestId,
    sequence,
    status: MarketplacePublicationStatusSchema.parse(event.status),
    code: event.code,
    message: event.message,
    issues: event.issues ?? [],
    externalListingId: event.externalListingId ?? null,
    externalSubmissionId: event.externalSubmissionId ?? null,
    externalMediaIds: event.externalMediaIds ?? [],
    externalState: event.externalState ?? null,
    retryable: event.retryable,
    actorUserId: context.userId,
  });
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
