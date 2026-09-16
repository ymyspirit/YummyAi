import { describe, expect, it } from "vitest";
import { readQueue, returnHref, workflowHref } from "./workflow-href";

describe("workflow return destinations", () => {
  it("keeps ERP object filters and a bounded chain of prerequisite returns", () => {
    expect(returnHref("/products?plan=example#product-suppliers")).toBe(
      "/products?plan=example#product-suppliers",
    );
    expect(returnHref("/orders?q=a&line=one&returnTo=https%3A%2F%2Foutside.invalid")).toBe(
      "/orders?q=a&line=one",
    );
    expect(returnHref("/process-library?returnTo=%2Fproduct-specifications")).toBe(
      "/process-library?returnTo=%2Fproduct-specifications",
    );
    const url = new URL(
      workflowHref("/production?line=one", "/orders?q=a&line=one"),
      "https://erp.invalid",
    );
    expect(url.searchParams.get("returnTo")).toBe("/orders?q=a&line=one");
  });
  it("rejects outside URLs, API actions and malformed or unbounded queues", () => {
    for (const value of [
      "https://outside.invalid",
      "//outside.invalid",
      "/\\outside.invalid",
      "/api/logout",
      "/orders\n",
    ])
      expect(returnHref(value)).toBeNull();
    expect(readQueue("a,b,c", "b")).toEqual(["a", "b", "c"]);
    expect(readQueue("a,b,c", "z")).toBeNull();
    expect(readQueue("a,../../x", "a")).toBeNull();
    expect(
      readQueue(Array.from({ length: 101 }, (_, n) => `id-${n}`).join(","), "id-0"),
    ).toBeNull();
  });
});
