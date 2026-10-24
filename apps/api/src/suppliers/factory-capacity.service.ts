import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection, TenantTransaction } from "@yummyai/database";
import {
  FactoryCapacityOwner, FactoryCapacityOwnerError,
  reserveFactoryCapacityInTransaction as reserveShared,
  recordFactoryCapacityMilestoneInTransaction as recordMilestoneShared,
  applyProductionQuantityCapacityStop as applyStopShared,
} from "@yummyai/order-core";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

async function apiResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof FactoryCapacityOwnerError) {
      if (error.status === 404) throw new NotFoundException(error.body);
      if (error.status === 422) throw new UnprocessableEntityException(error.body);
      throw new ConflictException(error.body);
    }
    throw error;
  }
}

@Injectable()
export class FactoryCapacityService {
  private readonly owner: FactoryCapacityOwner;
  constructor(@Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    @Inject(AuditService) audit: AuditService) {
    this.owner = new FactoryCapacityOwner(database, audit);
  }

  async workspace(context: TenantContext, factoryId: string, rawQuery: unknown = {}) {
    return apiResult(() => this.owner.workspace(context, factoryId, rawQuery));
  }
  async createPool(context: TenantContext, factoryId: string, rawInput: unknown) {
    return apiResult(() => this.owner.createPool(context, factoryId, rawInput));
  }
  async revisePool(context: TenantContext, factoryId: string, poolId: string, rawInput: unknown) {
    return apiResult(() => this.owner.revisePool(context, factoryId, poolId, rawInput));
  }
  async history(context: TenantContext, factoryId: string, poolId: string) {
    return apiResult(() => this.owner.history(context, factoryId, poolId));
  }
  async preview(context: TenantContext, factoryId: string, rawInput: unknown) {
    return apiResult(() => this.owner.preview(context, factoryId, rawInput));
  }
  async resolveTime(context: TenantContext, factoryId: string, rawInput: unknown) {
    return apiResult(() => this.owner.resolveTime(context, factoryId, rawInput));
  }
  async production(context: TenantContext, productionOrderId: string) {
    return apiResult(() => this.owner.production(context, productionOrderId));
  }
}

/** Delegate within the actual production owner's existing tenant transaction. */
export async function reserveFactoryCapacityInTransaction(tx: TenantTransaction, context: TenantContext, audit: AuditService,
  input: Parameters<typeof reserveShared>[3]) {
  return apiResult(() => reserveShared(tx, context, audit, input));
}

export async function recordFactoryCapacityMilestoneInTransaction(tx: TenantTransaction, context: TenantContext, audit: AuditService,
  input: Parameters<typeof recordMilestoneShared>[3]) {
  return apiResult(() => recordMilestoneShared(tx, context, audit, input));
}

export async function applyProductionQuantityCapacityStop(tx: TenantTransaction, context: TenantContext, reviewId: string) {
  return apiResult(() => applyStopShared(tx, context, reviewId));
}
