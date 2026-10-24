import { ConflictException,Inject,Injectable,NotFoundException,Optional } from "@nestjs/common";
import { Permission,authorize } from "@yummyai/authz";
import { DrizzleListingReadRepository,ListingDraftSchema,ListingReadOwner,assertCatalogListingAccess,assertCatalogSpuAccess,catalogOwnerFilter,currentCatalogContext,type ListingAccessPermission,type ListingCatalogItem,type ListingCatalogQuery,type ListingRecord,type ListingVersionRecord } from "@yummyai/catalog-core";
import {
ListingReplicationViewSchema,
createEntityId,
type CreateListingReplicationInput,
type ListingReplicationView,
type TenantContext,
} from "@yummyai/contracts";
import {
listingReplications,
listingVersions,
listings,
type DatabaseConnection,
type TenantTransaction
} from "@yummyai/database";
import {
amazonRules,
etsyRules,
validateListing,
type ListingDraft,
type ListingPlatform,
type ListingValidation,
} from "@yummyai/platform-rules";
import { and,desc,eq,isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withCatalogTenant } from "../catalog/catalog-access.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";

import {
DATABASE_CONNECTION,
LISTING_REPOSITORY,
MARKETPLACE_AUTOMATION_DISPATCHER,
REVIEW_APPROVAL_INVALIDATOR,
} from "../platform.tokens.js";

export interface ListingApprovalInvalidator {
  invalidateListingApprovals(
    context: TenantContext,
    listingId: string,
    replacingVersionId: string,
  ): Promise<void>;
}

export interface MarketplaceAutomationDispatcher {
  dispatchListingApproved(
    context: TenantContext,
    listingId: string,
    listingVersionId: string,
  ): Promise<void>;
}

export { ListingCatalogQuerySchema,ListingDraftSchema } from "@yummyai/catalog-core";
export type { ListingAccessPermission,ListingCatalogItem,ListingCatalogQuery,ListingRecord,ListingVersionRecord } from "@yummyai/catalog-core";
export interface ListingRepository {
  workspace?(
    context: TenantContext,
    id: string,
  ): Promise<{
    listing: ListingRecord;
    version: ListingVersionRecord;
    history: ListingVersionRecord[];
  }>;
  create(
    context: TenantContext,
    input: {
      spuId: string;
      styleId?: string;
      platform: ListingPlatform;
      marketplaceId?: string;
      locale: string;
      content: ListingDraft;
      validation: ListingValidation;
      ruleVersion: string;
    },
  ): Promise<{ listing: ListingRecord; version: ListingVersionRecord }>;
  get(
    context: TenantContext,
    id: string,
    permission?: ListingAccessPermission,
  ): Promise<ListingRecord | undefined>;
  list(context: TenantContext): Promise<ListingRecord[]>;
  archive?(context: TenantContext, id: string): Promise<void>;
  listCatalog(context: TenantContext): Promise<ListingCatalogItem[]>;
  listVersions(
    context: TenantContext,
    listingId: string,
    permission?: ListingAccessPermission,
  ): Promise<ListingVersionRecord[]>;
  createVersion(
    context: TenantContext,
    listingId: string,
    input: {
      content: ListingDraft;
      validation: ListingValidation;
      ruleVersion: string;
      source: "human" | "ai";
      expectedVersionId?: string;
    },
  ): Promise<ListingVersionRecord>;
  approveVersion(
    context: TenantContext,
    listingId: string,
    versionId: string,
  ): Promise<ListingVersionRecord>;
  findChannel(
    context: TenantContext,
    input: {
      spuId: string;
      styleId?: string;
      salesPlanId?: string;
      platform: ListingPlatform;
      marketplaceId: string;
      locale: string;
    },
  ): Promise<ListingRecord | undefined>;
  createReplica(
    context: TenantContext,
    input: {
      sourceListingId: string;
      sourceVersionId: string;
      spuId: string;
      styleId?: string;
      salesPlanId?: string;
      salesPlanRevision?: number;
      platform: ListingPlatform;
      targetMarketplaceId: string;
      targetLocale: string;
      overrides: CreateListingReplicationInput["overrides"];
      content: ListingDraft;
      validation: ListingValidation;
      ruleVersion: string;
    },
  ): Promise<ListingReplicationView>;
  listReplications(context: TenantContext, listingId: string): Promise<ListingReplicationView[]>;
}

@Injectable()
export class ListingService {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly repository: ListingRepository,
    @Optional()
    @Inject(REVIEW_APPROVAL_INVALIDATOR)
    private readonly approvalInvalidator?: ListingApprovalInvalidator,
    @Optional()
    @Inject(MARKETPLACE_AUTOMATION_DISPATCHER)
    private readonly automationDispatcher?: MarketplaceAutomationDispatcher,
  ) {}

  async create(
    context: TenantContext,
    input: {
      spuId: string;
      styleId?: string;
      platform: ListingPlatform;
      marketplaceId?: string;
      locale: string;
      content: ListingDraft;
    },
  ) {
    authorize(context, Permission.ListingWrite);
    authorize(context, Permission.ProductRead);
    const content = ListingDraftSchema.parse(input.content) as ListingDraft;
    assertChannel(input.platform, input.locale, content);
    const rules = rulesFor(input.platform);
    return this.repository.create(context, {
      ...input,
      content,
      validation: validateListing(rules, content),
      ruleVersion: rules.version,
    });
  }

  async createDevelopmentDraft(
    tx: TenantTransaction,
    context: TenantContext,
    input: {
      spuId: string;
      styleId?: string;
      salesPlanId?: string;
      salesPlanRevision?: number;
      platform: ListingPlatform;
      marketplaceId: string;
      locale: string;
      content: ListingDraft;
    },
  ) {
    context = await currentCatalogContext(tx, context);
    authorize(context, Permission.ListingWrite);
    await assertCatalogSpuAccess(tx, context, input.spuId, [Permission.ProductRead], true);
    const content = ListingDraftSchema.parse(input.content) as ListingDraft;
    assertChannel(input.platform, input.locale, content);
    const rules = rulesFor(input.platform),
      id = createEntityId(),
      versionId = createEntityId();
    await tx.insert(listings).values({
      id,
      tenantId: context.tenantId,
      spuId: input.spuId,
      styleId: input.styleId,
      salesPlanId: input.salesPlanId,
      salesPlanRevision: input.salesPlanRevision,
      platform: input.platform,
      marketplaceId: input.marketplaceId,
      locale: input.locale,
      createdBy: context.userId,
    });
    await tx.insert(listingVersions).values({
      id: versionId,
      tenantId: context.tenantId,
      listingId: id,
      versionNumber: 1,
      ruleVersion: rules.version,
      content,
      validation: validateListing(rules, content),
      createdBy: context.userId,
    });
    return { listingId: id, listingVersionId: versionId };
  }

  async reviseSalesPlanDraft(
    tx: TenantTransaction,
    context: TenantContext,
    input: {
      listingId: string;
      expectedVersionId: string;
      planRevision: number;
      styleId?: string;
      content: ListingDraft;
    },
  ) {
    context = await currentCatalogContext(tx, context);
    const listing = await assertCatalogListingAccess(
      tx,
      context,
      input.listingId,
      [Permission.ListingWrite],
      true,
    );
    if (!listing?.salesPlanId) throw new NotFoundException("销售方案刊登不存在");
    const [previous] = await tx
      .select()
      .from(listingVersions)
      .where(eq(listingVersions.listingId, listing.id))
      .orderBy(desc(listingVersions.versionNumber))
      .limit(1);
    if (listing.status !== "draft" || previous?.status !== "draft")
      throw new ConflictException("已进入审核的刊登请在刊登编辑器创建修订，原审核版本继续保留");
    if (previous.id !== input.expectedVersionId)
      throw new ConflictException("刊登内容已有新版本，请刷新后核对再同步");
    const previousPublication = previous.content.publication;
    if (
      previousPublication?.platform === "amazon" &&
      input.content.publication?.platform === "amazon" &&
      previousPublication.productType !== input.content.publication.productType
    ) {
      throw new ConflictException("刊登已有类目属性，更换商品类型请在刊登编辑器核对后修订");
    }
    const content = ListingDraftSchema.parse({
      ...input.content,
      attributes: { ...previous.content.attributes, ...input.content.attributes },
      compliance: { ...previous.content.compliance, ...input.content.compliance },
      publication:
        previousPublication?.platform === "amazon" &&
        input.content.publication?.platform === "amazon"
          ? {
              ...input.content.publication,
              attributes: {
                ...previousPublication.attributes,
                ...input.content.publication.attributes,
              },
            }
          : (input.content.publication ?? previousPublication),
      ...(previous.content.aPlusModules ? { aPlusModules: previous.content.aPlusModules } : {}),
      ...(previous.content.personalization
        ? { personalization: previous.content.personalization }
        : {}),
      mediaDescriptions: Object.fromEntries(
        Object.entries(previous.content.mediaDescriptions ?? {}).filter(([id]) =>
          input.content.mediaAssetIds.includes(id),
        ),
      ),
    }) as ListingDraft;
    assertChannel(listing.platform as ListingPlatform, listing.locale, content);
    const rules = rulesFor(listing.platform as ListingPlatform),
      versionId = createEntityId();
    await tx.insert(listingVersions).values({
      id: versionId,
      tenantId: context.tenantId,
      listingId: listing.id,
      versionNumber: previous.versionNumber + 1,
      ruleVersion: rules.version,
      content,
      validation: validateListing(rules, content),
      createdBy: context.userId,
    });
    await tx
      .update(listings)
      .set({
        salesPlanRevision: input.planRevision,
        styleId: input.styleId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(listings.id, listing.id));
    return { listingId: listing.id, listingVersionId: versionId };
  }

  list(context: TenantContext) {
    authorize(context, Permission.ListingRead);
    return this.repository.list(context);
  }
  async archive(context: TenantContext, id: string) {
    authorize(context, Permission.ListingWrite);
    if (!this.repository.archive) throw new ConflictException("刊登归档服务不可用");
    await this.repository.archive(context, id);
    return { archived: true };
  }
  async catalog(context:TenantContext,rawQuery:ListingCatalogQuery){return originalOwnerOperation(()=>new ListingReadOwner(this.repository).catalog(context,rawQuery));}
  listVersions(context:TenantContext,listingId:string){return originalOwnerOperation(()=>new ListingReadOwner(this.repository).listVersions(context,listingId));}

  async getWorkspace(context:TenantContext,listingId:string){return originalOwnerOperation(()=>new ListingReadOwner(this.repository).getWorkspace(context,listingId));}

  async saveVersion(
    context: TenantContext,
    listingId: string,
    rawContent: ListingDraft,
    source: "human" | "ai" = "human",
    expectedVersionId?: string,
  ) {
    authorize(context, Permission.ListingWrite);
    const listing = await this.repository.get(context, listingId, Permission.ListingWrite);
    if (!listing) throw new NotFoundException("Listing not found");
    authorize(context, Permission.ListingWrite, { ownerId: listing.ownerUserId });
    const content = ListingDraftSchema.parse(rawContent) as ListingDraft;
    assertChannel(listing.platform, listing.locale, content);
    const rules = rulesFor(listing.platform);
    const version = await this.repository.createVersion(context, listingId, {
      content,
      validation: validateListing(rules, content),
      ruleVersion: rules.version,
      source,
      ...(expectedVersionId ? { expectedVersionId } : {}),
    });
    await this.approvalInvalidator?.invalidateListingApprovals(context, listingId, version.id);
    return version;
  }

  applyAiSuggestion(context: TenantContext, listingId: string, content: ListingDraft) {
    return this.saveVersion(context, listingId, content, "ai");
  }

  async approveVersion(context: TenantContext, listingId: string, versionId: string) {
    authorize(context, Permission.ListingReview);
    const listing = await this.repository.get(context, listingId, Permission.ListingReview);
    if (!listing) throw new NotFoundException("Listing not found");
    authorize(context, Permission.ListingReview, { ownerId: listing.ownerUserId });
    const versions = await this.repository.listVersions(
      context,
      listingId,
      Permission.ListingReview,
    );
    const version = versions.find((candidate) => candidate.id === versionId);
    if (!version) throw new NotFoundException("Listing version not found");
    if (version.status !== "draft")
      throw new ConflictException("Only draft Listing versions can be approved");
    if (version.validation.blockers.length)
      throw new ConflictException("Listing has blocking validation issues");
    const approved = await this.repository.approveVersion(context, listingId, versionId);
    await this.automationDispatcher
      ?.dispatchListingApproved(context, listingId, versionId)
      .catch(() => undefined);
    return approved;
  }

  async replicate(context: TenantContext, listingId: string, input: CreateListingReplicationInput) {
    authorize(context, Permission.ListingRead);
    authorize(context, Permission.ListingWrite);
    const listing = await this.repository.get(context, listingId);
    if (!listing) throw new NotFoundException("Listing not found");
    const versions = await this.repository.listVersions(context, listingId);
    const source = versions.find((candidate) => candidate.id === input.sourceVersionId);
    if (!source) throw new NotFoundException("Source Listing version not found");
    if (
      source.status !== "approved" ||
      listing.primaryVersionId !== source.id ||
      listing.status !== "approved"
    ) {
      throw new ConflictException("Only the current approved Listing version can be replicated");
    }
    const existing = await this.repository.findChannel(context, {
      spuId: listing.spuId,
      styleId: listing.styleId,
      salesPlanId: listing.salesPlanId,
      platform: listing.platform,
      marketplaceId: input.targetMarketplaceId,
      locale: input.targetLocale,
    });
    if (existing)
      throw new ConflictException("Target marketplace and locale already have a Listing");
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
      styleId: listing.styleId,
      salesPlanId: listing.salesPlanId,
      salesPlanRevision: listing.salesPlanRevision,
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
    authorize(context, Permission.ListingRead);
    return this.repository.listReplications(context, listingId);
  }
}

@Injectable()
export class DrizzleListingRepository implements ListingRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async create(
    context: TenantContext,
    input: {
      spuId: string;
      styleId?: string;
      platform: ListingPlatform;
      marketplaceId?: string;
      locale: string;
      content: ListingDraft;
      validation: ListingValidation;
      ruleVersion: string;
    },
  ) {
    const listingId = createEntityId();
    const versionId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      authorize(context, Permission.ListingWrite);
      await assertCatalogSpuAccess(tx, context, input.spuId, [Permission.ProductRead], true);
      await tx.insert(listings).values({
        id: listingId,
        tenantId: context.tenantId,
        spuId: input.spuId,
        styleId: input.styleId,
        platform: input.platform,
        marketplaceId: input.marketplaceId,
        locale: input.locale,
        createdBy: context.userId,
      });
      await tx.insert(listingVersions).values({
        id: versionId,
        tenantId: context.tenantId,
        listingId,
        versionNumber: 1,
        ruleVersion: input.ruleVersion,
        content: input.content,
        validation: input.validation,
        createdBy: context.userId,
      });
    });
    return {
      listing: (await this.get(context, listingId, Permission.ListingWrite))!,
      version: (await this.getVersion(context, versionId, Permission.ListingWrite))!,
    };
  }

  async get(
    context: TenantContext,
    id: string,
    permission: ListingAccessPermission = Permission.ListingRead,
  ) {return originalOwnerOperation(()=>new DrizzleListingReadRepository(this.database).get(context,id,permission));}

  async list(context: TenantContext) {return originalOwnerOperation(()=>new DrizzleListingReadRepository(this.database).list(context));}
  async archive(context: TenantContext, id: string) {
    await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await assertCatalogListingAccess(tx, context, id, [Permission.ListingWrite], true);
      const [row] = await tx
        .update(listings)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(listings.id, id))
        .returning({ id: listings.id });
      if (!row) throw new NotFoundException("刊登不存在");
    });
  }

  async listCatalog(context: TenantContext) {return originalOwnerOperation(()=>new DrizzleListingReadRepository(this.database).listCatalog(context));}

  async workspace(context: TenantContext, id: string) {return originalOwnerOperation(()=>new DrizzleListingReadRepository(this.database).workspace(context,id));}

  async listVersions(
    context: TenantContext,
    listingId: string,
    permission: ListingAccessPermission = Permission.ListingRead,
  ) {return originalOwnerOperation(()=>new DrizzleListingReadRepository(this.database).listVersions(context,listingId,permission));}

  async createVersion(
    context: TenantContext,
    listingId: string,
    input: {
      content: ListingDraft;
      validation: ListingValidation;
      ruleVersion: string;
      source: "human" | "ai";
      expectedVersionId?: string;
    },
  ) {
    const id = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const listing = await assertCatalogListingAccess(
        tx,
        context,
        listingId,
        [Permission.ListingWrite],
        true,
      );
      if (listing.status === "archived") throw new ConflictException("Listing 已归档");
      const [latest] = await tx
        .select({ id: listingVersions.id, number: listingVersions.versionNumber })
        .from(listingVersions)
        .where(eq(listingVersions.listingId, listingId))
        .orderBy(desc(listingVersions.versionNumber))
        .limit(1);
      if (input.expectedVersionId && latest?.id !== input.expectedVersionId)
        throw new ConflictException("Listing 已有新版本，请刷新后合并改动再保存");
      await tx.insert(listingVersions).values({
        id,
        tenantId: context.tenantId,
        listingId,
        versionNumber: (latest?.number ?? 0) + 1,
        ruleVersion: input.ruleVersion,
        content: input.content,
        validation: input.validation,
        source: input.source,
        createdBy: context.userId,
      });
      await tx
        .update(listings)
        .set({ status: "draft", updatedAt: new Date() })
        .where(eq(listings.id, listingId));
    });
    return (await this.getVersion(context, id, Permission.ListingWrite))!;
  }

  async approveVersion(context: TenantContext, listingId: string, versionId: string) {
    await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const listing = await assertCatalogListingAccess(
        tx,
        context,
        listingId,
        [Permission.ListingReview],
        true,
      );
      if (listing.status === "archived") throw new ConflictException("Listing 已归档");
      const [latest] = await tx
        .select()
        .from(listingVersions)
        .where(eq(listingVersions.listingId, listingId))
        .orderBy(desc(listingVersions.versionNumber))
        .limit(1);
      if (!latest || latest.id !== versionId)
        throw new ConflictException("Listing 已有新版本 请核对当前版本后审核");
      if (latest.status !== "draft" || latest.validation.blockers.length)
        throw new ConflictException("当前刊登版本不可批准 请核对状态和阻断项");
      await tx
        .update(listingVersions)
        .set({ status: "approved", approvedBy: context.userId, approvedAt: new Date() })
        .where(
          and(
            eq(listingVersions.id, versionId),
            eq(listingVersions.listingId, listingId),
            eq(listingVersions.status, "draft"),
          ),
        );
      await tx
        .update(listings)
        .set({ status: "approved", primaryVersionId: versionId, updatedAt: new Date() })
        .where(eq(listings.id, listingId));
    });
    return (await this.getVersion(context, versionId, Permission.ListingReview))!;
  }

  async findChannel(
    context: TenantContext,
    input: {
      spuId: string;
      styleId?: string;
      salesPlanId?: string;
      platform: ListingPlatform;
      marketplaceId: string;
      locale: string;
    },
  ) {
    const [row] = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      return tx
        .select()
        .from(listings)
        .where(
          and(
            eq(listings.spuId, input.spuId),
            input.styleId ? eq(listings.styleId, input.styleId) : isNull(listings.styleId),
            input.salesPlanId
              ? eq(listings.salesPlanId, input.salesPlanId)
              : isNull(listings.salesPlanId),
            eq(listings.platform, input.platform),
            eq(listings.marketplaceId, input.marketplaceId),
            eq(listings.locale, input.locale),
            catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy),
          ),
        )
        .limit(1);
    });
    return row ? mapListing(row) : undefined;
  }

  async createReplica(
    context: TenantContext,
    input: {
      sourceListingId: string;
      sourceVersionId: string;
      spuId: string;
      styleId?: string;
      salesPlanId?: string;
      salesPlanRevision?: number;
      platform: ListingPlatform;
      targetMarketplaceId: string;
      targetLocale: string;
      overrides: CreateListingReplicationInput["overrides"];
      content: ListingDraft;
      validation: ListingValidation;
      ruleVersion: string;
    },
  ) {
    const replicationId = createEntityId();
    const targetListingId = createEntityId();
    const targetVersionId = createEntityId();
    let saved: typeof listingReplications.$inferSelect | undefined;
    await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      authorize(context, Permission.ListingWrite);
      await assertCatalogSpuAccess(tx, context, input.spuId, [Permission.ProductRead], true);
      const source = await assertCatalogListingAccess(
        tx,
        context,
        input.sourceListingId,
        [Permission.ListingRead],
        true,
      );
      const [version] = await tx
        .select()
        .from(listingVersions)
        .where(
          and(
            eq(listingVersions.id, input.sourceVersionId),
            eq(listingVersions.listingId, source.id),
          ),
        );
      if (
        !version ||
        source.spuId !== input.spuId ||
        (source.styleId ?? undefined) !== input.styleId ||
        (source.salesPlanId ?? undefined) !== input.salesPlanId ||
        source.platform !== input.platform
      )
        throw new NotFoundException("复制来源不存在或不可访问");
      if (
        source.status !== "approved" ||
        source.primaryVersionId !== version.id ||
        version.status !== "approved"
      )
        throw new ConflictException("来源审核版本已变化 请重新核对后复制");
      await tx.insert(listings).values({
        id: targetListingId,
        tenantId: context.tenantId,
        spuId: input.spuId,
        styleId: input.styleId,
        salesPlanId: input.salesPlanId,
        salesPlanRevision: input.salesPlanRevision,
        platform: input.platform,
        marketplaceId: input.targetMarketplaceId,
        locale: input.targetLocale,
        status: "draft",
        createdBy: context.userId,
      });
      await tx.insert(listingVersions).values({
        id: targetVersionId,
        tenantId: context.tenantId,
        listingId: targetListingId,
        versionNumber: 1,
        ruleVersion: input.ruleVersion,
        status: "draft",
        source: "human",
        content: input.content,
        validation: input.validation,
        createdBy: context.userId,
      });
      [saved] = await tx
        .insert(listingReplications)
        .values({
          id: replicationId,
          tenantId: context.tenantId,
          sourceListingId: input.sourceListingId,
          sourceVersionId: input.sourceVersionId,
          targetListingId,
          targetVersionId,
          platform: input.platform,
          targetMarketplaceId: input.targetMarketplaceId,
          targetLocale: input.targetLocale,
          overrides: input.overrides,
          createdBy: context.userId,
        })
        .returning();
    });
    return mapReplication(saved!);
  }

  async listReplications(context: TenantContext, listingId: string) {
    const rows = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await assertCatalogListingAccess(tx, context, listingId, [Permission.ListingRead]);
      const target = alias(listings, "replication_target");
      return tx
        .select({ replication: listingReplications })
        .from(listingReplications)
        .innerJoin(target, eq(target.id, listingReplications.targetListingId))
        .where(
          and(
            eq(listingReplications.sourceListingId, listingId),
            catalogOwnerFilter(context, Permission.ListingRead, target.createdBy),
          ),
        )
        .orderBy(desc(listingReplications.createdAt));
    });
    return rows.map((row) => mapReplication(row.replication));
  }

  private async getVersion(
    context: TenantContext,
    id: string,
    permission: ListingAccessPermission = Permission.ListingRead,
  ) {
    const [row] = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      authorize(context, permission);
      const [version] = await tx
        .select()
        .from(listingVersions)
        .where(eq(listingVersions.id, id))
        .limit(1);
      if (!version) return [];
      await assertCatalogListingAccess(tx, context, version.listingId, [permission]);
      return [version];
    });
    return row ? mapVersion(row) : undefined;
  }
}

async function withTenant<T>(
  database: DatabaseConnection["db"],
  context: TenantContext,
  operation: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withCatalogTenant(database, context, operation);
  } catch (error) {
    const value = error as { code?: string; cause?: { code?: string } };
    if ((value.code ?? value.cause?.code) === "23505")
      throw new ConflictException("目标渠道已存在或不可用 请核对后重试");
    throw error;
  }
}

function rulesFor(platform: ListingPlatform) {
  return platform === "amazon" ? amazonRules : etsyRules;
}
function assertChannel(platform: ListingPlatform, locale: string, content: ListingDraft) {
  if (
    content.platform !== platform ||
    content.locale !== locale ||
    (content.publication && content.publication.platform !== platform)
  ) {
    throw new Error("Listing content and publication settings must match its platform and locale");
  }
}
function mapListing(row: typeof listings.$inferSelect): ListingRecord {
  return {
    ...(row.createdBy ? { ownerUserId: row.createdBy } : {}),
    id: row.id,
    tenantId: row.tenantId,
    spuId: row.spuId,
    styleId: row.styleId ?? undefined,
    salesPlanId: row.salesPlanId ?? undefined,
    salesPlanRevision: row.salesPlanRevision ?? undefined,
    platform: row.platform as ListingPlatform,
    marketplaceId: row.marketplaceId ?? undefined,
    locale: row.locale,
    status: row.status as ListingRecord["status"],
    primaryVersionId: row.primaryVersionId ?? undefined,
  };
}
function mapVersion(row: typeof listingVersions.$inferSelect): ListingVersionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    listingId: row.listingId,
    versionNumber: row.versionNumber,
    ruleVersion: row.ruleVersion,
    status: row.status as ListingVersionRecord["status"],
    source: row.source as ListingVersionRecord["source"],
    content: row.content,
    validation: row.validation,
    createdAt: row.createdAt,
  };
}
function mapReplication(row: typeof listingReplications.$inferSelect): ListingReplicationView {
  return ListingReplicationViewSchema.parse({
    id: row.id,
    sourceListingId: row.sourceListingId,
    sourceVersionId: row.sourceVersionId,
    targetListingId: row.targetListingId,
    targetVersionId: row.targetVersionId,
    platform: row.platform,
    targetMarketplaceId: row.targetMarketplaceId,
    targetLocale: row.targetLocale,
    overrides: row.overrides,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });
}
