import { randomUUID } from "node:crypto";
import { expect, type Locator } from "@playwright/test";
import { FactoryCapacityPoolViewSchema, FactoryCapacityWorkspaceSchema, ResolvedFactoryLocalTimeSchema,
  type FactoryCapacityPoolView, type ProductionCapacityPlan } from "@yummyai/contracts/suppliers/factory-capacity";
import type { FactoryCapabilityView, FactoryView } from "@yummyai/contracts/suppliers/factory-directory";
import { syntheticFactoryCapacityProfile } from "../../../tools/testing/factory-capacity-fixtures";
import { centerApi } from "./order-centers-fixture";

/** Explicit finite synthetic capacity, never a booking or an inferred factory confirmation. */
export async function createCapacityFixture(factory: FactoryView, capabilities: FactoryCapabilityView[], capacityUnits: number) {
  const before = FactoryCapacityWorkspaceSchema.parse(await centerApi(`sourcing/factories/${factory.id}/capacity?days=1`));
  if (!factory.profile.timeZone) throw new Error("Synthetic capacity requires the actual factory timezone");
  const pool = FactoryCapacityPoolViewSchema.parse(await centerApi(`sourcing/factories/${factory.id}/capacity-pools`, {
    factoryVersionId: factory.versionId, code: `SYNTHETIC-${randomUUID()}`, timeZone: factory.profile.timeZone, unit: "each",
    profile: syntheticFactoryCapacityProfile(capabilities.map(item => ({ capabilityVersionId: item.versionId, unitsPerItem: 1 })), capacityUnits), idempotencyKey: randomUUID(),
  }));
  const localDate = before.from, next = new Date(`${localDate}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1);
  const dueLocal = `${next.toISOString().slice(0, 10)}T00:00`;
  const resolved = ResolvedFactoryLocalTimeSchema.parse(await centerApi(`sourcing/factories/${factory.id}/capacity/resolve-time`, { factoryVersionId: factory.versionId, localDateTime: dueLocal }));
  const capacityPlan: ProductionCapacityPlan = { allocations: [{ poolId: pool.id, poolVersionId: pool.versionId, localDate }] };
  return { pool, localDate, capacityPlan, dueLocal, expectedCompletionAt: resolved.instant };
}

/** Uses the real visible picker; readiness always comes from a real server preview. */
export async function fillProductionCapacity(form: Locator, value: { pool: FactoryCapacityPoolView; localDate: string }, count = 1) {
  const picker = form.getByRole("region", { name: "本次生产产能安排", exact: true });
  for (let index = 0; index < count; index++) await picker.getByLabel(`项目${index + 1} ${value.pool.profile.name}当地生产日期`, { exact: true }).fill(value.localDate);
  const preview = picker.getByRole("button", { name: "核对本批产能与当地完工时间", exact: true });
  await expect(preview).toBeEnabled(); await preview.click();
  await expect(picker.getByRole("region", { name: "本批产能核对结果", exact: true })).toContainText("本次预览可预约 尚未占用产能");
}
