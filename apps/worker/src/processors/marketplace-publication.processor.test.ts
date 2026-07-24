import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import {
  MarketplaceConnectorError,
  type MarketplaceDraftGateway,
  type MarketplaceDraftResult,
} from "@yummyai/marketplace-connectors";
import { describe, expect, it, vi } from "vitest";

import {
  interruptedMutationIsUncertain,
  MarketplacePublicationProcessor,
  type MarketplacePublicationReconciliationScheduler,
  type PublicationExecutionRepository,
  type PublicationExecutionSnapshot,
} from "./marketplace-publication.processor.js";

class FakeRepository implements PublicationExecutionRepository {
  snapshot: PublicationExecutionSnapshot | undefined = publicationSnapshot();
  complete = vi.fn(async () => undefined);
  fail = vi.fn(async () => undefined);
  readMedia = vi.fn(async () => [{
    assetId: "asset-1",
    bytes: Uint8Array.from([1]),
    fileName: "pillow.jpg",
    mediaType: "image/jpeg",
    rank: 1,
  }]);
  withAccountLeaseSpy = vi.fn();

  async withAccountLease<T>(
    context: TenantContext,
    requestId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.withAccountLeaseSpy(context, requestId, operation);
    return operation();
  }

  claim(): Promise<PublicationExecutionSnapshot | undefined> {
    return Promise.resolve(this.snapshot);
  }

  withCredential<T>(
    _context: TenantContext,
    _accountId: string,
    callback: (credential: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    return callback({ refreshToken: "secret" });
  }
}

describe("marketplace publication processor", () => {
  it("records an Amazon validation result returned by the connector", async () => {
    const repository = new FakeRepository();
    const result: MarketplaceDraftResult = {
      externalSubmissionId: "submission-1",
      externalState: "VALID",
      issues: [],
      status: "validation_passed",
      submittedAt: new Date(),
    };
    const gateway = fakeGateway({ create: vi.fn(async () => result) });
    await expect(new MarketplacePublicationProcessor(repository, gateway).process(envelope()))
      .resolves.toMatchObject({ status: "validation_passed" });
    expect(repository.complete).toHaveBeenCalledWith(
      expect.anything(),
      repository.snapshot!.requestId,
      result,
    );
    expect(repository.withAccountLeaseSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(Function),
    );
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records a retry event and rethrows a rate limit while attempts remain", async () => {
    const repository = new FakeRepository();
    const error = new MarketplaceConnectorError("amazon", "rate_limited", "429", 2_000);
    const gateway = fakeGateway({ create: vi.fn(async () => Promise.reject(error)) });
    await expect(new MarketplacePublicationProcessor(repository, gateway).process(envelope()))
      .rejects.toBe(error);
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), repository.snapshot!.requestId, {
      status: "retry_pending",
      code: "PUBLICATION_RATE_LIMITED",
      message: "Marketplace rate limit delayed the publication",
      retryable: true,
      revokeAccount: false,
    });
  });

  it("never retries an Etsy mutation when the external outcome is uncertain", async () => {
    const repository = new FakeRepository();
    repository.snapshot = {
      ...repository.snapshot!,
      platform: "etsy",
      account: { authorizationMode: "etsy_oauth", externalAccountId: "9001", platform: "etsy", region: "GLOBAL" },
      payload: {
        platform: "etsy", marketplaceId: "etsy", locale: "en-US", title: "Pillow", description: "Pillow",
        tags: [], price: { amount: 10, currency: "USD" }, quantity: 1, whoMade: "i_did",
        whenMade: "2020_2026", taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3,
      },
    };
    const error = new MarketplaceConnectorError(
      "etsy",
      "upstream_terminal",
      "response lost",
      undefined,
      true,
    );
    const gateway = fakeGateway({ create: vi.fn(async () => Promise.reject(error)) });
    await expect(new MarketplacePublicationProcessor(repository, gateway).process(envelope()))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), repository.snapshot.requestId, {
      status: "reconciliation_required",
      code: "PUBLICATION_OUTCOME_UNKNOWN",
      message: "Marketplace response was not received; manual reconciliation is required",
      retryable: false,
    });
  });

  it("requires reconciliation when an Etsy draft ID cannot be written back", async () => {
    const repository = new FakeRepository();
    repository.snapshot = etsySnapshot(repository.snapshot!);
    repository.complete.mockRejectedValueOnce(new Error("database unavailable"));
    const created: MarketplaceDraftResult = {
      externalListingId: "456",
      externalState: "draft",
      issues: [],
      status: "draft_created",
      submittedAt: new Date(),
    };
    const gateway = fakeGateway({ create: vi.fn(async () => created) });
    await expect(new MarketplacePublicationProcessor(repository, gateway).process(envelope()))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), repository.snapshot.requestId, {
      status: "reconciliation_required",
      code: "PUBLICATION_WRITEBACK_FAILED",
      message: "Marketplace mutation succeeded but its result could not be recorded; manual reconciliation is required",
      retryable: false,
    });
  });

  it("submits Amazon after a passed preview and records the reconciled published state", async () => {
    const repository = new FakeRepository();
    repository.snapshot = { ...repository.snapshot!, action: "amazon_submit" };
    const submit: MarketplaceDraftResult = {
      externalListingId: "SKU-1",
      externalSubmissionId: "submission-live",
      externalState: "ACCEPTED",
      issues: [],
      status: "submission_accepted",
      submittedAt: new Date(),
    };
    const published: MarketplaceDraftResult = {
      externalListingId: "SKU-1",
      externalState: "BUYABLE",
      issues: [],
      status: "published",
      submittedAt: new Date(),
    };
    const gateway = fakeGateway({
      submit: vi.fn(async () => submit),
      getStatus: vi.fn(async () => published),
    });
    await expect(new MarketplacePublicationProcessor(repository, gateway).process(envelope()))
      .resolves.toMatchObject({ status: "published" });
    expect(gateway.submit).toHaveBeenCalledOnce();
    expect(gateway.getStatus).toHaveBeenCalledWith(expect.anything(), expect.anything(), repository.snapshot.payload, "SKU-1");
    expect(repository.complete).toHaveBeenNthCalledWith(1, expect.anything(), repository.snapshot.requestId, submit);
    expect(repository.complete).toHaveBeenNthCalledWith(2, expect.anything(), repository.snapshot.requestId, published);
  });

  it("schedules bounded background reconciliation after initial status polling is exhausted", async () => {
    const repository = new FakeRepository();
    repository.snapshot = {
      ...repository.snapshot!,
      action: "amazon_submit",
      externalListingId: "SKU-1",
      resumeStatus: "sync_pending",
    };
    const scheduler: MarketplacePublicationReconciliationScheduler = {
      schedule: vi.fn(async () => undefined),
    };
    const gateway = fakeGateway({
      getStatus: vi.fn(async () => ({
        ...result("sync_pending", "PROCESSING"),
        externalListingId: "SKU-1",
      })),
    });
    await expect(new MarketplacePublicationProcessor(repository, gateway, scheduler).process(envelope()))
      .rejects.toThrow("Marketplace publication status is still processing");
    expect(scheduler.schedule).not.toHaveBeenCalled();

    const finalAttempt = { ...envelope(), attempt: 2, maxAttempts: 3 };
    await expect(new MarketplacePublicationProcessor(repository, gateway, scheduler).process(finalAttempt))
      .resolves.toMatchObject({ status: "sync_pending" });
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(scheduler.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: finalAttempt.tenantId, userId: finalAttempt.requestedBy }),
      repository.snapshot.requestId,
    );
  });

  it("requires manual reconciliation when background queue admission fails", async () => {
    const repository = new FakeRepository();
    repository.snapshot = {
      ...repository.snapshot!,
      action: "amazon_submit",
      externalListingId: "SKU-1",
      resumeStatus: "sync_pending",
    };
    const gateway = fakeGateway({
      getStatus: vi.fn(async () => ({
        ...result("sync_pending", "PROCESSING"),
        externalListingId: "SKU-1",
      })),
    });
    const scheduler: MarketplacePublicationReconciliationScheduler = {
      schedule: vi.fn(async () => { throw new Error("redis unavailable"); }),
    };
    await expect(new MarketplacePublicationProcessor(repository, gateway, scheduler).process({ ...envelope(), attempt: 2 }))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), repository.snapshot.requestId, {
      status: "reconciliation_required",
      code: "PUBLICATION_RECONCILIATION_QUEUE_UNAVAILABLE",
      message: "Background marketplace reconciliation could not be scheduled; manual reconciliation is required",
      retryable: false,
    });
  });

  it("configures, uploads, activates, and reconciles an Etsy draft in order", async () => {
    const repository = new FakeRepository();
    repository.snapshot = {
      ...etsySnapshot(repository.snapshot!),
      action: "etsy_activate",
      externalListingId: "456",
    };
    const configured = result("configuration_applied", "configuration_applied");
    const uploaded = { ...result("media_uploaded", "media_uploaded"), externalMediaIds: ["701"] };
    const activated = result("activation_accepted", "active");
    const published = result("published", "active");
    const gateway = fakeGateway({
      configure: vi.fn(async () => configured),
      uploadMedia: vi.fn(async () => uploaded),
      activate: vi.fn(async () => activated),
      getStatus: vi.fn(async () => published),
    });
    await expect(new MarketplacePublicationProcessor(repository, gateway).process(envelope()))
      .resolves.toMatchObject({ status: "published" });
    expect(repository.readMedia).toHaveBeenCalledOnce();
    expect(gateway.configure).toHaveBeenCalledOnce();
    expect(gateway.uploadMedia).toHaveBeenCalledOnce();
    expect(gateway.activate).toHaveBeenCalledOnce();
    expect(gateway.getStatus).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledTimes(4);
  });

  it("resumes Etsy after recorded media upload without uploading duplicate images", async () => {
    const repository = new FakeRepository();
    repository.snapshot = {
      ...etsySnapshot(repository.snapshot!),
      action: "etsy_activate",
      externalListingId: "456",
      resumeStatus: "media_uploaded",
      externalMediaIds: ["701"],
    };
    const gateway = fakeGateway({
      activate: vi.fn(async () => result("activation_accepted", "active")),
      getStatus: vi.fn(async () => result("published", "active")),
    });
    await expect(new MarketplacePublicationProcessor(repository, gateway).process(envelope()))
      .resolves.toMatchObject({ status: "published" });
    expect(repository.readMedia).not.toHaveBeenCalled();
    expect(gateway.configure).not.toHaveBeenCalled();
    expect(gateway.uploadMedia).not.toHaveBeenCalled();
    expect(gateway.activate).toHaveBeenCalledOnce();
  });

  it("only blocks an Etsy retry when a mutation was in flight without a recorded result", () => {
    expect(interruptedMutationIsUncertain("etsy_activate", "processing", "configuration_applied")).toBe(true);
    expect(interruptedMutationIsUncertain("etsy_activate", "processing", "media_uploaded")).toBe(true);
    expect(interruptedMutationIsUncertain("etsy_activate", "processing", "activation_accepted")).toBe(false);
    expect(interruptedMutationIsUncertain("etsy_activate", "configuration_applied", "configuration_applied")).toBe(false);
    expect(interruptedMutationIsUncertain("etsy_activate", "media_uploaded", "media_uploaded")).toBe(false);
  });
});

function publicationSnapshot(): PublicationExecutionSnapshot {
  return {
    requestId: createEntityId(),
    accountId: createEntityId(),
    action: "amazon_validation_preview",
    platform: "amazon",
    assetManifest: [],
    externalMediaIds: [],
    account: { authorizationMode: "amazon_private", externalAccountId: "A1SELLER", platform: "amazon", region: "NA" },
    payload: {
      platform: "amazon",
      marketplaceId: "ATVPDKIKX0DER",
      locale: "en-US",
      productType: "HOME",
      sku: "SKU-1",
      attributes: {},
    },
  };
}

function etsySnapshot(snapshot: PublicationExecutionSnapshot): PublicationExecutionSnapshot {
  return {
    ...snapshot,
    action: "etsy_create_draft",
    platform: "etsy",
    account: { authorizationMode: "etsy_oauth", externalAccountId: "9001", platform: "etsy", region: "GLOBAL" },
    payload: {
      platform: "etsy", marketplaceId: "etsy", locale: "en-US", title: "Pillow", description: "Pillow",
      tags: [], price: { amount: 10, currency: "USD" }, quantity: 1, whoMade: "i_did",
      whenMade: "2020_2026", taxonomyId: 1, shippingProfileId: 2, readinessStateId: 3,
    },
  };
}

function result(status: MarketplaceDraftResult["status"], externalState: string): MarketplaceDraftResult {
  return { externalListingId: "456", externalState, issues: [], status, submittedAt: new Date() };
}

function fakeGateway(overrides: Partial<MarketplaceDraftGateway>): MarketplaceDraftGateway {
  const unsupported = async () => { throw new Error("Unexpected gateway operation"); };
  return {
    create: vi.fn(unsupported),
    submit: vi.fn(unsupported),
    configure: vi.fn(unsupported),
    uploadMedia: vi.fn(unsupported),
    activate: vi.fn(unsupported),
    getStatus: vi.fn(unsupported),
    readOnlineListing: vi.fn(unsupported),
    updateOnlineListingPriceInventory: vi.fn(unsupported),
    updateOnlineListingContent: vi.fn(unsupported),
    ...overrides,
  };
}

function envelope(): JobEnvelope {
  const requestId = createEntityId();
  return {
    jobId: createEntityId(),
    tenantId: createEntityId(),
    requestedBy: createEntityId(),
    traceId: createTraceId(),
    correlationId: requestId,
    idempotencyKey: requestId,
    requestedAt: new Date().toISOString(),
    attempt: 0,
    maxAttempts: 3,
    payload: { publicationRequestId: requestId },
  };
}
