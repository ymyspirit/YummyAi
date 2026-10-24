import { expect, it } from "vitest";
import { notificationHref } from "./notification-href";
it("uses only supported business source identities and ignores metadata destinations", () => {
  const id = "019f0000-0000-7000-8000-000000000001";
  for (const source of ["procurement_order", "after_sales_case", "order_exception"])
    expect(
      notificationHref({
        resourceType: source,
        resourceId: id,
        metadata: { url: "https://untrusted.invalid" },
      }),
    ).toBe(`/business-tasks?object=${source}&target=${id}`);
  expect(
    notificationHref({ resourceType: "procurement_order", resourceId: "../unsafe" }),
  ).toBeNull();
  expect(
    notificationHref({ resourceType: "https://untrusted.invalid", resourceId: id }),
  ).toBeNull();
});
