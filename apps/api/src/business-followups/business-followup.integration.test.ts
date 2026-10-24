import { IncomingInspectionService } from "../procurement/incoming-inspection.service.js";
import { recordInspectedReceiptFixture } from "../procurement/incoming-inspection.fixtures.js";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { FollowupSource } from "@yummyai/contracts/operations/followup";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  orderLines,
  orderWorkItems,
  roles,
  memberships,
  membershipRoles,
  notifications,
  recordNotificationInTransaction,
} from "@yummyai/database";
import {
  FollowupCoordinator,
  FollowupInboxReader,
  FollowupAttentionDispatcher,
} from "@yummyai/followup-core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { OrderService } from "../orders/order.service.js";
import { OrderAfterSalesService } from "../orders/order-after-sales.service.js";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw new Error("Disposable business follow-up runner required");
describe.sequential("source-owned business follow-up arrangements", () => {
  const database = connectDatabase(),
    tenantId = createEntityId(),
    foreignTenant = createEntityId(),
    owner = createEntityId(),
    assignee = createEntityId(),
    outsider = createEntityId(),
    assigneeRole = createEntityId(),
    supplier = createEntityId(),
    account = createEntityId();
  const all = Object.values(Permission),
    context: TenantContext = { tenantId, userId: owner, permissions: all, dataScope: "tenant" },
    foreign: TenantContext = { ...context, tenantId: foreignTenant, userId: outsider };
  const vault = new SecretVault(Buffer.alloc(32, 119)),
    audit = new AuditService(database),
    inventory = new InventoryService(database, audit),
    procurement = new ProcurementService(database, inventory, audit),
    orders = new OrderService(database, vault, audit),
    afterSales = new OrderAfterSalesService(database, vault, audit),
    coordinator = new FollowupCoordinator(database),
    inbox = new FollowupInboxReader(database);
  const oldFlag = process.env.BUSINESS_FOLLOWUP_TENANT_IDS;
  let locationId: string, stockItemId: string;
  beforeAll(async () => {
    await migrateDatabase(database);
    process.env.BUSINESS_FOLLOWUP_TENANT_IDS = "*";
    for (const [tenant, title] of [
      [tenantId, "Follow-up"],
      [foreignTenant, "Other"],
    ])
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [
        tenant!,
        title!,
        "followup-" + tenant,
      ]);
    for (const [userId, tenant, role, name] of [
      [owner, tenantId, createEntityId(), "Owner"],
      [assignee, tenantId, assigneeRole, "Operator %_ literal"],
      [outsider, foreignTenant, createEntityId(), "Other member"],
    ]) {
      const member = createEntityId();
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
        [userId!, "followup-" + userId, userId + "@example.test", name!],
      );
      await database.client.unsafe(
        "insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')",
        [member, tenant!, userId!],
      );
      await database.client.unsafe(
        "insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')",
        [role!, tenant!, "followup-" + role, JSON.stringify(all)],
      );
      await database.client.unsafe(
        "insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
        [tenant!, member, role!],
      );
    }
    await database.client.unsafe(
      "insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy','Followup shop','GLOBAL','etsy_oauth',$3)",
      [account, tenantId, owner],
    );
    await database.client.unsafe(
      "insert into fulfillment_suppliers(id,tenant_id,name,kind,status,region_code,settlement_currency,priority,created_by) values($1,$2,'Followup supplier','manual','active','US','USD',1,$3)",
      [supplier, tenantId, owner],
    );
    const warehouse = await inventory.createWarehouse(context, {
      code: "FOLLOWUP",
      name: "Followup warehouse",
      type: "owned",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
    });
    locationId = (
      await inventory.createLocation(context, {
        warehouseId: warehouse.id,
        code: "RECEIVE",
        name: "Receiving",
      })
    ).id;
    stockItemId = (
      await inventory.createStockItem(context, {
        skuId: null,
        code: "FOLLOWUP",
        name: "Synthetic blank",
        baseUnit: "each",
      })
    ).id;
  });
  afterAll(async () => {
    if (oldFlag === undefined) delete process.env.BUSINESS_FOLLOWUP_TENANT_IDS;
    else process.env.BUSINESS_FOLLOWUP_TENANT_IDS = oldFlag;
    await database.client.end();
  });
  const table = (source: FollowupSource) =>
    sql.identifier(
      {
        procurement_order: "procurement_order_followups",
        after_sales_case: "after_sales_case_followups",
        order_exception: "order_exception_followups",
      }[source],
    );
  async function po() {
    return procurement.createPurchaseOrder(context, {
      code: "PO-" + createEntityId().toUpperCase(),
      supplierId: supplier,
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2099-06-01T00:00:00.000Z",
      lines: [
        {
          lineKey: "ONE",
          stockItemId,
          destinationLocationId: locationId,
          quantity: 10,
          unit: "each",
          unitCostMinor: 50,
        },
      ],
      idempotencyKey: createEntityId(),
    });
  }
  async function approve(id: string) {
    return procurement.reviewPurchaseOrder(context, id, {
      expectedVersion: 1,
      decision: "approved",
      reasonCode: "SYNTHETIC",
      idempotencyKey: createEntityId(),
    });
  }
  async function receive(id: string, quantity = 10) {
    const [recording] = await withTenant(database.db, context, tx => tx.execute<{ milliseconds: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`));
    return recordInspectedReceiptFixture(procurement, new IncomingInspectionService(database, procurement, audit), context, id, {
      expectedVersion: 1,
      // A deliberately past synthetic event, independent of the host clock and
      // postgres.js raw timestamp representation. Product future-time gates stay strict.
      receivedAt: new Date(Number(recording!.milliseconds) - 1000).toISOString(),
      externalReference: null,
      lines: [
        {
          lineKey: "ONE",
          receivedQuantity: quantity,
          rejectedQuantity: 0,
          rejectionReasonCode: null,
          lotCode: createEntityId().toUpperCase(),
          expiresAt: null,
        },
      ],
      idempotencyKey: createEntityId(),
    });
  }
  async function invoice(id: string, quantity = 10, unitCostMinor = 50) {
    return procurement.recordInvoice(context, id, {
      invoiceNumber: createEntityId(),
      currency: "USD",
      issuedAt: new Date().toISOString(),
      lines: [{ lineKey: "ONE", invoicedQuantity: quantity, unitCostMinor }],
      idempotencyKey: createEntityId(),
    });
  }
  async function order() {
    const identity = createEntityId(),
      current = await orders.ingestNormalized(context, {
        accountId: account,
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
            title: "Synthetic followup",
            quantity: 1,
            unitPrice: { amountMinor: 1000, currency: "USD" },
            customizationCount: 0,
          },
        ],
        redactedSource: { fixture: identity },
        protectedDetails: null,
      });
    return current;
  }
  async function caseRecord() {
    const parent = await order();
    return afterSales.create(context, parent.id, {
      type: "quality_issue",
      reasonCode: "SYNTHETIC",
      summary: "PRIVATE_SUMMARY_MUST_NOT_LEAK",
      idempotencyKey: createEntityId(),
    });
  }
  async function exception() {
    const parent = await order();
    return orders.openException(context, parent.id, {
      category: "address",
      code: "SYNTHETIC",
      message: "PRIVATE_EXCEPTION_MUST_NOT_LEAK",
      idempotencyKey: createEntityId(),
    });
  }
  async function assign(
    source: FollowupSource,
    id: string,
    dueAt: string | null = null,
    escalate = false,
  ) {
    const current = await coordinator.get(context, source, id);
    return coordinator.update(context, source, id, {
      expectedRevision: current.responsibility.revision,
      expectedSourceChecksum: current.item.sourceChecksum,
      assignedUserId: assignee,
      dueAt,
      escalationUserId: escalate ? owner : null,
      escalationDelayMinutes: escalate ? 1 : null,
      reason: "initial_assignment",
    });
  }
  async function force(source: FollowupSource, id: string) {
    await withTenant(database.db, context, (tx) =>
      tx.execute(
        sql`update ${table(source)} set attention_next_at='1970-01-01'::timestamptz where object_id=${id}`,
      ),
    );
  }
  async function notices(source: FollowupSource, id: string) {
    return withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(notifications)
        .where(sql`${notifications.resourceType}=${source} and ${notifications.resourceId}=${id}`),
    );
  }
  async function permissions(values = all) {
    await withTenant(database.db, context, (tx) =>
      tx.update(roles).set({ permissions: values }).where(eq(roles.id, assigneeRole)),
    );
  }

  async function mixedBusinessScope(permission: string, scope: "self" | "team") {
    const id = createEntityId();
    let originalRole: string;
    await withTenant(database.db, context, async (tx) => {
      const [member] = await tx.select().from(memberships).where(eq(memberships.userId, owner));
      const [link] = await tx
        .select()
        .from(membershipRoles)
        .where(eq(membershipRoles.membershipId, member!.id));
      originalRole = link!.roleId;
      await tx
        .update(roles)
        .set({ permissions: all.filter((p) => p !== permission) })
        .where(eq(roles.id, originalRole));
      await tx.insert(roles).values({
        id,
        tenantId,
        name: "Synthetic mixed business scope",
        permissions: [permission],
        dataScope: scope,
      });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: member!.id, roleId: id });
    });
    return () =>
      withTenant(database.db, context, async (tx) => {
        await tx.delete(membershipRoles).where(eq(membershipRoles.roleId, id));
        await tx.delete(roles).where(eq(roles.id, id));
        await tx
          .update(roles)
          .set({ permissions: all, dataScope: "tenant" })
          .where(eq(roles.id, originalRole));
      });
  }
  it.each([
    ["procurement_order", Permission.ProcurementRead],
    ["after_sales_case", Permission.OrderPiiRead],
    ["order_exception", Permission.OrderRead],
  ] as const)(
    "current order authority keeps the parent %s follow-up read scope independent",
    async (source, permission) => {
      const id =
        source === "procurement_order"
          ? (await po()).id
          : source === "after_sales_case"
            ? (await caseRecord()).case.id
            : (await exception()).id;
      await coordinator.get(context, source, id);
      const remove = await mixedBusinessScope(permission, "self");
      try {
        await expect(coordinator.get(context, source, id)).rejects.toMatchObject({
          status: 403,
        });
        await expect(inbox.list(context, source, {})).rejects.toMatchObject({ status: 403 });
      } finally {
        await remove();
      }
    },
  );
  it.each([
    ["procurement_order", Permission.ProcurementAssign],
    ["order_exception", Permission.OrderAssign],
  ] as const)(
    "current order authority keeps the parent %s assignment scope independent",
    async (source, permission) => {
      const record = source === "procurement_order" ? await po() : await exception();
      const remove = await mixedBusinessScope(permission, "team");
      try {
        const view = await coordinator.get(context, source, record.id);
        expect(view.responsibility.canManage).toBe(false);
        await expect(assign(source, record.id)).rejects.toMatchObject({ status: 403 });
      } finally {
        await remove();
      }
    },
  );

  it("reads legacy objects without backfilling arrangements or business facts", async () => {
    const item = await po(),
      before = await procurement.workspace(context),
      value = await coordinator.get(context, "procurement_order", item.id);
    expect(value.responsibility.revision).toBe(0);
    expect(value.item.taskKey).toBe("review");
    expect(
      await withTenant(database.db, context, (tx) =>
        tx.execute(
          sql`select object_id from procurement_order_followups where object_id=${item.id}`,
        ),
      ),
    ).toHaveLength(0);
    expect(await procurement.workspace(context)).toEqual(before);
  });
  it("stores responsibility separately with source CAS, idempotence and a single concurrent winner", async () => {
    const item = await po(),
      before = await procurement.workspace(context),
      first = await coordinator.get(context, "procurement_order", item.id);
    const input = {
      expectedRevision: 0,
      expectedSourceChecksum: first.item.sourceChecksum,
      assignedUserId: assignee,
      dueAt: null,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "initial_assignment",
    };
    const attempts = await Promise.allSettled([
      coordinator.update(context, "procurement_order", item.id, input),
      coordinator.update(context, "procurement_order", item.id, input),
    ]);
    expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(
      await coordinator.update(context, "procurement_order", item.id, {
        ...input,
        expectedRevision: 1,
      }),
    ).toMatchObject({ revision: 1 });
    expect(await procurement.workspace(context)).toEqual(before);
    await approve(item.id);
    await expect(
      coordinator.update(context, "procurement_order", item.id, {
        ...input,
        expectedRevision: 1,
        dueAt: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("keeps received goods open until an actual matching invoice is recorded", async () => {
    const item = await po();
    await approve(item.id);
    await receive(item.id);
    const received = await coordinator.get(context, "procurement_order", item.id);
    expect(received.item).toMatchObject({
      status: "received",
      taskKey: "invoice",
      isClosed: false,
    });
    await assign("procurement_order", item.id);
    await invoice(item.id);
    expect((await coordinator.get(context, "procurement_order", item.id)).item).toMatchObject({
      taskKey: "complete",
      isClosed: true,
    });
    await force("procurement_order", item.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    expect(await notices("procurement_order", item.id)).toHaveLength(0);
  });
  it("does not call cumulative or mismatched invoices complete", async () => {
    const item = await po();
    await approve(item.id);
    await receive(item.id, 5);
    await invoice(item.id, 5);
    await receive(item.id, 5);
    await invoice(item.id, 10);
    expect((await coordinator.get(context, "procurement_order", item.id)).item).toMatchObject({
      isClosed: false,
      needsAttention: true,
    });
    const mismatch = await po();
    await approve(mismatch.id);
    await receive(mismatch.id);
    await invoice(mismatch.id, 10, 60);
    expect((await coordinator.get(context, "procurement_order", mismatch.id)).item).toMatchObject({
      taskKey: "reconcile",
      isClosed: false,
      needsAttention: true,
    });
  });
  it("keeps a rejected procurement revisable and an archived one closed", async () => {
    const item = await po();
    await procurement.reviewPurchaseOrder(context, item.id, {
      expectedVersion: 1,
      decision: "rejected",
      reasonCode: "SYNTHETIC",
      idempotencyKey: createEntityId(),
    });
    expect((await coordinator.get(context, "procurement_order", item.id)).item).toMatchObject({
      taskKey: "revise",
      isClosed: false,
    });
    await procurement.archivePurchaseOrder(context, item.id, {
      archived: true,
      reason: "Synthetic archival",
    });
    expect((await coordinator.get(context, "procurement_order", item.id)).item).toMatchObject({
      isClosed: true,
      taskKey: "archived",
    });
  });
  it("preserves liability and keeps an approved after-sales decision open until real completion evidence", async () => {
    const item = await caseRecord(),
      id = item.case.id;
    await assign("after_sales_case", id);
    const decision = await afterSales.decide(context, id, {
      resolution: "partial_refund",
      refundAmountMinor: 100,
      refundCurrency: "USD",
      returnRequired: false,
      responsibilityParty: "supplier",
      reasonCode: "SYNTHETIC",
      reason: "Synthetic review",
      expectedDecisionVersion: 0,
      idempotencyKey: createEntityId(),
    });
    expect(decision.case.status).toBe("approved");
    expect(decision.decisions[0]!.responsibilityParty).toBe("supplier");
    expect((await coordinator.get(context, "after_sales_case", id)).item).toMatchObject({
      isClosed: false,
      taskKey: "approved",
    });
    await afterSales.complete(context, id, {
      expectedDecisionVersion: 1,
      occurredAt: new Date().toISOString(),
      evidenceReference: "Synthetic handling evidence",
      reason: "Recorded actual handling",
      idempotencyKey: createEntityId(),
    });
    expect((await coordinator.get(context, "after_sales_case", id)).item).toMatchObject({
      isClosed: true,
      status: "resolved",
    });
  });
  it("follows the latest real exception event without changing order fulfillment", async () => {
    const item = await exception(),
      before = await orders.get(context, item.orderId);
    await assign("order_exception", item.id);
    expect((await coordinator.get(context, "order_exception", item.id)).item).toMatchObject({
      isClosed: false,
      status: "open",
    });
    expect(await orders.get(context, item.orderId)).toEqual(before);
    await orders.resolveException(context, item.orderId, item.id, {
      resolution: "Synthetic actual resolution",
      idempotencyKey: createEntityId(),
    });
    expect((await coordinator.get(context, "order_exception", item.id)).item).toMatchObject({
      isClosed: true,
      status: "resolved",
    });
    expect((await orders.get(context, item.orderId)).workflowState).toBe(before.workflowState);
  });
  it("never exports decrypted case summaries or exception messages in tasks, audit metadata or notices", async () => {
    const item = await caseRecord(),
      issue = await exception();
    await assign("after_sales_case", item.case.id);
    await assign("order_exception", issue.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    for (const source of ["after_sales_case", "order_exception"] as const)
      expect(
        JSON.stringify(await inbox.list(context, source, { assignment: "visible", status: "all" })),
      ).not.toContain("PRIVATE_");
    expect(JSON.stringify(await notices("after_sales_case", item.case.id))).not.toContain(
      "PRIVATE_",
    );
    expect(JSON.stringify(await notices("order_exception", issue.id))).not.toContain("PRIVATE_");
  });
  it("rechecks tenant, membership, assign rights, scope and recipient eligibility", async () => {
    const item = await po(),
      view = await coordinator.get(context, "procurement_order", item.id);
    await expect(coordinator.get(foreign, "procurement_order", item.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      coordinator.get({ ...context, dataScope: "self" }, "procurement_order", item.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      coordinator.update(
        { ...context, permissions: all.filter((p) => p !== Permission.ProcurementAssign) },
        "procurement_order",
        item.id,
        {},
      ),
    ).rejects.toThrow();
    const input = {
      expectedRevision: 0,
      expectedSourceChecksum: view.item.sourceChecksum,
      assignedUserId: outsider,
      dueAt: null,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "handoff",
    };
    await expect(
      coordinator.update(context, "procurement_order", item.id, input),
    ).rejects.toMatchObject({ status: 400 });
    await permissions(all.filter((p) => p !== Permission.ProcurementRead));
    try {
      await expect(
        coordinator.get({ ...context, userId: assignee }, "procurement_order", item.id),
      ).rejects.toMatchObject({ status: 403 });
      await expect(assign("procurement_order", item.id)).rejects.toMatchObject({ status: 400 });
    } finally {
      await permissions();
    }
  });
  it("enforces composite recipient membership and source tenant foreign keys under forced RLS", async () => {
    const item = await po();
    for (const [tenant, user] of [
      [tenantId, outsider],
      [foreignTenant, outsider],
    ])
      await expect(
        withTenant(database.db, context, (tx) =>
          tx.execute(
            sql`insert into procurement_order_followups(object_id,tenant_id,assigned_user_id,revision,reason_code,updated_by,observed_source_checksum) values(${item.id},${tenant},${user},1,'initial_assignment',${owner},${"a".repeat(64)})`,
          ),
        ),
      ).rejects.toThrow();
    expect(
      (await coordinator.get(context, "procurement_order", item.id)).responsibility.revision,
    ).toBe(0);
  });
  it("filters and counts the full result before pagination and searches wildcard characters literally", async () => {
    const first = await po(),
      second = await po();
    await assign("procurement_order", first.id, "2000-01-01T00:00:00.000Z");
    await assign("procurement_order", second.id, "2099-01-01T00:00:00.000Z");
    const query = {
        assignment: "visible",
        q: "%_",
        pageSize: 1,
        sort: "deadline",
        timeZone: "America/Los_Angeles",
      },
      result = await inbox.list(context, "procurement_order", query);
    expect(result.total).toBeGreaterThanOrEqual(2);
    expect(result.items).toHaveLength(1);
    expect(result.summary.overdue).toBeGreaterThanOrEqual(1);
    expect(
      (await inbox.list(context, "procurement_order", { ...query, page: 2 })).items[0]!.id,
    ).not.toBe(result.items[0]!.id);
    expect(
      (
        await inbox.list(context, "procurement_order", {
          assignment: "visible",
          q: "not-present-%_",
        })
      ).total,
    ).toBe(0);
    await expect(
      inbox.list(context, "procurement_order", { timeZone: "invalid/zone" }),
    ).rejects.toThrow();
  });
  it("deduplicates assignment, due and escalation notices across repeated and concurrent dispatch", async () => {
    const item = await exception();
    await assign("order_exception", item.id, "2000-01-01T00:00:00.000Z", true);
    await Promise.all([
      new FollowupAttentionDispatcher(database).dispatch(),
      new FollowupAttentionDispatcher(database).dispatch(),
    ]);
    await force("order_exception", item.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    expect(
      (await notices("order_exception", item.id)).map((row) => row.metadata.stage).sort(),
    ).toEqual(["due", "escalated"]);
  });
  it("rolls notification writes back with a failed checkpoint and lets another item progress", async () => {
    const item = await po(),
      other = await po();
    await assign("procurement_order", item.id);
    await assign("procurement_order", other.id);
    const failing = new FollowupAttentionDispatcher(database, async (tx, target, input) => {
      const notice = await recordNotificationInTransaction(tx, target, input);
      if (input.resourceId === item.id) throw new Error("Synthetic checkpoint failure");
      return notice;
    });
    expect((await failing.dispatch()).failures).toBeGreaterThanOrEqual(1);
    expect(await notices("procurement_order", item.id)).toHaveLength(0);
    expect(await notices("procurement_order", other.id)).toHaveLength(1);
    await force("procurement_order", item.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    expect(await notices("procurement_order", item.id)).toHaveLength(1);
  });
  it("stops delivery on expiry and requires an explicit current-source review to resume", async () => {
    const item = await exception(),
      [line] = await withTenant(database.db, context, (tx) =>
        tx
          .select({ id: orderLines.id })
          .from(orderLines)
          .where(eq(orderLines.orderId, item.orderId)),
      );
    await withTenant(database.db, context, (tx) =>
      tx.insert(orderWorkItems).values({
        id: line!.id,
        tenantId,
        encryptedDataKey: vault.encrypt(Buffer.alloc(32, 17).toString("base64")),
        expiresAt: new Date(0),
      }),
    );
    expect((await coordinator.get(context, "order_exception", item.id)).item.available).toBe(false);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ expiresAt: new Date(Date.now() + 86400000) })
        .where(eq(orderWorkItems.id, line!.id)),
    );
    await assign("order_exception", item.id);
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ expiresAt: new Date(0) })
        .where(eq(orderWorkItems.id, line!.id)),
    );
    await new FollowupAttentionDispatcher(database).dispatch();
    expect(await notices("order_exception", item.id)).toHaveLength(0);
    expect(
      (await coordinator.get(context, "order_exception", item.id)).responsibility,
    ).toMatchObject({ nextCheckAt: null, lastError: "SOURCE_UNAVAILABLE" });
    await withTenant(database.db, context, (tx) =>
      tx
        .update(orderWorkItems)
        .set({ expiresAt: new Date(Date.now() + 86400000) })
        .where(eq(orderWorkItems.id, line!.id)),
    );
    const restored = await coordinator.get(context, "order_exception", item.id);
    expect(restored.responsibility.canResume).toBe(true);
    await coordinator.update(
      context,
      "order_exception",
      item.id,
      {
        expectedRevision: restored.responsibility.revision,
        expectedSourceChecksum: restored.item.sourceChecksum,
        assignedUserId: assignee,
        dueAt: null,
        escalationUserId: null,
        escalationDelayMinutes: null,
        reason: "correction",
      },
      true,
    );
    await new FollowupAttentionDispatcher(database).dispatch();
    expect(await notices("order_exception", item.id)).toHaveLength(1);
  });
  it("does not deliver to revoked recipients and resumes after current permission recovery", async () => {
    const item = await po();
    await assign("procurement_order", item.id);
    await permissions(all.filter((p) => p !== Permission.NotificationRead));
    try {
      await new FollowupAttentionDispatcher(database).dispatch();
      expect(await notices("procurement_order", item.id)).toHaveLength(0);
      expect(
        (await coordinator.get(context, "procurement_order", item.id)).responsibility.lastError,
      ).toBe("RECIPIENT_UNAVAILABLE");
    } finally {
      await permissions();
    }
    await force("procurement_order", item.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    expect(await notices("procurement_order", item.id)).toHaveLength(1);
  });
  it("observes original procurement archival and reopening without inventing completion", async () => {
    const item = await po();
    await assign("procurement_order", item.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    await procurement.archivePurchaseOrder(context, item.id, {
      archived: true,
      reason: "Synthetic archival",
    });
    await force("procurement_order", item.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    expect(await notices("procurement_order", item.id)).toHaveLength(1);
    await procurement.archivePurchaseOrder(context, item.id, {
      archived: false,
      reason: "Synthetic reopening",
    });
    await force("procurement_order", item.id);
    await new FollowupAttentionDispatcher(database).dispatch();
    expect((await coordinator.get(context, "procurement_order", item.id)).item).toMatchObject({
      status: "draft",
      isClosed: false,
    });
    const messages = await notices("procurement_order", item.id);
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.metadata.cycle)).size).toBe(2);
  });
  it("keeps a rejected after-sales decision open for actual closure evidence", async () => {
    const item = await caseRecord();
    await afterSales.decide(context, item.case.id, {
      resolution: "no_action",
      refundAmountMinor: null,
      refundCurrency: null,
      returnRequired: false,
      responsibilityParty: "undetermined",
      reasonCode: "SYNTHETIC",
      reason: "Synthetic rejection",
      expectedDecisionVersion: 0,
      idempotencyKey: createEntityId(),
    });
    expect((await coordinator.get(context, "after_sales_case", item.case.id)).item).toMatchObject({
      status: "rejected",
      isClosed: false,
    });
    await assign("after_sales_case", item.case.id);
    await afterSales.complete(context, item.case.id, {
      expectedDecisionVersion: 1,
      occurredAt: new Date().toISOString(),
      evidenceReference: "Synthetic handling evidence",
      reason: "Actual handling recorded",
      idempotencyKey: createEntityId(),
    });
    expect((await coordinator.get(context, "after_sales_case", item.case.id)).item.isClosed).toBe(
      true,
    );
  });
  it("keeps the deployment flag default-off", async () => {
    const item = await po();
    delete process.env.BUSINESS_FOLLOWUP_TENANT_IDS;
    try {
      await expect(coordinator.get(context, "procurement_order", item.id)).rejects.toMatchObject({
        status: 404,
      });
      expect(await new FollowupAttentionDispatcher(database).dispatch()).toEqual({
        checked: 0,
        notices: 0,
        deferred: 0,
        failures: 0,
      });
    } finally {
      process.env.BUSINESS_FOLLOWUP_TENANT_IDS = "*";
    }
  });
});
