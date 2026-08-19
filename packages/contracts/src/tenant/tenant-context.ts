import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const TenantContextSchema = z.object({
  tenantId: EntityIdSchema,
  userId: EntityIdSchema,
  teamId: EntityIdSchema.optional(),
  permissions: z.array(z.string()).readonly(),
  dataScope: z.enum(["self", "team", "tenant"]),
});

export type TenantContext = z.infer<typeof TenantContextSchema>;
