import { describe, expect, it } from "vitest";

import { TenantContextSchema } from "../index.js";

describe("TenantContextSchema", () => {
  it("rejects a tenant context without a UUID tenant", () => {
    expect(
      TenantContextSchema.safeParse({
        tenantId: "x",
        userId: "550e8400-e29b-41d4-a716-446655440000",
        permissions: [],
        dataScope: "self",
      }).success,
    ).toBe(false);
  });
});
