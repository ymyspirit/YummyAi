import { BaseExceptionFilter } from "@nestjs/core";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { describe, expect, it, vi } from "vitest";

describe("business permission errors at the HTTP boundary", () => {
  it("returns 403 for a business-resource denial after the route permission guard", () => {
    const reply = vi.fn(),
      response = {};
    const adapter = { isHeadersSent: () => false, reply };
    const host = { getArgByIndex: () => response };
    new BaseExceptionFilter(adapter as never).catch(
      new ForbiddenError(Permission.ProductRead, "outside_data_scope"),
      host as never,
    );
    expect(reply).toHaveBeenCalledWith(
      response,
      { statusCode: 403, message: "Permission denied: product:read" },
      403,
    );
  });
});
