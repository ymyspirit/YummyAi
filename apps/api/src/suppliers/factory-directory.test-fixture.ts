import { randomUUID } from "node:crypto";
import type { TenantContext } from "@yummyai/contracts";
import type { FactoryCapabilityProfile } from "@yummyai/contracts/suppliers/factory-directory";
import { syntheticFactoryProfile, syntheticFactoryCapability } from "../../../../tools/testing/factory-fixtures.js";
import type { FactoryDirectoryService } from "./factory-directory.service.js";

export async function createSyntheticFactory(service: FactoryDirectoryService, context: TenantContext, supplierId: string, productType: FactoryCapabilityProfile["productType"] = "other", name?: string) {
  const factory = await service.create(context, { supplierId, code: `TEST-${randomUUID()}`, profile: syntheticFactoryProfile(name), idempotencyKey: randomUUID() });
  const capability = await service.createCapability(context, factory.id, { profile: syntheticFactoryCapability(productType), idempotencyKey: randomUUID() });
  return { factory, capability, pins: { factoryId: factory.id, factoryVersionId: factory.versionId, capabilityVersionId: capability.versionId } };
}
