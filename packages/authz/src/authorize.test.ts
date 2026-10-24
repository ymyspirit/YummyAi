import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { authorize, ForbiddenError, Permission, permissionContext } from "./index.js";

const tenantId = "019b0000-0000-7000-8000-000000000001";
const userId = "019b0000-0000-7000-8000-000000000002";
const teamId = "019b0000-0000-7000-8000-000000000003";

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId,
    userId,
    teamId,
    permissions: [Permission.CaptureWrite],
    dataScope: "self",
    ...overrides,
  };
}

describe("authorize", () => {
  it("uses the current team set and never resurrects a legacy team after membership withdrawal", () => {
    const member = context({
      dataScope: "team",
      teamIds: [teamId, "019b0000-0000-7000-8000-000000000004"],
    });
    expect(() =>
      authorize(member, Permission.CaptureWrite, {
        teamId: "019b0000-0000-7000-8000-000000000004",
      }),
    ).not.toThrow();
    expect(() =>
      authorize({ ...member, teamIds: [] }, Permission.CaptureWrite, { teamId }),
    ).toThrow(ForbiddenError);
  });
  it("denies a self-scoped user from editing another user's capture", () => {
    expect(() =>
      authorize(context(), Permission.CaptureWrite, {
        ownerId: "019b0000-0000-7000-8000-000000000099",
      }),
    ).toThrow(ForbiddenError);
  });

  it("allows a self-scoped user to edit their own capture", () => {
    expect(() => authorize(context(), Permission.CaptureWrite, { ownerId: userId })).not.toThrow();
  });

  it("denies a team-scoped user from another team", () => {
    expect(() =>
      authorize(context({ dataScope: "team" }), Permission.CaptureWrite, {
        teamId: "019b0000-0000-7000-8000-000000000098",
      }),
    ).toThrow(ForbiddenError);
  });

  it("denies a permission that is not granted", () => {
    expect(() => authorize(context(), Permission.ListingReview)).toThrow(ForbiddenError);
  });

  it("allows tenant-scoped access after the permission check", () => {
    expect(() =>
      authorize(context({ dataScope: "tenant" }), Permission.CaptureWrite, {
        ownerId: "019b0000-0000-7000-8000-000000000099",
      }),
    ).not.toThrow();
  });

  it("does not borrow tenant read scope for another permission's self writes", () => {
    const mixed = context({
      permissions: [Permission.ProductRead, Permission.ProductWrite],
      dataScope: "tenant",
      permissionScopes: { [Permission.ProductRead]: "tenant", [Permission.ProductWrite]: "self" },
    });
    const other = { ownerId: "019b0000-0000-7000-8000-000000000099" };
    expect(() => authorize(mixed, Permission.ProductRead, other)).not.toThrow();
    expect(() => authorize(mixed, Permission.ProductWrite, other)).toThrow(ForbiddenError);
    expect(permissionContext(mixed, Permission.ProductWrite).dataScope).toBe("self");
    expect(mixed.dataScope).toBe("tenant");
  });

  it("fails closed for missing ownership or an inconsistent pinned grant", () => {
    expect(() => authorize(context(), Permission.CaptureWrite, {})).toThrow(ForbiddenError);
    expect(() => authorize(context({ dataScope: "team" }), Permission.CaptureWrite, {})).toThrow(
      ForbiddenError,
    );
    expect(() => authorize(context({ permissionScopes: {} }), Permission.CaptureWrite)).toThrow(
      ForbiddenError,
    );
  });

  it("allows the object's owner or an explicitly matching team under a team grant", () => {
    const member = context({ dataScope: "team" });
    expect(() => authorize(member, Permission.CaptureWrite, { ownerId: userId })).not.toThrow();
    expect(() => authorize(member, Permission.CaptureWrite, { teamId })).not.toThrow();
    expect(() => authorize(member, Permission.CaptureWrite, { ownerId: "other" })).toThrow(
      ForbiddenError,
    );
  });
});
