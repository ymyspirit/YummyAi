import { createHash } from "node:crypto";
import type { modelProviderConfigs, modelRoutes } from "@yummyai/database";

export type ModelConfigurationRevisionProvider = Pick<typeof modelProviderConfigs.$inferSelect, "id" | "updatedAt">;
export type ModelConfigurationRevisionRoute = Pick<typeof modelRoutes.$inferSelect, "id" | "updatedAt" | "status" | "targets" | "modelKey" | "taskType">;

/** Shared by channel configuration and Studio selections; no credential is read. */
export function modelConfigurationRevision(
  provider: ModelConfigurationRevisionProvider,
  routes: readonly ModelConfigurationRevisionRoute[],
): string {
  const related = routes
    .filter(route => route.targets.some(target => target.providerConfigId.toLowerCase() === provider.id.toLowerCase()))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  // Preserve the channel's existing revision fields and target priority order.
  // Sorting a new array prevents database row order from changing the revision.
  return createHash("sha256").update(JSON.stringify([
    provider.updatedAt,
    related.map(route => [route.id, route.updatedAt, route.status, route.targets, route.modelKey, route.taskType]),
  ])).digest("hex");
}
