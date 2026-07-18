import { Inject, Injectable } from "@nestjs/common";
import { SupplierCandidateInputSchema, createEntityId, type Money, type SupplierCandidateInput, type TenantContext } from "@yummyai/contracts";
import { supplierCandidates, type DatabaseConnection, withTenant } from "@yummyai/database";
import { and, asc, eq } from "drizzle-orm";

import { DATABASE_CONNECTION, SUPPLIER_REPOSITORY } from "../platform.tokens.js";

export interface SupplierCandidateRecord extends SupplierCandidateInput {
  id: string;
  tenantId: string;
  status: "candidate" | "contacted" | "approved" | "rejected";
}

export interface SupplierRepository {
  create(context: TenantContext, input: SupplierCandidateInput): Promise<SupplierCandidateRecord>;
  list(context: TenantContext, productPlanId: string): Promise<SupplierCandidateRecord[]>;
}

@Injectable()
export class SupplierService {
  constructor(@Inject(SUPPLIER_REPOSITORY) private readonly repository: SupplierRepository) {}

  addCandidate(context: TenantContext, input: SupplierCandidateInput) {
    return this.repository.create(context, SupplierCandidateInputSchema.parse(input));
  }

  listCandidates(context: TenantContext, productPlanId: string) {
    return this.repository.list(context, productPlanId);
  }
}

@Injectable()
export class DrizzleSupplierRepository implements SupplierRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async create(context: TenantContext, rawInput: SupplierCandidateInput): Promise<SupplierCandidateRecord> {
    const input = SupplierCandidateInputSchema.parse(rawInput);
    const [row] = await withTenant(this.database.db, context, (tx) => tx.insert(supplierCandidates).values({
      id: createEntityId(), tenantId: context.tenantId, productPlanId: input.productPlanId, name: input.name, priority: input.priority,
      quotedCostAmount: input.quotedCost?.amount.toFixed(2), quotedCostCurrency: input.quotedCost?.currency,
      minimumOrderQuantity: input.minimumOrderQuantity, leadTimeDays: input.leadTimeDays, notes: input.notes,
    }).returning());
    return mapCandidate(row!);
  }

  async list(context: TenantContext, productPlanId: string): Promise<SupplierCandidateRecord[]> {
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(supplierCandidates)
      .where(and(eq(supplierCandidates.tenantId, context.tenantId), eq(supplierCandidates.productPlanId, productPlanId)))
      .orderBy(asc(supplierCandidates.priority), asc(supplierCandidates.quotedCostAmount)));
    return rows.map(mapCandidate);
  }
}

function mapCandidate(row: typeof supplierCandidates.$inferSelect): SupplierCandidateRecord {
  const quotedCost: Money | undefined = row.quotedCostAmount && row.quotedCostCurrency
    ? { amount: Number(row.quotedCostAmount), currency: row.quotedCostCurrency }
    : undefined;
  return {
    id: row.id, tenantId: row.tenantId, productPlanId: row.productPlanId, name: row.name, priority: row.priority,
    quotedCost, minimumOrderQuantity: row.minimumOrderQuantity ?? undefined, leadTimeDays: row.leadTimeDays ?? undefined,
    notes: row.notes ?? undefined, status: row.status as SupplierCandidateRecord["status"],
  };
}
