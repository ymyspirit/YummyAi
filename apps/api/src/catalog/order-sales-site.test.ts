import { describe, expect, it } from "vitest";
import { OrderSalesSiteResolutionSchema } from "@yummyai/contracts/order/workspace";
import { orderSalesSiteIssue, resolveOrderSalesSite } from "./order-sales-site.js";

const us = "ATVPDKIKX0DER", ca = "A2EUQ1WTGCTBG2", orderId = "SYNTHETIC-SITE-ORDER";
const source = (overrides: Partial<Parameters<typeof resolveOrderSalesSite>[2][number]> = {}) => ({
  apiVersion: "2026-01-01", orderId, source: undefined, marketplaceId: us, ...overrides,
});

describe("order site evidence selection", () => {
  it.each([
    { name: "formal API", snapshots: [source()], reports: [], status: "resolved", marketplaceId: us },
    { name: "later formal source fills an initial gap", snapshots: [source({ marketplaceId: null }), source()], reports: [], status: "resolved", marketplaceId: us },
    { name: "source order identity is required", snapshots: [source({ orderId: "OTHER-ORDER" })], reports: [], status: "missing", marketplaceId: null },
    { name: "unknown adapter cannot supply a top-level site", snapshots: [source({ apiVersion: "unknown-adapter" })], reports: [], status: "missing", marketplaceId: null },
    { name: "whitespace is not a marketplace identity", snapshots: [source({ marketplaceId: " " })], reports: [], status: "missing", marketplaceId: null },
    { name: "non-string site is not evidence", snapshots: [source({ marketplaceId: { marketplaceId: us } })], reports: [], status: "missing", marketplaceId: null },
    { name: "manual report adapter source", snapshots: [source({ apiVersion: null, orderId: null, source: "amazon_manual_report" })], reports: [], status: "resolved", marketplaceId: us },
    { name: "successful report-only evidence", snapshots: [], reports: [us], status: "resolved", marketplaceId: us },
    { name: "duplicate consistent evidence", snapshots: [source(), source()], reports: [us, us], status: "resolved", marketplaceId: us },
    { name: "conflicting API updates never choose the newest", snapshots: [source(), source({ marketplaceId: ca })], reports: [], status: "conflict", marketplaceId: null },
    { name: "API and report conflict", snapshots: [source()], reports: [ca], status: "conflict", marketplaceId: null },
    { name: "conflicting report batches", snapshots: [], reports: [us, ca], status: "conflict", marketplaceId: null },
  ])("$name", ({ snapshots, reports, status, marketplaceId }) => {
    const result = resolveOrderSalesSite("amazon", orderId, snapshots, reports);
    expect(OrderSalesSiteResolutionSchema.parse(result)).toEqual({ status, marketplaceId });
    expect(orderSalesSiteIssue(result)?.code ?? null).toBe(status === "resolved" ? null : `order_site_${status}`);
  });

  it("keeps Etsy in its own platform domain despite unrelated Amazon-shaped data", () => {
    expect(resolveOrderSalesSite("etsy", orderId, [source(), source({ marketplaceId: ca })], [us, ca]))
      .toEqual({ status: "resolved", marketplaceId: "etsy" });
  });

  it("does not let a report marker masquerade as a supported platform", () => {
    expect(resolveOrderSalesSite("unsupported", orderId, [source({ source: "amazon_manual_report" })], [us]))
      .toEqual({ status: "missing", marketplaceId: null });
  });
});
