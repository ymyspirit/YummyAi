import { describe, expect, it } from "vitest";
import { intersectPermissionContexts, summarizeRoleGrants } from "./role-grants.js";
import type { TenantContext } from "@yummyai/contracts";

describe("permission-specific role grants", () => {
  it("keeps tenant reads and self writes separate regardless of role order", () => {
    const grants = [
      { permissions: ["product:read", "capture:read"], scope: "tenant" },
      { permissions: ["product:write"], scope: "self" },
    ];
    const expected = {
      permissions: ["capture:read", "product:read", "product:write"],
      dataScope: "tenant",
      permissionScopes: {
        "capture:read": "tenant",
        "product:read": "tenant",
        "product:write": "self",
      },
    };
    expect(summarizeRoleGrants(grants)).toEqual(expected);
    expect(summarizeRoleGrants([...grants].reverse())).toEqual(expected);
  });

  it("unions broader grants for the same permission only", () => {
    expect(
      summarizeRoleGrants([
        { permissions: ["product:read", "product:write"], scope: "self" },
        { permissions: ["product:read"], scope: "team" },
        { permissions: ["finance:read"], scope: "tenant" },
      ]).permissionScopes,
    ).toEqual({ "finance:read": "tenant", "product:read": "team", "product:write": "self" });
  });

  it("does not gain grants from an empty or invalid role", () => {
    expect(
      summarizeRoleGrants([
        { permissions: [], scope: "tenant" },
        { permissions: ["product:write"], scope: "invalid" },
      ]),
    ).toEqual({ permissions: [], permissionScopes: {}, dataScope: "self" });
  });
});

describe("request ceiling and current permission intersection", () => {
  const actor: TenantContext = {
    tenantId: "00000000-0000-7000-8000-000000000001",
    userId: "00000000-0000-7000-8000-000000000002",
    permissions: ["order:read", "order:write", "notification:read"],
    dataScope: "tenant",
  };
  it("keeps an earlier narrow write ceiling after current grants widen", () => {
    const input = {
      ...actor,
      permissionScopes: {
        "order:read": "tenant" as const,
        "order:write": "self" as const,
        "notification:read": "self" as const,
      },
    };
    expect(intersectPermissionContexts(input, actor).permissionScopes).toEqual(
      input.permissionScopes,
    );
  });
  it("takes current narrowing and revocation without borrowing unrelated tenant scope", () => {
    const current: TenantContext = {
      ...actor,
      permissions: ["order:read", "notification:read"],
      permissionScopes: { "order:read": "self", "notification:read": "tenant" },
    };
    expect(intersectPermissionContexts(actor, current)).toMatchObject({
      permissions: ["notification:read", "order:read"],
      permissionScopes: { "order:read": "self", "notification:read": "tenant" },
    });
  });
  it("never grants a permission missing from the original request ceiling", () => {
    expect(
      intersectPermissionContexts({ ...actor, permissions: ["order:read"] }, actor).permissions,
    ).toEqual(["order:read"]);
  });
  it("fails closed for a permission omitted by a supplied scope map", () => {
    expect(
      intersectPermissionContexts({ ...actor, permissionScopes: { "order:read": "tenant" } }, actor)
        .permissions,
    ).toEqual(["order:read"]);
  });
  it("retains only teams trusted by both contexts, including a legacy single team", () => {
    expect(
      intersectPermissionContexts(
        { ...actor, teamId: "team-a" },
        { ...actor, teamIds: ["team-a", "team-b"] },
      ).teamIds,
    ).toEqual(["team-a"]);
    expect(
      intersectPermissionContexts({ ...actor, teamIds: [] }, { ...actor, teamId: "team-a" })
        .teamIds,
    ).toEqual([]);
  });
  it("rejects cross-tenant and cross-user context composition", () => {
    expect(() =>
      intersectPermissionContexts(actor, {
        ...actor,
        tenantId: "00000000-0000-7000-8000-000000000003",
      }),
    ).toThrow("different identities");
    expect(() =>
      intersectPermissionContexts(actor, {
        ...actor,
        userId: "00000000-0000-7000-8000-000000000004",
      }),
    ).toThrow("different identities");
  });
});
