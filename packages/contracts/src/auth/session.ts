import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  DataScopeSchema,
  PermissionScopesSchema,
  type TenantContext,
} from "@yummyai/contracts/tenant/tenant-context";
export const ErpSessionViewSchema = z
  .object({
    authenticated: z.literal(true),
    canUseErp: z.boolean(),
    userId: EntityIdSchema,
    tenantId: EntityIdSchema,
    displayName: z.string().max(500),
    organizationName: z.string().max(500),
    permissions: z.array(z.string().min(1).max(128)).max(256),
    dataScope: DataScopeSchema,
    permissionScopes: PermissionScopesSchema.optional(),
    teamIds: z.array(EntityIdSchema).max(200).optional(),
    teamAuthority: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const ErpSessionQuerySchema = z.object({}).strict();
export type ErpSessionView = z.infer<typeof ErpSessionViewSchema>;
export function erpSessionAuthority(
  view: Pick<
    TenantContext,
    | "tenantId"
    | "userId"
    | "permissions"
    | "dataScope"
    | "permissionScopes"
    | "teamIds"
    | "teamAuthority"
  >,
) {
  return JSON.stringify({
    tenantId: view.tenantId,
    userId: view.userId,
    permissions: [...view.permissions].sort(),
    dataScope: view.dataScope,
    teamIds: view.teamIds && [...view.teamIds].sort(),
    teamAuthority: view.teamAuthority,
    permissionScopes:
      view.permissionScopes &&
      Object.fromEntries(
        Object.entries(view.permissionScopes).sort(([a], [b]) => a.localeCompare(b)),
      ),
  });
}

const ErpAuthorityPayloadSchema = ErpSessionViewSchema.omit({
  authenticated: true,
  canUseErp: true,
  displayName: true,
  organizationName: true,
});

/** An authority stamp describes a response's membership ceiling, never a credential. */
export const ErpContextAuthoritySchema = z.string().max(131072).superRefine((value, context) => {
  try {
    const parsed = ErpAuthorityPayloadSchema.safeParse(JSON.parse(value));
    if (parsed.success && erpSessionAuthority(parsed.data) === value) return;
  } catch { /* Invalid JSON is rejected below. */ }
  context.addIssue({ code: "custom", message: "Invalid ERP context authority" });
});
