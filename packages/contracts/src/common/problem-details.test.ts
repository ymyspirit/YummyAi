import { describe, expect, it } from "vitest";

import {
  EntityIdSchema,
  PageRequestSchema,
  PageResultSchema,
  ProblemDetailsSchema,
} from "../index.js";

describe("ProblemDetailsSchema", () => {
  it("requires RFC 9457 problem fields", () => {
    expect(
      ProblemDetailsSchema.parse({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
      }),
    ).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
    });
  });

  it("rejects non-error HTTP statuses", () => {
    expect(
      ProblemDetailsSchema.safeParse({
        type: "about:blank",
        title: "OK",
        status: 200,
      }).success,
    ).toBe(false);
  });
});

describe("common schemas", () => {
  it("accepts only UUIDv7 entity identifiers", () => {
    expect(EntityIdSchema.safeParse("not-an-id").success).toBe(false);
    expect(
      EntityIdSchema.safeParse("0190a5c0-7b6d-7f8e-8c9d-0123456789ab")
        .success,
    ).toBe(true);
    expect(
      EntityIdSchema.safeParse("550e8400-e29b-41d4-a716-446655440000")
        .success,
    ).toBe(false);
  });

  it("defaults cursor page size and caps it at 100", () => {
    expect(PageRequestSchema.parse({})).toEqual({ limit: 20 });
    expect(PageRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("represents an opaque next cursor", () => {
    expect(PageResultSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
