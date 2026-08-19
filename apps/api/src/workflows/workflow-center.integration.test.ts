import { NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { AMAZON_CUSTOM_WORKFLOW_STEPS, createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  migrateDatabase,
  workflowDefinitionVersions,
  workflowRunEvents,
  withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AmazonCustomWorkflowService } from "../catalog/amazon-custom-workflow.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { WorkflowCapabilityRegistry } from "./workflow-capability.registry.js";
import { WorkflowDefinitionService } from "./workflow-definition.service.js";
import {
  ExternalWorkflowExecutor,
  HumanExecutor,
  InternalCapabilityExecutor,
  WorkflowExecutorRouter,
} from "./workflow-node.executor.js";
import { WorkflowRunService } from "./workflow-run.service.js";

describe("generic workflow center", () => {
  const database = connectDatabase();
  const products = new ProductService(new DrizzleCatalogRepository(database));
  const capabilities = new WorkflowCapabilityRegistry();
  const definitions = new WorkflowDefinitionService(database, capabilities);
  const enqueue = vi.fn(async () => undefined);
  const runs = new WorkflowRunService(
    database,
    definitions,
    new WorkflowExecutorRouter(
      new HumanExecutor(),
      new InternalCapabilityExecutor({ enqueue }),
      new ExternalWorkflowExecutor(),
    ),
  );
  const legacy = new AmazonCustomWorkflowService(database);
  const userId = createEntityId();
  const first = tenant(createEntityId(), userId);
  const second = tenant(createEntityId(), userId);

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Workflow Center A', $2), ($3, 'Workflow Center B', $4)`,
      [first.tenantId, `workflow-center-${first.tenantId}`, second.tenantId, `workflow-center-${second.tenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Workflow Center Operator')`,
      [userId, `workflow-center-${userId}`, `${userId}@example.test`],
    );
    await database.client.unsafe(
      `insert into memberships (id, tenant_id, user_id, status) values ($1, $2, $3, 'active'), ($4, $5, $3, 'active')`,
      [createEntityId(), first.tenantId, userId, createEntityId(), second.tenantId],
    );
  });

  afterAll(async () => database.client.end());

  it("serializes concurrent official workflow initialization", async () => {
    const [left, right] = await Promise.all([
      definitions.ensureOfficial(first),
      definitions.ensureOfficial(first),
    ]);

    expect(left.id).toBe(right.id);
    const detail = await definitions.get(first, left.id);
    expect(detail.published).toBeDefined();
  });

  it("pins published versions, allows completed-note edits, and keeps versions and events immutable", async () => {
    const plan = await products.createPlan(first, {
      name: "Generic workflow product",
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
    const official = (await definitions.list(first)).items.find((item) => item.scope === "official")!;
    const started = await runs.start(first, { definitionId: official.id, productPlanId: plan.id });
    expect(started).toMatchObject({ status: "active", currentNodeId: "research_capture", completedNodes: 0, totalNodes: 14 });

    const blocked = await runs.command(first, started.id, "research_capture", {
      type: "block", reason: "等待研究证据", expectedRevision: started.revision,
    });
    expect(blocked).toMatchObject({ status: "blocked", latestBlocker: "等待研究证据" });
    const unblocked = await runs.command(first, started.id, "research_capture", {
      type: "unblock", expectedRevision: blocked.revision,
    });
    const completed = await runs.command(first, started.id, "research_capture", {
      type: "complete", note: "研究证据已确认", parameters: {}, expectedRevision: unblocked.revision,
    });
    expect(completed).toMatchObject({ completedNodes: 1, currentNodeId: "research_review" });
    const edited = await runs.command(first, started.id, "research_capture", {
      type: "update_note", note: "完成后补充的研究说明", expectedRevision: completed.revision,
    });
    expect(edited.nodes.find((node) => node.nodeId === "research_capture")).toMatchObject({
      status: "completed",
      note: "完成后补充的研究说明",
    });
    await expect(runs.get(second, started.id)).rejects.toBeInstanceOf(NotFoundException);

    const definition = await definitions.get(first, official.id);
    const cloned = await definitions.clone(first, official.id, { scope: "team", name: "Amazon Custom 团队流程" });
    const publishedClone = await definitions.publish(first, cloned.id, cloned.revision);
    expect(publishedClone).toMatchObject({ scope: "team", status: "published" });
    expect(publishedClone.published?.graph.nodes).toHaveLength(16);
    expect((await runs.get(first, started.id)).definitionVersionId).toBe(definition.published!.id);
    await expect(withTenant(database.db, first, (tx) => tx.update(workflowDefinitionVersions)
      .set({ checksum: "0".repeat(64) }).where(eq(workflowDefinitionVersions.id, definition.published!.id)))).rejects.toThrow();
    const eventId = edited.events[0]!.id;
    await expect(withTenant(database.db, first, (tx) => tx.update(workflowRunEvents)
      .set({ note: "mutated" }).where(eq(workflowRunEvents.id, eventId)))).rejects.toThrow();
  });

  it("migrates the fixed Amazon projection without changing 11/14 and step 12 blocker", async () => {
    const plan = await products.createPlan(first, {
      name: "Legacy Amazon Custom trial",
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
    let detail = await legacy.start(first, plan.id);
    for (const [index, step] of AMAZON_CUSTOM_WORKFLOW_STEPS.entries()) {
      if (index === 11) break;
      if (index > 0) {
        detail = await legacy.transition(first, plan.id, step.key, {
          status: "in_progress",
          expectedRevision: detail.revision,
        });
      }
      detail = await legacy.transition(first, plan.id, step.key, {
        status: "completed",
        note: `完成 ${step.title}`,
        expectedRevision: detail.revision,
      });
    }
    detail = await legacy.transition(first, plan.id, "content_review", {
      status: "in_progress",
      expectedRevision: detail.revision,
    });
    detail = await legacy.transition(first, plan.id, "content_review", {
      status: "blocked",
      note: "等待自有事实和授权素材",
      expectedRevision: detail.revision,
    });

    const migrated = await runs.getByProductPlan(first, plan.id);
    expect(migrated).toMatchObject({
      status: "blocked",
      completedNodes: 11,
      totalNodes: 14,
      currentNodeId: "content_review",
      latestBlocker: "等待自有事实和授权素材",
      revision: detail.revision,
    });
    expect(migrated.nodes.find((node) => node.nodeId === "design_proof")?.note).toBe("完成 完成设计校样");
  });
});

function tenant(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    userId,
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
}
