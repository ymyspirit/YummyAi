import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  ListingReplicationViewSchema,
  createEntityId,
  type CreateListingReplicationInput,
  type ListingReplicationView,
  type TenantContext,
} from "@yummyai/contracts";
import { listingReplications, listingVersions, listings, type DatabaseConnection, withTenant } from "@yummyai/database";
import { amazonRules, etsyRules, validateListing, type ListingDraft, type ListingPlatform, type ListingValidation } from "@yummyai/platform-rules";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { DATABASE_CONNECTION, LISTING_REPOSITORY, MARKETPLACE_AUTOMATION_DISPATCHER, REVIEW_APPROVAL_INVALIDATOR } from "../platform.tokens.js";

export interface ListingApprovalInvalidator {
  invalidateListingApprovals(context: TenantContext, listingId: string, replacingVersionId: string): Promise<void>;
}

export interface MarketplaceAutomationDispatcher {
  dispatchListingApproved(context: TenantContext, listingId: string, listingVersionId: string): Promise<void>;
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const publication = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("amazon"),
    productType: z.string().trim().min(1).max(120).regex(/^[A-Z0-9_]+$/),
    attributes: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    platform: z.literal("etsy"),
    price: z.object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
    quantity: z.number().int().positive().max(999),
    whoMade: z.enum(["i_did", "collective", "someone_else"]),
    whenMade: z.string().trim().min(1).max(120),
    taxonomyId: z.number().int().positive(),
    shippingProfileId: z.number().int().positive(),
    readinessStateId: z.number().int().positive(),
    shopSectionId: z.number().int().positive().optional(),
    isSupply: z.boolean().optional(),
    inventory: z.object({
      products: z.array(z.object({
        sku: z.string().trim().min(1).max(160),
        propertyValues: z.array(z.object({
          propertyId: z.number().int().positive(),
          propertyName: z.string().trim().min(1).max(120),
          scaleId: z.number().int().positive().optional(),
          valueIds: z.array(z.number().int().positive()),
          values: z.array(z.string().trim().min(1).max(200)),
        }).strict()).max(3),
        offerings: z.array(z.object({
          price: z.object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
          quantity: z.number().int().nonnegative().max(999),
          isEnabled: z.boolean(),
          readinessStateId: z.number().int().positive().optional(),
        }).strict()).min(1),
      }).strict()).min(1).max(500),
      priceOnProperty: z.array(z.number().int().positive()).max(3),
      quantityOnProperty: z.array(z.number().int().positive()).max(3),
      skuOnProperty: z.array(z.number().int().positive()).max(3),
      readinessStateOnProperty: z.array(z.number().int().positive()).max(3),
    }).strict().optional(),
  }).strict(),
]);
export const ListingDraftSchema = z.object({
  platform: z.enum(["amazon", "etsy"]), locale: z.string().min(2).max(20), title: z.string(), description: z.string(),
  bullets: z.array(z.string()), tags: z.array(z.string()), mainImageId: z.string().optional(), mediaAssetIds: z.array(z.string()),
  variants: z.array(z.object({ skuId: z.string().min(1), skuCode: z.string().min(1), optionValues: z.record(z.string(), z.string()) })),
  attributes: z.record(z.string(), scalar), compliance: z.record(z.string(), scalar),
  publication: publication.optional(),
  aPlusModules: z.array(z.object({ type: z.string(), assetIds: z.array(z.string()), headline: z.string().optional() })).optional(),
  personalization: z.object({
    enabled: z.boolean(),
    instructions: z.string().optional(),
    required: z.boolean().optional(),
    maxAllowedCharacters: z.number().int().min(1).max(1_024).optional(),
  }).optional(),
});

export interface ListingRecord {
  id: string; tenantId: string; spuId: string; platform: ListingPlatform; marketplaceId?: string; locale: string;
  status: "draft" | "in_review" | "approved" | "archived"; primaryVersionId?: string;
}

export interface ListingVersionRecord {
  id: string; tenantId: string; listingId: string; versionNumber: number; ruleVersion: string;
  status: "draft" | "approved" | "superseded"; source: "human" | "ai";
  content: ListingDraft; validation: ListingValidation; createdAt: Date;
}

export interface ListingRepository {
  create(context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId?: string; locale: string; content: ListingDraft; validation: ListingValidation; ruleVersion: string }): Promise<{ listing: ListingRecord; version: ListingVersionRecord }>;
  get(context: TenantContext, id: string): Promise<ListingRecord | undefined>;
  list(context: TenantContext): Promise<ListingRecord[]>;
  listVersions(context: TenantContext, listingId: string): Promise<ListingVersionRecord[]>;
  createVersion(context: TenantContext, listingId: string, input: { content: ListingDraft; validation: ListingValidation; ruleVersion: string; source: "human" | "ai" }): Promise<ListingVersionRecord>;
  approveVersion(context: TenantContext, listingId: string, versionId: string): Promise<ListingVersionRecord>;
  findChannel(context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId: string; locale: string }): Promise<ListingRecord | undefined>;
  createReplica(context: TenantContext, input: { sourceListingId: string; sourceVersionId: string; spuId: string; platform: ListingPlatform; targetMarketplaceId: string; targetLocale: string; overrides: CreateListingReplicationInput["overrides"]; content: ListingDraft; validation: ListingValidation; ruleVersion: string }): Promise<ListingReplicationView>;
  listReplications(context: TenantContext, listingId: string): Promise<ListingReplicationView[]>;
}

@Injectable()
export class ListingService {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly repository: ListingRepository,
    @Optional() @Inject(REVIEW_APPROVAL_INVALIDATOR) private readonly approvalInvalidator?: ListingApprovalInvalidator,
    @Optional() @Inject(MARKETPLACE_AUTOMATION_DISPATCHER) private readonly automationDispatcher?: MarketplaceAutomationDispatcher,
  ) {}

  async create(context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId?: string; locale: string; content: ListingDraft }) {
    const content = ListingDraftSchema.parse(input.content) as ListingDraft;
    assertChannel(input.platform, input.locale, content);
    const rules = rulesFor(input.platform);
    return this.repository.create(context, { ...input, content, validation: validateListing(rules, content), ruleVersion: rules.version });
  }

  list(context: TenantContext) { return this.repository.list(context); }
  listVersions(context: TenantContext, listingId: string) { return this.repository.listVersions(context, listingId); }

  async getWorkspace(context: TenantContext, listingId: string) {
    const listing = await this.repository.get(context, listingId);
    if (!listing) throw new NotFoundException("Listing not found");
    const history = await this.repository.listVersions(context, listingId);
    const version = history[0];
    if (!version) throw new NotFoundException("Listing version not found");
    return { listing, version, history };
  }

  async saveVersion(context: TenantContext, listingId: string, rawContent: ListingDraft, source: "human" | "ai" = "human") {
    const listing = await this.repository.get(context, listingId);
    if (!listing) throw new NotFoundException("Listing not found");
    const content = ListingDraftSchema.parse(rawContent) as ListingDraft;
    assertChannel(listing.platform, listing.locale, content);
    const rules = rulesFor(listing.platform);
    const version = await this.repository.createVersion(context, listingId, { content, validation: validateListing(rules, content), ruleVersion: rules.version, source });
    await this.approvalInvalidator?.invalidateListingApprovals(context, listingId, version.id);
    return version;
  }

  applyAiSuggestion(context: TenantContext, listingId: string, content: ListingDraft) {
    return this.saveVersion(context, listingId, content, "ai");
  }

  async approveVersion(context: TenantContext, listingId: string, versionId: string) {
    const versions = await this.repository.listVersions(context, listingId);
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) throw new NotFoundException("Listing version not found");
    if (version.status !== "draft") throw new ConflictException("Only draft Listing versions can be approved");
    if (version.validation.blockers.length) throw new ConflictException("Listing has blocking validation issues");
    const approved = await this.repository.approveVersion(context, listingId, versionId);
    await this.automationDispatcher?.dispatchListingApproved(context, listingId, versionId).catch(() => undefined);
    return approved;
  }

  async replicate(context: TenantContext, listingId: string, input: CreateListingReplicationInput) {
    const listing = await this.repository.get(context, listingId);
    if (!listing) throw new NotFoundException("Listing not found");
    const versions = await this.repository.listVersions(context, listingId);
    const source = versions.find((candidate) => candidate.id === input.sourceVersionId);
    if (!source) throw new NotFoundException("Source Listing version not found");
    if (source.status !== "approved" || listing.primaryVersionId !== source.id || listing.status !== "approved") {
      throw new ConflictException("Only the current approved Listing version can be replicated");
    }
    const existing = await this.repository.findChannel(context, {
      spuId: listing.spuId,
      platform: listing.platform,
      marketplaceId: input.targetMarketplaceId,
      locale: input.targetLocale,
    });
    if (existing) throw new ConflictException("Target marketplace and locale already have a Listing");
    const content = ListingDraftSchema.parse({
      ...source.content,
      ...input.overrides,
      locale: input.targetLocale,
      attributes: { ...source.content.attributes, ...input.overrides.attributes },
      compliance: { ...source.content.compliance, ...input.overrides.compliance },
    }) as ListingDraft;
    assertChannel(listing.platform, input.targetLocale, content);
    const rules = rulesFor(listing.platform);
    return this.repository.createReplica(context, {
      sourceListingId: listing.id,
      sourceVersionId: source.id,
      spuId: listing.spuId,
      platform: listing.platform,
      targetMarketplaceId: input.targetMarketplaceId,
      targetLocale: input.targetLocale,
      overrides: input.overrides,
      content,
      validation: validateListing(rules, content),
      ruleVersion: rules.version,
    });
  }

  listReplications(context: TenantContext, listingId: string) {
    return this.repository.listReplications(context, listingId);
  }
}

@Injectable()
export class DrizzleListingRepository implements ListingRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async create(context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId?: string; locale: string; content: ListingDraft; validation: ListingValidation; ruleVersion: string }) {
    const listingId = createEntityId(); const versionId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      await tx.insert(listings).values({ id: listingId, tenantId: context.tenantId, spuId: input.spuId, platform: input.platform, marketplaceId: input.marketplaceId, locale: input.locale, createdBy: context.userId });
      await tx.insert(listingVersions).values({ id: versionId, tenantId: context.tenantId, listingId, versionNumber: 1, ruleVersion: input.ruleVersion, content: input.content, validation: input.validation, createdBy: context.userId });
    });
    return { listing: (await this.get(context, listingId))!, version: (await this.getVersion(context, versionId))! };
  }

  async get(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(listings).where(eq(listings.id, id)).limit(1));
    return row ? mapListing(row) : undefined;
  }

  async list(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(listings).orderBy(desc(listings.updatedAt)));
    return rows.map(mapListing);
  }

  async listVersions(context: TenantContext, listingId: string) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(listingVersions).where(eq(listingVersions.listingId, listingId)).orderBy(desc(listingVersions.versionNumber)));
    return rows.map(mapVersion);
  }

  async createVersion(context: TenantContext, listingId: string, input: { content: ListingDraft; validation: ListingValidation; ruleVersion: string; source: "human" | "ai" }) {
    const id = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      const [latest] = await tx.select({ number: listingVersions.versionNumber }).from(listingVersions).where(eq(listingVersions.listingId, listingId)).orderBy(desc(listingVersions.versionNumber)).limit(1);
      await tx.insert(listingVersions).values({ id, tenantId: context.tenantId, listingId, versionNumber: (latest?.number ?? 0) + 1, ruleVersion: input.ruleVersion, content: input.content, validation: input.validation, source: input.source, createdBy: context.userId });
      await tx.update(listings).set({ status: "draft", updatedAt: new Date() }).where(eq(listings.id, listingId));
    });
    return (await this.getVersion(context, id))!;
  }

  async approveVersion(context: TenantContext, listingId: string, versionId: string) {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.update(listingVersions).set({ status: "approved", approvedBy: context.userId, approvedAt: new Date() }).where(and(eq(listingVersions.id, versionId), eq(listingVersions.status, "draft")));
      await tx.update(listings).set({ status: "approved", primaryVersionId: versionId, updatedAt: new Date() }).where(eq(listings.id, listingId));
    });
    return (await this.getVersion(context, versionId))!;
  }

  async findChannel(context: TenantContext, input: { spuId: string; platform: ListingPlatform; marketplaceId: string; locale: string }) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(listings).where(and(
      eq(listings.spuId, input.spuId),
      eq(listings.platform, input.platform),
      eq(listings.marketplaceId, input.marketplaceId),
      eq(listings.locale, input.locale),
    )).limit(1));
    return row ? mapListing(row) : undefined;
  }

  async createReplica(context: TenantContext, input: { sourceListingId: string; sourceVersionId: string; spuId: string; platform: ListingPlatform; targetMarketplaceId: string; targetLocale: string; overrides: CreateListingReplicationInput["overrides"]; content: ListingDraft; validation: ListingValidation; ruleVersion: string }) {
    const replicationId = createEntityId();
    const targetListingId = createEntityId();
    const targetVersionId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      await tx.insert(listings).values({ id: targetListingId, tenantId: context.tenantId, spuId: input.spuId, platform: input.platform, marketplaceId: input.targetMarketplaceId, locale: input.targetLocale, status: "draft", createdBy: context.userId });
      await tx.insert(listingVersions).values({ id: targetVersionId, tenantId: context.tenantId, listingId: targetListingId, versionNumber: 1, ruleVersion: input.ruleVersion, status: "draft", source: "human", content: input.content, validation: input.validation, createdBy: context.userId });
      await tx.insert(listingReplications).values({ id: replicationId, tenantId: context.tenantId, sourceListingId: input.sourceListingId, sourceVersionId: input.sourceVersionId, targetListingId, targetVersionId, platform: input.platform, targetMarketplaceId: input.targetMarketplaceId, targetLocale: input.targetLocale, overrides: input.overrides, createdBy: context.userId });
    });
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(listingReplications).where(eq(listingReplications.id, replicationId)).limit(1));
    return mapReplication(row!);
  }

  async listReplications(context: TenantContext, listingId: string) {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(listingReplications).where(eq(listingReplications.sourceListingId, listingId)).orderBy(desc(listingReplications.createdAt)));
    return rows.map(mapReplication);
  }

  private async getVersion(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(listingVersions).where(eq(listingVersions.id, id)).limit(1));
    return row ? mapVersion(row) : undefined;
  }
}

function rulesFor(platform: ListingPlatform) { return platform === "amazon" ? amazonRules : etsyRules; }
function assertChannel(platform: ListingPlatform, locale: string, content: ListingDraft) {
  if (content.platform !== platform || content.locale !== locale || (content.publication && content.publication.platform !== platform)) {
    throw new Error("Listing content and publication settings must match its platform and locale");
  }
}
function mapListing(row: typeof listings.$inferSelect): ListingRecord { return { id: row.id, tenantId: row.tenantId, spuId: row.spuId, platform: row.platform as ListingPlatform, marketplaceId: row.marketplaceId ?? undefined, locale: row.locale, status: row.status as ListingRecord["status"], primaryVersionId: row.primaryVersionId ?? undefined }; }
function mapVersion(row: typeof listingVersions.$inferSelect): ListingVersionRecord { return { id: row.id, tenantId: row.tenantId, listingId: row.listingId, versionNumber: row.versionNumber, ruleVersion: row.ruleVersion, status: row.status as ListingVersionRecord["status"], source: row.source as ListingVersionRecord["source"], content: row.content, validation: row.validation, createdAt: row.createdAt }; }
function mapReplication(row: typeof listingReplications.$inferSelect): ListingReplicationView { return ListingReplicationViewSchema.parse({ id: row.id, sourceListingId: row.sourceListingId, sourceVersionId: row.sourceVersionId, targetListingId: row.targetListingId, targetVersionId: row.targetVersionId, platform: row.platform, targetMarketplaceId: row.targetMarketplaceId, targetLocale: row.targetLocale, overrides: row.overrides, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() }); }
