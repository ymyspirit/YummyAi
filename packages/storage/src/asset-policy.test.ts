import type { TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import {
  assertAssetAccess,
  isSignedUrlExpired,
  objectKey,
  type StoredAsset,
} from "./index.js";

const context: TenantContext = {
  tenantId: "019b0000-0000-7000-8000-000000000001",
  userId: "019b0000-0000-7000-8000-000000000002",
  permissions: ["asset:read"],
  dataScope: "tenant",
};

function asset(overrides: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id: "019b0000-0000-7000-8000-000000000003",
    tenantId: context.tenantId,
    assetDomain: "research",
    objectKey: `tenants/${context.tenantId}/research/${"a".repeat(64)}/sample.png`,
    ...overrides,
  };
}

describe("asset storage policy", () => {
  it("does not sign a research object as an authorized asset", () => {
    expect(() => assertAssetAccess(context, asset(), "authorized")).toThrow();
  });

  it("denies an object owned by another tenant", () => {
    const tenantId = "019b0000-0000-7000-8000-000000000099";
    expect(() =>
      assertAssetAccess(
        context,
        asset({ tenantId, objectKey: `tenants/${tenantId}/research/${"a".repeat(64)}/sample.png` }),
        "research",
      ),
    ).toThrow();
  });

  it("builds deterministic safe private keys", () => {
    expect(
      objectKey({
        tenantId: context.tenantId,
        domain: "authorized",
        sha256: "A".repeat(64),
        fileName: "my unsafe/设计.png",
      }),
    ).toBe(
      `tenants/${context.tenantId}/authorized/${"a".repeat(64)}/my_unsafe___.png`,
    );
  });

  it("detects an expired AWS-style signed URL", () => {
    const url = "https://storage.test/file?X-Amz-Date=20260718T010000Z&X-Amz-Expires=600";
    expect(isSignedUrlExpired(url, new Date("2026-07-18T01:10:01Z"))).toBe(true);
    expect(isSignedUrlExpired(url, new Date("2026-07-18T01:09:59Z"))).toBe(false);
  });
});
