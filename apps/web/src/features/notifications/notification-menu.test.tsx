import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationMenu } from "./notification-menu";

describe("notification menu", () => {
  it("shows unread count without inventing notifications", () => {
    const html = renderToStaticMarkup(<NotificationMenu initialNotifications={[{ id: "n1", kind: "job_failed", title: "导出失败", body: "研究域素材被阻断", createdAt: "2026-07-18T04:00:00Z" }, { id: "n2", kind: "review_decided", title: "审核通过", body: "Listing V04 已锁定", readAt: "2026-07-18T04:02:00Z", createdAt: "2026-07-18T04:01:00Z" }]} />);
    expect(html).toContain(">1<"); expect(html).toContain("aria-expanded=\"false\"");
  });
});
