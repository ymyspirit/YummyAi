import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { listingVersions, listings, type DatabaseConnection, withTenant } from "@yummyai/database";
import { amazonRules, etsyRules, validateListing, type ListingDraft, type ListingPlatform, type ListingValidation } from "@yummyai/platform-rules";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { DATABASE_CONNECTION, LISTING_REPOSITORY } from "../platform.tokens.js";

const scalar = z.union([z.string(), z.number(), z.boolean()]);
export const ListingDraftSchema = z.object({
  platform: z.enum(["amazon", "etsy"]), locale: z.string().min(2).max(20), title: z.string(), description: z.string(),
  bullets: z.array(z.string()), tags: z.array(z.string()), mainImageId: z.string().optional(), mediaAssetIds: z.array(z.string()),
  variants: z.array(z.object({ skuId: z.string().min(1), skuCode: z.string().min(1), optionValues: z.record(z.string(), z.string()) })),
  attributes: z.record(z.string(), scalar), compliance: z.record(z.string(), scalar),
  aPlusModules: z.array(z.object({ type: z.string(), assetIds: z.array(z.string()), headline: z.string().optional() })).optional(),
  personalization: z.object({ enabled: z.boolean(), instructions: z.string().optional(), required: z.boolean().optional() }).optional(),
});

export interface ListingRecord {
  id: string; tenantId: string; spuId: string; platform: ListingPlatform; locale: string;
  status: "draft" | "in_review" | "approved" | "archived"; primaryVersionId?: string;
}

export interface ListingVersionRecord {
  id: string; tenantId: string; listingId: string; versionNumber: number; ruleVersion: string;
  status: "draft" | "approved" | "superseded"; source: "human" | "ai";
  content: ListingDraft; validation: ListingValidation; createdAt: Date;
}

export interface ListingRepository {
  create(context: TenantContext, input: { spuId: string; platform: ListingPlatform; locale: string; content: ListingDraft; validation: ListingValidation; ruleVersion: string }): Promise<{ listing: ListingRecord; version: ListingVersionRecord }>;
  get(context: TenantContext, id: string): Promise<ListingRecord | undefined>;
  list(context: TenantContext): Promise<ListingRecord[]>;
  listVersions(context: TenantContext, listingId: string): Promise<ListingVersionRecord[]>;
  createVersion(context: TenantContext, listingId: string, input: { content: ListingDraft; validation: ListingValidation; ruleVersion: string; source: "human" | "ai" }): Promise<ListingVersionRecord>;
  approveVersion(context: TenantContext, listingId: string, versionId: string): Promise<ListingVersionRecord>;
}

@Injectable()
export class ListingService {
  constructor(@Inject(LISTING_REPOSITORY) private readonly repository: ListingRepository) {}

  async create(context: TenantContext, input: { spuId: string; platform: ListingPlatform; locale: string; content: ListingDraft }) {
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
    return this.repository.createVersion(context, listingId, { content, validation: validateListing(rules, content), ruleVersion: rules.version, source });
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
    return this.repository.approveVersion(context, listingId, versionId);
  }
}

@Injectable()
export class DrizzleListingRepository implements ListingRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async create(context: TenantContext, input: { spuId: string; platform: ListingPlatform; locale: string; content: ListingDraft; validation: ListingValidation; ruleVersion: string }) {
    const listingId = createEntityId(); const versionId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      await tx.insert(listings).values({ id: listingId, tenantId: context.tenantId, spuId: input.spuId, platform: input.platform, locale: input.locale, createdBy: context.userId });
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

  private async getVersion(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(listingVersions).where(eq(listingVersions.id, id)).limit(1));
    return row ? mapVersion(row) : undefined;
  }
}

function rulesFor(platform: ListingPlatform) { return platform === "amazon" ? amazonRules : etsyRules; }
function assertChannel(platform: ListingPlatform, locale: string, content: ListingDraft) { if (content.platform !== platform || content.locale !== locale) throw new Error("Listing content must match its platform and locale"); }
function mapListing(row: typeof listings.$inferSelect): ListingRecord { return { id: row.id, tenantId: row.tenantId, spuId: row.spuId, platform: row.platform as ListingPlatform, locale: row.locale, status: row.status as ListingRecord["status"], primaryVersionId: row.primaryVersionId ?? undefined }; }
function mapVersion(row: typeof listingVersions.$inferSelect): ListingVersionRecord { return { id: row.id, tenantId: row.tenantId, listingId: row.listingId, versionNumber: row.versionNumber, ruleVersion: row.ruleVersion, status: row.status as ListingVersionRecord["status"], source: row.source as ListingVersionRecord["source"], content: row.content, validation: row.validation, createdAt: row.createdAt }; }
