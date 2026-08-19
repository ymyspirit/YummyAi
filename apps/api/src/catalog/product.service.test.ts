import { ConflictException } from "@nestjs/common";
import {
  createEntityId,
  type CreateSkuInput,
  type CreateSpuInput,
  type ProductPlanInput,
  type ProductStatus,
  type TenantContext,
} from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import {
  ApprovalEvidenceRequiredError,
  InvalidTransitionError,
  ProductService,
  type CatalogRepository,
  type ProductPlanRecord,
  type SkuRecord,
  type SpuRecord,
} from "./product.service.js";

const tenantA = context();
const tenantB = context();

describe("ProductService", () => {
  it("does not create an SPU from an unapproved product plan", async () => {
    const service = new ProductService(new MemoryCatalogRepository());
    const plan = await service.createPlan(tenantA, planInput([]));
    await expect(
      service.createSpu(tenantA, plan.id, { code: "MUG", name: "Gift mug" }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("requires report evidence before approval", async () => {
    const service = new ProductService(new MemoryCatalogRepository());
    const plan = await service.createPlan(tenantA, planInput([]));
    await service.transition(tenantA, plan.id, "pending_approval");
    await expect(service.transition(tenantA, plan.id, "approved")).rejects.toBeInstanceOf(
      ApprovalEvidenceRequiredError,
    );
  });

  it("rejects duplicate SKU codes inside one tenant but allows the same code in another tenant", async () => {
    const repository = new MemoryCatalogRepository();
    const service = new ProductService(repository);
    const spuA = await approvedSpu(service, tenantA, "MUG-A");
    const spuB = await approvedSpu(service, tenantB, "MUG-B");

    await service.createSku(tenantA, {
      spuId: spuA.id,
      code: "mug-blk-11",
      attributes: {},
      unitCost: { amount: 8.25, currency: "USD" },
    });
    await expect(
      service.createSku(tenantA, { spuId: spuA.id, code: "MUG-BLK-11", attributes: {} }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.createSku(tenantB, { spuId: spuB.id, code: "MUG-BLK-11", attributes: {} }),
    ).resolves.toMatchObject({ code: "MUG-BLK-11" });
  });

  it("enforces explicit lifecycle transitions and preserves cost currency", async () => {
    const service = new ProductService(new MemoryCatalogRepository());
    const plan = await service.createPlan(tenantA, planInput([createEntityId()]));
    await expect(service.transition(tenantA, plan.id, "ready")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    const pending = await service.transition(tenantA, plan.id, "pending_approval");
    expect(pending.status).toBe("pending_approval");
    const approved = await service.transition(tenantA, plan.id, "approved");
    expect([approved.status, approved.targetCost]).toEqual([
      "approved",
      { amount: 12.5, currency: "USD" },
    ]);
  });

  it("lists only plans from the active tenant", async () => {
    const service = new ProductService(new MemoryCatalogRepository());
    await service.createPlan(tenantA, planInput([]));
    await service.createPlan(tenantB, { ...planInput([]), name: "Other tenant plan" });
    await expect(service.listPlans(tenantA)).resolves.toHaveLength(1);
  });

  it("persists customization only while the tenant plan is researching", async () => {
    const service = new ProductService(new MemoryCatalogRepository());
    const plan = await service.createPlan(tenantA, planInput([]));
    const customization = {
      version: 1,
      fields: [
        {
          key: "photo_upload",
          label: "Upload your photo",
          required: true,
          type: "image" as const,
          validation: {
            allowedMediaTypes: ["image/png" as const, "image/jpeg" as const],
            maxBytes: 10_000_000,
            maxFiles: 1,
          },
        },
      ],
    };

    await expect(
      service.updateCustomization(tenantA, plan.id, { customization }),
    ).resolves.toMatchObject({ customization });
    await service.transition(tenantA, plan.id, "pending_approval");
    await expect(
      service.updateCustomization(tenantA, plan.id, { customization }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

class MemoryCatalogRepository implements CatalogRepository {
  private readonly plans: ProductPlanRecord[] = [];
  private readonly spus: SpuRecord[] = [];
  private readonly skus: SkuRecord[] = [];

  async createPlan(context: TenantContext, input: ProductPlanInput) {
    const plan: ProductPlanRecord = {
      id: createEntityId(),
      tenantId: context.tenantId,
      status: "researching",
      ...input,
    };
    this.plans.push(plan);
    return plan;
  }
  async getPlan(context: TenantContext, id: string) {
    return this.plans.find((plan) => plan.tenantId === context.tenantId && plan.id === id);
  }
  async listPlans(context: TenantContext) {
    return this.plans.filter((plan) => plan.tenantId === context.tenantId);
  }
  async updatePlanCustomization(
    context: TenantContext,
    id: string,
    customization: ProductPlanRecord["customization"],
  ) {
    const plan = await this.getPlan(context, id);
    if (!plan) throw new Error("missing plan");
    plan.customization = customization;
    return plan;
  }
  async setPlanStatus(context: TenantContext, id: string, status: ProductStatus) {
    const plan = await this.getPlan(context, id);
    if (!plan) throw new Error("missing plan");
    plan.status = status;
    return plan;
  }
  async createSpu(context: TenantContext, plan: ProductPlanRecord, input: CreateSpuInput) {
    const spu: SpuRecord = {
      id: createEntityId(),
      tenantId: context.tenantId,
      productPlanId: plan.id,
      status: "developing",
      customization: plan.customization,
      ...input,
    };
    this.spus.push(spu);
    return spu;
  }
  async getSpu(context: TenantContext, id: string) {
    return this.spus.find((spu) => spu.tenantId === context.tenantId && spu.id === id);
  }
  async findSkuByCode(context: TenantContext, code: string) {
    return this.skus.find((sku) => sku.tenantId === context.tenantId && sku.code === code);
  }
  async createSku(context: TenantContext, input: CreateSkuInput) {
    const sku: SkuRecord = {
      id: createEntityId(),
      tenantId: context.tenantId,
      status: "draft",
      ...input,
    };
    this.skus.push(sku);
    return sku;
  }
}

async function approvedSpu(service: ProductService, tenant: TenantContext, code: string) {
  const plan = await service.createPlan(tenant, planInput([createEntityId()]));
  await service.transition(tenant, plan.id, "pending_approval");
  await service.transition(tenant, plan.id, "approved");
  return service.createSpu(tenant, plan.id, { code, name: code });
}

function planInput(sourceReportIds: string[]): ProductPlanInput {
  return {
    name: "Gift mug plan",
    sourceReportIds,
    targetCost: { amount: 12.5, currency: "USD" },
    customization: { version: 1, fields: [] },
  };
}

function context(): TenantContext {
  return {
    tenantId: createEntityId(),
    userId: createEntityId(),
    permissions: [],
    dataScope: "tenant",
  };
}
