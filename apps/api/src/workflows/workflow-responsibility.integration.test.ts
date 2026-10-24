import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext, type WorkflowGraph } from "@yummyai/contracts";
import {
  WorkflowAttentionDispatcher,
  WorkflowResponsibilityCoordinator,
} from "@yummyai/workflow-core";
import {
  connectDatabase,
  migrateDatabase,
  notifications,
  recordNotificationInTransaction,
  roles,
  workflowNodeRuns,
  withTenant,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { WorkflowAttentionScheduler } from "../../../worker/src/processors/workflow-attention.scheduler.js";
import { ProductService, DrizzleCatalogRepository } from "../catalog/product.service.js";
import { WorkflowDefinitionService } from "./workflow-definition.service.js";
import { WorkflowCapabilityRegistry } from "./workflow-capability.registry.js";
import { WorkflowRunService } from "./workflow-run.service.js";
import {
  DrizzleNotificationRepository,
  NotificationService,
} from "../notifications/notification.service.js";
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
  throw new Error("Use the disposable workflow-responsibility-integration runner");
describe("workflow responsibility and durable in-app attention", () => {
  const database = connectDatabase(),
    tenantId = createEntityId(),
    otherTenant = createEntityId();
  const owner = createEntityId(),
    assignee = createEntityId(),
    manager = createEntityId(),
    restricted = createEntityId(),
    outsider = createEntityId();
  const ownerRole = createEntityId(),
    assigneeRole = createEntityId(),
    managerRole = createEntityId(),
    restrictedRole = createEntityId();
  const all = Object.values(Permission),
    read = [Permission.WorkflowRead, Permission.ProductRead, Permission.NotificationRead];
  const context: TenantContext = { tenantId, userId: owner, permissions: all, dataScope: "tenant" };
  const definitions = new WorkflowDefinitionService(database, new WorkflowCapabilityRegistry());
  const runs = new WorkflowRunService(
    database,
    definitions,
    new WorkflowExecutorRouter(
      new HumanExecutor(),
      new InternalCapabilityExecutor({
        enqueue: async () => {
          throw new Error("Unexpected synthetic execution");
        },
      }),
      new ExternalWorkflowExecutor(),
    ),
  );
  const coordinator = new WorkflowResponsibilityCoordinator(database),
    products = new ProductService(new DrizzleCatalogRepository(database));
  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Responsibility acceptance',$2),($3,'Other responsibility acceptance',$4)",
      [tenantId, "responsibility-" + tenantId, otherTenant, "responsibility-" + otherTenant],
    );
    for (const [index, userId] of [owner, assignee, manager, restricted, outsider].entries()) {
      const target = index === 4 ? otherTenant : tenantId,
        member = createEntityId();
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [
          userId,
          "responsibility-" + userId,
          userId + "@example.test",
          ["Owner", "Assignee", "Escalation", "Restricted", "Other tenant"][index]!,
        ],
      );
      await database.client.unsafe(
        "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
        [member, target, userId],
      );
      if (index < 4) {
        const id = [ownerRole, assigneeRole, managerRole, restrictedRole][index]!;
        await database.client.unsafe(
          "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,$5)",
          [
            id,
            tenantId,
            "Responsibility " + index,
            JSON.stringify(index === 2 ? read : all),
            index === 3 ? "self" : "tenant",
          ],
        );
        await database.client.unsafe(
          "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
          [tenantId, member, id],
        );
      }
    }
  });
  afterAll(async () => database.client.end());
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
      title: id!,
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
      { id: "d", source: "review", target: "work", kind: "rework" },
    ],
  };
  async function fixture() {
    const plan = await products.createPlan(context, {
      name: "Sensitive synthetic product " + createEntityId(),
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
    const definition = await definitions.create(context, {
      name: "Responsibility acceptance",
      description: "",
      scope: "team",
      category: "Acceptance",
      graph,
    });
    await definitions.publish(context, definition.id, definition.revision);
    return runs.start(context, { definitionId: definition.id, productPlanId: plan.id });
  }
  async function arrange(
    run: Awaited<ReturnType<typeof fixture>>,
    overrides: Record<string, unknown> = {},
  ) {
    return coordinator.update(context, run.id, "work", {
      expectedRevision: run.revision,
      assignedUserId: assignee,
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "Private internal reason must stay out of notifications",
      ...overrides,
    } as never);
  }
  const inbox = (runId: string) =>
    withTenant(database.db, context, (tx) =>
      tx.select().from(notifications).where(eq(notifications.resourceId, runId)),
    );
  const grant = (id: string, permissions: readonly string[] = all, scope = "tenant") =>
    withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ permissions, dataScope: scope }).where(eq(roles.id, id)),
    );
  const wake = (runId: string) =>
    withTenant(database.db, context, (tx) =>
      tx
        .update(workflowNodeRuns)
        .set({ attentionNextAt: sql`clock_timestamp()` })
        .where(eq(workflowNodeRuns.runId, runId)),
    );

  it("keeps legacy nodes unconfigured, checks eligible current recipients and records one atomic arrangement", async () => {
    const run = await fixture(),
      initial = await coordinator.get(context, run.id, "work");
    expect(initial).toMatchObject({
      assignmentRevision: 0,
      assignedUserId: null,
      dueAt: null,
      nextCheckAt: null,
    });
    expect(initial.candidates.find((value) => value.id === restricted)).toBeUndefined();
    expect(initial.candidates.find((value) => value.id === manager)).toMatchObject({
      canAssign: false,
      canEscalate: true,
    });
    const saved = await arrange(run);
    expect(saved).toMatchObject({
      assignmentRevision: 1,
      assignedUserId: assignee,
      revision: run.revision + 1,
    });
    expect(await inbox(run.id)).toEqual([]);
    expect(
      (await runs.get(context, run.id)).events.filter(
        (event) => event.type === "node_responsibility_updated",
      ),
    ).toHaveLength(1);
    const unchanged = await coordinator.update(context, run.id, "work", {
      expectedRevision: saved.revision,
      assignedUserId: assignee,
      dueAt: saved.dueAt,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "Same arrangement",
    });
    expect(unchanged.revision).toBe(saved.revision);
  });
  it("rejects stale changes, cross-tenant recipients, narrowed scopes and revoked assignment permissions", async () => {
    const run = await fixture();
    await expect(arrange(run, { assignedUserId: outsider })).rejects.toMatchObject({ status: 400 });
    await expect(arrange(run, { assignedUserId: restricted })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      coordinator.get({ ...context, tenantId: otherTenant, userId: outsider }, run.id, "work"),
    ).rejects.toMatchObject({ status: 404 });
    try {
      await grant(
        ownerRole,
        all.filter((value) => value !== Permission.WorkflowAssign),
      );
      await expect(arrange(run)).rejects.toMatchObject({ status: 403 });
    } finally {
      await grant(ownerRole);
    }
    await arrange(run);
    await expect(arrange(run)).rejects.toMatchObject({ status: 409 });
  });
  it("serializes concurrent arrangement changes and concurrent dispatchers without duplicate inbox rows", async () => {
    const run = await fixture();
    const changes = await Promise.allSettled([
      arrange(run),
      arrange(run, { dueAt: new Date(Date.now() + 7_200_000).toISOString() }),
    ]);
    expect(changes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    await Promise.all([
      new WorkflowAttentionDispatcher(database).dispatch(),
      new WorkflowAttentionDispatcher(database).dispatch(),
    ]);
    expect(await inbox(run.id)).toHaveLength(1);
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(1);
    const [notice] = await inbox(run.id);
    expect(notice!.metadata.stage).toBe("assigned");
    expect(notice!.body).not.toContain("Sensitive");
    expect(notice!.body).not.toContain("Private internal reason");
  });
  it("catches up the current due stage and escalates once without changing the business state", async () => {
    const run = await fixture();
    await arrange(run, {
      dueAt: new Date(Date.now() - 65 * 60_000).toISOString(),
      escalationUserId: manager,
      escalationDelayMinutes: 60,
    });
    await new WorkflowAttentionDispatcher(database).dispatch();
    const notices = await inbox(run.id);
    expect(notices.map((value) => value.metadata.stage).sort()).toEqual(["due", "escalated"]);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(eq(notifications.resourceId, run.id)),
    );
    expect(
      (await runs.get(context, run.id)).nodes.find((value) => value.nodeId === "work")!.status,
    ).toBe("in_progress");
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(2);
  });
  it("defers revoked recipients and resumes the same durable arrangement after permission recovery", async () => {
    const run = await fixture();
    await arrange(run);
    try {
      await grant(
        assigneeRole,
        all.filter((value) => value !== Permission.NotificationRead),
      );
      await new WorkflowAttentionDispatcher(database).dispatch();
      expect(await inbox(run.id)).toHaveLength(0);
      expect(await coordinator.get(context, run.id, "work")).toMatchObject({
        lastError: "RECIPIENT_UNAVAILABLE",
        assignmentNotifiedAt: null,
      });
    } finally {
      await grant(assigneeRole);
    }
    await wake(run.id);
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(1);
  });
  it("does not deliver a new notice after the recipient scope narrows", async () => {
    const run = await fixture();
    await arrange(run);
    try {
      await grant(assigneeRole, all, "self");
      await new WorkflowAttentionDispatcher(database).dispatch();
      expect(await inbox(run.id)).toHaveLength(0);
    } finally {
      await grant(assigneeRole);
    }
  });
  it("rolls notification insertion and delivery markers back together, then recovers without a duplicate", async () => {
    const run = await fixture();
    await arrange(run);
    const healthy = await fixture();
    await arrange(healthy);
    const broken = new WorkflowAttentionDispatcher(database, async (tx, recipient, input) => {
      const row = await recordNotificationInTransaction(tx, recipient, input);
      if (input.resourceId === run.id) throw new Error("Synthetic post-insert interruption");
      return row;
    });
    expect((await broken.dispatch()).failures).toBeGreaterThan(0);
    expect(await inbox(run.id)).toHaveLength(0);
    expect((await coordinator.get(context, run.id, "work")).assignmentNotifiedAt).toBeNull();
    expect((await coordinator.get(context, run.id, "work")).lastError).toBe("DISPATCH_FAILED");
    expect(await inbox(healthy.id)).toHaveLength(1);
    await wake(run.id);
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(1);
  });
  it("stops completed/cancelled nodes and creates a new reminder cycle for explicit rework", async () => {
    const run = await fixture();
    const saved = await arrange(run);
    const completed = await runs.command(context, run.id, "work", {
      type: "complete",
      expectedRevision: saved.revision,
      parameters: {},
    });
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(0);
    const reopened = await runs.command(context, run.id, "work", {
      type: "reopen",
      expectedRevision: completed.revision,
      reason: "Synthetic correction",
    });
    expect((await coordinator.get(context, run.id, "work")).assignmentRevision).toBe(2);
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(1);
    const changed = await coordinator.update(context, run.id, "work", {
      expectedRevision: reopened.revision,
      assignedUserId: assignee,
      dueAt: new Date(Date.now() + 8_000_000).toISOString(),
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "Change for cancellation test",
    });
    await runs.command(context, run.id, "work", {
      type: "cancel",
      expectedRevision: changed.revision,
    });
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(1);
  });
  it("preserves the notice identity and still permits current-user read state", async () => {
    const run = await fixture();
    await arrange(run);
    await new WorkflowAttentionDispatcher(database).dispatch();
    const [notice] = await inbox(run.id);
    await expect(
      withTenant(database.db, context, (tx) =>
        tx.update(notifications).set({ body: "Rewrite" }).where(eq(notifications.id, notice!.id)),
      ),
    ).rejects.toThrow();
    await withTenant(database.db, context, (tx) =>
      tx.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, notice!.id)),
    );
    expect((await inbox(run.id))[0]!.readAt).not.toBeNull();
  });
  it("runs via the standard attention scheduler and closes its timer cleanly", async () => {
    const run = await fixture();
    await arrange(run);
    const scheduler = new WorkflowAttentionScheduler(database, 20);
    try {
      scheduler.start();
      await expect.poll(async () => (await inbox(run.id)).length, { timeout: 5_000 }).toBe(1);
    } finally {
      await scheduler.close();
    }
    expect((await scheduler.dispatch()).checked).toBe(0);
  });
  it("paginates exact database timestamps, counts the full inbox and keeps reads scoped to one user", async () => {
    const userId = createEntityId(),
      memberId = createEntityId();
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Inbox acceptance')",
      [userId, "inbox-" + userId, userId + "@example.test"],
    );
    await database.client.unsafe(
      "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
      [memberId, tenantId, userId],
    );
    const recipient = { ...context, userId },
      service = new NotificationService(new DrizzleNotificationRepository(database));
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const row = await service.create(recipient, {
        kind: "system",
        title: "Synthetic inbox " + index,
        body: "Synthetic controlled record",
      });
      ids.push(row.id);
      await withTenant(database.db, recipient, (tx) =>
        tx
          .update(notifications)
          .set({
            createdAt: sql`'2026-10-01T00:00:00.000123Z'::timestamptz + ${index} * interval '1 microsecond'`,
          })
          .where(eq(notifications.id, row.id)),
      );
    }
    let cursor: string | undefined;
    const received: string[] = [];
    do {
      const page = await service.inbox(recipient, { unreadOnly: false, limit: 2, after: cursor });
      expect(page.total).toBe(5);
      expect(page.unread).toBe(5);
      received.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(received).toEqual([...ids].reverse());
    const once = await service.markRead(recipient, ids[0]!);
    expect((await service.markRead(recipient, ids[0]!)).readAt).toBe(once.readAt);
    expect(await service.inbox(recipient, { unreadOnly: true, limit: 1 })).toMatchObject({
      total: 4,
      unread: 4,
    });
    await expect(
      service.inbox(context, { unreadOnly: false, limit: 2, after: ids[0] }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.markRead(context, ids[1]!)).rejects.toMatchObject({ status: 404 });
    expect(await service.markAllRead(recipient)).toBe(4);
    expect(await service.inbox(recipient, { unreadOnly: true, limit: 30 })).toMatchObject({
      items: [],
      total: 0,
      unread: 0,
    });
    expect(
      await service.inbox(
        { ...recipient, tenantId: otherTenant },
        { unreadOnly: false, limit: 30 },
      ),
    ).toMatchObject({ items: [], total: 0 });
  });
  it("serializes role revocation after a delivery already authorized under locked grants", async () => {
    const run = await fixture();
    await arrange(run);
    let release!: () => void,
      reached = false,
      revokePid = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = new WorkflowAttentionDispatcher(database, async (tx, recipient, input) => {
      if (input.resourceId === run.id) {
        reached = true;
        await gate;
      }
      return recordNotificationInTransaction(tx, recipient, input);
    });
    const sending = dispatcher.dispatch();
    let revoking: Promise<unknown> | undefined;
    try {
      // Observe the actual transaction barrier; the default one-second poll is not a delivery SLA.
      await expect.poll(() => reached, { timeout: 5_000 }).toBe(true);
      revoking = withTenant(database.db, context, async (tx) => {
        const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        revokePid = pid[0]!.pid;
        return tx
          .update(roles)
          .set({
            permissions: all.filter((permission) => permission !== Permission.NotificationRead),
          })
          .where(eq(roles.id, assigneeRole));
      });
      await expect
        .poll(
          async () => {
            if (!revokePid) return false;
            const rows = await database.client.unsafe<{ waiting: boolean }[]>(
              "select wait_event_type='Lock' as waiting from pg_stat_activity where pid=$1",
              [revokePid],
            );
            return rows[0]?.waiting ?? false;
          },
          { timeout: 5_000 },
        )
        .toBe(true);
    } finally {
      release();
      await sending;
      await revoking;
      await grant(assigneeRole);
    }
    expect(await inbox(run.id)).toHaveLength(1);
  });
  it("clears scheduling on unassignment and keeps the published feature allowlist in effect", async () => {
    const run = await fixture();
    const saved = await arrange(run);
    const previous = process.env.WORKFLOW_CENTER_TENANT_IDS;
    try {
      process.env.WORKFLOW_CENTER_TENANT_IDS = otherTenant;
      await new WorkflowAttentionDispatcher(database).dispatch();
      expect(await inbox(run.id)).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_CENTER_TENANT_IDS;
      else process.env.WORKFLOW_CENTER_TENANT_IDS = previous;
    }
    const cleared = await coordinator.update(context, run.id, "work", {
      expectedRevision: saved.revision,
      assignedUserId: null,
      dueAt: null,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "Synthetic unassignment",
    });
    expect(cleared.nextCheckAt).toBeNull();
    await new WorkflowAttentionDispatcher(database).dispatch();
    expect(await inbox(run.id)).toHaveLength(0);
  });
});
