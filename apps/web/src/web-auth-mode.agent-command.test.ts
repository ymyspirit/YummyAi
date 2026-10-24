import { describe, expect, it } from "vitest";
import { erpReturnPath } from "./web-auth-mode";

describe("Agent original-command return after personal login", () => {
  it("keeps one original command reference, drops private and ambiguous fields, and preserves the independent read run", () => {
    const id = "0199a7bf-e321-7a44-8cba-111111111111", run = "0199a7bf-e321-7a44-8cba-222222222222";
    expect(erpReturnPath(erpReturnPath(`/ai-tasks?agentCommand=${id}&body=private&token=secret&tenantId=other`))).toBe(`/ai-tasks?agentCommand=${id}`);
    expect(erpReturnPath(`/ai-tasks?agentCommand=${id}&agentCommand=${id}`)).toBe("/ai-tasks");
    expect(erpReturnPath("/ai-tasks?agentCommand=invalid")).toBe("/ai-tasks");
    expect(erpReturnPath(`/orders?agentCommand=${id}`)).toBe("/orders");
    expect(erpReturnPath(`/ai-tasks?agentRun=${run}&agentCommand=${id}`)).toBe(`/ai-tasks?agentRun=${run}&agentCommand=${id}`);
  });
});
