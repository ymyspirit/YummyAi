import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  OrderLineResponsibilityCoordinator,
  OrderLineAttentionDispatcher,
  OrderTaskInboxReader,
  orderResponsibilityRecipient,
} from "@yummyai/order-core";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  orderWorkItems,
  orderLineResponsibilities,
  orderLines,
  roles,
  memberships,
  membershipRoles,
  notifications,
  recordNotificationInTransaction,
} from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw new Error("Disposable order responsibility runner required");
describe("order-line follow-up responsibility and durable attention", () => {
  const database = connectDatabase(),
    tenantId = createEntityId(),
    otherTenant = createEntityId(),
    owner = createEntityId(),
    assignee = createEntityId(),
    outsider = createEntityId(),
    ownerRole = createEntityId(),
    assigneeRole = createEntityId(),
    accountId = createEntityId(),
    otherAccount = createEntityId();
  const all = Object.values(Permission),
    context: TenantContext = { tenantId, userId: owner, permissions: all, dataScope: "tenant" },
    other: TenantContext = { ...context, tenantId: otherTenant, userId: outsider };
  const vault = new SecretVault(Buffer.alloc(32, 121)),
    orders = new OrderService(database, vault, new AuditService(database)),
    coordinator = new OrderLineResponsibilityCoordinator(database),
    inbox = new OrderTaskInboxReader(database);
  const previousFlag = process.env.ORDER_RESPONSIBILITY_TENANT_IDS;
  beforeAll(async () => {
    await migrateDatabase(database);
    process.env.ORDER_RESPONSIBILITY_TENANT_IDS = "*";
    await database.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Order follow-up acceptance',$2),($3,'Other follow-up acceptance',$4)",
      [tenantId, "follow-up-" + tenantId, otherTenant, "follow-up-" + otherTenant],
    );
    for (const [index, userId] of [owner, assignee, outsider].entries()) {
      const tenant = index === 2 ? otherTenant : tenantId,
        member = createEntityId(),
        role = index === 0 ? ownerRole : index === 1 ? assigneeRole : createEntityId();
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [
          userId,
          "follow-up-" + userId,
          userId + "@example.test",
          ["Owner", "Assignee", "Other member"][index]!,
        ],
      );
      await database.client.unsafe(
        "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
        [member, tenant, userId],
      );
      await database.client.unsafe(
        "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
        [role, tenant, "Follow-up role " + index, JSON.stringify(all)],
      );
      await database.client.unsafe(
        "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
        [tenant, member, role],
      );
    }
    for (const [id, tenant, user] of [
      [accountId, tenantId, owner],
      [otherAccount, otherTenant, outsider],
    ])
      await database.client.unsafe(
        "insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)",
        [id!, tenant!, "Synthetic shop " + id, user!],
      );
  });
  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.ORDER_RESPONSIBILITY_TENANT_IDS;
    else process.env.ORDER_RESPONSIBILITY_TENANT_IDS = previousFlag;
    await database.client.end();
  });
  async function line(ctx = context, label?: string, createWork = true) {
    const identity = createEntityId();
    const order = await orders.ingestNormalized(ctx, {
      accountId: ctx.tenantId === tenantId ? accountId : otherAccount,
      platform: "etsy",
      externalEventId: identity + ":v1",
      externalOrderId: identity,
      providerStatus: "paid",
      placedAt: new Date().toISOString(),
      orderTotal: { amountMinor: 1000, currency: "USD" },
      lines: [
        {
          externalLineId: identity + "-1",
          externalListingId: null,
          skuCode: null,
          title: label ?? "Synthetic follow-up item " + identity,
          quantity: 1,
          unitPrice: { amountMinor: 1000, currency: "USD" },
          customizationCount: 0,
        },
      ],
      redactedSource: { fixture: identity },
      protectedDetails: null,
    });
    const [created] = await withTenant(database.db, ctx, (tx) =>
      tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, order.id)),
    );
    if (createWork)
      await withTenant(database.db, ctx, (tx) =>
        tx.insert(orderWorkItems).values({
          id: created!.id,
          tenantId: ctx.tenantId,
          encryptedDataKey: vault.encrypt(Buffer.alloc(32, 79).toString("base64")),
          expiresAt: new Date(Date.now() + 86400000),
        }),
      );
    return created!.id;
  }
  async function assign(id: string, dueAt: string | null = null, escalate = false) {
    const view = await coordinator.get(context, id);
    return coordinator.update(context, id, {
      expectedRevision: view.revision,
      expectedSourceChecksum: view.sourceChecksum,
      assignedUserId: assignee,
      dueAt,
      escalationUserId: escalate ? owner : null,
      escalationDelayMinutes: escalate ? 1 : null,
      reason: "initial_assignment",
    });
  }
  async function stored(id: string) {
    const [row] = await withTenant(database.db, context, (tx) =>
      tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, id)),
    );
    return row!;
  }
  async function arrangement(id: string) {
    const [row] = await withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(orderLineResponsibilities)
        .where(eq(orderLineResponsibilities.workItemId, id)),
    );
    return row!;
  }
  async function force(id: string) {
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderLineResponsibilities)
        .set({ attentionNextAt: new Date(0) })
        .where(eq(orderLineResponsibilities.workItemId, id)),
    );
  }
  async function notices(id: string) {
    return withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.resourceType, "order_work_item"), eq(notifications.resourceId, id)),
        ),
    );
  }
  async function grant(role: string, permissions: string[], scope: "tenant" | "self" = "tenant") {
    await withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ permissions, dataScope: scope }).where(eq(roles.id, role)),
    );
  }
  it("reads unconfigured arrangements without creating facts or changing business versions", async () => {
    const id = await line(),
      before = await stored(id),
      view = await coordinator.get(context, id);
    expect(view).toMatchObject({
      lineId: id,
      revision: 0,
      assignmentRevision: 0,
      assignedUserId: null,
      dueAt: null,
      active: true,
      canManage: true,
      reminderCycle: 0,
    });
    expect(view.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: assignee, canAssign: true })]),
    );
    expect(await arrangement(id)).toBeUndefined();
    expect(await stored(id)).toEqual(before);
  });
  it("stores a distinct internal deadline and arrangement revision without modifying source/order state", async () => {
    const id = await line(),
      before = await stored(id),
      view = await assign(id, "2099-01-01T00:00:00Z", true);
    expect(view).toMatchObject({
      revision: 1,
      assignedUserId: assignee,
      escalationUserId: owner,
      reminderCycle: 1,
      dueAt: "2099-01-01T00:00:00.000Z",
    });
    expect(await stored(id)).toEqual(before);
    expect((await arrangement(id)).internalDueAt?.toISOString()).toBe(view.dueAt);
  });
  it("does not renew an unchanged arrangement and serializes conflicting concurrent edits", async () => {
    const id = await line(),
      view = await assign(id),
      input = {
        expectedRevision: view.revision,
        expectedSourceChecksum: view.sourceChecksum,
        assignedUserId: assignee,
        dueAt: null,
        escalationUserId: null,
        escalationDelayMinutes: null,
        reason: "handoff",
      };
    expect((await coordinator.update(context, id, input)).revision).toBe(1);
    const updates = await Promise.allSettled([
      coordinator.update(context, id, { ...input, dueAt: "2098-01-01T00:00:00Z" }),
      coordinator.update(context, id, { ...input, dueAt: "2097-01-01T00:00:00Z" }),
    ]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await arrangement(id)).revision).toBe(2);
  });
  it("pins actual order exceptions and rejects stale business evidence while retaining their owning events", async () => {
    const id = await line(),
      view = await coordinator.get(context, id),
      before = await orders.get(context, view.orderId);
    const opened = await orders.openException(context, view.orderId, {
      category: "address",
      code: "SYNTHETIC_REVIEW",
      message: "Synthetic exception only",
      idempotencyKey: "exception-" + createEntityId(),
    });
    const current = await coordinator.get(context, id);
    expect(current.openExceptionCount).toBe(1);
    expect(current.currentTaskKey).toBe("order_exception");
    expect(current.sourceChecksum).not.toBe(view.sourceChecksum);
    await expect(
      coordinator.update(context, id, {
        expectedRevision: 0,
        expectedSourceChecksum: view.sourceChecksum,
        assignedUserId: assignee,
        dueAt: null,
        escalationUserId: null,
        escalationDelayMinutes: null,
        reason: "initial_assignment",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await assign(id);
    expect(
      (await orders.listExceptions(context, "open")).some((item) => item.id === opened.id),
    ).toBe(true);
    expect((await orders.get(context, view.orderId)).workflowState).toBe(before.workflowState);
    await orders.resolveException(context, view.orderId, opened.id, {
      resolution: "Synthetic evidence reviewed",
      idempotencyKey: "resolve-" + createEntityId(),
    });
    expect((await coordinator.get(context, id)).openExceptionCount).toBe(0);
  });
  async function limitedRole(actor: string, permissions: string[], scope: "self" | "team") {
    const id = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      const [member] = await tx.select().from(memberships).where(eq(memberships.userId, actor));
      if (!member) throw new Error("Synthetic membership missing");
      await tx
        .insert(roles)
        .values({
          id,
          tenantId,
          name: "Synthetic limited follow-up",
          permissions,
          dataScope: scope,
        });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: member.id, roleId: id });
    });
    return () =>
      withTenant(database.db, context, async (tx) => {
        await tx.delete(membershipRoles).where(eq(membershipRoles.roleId, id));
        await tx.delete(roles).where(eq(roles.id, id));
      });
  }
  it.each([Permission.OrderRead, Permission.OrderPiiRead])(
    "current order authority keeps follow-up %s scope independent",
    async (permission) => {
      const id = await line(),
        remove = await limitedRole(owner, [permission], "self");
      try {
        await grant(
          ownerRole,
          all.filter((p) => p !== permission),
        );
        await expect(coordinator.get(context, id)).rejects.toMatchObject({ status: 403 });
        await expect(inbox.list(context, {})).rejects.toMatchObject({ status: 403 });
      } finally {
        await grant(ownerRole, all);
        await remove();
      }
    },
  );
  it("current order authority does not turn limited assignment into tenant management", async () => {
    const id = await line(),
      remove = await limitedRole(owner, [Permission.OrderAssign], "team");
    try {
      await grant(
        ownerRole,
        all.filter((p) => p !== Permission.OrderAssign),
      );
      const view = await coordinator.get(context, id);
      expect(view.canManage).toBe(false);
      await expect(
        coordinator.update(context, id, {
          expectedRevision: 0,
          expectedSourceChecksum: view.sourceChecksum,
          assignedUserId: assignee,
          dueAt: null,
          escalationUserId: null,
          escalationDelayMinutes: null,
          reason: "initial_assignment",
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await arrangement(id)).toBeUndefined();
    } finally {
      await grant(ownerRole, all);
      await remove();
    }
  });
  it("current order authority distinguishes handling scope from personal notification scope", async () => {
    const removeWrite = await limitedRole(assignee, [Permission.OrderWrite], "self");
    try {
      await grant(
        assigneeRole,
        all.filter((p) => p !== Permission.OrderWrite),
      );
      expect(
        await withTenant(database.db, context, (tx) =>
          orderResponsibilityRecipient(tx, tenantId, assignee, true),
        ),
      ).toBeUndefined();
      expect(
        await withTenant(database.db, context, (tx) =>
          orderResponsibilityRecipient(tx, tenantId, assignee, false),
        ),
      ).toBeDefined();
    } finally {
      await grant(assigneeRole, all);
      await removeWrite();
    }
    const removeNotification = await limitedRole(assignee, [Permission.NotificationRead], "self");
    try {
      await grant(
        assigneeRole,
        all.filter((p) => p !== Permission.NotificationRead),
      );
      expect(
        await withTenant(database.db, context, (tx) =>
          orderResponsibilityRecipient(tx, tenantId, assignee, true),
        ),
      ).toBeDefined();
    } finally {
      await grant(assigneeRole, all);
      await removeNotification();
    }
  });

  it("intersects current grants and scope and never grants an assignee access", async () => {
    const id = await line(),
      view = await coordinator.get(context, id),
      input = {
        expectedRevision: 0,
        expectedSourceChecksum: view.sourceChecksum,
        assignedUserId: assignee,
        dueAt: null,
        escalationUserId: null,
        escalationDelayMinutes: null,
        reason: "initial_assignment",
      };
    try {
      await grant(
        ownerRole,
        all.filter((value) => value !== Permission.OrderAssign),
      );
      await expect(coordinator.update(context, id, input)).rejects.toMatchObject({ status: 403 });
      await grant(ownerRole, all, "self");
      await expect(coordinator.get(context, id)).rejects.toMatchObject({ status: 403 });
      await grant(ownerRole, all);
      await grant(
        assigneeRole,
        all.filter((value) => value !== Permission.OrderWrite),
      );
      await expect(coordinator.update(context, id, input)).rejects.toMatchObject({ status: 400 });
    } finally {
      await grant(ownerRole, all);
      await grant(assigneeRole, all);
    }
    expect(await arrangement(id)).toBeUndefined();
  });
  it("isolates tenants and rejects a recipient from another organization", async () => {
    const id = await line();
    await expect(coordinator.get(other, id)).rejects.toMatchObject({ status: 404 });
    const view = await coordinator.get(context, id);
    await expect(
      coordinator.update(context, id, {
        expectedRevision: 0,
        expectedSourceChecksum: view.sourceChecksum,
        assignedUserId: outsider,
        dueAt: null,
        escalationUserId: null,
        escalationDelayMinutes: null,
        reason: "initial_assignment",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await withTenant(database.db, other, (tx) =>
        tx
          .select()
          .from(orderLineResponsibilities)
          .where(eq(orderLineResponsibilities.workItemId, id)),
      ),
    ).toEqual([]);
  });
  it("sends one generic assignment and keeps its durable receipt across repeated dispatchers", async () => {
    const id = await line();
    await assign(id, "2099-01-01T00:00:00Z");
    const before = await stored(id);
    await new OrderLineAttentionDispatcher(database).dispatch();
    await force(id);
    await new OrderLineAttentionDispatcher(database).dispatch();
    const delivered = await notices(id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.metadata).toMatchObject({
      stage: "assigned",
      assignmentRevision: 1,
      cycle: 1,
    });
    expect(JSON.stringify(delivered)).not.toContain("Synthetic follow-up item");
    expect(JSON.stringify(delivered)).not.toContain("encryptedDataKey");
    expect(await stored(id)).toEqual(before);
  });
  it("sends the current due/escalation stages atomically without obsolete assignment alerts", async () => {
    const id = await line();
    await assign(id, "2000-01-01T00:00:00Z", true);
    await Promise.all([
      new OrderLineAttentionDispatcher(database).dispatch(),
      new OrderLineAttentionDispatcher(database).dispatch(),
    ]);
    expect((await notices(id)).map((item) => item.metadata.stage).sort()).toEqual([
      "due",
      "escalated",
    ]);
    await force(id);
    await new OrderLineAttentionDispatcher(database).dispatch();
    expect(await notices(id)).toHaveLength(2);
  });
  it("rechecks current recipient grants at delivery and resumes after authorization is restored", async () => {
    const id = await line();
    await assign(id);
    try {
      await grant(
        assigneeRole,
        all.filter((value) => value !== Permission.OrderWrite),
      );
      await new OrderLineAttentionDispatcher(database).dispatch();
      expect(await notices(id)).toHaveLength(0);
      expect((await arrangement(id)).attentionLastError).toBe("RECIPIENT_UNAVAILABLE");
    } finally {
      await grant(assigneeRole, all);
    }
    await force(id);
    await new OrderLineAttentionDispatcher(database).dispatch();
    expect(await notices(id)).toHaveLength(1);
  });
  it("rolls back a per-item notification failure while delivering unrelated valid items", async () => {
    const failed = await line(),
      healthy = await line();
    await assign(failed);
    await assign(healthy);
    const dispatcher = new OrderLineAttentionDispatcher(database, async (tx, recipient, input) => {
      const row = await recordNotificationInTransaction(tx, recipient, input);
      if (input.resourceId === failed) throw new Error("Synthetic failure after insertion");
      return row;
    });
    await dispatcher.dispatch();
    expect(await notices(failed)).toHaveLength(0);
    expect(await notices(healthy)).toHaveLength(1);
    expect((await arrangement(failed)).attentionLastError).toBe("DISPATCH_FAILED");
    await force(failed);
    await new OrderLineAttentionDispatcher(database).dispatch();
    expect(await notices(failed)).toHaveLength(1);
  });
  it("silences archived work and creates a new notification cycle from actual restored business evidence", async () => {
    const id = await line();
    await assign(id);
    await new OrderLineAttentionDispatcher(database).dispatch();
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ archivedAt: new Date(), projectionVersion: 2 })
        .where(eq(orderWorkItems.id, id)),
    );
    await force(id);
    await new OrderLineAttentionDispatcher(database).dispatch();
    expect(await notices(id)).toHaveLength(1);
    expect((await coordinator.get(context, id)).active).toBe(false);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ archivedAt: null, projectionVersion: 3 })
        .where(eq(orderWorkItems.id, id)),
    );
    await force(id);
    await new OrderLineAttentionDispatcher(database).dispatch();
    expect(await notices(id)).toHaveLength(2);
    expect((await arrangement(id)).attentionCycle).toBe(3);
  });
  it("stops new arrangements and reminders after privacy expiry", async () => {
    const id = await line();
    await assign(id);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ expiresAt: new Date(0) })
        .where(eq(orderWorkItems.id, id)),
    );
    await new OrderLineAttentionDispatcher(database).dispatch();
    expect(await notices(id)).toHaveLength(0);
    expect((await arrangement(id)).attentionNextAt).toBeNull();
    expect(await coordinator.get(context, id)).toMatchObject({
      available: false,
      canManage: false,
    });
  });
  it("keeps new API and background work disabled until this tenant is explicitly enabled", async () => {
    const id = await line();
    process.env.ORDER_RESPONSIBILITY_TENANT_IDS = "";
    try {
      await expect(coordinator.get(context, id)).rejects.toMatchObject({ status: 404 });
      await expect(inbox.list(context)).rejects.toMatchObject({ status: 404 });
      expect(await new OrderLineAttentionDispatcher(database).dispatch()).toEqual({
        checked: 0,
        notices: 0,
        deferred: 0,
        failures: 0,
      });
    } finally {
      process.env.ORDER_RESPONSIBILITY_TENANT_IDS = "*";
    }
  });
  it("reads full filtered assignment counts before stable paging without creating task facts", async () => {
    const prefix = "inbox-paging-" + createEntityId(),
      ids = await Promise.all(Array.from({ length: 4 }, () => line(context, prefix))),
      assigned = { ...context, userId: assignee };
    await assign(ids[0]!, "2000-01-01T00:00:00Z");
    await assign(ids[1]!, "2099-01-01T00:00:00Z");
    const counts = () =>
      withTenant(
        database.db,
        context,
        async (tx) =>
          (
            await tx.execute(sql`
      select (select count(*) from order_line_responsibilities) arrangements,
        (select count(*) from order_work_events) events,
        (select count(*) from notifications) notices`)
          )[0],
      );
    const before = await counts();
    const first = await inbox.list(assigned, { assignment: "visible", q: prefix, pageSize: 1 }),
      second = await inbox.list(assigned, {
        assignment: "visible",
        q: prefix,
        pageSize: 1,
        page: 2,
      });
    expect(first.total).toBe(4);
    expect(first.summary).toMatchObject({ overdue: 1, unassigned: 2 });
    expect(second.summary).toEqual(first.summary);
    expect(first.items[0]!.id).toBe(ids[0]);
    expect(second.items[0]!.id).toBe(ids[1]);
    expect((await inbox.list(assigned, { q: prefix })).total).toBe(2);
    expect((await inbox.list(assigned, { q: prefix, assignment: "unassigned" })).total).toBe(2);
    expect(
      (await inbox.list(assigned, { q: prefix, assignment: "mine", due: "overdue" })).items.map(
        (row) => row.id,
      ),
    ).toEqual([ids[0]]);
    expect(await counts()).toEqual(before);
  });
  it("intersects current inbox membership grants and never exposes another tenant or widens self scope", async () => {
    const prefix = "inbox-scope-" + createEntityId();
    await line(context, prefix);
    await line(other, prefix);
    expect((await inbox.list(context, { assignment: "visible", q: prefix })).total).toBe(1);
    expect((await inbox.list(other, { assignment: "visible", q: prefix })).total).toBe(1);
    try {
      await grant(ownerRole, [Permission.OrderRead, Permission.OrderPiiRead]);
      expect((await inbox.list(context, { assignment: "visible", q: prefix })).total).toBe(1);
      await grant(ownerRole, [Permission.OrderRead]);
      await expect(inbox.list(context, { assignment: "visible" })).rejects.toMatchObject({
        status: 403,
      });
      await grant(ownerRole, all, "self");
      await expect(inbox.list(context, { assignment: "visible" })).rejects.toMatchObject({
        status: 403,
      });
      await grant(ownerRole, all);
      await expect(inbox.list({ ...context, dataScope: "self" })).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        inbox.list({ ...context, permissions: [Permission.OrderRead] }),
      ).rejects.toMatchObject({ name: "ForbiddenError" });
    } finally {
      await grant(ownerRole, all);
    }
  });
  it("derives order-level exception follow-up from actual open and resolved events without replacing business state", async () => {
    const prefix = "inbox-exception-" + createEntityId(),
      id = await line(context, prefix),
      view = await coordinator.get(context, id),
      before = await stored(id);
    const opened = await orders.openException(context, view.orderId, {
      category: "address",
      code: "SYNTHETIC_INBOX",
      message: "Synthetic exception",
      idempotencyKey: createEntityId(),
    });
    const read = () => inbox.list(context, { assignment: "visible", q: prefix });
    expect((await read()).items[0]).toMatchObject({
      taskKey: "order_exception",
      title: "核对订单级异常",
      openExceptionCount: 1,
      needsAttention: true,
    });
    await orders.resolveException(context, view.orderId, opened.id, {
      resolution: "Synthetic review",
      idempotencyKey: createEntityId(),
    });
    expect((await read()).items[0]).toMatchObject({
      taskKey: "review_order",
      openExceptionCount: 0,
    });
    expect(await stored(id)).toEqual(before);
    expect(await arrangement(id)).toBeUndefined();
  });
  it("keeps expired and unprepared work visible as unavailable rather than inventing completion or a new record", async () => {
    const prefix = "inbox-unavailable-" + createEntityId(),
      expired = await line(context, prefix),
      unprepared = await line(context, prefix, false);
    await assign(expired);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ expiresAt: new Date(0) })
        .where(eq(orderWorkItems.id, expired)),
    );
    const result = await inbox.list(context, { assignment: "visible", q: prefix });
    expect(result.total).toBe(2);
    expect(result.summary.unavailable).toBe(2);
    expect(result.items.find((row) => row.id === expired)).toMatchObject({
      isClosed: false,
      hasWorkRecord: true,
      sourceAvailable: false,
    });
    expect(result.items.find((row) => row.id === unprepared)).toMatchObject({
      isClosed: false,
      hasWorkRecord: false,
      sourceAvailable: false,
    });
    expect(await stored(unprepared)).toBeUndefined();
    expect(await arrangement(unprepared)).toBeUndefined();
  });
  it("filters actual archival and restoration while retaining the original assignment and internal deadline", async () => {
    const prefix = "inbox-archive-" + createEntityId(),
      id = await line(context, prefix);
    await assign(id, "2000-01-01T00:00:00Z");
    const before = await arrangement(id);
    await withTenant(database.db, context, (tx) =>
      tx.update(orderWorkItems).set({ archivedAt: new Date() }).where(eq(orderWorkItems.id, id)),
    );
    expect((await inbox.list(context, { assignment: "visible", q: prefix })).total).toBe(0);
    const closed = await inbox.list(context, {
      assignment: "visible",
      q: prefix,
      status: "closed",
    });
    expect(closed.items[0]).toMatchObject({
      isClosed: true,
      isOverdue: false,
      taskKey: "archived",
      assignedUserId: assignee,
    });
    await withTenant(database.db, context, (tx) =>
      tx.update(orderWorkItems).set({ archivedAt: null }).where(eq(orderWorkItems.id, id)),
    );
    expect(
      (await inbox.list(context, { assignment: "visible", q: prefix, due: "overdue" })).total,
    ).toBe(1);
    expect(await arrangement(id)).toEqual(before);
  });
  it("uses literal search and the selected local calendar day while rejecting unsupported or extra query scope", async () => {
    const prefix = "inbox-literal-" + createEntityId(),
      marker = prefix + "%_\\",
      id = await line(context, marker);
    await line(context, prefix + "-other");
    const bounds = await withTenant(
      database.db,
      context,
      async (tx) =>
        (
          await tx.execute<{ start: Date }>(sql`
      select date_trunc('day', current_timestamp at time zone 'Pacific/Kiritimati') at time zone 'Pacific/Kiritimati' as start`)
        )[0]!,
    );
    const dueAt = new Date(new Date(bounds.start).getTime() + 30 * 60_000).toISOString();
    await assign(id, dueAt);
    const result = await inbox.list(
      { ...context, userId: assignee },
      { q: marker, timeZone: "Pacific/Kiritimati", due: "today" },
    );
    expect(result.items.map((row) => row.id)).toEqual([id]);
    expect(result.summary.dueToday).toBe(1);
    expect(result.items[0]!.platformShipByAt).toBeNull();
    await expect(inbox.list(context, { timeZone: "invalid/timezone" })).rejects.toThrow();
    await expect(inbox.list(context, { tenantId: otherTenant })).rejects.toThrow();
    await expect(inbox.list(context, { status: "closed", due: "overdue" })).rejects.toThrow();
  });
});
