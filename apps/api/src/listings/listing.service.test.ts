import { ConflictException } from "@nestjs/common";
import { createEntityId, type ListingReplicationView, type TenantContext } from "@yummyai/contracts";
import type { ListingDraft, ListingPlatform, ListingValidation } from "@yummyai/platform-rules";
import { describe, expect, it, vi } from "vitest";

import { ListingService, type ListingRecord, type ListingRepository, type ListingVersionRecord } from "./listing.service.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };

describe("listing service", () => {
  it("blocks approval when Amazon title and main image are missing", async () => {
    const repository = new MemoryListingRepository(); const service = new ListingService(repository);
    const created = await service.create(context, { spuId: createEntityId(), platform: "amazon", locale: "en-US", content: amazon({ title: "", mainImageId: undefined }) });
    expect(created.version.validation.blockers.map((issue) => issue.path)).toEqual(expect.arrayContaining(["title", "mainImageId"]));
    await expect(service.approveVersion(context, created.listing.id, created.version.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it("creates an AI draft version without overwriting approved content", async () => {
    const repository = new MemoryListingRepository(); const service = new ListingService(repository);
    const created = await service.create(context, { spuId: createEntityId(), platform: "amazon", locale: "en-US", content: amazon({}) });
    await service.approveVersion(context, created.listing.id, created.version.id);
    const originalTitle = created.version.content.title;
    const next = await service.applyAiSuggestion(context, created.listing.id, amazon({ title: "AI suggested title" }));
    expect(next.id).not.toBe(created.version.id);
    expect(next.source).toBe("ai");
    expect(created.version.content.title).toBe(originalTitle);
    expect(created.version.status).toBe("approved");
  });

  it("pins Etsy rule versions and validates tags and personalization", async () => {
    const repository = new MemoryListingRepository(); const service = new ListingService(repository);
    const created = await service.create(context, { spuId: createEntityId(), platform: "etsy", locale: "en-US", content: etsy({ tags: Array.from({ length: 14 }, (_, index) => `tag-${index}`), personalization: { enabled: true } }) });
    expect(created.version.ruleVersion).toMatch(/^etsy-/);
    expect(created.version.validation.blockers.map((issue) => issue.path)).toEqual(expect.arrayContaining(["tags", "personalization.instructions"]));
  });

  it("preserves variant mapping and computes full completeness", async () => {
    const repository = new MemoryListingRepository(); const service = new ListingService(repository);
    const created = await service.create(context, { spuId: createEntityId(), platform: "amazon", locale: "en-US", content: amazon({}) });
    expect(created.version.validation.completeness).toBe(100);
    expect(created.version.content.variants[0]).toMatchObject({ skuCode: "MUG-NVY", optionValues: { color: "navy" } });
  });

  it("replicates only the current approved version into a new draft channel", async () => {
    const repository = new MemoryListingRepository(); const service = new ListingService(repository);
    const created = await service.create(context, { spuId: createEntityId(), platform: "amazon", marketplaceId: "A1", locale: "en-US", content: amazon({}) });
    await service.approveVersion(context, created.listing.id, created.version.id);
    const replica = await service.replicate(context, created.listing.id, { sourceVersionId: created.version.id, targetMarketplaceId: "A2", targetLocale: "en-GB", overrides: { title: "UK travel mug" } });
    expect(replica).toMatchObject({ sourceVersionId: created.version.id, targetMarketplaceId: "A2", targetLocale: "en-GB" });
    expect(repository.listings.find((listing) => listing.id === replica.targetListingId)).toMatchObject({ status: "draft", marketplaceId: "A2", locale: "en-GB" });
    expect(repository.versions.find((version) => version.id === replica.targetVersionId)).toMatchObject({ status: "draft", content: { title: "UK travel mug", locale: "en-GB" } });
  });

  it("dispatches approval automation without rolling back an approved version when a rule fails", async () => {
    const repository = new MemoryListingRepository();
    const dispatchListingApproved = vi.fn(async () => { throw new Error("Rule preflight failed"); });
    const service = new ListingService(repository, undefined, { dispatchListingApproved });
    const created = await service.create(context, { spuId: createEntityId(), platform: "amazon", marketplaceId: "A1", locale: "en-US", content: amazon({}) });
    await expect(service.approveVersion(context, created.listing.id, created.version.id)).resolves.toMatchObject({ status: "approved" });
    expect(dispatchListingApproved).toHaveBeenCalledWith(context, created.listing.id, created.version.id);
    expect(repository.listings[0]).toMatchObject({ status: "approved", primaryVersionId: created.version.id });
  });
});

class MemoryListingRepository implements ListingRepository {
  listings: ListingRecord[] = []; versions: ListingVersionRecord[] = []; replications: ListingReplicationView[] = [];
  async create(_context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId?: string; locale: string; content: ListingDraft; validation: ListingValidation; ruleVersion: string }) {
    const listing: ListingRecord = { id: createEntityId(), tenantId: context.tenantId, spuId: input.spuId, platform: input.platform, marketplaceId: input.marketplaceId, locale: input.locale, status: "draft" };
    const version = this.version(listing.id, input.content, input.validation, input.ruleVersion, "human");
    this.listings.push(listing); this.versions.push(version); return { listing, version };
  }
  async get(_context: TenantContext, id: string) { return this.listings.find((listing) => listing.id === id); }
  async list() { return this.listings; }
  async listVersions(_context: TenantContext, listingId: string) { return this.versions.filter((version) => version.listingId === listingId); }
  async createVersion(_context: TenantContext, listingId: string, input: { content: ListingDraft; validation: ListingValidation; ruleVersion: string; source: "human" | "ai" }) {
    const version = this.version(listingId, input.content, input.validation, input.ruleVersion, input.source); this.versions.push(version); return version;
  }
  async approveVersion(_context: TenantContext, listingId: string, versionId: string) {
    const version = this.versions.find((candidate) => candidate.id === versionId)!; version.status = "approved";
    const listing = this.listings.find((candidate) => candidate.id === listingId)!; listing.status = "approved"; listing.primaryVersionId = versionId; return version;
  }
  async findChannel(_context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId: string; locale: string }) { return this.listings.find((listing) => listing.spuId === input.spuId && listing.platform === input.platform && listing.marketplaceId === input.marketplaceId && listing.locale === input.locale); }
  async createReplica(_context: TenantContext, input: { sourceListingId: string; sourceVersionId: string; spuId: string; platform: ListingPlatform; targetMarketplaceId: string; targetLocale: string; overrides: Record<string, unknown>; content: ListingDraft; validation: ListingValidation; ruleVersion: string }) {
    const listing: ListingRecord = { id: createEntityId(), tenantId: context.tenantId, spuId: input.spuId, platform: input.platform, marketplaceId: input.targetMarketplaceId, locale: input.targetLocale, status: "draft" };
    const version = this.version(listing.id, input.content, input.validation, input.ruleVersion, "human");
    const replication: ListingReplicationView = { id: createEntityId(), sourceListingId: input.sourceListingId, sourceVersionId: input.sourceVersionId, targetListingId: listing.id, targetVersionId: version.id, platform: input.platform, targetMarketplaceId: input.targetMarketplaceId, targetLocale: input.targetLocale, overrides: input.overrides, createdBy: context.userId, createdAt: new Date().toISOString() } as ListingReplicationView;
    this.listings.push(listing); this.versions.push(version); this.replications.push(replication); return replication;
  }
  async listReplications(_context: TenantContext, listingId: string) { return this.replications.filter((replication) => replication.sourceListingId === listingId); }
  private version(listingId: string, content: ListingDraft, validation: ListingValidation, ruleVersion: string, source: "human" | "ai"): ListingVersionRecord {
    return { id: createEntityId(), tenantId: context.tenantId, listingId, versionNumber: this.versions.filter((version) => version.listingId === listingId).length + 1, ruleVersion, status: "draft", source, content: structuredClone(content), validation, createdAt: new Date() };
  }
}

function amazon(patch: Partial<ListingDraft>): ListingDraft { return { platform: "amazon", locale: "en-US", title: "Personalized travel mug", description: "Gift ready", bullets: ["Laser engraved"], tags: [], mainImageId: "asset-main", mediaAssetIds: ["asset-main"], variants: [{ skuId: "sku-1", skuCode: "MUG-NVY", optionValues: { color: "navy" } }], attributes: { brand: "Yummy" }, compliance: { countryOfOrigin: "CN" }, aPlusModules: [{ type: "standard", assetIds: ["asset-main"] }], ...patch }; }
function etsy(patch: Partial<ListingDraft>): ListingDraft { return { platform: "etsy", locale: "en-US", title: "Personalized travel mug", description: "Gift ready", bullets: [], tags: ["travel mug"], mainImageId: "asset-main", mediaAssetIds: ["asset-main"], variants: [{ skuId: "sku-1", skuCode: "MUG-NVY", optionValues: { color: "navy" } }], attributes: {}, compliance: {}, ...patch }; }
