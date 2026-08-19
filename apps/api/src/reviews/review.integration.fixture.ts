import { createEntityId, type ReviewDecisionInput, type ReviewRecord, type SubmitReviewInput, type TenantContext } from "@yummyai/contracts";
import type { ListingRecord, ListingVersionRecord } from "../listings/listing.service.js";
import type { ExportJobEnqueuer, ExportPackageRepository, ReviewRepository, ReviewSourceRepository } from "./review.service.js";

export class MemoryIntegrationRepository implements ReviewRepository, ReviewSourceRepository, ExportJobEnqueuer, ExportPackageRepository {
  private reviews: ReviewRecord[] = []; private listing?: ListingRecord; private versions: ListingVersionRecord[] = [];
  constructor(private readonly context: TenantContext) {}
  attach(listing: ListingRecord, version: ListingVersionRecord) { this.listing = listing; if (!this.versions.some((row) => row.id === version.id)) this.versions.push(version); }
  async create(_context: TenantContext, input: SubmitReviewInput) { const record: ReviewRecord = { id: createEntityId(), tenantId: this.context.tenantId, ...input, status: "pending", submittedBy: this.context.userId, submittedAt: new Date().toISOString() }; this.reviews.push(record); return record; }
  async get(_context: TenantContext, id: string) { return this.reviews.find((row) => row.id === id); }
  async decide(_context: TenantContext, id: string, input: ReviewDecisionInput) { const row = (await this.get(this.context, id))!; row.status = input.decision === "approve" ? "approved" : "rejected"; row.decidedBy = this.context.userId; row.decidedAt = new Date().toISOString(); if (input.decision === "reject") row.rejectionReason = input.reason; return row; }
  async invalidateApproved(_context: TenantContext, listingId: string, replacingVersionId: string) { const rows = this.reviews.filter((row) => row.listingId === listingId && row.status === "approved"); for (const row of rows) { row.status = "invalidated"; row.invalidatedByVersionId = replacingVersionId; row.invalidatedAt = new Date().toISOString(); } return rows; }
  async getVersion(_context: TenantContext, listingId: string, versionId: string) { const row = this.versions.find((version) => version.id === versionId && version.listingId === listingId); return row ? { id: row.id, listingId, validationBlockers: row.validation.blockers.map((issue) => issue.path), assets: [{ id: row.content.mainImageId!, version: 1, domain: "authorized" as const, rightsStatus: "approved" as const }] } : undefined; }
  async getLatestVersionId() { return this.versions.at(-1)?.id; }
  async enqueue() { return { jobId: createEntityId() }; }
  async signDownload() { return "https://signed.example/export.zip"; }
}
