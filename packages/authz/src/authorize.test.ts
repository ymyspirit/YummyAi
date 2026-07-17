import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { authorize, ForbiddenError, Permission } from "./index.js";

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
      authorize(
        context({ dataScope: "team" }),
        Permission.CaptureWrite,
        { teamId: "019b0000-0000-7000-8000-000000000098" },
      ),
    ).toThrow(ForbiddenError);
  });

  it("denies a permission that is not granted", () => {
    expect(() => authorize(context(), Permission.ListingReview)).toThrow(ForbiddenError);
  });

  it("allows tenant-scoped access after the permission check", () => {
    expect(() =>
      authorize(
        context({ dataScope: "tenant" }),
        Permission.CaptureWrite,
        { ownerId: "019b0000-0000-7000-8000-000000000099" },
      ),
    ).not.toThrow();
  });
});
