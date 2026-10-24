import { describe, it, expect } from "vitest";
import type { AdExportView } from "@yummyai/contracts/advertising";
import { advertisingReviewCsv } from "./ad-export.js";
describe("reviewed advertising checklist export", () => {
  it("keeps exact monetary units and neutralizes formula-like untrusted terms, names and IDs", () => {
    const sealed = {
      id: "sealed",
      checksum: "checksum",
      payload: {
        actions: [
          {
            id: "action",
            status: "adopted",
            actualBeforeMinor: null,
            actualAfterMinor: null,
            executedAt: null,
            execution: {
              campaignId: "destination",
              adGroupId: "destination-group",
              targetId: "@new-target",
            },
            recommendation: {
              ruleId: "rule",
              scope: { asin: "B012345678" },
              marketplace: "US",
              currency: "USD",
              campaignId: "=CMD()",
              adGroupId: "group",
              targetId: null,
              term: ' \t=HYPERLINK("x")',
              currentBidMinor: 100,
              proposedBidMinor: 85,
              reason: "review\nreason",
              periodStart: "2026-09-01",
              periodEnd: "2026-09-15",
              constraints: ["manual only"],
            },
          },
        ],
      },
    } as unknown as AdExportView;
    const csv = advertisingReviewCsv(sealed);
    expect(csv).toContain('"1.00","0.85"');
    expect(csv).toContain('"\'=CMD()"');
    expect(csv).toContain('"\' \t=HYPERLINK(""x"")"');
    expect(csv).toContain('"review\nreason"');
    expect(csv).toContain('"destination","destination-group","\'@new-target"');
    expect(csv.startsWith("\ufeff")).toBe(true);
  });
});
