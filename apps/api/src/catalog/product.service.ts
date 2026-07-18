import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  CreateSkuInputSchema,
  CreateSpuInputSchema,
  ProductPlanInputSchema,
  ProductStatusSchema,
  createEntityId,
  type CreateSkuInput,
  type CreateSpuInput,
  type CustomizationDefinition,
  type Money,
  type ProductPlanInput,
  type ProductStatus,
  type TenantContext,
} from "@yummyai/contracts";
import { productPlans, skus, spus, type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, desc, eq } from "drizzle-orm";

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
  getPlan(context: TenantContext, id: string): Promise<ProductPlanRecord | undefined>;
  listPlans(context: TenantContext): Promise<ProductPlanRecord[]>;
  setPlanStatus(context: TenantContext, id: string, status: ProductStatus, approval?: { by: string; at: Date }): Promise<ProductPlanRecord>;
  createSpu(context: TenantContext, plan: ProductPlanRecord, input: CreateSpuInput): Promise<SpuRecord>;
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
  constructor(readonly from: ProductStatus, readonly to: ProductStatus) {
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
    return this.repository.createPlan(context, ProductPlanInputSchema.parse(input));
  }

  listPlans(context: TenantContext) {
    return this.repository.listPlans(context);
  }

  async transition(context: TenantContext, planId: string, requestedStatus: ProductStatus) {
    const next = ProductStatusSchema.parse(requestedStatus);
    const plan = await this.requirePlan(context, planId);
    if (!productTransitions[plan.status].includes(next)) throw new InvalidTransitionError(plan.status, next);
    if (next === "approved" && plan.sourceReportIds.length === 0) throw new ApprovalEvidenceRequiredError();
    return this.repository.setPlanStatus(
      context,
      plan.id,
      next,
      next === "approved" ? { by: context.userId, at: new Date() } : undefined,
    );
  }

  async createSpu(context: TenantContext, planId: string, input: CreateSpuInput) {
    const plan = await this.requirePlan(context, planId);
    if (plan.status !== "approved") throw new InvalidTransitionError(plan.status, "developing");
    const spu = await this.repository.createSpu(context, plan, CreateSpuInputSchema.parse(input));
    await this.repository.setPlanStatus(context, plan.id, "developing");
    return spu;
  }

  async createSku(context: TenantContext, input: CreateSkuInput) {
    const parsed = CreateSkuInputSchema.parse(input);
    if (!await this.repository.getSpu(context, parsed.spuId)) throw new NotFoundException("SPU not found");
    if (await this.repository.findSkuByCode(context, parsed.code)) throw new ConflictException("SKU code already exists in this tenant");
    try {
      return await this.repository.createSku(context, parsed);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("SKU code already exists in this tenant");
      throw error;
    }
  }

  private async requirePlan(context: TenantContext, id: string) {
    const plan = await this.repository.getPlan(context, id);
    if (!plan) throw new NotFoundException("Product plan not found");
    return plan;
  }
}

@Injectable()
export class DrizzleCatalogRepository implements CatalogRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async createPlan(context: TenantContext, rawInput: ProductPlanInput): Promise<ProductPlanRecord> {
    const input = ProductPlanInputSchema.parse(rawInput);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.insert(productPlans).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      name: input.name,
      description: input.description,
      sourceReportIds: input.sourceReportIds,
      targetCostAmount: input.targetCost?.amount.toFixed(2),
      targetCostCurrency: input.targetCost?.currency,
      customization: input.customization,
      createdBy: context.userId,
    }).returning());
    return mapPlan(row!);
  }

  async getPlan(context: TenantContext, id: string): Promise<ProductPlanRecord | undefined> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(productPlans).where(eq(productPlans.id, id)).limit(1));
    return row ? mapPlan(row) : undefined;
  }

  async listPlans(context: TenantContext): Promise<ProductPlanRecord[]> {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(productPlans).orderBy(desc(productPlans.updatedAt)));
    return rows.map(mapPlan);
  }

  async setPlanStatus(context: TenantContext, id: string, status: ProductStatus, approval?: { by: string; at: Date }) {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.update(productPlans).set({
      status,
      ...(approval ? { approvedBy: approval.by, approvedAt: approval.at } : {}),
      updatedAt: new Date(),
    }).where(and(eq(productPlans.tenantId, context.tenantId), eq(productPlans.id, id))).returning());
    if (!row) throw new NotFoundException("Product plan not found");
    return mapPlan(row);
  }

  async createSpu(context: TenantContext, plan: ProductPlanRecord, rawInput: CreateSpuInput): Promise<SpuRecord> {
    const input = CreateSpuInputSchema.parse(rawInput);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.insert(spus).values({
      id: createEntityId(), tenantId: context.tenantId, productPlanId: plan.id, code: input.code, name: input.name, customization: plan.customization,
    }).returning());
    return mapSpu(row!);
  }

  async getSpu(context: TenantContext, id: string): Promise<SpuRecord | undefined> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(spus).where(eq(spus.id, id)).limit(1));
    return row ? mapSpu(row) : undefined;
  }

  async findSkuByCode(context: TenantContext, code: string): Promise<SkuRecord | undefined> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(skus).where(eq(skus.code, code)).limit(1));
    return row ? mapSku(row) : undefined;
  }

  async createSku(context: TenantContext, rawInput: CreateSkuInput): Promise<SkuRecord> {
    const input = CreateSkuInputSchema.parse(rawInput);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.insert(skus).values({
      id: createEntityId(), tenantId: context.tenantId, spuId: input.spuId, code: input.code, attributes: input.attributes,
      unitCostAmount: input.unitCost?.amount.toFixed(2), unitCostCurrency: input.unitCost?.currency,
    }).returning());
    return mapSku(row!);
  }
}

function mapPlan(row: typeof productPlans.$inferSelect): ProductPlanRecord {
  return {
    id: row.id, tenantId: row.tenantId, name: row.name, description: row.description ?? undefined,
    status: ProductStatusSchema.parse(row.status), sourceReportIds: row.sourceReportIds,
    targetCost: row.targetCostAmount && row.targetCostCurrency ? { amount: Number(row.targetCostAmount), currency: row.targetCostCurrency } : undefined,
    customization: row.customization,
  };
}

function mapSpu(row: typeof spus.$inferSelect): SpuRecord {
  return { id: row.id, tenantId: row.tenantId, productPlanId: row.productPlanId, code: row.code, name: row.name, status: row.status as SpuRecord["status"], customization: row.customization };
}

function mapSku(row: typeof skus.$inferSelect): SkuRecord {
  return { id: row.id, tenantId: row.tenantId, spuId: row.spuId, code: row.code, attributes: row.attributes, unitCost: row.unitCostAmount && row.unitCostCurrency ? { amount: Number(row.unitCostAmount), currency: row.unitCostCurrency } : undefined, status: row.status as SkuRecord["status"] };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
