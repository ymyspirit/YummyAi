import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  ReviewDecisionInputSchema,
  SubmitReviewInputSchema,
  createEntityId,
  type ReviewDecisionInput,
  type ReviewRecord,
  type SubmitReviewInput,
  type TenantContext,
} from "@yummyai/contracts";
import type { ExportJobPayload } from "@yummyai/jobs";

import { AuditService } from "../audit/audit.service.js";
import type { ListingApprovalInvalidator } from "../listings/listing.service.js";
import {
  EXPORT_JOB_ENQUEUER,
  EXPORT_PACKAGE_REPOSITORY,
  REVIEW_REPOSITORY,
  REVIEW_SOURCE_REPOSITORY,
} from "../platform.tokens.js";

export interface ReviewableAsset {
  id: string;
  version: number;
  domain: "research" | "authorized";
  rightsStatus: "unverified" | "approved" | "rejected";
}

export interface ReviewableListingVersion {
  id: string;
  listingId: string;
  validationBlockers: readonly string[];
  assets: readonly ReviewableAsset[];
}

export interface ReviewSourceRepository {
  getVersion(context: TenantContext, listingId: string, versionId: string): Promise<ReviewableListingVersion | undefined>;
  getLatestVersionId(context: TenantContext, listingId: string): Promise<string | undefined>;
}

export interface ReviewRepository {
  create(context: TenantContext, input: SubmitReviewInput): Promise<ReviewRecord>;
  get(context: TenantContext, id: string): Promise<ReviewRecord | undefined>;
  decide(context: TenantContext, id: string, input: ReviewDecisionInput): Promise<ReviewRecord>;
  invalidateApproved(context: TenantContext, listingId: string, replacingVersionId: string): Promise<readonly ReviewRecord[]>;
}

export interface ExportJobEnqueuer {
  enqueue(context: TenantContext, payload: ExportJobPayload): Promise<{ jobId: string }>;
}

export interface ExportPackageRepository {
  signDownload(context: TenantContext, exportId: string): Promise<string | undefined>;
}

export class AuthorizedAssetsRequiredError extends ConflictException {
  constructor(readonly assetIds: readonly string[]) {
    super(`All exported assets require authorized-domain files and approved rights: ${assetIds.join(", ")}`);
  }
}

@Injectable()
export class ReviewService implements ListingApprovalInvalidator {
  constructor(
    @Inject(REVIEW_REPOSITORY) private readonly reviews: ReviewRepository,
    @Inject(REVIEW_SOURCE_REPOSITORY) private readonly source: ReviewSourceRepository,
    @Inject(EXPORT_JOB_ENQUEUER) private readonly exports: ExportJobEnqueuer,
    @Inject(EXPORT_PACKAGE_REPOSITORY) private readonly packages: ExportPackageRepository,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  async submit(context: TenantContext, rawInput: SubmitReviewInput) {
    const input = SubmitReviewInputSchema.parse(rawInput);
    const version = await this.source.getVersion(context, input.listingId, input.listingVersionId);
    if (!version) throw new NotFoundException("Listing version not found");
    if (version.validationBlockers.length) throw new ConflictException("Listing has blocking validation issues");
    const latest = await this.source.getLatestVersionId(context, input.listingId);
    if (latest !== input.listingVersionId) throw new ConflictException("Only the latest Listing version can be submitted");
    const review = await this.reviews.create(context, input);
    await this.record(context, "listing.review.submit", review.id, { listingId: input.listingId, listingVersionId: input.listingVersionId });
    return review;
  }

  async decide(context: TenantContext, reviewId: string, rawInput: ReviewDecisionInput) {
    const input = ReviewDecisionInputSchema.parse(rawInput);
    const review = await this.requirePending(context, reviewId);
    if (input.decision === "approve") {
      const latest = await this.source.getLatestVersionId(context, review.listingId);
      if (latest !== review.listingVersionId) throw new ConflictException("Listing changed after review submission");
      const version = await this.source.getVersion(context, review.listingId, review.listingVersionId);
      if (!version) throw new NotFoundException("Listing version not found");
      assertAuthorized(version.assets);
    }
    const decided = await this.reviews.decide(context, reviewId, input);
    await this.record(context, `listing.review.${input.decision}`, reviewId, input.decision === "reject" ? { reason: input.reason } : undefined);
    return decided;
  }

  async invalidateListingApprovals(context: TenantContext, listingId: string, replacingVersionId: string) {
    const invalidated = await this.reviews.invalidateApproved(context, listingId, replacingVersionId);
    await Promise.all(invalidated.map((review) => this.record(context, "listing.review.invalidate", review.id, { replacingVersionId })));
  }

  async requestExport(context: TenantContext, reviewId: string) {
    const review = await this.reviews.get(context, reviewId);
    if (!review) throw new NotFoundException("Review not found");
    if (review.status !== "approved") throw new ConflictException("A current approval is required before export");
    const latest = await this.source.getLatestVersionId(context, review.listingId);
    if (latest !== review.listingVersionId) throw new ConflictException("Approval was invalidated by a newer Listing version");
    const version = await this.source.getVersion(context, review.listingId, review.listingVersionId);
    if (!version) throw new NotFoundException("Listing version not found");
    assertAuthorized(version.assets);
    const exportId = createEntityId();
    const queued = await this.exports.enqueue(context, { exportId, reviewId, listingId: review.listingId, listingVersionId: review.listingVersionId });
    await this.record(context, "listing.export.request", exportId, { reviewId, jobId: queued.jobId, listingVersionId: review.listingVersionId });
    return { exportId, jobId: queued.jobId, status: "queued" as const };
  }

  async signDownload(context: TenantContext, exportId: string) {
    const url = await this.packages.signDownload(context, exportId);
    if (!url) throw new NotFoundException("Export package not found");
    await this.record(context, "listing.export.download", exportId);
    return { url, expiresInSeconds: 600 };
  }

  private async requirePending(context: TenantContext, id: string) {
    const review = await this.reviews.get(context, id);
    if (!review) throw new NotFoundException("Review not found");
    if (review.status !== "pending") throw new ConflictException("Only pending reviews can be decided");
    return review;
  }

  private async record(context: TenantContext, action: string, resourceId: string, metadata?: Record<string, unknown>) {
    await this.audit?.record(context, { action, resourceType: action.startsWith("listing.export") ? "listing_export" : "listing_review", resourceId, result: "success", metadata });
  }
}

function assertAuthorized(assets: readonly ReviewableAsset[]) {
  const invalid = assets.filter((asset) => asset.domain !== "authorized" || asset.rightsStatus !== "approved").map((asset) => asset.id);
  if (invalid.length) throw new AuthorizedAssetsRequiredError(invalid);
}
