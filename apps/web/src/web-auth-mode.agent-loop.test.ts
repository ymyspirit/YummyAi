import { describe, expect, it } from "vitest";
import { erpReturnPath } from "./web-auth-mode";

describe("Agent original-run return after personal login", () => {
  it("preserves only one genuine run identity through repeated sanitization and rejects private or ambiguous recovery data", () => {
    const id = "0199a7bf-e321-7a44-8cba-111111111111";
    const expected = "/ai-tasks?agentRun=" + id;
    expect(erpReturnPath(erpReturnPath(expected + "&goal=private&tenantId=other&requestChecksum=secret"))).toBe(expected);
    expect(erpReturnPath("/ai-tasks?agentRun=" + id + "&agentRun=" + id)).toBe("/ai-tasks");
    expect(erpReturnPath("/ai-tasks?agentRun=malformed")).toBe("/ai-tasks");
    expect(erpReturnPath("/orders?agentRun=" + id)).toBe("/orders");
  });
});
