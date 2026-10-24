import { randomUUID } from "node:crypto";
import type { FactoryView, FactoryProfile, FactoryCapabilityView, FactoryCapabilityProfile } from "@yummyai/contracts/suppliers/factory-directory";
import { syntheticFactoryProfile, syntheticFactoryCapability } from "../../../tools/testing/factory-fixtures";
import { centerApi } from "./order-centers-fixture";

export async function createFactoryFixture(supplierId: string, productType: FactoryCapabilityProfile["productType"], name: string, profile?: FactoryProfile) {
  const factory = await centerApi<FactoryView>("sourcing/factories", { supplierId, code: `TEST-${randomUUID()}`, profile: profile ?? syntheticFactoryProfile(name), idempotencyKey: randomUUID() });
  const capability = await centerApi<FactoryCapabilityView>(`sourcing/factories/${factory.id}/capabilities`, { profile: syntheticFactoryCapability(productType), idempotencyKey: randomUUID() });
  return { factory, capability, pins: { factoryId: factory.id, factoryVersionId: factory.versionId, capabilityVersionId: capability.versionId } };
}
