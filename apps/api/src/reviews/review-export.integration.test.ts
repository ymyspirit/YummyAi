import { createEntityId, type ListingReplicationView, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { ListingService, type ListingRecord, type ListingRepository, type ListingVersionRecord } from "../listings/listing.service.js";
import type { ListingDraft, ListingPlatform, ListingValidation } from "@yummyai/platform-rules";
import { ReviewService } from "./review.service.js";
import { MemoryIntegrationRepository } from "./review.integration.fixture.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };

describe("review-export integration", () => {
  it("invalidates an approval through the Listing mutation boundary", async () => {
    const reviewRepository = new MemoryIntegrationRepository(context);
    const review = new ReviewService(reviewRepository, reviewRepository, reviewRepository, reviewRepository);
    const listings = new ListingService(new MemoryListings(reviewRepository), review);
    const created = await listings.create(context, { spuId: createEntityId(), platform: "amazon", locale: "en-US", content: draft("Approved title") });
    reviewRepository.attach(created.listing, created.version);
    const submitted = await review.submit(context, { listingId: created.listing.id, listingVersionId: created.version.id });
    await review.decide(context, submitted.id, { decision: "approve" });
    const next = await listings.saveVersion(context, created.listing.id, draft("Changed title"));
    reviewRepository.attach(created.listing, next);
    expect(await reviewRepository.get(context, submitted.id)).toMatchObject({ status: "invalidated", invalidatedByVersionId: next.id });
  });
});

class MemoryListings implements ListingRepository {
  listings: ListingRecord[] = []; versions: ListingVersionRecord[] = [];
  constructor(private readonly bridge: MemoryIntegrationRepository) {}
  async create(_context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId?: string; locale: string; content: ListingDraft; validation: ListingValidation; ruleVersion: string }) {
    const listing: ListingRecord = { id: createEntityId(), tenantId: context.tenantId, spuId: input.spuId, platform: input.platform, marketplaceId: input.marketplaceId, locale: input.locale, status: "draft" };
    const version = this.makeVersion(listing.id, input.content, input.validation, input.ruleVersion); this.listings.push(listing); this.versions.push(version); return { listing, version };
  }
  async get(_context: TenantContext, id: string) { return this.listings.find((row) => row.id === id); }
  async list() { return this.listings; }
  async listVersions(_context: TenantContext, listingId: string) { return this.versions.filter((row) => row.listingId === listingId); }
  async createVersion(_context: TenantContext, listingId: string, input: { content: ListingDraft; validation: ListingValidation; ruleVersion: string; source: "human" | "ai" }) {
    const version = this.makeVersion(listingId, input.content, input.validation, input.ruleVersion, input.source); this.versions.push(version); this.bridge.attach(this.listings[0]!, version); return version;
  }
  async approveVersion(_context: TenantContext, _listingId: string, versionId: string) { const version = this.versions.find((row) => row.id === versionId)!; version.status = "approved"; return version; }
  async findChannel() { return undefined; }
  async createReplica(): Promise<ListingReplicationView> { throw new Error("Not used in review integration test"); }
  async listReplications(): Promise<ListingReplicationView[]> { return []; }
  private makeVersion(listingId: string, content: ListingDraft, validation: ListingValidation, ruleVersion: string, source: "human" | "ai" = "human"): ListingVersionRecord {
    return { id: createEntityId(), tenantId: context.tenantId, listingId, versionNumber: this.versions.length + 1, ruleVersion, status: "draft", source, content, validation, createdAt: new Date() };
  }
}

function draft(title: string): ListingDraft { return { platform: "amazon", locale: "en-US", title, description: "Gift-ready travel mug", bullets: ["Laser engraved"], tags: [], mainImageId: createEntityId(), mediaAssetIds: [], variants: [{ skuId: "sku", skuCode: "MUG", optionValues: {} }], attributes: { brand: "Yummy" }, compliance: { countryOfOrigin: "CN" } }; }
