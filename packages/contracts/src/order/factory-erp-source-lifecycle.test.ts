import { describe, expect, it } from "vitest";
import { FactoryErpSourceLifecycleSchema } from "./factory-erp-import.js";
const id = "019f7600-0000-7000-8000-000000000001";
const source = () => ({ id, factoryId: id, fileChecksum: "a".repeat(64), byteSize: 100, templateVersion: "pillow-erp-2026-10-21-v1",
  previewChecksum: "b".repeat(64), createdAt: "2026-10-21T00:00:00.000Z", expiresAt: "2026-11-20T00:00:00.000Z", checkedAt: "2026-10-22T00:00:00.000Z",
  access: "retained", privateRedactedAt: null, purgeStatus: "not_due", attempts: 0, nextAttemptAt: null, purgedAt: null, lastApplicationId: null });
describe("private source lifecycle receipts", () => {
  it("rejects private data and internal storage pointers in a public lifecycle receipt", () => {
    for (const extra of [{ fileName: "private.xlsx" }, { rawCells: ["private"] }, { objectKey: "private" }, { leaseToken: id }])
      expect(FactoryErpSourceLifecycleSchema.safeParse({ ...source(), ...extra }).success).toBe(false);
  });
  it("does not equate an expired access window with a confirmed object deletion", () => {
    const expired = { ...source(), access: "expired", checkedAt: "2026-11-21T00:00:00.000Z", purgeStatus: "pending" };
    expect(FactoryErpSourceLifecycleSchema.safeParse(expired).success).toBe(true);
    expect(FactoryErpSourceLifecycleSchema.safeParse({ ...expired, purgeStatus: "purged" }).success).toBe(false);
    expect(FactoryErpSourceLifecycleSchema.safeParse({ ...source(), access: "expired", purgeStatus: "pending" }).success).toBe(false);
  });
  it("requires both database redaction and the independently completed object receipt", () => {
    const done = { ...source(), access: "expired", checkedAt: "2026-11-21T00:00:00.000Z", purgeStatus: "purged", privateRedactedAt: "2026-11-20T00:01:00.000Z", purgedAt: "2026-11-20T00:02:00.000Z", attempts: 2 };
    expect(FactoryErpSourceLifecycleSchema.safeParse(done).success).toBe(true);
    expect(FactoryErpSourceLifecycleSchema.safeParse({ ...done, privateRedactedAt: null }).success).toBe(false);
    expect(FactoryErpSourceLifecycleSchema.safeParse({ ...done, purgedAt: "2026-11-20T00:00:00.000Z" }).success).toBe(false);
  });
  it("cannot resurrect an erased source after clock correction", () => {
    const erased = { ...source(), access: "expired", purgeStatus: "pending", privateRedactedAt: "2026-11-20T00:01:00.000Z" };
    expect(FactoryErpSourceLifecycleSchema.safeParse(erased).success).toBe(true);
    expect(FactoryErpSourceLifecycleSchema.safeParse({ ...erased, access: "retained", purgeStatus: "not_due" }).success).toBe(false);
  });
});
