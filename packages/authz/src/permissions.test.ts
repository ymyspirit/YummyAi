import { describe, expect, it } from "vitest";
import { erpPermissionContext, erpPermissions, Permission } from "./permissions.js";
import type { TenantContext } from "@yummyai/contracts";
import { requireTenantOrderPermissions } from "./authorize.js";
describe("ordinary ERP authority projection", () => {
  it("matches ERP session grants while excluding factory-only and unknown grants", () => {
    const grants = [
      Permission.FactoryTaskRead,
      Permission.ProductWrite,
      "unregistered",
      Permission.FactoryTaskRespond,
      Permission.ProductRead,
    ];
    expect(erpPermissions(grants)).toEqual([Permission.ProductRead, Permission.ProductWrite]);
    expect(grants[0]).toBe(Permission.FactoryTaskRead);
  });
  it("matches the personal session projection while preserving the owner and team evidence", () => {
    const owner: TenantContext = { tenantId: "tenant", userId: "operator", dataScope: "tenant", permissions: [Permission.FactoryTaskRead, Permission.OrderWrite, Permission.FactoryTaskRespond, Permission.OrderRead],
      permissionScopes: { [Permission.FactoryTaskRead]: "tenant", [Permission.FactoryTaskRespond]: "tenant", [Permission.OrderRead]: "tenant", [Permission.OrderWrite]: "self" },
      teamIds: ["team"], teamAuthority: "a".repeat(64) };
    const before = structuredClone(owner), view = erpPermissionContext(owner);
    expect(view).toEqual({ ...owner, permissions: [Permission.OrderRead, Permission.OrderWrite], permissionScopes: { [Permission.OrderRead]: "tenant", [Permission.OrderWrite]: "self" } });
    expect(owner).toEqual(before); expect(owner.permissions).toContain(Permission.FactoryTaskRespond); expect(view.teamAuthority).toBe(owner.teamAuthority);
  });
  it("keeps per-operation self scope despite a tenant factory grant and a tenant ERP read", () => {
    const view = erpPermissionContext({ tenantId: "tenant", userId: "operator", dataScope: "tenant", permissions: [Permission.FactoryTaskRespond, Permission.OrderRead, Permission.OrderWrite],
      permissionScopes: { [Permission.FactoryTaskRespond]: "tenant", [Permission.OrderRead]: "tenant", [Permission.OrderWrite]: "self" } });
    expect(() => requireTenantOrderPermissions(view, [Permission.OrderRead])).not.toThrow();
    expect(() => requireTenantOrderPermissions(view, [Permission.OrderWrite])).toThrow();
    expect(view.permissionScopes).not.toHaveProperty(Permission.FactoryTaskRespond);
  });
  it("retains the explicit legacy no-map credential ceiling without manufacturing a permission map", () => {
    const owner: TenantContext = { tenantId: "tenant", userId: "operator", dataScope: "tenant", permissions: [Permission.OrderRead, Permission.FactoryTaskRead] };
    const view = erpPermissionContext(owner); expect(view.permissions).toEqual([Permission.OrderRead]); expect(view).not.toHaveProperty("permissionScopes");
    expect(() => requireTenantOrderPermissions(view, [Permission.OrderRead])).not.toThrow(); expect(owner.permissions).toHaveLength(2);
  });
});
