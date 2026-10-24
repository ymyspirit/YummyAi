import { authorize,Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { listings,listingVersions,productPlans,spus,type DatabaseConnection } from "@yummyai/database";
import type { ListingPlatform } from "@yummyai/platform-rules";
import { and,desc,eq,sql } from "drizzle-orm";
import { assertCatalogListingAccess,catalogOwnerFilter,catalogPlanFilter,currentCatalogContext } from "./access.js";
import { withCatalogReadTenant as catalogTenant } from "./development-read-data.js";
import { ListingCatalogQuerySchema,type ListingAccessPermission,type ListingCatalogItem,type ListingCatalogQuery,type ListingRecord,type ListingVersionRecord } from "./listing-read-contracts.js";
export interface ListingReadRepository {
workspace?(context:TenantContext,id:string):Promise<{listing:ListingRecord;version:ListingVersionRecord;history:ListingVersionRecord[]}>;
get(context:TenantContext,id:string,permission?:ListingAccessPermission):Promise<ListingRecord|undefined>;
listCatalog(context:TenantContext):Promise<ListingCatalogItem[]>;
listVersions(context:TenantContext,id:string,permission?:ListingAccessPermission):Promise<ListingVersionRecord[]>;
}
async function withTenant<T>(db:DatabaseConnection['db'],context:TenantContext,operation:Parameters<typeof catalogTenant<T>>[2]){try{return await catalogTenant(db,context,operation);}catch(error){const value=error as {code?:string;cause?:{code?:string}};if((value?.code??value?.cause?.code)==='23505')throw new OriginalOwnerError(409,'目标渠道已存在或不可用 请核对后重试');throw error;}}
export class ListingReadOwner{constructor(private readonly repository:ListingReadRepository){}
async catalog(context: TenantContext, rawQuery: ListingCatalogQuery) {
    authorize(context, Permission.ListingRead);
    const query = ListingCatalogQuerySchema.parse(rawQuery);
    const q = query.q.toLocaleLowerCase();
    const filtered = (await this.repository.listCatalog(context)).filter((item) => {
      if (query.platform && item.platform !== query.platform) return false;
      if (query.status && item.status !== query.status) return false;
      if (!query.status && item.status === "archived") return false;
      if (query.locale && item.locale !== query.locale) return false;
      if (query.marketplaceId && item.marketplaceId !== query.marketplaceId) return false;
      if (query.completeness === "low" && item.completeness >= 80) return false;
      if (query.completeness === "partial" && (item.completeness < 80 || item.completeness >= 100))
        return false;
      if (query.completeness === "complete" && item.completeness < 100) return false;
      if (query.blockers === "with" && item.blockerCount === 0) return false;
      if (query.blockers === "without" && item.blockerCount > 0) return false;
      return (
        !q ||
        [item.title, item.spuCode, item.spuName, item.id].some((value) =>
          value.toLocaleLowerCase().includes(q),
        )
      );
    });
    filtered.sort((left, right) => compareCatalogItems(left, right, query.sort, query.direction));
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / query.limit));
    const page = Math.min(query.page, pages);
    const start = (page - 1) * query.limit;
    return {
      items: filtered.slice(start, start + query.limit),
      page,
      limit: query.limit,
      total,
      pages,
    };
  }
async getWorkspace(context: TenantContext, listingId: string) {
    authorize(context, Permission.ListingRead);
    if (this.repository.workspace) return this.repository.workspace(context, listingId);
    const listing = await this.repository.get(context, listingId);
    if (!listing) throw new OriginalOwnerError(404, "Listing not found");
    const history = await this.repository.listVersions(context, listingId);
    const version = history[0];
    if (!version) throw new OriginalOwnerError(404, "Listing version not found");
    return { listing, version, history };
  }
listVersions(context: TenantContext, listingId: string) {
    authorize(context, Permission.ListingRead);
    return this.repository.listVersions(context, listingId);
  }
}
export class DrizzleListingReadRepository {constructor(private readonly database:DatabaseConnection){}
async get(
    context: TenantContext,
    id: string,
    permission: ListingAccessPermission = Permission.ListingRead,
  ) {
    const [row] = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      return tx
        .select()
        .from(listings)
        .where(
          and(eq(listings.id, id), catalogOwnerFilter(context, permission, listings.createdBy)),
        )
        .limit(1);
    });
    return row ? mapListing(row) : undefined;
  }
async list(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      return tx
        .select()
        .from(listings)
        .where(catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy))
        .orderBy(desc(listings.updatedAt));
    });
    return rows.map(mapListing);
  }
async listCatalog(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const productReadable = context.permissions.includes(Permission.ProductRead)
        ? (catalogPlanFilter(context, Permission.ProductRead) ?? sql`true`)
        : sql`false`;
      return tx
        .select({
          ownerUserId: listings.createdBy,
          id: listings.id,
          spuId: listings.spuId,
          spuCode: sql<string | null>`case when ${productReadable} then ${spus.code} else null end`,
          spuName: sql<string | null>`case when ${productReadable} then ${spus.name} else null end`,
          platform: listings.platform,
          marketplaceId: listings.marketplaceId,
          locale: listings.locale,
          status: listings.status,
          primaryVersionId: listings.primaryVersionId,
          versionId: listingVersions.id,
          versionNumber: listingVersions.versionNumber,
          source: listingVersions.source,
          content: listingVersions.content,
          validation: listingVersions.validation,
          updatedAt: listingVersions.createdAt,
        })
        .from(listings)
        .innerJoin(spus, eq(spus.id, listings.spuId))
        .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
        .innerJoin(listingVersions, eq(listingVersions.listingId, listings.id))
        .where(catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy))
        .orderBy(desc(listingVersions.versionNumber));
    });
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .map((row): ListingCatalogItem => ({
        ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
        id: row.id,
        spuId: row.spuId,
        spuCode: row.spuCode ?? "",
        spuName: row.spuName ?? "",
        productAccess: row.spuName !== null,
        platform: row.platform as ListingPlatform,
        ...(row.marketplaceId ? { marketplaceId: row.marketplaceId } : {}),
        locale: row.locale,
        status: row.status as ListingRecord["status"],
        ...(row.primaryVersionId ? { primaryVersionId: row.primaryVersionId } : {}),
        versionId: row.versionId,
        versionNumber: row.versionNumber,
        title: row.content.title,
        hasMainImage: Boolean(row.content.mainImageId),
        completeness: row.validation.completeness,
        blockerCount: row.validation.blockers.length,
        source: row.source as ListingVersionRecord["source"],
        updatedAt: row.updatedAt.toISOString(),
      }));
  }
async workspace(context: TenantContext, id: string) {
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const listing = await assertCatalogListingAccess(
        tx,
        context,
        id,
        [Permission.ListingRead],
        "share",
      );
      const rows = await tx
        .select()
        .from(listingVersions)
        .where(eq(listingVersions.listingId, id))
        .orderBy(desc(listingVersions.versionNumber));
      if (!rows[0]) throw new OriginalOwnerError(404, "Listing version not found");
      const history = rows.map(mapVersion);
      return { listing: mapListing(listing), version: history[0]!, history };
    });
  }
async listVersions(
    context: TenantContext,
    listingId: string,
    permission: ListingAccessPermission = Permission.ListingRead,
  ) {
    const rows = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await assertCatalogListingAccess(tx, context, listingId, [permission]);
      return tx
        .select()
        .from(listingVersions)
        .where(eq(listingVersions.listingId, listingId))
        .orderBy(desc(listingVersions.versionNumber));
    });
    return rows.map(mapVersion);
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
function compareCatalogItems(
  left: ListingCatalogItem,
  right: ListingCatalogItem,
  sort: ListingCatalogQuery["sort"],
  direction: ListingCatalogQuery["direction"],
) {
  const leftValue =
    sort === "title"
      ? left.title.toLocaleLowerCase()
      : sort === "updatedAt"
        ? Date.parse(left.updatedAt)
        : left[sort];
  const rightValue =
    sort === "title"
      ? right.title.toLocaleLowerCase()
      : sort === "updatedAt"
        ? Date.parse(right.updatedAt)
        : right[sort];
  const result = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  return direction === "asc" ? result : -result;
}
