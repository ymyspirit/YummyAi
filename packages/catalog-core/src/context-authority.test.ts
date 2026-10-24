import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { catalogContextAuthority } from "./access.js";
describe("catalog authority matches ordinary ERP identity", () => {
  it("projects factory-only grants out of the ordinary session fingerprint", () => {
    const context: TenantContext = {
      tenantId: createEntityId(),
      userId: createEntityId(),
      dataScope: "tenant",
      permissions: [Permission.FactoryTaskRead, Permission.ProductRead],
      permissionScopes: {
        [Permission.FactoryTaskRead]: "tenant",
        [Permission.ProductRead]: "self",
      },
    };
    expect(catalogContextAuthority(context)).toBe(
      erpSessionAuthority({
        ...context,
        permissions: [Permission.ProductRead],
        permissionScopes: { [Permission.ProductRead]: "self" },
      }),
    );
    expect(catalogContextAuthority(context)).not.toBe(
      catalogContextAuthority({
        ...context,
        permissionScopes: { ...context.permissionScopes, [Permission.ProductRead]: "tenant" },
      }),
    );
  });
});
