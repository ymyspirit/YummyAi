import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const DataScopeSchema = z.enum(["self", "team", "tenant"]);
export const PermissionScopesSchema = z.record(z.string().min(1).max(128), DataScopeSchema);

export const TenantContextSchema = z.object({
  tenantId: EntityIdSchema,
  userId: EntityIdSchema,
  teamId: EntityIdSchema.optional(),
  teamIds: z.array(EntityIdSchema).max(200).readonly().optional(),
  teamAuthority: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  permissions: z.array(z.string()).readonly(),
  dataScope: DataScopeSchema,
  // Absent only in legacy/internal contexts. Authenticated memberships pin each
  // permission's own scope; the aggregate is display/compatibility metadata.
  permissionScopes: PermissionScopesSchema.optional(),
});

export type TenantContext = z.infer<typeof TenantContextSchema>;
