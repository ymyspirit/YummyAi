import { describe, expect, it } from "vitest";
import { assistUsesReviewedGuidance } from "@yummyai/ai-core";
import { authorizeAssistRequest, Permission, ForbiddenError } from "@yummyai/authz";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import type { AgentMethodSelection } from "@yummyai/contracts/harness/methods";
import type { TenantContext } from "@yummyai/contracts";

const id = "019b0000-0000-7000-8000-000000000001";
const request = CreateAssistSchema.parse({
  kind: "order_review",
  requestId: id,
  modelId: id,
  orderLineId: id,
  expectedRevision: 0,
  expectedSourceVersionId: null,
});
const context: TenantContext = {
  tenantId: id,
  userId: id,
  permissions: [Permission.OrderRead, Permission.OrderPiiRead],
  dataScope: "tenant",
};
const builtin: AgentMethodSelection = {
  schemaVersion: "agent-method-selection-v1",
  mode: "builtin",
  methodKey: "yummyai.assist.order_review.review",
  contractChecksum: "a".repeat(64),
  withdrawalGeneration: 0,
};
const published: AgentMethodSelection = {
  ...builtin,
  mode: "published",
  methodId: id,
  versionId: id,
  version: 1,
  checksum: "b".repeat(64),
  publicationEventId: id,
};
describe("method notes participate in current assistant read authorization", () => {
  it("retains ordinary reads for an unchanged built-in method without retrieved knowledge", () => {
    expect(() =>
      authorizeAssistRequest(context, request, "read", {
        hasKnowledge: assistUsesReviewedGuidance({ knowledge: [], methodSelection: builtin }),
      }),
    ).not.toThrow();
  });
  it("denies a published method's result after knowledge-read access is withdrawn even with zero retrieval hits", () => {
    expect(() =>
      authorizeAssistRequest(context, request, "read", {
        hasKnowledge: assistUsesReviewedGuidance({ knowledge: [], methodSelection: published }),
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      authorizeAssistRequest(
        { ...context, permissions: [...context.permissions, Permission.WorkflowRead] },
        request,
        "read",
        { hasKnowledge: assistUsesReviewedGuidance({ knowledge: [], methodSelection: published }) },
      ),
    ).not.toThrow();
  });
});
