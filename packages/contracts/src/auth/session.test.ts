import { describe, expect, it } from "vitest";
import { ErpSessionViewSchema, erpSessionAuthority } from "./session.js";

const session = ErpSessionViewSchema.parse({
  authenticated: true,
  canUseErp: true,
  tenantId: "019b0000-0000-7000-8000-000000000001",
  userId: "019b0000-0000-7000-8000-000000000002",
  displayName: "Synthetic member",
  organizationName: "Synthetic tenant",
  permissions: ["product:read", "product:write"],
  dataScope: "tenant",
  permissionScopes: { "product:read": "tenant", "product:write": "tenant" },
});

describe("ERP session authority", () => {
  it("pins team membership and its revision even when ordinary permissions stay unchanged", () => {
    const first = { ...session, teamIds: [session.tenantId], teamAuthority: "a".repeat(64) };
    expect(erpSessionAuthority({ ...first, teamAuthority: "b".repeat(64) })).not.toBe(
      erpSessionAuthority(first),
    );
    expect(erpSessionAuthority({ ...first, teamIds: [] })).not.toBe(erpSessionAuthority(first));
  });
  it("changes when one operation narrows although permissions and the aggregate stay identical", () => {
    expect(
      erpSessionAuthority({
        ...session,
        permissionScopes: { ...session.permissionScopes, "product:write": "self" },
      }),
    ).not.toBe(erpSessionAuthority(session));
  });
  it("is stable across grant and permission ordering", () => {
    expect(
      erpSessionAuthority({
        ...session,
        permissions: [...session.permissions].reverse(),
        permissionScopes: { "product:write": "tenant", "product:read": "tenant" },
      }),
    ).toBe(erpSessionAuthority(session));
  });
});
