import { InventoryWorkspaceViewSchema, type InventoryWorkspaceView } from "@yummyai/contracts/inventory";

const internalFields = ["tenantId", "createdBy", "recordedBy", "idempotencyKey"];

export function parseInventoryWorkspaceResponse(value: unknown): InventoryWorkspaceView {
  const workspace = InventoryWorkspaceViewSchema.parse(value);
  // The shared schema validates these collections; inspect original records before stripping unknown fields.
  const source = value as Record<keyof InventoryWorkspaceView, Record<string, unknown>[]>;
  for (const key of Object.keys(workspace) as (keyof InventoryWorkspaceView)[]) {
    for (const item of source[key]) {
      if (internalFields.some(field => field in item)) throw new TypeError("库存 API 返回了内部租户或幂等字段。");
    }
  }
  return workspace;
}
