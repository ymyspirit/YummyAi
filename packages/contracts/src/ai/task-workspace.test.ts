import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { AssistKindSchema, CreateAssistSchema } from "./assist.js";
import {
  ASSIST_TASKS,
  assistTaskHref,
  AssistTaskBasisRequestSchema,
  AssistTaskQuerySchema,
  AssistTaskInputSchema,
  AssistTaskBasisSchema,
} from "./task-workspace.js";
describe("business AI task contracts", () => {
  it("preserves the server-selected method in a basis but rejects a caller-provided selection", () => {
    const input = {
      kind: "order_review",
      orderLineId: createEntityId(),
      expectedRevision: 1,
      expectedSourceVersionId: null,
    };
    const methodSelection = {
      schemaVersion: "agent-method-selection-v1",
      mode: "builtin",
      methodKey: "yummyai.assist.order_review.review",
      contractChecksum: "a".repeat(64),
      withdrawalGeneration: 0,
    };
    expect(
      AssistTaskBasisSchema.parse({
        input,
        methodSelection,
        fingerprint: "b".repeat(64),
        rows: [],
        sources: [],
        checks: [],
        diagnostics: [],
        scope: `order:${input.orderLineId}`,
        href: "/orders",
      }).methodSelection,
    ).toEqual(methodSelection);
    expect(AssistTaskInputSchema.safeParse({ ...input, methodSelection }).success).toBe(false);
    expect(
      CreateAssistSchema.safeParse({
        ...input,
        methodSelection,
        modelId: createEntityId(),
        requestId: createEntityId(),
      }).success,
    ).toBe(false);
  });
  it("covers every existing capability and keeps legacy requests valid", () => {
    expect(ASSIST_TASKS.map((task) => task.kind).sort()).toEqual(
      [...AssistKindSchema.options].sort(),
    );
    const request = {
      kind: "order_review",
      orderLineId: createEntityId(),
      expectedRevision: 1,
      expectedSourceVersionId: null,
      requestId: createEntityId(),
      modelId: createEntityId(),
    };
    expect(CreateAssistSchema.parse(request)).toEqual(request);
    const input = { ...request } as Record<string, unknown>;
    delete input.modelId;
    delete input.requestId;
    expect(AssistTaskInputSchema.parse(input)).toEqual(input);
  });
  it("rejects caller tenant selection, execution paths and unbounded tasks", () => {
    expect(AssistTaskQuerySchema.safeParse({ tenantId: createEntityId() }).success).toBe(false);
    expect(AssistTaskQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(
      AssistTaskBasisRequestSchema.safeParse({
        kind: "order_review",
        targetId: createEntityId(),
        taskGoal: "x".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      AssistTaskBasisRequestSchema.safeParse({
        kind: "knowledge_answer",
        targetId: null,
        path: "../../secrets",
      }).success,
    ).toBe(false);
  });
  it("returns the original business object and task even outside the current history page", () => {
    const request = CreateAssistSchema.parse({
      kind: "order_review",
      orderLineId: createEntityId(),
      expectedRevision: 1,
      expectedSourceVersionId: null,
      requestId: createEntityId(),
      modelId: createEntityId(),
    });
    if (request.kind !== "order_review") throw new Error("Expected order fixture");
    const run = createEntityId();
    expect(assistTaskHref(request, request.kind, [], run)).toBe(
      `/orders?line=${request.orderLineId}&assistRun=${run}`,
    );
    const afterSales = CreateAssistSchema.parse({
      kind: "after_sales_review",
      caseId: createEntityId(),
      expectedFingerprint: "a".repeat(64),
      locale: "en-US",
      contextNotes: "",
      requestId: createEntityId(),
      modelId: createEntityId(),
    });
    if (afterSales.kind !== "after_sales_review") throw new Error("Expected after-sales fixture");
    expect(
      assistTaskHref(
        afterSales,
        afterSales.kind,
        [
          {
            id: afterSales.caseId,
            label: "case",
            href: `/after-sales?line=${request.orderLineId}`,
          },
        ],
        run,
      ),
    ).toBe(`/after-sales?line=${request.orderLineId}&assistRun=${run}`);
    expect(assistTaskHref(null, "knowledge_answer", [], run)).toBe("/knowledge");
    const planId = createEntityId();
    const listingTask = CreateAssistSchema.parse({
      kind: "sku_package",
      listingId: createEntityId(),
      expectedVersionId: createEntityId(),
      salesPlan: { id: planId, revision: 2 },
      modelId: createEntityId(),
      requestId: createEntityId(),
    });
    expect(assistTaskHref(listingTask, listingTask.kind, [], run)).toBe(
      `/sales-plans?plan=${planId}&view=tasks&kind=sku_package&launchRun=${run}`,
    );
  });
});
