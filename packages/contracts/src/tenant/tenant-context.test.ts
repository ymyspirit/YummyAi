import { describe, expect, it } from "vitest";

import { TenantContextSchema } from "../index.js";

describe("TenantContextSchema", () => {
  it("rejects a tenant context without a UUID tenant", () => {
    expect(
      TenantContextSchema.safeParse({
        tenantId: "x",
        userId: "0190a5c0-7b6d-7f8e-8c9d-0123456789ab",
        permissions: [],
        dataScope: "self",
      }).success,
    ).toBe(false);
  });
});
