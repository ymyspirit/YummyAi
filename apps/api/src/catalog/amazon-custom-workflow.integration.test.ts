import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  amazonCustomWorkflowEvents,
  connectDatabase,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AmazonCustomWorkflowService } from "./amazon-custom-workflow.service.js";
import { DrizzleCatalogRepository, ProductService } from "./product.service.js";

describe("Amazon Custom product workflow", () => {
  const database = connectDatabase();
  const products = new ProductService(new DrizzleCatalogRepository(database));
  const workflows = new AmazonCustomWorkflowService(database);
  const userId = createEntityId();
  const first = tenant(createEntityId(), userId);
  const second = tenant(createEntityId(), userId);

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Workflow A', $2), ($3, 'Workflow B', $4)`,
      [
        first.tenantId,
        `workflow-${first.tenantId}`,
        second.tenantId,
        `workflow-${second.tenantId}`,
      ],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Workflow Operator')`,
      [userId, `workflow-${userId}`, `${userId}@example.test`],
    );
    await database.client.unsafe(
      `insert into memberships (id, tenant_id, user_id, status) values ($1, $2, $3, 'active'), ($4, $5, $3, 'active')`,
      [createEntityId(), first.tenantId, userId, createEntityId(), second.tenantId],
    );
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("tracks sequential product progress, blockers, revisions, and immutable events", async () => {
    const firstPlan = await products.createPlan(first, {
      name: "Custom cake topper",
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
    await products.createPlan(second, {
      name: "Other tenant product",
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });

    await expect(workflows.list(first)).resolves.toMatchObject({
      items: [
        {
          productPlanId: firstPlan.id,
          status: "not_started",
          completedSteps: 0,
          currentStepKey: "research_capture",
          currentStepStatus: "not_started",
        },
      ],
    });
    const started = await workflows.start(first, firstPlan.id);
    expect(started).toMatchObject({
      status: "active",
      revision: 1,
      currentStepKey: "research_capture",
      currentStepStatus: "in_progress",
    });
    expect(started.steps).toHaveLength(14);
    expect(started.events[0]).toMatchObject({
      action: "workflow_started",
      revision: 1,
    });

    const blocked = await workflows.transition(first, firstPlan.id, "research_capture", {
      expectedRevision: 1,
      status: "blocked",
      note: "等待竞品评论复核",
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      revision: 2,
      latestBlocker: "等待竞品评论复核",
    });
    await expect(
      workflows.transition(first, firstPlan.id, "research_capture", {
        expectedRevision: 1,
        status: "in_progress",
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const unblocked = await workflows.transition(first, firstPlan.id, "research_capture", {
      expectedRevision: 2,
      status: "in_progress",
      note: "评论复核已补齐",
    });
    const completed = await workflows.transition(first, firstPlan.id, "research_capture", {
      expectedRevision: unblocked.revision,
      status: "completed",
      note: "研究快照已确认",
    });
    expect(completed).toMatchObject({
      status: "active",
      revision: 4,
      completedSteps: 1,
      currentStepKey: "research_review",
      currentStepStatus: "not_started",
    });
    const secondStep = await workflows.transition(first, firstPlan.id, "research_review", {
      expectedRevision: completed.revision,
      status: "in_progress",
    });
    expect(secondStep).toMatchObject({
      revision: 5,
      currentStepKey: "research_review",
      currentStepStatus: "in_progress",
    });
    const editedCompletion = await workflows.updateCompletedStepNote(
      first,
      firstPlan.id,
      "research_capture",
      {
        expectedRevision: secondStep.revision,
        note: "研究快照与评论结论已补充",
      },
    );
    expect(editedCompletion).toMatchObject({
      revision: 6,
      currentStepKey: "research_review",
      currentStepStatus: "in_progress",
    });
    expect(editedCompletion.steps[0]).toMatchObject({
      status: "completed",
      note: "研究快照与评论结论已补充",
    });
    expect(editedCompletion.events[0]).toMatchObject({
      action: "step_note_updated",
      fromStatus: "completed",
      toStatus: "completed",
      revision: 6,
    });

    await expect(workflows.get(second, firstPlan.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await workflows.list(second)).items).toHaveLength(1);

    const eventId = editedCompletion.events[0]!.id;
    await expect(
      withTenant(database.db, first, (tx) =>
        tx
          .update(amazonCustomWorkflowEvents)
          .set({ note: "mutated" })
          .where(eq(amazonCustomWorkflowEvents.id, eventId)),
      ),
    ).rejects.toThrow();
  });
});

function tenant(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    userId,
    permissions: [Permission.ProductRead, Permission.ProductWrite],
    dataScope: "tenant",
  };
}
