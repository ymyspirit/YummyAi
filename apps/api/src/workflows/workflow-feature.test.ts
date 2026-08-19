import { describe, expect, it } from "vitest";

import { workflowCenterEnabled } from "./workflow-feature.js";

describe("workflow center tenant rollout", () => {
  it("enables local/default and wildcard rollout", () => {
    expect(workflowCenterEnabled("tenant-a", undefined)).toBe(true);
    expect(workflowCenterEnabled("tenant-a", "*")).toBe(true);
  });

  it("limits an allowlist to the configured tenants", () => {
    expect(workflowCenterEnabled("tenant-a", "tenant-b, tenant-a")).toBe(true);
    expect(workflowCenterEnabled("tenant-c", "tenant-b, tenant-a")).toBe(false);
  });
});
