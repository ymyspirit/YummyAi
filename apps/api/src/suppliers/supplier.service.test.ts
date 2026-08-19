import { createEntityId, type SupplierCandidateInput, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { SupplierService, type SupplierCandidateRecord, type SupplierRepository } from "./supplier.service.js";

describe("SupplierService", () => {
  it("orders candidates by priority and preserves quoted cost currency", async () => {
    const repository = new MemorySupplierRepository();
    const service = new SupplierService(repository);
    const context = tenant();
    const productPlanId = createEntityId();
    await service.addCandidate(context, { productPlanId, name: "Backup", priority: 3, quotedCost: { amount: 9, currency: "USD" } });
    await service.addCandidate(context, { productPlanId, name: "Preferred", priority: 1, quotedCost: { amount: 10, currency: "USD" } });
    const candidates = await service.listCandidates(context, productPlanId);
    expect(candidates.map((candidate) => candidate.name)).toEqual(["Preferred", "Backup"]);
    expect(candidates[0]?.quotedCost).toEqual({ amount: 10, currency: "USD" });
  });

  it("isolates candidate lists by tenant", async () => {
    const service = new SupplierService(new MemorySupplierRepository());
    const first = tenant();
    const second = tenant();
    const productPlanId = createEntityId();
    await service.addCandidate(first, { productPlanId, name: "First supplier", priority: 1 });
    await expect(service.listCandidates(second, productPlanId)).resolves.toEqual([]);
  });
});

class MemorySupplierRepository implements SupplierRepository {
  private readonly candidates: SupplierCandidateRecord[] = [];
  async create(context: TenantContext, input: SupplierCandidateInput) {
    const candidate: SupplierCandidateRecord = { id: createEntityId(), tenantId: context.tenantId, status: "candidate", ...input };
    this.candidates.push(candidate);
    return candidate;
  }
  async list(context: TenantContext, productPlanId: string) {
    return this.candidates
      .filter((candidate) => candidate.tenantId === context.tenantId && candidate.productPlanId === productPlanId)
      .sort((left, right) => left.priority - right.priority || (left.quotedCost?.amount ?? Infinity) - (right.quotedCost?.amount ?? Infinity));
  }
}

function tenant(): TenantContext {
  return { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };
}
