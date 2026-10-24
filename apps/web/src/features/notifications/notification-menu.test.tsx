import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotificationMenu } from "./notification-menu";
import { notificationHref } from "./notification-href";
import { createEntityId } from "@yummyai/contracts/common/ids";

describe("notification menu", () => {
  it("shows unread count without inventing notifications", () => {
    const html = renderToStaticMarkup(
      <NotificationMenu
        live={false}
        initialNotifications={[
          {
            id: "n1",
            kind: "job_failed",
            title: "导出失败",
            body: "研究域素材被阻断",
            createdAt: "2026-07-18T04:00:00Z",
          },
          {
            id: "n2",
            kind: "review_decided",
            title: "审核通过",
            body: "Listing V04 已锁定",
            readAt: "2026-07-18T04:02:00Z",
            createdAt: "2026-07-18T04:01:00Z",
          },
        ]}
      />,
    );
    expect(html).toContain(">1<");
    expect(html).toContain('aria-expanded="false"');
  });
  it("limits notification destinations to local workflow and order records", () => {
    const run = createEntityId(),
      node = createEntityId();
    expect(
      notificationHref({
        resourceType: "workflow_run",
        resourceId: run,
        metadata: { nodeRunId: node, href: "https://untrusted.test" },
      }),
    ).toBe(`/workflows/runs/${run}?task=${node}`);
    expect(
      notificationHref({
        resourceType: "workflow_run",
        resourceId: run,
        metadata: { nodeRunId: "../private" },
      }),
    ).toBe(`/workflows/runs/${run}`);
    expect(
      notificationHref({ resourceType: "workflow_run", resourceId: "https://untrusted.test" }),
    ).toBeNull();
    expect(notificationHref({ resourceType: "unknown", resourceId: run })).toBeNull();
    expect(
      notificationHref({
        resourceType: "order_work_item",
        resourceId: node,
        metadata: { href: "https://untrusted.test" },
      }),
    ).toBe(`/business-tasks?object=order&target=${node}`);
    for (const resourceId of ["../private", "https://untrusted.test", node + "?tenant=other"])
      expect(notificationHref({ resourceType: "order_work_item", resourceId })).toBeNull();
  });
});
