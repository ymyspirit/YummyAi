import { BadRequestException } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";
import { factoryCursor, nextFactoryCursor, resolveFactoryCursor } from "./factory-pagination.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
describe("factory pagination preserves the visible immutable PostgreSQL anchor", () => {
  it("preserves distinct microseconds and resolves an original millisecond token from the exact visible anchor", () => {
    const first = { id: createEntityId(), createdAtExact: "2026-10-22T03:04:05.123900Z" },
      second = { id: createEntityId(), createdAtExact: "2026-10-22T03:04:05.123800Z" };
    const exact = factoryCursor(nextFactoryCursor(first, true)!);
    expect(exact).toEqual({ id: first.id, at: first.createdAtExact });
    expect(resolveFactoryCursor(exact, first)).toEqual(exact);
    expect(factoryCursor(nextFactoryCursor(second, true)!)?.at).not.toBe(exact?.at);
    const legacy = factoryCursor(encode({ id: first.id, at: "2026-10-22T03:04:05.123Z" }));
    expect(resolveFactoryCursor(legacy, first)).toEqual({ id: first.id, at: first.createdAtExact });
    expect(nextFactoryCursor(first, false)).toBeNull(); expect(resolveFactoryCursor(null, undefined)).toBeNull();
  });

  it("rejects missing foreign changed or malformed anchors instead of flooring into a gap or accepting another filter set", () => {
    const anchor = { id: createEntityId(), createdAtExact: "2026-10-22T03:04:05.123900Z" };
    const legacy = factoryCursor(encode({ id: anchor.id, at: "2026-10-22T03:04:05.123Z" }));
    for (const invalid of [undefined, { ...anchor, id: createEntityId() }, { ...anchor, createdAtExact: "2026-10-22T03:04:05.124900Z" },
      { ...anchor, createdAtExact: "2026-10-22T03:04:05.123Z" }]) expect(() => resolveFactoryCursor(legacy, invalid)).toThrow(BadRequestException);
    for (const invalid of ["!not-base64", encode({ id: anchor.id, at: anchor.createdAtExact, tenantId: createEntityId() }),
      encode({ id: anchor.id, at: "2026-10-22T03:04:05.1239001Z" }), encode({ id: "not-an-id", at: anchor.createdAtExact })])
      expect(() => factoryCursor(invalid)).toThrow(BadRequestException);
  });
});
