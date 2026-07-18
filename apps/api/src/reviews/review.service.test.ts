import { ConflictException } from "@nestjs/common";
import { createEntityId, type ReviewDecisionInput, type ReviewRecord, type SubmitReviewInput, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import {
  AuthorizedAssetsRequiredError,
  ReviewService,
  type ExportJobEnqueuer,
  type ExportPackageRepository,
  type ReviewRepository,
  type ReviewSourceRepository,
  type ReviewableAsset,
} from "./review.service.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };

describe("review service", () => {
  it("requires a rejection reason and supports resubmission", async () => {
    const kit = fixture();
    const first = await kit.service.submit(context, { listingId: kit.listingId, listingVersionId: kit.versionId });
    await expect(kit.service.decide(context, first.id, { decision: "reject" } as never)).rejects.toThrow();
    const rejected = await kit.service.decide(context, first.id, { decision: "reject", reason: "Main image safe area is too narrow" });
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Main image safe area is too narrow" });
    await expect(kit.service.submit(context, { listingId: kit.listingId, listingVersionId: kit.versionId })).resolves.toMatchObject({ status: "pending" });
  });

  it("invalidates approval when a newer field or asset version is saved", async () => {
    const kit = fixture();
    const pending = await kit.service.submit(context, { listingId: kit.listingId, listingVersionId: kit.versionId });
    await kit.service.decide(context, pending.id, { decision: "approve" });
    const replacement = createEntityId();
    kit.source.latest = replacement;
    await kit.service.invalidateListingApprovals(context, kit.listingId, replacement);
    expect(await kit.reviews.get(context, pending.id)).toMatchObject({ status: "invalidated", invalidatedByVersionId: replacement });
    await expect(kit.service.requestExport(context, pending.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses approval and export when any media remains in the research domain", async () => {
    const kit = fixture([{ id: createEntityId(), version: 1, domain: "research", rightsStatus: "unverified" }]);
    const pending = await kit.service.submit(context, { listingId: kit.listingId, listingVersionId: kit.versionId });
    await expect(kit.service.decide(context, pending.id, { decision: "approve" })).rejects.toBeInstanceOf(AuthorizedAssetsRequiredError);
  });

  it("queues an export pinned to the approved Listing version and signs its download", async () => {
    const kit = fixture();
    const pending = await kit.service.submit(context, { listingId: kit.listingId, listingVersionId: kit.versionId });
    await kit.service.decide(context, pending.id, { decision: "approve" });
    const queued = await kit.service.requestExport(context, pending.id);
    expect(kit.enqueuer.payload).toMatchObject({ exportId: queued.exportId, reviewId: pending.id, listingId: kit.listingId, listingVersionId: kit.versionId });
    await expect(kit.service.signDownload(context, queued.exportId)).resolves.toEqual({ url: "https://signed.example/export.zip", expiresInSeconds: 600 });
  });
});

class MemoryReviews implements ReviewRepository {
  records: ReviewRecord[] = [];
  async create(_context: TenantContext, input: SubmitReviewInput) {
    const record: ReviewRecord = { id: createEntityId(), tenantId: context.tenantId, ...input, status: "pending", submittedBy: context.userId, submittedAt: new Date().toISOString() };
    this.records.push(record); return record;
  }
  async get(_context: TenantContext, id: string) { return this.records.find((record) => record.id === id); }
  async decide(_context: TenantContext, id: string, input: ReviewDecisionInput) {
    const record = (await this.get(context, id))!; record.status = input.decision === "approve" ? "approved" : "rejected";
    record.decidedBy = context.userId; record.decidedAt = new Date().toISOString();
    if (input.decision === "reject") record.rejectionReason = input.reason;
    return record;
  }
  async invalidateApproved(_context: TenantContext, listingId: string, replacingVersionId: string) {
    const records = this.records.filter((record) => record.listingId === listingId && record.status === "approved");
    for (const record of records) { record.status = "invalidated"; record.invalidatedAt = new Date().toISOString(); record.invalidatedByVersionId = replacingVersionId; }
    return records;
  }
}

class Source implements ReviewSourceRepository {
  latest: string;
  constructor(readonly listingId: string, readonly versionId: string, readonly assets: readonly ReviewableAsset[]) { this.latest = versionId; }
  async getVersion(_context: TenantContext, listingId: string, versionId: string) {
    return listingId === this.listingId && versionId === this.versionId ? { id: versionId, listingId, validationBlockers: [], assets: this.assets } : undefined;
  }
  async getLatestVersionId() { return this.latest; }
}

class Enqueuer implements ExportJobEnqueuer {
  payload?: Parameters<ExportJobEnqueuer["enqueue"]>[1];
  async enqueue(_context: TenantContext, payload: Parameters<ExportJobEnqueuer["enqueue"]>[1]) { this.payload = payload; return { jobId: createEntityId() }; }
}

function fixture(assets: readonly ReviewableAsset[] = [{ id: createEntityId(), version: 2, domain: "authorized", rightsStatus: "approved" }]) {
  const listingId = createEntityId(); const versionId = createEntityId(); const reviews = new MemoryReviews(); const source = new Source(listingId, versionId, assets); const enqueuer = new Enqueuer();
  const packages: ExportPackageRepository = { signDownload: async () => "https://signed.example/export.zip" };
  return { listingId, versionId, reviews, source, enqueuer, service: new ReviewService(reviews, source, enqueuer, packages) };
}
