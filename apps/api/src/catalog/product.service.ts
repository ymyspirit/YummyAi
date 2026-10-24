import { withCatalogTenant as withTenant } from "./catalog-access.js";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  CreateSkuInputSchema,
  CreateSpuInputSchema,
  ProductPlanInputSchema,
  ProductStatusSchema,
  UpdateProductPlanCustomizationInputSchema,
  createEntityId,
  type CreateSkuInput,
  type CreateSpuInput,
  type CustomizationDefinition,
  type Money,
  type LegacySpuCandidate,
  type ProductPlanInput,
  type ProductStatus,
  type TenantContext,
  type UpdateProductPlanCustomizationInput,
} from "@yummyai/contracts";
import type { CustomProductProfileV1 } from "@yummyai/contracts/catalog/custom-product-package";
import { authorize, Permission, permissionContext } from "@yummyai/authz";
import {
  currentCatalogContext,
  catalogPlanFilter,
  assertCatalogPlanAccess,
  assertCatalogUnambiguousPlan,
  assertCatalogSpuAccess,
  assertCatalogTeamAssignment,
} from "@yummyai/catalog-core";
import {
  designTasks,
  listings,
  productPlans,
  skus,
  spus,
  supplierCandidates,
  users,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, desc, eq, inArray } from "drizzle-orm";

import { CATALOG_REPOSITORY, DATABASE_CONNECTION } from "../platform.tokens.js";

export interface ProductPlanRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  status: ProductStatus;
  sourceReportIds: string[];
  targetCost?: Money;
  customization: CustomizationDefinition;
  customProductProfile?: CustomProductProfileV1;
  ownerUserId?: string;
  teamId?: string;
  ownerName?: string;
  createdAt?: string;
  updatedAt?: string;
  legacySpuCandidates?: LegacySpuCandidate[];
  spu?: {
    id: string;
    code: string;
    name: string;
    skus: Array<{ id: string; code: string; attributes: Record<string, string>; unitCost?: Money }>;
  };
  suppliers?: Array<{
    id: string;
    name: string;
    priority: number;
    quotedCost?: Money;
    minimumOrderQuantity?: number;
    leadTimeDays?: number;
  }>;
  designTasks?: Array<{
    id: string;
    skuCode: string;
    title: string;
    status: string;
    dueAt?: string;
  }>;
  listings?: Array<{
    id: string;
    platform: "amazon" | "etsy";
    marketplaceId?: string;
    locale: string;
    status: string;
  }>;
}

export interface SpuRecord {
  id: string;
  tenantId: string;
  productPlanId: string;
  code: string;
  name: string;
  status: "developing" | "listing" | "ready" | "archived";
  customization: CustomizationDefinition;
}

export interface SkuRecord {
  id: string;
  tenantId: string;
  spuId: string;
  code: string;
  attributes: Record<string, string>;
  unitCost?: Money;
  status: "draft" | "active" | "archived";
}

export interface CatalogRepository {
  createPlan(context: TenantContext, input: ProductPlanInput): Promise<ProductPlanRecord>;
  getPlan(
    context: TenantContext,
    id: string,
    permission?: Permission,
  ): Promise<ProductPlanRecord | undefined>;
  listPlans(context: TenantContext): Promise<ProductPlanRecord[]>;
  updatePlanCustomization(
    context: TenantContext,
    id: string,
    customization: CustomizationDefinition,
  ): Promise<ProductPlanRecord>;
  setPlanStatus(
    context: TenantContext,
    id: string,
    status: ProductStatus,
    approval?: { by: string; at: Date },
    expectedStatus?: ProductStatus,
  ): Promise<ProductPlanRecord>;
  createSpu(
    context: TenantContext,
    plan: ProductPlanRecord,
    input: CreateSpuInput,
  ): Promise<SpuRecord>;
  getSpu(context: TenantContext, id: string): Promise<SpuRecord | undefined>;
  findSkuByCode(context: TenantContext, code: string): Promise<SkuRecord | undefined>;
  createSku(context: TenantContext, input: CreateSkuInput): Promise<SkuRecord>;
}

export const productTransitions: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
  researching: ["pending_approval", "archived"],
  pending_approval: ["approved", "researching", "archived"],
  approved: ["developing", "archived"],
  developing: ["listing", "archived"],
  listing: ["ready", "developing", "archived"],
  ready: ["archived"],
  archived: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ProductStatus,
    readonly to: ProductStatus,
  ) {
    super(`Product status cannot transition from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class ApprovalEvidenceRequiredError extends Error {
  constructor() {
    super("A product plan requires at least one approved analysis report before approval");
    this.name = "ApprovalEvidenceRequiredError";
  }
}

@Injectable()
export class ProductService {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly repository: CatalogRepository) {}

  createPlan(context: TenantContext, input: ProductPlanInput) {
    context = permissionContext(context, Permission.ProductWrite);
    return this.repository.createPlan(context, ProductPlanInputSchema.parse(input));
  }

  listPlans(context: TenantContext) {
    context = permissionContext(context, Permission.ProductRead);
    return this.repository.listPlans(context);
  }

  async updateCustomization(
    context: TenantContext,
    planId: string,
    input: UpdateProductPlanCustomizationInput,
  ) {
    context = permissionContext(context, Permission.ProductWrite);
    const parsed = UpdateProductPlanCustomizationInputSchema.parse(input);
    const plan = await this.requirePlan(context, planId);
    if (plan.status !== "researching") {
      throw new ConflictException(
        "Product customization can only be edited while the plan is researching",
      );
    }
    return this.repository.updatePlanCustomization(context, plan.id, parsed.customization);
  }

  async transition(context: TenantContext, planId: string, requestedStatus: ProductStatus) {
    context = permissionContext(context, Permission.ProductWrite);
    const next = ProductStatusSchema.parse(requestedStatus);
    const plan = await this.requirePlan(context, planId);
    if (!productTransitions[plan.status].includes(next))
      throw new InvalidTransitionError(plan.status, next);
    if (next === "approved" && plan.sourceReportIds.length === 0)
      throw new ApprovalEvidenceRequiredError();
    return this.repository.setPlanStatus(
      context,
      plan.id,
      next,
      next === "approved" ? { by: context.userId, at: new Date() } : undefined,
      plan.status,
    );
  }

  async createSpu(context: TenantContext, planId: string, input: CreateSpuInput) {
    context = permissionContext(context, Permission.ProductWrite);
    const plan = await this.requirePlan(context, planId);
    if (plan.status !== "approved") throw new InvalidTransitionError(plan.status, "developing");
    return this.repository.createSpu(context, plan, CreateSpuInputSchema.parse(input));
  }

  async createSku(context: TenantContext, input: CreateSkuInput) {
    context = permissionContext(context, Permission.ProductWrite);
    const parsed = CreateSkuInputSchema.parse(input);
    const spu = await this.repository.getSpu(context, parsed.spuId);
    if (!spu) throw new NotFoundException("SPU not found");
    await this.requirePlan(context, spu.productPlanId);
    if (await this.repository.findSkuByCode(context, parsed.code))
      throw new ConflictException("SKU code already exists in this tenant");
    try {
      return await this.repository.createSku(context, parsed);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("SKU code already exists in this tenant");
      throw error;
    }
  }

  private async requirePlan(context: TenantContext, id: string) {
    const plan = await this.repository.getPlan(context, id, Permission.ProductWrite);
    if (!plan) throw new NotFoundException("Product plan not found");
    authorize(context, Permission.ProductWrite, { ownerId: plan.ownerUserId, teamId: plan.teamId });
    return plan;
  }
}

@Injectable()
export class DrizzleCatalogRepository implements CatalogRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async createPlan(context: TenantContext, rawInput: ProductPlanInput): Promise<ProductPlanRecord> {
    const input = ProductPlanInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentCatalogContext(tx, context);
      authorize(current, Permission.ProductWrite);
      await assertCatalogTeamAssignment(tx, current, input.teamId);
      const [row] = await tx
        .insert(productPlans)
        .values({
          id: createEntityId(),
          tenantId: current.tenantId,
          name: input.name,
          description: input.description,
          sourceReportIds: input.sourceReportIds,
          targetCostAmount: input.targetCost?.amount.toFixed(2),
          targetCostCurrency: input.targetCost?.currency,
          customization: input.customization,
          createdBy: current.userId,
          teamId: input.teamId,
        })
        .returning();
      return mapPlan(row!);
    });
  }

  async getPlan(
    context: TenantContext,
    id: string,
    permission: Permission = Permission.ProductRead,
  ): Promise<ProductPlanRecord | undefined> {
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentCatalogContext(tx, context);
      const [row] = await tx
        .select()
        .from(productPlans)
        .where(and(eq(productPlans.id, id), catalogPlanFilter(current, permission)))
        .limit(1);
      return row ? mapPlan(row) : undefined;
    });
  }

  async listPlans(context: TenantContext): Promise<ProductPlanRecord[]> {
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const planRows = await tx
        .select()
        .from(productPlans)
        .where(catalogPlanFilter(context, Permission.ProductRead))
        .orderBy(desc(productPlans.updatedAt));
      if (planRows.length === 0) return [];
      const planIds = planRows.map((row) => row.id);
      const spuRows = await tx.select().from(spus).where(inArray(spus.productPlanId, planIds));
      const spuIds = spuRows.map((row) => row.id);
      const skuRows = spuIds.length
        ? await tx.select().from(skus).where(inArray(skus.spuId, spuIds))
        : [];
      const supplierRows = await tx
        .select()
        .from(supplierCandidates)
        .where(inArray(supplierCandidates.productPlanId, planIds));
      const designRows = skuRows.length
        ? await tx
            .select()
            .from(designTasks)
            .where(
              inArray(
                designTasks.skuId,
                skuRows.map((row) => row.id),
              ),
            )
            .orderBy(desc(designTasks.updatedAt))
        : [];
      const listingRows = spuIds.length
        ? await tx
            .select()
            .from(listings)
            .where(inArray(listings.spuId, spuIds))
            .orderBy(desc(listings.updatedAt))
        : [];
      const ownerIds = [
        ...new Set(planRows.flatMap((row) => (row.createdBy ? [row.createdBy] : []))),
      ];
      const ownerRows = ownerIds.length
        ? await tx
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, ownerIds))
        : [];
      const ownerNames = new Map(ownerRows.map((row) => [row.id, row.displayName]));
      const spusByPlan = new Map<string, typeof spuRows>();
      for (const row of spuRows) spusByPlan.set(row.productPlanId, [...(spusByPlan.get(row.productPlanId) ?? []), row]);
      const skusBySpu = new Map<string, typeof skuRows>();
      for (const row of skuRows)
        skusBySpu.set(row.spuId, [...(skusBySpu.get(row.spuId) ?? []), row]);
      const suppliersByPlan = new Map<string, typeof supplierRows>();
      for (const row of supplierRows)
        suppliersByPlan.set(row.productPlanId, [
          ...(suppliersByPlan.get(row.productPlanId) ?? []),
          row,
        ]);
      const skuById = new Map(skuRows.map((row) => [row.id, row]));
      const designsBySpu = new Map<string, typeof designRows>();
      for (const row of designRows) {
        const sku = skuById.get(row.skuId);
        if (sku) designsBySpu.set(sku.spuId, [...(designsBySpu.get(sku.spuId) ?? []), row]);
      }
      const listingsBySpu = new Map<string, typeof listingRows>();
      for (const row of listingRows)
        listingsBySpu.set(row.spuId, [...(listingsBySpu.get(row.spuId) ?? []), row]);
      return planRows.map((row) => {
        const candidates = spusByPlan.get(row.id) ?? [];
        const spu = candidates.length === 1 && !candidates[0]!.legacyPlanAmbiguous ? candidates[0] : undefined;
        return {
          ...mapPlan(row),
          ...(candidates.some(candidate => candidate.legacyPlanAmbiguous) || candidates.length > 1
            ? { legacySpuCandidates: candidates.map(candidate => ({ id: candidate.id, code: candidate.code, name: candidate.name })) }
            : {}),
          ...(row.createdBy
            ? {
                ownerUserId: row.createdBy,
                ownerName: ownerNames.get(row.createdBy) ?? "成员已移除",
              }
            : {}),
          ...(spu
            ? {
                spu: {
                  id: spu.id,
                  code: spu.code,
                  name: spu.name,
                  skus: (skusBySpu.get(spu.id) ?? []).map((sku) => ({
                    id: sku.id,
                    code: sku.code,
                    attributes: sku.attributes,
                    ...(sku.unitCostAmount && sku.unitCostCurrency
                      ? {
                          unitCost: {
                            amount: Number(sku.unitCostAmount),
                            currency: sku.unitCostCurrency,
                          },
                        }
                      : {}),
                  })),
                },
              }
            : {}),
          suppliers: (suppliersByPlan.get(row.id) ?? [])
            .sort((left, right) => left.priority - right.priority)
            .map((supplier) => ({
              id: supplier.id,
              name: supplier.name,
              priority: supplier.priority,
              ...(supplier.quotedCostAmount && supplier.quotedCostCurrency
                ? {
                    quotedCost: {
                      amount: Number(supplier.quotedCostAmount),
                      currency: supplier.quotedCostCurrency,
                    },
                  }
                : {}),
              ...(supplier.minimumOrderQuantity !== null
                ? { minimumOrderQuantity: supplier.minimumOrderQuantity }
                : {}),
              ...(supplier.leadTimeDays !== null ? { leadTimeDays: supplier.leadTimeDays } : {}),
            })),
          designTasks: candidates.flatMap(candidate => designsBySpu.get(candidate.id) ?? []).map((task) => ({
                id: task.id,
                skuCode: skuById.get(task.skuId)?.code ?? task.skuId.slice(0, 12),
                title: task.title,
                status: task.status,
                ...(task.dueAt ? { dueAt: task.dueAt.toISOString() } : {}),
              })),
          listings: candidates.flatMap(candidate => listingsBySpu.get(candidate.id) ?? []).map((listing) => ({
                id: listing.id,
                platform: listing.platform as "amazon" | "etsy",
                ...(listing.marketplaceId ? { marketplaceId: listing.marketplaceId } : {}),
                locale: listing.locale,
                status: listing.status,
              })),
        };
      });
    });
  }

  async setPlanStatus(
    context: TenantContext,
    id: string,
    status: ProductStatus,
    approval?: { by: string; at: Date },
    expectedStatus?: ProductStatus,
  ) {
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentCatalogContext(tx, context),
        plan = await assertCatalogPlanAccess(tx, current, id, [Permission.ProductWrite], true);
      if (expectedStatus !== undefined && plan.status !== expectedStatus)
        throw new ConflictException("产品阶段已变化 请刷新后重试");
      await assertCatalogUnambiguousPlan(tx, id);
      const [row] = await tx
        .update(productPlans)
        .set({
          status,
          ...(approval ? { approvedBy: approval.by, approvedAt: approval.at } : {}),
          updatedAt: new Date(),
        })
        .where(eq(productPlans.id, id))
        .returning();
      return mapPlan(row!);
    });
  }

  async updatePlanCustomization(
    context: TenantContext,
    id: string,
    customization: CustomizationDefinition,
  ) {
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentCatalogContext(tx, context),
        plan = await assertCatalogPlanAccess(tx, current, id, [Permission.ProductWrite], true);
      if (plan.status !== "researching")
        throw new ConflictException(
          "Product customization can only be edited while the plan is researching",
        );
      await assertCatalogUnambiguousPlan(tx, id);
      const [row] = await tx
        .update(productPlans)
        .set({ customization, updatedAt: new Date() })
        .where(eq(productPlans.id, id))
        .returning();
      return mapPlan(row!);
    });
  }

  async createSpu(
    context: TenantContext,
    plan: ProductPlanRecord,
    rawInput: CreateSpuInput,
  ): Promise<SpuRecord> {
    const input = CreateSpuInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentCatalogContext(tx, context),
        actual = await assertCatalogPlanAccess(
          tx,
          current,
          plan.id,
          [Permission.ProductWrite],
          true,
        );
      const existing = await tx.select({ id: spus.id, ambiguous: spus.legacyPlanAmbiguous }).from(spus).where(eq(spus.productPlanId, actual.id));
      if (existing.length > 1 || existing.some(row => row.ambiguous)) throw new ConflictException("历史企划关联多个 SPU，请从商品库明确选择原 SPU；不能自动创建或选择默认记录");
      if (actual.status !== "approved") throw new ConflictException("产品阶段已变化 请刷新后重试");
      const [row] = await tx
        .insert(spus)
        .values({
          id: createEntityId(),
          tenantId: current.tenantId,
          productPlanId: actual.id,
          code: input.code,
          name: input.name,
          customization: actual.customization,
        })
        .returning();
      await tx
        .update(productPlans)
        .set({ status: "developing", updatedAt: new Date() })
        .where(eq(productPlans.id, actual.id));
      return mapSpu(row!);
    });
  }

  async getSpu(context: TenantContext, id: string): Promise<SpuRecord | undefined> {
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(spus).where(eq(spus.id, id)).limit(1),
    );
    return row ? mapSpu(row) : undefined;
  }

  async findSkuByCode(context: TenantContext, code: string): Promise<SkuRecord | undefined> {
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(skus).where(eq(skus.code, code)).limit(1),
    );
    return row ? mapSku(row) : undefined;
  }

  async createSku(context: TenantContext, rawInput: CreateSkuInput): Promise<SkuRecord> {
    const input = CreateSkuInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentCatalogContext(tx, context);
      await assertCatalogSpuAccess(tx, current, input.spuId, [Permission.ProductWrite], true);
      const [row] = await tx
        .insert(skus)
        .values({
          id: createEntityId(),
          tenantId: current.tenantId,
          spuId: input.spuId,
          code: input.code,
          attributes: input.attributes,
          unitCostAmount: input.unitCost?.amount.toFixed(2),
          unitCostCurrency: input.unitCost?.currency,
        })
        .returning();
      return mapSku(row!);
    });
  }
}

function mapPlan(row: typeof productPlans.$inferSelect): ProductPlanRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description ?? undefined,
    status: ProductStatusSchema.parse(row.status),
    sourceReportIds: row.sourceReportIds,
    targetCost:
      row.targetCostAmount && row.targetCostCurrency
        ? { amount: Number(row.targetCostAmount), currency: row.targetCostCurrency }
        : undefined,
    customization: row.customization,
    ...(row.customProductProfile ? { customProductProfile: row.customProductProfile } : {}),
    ...(row.createdBy ? { ownerUserId: row.createdBy } : {}),
    ...(row.teamId ? { teamId: row.teamId } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSpu(row: typeof spus.$inferSelect): SpuRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    productPlanId: row.productPlanId,
    code: row.code,
    name: row.name,
    status: row.status as SpuRecord["status"],
    customization: row.customization,
  };
}

function mapSku(row: typeof skus.$inferSelect): SkuRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    spuId: row.spuId,
    code: row.code,
    attributes: row.attributes,
    unitCost:
      row.unitCostAmount && row.unitCostCurrency
        ? { amount: Number(row.unitCostAmount), currency: row.unitCostCurrency }
        : undefined,
    status: row.status as SkuRecord["status"],
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
