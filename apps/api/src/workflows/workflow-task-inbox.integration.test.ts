import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext, type WorkflowGraph } from "@yummyai/contracts";
import { WorkflowTaskInboxReader, WorkflowResponsibilityCoordinator } from "@yummyai/workflow-core";
import {
  connectDatabase,
  migrateDatabase,
  productPlans,
  roles,
  workflowNodeRuns,
  withTenant,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductService, DrizzleCatalogRepository } from "../catalog/product.service.js";
import { WorkflowDefinitionService } from "./workflow-definition.service.js";
import { WorkflowCapabilityRegistry } from "./workflow-capability.registry.js";
import { WorkflowRunService } from "./workflow-run.service.js";
import {
  WorkflowExecutorRouter,
  HumanExecutor,
  InternalCapabilityExecutor,
  ExternalWorkflowExecutor,
} from "./workflow-node.executor.js";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw new Error("Disposable workflow-task-inbox-integration runner required");
describe("workflow assignment inbox read model", () => {
  const database = connectDatabase(),
    tenantId = createEntityId(),
    otherTenant = createEntityId();
  const owner = createEntityId(),
    assignee = createEntityId(),
    outsider = createEntityId(),
    ownerRole = createEntityId(),
    assigneeRole = createEntityId();
  const all = Object.values(Permission),
    context: TenantContext = { tenantId, userId: owner, permissions: all, dataScope: "tenant" };
  const other: TenantContext = {
    tenantId: otherTenant,
    userId: outsider,
    permissions: all,
    dataScope: "tenant",
  };
  const assigneeContext: TenantContext = { ...context, userId: assignee };
  const definitions = new WorkflowDefinitionService(database, new WorkflowCapabilityRegistry());
  const runs = new WorkflowRunService(
    database,
    definitions,
    new WorkflowExecutorRouter(
      new HumanExecutor(),
      new InternalCapabilityExecutor({
        enqueue: async () => {
          throw new Error("Read-only inbox must not dispatch");
        },
      }),
      new ExternalWorkflowExecutor(),
    ),
  );
  const products = new ProductService(new DrizzleCatalogRepository(database)),
    reader = new WorkflowTaskInboxReader(database),
    responsibilities = new WorkflowResponsibilityCoordinator(database);
  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Inbox acceptance',$2),($3,'Other inbox acceptance',$4)",
      [tenantId, "inbox-" + tenantId, otherTenant, "inbox-" + otherTenant],
    );
    for (const [index, userId] of [owner, assignee, outsider].entries()) {
      const tenant = index === 2 ? otherTenant : tenantId,
        member = createEntityId(),
        role = index === 0 ? ownerRole : index === 1 ? assigneeRole : createEntityId();
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [
          userId,
          "inbox-" + userId,
          userId + "@example.test",
          ["Inbox owner", "Inbox assignee", "Other inbox member"][index]!,
        ],
      );
      await database.client.unsafe(
        "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
        [member, tenant, userId],
      );
      await database.client.unsafe(
        "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
        [role, tenant, "Inbox role " + index, JSON.stringify(all)],
      );
      await database.client.unsafe(
        "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
        [tenant, member, role],
      );
    }
  });
  afterAll(() => database.client.end());
  const graph: WorkflowGraph = {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      ["start", "start"],
      ["work", "human_task"],
      ["review", "approval_gate"],
      ["end", "end"],
    ].map(([id, kind], index) => ({
      id: id!,
      kind: kind as WorkflowGraph["nodes"][number]["kind"],
      title: id === "work" ? "核对商品资料" : id === "review" ? "审核固定版本" : id!,
      description: "",
      ownerRole: "Operator",
      inputPorts: [],
      outputPorts: [],
      config: { parameters: {} },
      position: { x: 0, y: index * 100 },
      ...(kind === "approval_gate" ? { reworkTargetNodeId: "work" } : {}),
    })),
    edges: [
      { id: "a", source: "start", target: "work", kind: "success" },
      { id: "b", source: "work", target: "review", kind: "success" },
      { id: "c", source: "review", target: "end", kind: "success" },
      { id: "r", source: "review", target: "work", kind: "rework" },
    ],
  };
  async function fixture(title = "Inbox " + createEntityId(), actor = context) {
    const product = await products.createPlan(actor, {
      name: title,
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
    const definition = await definitions.create(actor, {
      name: title,
      description: "",
      category: "Acceptance",
      scope: "team",
      graph,
    });
    await definitions.publish(actor, definition.id, definition.revision);
    return runs.start(actor, { definitionId: definition.id, productPlanId: product.id, title });
  }
  const arrange = (
    run: Awaited<ReturnType<typeof fixture>>,
    userId: string | null = owner,
    dueAt: string | null = null,
    nodeId = "work",
  ) =>
    responsibilities.update(context, run.id, nodeId, {
      expectedRevision: run.revision,
      assignedUserId: userId,
      dueAt,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "Synthetic inbox arrangement",
    });
  const grant = (role: string, permissions: readonly string[] = all, scope = "tenant") =>
    withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ permissions, dataScope: scope }).where(eq(roles.id, role)),
    );
  const totalRows = () =>
    withTenant(database.db, context, async (tx) => {
      const result = await tx.execute<{ runs: number; events: number; attempts: number }>(
        sql`select (select count(*)::int from workflow_runs) runs,(select count(*)::int from workflow_run_events) events,(select count(*)::int from workflow_node_attempts) attempts`,
      );
      return result[0];
    });
  it("uses exact server totals, stable deadline pages and separate responsibility scopes", async () => {
    const prefix = "Paging " + createEntityId(),
      ids: string[] = [];
    for (let index = 0; index < 7; index++) {
      const run = await fixture(prefix + " " + index);
      ids.push(run.nodes.find((n) => n.nodeId === "work")!.id);
      await arrange(run, owner, "2000-01-01T00:00:00Z");
    }
    const received: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const view = await reader.list(context, { q: prefix, page, pageSize: 2 });
      expect(view.total).toBe(7);
      expect(view.summary.overdue).toBe(7);
      expect(view.items.length).toBe(page === 4 ? 1 : 2);
      received.push(...view.items.map((item) => item.id));
    }
    expect(received).toEqual([...ids].sort());
    expect(await reader.list(context, { q: prefix, page: 99, pageSize: 2 })).toMatchObject({
      items: [],
      total: 7,
      summary: { overdue: 7 },
    });
    expect(await reader.list(context, { q: prefix, assignment: "unassigned" })).toMatchObject({
      total: 7,
      summary: { upcoming: 7, unassigned: 7 },
    });
    expect(await reader.list(context, { q: prefix, assignment: "visible" })).toMatchObject({
      total: 14,
    });
  });
  it("keeps search literal and projects only the necessary task fields without writes", async () => {
    const prefix = "Literal " + createEntityId(),
      run = await fixture(prefix + " 100%_");
    await arrange(run);
    const otherRun = await fixture(prefix + " 100ZZ");
    await arrange(otherRun);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeRuns)
        .set({ note: "private-inbox-note", parameterSnapshot: { privatePrompt: "not-for-inbox" } })
        .where(eq(workflowNodeRuns.runId, run.id)),
    );
    const before = await totalRows(),
      view = await reader.list(context, { q: prefix + " 100%_" });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      runId: run.id,
      title: "核对商品资料",
      isCurrent: true,
      isClosed: false,
      dueAt: null,
      responsibilityRevision: 1,
    });
    expect(JSON.stringify(view)).not.toContain("private-inbox-note");
    expect(JSON.stringify(view)).not.toContain("not-for-inbox");
    expect(await totalRows()).toEqual(before);
  });
  it("uses the same filtered population for due, blocked and unassigned counts", async () => {
    const prefix = "Filters " + createEntityId();
    const overdue = await fixture(prefix + " overdue"),
      future = await fixture(prefix + " future"),
      unset = await fixture(prefix + " unset");
    const saved = await arrange(overdue, owner, "2000-01-01T00:00:00Z");
    await arrange(future, owner, "2100-01-01T00:00:00Z");
    await arrange(unset);
    await runs.command(context, overdue.id, "work", {
      type: "block",
      expectedRevision: saved.revision,
      reason: "Synthetic blocker",
    });
    expect(await reader.list(context, { q: prefix, due: "overdue" })).toMatchObject({
      total: 1,
      summary: { overdue: 1, blocked: 1 },
    });
    expect(await reader.list(context, { q: prefix, due: "unset" })).toMatchObject({
      total: 1,
      summary: { overdue: 0, blocked: 0 },
    });
    const visible = await reader.list(context, { q: prefix, assignment: "visible" });
    expect(visible.total).toBe(6);
    expect(visible.summary.unassigned).toBe(3);
    expect(visible.summary.upcoming).toBe(3);
    expect(visible.items.at(-1)!.dueAt).toBeNull();
  });
  it("interprets today in the selected real time zone using database time", async () => {
    const prefix = "Time zones " + createEntityId(),
      initial = await reader.list(context, { q: prefix }),
      base = new Date(initial.asOf);
    const dueDates = [-20, -8, 0, 8, 20, 32].map((hours) =>
      new Date(base.getTime() + hours * 3_600_000).toISOString(),
    );
    for (const [index, dueAt] of dueDates.entries())
      await arrange(await fixture(prefix + " " + index), owner, dueAt);
    for (const timeZone of ["UTC", "Asia/Shanghai"]) {
      const view = await reader.list(context, { q: prefix, due: "today", timeZone });
      const formatter = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }),
        date = formatter.format(new Date(view.asOf));
      const expected = dueDates.filter((value) => formatter.format(new Date(value)) === date);
      expect(view.total).toBe(expected.length);
      expect(view.items.map((item) => item.dueAt).sort()).toEqual(expected.sort());
      expect(view.summary.dueToday).toBe(expected.length);
    }
  });
  it("reads current member grants and object scope before filtering an assignment", async () => {
    const prefix = "Scope " + createEntityId(),
      owned = await fixture(prefix + " owned", assigneeContext),
      external = await fixture(prefix + " external");
    await arrange(owned, assignee);
    await arrange(external, assignee);
    expect((await reader.list(assigneeContext, { q: prefix })).total).toBe(2);
    try {
      await grant(assigneeRole, all, "self");
      const narrowed = await reader.list(assigneeContext, { q: prefix, assignment: "visible" });
      expect(narrowed.total).toBe(2);
      expect(narrowed.items.every((item) => item.runId === owned.id)).toBe(true);
      expect(narrowed.items.map((item) => item.nodeId).sort()).toEqual(["review", "work"]);
      expect((await reader.list(other, { q: prefix, assignment: "visible" })).total).toBe(0);
      await grant(
        assigneeRole,
        all.filter((permission) => permission !== Permission.ProductRead),
      );
      await expect(reader.list(assigneeContext, { q: prefix })).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await grant(assigneeRole);
    }
  });
  it("keeps actual completed/cancelled states and does not complete an archived product's task", async () => {
    const prefix = "Lifecycle " + createEntityId(),
      completed = await fixture(prefix + " completed");
    const saved = await arrange(completed, owner, "2000-01-01T00:00:00Z");
    await runs.command(context, completed.id, "work", {
      type: "complete",
      expectedRevision: saved.revision,
      parameters: {},
    });
    const cancelled = await fixture(prefix + " cancelled"),
      cancelSaved = await arrange(cancelled);
    await runs.command(context, cancelled.id, "work", {
      type: "cancel",
      expectedRevision: cancelSaved.revision,
    });
    const archived = await fixture(prefix + " archived");
    await arrange(archived);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(productPlans)
        .set({ status: "archived" })
        .where(eq(productPlans.id, archived.productPlanId)),
    );
    const open = await reader.list(context, { q: prefix });
    expect(open.items).toHaveLength(1);
    expect(open.items[0]).toMatchObject({
      runId: archived.id,
      productArchived: true,
      isClosed: false,
    });
    const closed = await reader.list(context, { q: prefix, status: "closed" });
    expect(closed.total).toBe(2);
    expect(closed.items.every((item) => item.isClosed && !item.isOverdue)).toBe(true);
    expect(closed.items.find((item) => item.runId === completed.id)!.nodeStatus).toBe("completed");
    expect(closed.items.find((item) => item.runId === cancelled.id)!.runStatus).toBe("cancelled");
  });
  it("exposes a missing pinned node definition without inventing steps or leaking its inputs", async () => {
    const run = await fixture("Missing definition " + createEntityId()),
      id = createEntityId();
    await withTenant(database.db, context, (tx) =>
      tx
        .insert(workflowNodeRuns)
        .values({
          id,
          tenantId,
          runId: run.id,
          nodeId: "legacy-missing-node",
          status: "not_started",
          assignedUserId: owner,
          parameterSnapshot: { privatePrompt: "never-project" },
        }),
    );
    const view = await reader.list(context, { q: run.title });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      id,
      definitionMissing: true,
      title: "任务定义不可用",
      responsibilityRevision: 0,
    });
    expect(JSON.stringify(view)).not.toContain("never-project");
  });
  it("honors the shared feature allowlist and rejects invalid query combinations", async () => {
    const before = process.env.WORKFLOW_CENTER_TENANT_IDS;
    try {
      process.env.WORKFLOW_CENTER_TENANT_IDS = otherTenant;
      await expect(reader.list(context)).rejects.toMatchObject({ status: 404 });
    } finally {
      if (before === undefined) delete process.env.WORKFLOW_CENTER_TENANT_IDS;
      else process.env.WORKFLOW_CENTER_TENANT_IDS = before;
    }
    await expect(reader.list(context, { status: "closed", due: "overdue" })).rejects.toThrow();
    await expect(reader.list(context, { timeZone: "not-a-zone" })).rejects.toThrow();
  });
});
