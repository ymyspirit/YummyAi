import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreateProductSupplyInputSchema, ReviseProductSupplyInputSchema, ProductSupplyWorkspaceSchema,
  ProductSupplyVersionViewSchema, type CreateProductSupplyInput, type ReviseProductSupplyInput, type SupplyTerms,
} from "@yummyai/contracts/catalog/product-supply";
import {
  productSupplyLinks, productSupplyVersions, productPlans, spus, skus, fulfillmentSuppliers,
  inventoryStockItems, inventoryLocations, inventoryWarehouses, withTenant,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

@Injectable()
export class ProductSupplyService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  workspace(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      const rows = await tx.select({ link: productSupplyLinks, version: productSupplyVersions,
        productName: productPlans.name, supplierName: fulfillmentSuppliers.name,
        supplierStatus: fulfillmentSuppliers.status, skuCode: skus.code,
      }).from(productSupplyLinks)
        .innerJoin(productSupplyVersions, and(eq(productSupplyVersions.linkId, productSupplyLinks.id), eq(productSupplyVersions.versionNumber, productSupplyLinks.currentVersion)))
        .innerJoin(productPlans, eq(productPlans.id, productSupplyLinks.productPlanId))
        .innerJoin(fulfillmentSuppliers, eq(fulfillmentSuppliers.id, productSupplyLinks.supplierId))
        .leftJoin(skus, eq(skus.id, productSupplyLinks.skuId)).orderBy(desc(productSupplyLinks.updatedAt));
      const plans = await tx.select({ id: productPlans.id, name: productPlans.name, status: productPlans.status }).from(productPlans).orderBy(asc(productPlans.name));
      const skuRows = await tx.select({ id: skus.id, code: skus.code, attributes: skus.attributes, productPlanId: spus.productPlanId })
        .from(skus).innerJoin(spus, eq(spus.id, skus.spuId));
      const suppliers = await tx.select().from(fulfillmentSuppliers).orderBy(asc(fulfillmentSuppliers.name));
      const stockItems = await tx.select().from(inventoryStockItems);
      const locations = await tx.select().from(inventoryLocations);
      const warehouses = await tx.select().from(inventoryWarehouses);
      // Parse projections before crossing the API boundary; never expose tenant IDs or connection references.
      return ProductSupplyWorkspaceSchema.parse({
        links: rows.map(({ link, version, ...names }) => ({ ...link, ...names, versionId: version.id, terms: version.terms, updatedAt: link.updatedAt.toISOString() })),
        products: plans.map((plan) => ({ ...plan, skus: skuRows.filter((sku) => sku.productPlanId === plan.id) })),
        suppliers, stockItems, locations, warehouses,
      });
    });
  }

  history(context: TenantContext, id: string) {
    return withTenant(this.database.db, context, async (tx) => {
      await requireLink(tx, id);
      const rows = await tx.select().from(productSupplyVersions).where(eq(productSupplyVersions.linkId, id)).orderBy(desc(productSupplyVersions.versionNumber));
      return rows.map((row) => ProductSupplyVersionViewSchema.parse({ id: row.id, version: row.versionNumber, terms: row.terms, createdAt: row.createdAt.toISOString() }));
    });
  }

  async create(context: TenantContext, raw: CreateProductSupplyInput) {
    const input = CreateProductSupplyInputSchema.parse(raw);
    const hash = requestHash({ operation: "create", input });
    const result = await withTenant(this.database.db, context, async (tx) => {
      await requestLock(tx, input.idempotencyKey);
      const replay = await replayVersion(tx, input.idempotencyKey, hash);
      if (replay) return replay;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`product-supply:${context.tenantId}:${input.productPlanId}`}, 0))`);
      const [plan] = await tx.select().from(productPlans).where(eq(productPlans.id, input.productPlanId)).limit(1);
      if (!plan) throw new NotFoundException("Product not found");
      if (plan.status === "archived") throw new ConflictException("Product is archived");
      await validateReferences(tx, input.supplierId, input.skuId, input.productPlanId, input.terms);
      const [duplicate] = await tx.select().from(productSupplyLinks).where(and(
        eq(productSupplyLinks.productPlanId, input.productPlanId), eq(productSupplyLinks.supplierId, input.supplierId),
        input.skuId ? eq(productSupplyLinks.skuId, input.skuId) : isNull(productSupplyLinks.skuId),
      )).limit(1);
      if (duplicate) throw new ConflictException("Supply relationship already exists; revise its terms");
      await validatePrimary(tx, input.productPlanId, input.skuId, input.terms);
      const id = createEntityId();
      await tx.insert(productSupplyLinks).values({ id, tenantId: context.tenantId, productPlanId: input.productPlanId, supplierId: input.supplierId, skuId: input.skuId, createdBy: context.userId });
      await appendVersion(tx, context, id, 1, input.terms, input.idempotencyKey, hash);
      return { id, currentVersion: 1 };
    });
    await this.audit.record(context, { action: "product_supply.create", resourceType: "product_supply", resourceId: result.id, result: "success" });
    return result;
  }

  async revise(context: TenantContext, id: string, raw: ReviseProductSupplyInput) {
    const input = ReviseProductSupplyInputSchema.parse(raw);
    const hash = requestHash({ operation: "revise", id, input });
    const result = await withTenant(this.database.db, context, async (tx) => {
      await requestLock(tx, input.idempotencyKey);
      const replay = await replayVersion(tx, input.idempotencyKey, hash);
      if (replay) return replay;
      const initial = await requireLink(tx, id);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`product-supply:${context.tenantId}:${initial.productPlanId}`}, 0))`);
      const link = await requireLink(tx, id);
      if (link.currentVersion !== input.expectedVersion) throw new ConflictException("Supply version changed");
      await validateReferences(tx, link.supplierId, link.skuId, link.productPlanId, input.terms);
      await validatePrimary(tx, link.productPlanId, link.skuId, input.terms, id);
      const version = link.currentVersion + 1;
      await appendVersion(tx, context, id, version, input.terms, input.idempotencyKey, hash);
      await tx.update(productSupplyLinks).set({ currentVersion: version, updatedAt: new Date() }).where(eq(productSupplyLinks.id, id));
      return { id, currentVersion: version };
    });
    await this.audit.record(context, { action: "product_supply.revise", resourceType: "product_supply", resourceId: id, result: "success", metadata: { version: result.currentVersion } });
    return result;
  }
}

async function requireLink(tx: TenantTransaction, id: string) {
  const [link] = await tx.select().from(productSupplyLinks).where(eq(productSupplyLinks.id, id)).limit(1);
  if (!link) throw new NotFoundException("Product supply not found");
  return link;
}
async function requestLock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`product-supply-request:${key}`}, 0))`);
}
function requestHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function replayVersion(tx: TenantTransaction, key: string, hash: string) {
  const [version] = await tx.select().from(productSupplyVersions).where(eq(productSupplyVersions.idempotencyKey, key)).limit(1);
  if (!version) return null;
  if (version.requestHash !== hash) throw new ConflictException("Idempotency key was used with different input");
  return { id: version.linkId, currentVersion: version.versionNumber };
}
async function appendVersion(tx: TenantTransaction, context: TenantContext, id: string, version: number, terms: SupplyTerms, key: string, hash: string) {
  await tx.insert(productSupplyVersions).values({ id: createEntityId(), tenantId: context.tenantId, linkId: id, versionNumber: version, stockItemId: terms.stockItemId, terms, idempotencyKey: key, requestHash: hash, createdBy: context.userId });
}
async function validateReferences(tx: TenantTransaction, supplierId: string, skuId: string | null, productPlanId: string, terms: SupplyTerms) {
  const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, supplierId)).limit(1);
  if (!supplier) throw new NotFoundException("Supplier not found");
  if (terms.status === "active" && supplier.status !== "active") throw new ConflictException("Supplier is inactive");
  if (skuId) {
    const [sku] = await tx.select({ productPlanId: spus.productPlanId }).from(skus).innerJoin(spus, eq(spus.id, skus.spuId)).where(eq(skus.id, skuId)).limit(1);
    if (!sku || sku.productPlanId !== productPlanId) throw new NotFoundException("SKU does not belong to this product");
  }
  if (terms.stockItemId) {
    const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, terms.stockItemId)).limit(1);
    if (!stock) throw new NotFoundException("Stock item not found");
    if (terms.status === "active" && stock.status !== "active") throw new ConflictException("Stock item is inactive");
    if (stock.skuId && stock.skuId !== skuId) throw new ConflictException("Stock SKU does not match supply SKU");
  }
}
async function validatePrimary(tx: TenantTransaction, plan: string, sku: string | null, terms: SupplyTerms, exclude?: string) {
  if (terms.status !== "active" || terms.preference !== "primary") return;
  const links = await tx.select({ id: productSupplyLinks.id, terms: productSupplyVersions.terms }).from(productSupplyLinks)
    .innerJoin(productSupplyVersions, and(eq(productSupplyVersions.linkId, productSupplyLinks.id), eq(productSupplyVersions.versionNumber, productSupplyLinks.currentVersion)))
    .where(and(eq(productSupplyLinks.productPlanId, plan), sku ? eq(productSupplyLinks.skuId, sku) : isNull(productSupplyLinks.skuId)));
  if (links.some((link) => link.id !== exclude && link.terms.status === "active" && link.terms.preference === "primary")) throw new ConflictException("Primary supplier already exists for this specification");
}
