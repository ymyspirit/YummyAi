import type { OrderPersonalizationCandidate } from "@yummyai/contracts/pod/order-personalization";
import { describe, expect, it } from "vitest";

import {
  candidateSelectionValue,
  parseOrderPersonalizationCandidateCsv,
} from "./pod-order-personalization-table-import";

describe("order personalization table import", () => {
  it("matches safe order identifiers and uses size to resolve a template", () => {
    const candidates = [candidate({ sizeLabel: "S", bindingId: id(5) }), candidate({ sizeLabel: "M", bindingId: id(6) })];
    const result = parseOrderPersonalizationCandidateCsv(
      "\uFEFFexternal_order_id,external_line_id,size_label\r\nORDER-1,LINE-1,M\r\n",
      candidates,
    );

    expect(result).toEqual({
      diagnostics: [],
      matchedValues: [candidateSelectionValue(candidates[1]!)],
      rowCount: 1,
    });
  });

  it("keeps valid rows and returns stable diagnostics for ambiguous, blocked, unknown, and duplicate rows", () => {
    const candidates = [
      candidate({ sizeLabel: "S", bindingId: id(5) }),
      candidate({ sizeLabel: "M", bindingId: id(6) }),
      candidate({ externalOrderId: "ORDER-2", externalLineId: "LINE-2", orderLineId: id(12), bindingId: id(15) }),
      candidate({ externalOrderId: "ORDER-3", externalLineId: "LINE-3", orderLineId: id(13), bindingId: undefined, eligible: false }),
    ];
    const result = parseOrderPersonalizationCandidateCsv([
      "external_order_id,external_line_id,size_label",
      "ORDER-1,LINE-1,",
      "ORDER-2,LINE-2,S",
      "ORDER-3,LINE-3,S",
      "SECRET-CUSTOMER-NAME,UNKNOWN,S",
      "ORDER-2,LINE-2,S",
    ].join("\n"), candidates);

    expect(result.matchedValues).toEqual([candidateSelectionValue(candidates[2]!)]);
    expect(result.diagnostics).toEqual([
      { code: "size_required", row: 2 },
      { code: "candidate_blocked", row: 4 },
      { code: "candidate_not_found", row: 5 },
      { code: "duplicate_order_line", row: 6 },
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET-CUSTOMER-NAME");
  });

  it("rejects unexpected columns, malformed quotes, and oversized batches before selection", () => {
    expect(parseOrderPersonalizationCandidateCsv(
      "external_order_id,external_line_id,customer_name\nORDER-1,LINE-1,private",
      [candidate()],
    ).fileError).toContain("只能包含");
    expect(parseOrderPersonalizationCandidateCsv(
      'external_order_id,external_line_id\n"ORDER-1,LINE-1',
      [candidate()],
    ).fileError).toContain("格式无效");
    const oversized = ["external_order_id,external_line_id", ...Array.from({ length: 101 }, (_, index) => `ORDER-${index},LINE-${index}`)].join("\n");
    expect(parseOrderPersonalizationCandidateCsv(oversized, [candidate()]).fileError).toContain("100 行");
  });

  it("supports quoted commas without exposing them in diagnostics", () => {
    const input = candidate({ externalOrderId: "ORDER,1" });
    const result = parseOrderPersonalizationCandidateCsv(
      'external_order_id,external_line_id\n"ORDER,1",LINE-1',
      [input],
    );
    expect(result.matchedValues).toEqual([candidateSelectionValue(input)]);
  });
});

function candidate(overrides: Partial<OrderPersonalizationCandidate> = {}): OrderPersonalizationCandidate {
  return {
    orderId: id(1),
    externalOrderId: "ORDER-1",
    platform: "amazon",
    placedAt: "2026-08-04T00:00:00.000Z",
    orderLineId: id(2),
    externalLineId: "LINE-1",
    lineTitle: "Custom product",
    quantity: 1,
    skuId: id(3),
    skuCode: "SKU-1",
    customizationVersionId: id(4),
    customizationVersionNumber: 1,
    completeness: 100,
    requirementStatus: "ready",
    bindingId: id(5),
    templateVersionId: id(6),
    templateName: "Portrait template",
    sizeLabel: "S",
    eligible: true,
    blockers: [],
    ...overrides,
  };
}

function id(suffix: number) {
  return `019f0000-0000-7000-8000-${String(suffix).padStart(12, "0")}`;
}
