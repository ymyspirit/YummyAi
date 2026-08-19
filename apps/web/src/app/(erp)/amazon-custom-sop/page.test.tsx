import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import AmazonCustomSopPage from "./page";

describe("legacy Amazon Custom SOP route", () => {
  beforeEach(() => mocks.redirect.mockClear());

  it("redirects the old entry to the generic workflow center", async () => {
    await AmazonCustomSopPage({ searchParams: Promise.resolve({}) });
    expect(mocks.redirect).toHaveBeenCalledWith("/workflows");
  });
});
