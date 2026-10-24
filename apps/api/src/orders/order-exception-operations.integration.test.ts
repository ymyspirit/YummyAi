import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  orderEvents,
  orderExceptionEvents,
  orderExceptions,
  orderLines,
  orderWorkItems,
  roles,
  memberships,
  membershipRoles,
  amazonOrderReportBatches,
  amazonOrderReportLines,
} from "@yummyai/database";
import { FollowupCoordinator } from "@yummyai/followup-core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw new Error("Disposable exception-operations runner required");
describe.sequential("reviewed order exceptions with real minimum roles", () => {
  const database = connectDatabase(),
    tenantId = createEntityId(),
    foreignTenant = createEntityId(),
    owner = createEntityId(),
    reader = createEntityId(),
    assigner = createEntityId(),
    outsider = createEntityId(),
    account = createEntityId(),
    amazonAccount = createEntityId(),
    ownerRole = createEntityId(),
    ownerMember = createEntityId();
  const handling = [
    Permission.OrderRead,
    Permission.OrderPiiRead,
    Permission.OrderWrite,
    Permission.NotificationRead,
    Permission.OrderAssign,
  ];
  const context: TenantContext = {
      tenantId,
      userId: owner,
      permissions: handling,
      dataScope: "tenant",
    },
    readOnly: TenantContext = {
      ...context,
      userId: reader,
      permissions: [Permission.OrderRead, Permission.OrderPiiRead, Permission.NotificationRead],
    },
    assignmentOnly: TenantContext = {
      ...readOnly,
      userId: assigner,
      permissions: [...readOnly.permissions, Permission.OrderAssign],
    },
    foreign: TenantContext = { ...context, tenantId: foreignTenant, userId: outsider };
  const vault = new SecretVault(Buffer.alloc(32, 123)),
    audit = new AuditService(database),
    orders = new OrderService(database, vault, audit);
  beforeAll(async () => {
    await migrateDatabase(database);
    for (const tenant of [tenantId, foreignTenant])
      await database.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Exception acceptance',$2)",
        [tenant, "exception-" + tenant],
      );
    for (const [index, actor] of [context, readOnly, assignmentOnly, foreign].entries()) {
      const member = index === 0 ? ownerMember : createEntityId(),
        role = index === 0 ? ownerRole : createEntityId();
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [
          actor.userId,
          "exception-" + actor.userId,
          actor.userId + "@example.test",
          ["Handling operator", "Read only", "Assignment only", "Other member"][index]!,
        ],
      );
      await database.client.unsafe(
        "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
        [member, actor.tenantId, actor.userId],
      );
      await database.client.unsafe(
        "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
        [role, actor.tenantId, "exception-" + role, JSON.stringify(actor.permissions)],
      );
      await database.client.unsafe(
        "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
        [actor.tenantId, member, role],
      );
    }
    await database.client.unsafe(
      "insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy','Synthetic exception shop','GLOBAL','etsy_oauth',$3)",
      [account, tenantId, owner],
    );
    await database.client.unsafe(
      "insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon','Synthetic report shop','NA','amazon_private',$3)",
      [amazonAccount, tenantId, owner],
    );
  });
  afterAll(async () => {
    await database.client.end();
  });
  async function order(platform: "amazon" | "etsy" = "etsy") {
    const id = createEntityId();
    return orders.ingestNormalized(context, {
      accountId: platform === "amazon" ? amazonAccount : account,
      platform,
      externalEventId: id + ":1",
      externalOrderId: id,
      providerStatus: "paid",
      placedAt: new Date().toISOString(),
      orderTotal: { amountMinor: 1000, currency: "USD" },
      lines: [
        {
          externalLineId: id + "-1",
          externalListingId: null,
          skuCode: null,
          title: "Synthetic exception item",
          quantity: 1,
          unitPrice: { amountMinor: 1000, currency: "USD" },
          customizationCount: 0,
        },
      ],
      redactedSource: { fixture: id },
      protectedDetails: null,
    });
  }
  async function open(orderId: string, message = "Synthetic business issue") {
    const basis = await orders.exceptionOperations(context, orderId);
    const input = {
      category: "address",
      code: "SYNTHETIC",
      message,
      idempotencyKey: createEntityId(),
      expectedOrderSequence: basis.orderSequence,
      expectedSourceChecksum: basis.sourceChecksum,
    };
    return { input, value: await orders.openExceptionReviewed(context, orderId, input) };
  }
  async function resolution(orderId: string, id: string) {
    const view = await orders.exceptionOperations(context, orderId, { exceptionId: id }),
      item = view.items[0]!;
    return {
      expectedSequence: item.sequence,
      expectedSourceChecksum: item.sourceChecksum,
      resolution: "Actual internal handling evidence checked",
      idempotencyKey: createEntityId(),
    };
  }
  async function stored(orderId: string) {
    return withTenant(database.db, context, async (tx) => ({
      exceptions: await tx
        .select()
        .from(orderExceptions)
        .where(eq(orderExceptions.orderId, orderId)),
      events: await tx
        .select()
        .from(orderExceptionEvents)
        .where(eq(orderExceptionEvents.orderId, orderId)),
      orderEvents: await tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)),
    }));
  }
  it("reads without creating events and admits the actual minimum handling role", async () => {
    const parent = await order(),
      before = await stored(parent.id),
      view = await orders.exceptionOperations(context, parent.id);
    expect(view).toMatchObject({ canCreate: true, total: 0, items: [] });
    expect(await stored(parent.id)).toEqual(before);
    expect(context.permissions).not.toContain(Permission.FinanceRead);
  });
  it("records and resolves the original event while leaving workflow and fulfillment unchanged", async () => {
    const parent = await order(),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id);
    const result = await orders.resolveExceptionReviewed(
      context,
      parent.id,
      created.value.id,
      command,
    );
    expect(result.status).toBe("resolved");
    const current = await orders.get(context, parent.id);
    expect(current.workflowState).toBe(parent.workflowState);
    expect(current.sideState).toBe(parent.sideState);
    expect((await stored(parent.id)).events.map((event) => event.status)).toEqual([
      "open",
      "resolved",
    ]);
  });
  it("protects the public order event history using current private-source permission", async () => {
    const parent = await order();
    await open(parent.id, "Synthetic protected handling message");
    expect(
      (await orders.operatorEvents(readOnly, parent.id)).some(
        (event) => event.message === "Synthetic protected handling message",
      ),
    ).toBe(true);
    await expect(
      orders.operatorEvents({ ...context, permissions: [Permission.OrderRead] }, parent.id),
    ).rejects.toMatchObject({ status: 403 });
    await withTenant(database.db, context, (tx) =>
      tx
        .update(roles)
        .set({ permissions: [Permission.OrderRead] })
        .where(eq(roles.id, ownerRole)),
    );
    try {
      await expect(orders.operatorEvents(context, parent.id)).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await withTenant(database.db, context, (tx) =>
        tx.update(roles).set({ permissions: handling }).where(eq(roles.id, ownerRole)),
      );
    }
  });
  it("replays identical create and resolve requests after their source advances, without another audit or event", async () => {
    const parent = await order(),
      created = await open(parent.id);
    expect((await orders.openExceptionReviewed(context, parent.id, created.input)).id).toBe(
      created.value.id,
    );
    const command = await resolution(parent.id, created.value.id);
    await orders.resolveExceptionReviewed(context, parent.id, created.value.id, command);
    const before = await stored(parent.id);
    expect(
      (await orders.resolveExceptionReviewed(context, parent.id, created.value.id, command)).status,
    ).toBe("resolved");
    expect(await stored(parent.id)).toEqual(before);
  });
  it("rejects a reused create key with changed content and an open key used to resolve", async () => {
    const parent = await order(),
      created = await open(parent.id),
      before = await stored(parent.id);
    await expect(
      orders.openExceptionReviewed(context, parent.id, {
        ...created.input,
        message: "Different issue",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const command = await resolution(parent.id, created.value.id);
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, created.value.id, {
        ...command,
        idempotencyKey: created.input.idempotencyKey,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await stored(parent.id)).toEqual(before);
  });
  it("binds resolve keys to the exception, request content and reviewed source", async () => {
    const parent = await order(),
      one = await open(parent.id),
      two = await open(parent.id),
      command = await resolution(parent.id, one.value.id);
    await orders.resolveExceptionReviewed(context, parent.id, one.value.id, command);
    const next = await resolution(parent.id, two.value.id);
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, two.value.id, {
        ...next,
        idempotencyKey: command.idempotencyKey,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, one.value.id, {
        ...command,
        resolution: "Changed handling evidence",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("reports a conflict for keys already committed by another order action, without partial exceptions", async () => {
    const parent = await order(),
      key = createEntityId();
    await orders.changeSideState(context, parent.id, {
      action: "hold",
      expectedSequence: parent.latestEventSequence,
      idempotencyKey: key,
      reason: "Synthetic original action",
    });
    const created = await open(parent.id);
    const basis = await orders.exceptionOperations(context, parent.id);
    const before = await stored(parent.id);
    await expect(
      orders.openExceptionReviewed(context, parent.id, {
        ...created.input,
        idempotencyKey: key,
        expectedOrderSequence: basis.orderSequence,
        expectedSourceChecksum: basis.sourceChecksum,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, created.value.id, {
        ...(await resolution(parent.id, created.value.id)),
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await stored(parent.id)).toEqual(before);
  });
  it("retains stale source conflicts even when an unrelated order state changes", async () => {
    const parent = await order(),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id),
      current = await orders.get(context, parent.id);
    await orders.changeSideState(context, parent.id, {
      action: "hold",
      expectedSequence: current.latestEventSequence,
      reason: "Synthetic hold",
      idempotencyKey: createEntityId(),
    });
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, created.value.id, command),
    ).rejects.toMatchObject({ status: 409 });
    expect((await orders.exceptionOperations(context, parent.id)).items[0]!.exception.status).toBe(
      "open",
    );
  });
  it("serializes competing resolve requests and preserves the winning evidence", async () => {
    const parent = await order(),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id);
    const results = await Promise.allSettled([
      orders.resolveExceptionReviewed(context, parent.id, created.value.id, command),
      orders.resolveExceptionReviewed(context, parent.id, created.value.id, {
        ...command,
        idempotencyKey: createEntityId(),
        resolution: "Other actual handling",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await stored(parent.id)).events).toHaveLength(2);
  });
  it("keeps read-only and assignment-only roles from resolving or registering exceptions", async () => {
    const parent = await order(),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id);
    for (const actor of [readOnly, assignmentOnly]) {
      const view = await orders.exceptionOperations(actor, parent.id);
      expect(view.canCreate).toBe(false);
      expect(view.items[0]!.canResolve).toBe(false);
      await expect(
        orders.resolveExceptionReviewed(actor, parent.id, created.value.id, command),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        orders.openExceptionReviewed(actor, parent.id, created.input),
      ).rejects.toMatchObject({ status: 403 });
    }
  });
  async function mixedScope(permission: string, scope: "self" | "team") {
    const id = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx
        .update(roles)
        .set({ permissions: handling.filter((p) => p !== permission) })
        .where(eq(roles.id, ownerRole));
      await tx
        .insert(roles)
        .values({
          id,
          tenantId,
          name: "Synthetic limited exception authority",
          permissions: [permission],
          dataScope: scope,
        });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: ownerMember, roleId: id });
    });
    return () =>
      withTenant(database.db, context, async (tx) => {
        await tx.delete(membershipRoles).where(eq(membershipRoles.roleId, id));
        await tx.delete(roles).where(eq(roles.id, id));
        await tx
          .update(roles)
          .set({ permissions: handling, dataScope: "tenant" })
          .where(eq(roles.id, ownerRole));
      });
  }
  it.each([Permission.OrderRead, Permission.OrderPiiRead])(
    "current order authority rejects mixed %s exception reads",
    async (permission) => {
      const parent = await order(),
        remove = await mixedScope(permission, "team");
      try {
        await expect(orders.exceptionOperations(context, parent.id)).rejects.toMatchObject({
          status: 403,
        });
      } finally {
        await remove();
      }
    },
  );
  it("current order authority keeps mixed write scope out of exception commands and replay", async () => {
    const parent = await order(),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id),
      before = await stored(parent.id);
    const remove = await mixedScope(Permission.OrderWrite, "self");
    try {
      const view = await orders.exceptionOperations(context, parent.id);
      expect(view.canCreate).toBe(false);
      expect(view.items[0]?.canResolve).toBe(false);
      await expect(
        orders.openExceptionReviewed(context, parent.id, created.input),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        orders.resolveExceptionReviewed(context, parent.id, created.value.id, command),
      ).rejects.toMatchObject({ status: 403 });
      expect(await stored(parent.id)).toEqual(before);
    } finally {
      await remove();
    }
  });

  it("rechecks current membership, role permissions and tenant scope instead of caller snapshots", async () => {
    const parent = await order(),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(roles)
        .set({ permissions: [Permission.OrderRead, Permission.OrderPiiRead] })
        .where(eq(roles.id, ownerRole)),
    );
    try {
      await expect(
        orders.resolveExceptionReviewed(context, parent.id, created.value.id, command),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await withTenant(database.db, context, (tx) =>
        tx.update(roles).set({ permissions: handling }).where(eq(roles.id, ownerRole)),
      );
    }
    await withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, ownerRole)),
    );
    try {
      await expect(orders.exceptionOperations(context, parent.id)).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await withTenant(database.db, context, (tx) =>
        tx.update(roles).set({ dataScope: "tenant" }).where(eq(roles.id, ownerRole)),
      );
    }
    await withTenant(database.db, context, (tx) =>
      tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, ownerMember)),
    );
    try {
      await expect(orders.exceptionOperations(context, parent.id)).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await database.client.unsafe("update memberships set status='active' where id=$1", [
        ownerMember,
      ]);
    }
  });
  it("rejects cross-tenant reads and writes without exposing message contents", async () => {
    const parent = await order(),
      created = await open(parent.id, "Synthetic restricted issue"),
      command = await resolution(parent.id, created.value.id);
    await expect(orders.exceptionOperations(foreign, parent.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(orders.operatorEvents(foreign, parent.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      orders.resolveExceptionReviewed(foreign, parent.id, created.value.id, command),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("uses both the current Amazon report deadline and expired state for every exception read and write", async () => {
    const parent = await order("amazon"),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id),
      batchId = createEntityId(),
      reportLineId = createEntityId();
    const [line] = await withTenant(database.db, context, (tx) =>
      tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, parent.id)),
    );
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(amazonOrderReportBatches).values({
        id: batchId,
        tenantId,
        accountId: amazonAccount,
        marketplaceId: "ATVPDKIKX0DER",
        fileName: "synthetic.tsv",
        reportChecksum: "c".repeat(64),
        encryptedReport: vault.encrypt("Synthetic report"),
        rowCount: 1,
        orderCount: 1,
        status: "completed",
        createdBy: owner,
        expiresAt: new Date(Date.now() + 3600000),
      });
      await tx.insert(amazonOrderReportLines).values({
        id: reportLineId,
        tenantId,
        orderId: parent.id,
        orderLineId: line!.id,
        batchId,
        sourceChecksum: "d".repeat(64),
        encryptedSource: vault.encrypt("Synthetic report line"),
        expiresAt: new Date(Date.now() + 3600000),
      });
    });
    expect((await orders.exceptionOperations(context, parent.id)).total).toBe(1);
    for (const patch of [
      { expiresAt: new Date(0) },
      { expiresAt: new Date(Date.now() + 3600000), state: "expired" },
    ]) {
      await withTenant(database.db, context, (tx) =>
        tx
          .update(amazonOrderReportLines)
          .set(patch)
          .where(eq(amazonOrderReportLines.id, reportLineId)),
      );
      await expect(orders.exceptionOperations(context, parent.id)).rejects.toMatchObject({
        status: 410,
      });
      await expect(orders.operatorExceptionViews(context, parent.id)).rejects.toMatchObject({
        status: 410,
      });
      await expect(orders.operatorEvents(context, parent.id)).rejects.toMatchObject({
        status: 410,
      });
      await expect(
        orders.resolveExceptionReviewed(context, parent.id, created.value.id, command),
      ).rejects.toMatchObject({ status: 410 });
      expect(
        (await orders.listExceptions(context)).some((item) => item.orderId === parent.id),
      ).toBe(false);
    }
  });
  it("clears expired sources from public reads, queue and writes, including the shared follow-up projection", async () => {
    const parent = await order(),
      created = await open(parent.id),
      command = await resolution(parent.id, created.value.id),
      [line] = await withTenant(database.db, context, (tx) =>
        tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, parent.id)),
      );
    await withTenant(database.db, context, (tx) =>
      tx.insert(orderWorkItems).values({
        id: line!.id,
        tenantId,
        encryptedDataKey: vault.encrypt(Buffer.alloc(32, 42).toString("base64")),
        expiresAt: new Date(0),
      }),
    );
    await expect(orders.exceptionOperations(context, parent.id)).rejects.toMatchObject({
      status: 410,
    });
    await expect(orders.operatorExceptionViews(context, parent.id)).rejects.toMatchObject({
      status: 410,
    });
    await expect(orders.operatorEvents(context, parent.id)).rejects.toMatchObject({ status: 410 });
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, created.value.id, command),
    ).rejects.toMatchObject({ status: 410 });
    expect((await orders.listExceptions(context)).some((item) => item.orderId === parent.id)).toBe(
      false,
    );
    const previous = process.env.BUSINESS_FOLLOWUP_TENANT_IDS;
    process.env.BUSINESS_FOLLOWUP_TENANT_IDS = "*";
    try {
      expect(
        (await new FollowupCoordinator(database).get(context, "order_exception", created.value.id))
          .item,
      ).toMatchObject({ available: false, isClosed: false });
    } finally {
      if (previous === undefined) delete process.env.BUSINESS_FOLLOWUP_TENANT_IDS;
      else process.env.BUSINESS_FOLLOWUP_TENANT_IDS = previous;
    }
  });
  it("uses one filtered snapshot for exact counts, stable pages and focused records", async () => {
    const parent = await order();
    for (let index = 0; index < 4; index++) await open(parent.id);
    const first = await orders.exceptionOperations(context, parent.id, { pageSize: 2 }),
      second = await orders.exceptionOperations(context, parent.id, { pageSize: 2, page: 2 });
    expect(first.total).toBe(4);
    expect(first.summary.open).toBe(4);
    expect(new Set([...first.items, ...second.items].map((item) => item.exception.id)).size).toBe(
      4,
    );
    expect(
      (
        await orders.exceptionOperations(context, parent.id, {
          exceptionId: second.items[0]!.exception.id,
        })
      ).items,
    ).toHaveLength(1);
  });
  it("identifies legacy missing event histories without filling or resolving them", async () => {
    const parent = await order(),
      id = createEntityId();
    await withTenant(database.db, context, (tx) =>
      tx.insert(orderExceptions).values({
        id,
        tenantId,
        orderId: parent.id,
        category: "address",
        code: "LEGACY",
        message: "Synthetic legacy record",
        openedBy: owner,
      }),
    );
    const view = await orders.exceptionOperations(context, parent.id);
    expect(view.items[0]).toMatchObject({ eventMissing: true, canResolve: false, sequence: 0 });
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, id, {
        expectedSequence: 1,
        expectedSourceChecksum: view.items[0]!.sourceChecksum,
        resolution: "Unverified history",
        idempotencyKey: createEntityId(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await stored(parent.id)).events).toHaveLength(0);
  });
  it("rolls event, order sequence and audit back together when auditing fails", async () => {
    const parent = await order(),
      basis = await orders.exceptionOperations(context, parent.id),
      before = await stored(parent.id),
      spy = vi
        .spyOn(audit, "recordInTransaction")
        .mockRejectedValueOnce(new Error("Synthetic audit failure"));
    try {
      await expect(
        orders.openExceptionReviewed(context, parent.id, {
          category: "address",
          code: "SYNTHETIC",
          message: "Synthetic issue",
          idempotencyKey: createEntityId(),
          expectedOrderSequence: basis.orderSequence,
          expectedSourceChecksum: basis.sourceChecksum,
        }),
      ).rejects.toThrow("Synthetic audit failure");
    } finally {
      spy.mockRestore();
    }
    expect(await stored(parent.id)).toEqual(before);
    expect((await orders.get(context, parent.id)).latestEventSequence).toBe(
      parent.latestEventSequence,
    );
  });
  it("rejects unreviewed HTTP-shaped commands rather than inventing a current source", async () => {
    const parent = await order(),
      created = await open(parent.id);
    await expect(
      orders.openExceptionReviewed(context, parent.id, {
        category: "address",
        code: "SYNTHETIC",
        message: "No basis",
        idempotencyKey: createEntityId(),
      }),
    ).rejects.toThrow();
    await expect(
      orders.resolveExceptionReviewed(context, parent.id, created.value.id, {
        resolution: "No basis",
        idempotencyKey: createEntityId(),
      }),
    ).rejects.toThrow();
  });
});
