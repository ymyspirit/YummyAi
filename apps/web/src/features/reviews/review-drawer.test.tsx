import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewDrawer, type ReviewDrawerView } from "./review-drawer";

describe("review drawer", () => {
  it("shows pinned Listing and authorized asset versions for approval", () => {
    const html = renderToStaticMarkup(<ReviewDrawer review={fixture("pending")} />);
    expect(html).toContain("V07 审核凭证");
    expect(html).toContain("发布前检查");
    expect(html).toContain("AUTHORIZED");
    expect(html).toContain("批准此版本");
    expect(html).toContain("驳回时必填");
  });

  it("explains mutation invalidation and hides export action", () => {
    const html = renderToStaticMarkup(<ReviewDrawer review={{ ...fixture("invalidated"), invalidatedByVersion: 8 }} />);
    expect(html).toContain("批准已自动失效");
    expect(html).toContain("V08");
    expect(html).not.toContain("生成不可变 ZIP");
  });

  it("offers immutable export only for approved snapshots", () => {
    const html = renderToStaticMarkup(<ReviewDrawer review={fixture("approved")} />);
    expect(html).toContain("审批快照已锁定");
    expect(html).toContain("生成不可变 ZIP");
  });
});

function fixture(status: ReviewDrawerView["status"]): ReviewDrawerView {
  return { id: "review", listingVersion: 7, listingVersionId: "0198fbef-4a10-7000-8000-000000000701", platform: "amazon", locale: "en-US", status, submittedBy: "Lin Q.", submittedAt: "2026-07-18T04:00:00.000Z", decidedBy: "Mia Chen", decidedAt: "2026-07-18T05:00:00.000Z", assets: [{ id: "0198fbef-4a10-7000-8000-000000000702", fileName: "mug-main-hero.png", version: 3, authorized: true, rightsApproved: true }], blockers: 0, warnings: 2 };
}
