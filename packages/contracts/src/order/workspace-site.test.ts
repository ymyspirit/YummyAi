import { describe, expect, it } from "vitest";
import { OrderSalesSiteResolutionSchema, OrderWorkDetailViewSchema } from "./workspace.js";

describe("order channel site evidence boundary", () => {
  it("represents a derived site without transporting private source payloads", () => {
    expect(OrderSalesSiteResolutionSchema.parse({ status: "resolved", marketplaceId: "ATVPDKIKX0DER" }))
      .toEqual({ status: "resolved", marketplaceId: "ATVPDKIKX0DER" });
    expect(OrderSalesSiteResolutionSchema.parse({ status: "resolved", marketplaceId: "etsy" }).marketplaceId).toBe("etsy");
    expect(OrderSalesSiteResolutionSchema.safeParse({ status: "resolved", marketplaceId: "ATVPDKIKX0DER", rawPayload: {} }).success).toBe(false);
  });

  it("cannot label an unresolved order with a guessed marketplace", () => {
    for (const status of ["missing", "conflict"] as const) {
      expect(OrderSalesSiteResolutionSchema.parse({ status, marketplaceId: null })).toEqual({ status, marketplaceId: null });
      expect(OrderSalesSiteResolutionSchema.safeParse({ status, marketplaceId: "ATVPDKIKX0DER" }).success).toBe(false);
    }
    for (const marketplaceId of [null, undefined, "", " \t\n", "x".repeat(101)])
      expect(OrderSalesSiteResolutionSchema.safeParse({ status: "resolved", marketplaceId }).success).toBe(false);
  });

  it("keeps existing detail responses readable while preserving a supplied conflict", () => {
    const view = OrderWorkDetailViewSchema.shape.catalog.unwrap().pick({ site: true });
    expect(view.parse({})).toEqual({});
    expect(view.parse({ site: { status: "conflict", marketplaceId: null } })).toEqual({ site: { status: "conflict", marketplaceId: null } });
  });
});
