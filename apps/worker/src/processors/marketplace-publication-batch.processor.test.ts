import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz";
import { PublicationAuthorityError } from "@yummyai/catalog-core";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import {
  MarketplaceConnectorError,
  HttpMarketplaceDraftGateway,
  type AmazonListingsFeedResult,
  type MarketplaceFeedGateway,
} from "@yummyai/marketplace-connectors";
import { describe, expect, it, vi } from "vitest";

import {
  classifyAmazonFeedReport,
  MarketplacePublicationBatchProcessor,
  type PublicationBatchExecutionRepository,
  type PublicationBatchExecutionSnapshot,
} from "./marketplace-publication-batch.processor.js";

class FakeBatchRepository implements PublicationBatchExecutionRepository {
  snapshot: PublicationBatchExecutionSnapshot | undefined = batchSnapshot();
  beforeProviderRequest?: PublicationBatchExecutionRepository["beforeProviderRequest"];
  credentialContexts: TenantContext[] = [];
  credentialSnapshots: Array<PublicationBatchExecutionSnapshot | undefined> = [];
  complete = vi.fn(async () => ({
    reconciliationRequestIds: this.snapshot!.items.map((item) => item.requestId),
    status: "submitted" as const,
  }));
  fail = vi.fn(async () => undefined);
  recordPending = vi.fn(async () => undefined);
  recordSubmission = vi.fn(async () => undefined);

  claim(): Promise<PublicationBatchExecutionSnapshot | undefined> {
    return Promise.resolve(this.snapshot);
  }

  async withAccountLease<T>(
    _context: TenantContext,
    _batchId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  }

  withCredential<T>(
    context: TenantContext,
    _accountId: string,
    callback: (credential: Readonly<Record<string, string>>) => Promise<T>,
    snapshot?: PublicationBatchExecutionSnapshot,
  ): Promise<T> {
    this.credentialContexts.push(context);
    this.credentialSnapshots.push(snapshot);
    return callback({ refreshToken: "secret", clientId: "synthetic-client", clientSecret: "synthetic-secret", sellingPartnerId: "A1SELLER" });
  }
}

describe("marketplace publication batch processor", () => {
  it("submits one Amazon JSON Feed and schedules accepted items for reconciliation", async () => {
    const repository = new FakeBatchRepository();
    const gateway = fakeGateway({
      submitAmazonListingsFeed: vi.fn(async () => ({ feedDocumentId: "doc-1", feedId: "feed-1" })),
      getAmazonListingsFeed: vi.fn(async () => completedResult()),
    });
    const reconciliation = { schedule: vi.fn(async () => undefined) };

    await expect(new MarketplacePublicationBatchProcessor(repository, gateway, reconciliation).process(envelope()))
      .resolves.toEqual({ batchId: repository.snapshot!.batchId, status: "submitted" });

    expect(gateway.submitAmazonListingsFeed).toHaveBeenCalledWith(
      repository.snapshot!.account,
      expect.anything(),
      repository.snapshot!.marketplaceId,
      repository.snapshot!.items.map((item) => item.message),
    );
    expect(repository.recordSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ feedId: "feed-1" }),
      expect.objectContaining({ feedId: "feed-1" }),
    );
    expect(reconciliation.schedule).toHaveBeenCalledTimes(2);
  });

  it("retries a known Feed that is still processing without submitting it again", async () => {
    const repository = new FakeBatchRepository();
    repository.snapshot = { ...repository.snapshot!, feedId: "feed-known" };
    const gateway = fakeGateway({
      getAmazonListingsFeed: vi.fn(async (): Promise<AmazonListingsFeedResult> => ({
        feedId: "feed-known",
        issues: [],
        processingStatus: "IN_PROGRESS",
      })),
    });

    await expect(new MarketplacePublicationBatchProcessor(
      repository,
      gateway,
      { schedule: vi.fn(async () => undefined) },
    ).process(envelope())).rejects.toThrow("still processing");

    expect(gateway.submitAmazonListingsFeed).not.toHaveBeenCalled();
    expect(repository.recordPending).toHaveBeenCalledOnce();
    expect(repository.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ feedId: "feed-known" }),
      expect.objectContaining({ status: "retry_pending", retryable: true }),
    );
  });

  it("does not replay Feed creation when the provider outcome is unknown", async () => {
    const repository = new FakeBatchRepository();
    const error = new MarketplaceConnectorError("amazon", "upstream_terminal", "response lost", undefined, true);
    const gateway = fakeGateway({ submitAmazonListingsFeed: vi.fn(async () => Promise.reject(error)) });

    await expect(new MarketplacePublicationBatchProcessor(
      repository,
      gateway,
      { schedule: vi.fn(async () => undefined) },
    ).process(envelope())).resolves.toMatchObject({ status: "reconciliation_required" });

    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), repository.snapshot, {
      status: "reconciliation_required",
      code: "AMAZON_FEED_OUTCOME_UNKNOWN",
      message: "Amazon Feed creation outcome is unknown and cannot be replayed safely",
      retryable: false,
    });
  });

  it("records manual reconciliation when a created Feed ID cannot be written back", async () => {
    const repository = new FakeBatchRepository();
    repository.recordSubmission.mockRejectedValueOnce(new Error("database unavailable"));
    const gateway = fakeGateway({
      submitAmazonListingsFeed: vi.fn(async () => ({ feedDocumentId: "doc-1", feedId: "feed-1" })),
    });

    await expect(new MarketplacePublicationBatchProcessor(
      repository,
      gateway,
      { schedule: vi.fn(async () => undefined) },
    ).process(envelope())).resolves.toMatchObject({ status: "reconciliation_required" });

    expect(repository.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ feedId: "feed-1" }),
      expect.objectContaining({ code: "AMAZON_FEED_WRITEBACK_FAILED", retryable: false }),
    );
    expect(gateway.getAmazonListingsFeed).not.toHaveBeenCalled();
  });

  it("requires manual reconciliation when an accepted Feed item cannot be queued for status reads", async () => {
    const repository = new FakeBatchRepository();
    const gateway = fakeGateway({
      submitAmazonListingsFeed: vi.fn(async () => ({ feedDocumentId: "doc-1", feedId: "feed-1" })),
      getAmazonListingsFeed: vi.fn(async () => completedResult()),
    });
    const reconciliation = {
      schedule: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("redis unavailable")),
    };

    await expect(new MarketplacePublicationBatchProcessor(repository, gateway, reconciliation).process(envelope()))
      .resolves.toMatchObject({ status: "reconciliation_required" });

    expect(repository.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ feedId: "feed-1" }),
      expect.objectContaining({
        code: "AMAZON_FEED_RECONCILIATION_QUEUE_UNAVAILABLE",
        requestIds: [repository.snapshot!.items[1]!.requestId],
        retryable: false,
      }),
    );
  });
});

describe("original batch authority at every provider boundary", () => {
  it("fails closed before credential access when a guarded repository has an unguarded gateway", async () => {
    const repository = new FakeBatchRepository(), gateway = fakeGateway({}), reconciliation = { schedule: vi.fn(async () => undefined) };
    repository.beforeProviderRequest = vi.fn(async () => undefined);
    await expect(new MarketplacePublicationBatchProcessor(repository, gateway, reconciliation).process(envelope()))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    expect(repository.credentialContexts).toHaveLength(0);
    expect(gateway.submitAmazonListingsFeed).not.toHaveBeenCalled();
    expect(gateway.getAmazonListingsFeed).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), repository.snapshot,
      expect.objectContaining({ code: "PUBLICATION_AUTHORITY_CHANGED", retryable: false }));
  });

  it("guards all eight original HTTP calls including Feed document upload and report download, under the saved authority", async () => {
    const repository = new FakeBatchRepository(), trace: string[] = [], job = envelope();
    const authority: TenantContext = { tenantId: job.tenantId, userId: job.requestedBy,
      permissions: [Permission.ListingPublish, Permission.ListingRead, Permission.StoreRead], dataScope: "self" };
    repository.snapshot = { ...repository.snapshot!, authority };
    repository.beforeProviderRequest = vi.fn(async (current, snapshot) => {
      expect(current).toBe(authority);
      expect(snapshot.batchId).toBe(repository.snapshot!.batchId);
      trace.push("authority");
    });
    const reconciliation = { schedule: vi.fn(async () => undefined) };
    await expect(new MarketplacePublicationBatchProcessor(repository, originalFeedGateway(trace), reconciliation).process(job))
      .resolves.toMatchObject({ status: "submitted" });
    expect(trace).toEqual([
      "authority", "POST /auth/o2/token", "authority", "POST /feeds/2021-06-30/documents",
      "authority", "PUT /upload", "authority", "POST /feeds/2021-06-30/feeds",
      "authority", "POST /auth/o2/token", "authority", "GET /feeds/2021-06-30/feeds/feed-1",
      "authority", "GET /feeds/2021-06-30/documents/report-1", "authority", "GET /report",
    ]);
    expect(repository.credentialContexts).toEqual([authority, authority]);
    expect(repository.credentialSnapshots).toEqual([repository.snapshot, { ...repository.snapshot, feedId: "feed-1" }]);
    expect(repository.recordSubmission).toHaveBeenCalledWith(authority, expect.objectContaining({ feedId: "feed-1" }), expect.anything());
    expect(repository.complete).toHaveBeenCalledWith(authority, expect.objectContaining({ feedId: "feed-1" }), expect.anything());
    expect(reconciliation.schedule).toHaveBeenCalledTimes(2);
  });

  it.each([
    { denyAt: 2, reached: ["POST /auth/o2/token"] },
    { denyAt: 3, reached: ["POST /auth/o2/token", "POST /feeds/2021-06-30/documents"] },
    { denyAt: 8, reached: ["POST /auth/o2/token", "POST /feeds/2021-06-30/documents", "PUT /upload", "POST /feeds/2021-06-30/feeds",
      "POST /auth/o2/token", "GET /feeds/2021-06-30/feeds/feed-1", "GET /feeds/2021-06-30/documents/report-1"] },
  ])("does not issue HTTP or retry after authority is withdrawn at original request $denyAt", async ({ denyAt, reached }) => {
    const repository = new FakeBatchRepository(), trace: string[] = []; let checked = 0;
    repository.beforeProviderRequest = vi.fn(async () => {
      if (++checked === denyAt) throw new PublicationAuthorityError();
    });
    const reconciliation = { schedule: vi.fn(async () => undefined) };
    await expect(new MarketplacePublicationBatchProcessor(repository, originalFeedGateway(trace), reconciliation).process(envelope()))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    expect(trace).toEqual(reached);
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.recordPending).not.toHaveBeenCalled();
    expect(reconciliation.schedule).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ code: "PUBLICATION_AUTHORITY_CHANGED", retryable: false }));
    if (denyAt === 8) expect(repository.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ feedId: "feed-1" }), expect.anything());
  });

  it("does not adopt a received report or schedule follow-up work after final authority rejection", async () => {
    const repository = new FakeBatchRepository();
    repository.complete.mockRejectedValueOnce(new PublicationAuthorityError());
    const gateway = fakeGateway({ submitAmazonListingsFeed: vi.fn(async () => ({ feedDocumentId: "doc-1", feedId: "feed-1" })),
      getAmazonListingsFeed: vi.fn(async () => completedResult()) });
    const reconciliation = { schedule: vi.fn(async () => undefined) };
    await expect(new MarketplacePublicationBatchProcessor(repository, gateway, reconciliation).process(envelope()))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    expect(gateway.submitAmazonListingsFeed).toHaveBeenCalledOnce();
    expect(gateway.getAmazonListingsFeed).toHaveBeenCalledOnce();
    expect(reconciliation.schedule).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ feedId: "feed-1" }),
      expect.objectContaining({ code: "PUBLICATION_AUTHORITY_CHANGED", retryable: false }));
  });

  it("keeps an original known Feed and stops retries when its pending-result write loses authority", async () => {
    const repository = new FakeBatchRepository();
    repository.snapshot = { ...repository.snapshot!, feedId: "feed-known" };
    repository.recordPending.mockRejectedValueOnce(new PublicationAuthorityError());
    const gateway = fakeGateway({ getAmazonListingsFeed: vi.fn(async (): Promise<AmazonListingsFeedResult> => ({ feedId: "feed-known", issues: [], processingStatus: "IN_PROGRESS" })) });
    await expect(new MarketplacePublicationBatchProcessor(repository, gateway, { schedule: vi.fn(async () => undefined) }).process(envelope()))
      .resolves.toMatchObject({ status: "reconciliation_required" });
    expect(gateway.submitAmazonListingsFeed).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ feedId: "feed-known" }),
      expect.objectContaining({ code: "PUBLICATION_AUTHORITY_CHANGED", retryable: false }));
  });
});

describe("Amazon Feed report classification", () => {
  it("maps a rejected message by stable messageId and accepts the other item", () => {
    const snapshot = batchSnapshot();
    const decision = classifyAmazonFeedReport(snapshot, {
      ...completedResult(),
      issues: [{ messageId: 2, issue: { code: "90220", message: "Brand is invalid", path: "brand", severity: "blocker" } }],
      summary: { errors: 1, messagesAccepted: 1, messagesProcessed: 2, warnings: 0 },
    }, snapshot.items.map((item) => item.requestId));

    expect(decision.status).toBe("partial");
    expect(decision.items).toEqual([
      expect.objectContaining({ requestId: snapshot.items[0]!.requestId, outcome: "accepted" }),
      expect.objectContaining({ requestId: snapshot.items[1]!.requestId, outcome: "failed" }),
    ]);
  });

  it("requires reconciliation for an incomplete or unmappable processing report", () => {
    const snapshot = batchSnapshot();
    const decision = classifyAmazonFeedReport(snapshot, {
      ...completedResult(),
      issues: [{ messageId: 99, issue: { code: "UNKNOWN_MESSAGE", message: "Unknown report item", severity: "warning" } }],
      summary: { errors: 0, messagesAccepted: 1, messagesProcessed: 1, warnings: 1 },
    }, snapshot.items.map((item) => item.requestId));

    expect(decision.status).toBe("reconciliation_required");
    expect(decision.items.every((item) => item.outcome === "reconciliation_required")).toBe(true);
  });
});

function batchSnapshot(): PublicationBatchExecutionSnapshot {
  return {
    account: {
      authorizationMode: "amazon_private",
      externalAccountId: "A1SELLER",
      platform: "amazon",
      region: "NA",
    },
    accountId: createEntityId(),
    batchId: createEntityId(),
    expectedMessageCount: 2,
    items: [
      { requestId: createEntityId(), message: { attributes: {}, messageId: 1, productType: "HOME", sku: "SKU-1" } },
      { requestId: createEntityId(), message: { attributes: {}, messageId: 2, productType: "HOME", sku: "SKU-2" } },
    ],
    marketplaceId: "ATVPDKIKX0DER",
  };
}

function completedResult(): AmazonListingsFeedResult {
  return {
    feedId: "feed-1",
    issues: [],
    processingStatus: "DONE",
    summary: { errors: 0, messagesAccepted: 2, messagesProcessed: 2, warnings: 0 },
  };
}

function fakeGateway(overrides: Partial<MarketplaceFeedGateway>): MarketplaceFeedGateway {
  const unsupported = async () => { throw new Error("Unexpected Feed gateway operation"); };
  return {
    submitAmazonListingsFeed: vi.fn(unsupported),
    getAmazonListingsFeed: vi.fn(unsupported),
    ...overrides,
  };
}

/** The original HTTP gateway and parsers run unchanged; only external transport is synthetic. */
function originalFeedGateway(trace: string[]): MarketplaceFeedGateway {
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const request: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw)), method = init?.method ?? "GET";
    trace.push(`${method} ${url.pathname}`);
    if (url.pathname === "/auth/o2/token") return json({ access_token: "synthetic-access", expires_in: 3600 });
    if (url.pathname === "/feeds/2021-06-30/documents" && method === "POST") return json({ feedDocumentId: "doc-1", url: "https://synthetic-documents.invalid/upload" });
    if (url.pathname === "/upload" && method === "PUT") return new Response(null, { status: 200 });
    if (url.pathname === "/feeds/2021-06-30/feeds" && method === "POST") return json({ feedId: "feed-1" });
    if (url.pathname === "/feeds/2021-06-30/feeds/feed-1") return json({ feedId: "feed-1", processingStatus: "DONE", resultFeedDocumentId: "report-1" });
    if (url.pathname === "/feeds/2021-06-30/documents/report-1") return json({ feedDocumentId: "report-1", url: "https://synthetic-documents.invalid/report" });
    if (url.pathname === "/report") return json({ issues: [], summary: completedResult().summary });
    throw new Error("Unexpected synthetic original Feed HTTP");
  };
  return new HttpMarketplaceDraftGateway(request, {});
}

function envelope(): JobEnvelope {
  const batchId = createEntityId();
  return {
    jobId: createEntityId(),
    tenantId: createEntityId(),
    requestedBy: createEntityId(),
    traceId: createTraceId(),
    correlationId: batchId,
    idempotencyKey: batchId,
    requestedAt: new Date().toISOString(),
    attempt: 0,
    maxAttempts: 3,
    payload: { publicationBatchId: batchId },
  };
}
